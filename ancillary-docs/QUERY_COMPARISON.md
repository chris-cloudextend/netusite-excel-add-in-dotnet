# Query Comparison: Individual vs Batch TYPEBALANCE

## Individual Query (When Formula is Entered)

**Location:** `BalanceService.cs` - `GetTypeBalanceAsync` method  
**Called from:** `/type-balance` endpoint  
**When:** User enters `=XAVI.TYPEBALANCE("Income", "Jan 2025", "Jan 2025", ...)`

### Query Structure:
```sql
SELECT SUM(
    TO_NUMBER(
        BUILTIN.CONSOLIDATE(
            tal.amount,
            'LEDGER',
            'DEFAULT',
            'DEFAULT',
            {targetSub},
            t.postingperiod,
            'DEFAULT'
        )
    ) * CASE WHEN a.accttype IN ('Income', 'OthIncome') THEN -1 ELSE 1 END
) AS balance
FROM transactionaccountingline tal
JOIN transaction t ON t.id = tal.transaction
JOIN account a ON a.id = tal.account
JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
WHERE t.posting = 'T'
  AND tal.posting = 'T'
  AND a.accttype IN ('Income')  -- ← SINGLE TYPE FILTER
  AND t.postingperiod IN ({periodIdList})  -- ← All periods in range
  AND tal.accountingbook = {accountingBook}
  AND {segmentWhere}  -- ← tl.subsidiary IN (...)
```

**Key Points:**
- Filters to **ONE account type** at a time: `a.accttype IN ('Income')`
- Uses `MapAccountType("Income")` which returns `'Income'`
- No GROUP BY (returns single SUM)
- Sign flip: `CASE WHEN a.accttype IN ('Income', 'OthIncome') THEN -1 ELSE 1 END`

---

## Batch Query (When Book/Subsidiary Changes)

**Location:** `TypeBalanceController.cs` - `BatchTypeBalanceRefresh` method  
**Called from:** `/batch/typebalance_refresh` endpoint  
**When:** User changes accounting book or subsidiary

### Query Structure:
```sql
SELECT 
    a.accttype AS account_type,
    SUM(CASE WHEN t.postingperiod = {periodId1} THEN 
        TO_NUMBER(
            BUILTIN.CONSOLIDATE(
                tal.amount, 
                'LEDGER', 
                'DEFAULT', 
                'DEFAULT', 
                {targetSub}, 
                t.postingperiod, 
                'DEFAULT'
            )
        ) * CASE WHEN a.accttype IN ('Income', 'OthIncome') THEN -1 ELSE 1 END
    ELSE 0 END) AS jan,
    SUM(CASE WHEN t.postingperiod = {periodId2} THEN 
        TO_NUMBER(...) * CASE WHEN a.accttype IN ('Income', 'OthIncome') THEN -1 ELSE 1 END
    ELSE 0 END) AS feb,
    ... (12 months total)
FROM transactionaccountingline tal
JOIN transaction t ON t.id = tal.transaction
JOIN account a ON a.id = tal.account
JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
WHERE t.posting = 'T'
  AND tal.posting = 'T'
  AND a.accttype IN ('Income', 'COGS', 'Expense', 'OthIncome', 'OthExpense')  -- ← ALL TYPES
  AND a.isinactive = 'F'  -- ← EXTRA FILTER
  AND t.postingperiod IN ({periodFilter})  -- ← All periods
  AND tal.accountingbook = {accountingBook}
  AND {segmentWhere}  -- ← tl.subsidiary IN (...)
GROUP BY a.accttype  -- ← GROUPS BY TYPE
ORDER BY a.accttype
```

**Key Points:**
- Filters to **ALL account types** at once: `a.accttype IN ('Income', 'COGS', 'Expense', 'OthIncome', 'OthExpense')`
- Has **extra filter**: `a.isinactive = 'F'` (individual query doesn't have this!)
- Uses **GROUP BY a.accttype** to pivot by type
- Sign flip: Same as individual query
- **Pivots by period** using CASE WHEN for each month

---

## Critical Differences

### 1. Account Type Filter
- **Individual:** `a.accttype IN ('Income')` - Only Income
- **Batch:** `a.accttype IN ('Income', 'COGS', 'Expense', 'OthIncome', 'OthExpense')` - All types
- **Impact:** Expected difference - batch gets all types at once, individual gets one type

### 2. Inactive Account Filter ⚠️ **FIXED**
- **Individual:** ❌ **NOT PRESENT**
- **Batch:** ❌ **REMOVED** (was `a.isinactive = 'F'` - **THIS WAS THE DIFFERENCE!**)

**FIX APPLIED (v4.0.6.84):** Removed `a.isinactive = 'F'` from batch query to match individual query exactly.

### 3. Query Structure
- **Individual:** Single SUM, no GROUP BY
- **Batch:** GROUP BY a.accttype, pivots by period using CASE WHEN
- **Impact:** Expected difference - batch pivots by type and period

### 3. Query Structure
- **Individual:** Single SUM, no GROUP BY
- **Batch:** GROUP BY a.accttype, pivots by period

---

## Hypothesis

The batch query has `a.isinactive = 'F'` but the individual query does NOT. However, this shouldn't cause Income to return zeros if Income accounts are active.

**Wait - let me check if there's a difference in how the sign flip is evaluated in the GROUP BY context...**

Actually, I think the issue might be that when you GROUP BY a.accttype, the sign flip CASE statement is evaluated per row, but since we're grouping by accttype, all rows in a group have the same accttype. So the sign flip should work correctly.

But wait - in the batch query, the sign flip is INSIDE each month's CASE WHEN. Let me check if that's causing an issue...

Actually, I think I need to see the actual generated SQL to compare them properly.

