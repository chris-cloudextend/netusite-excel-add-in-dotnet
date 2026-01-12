# Fix Summary v4.0.6.84 - Income Query Matching

## Problem

Income account type returns $0.00 for all periods in batch query, but individual queries work correctly when formulas are entered after clearing cache.

## Root Cause

The batch query had **`a.isinactive = 'F'`** filter, but the individual query does **NOT** have this filter. This inconsistency caused the batch query to potentially exclude Income accounts that the individual query includes.

## Fix Applied

**File:** `backend-dotnet/Controllers/TypeBalanceController.cs`

**Change:** Removed `a.isinactive = 'F'` from the batch query to match the individual query structure exactly.

### Before:
```sql
WHERE t.posting = 'T'
  AND tal.posting = 'T'
  AND a.accttype IN ('Income', 'COGS', 'Expense', 'OthIncome', 'OthExpense')
  AND a.isinactive = 'F'  -- ← REMOVED
  AND t.postingperiod IN ({periodFilter})
  AND tal.accountingbook = {accountingBook}
  AND {segmentWhere}
```

### After:
```sql
WHERE t.posting = 'T'
  AND tal.posting = 'T'
  AND a.accttype IN ('Income', 'COGS', 'Expense', 'OthIncome', 'OthExpense')
  AND t.postingperiod IN ({periodFilter})
  AND tal.accountingbook = {accountingBook}
  AND {segmentWhere}
```

## Query Structure Now Matches

Both queries now have identical WHERE clause structure (except for account type filter, which is expected):

**Individual Query:**
- `a.accttype IN ('Income')` - Single type
- No `a.isinactive` filter

**Batch Query:**
- `a.accttype IN ('Income', 'COGS', 'Expense', 'OthIncome', 'OthExpense')` - All types
- No `a.isinactive` filter ✅ **NOW MATCHES**

## Testing

After this fix:
1. Change accounting book from 1 to 2
2. Verify Income (Revenue) values appear for all periods
3. Compare with individual query results to ensure they match

## Files Changed

- `backend-dotnet/Controllers/TypeBalanceController.cs` - Removed `a.isinactive = 'F'` from main query and diagnostic queries

