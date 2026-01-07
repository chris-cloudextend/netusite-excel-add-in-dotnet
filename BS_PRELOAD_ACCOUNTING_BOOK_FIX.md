# BS PRELOAD Accounting Book Filter Fix

## Issue

When dragging down formulas for Balance Sheet accounts (like account 13000), the batch preload query was returning incorrect balances compared to individual formula queries.

## Root Cause

The BS PRELOAD query (`PreloadBalanceSheetAccounts`) had an incorrect accounting book filter that allowed NULL values:

**Before (INCORRECT):**
```sql
LEFT JOIN transactionaccountingline tal ON tal.account = a.id
    AND tal.posting = 'T'
    AND (tal.accountingbook = {accountingBook} OR tal.accountingbook IS NULL)  -- ❌ Allows NULL
```

This filter would include transactions from other accounting books when `tal.accountingbook IS NULL`, causing incorrect balances.

## Fix

Changed to strict equality to match the individual `BalanceService.GetBalanceAsync()` query:

**After (CORRECT):**
```sql
LEFT JOIN transactionaccountingline tal ON tal.account = a.id
    AND tal.posting = 'T'
    AND tal.accountingbook = {accountingBook}  -- ✅ Strict equality, no NULL
```

## Why This Works

1. **Strict Filtering:** Only transactions from the specified accounting book are included
2. **Zero Balance Accounts:** Accounts with no transactions in that book still return 0 due to LEFT JOIN + COALESCE
3. **Consistency:** Matches the individual query behavior exactly

## Comparison

### Individual Query (BalanceService.cs:395)
```sql
WHERE t.posting = 'T'
  AND tal.posting = 'T'
  AND {accountFilter}
  AND t.trandate <= TO_DATE('{toEndDate}', 'YYYY-MM-DD')
  AND tal.accountingbook = {accountingBook}  -- ✅ Strict equality
```

### BS PRELOAD Query (BalanceController.cs:1139) - FIXED
```sql
LEFT JOIN transactionaccountingline tal ON tal.account = a.id
    AND tal.posting = 'T'
    AND tal.accountingbook = {accountingBook}  -- ✅ Now matches individual query
```

## Impact

- **Account 13000** (and all other accounts) will now return the same balance from:
  - Individual `XAVI.BALANCE` formula calls
  - Batch preload (when dragging down formulas)
- **Multi-Book Accounting:** Correctly filters by accounting book
- **Zero Balance Accounts:** Still correctly return 0

## Testing

After this fix:
1. Individual formula: `=XAVI.BALANCE("13000", "May 2025", , , , , , 2)` should match NetSuite
2. Dragging down formulas should use the same cached value from batch preload
3. Both should return identical balances

## Files Changed

- `backend-dotnet/Controllers/BalanceController.cs` (line 1139)
  - Changed accounting book filter from `(tal.accountingbook = {accountingBook} OR tal.accountingbook IS NULL)` to `tal.accountingbook = {accountingBook}`
  - Updated comment to explain the fix

