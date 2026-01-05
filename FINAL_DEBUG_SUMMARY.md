# Final Debug Summary - Income Query Fix

## Problem Identified

You correctly pointed out that if individual queries work when formulas are entered after clearing cache, then `BUILTIN.CONSOLIDATE` is NOT the issue. The problem must be in how the batch query differs from the individual query.

## Root Cause Found

**The batch query had `a.isinactive = 'F'` filter, but the individual query does NOT have this filter.**

### Individual Query (Works)
```sql
WHERE t.posting = 'T'
  AND tal.posting = 'T'
  AND a.accttype IN ('Income')  -- Single type
  AND t.postingperiod IN ({periodIdList})
  AND tal.accountingbook = {accountingBook}
  AND {segmentWhere}
  -- NO a.isinactive filter
```

### Batch Query (Was Broken)
```sql
WHERE t.posting = 'T'
  AND tal.posting = 'T'
  AND a.accttype IN ('Income', 'COGS', 'Expense', 'OthIncome', 'OthExpense')  -- All types
  AND a.isinactive = 'F'  -- ← THIS WAS THE DIFFERENCE!
  AND t.postingperiod IN ({periodFilter})
  AND tal.accountingbook = {accountingBook}
  AND {segmentWhere}
```

## Fix Applied (v4.0.6.84)

**File:** `backend-dotnet/Controllers/TypeBalanceController.cs`

**Change:** Removed `a.isinactive = 'F'` from:
1. Main batch query (line 209)
2. Diagnostic query (line 318)
3. Test query (line 356)

**Result:** Batch query now matches individual query structure exactly (except for expected differences like account type filter and GROUP BY).

## Query Structure Comparison

| Aspect | Individual Query | Batch Query | Status |
|--------|------------------|-------------|--------|
| Account Type Filter | `a.accttype IN ('Income')` | `a.accttype IN ('Income', 'COGS', ...)` | ✅ Expected difference |
| Inactive Filter | ❌ Not present | ❌ **REMOVED** | ✅ **NOW MATCHES** |
| Posting Filters | `t.posting = 'T' AND tal.posting = 'T'` | Same | ✅ Matches |
| Period Filter | `t.postingperiod IN ({periodIdList})` | `t.postingperiod IN ({periodFilter})` | ✅ Matches |
| Accounting Book | `tal.accountingbook = {accountingBook}` | Same | ✅ Matches |
| Segment Filter | `{segmentWhere}` | Same | ✅ Matches |
| BUILTIN.CONSOLIDATE | Same structure | Same structure | ✅ Matches |
| Sign Flip | Same logic | Same logic | ✅ Matches |
| GROUP BY | None | `GROUP BY a.accttype` | ✅ Expected difference |

## Files Updated

1. ✅ `backend-dotnet/Controllers/TypeBalanceController.cs` - Removed `a.isinactive = 'F'` from 3 queries
2. ✅ `docs/functions.js` - Updated version to 4.0.6.84
3. ✅ `excel-addin/manifest.xml` - Updated all version references to 4.0.6.84
4. ✅ `docs/taskpane.html` - Updated functions.js script version
5. ✅ `docs/sharedruntime.html` - Updated functions.js script version
6. ✅ `docs/functions.html` - Updated functions.js script version

## Testing Required

1. **Restart backend server** to load the fix
2. **Clear Excel cache** in the add-in
3. **Change accounting book from 1 to 2**
4. **Verify Income (Revenue) values appear** for all periods
5. **Compare with individual query results** to ensure they match

## Expected Result

After this fix, the batch query should return Income values that match the individual query results exactly, since they now have identical WHERE clause structure (except for the expected account type filter difference).

