# TYPEBALANCE Backend Debug Report

**Date:** 2026-01-05  
**Issue:** Income account type returning $0.00 for all periods in Book 2 (India subsidiary)  
**Status:** Investigating

## Problem Summary

From console logs:
- Backend returns all $0.00 for Income (Revenue) for all 12 months in 2025
- Other account types (COGS, Expense, OthIncome, OthExpense) appear to have data
- Cache is being populated correctly with zeros
- Individual queries (when formulas are dragged) work and show data

## Test Parameters

- **Year:** 2025
- **Subsidiary:** "Celigo India Pvt Ltd"
- **Accounting Book:** 2 (Secondary Book - India GAAP)
- **Department:** (none)
- **Location:** (none)
- **Class:** (none)

## Expected vs Actual Results

### Income (Revenue)
| Period | Expected | Actual | Status |
|--------|----------|--------|--------|
| Jan 2025 | ? | $0.00 | ❌ |
| Feb 2025 | ? | $0.00 | ❌ |
| Mar 2025 | ? | $0.00 | ❌ |
| Apr 2025 | ? | $0.00 | ❌ |
| May 2025 | ? | $0.00 | ❌ |
| Jun 2025 | ? | $0.00 | ❌ |
| Jul 2025 | ? | $0.00 | ❌ |
| Aug 2025 | ? | $0.00 | ❌ |
| Sep 2025 | ? | $0.00 | ❌ |
| Oct 2025 | ? | $0.00 | ❌ |
| Nov 2025 | ? | $0.00 | ❌ |
| Dec 2025 | ? | $0.00 | ❌ |

**Total:** $0.00 (0/12 months with data)

### COGS
| Period | Value | Status |
|--------|-------|--------|
| Jan 2025 | TBD | ⬜ |
| Feb 2025 | TBD | ⬜ |
| Mar 2025 | TBD | ⬜ |
| Apr 2025 | TBD | ⬜ |
| May 2025 | TBD | ⬜ |
| Jun 2025 | TBD | ⬜ |
| Jul 2025 | TBD | ⬜ |
| Aug 2025 | TBD | ⬜ |
| Sep 2025 | TBD | ⬜ |
| Oct 2025 | TBD | ⬜ |
| Nov 2025 | TBD | ⬜ |
| Dec 2025 | TBD | ⬜ |

### Expense
| Period | Value | Status |
|--------|-------|--------|
| Jan 2025 | TBD | ⬜ |
| Feb 2025 | TBD | ⬜ |
| Mar 2025 | TBD | ⬜ |
| Apr 2025 | TBD | ⬜ |
| May 2025 | TBD | ⬜ |
| Jun 2025 | TBD | ⬜ |
| Jul 2025 | TBD | ⬜ |
| Aug 2025 | TBD | ⬜ |
| Sep 2025 | TBD | ⬜ |
| Oct 2025 | TBD | ⬜ |
| Nov 2025 | TBD | ⬜ |
| Dec 2025 | TBD | ⬜ |

### OthIncome
| Period | Value | Status |
|--------|-------|--------|
| Jan 2025 | TBD | ⬜ |
| Feb 2025 | TBD | ⬜ |
| Mar 2025 | TBD | ⬜ |
| Apr 2025 | TBD | ⬜ |
| May 2025 | TBD | ⬜ |
| Jun 2025 | TBD | ⬜ |
| Jul 2025 | TBD | ⬜ |
| Aug 2025 | TBD | ⬜ |
| Sep 2025 | TBD | ⬜ |
| Oct 2025 | TBD | ⬜ |
| Nov 2025 | TBD | ⬜ |
| Dec 2025 | TBD | ⬜ |

### OthExpense
| Period | Value | Status |
|--------|-------|--------|
| Jan 2025 | TBD | ⬜ |
| Feb 2025 | TBD | ⬜ |
| Mar 2025 | TBD | ⬜ |
| Apr 2025 | TBD | ⬜ |
| May 2025 | TBD | ⬜ |
| Jun 2025 | TBD | ⬜ |
| Jul 2025 | TBD | ⬜ |
| Aug 2025 | TBD | ⬜ |
| Sep 2025 | TBD | ⬜ |
| Oct 2025 | TBD | ⬜ |
| Nov 2025 | TBD | ⬜ |
| Dec 2025 | TBD | ⬜ |

## Code Changes Made

### v4.0.6.83 - Query Structure Fix

**Problem:** Batch query was using `COALESCE` which individual query doesn't use.

**Fix:** Removed `COALESCE` and matched individual query structure exactly:

**Before:**
```sql
CASE WHEN a.accttype IN ('Income', 'OthIncome') THEN 
    -COALESCE(TO_NUMBER(BUILTIN.CONSOLIDATE(...)), tal.amount)
ELSE 
    COALESCE(TO_NUMBER(BUILTIN.CONSOLIDATE(...)), tal.amount)
END
```

**After:**
```sql
TO_NUMBER(BUILTIN.CONSOLIDATE(...)) * CASE WHEN a.accttype IN ('Income', 'OthIncome') THEN -1 ELSE 1 END
```

This matches the individual query structure exactly. If `BUILTIN.CONSOLIDATE` returns NULL, `TO_NUMBER(NULL) = NULL`, and `NULL * -1 = NULL` (which SUM ignores).

## Next Steps

1. ✅ Run test script against backend to get actual values
2. ⬜ Compare batch query results with individual query results
3. ⬜ Check backend logs for diagnostic query output
4. ⬜ Verify if `BUILTIN.CONSOLIDATE` is returning NULL for Income accounts
5. ⬜ Test with different subsidiaries/books to isolate the issue

## Test Script

Run the following to test the backend:

```bash
./test-typebalance-backend.sh http://localhost:5002 2025 "Celigo India Pvt Ltd" 2
```

This will:
- Query the `/batch/typebalance_refresh` endpoint
- Document results by account type and period
- Generate a markdown report with all values
- Save full JSON response for analysis

