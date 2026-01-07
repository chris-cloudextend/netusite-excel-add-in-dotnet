# BS PRELOAD Query Structure Fix

## Issue

Batch preload query was returning incorrect balances (e.g., 7,855,937 for account 13000) compared to individual queries (8,314,265.34). The wrong value was being cached and used when dragging down formulas.

## Root Cause

The BS PRELOAD query used a **LEFT JOIN structure with conditional logic** that differed fundamentally from the individual query's **INNER JOIN structure**:

**Before (INCORRECT):**
```sql
FROM account a
LEFT JOIN transactionaccountingline tal ON ...
LEFT JOIN transaction t ON ...
LEFT JOIN TransactionLine tl ON ... AND ({segmentWhere})  -- Segment filters in JOIN
WHERE ...
GROUP BY ...
-- Uses CASE WHEN tl.id IS NOT NULL to conditionally include transactions
```

**Problems:**
1. Segment filters (including subsidiary) were in the JOIN condition, not WHERE clause
2. The `CASE WHEN tl.id IS NOT NULL` logic could exclude valid transactions
3. LEFT JOIN structure with conditional aggregation doesn't match individual query logic
4. Multiple TransactionLines per transaction could cause incorrect aggregation

## Fix

Restructured the query to use a **subquery approach** that matches the individual query structure exactly:

**After (CORRECT):**
```sql
SELECT 
    a.acctnumber,
    a.accountsearchdisplaynamecopy AS account_name,
    a.accttype,
    COALESCE(SUM(x.cons_amt), 0) AS balance
FROM account a
LEFT JOIN (
    SELECT
        tal.account,
        TO_NUMBER(
            BUILTIN.CONSOLIDATE(...)
        ) * CASE WHEN a.accttype IN ({signFlipSql}) THEN -1 ELSE 1 END AS cons_amt
    FROM transactionaccountingline tal
    JOIN transaction t ON t.id = tal.transaction
    JOIN account a ON a.id = tal.account
    JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
    WHERE t.posting = 'T'
      AND tal.posting = 'T'
      AND t.trandate <= TO_DATE('{endDate}', 'YYYY-MM-DD')
      AND tal.accountingbook = {accountingBook}
      AND ({segmentWhere})  -- Segment filters in WHERE clause (matches individual query)
) x ON x.account = a.id
WHERE a.accttype IN ({bsTypesSql})
  AND a.isinactive = 'F'
GROUP BY a.acctnumber, a.accountsearchdisplaynamecopy, a.accttype
```

## Key Changes

1. **Subquery with INNER JOINs** - Matches individual query structure exactly
2. **Segment filters in WHERE clause** - Same as individual query, not in JOIN condition
3. **LEFT JOIN subquery to account table** - Ensures zero-balance accounts are still included
4. **No conditional CASE logic** - Direct aggregation, matching individual query

## Comparison

### Individual Query (BalanceService.cs:372-397)
```sql
SELECT SUM(x.cons_amt) AS balance
FROM (
    SELECT
        TO_NUMBER(BUILTIN.CONSOLIDATE(...)) * {signFlip} AS cons_amt
    FROM transactionaccountingline tal
    JOIN transaction t ON t.id = tal.transaction
    JOIN account a ON a.id = tal.account
    {tlJoin}  -- INNER JOIN TransactionLine if needed
    WHERE t.posting = 'T'
      AND tal.posting = 'T'
      AND {accountFilter}
      AND t.trandate <= TO_DATE('{toEndDate}', 'YYYY-MM-DD')
      AND tal.accountingbook = {accountingBook}
      {whereSegment}  -- Segment filters in WHERE
) x
```

### BS PRELOAD Query (BalanceController.cs:1122-1156) - FIXED
```sql
SELECT 
    a.acctnumber,
    COALESCE(SUM(x.cons_amt), 0) AS balance
FROM account a
LEFT JOIN (
    SELECT
        tal.account,
        TO_NUMBER(BUILTIN.CONSOLIDATE(...)) * CASE ... END AS cons_amt
    FROM transactionaccountingline tal
    JOIN transaction t ON t.id = tal.transaction
    JOIN account a ON a.id = tal.account
    JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
    WHERE t.posting = 'T'
      AND tal.posting = 'T'
      AND t.trandate <= TO_DATE('{endDate}', 'YYYY-MM-DD')
      AND tal.accountingbook = {accountingBook}
      AND ({segmentWhere})  -- Segment filters in WHERE (matches individual query)
) x ON x.account = a.id
WHERE a.accttype IN ({bsTypesSql})
  AND a.isinactive = 'F'
GROUP BY a.acctnumber, ...
```

## Impact

- **Account 13000** (and all accounts) will now return the same balance from:
  - Individual `XAVI.BALANCE` formula calls
  - Batch preload (when dragging down formulas)
- **Query structure matches** - Both use INNER JOINs in subquery with WHERE clause filters
- **Zero balance accounts** - Still correctly return 0 due to LEFT JOIN + COALESCE
- **Cache consistency** - Cached values will match individual query results

## Testing

After this fix:
1. Clear cache for account 13000
2. Drag down formulas - should return 8,314,265.34 (not 7,855,937)
3. Individual formula should match batch preload result
4. Both should match NetSuite GL Balance report

## Files Changed

- `backend-dotnet/Controllers/BalanceController.cs` (lines 1119-1156)
  - Restructured query from LEFT JOIN with conditional logic to subquery with INNER JOINs
  - Moved segment filters from JOIN condition to WHERE clause
  - Removed `CASE WHEN tl.id IS NOT NULL` conditional logic

