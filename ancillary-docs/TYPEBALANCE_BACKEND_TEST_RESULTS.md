# TYPEBALANCE Backend Test Results - Book 2, India Subsidiary, 2025

**Test Date:** 2026-01-05  
**Parameters:**
- Year: 2025
- Subsidiary: "Celigo India Pvt Ltd"
- Accounting Book: 2 (Secondary Book - India GAAP)
- Department: (none)
- Location: (none)
- Class: (none)

## Executive Summary

**Issue:** Income (Revenue) account type returns **$0.00 for ALL 12 months** in the batch query, while other account types have data.

**Status:** Backend query structure fixed (v4.0.6.83) to match individual queries, but Income still returns zeros. Other account types work correctly.

---

## Detailed Results by Account Type and Period

### 1. Income (Revenue) - ❌ ALL ZEROS

| Period | Value | Status |
|--------|-------|--------|
| Jan 2025 | $0.00 | ❌ |
| Feb 2025 | $0.00 | ❌ |
| Mar 2025 | $0.00 | ❌ |
| Apr 2025 | $0.00 | ❌ |
| May 2025 | $0.00 | ❌ |
| Jun 2025 | $0.00 | ❌ |
| Jul 2025 | $0.00 | ❌ |
| Aug 2025 | $0.00 | ❌ |
| Sep 2025 | $0.00 | ❌ |
| Oct 2025 | $0.00 | ❌ |
| Nov 2025 | $0.00 | ❌ |
| Dec 2025 | $0.00 | ❌ |
| **Total** | **$0.00** | **0/12 months with data** |

**Finding:** Backend returns Income row with all 12 periods, but all values are zero. Cache keys are created correctly, indicating the backend IS returning the Income row (not missing it).

---

### 2. COGS - ✅ HAS DATA (7/12 months)

| Period | Value | Status |
|--------|-------|--------|
| Jan 2025 | $0.00 | ⚠️ |
| Feb 2025 | $0.00 | ⚠️ |
| Mar 2025 | $0.00 | ⚠️ |
| Apr 2025 | $0.00 | ⚠️ |
| May 2025 | $5,833,114.42 | ✅ |
| Jun 2025 | $6,477,281.67 | ✅ |
| Jul 2025 | $6,553,868.76 | ✅ |
| Aug 2025 | $7,393,751.16 | ✅ |
| Sep 2025 | $6,483,003.95 | ✅ |
| Oct 2025 | $6,371,159.62 | ✅ |
| Nov 2025 | $6,911,780.31 | ✅ |
| Dec 2025 | $0.00 | ⚠️ |
| **Total** | **~$45,024,959.89** | **7/12 months with data** |

**Finding:** COGS has significant values starting in May 2025. Jan-Apr and Dec are zero, which may be expected if there were no transactions in those periods.

---

### 3. Expense - ⚠️ LIMITED DATA (2/12 months)

| Period | Value | Status |
|--------|-------|--------|
| Jan 2025 | $0.00 | ⚠️ |
| Feb 2025 | $0.00 | ⚠️ |
| Mar 2025 | $49,029,514.00 | ✅ |
| Apr 2025 | $0.00 | ⚠️ |
| May 2025 | $0.00 | ⚠️ |
| Jun 2025 | $0.00 | ⚠️ |
| Jul 2025 | $0.00 | ⚠️ |
| Aug 2025 | $0.00 | ⚠️ |
| Sep 2025 | $0.00 | ⚠️ |
| Oct 2025 | $0.00 | ⚠️ |
| Nov 2025 | $0.00 | ⚠️ |
| Dec 2025 | $7,380,682.23 | ✅ |
| **Total** | **~$56,410,196.23** | **2/12 months with data** |

**Finding:** Expense has data for only 2 months (Mar and Dec). This is suspicious - either:
1. Transactions are only in those months (unlikely)
2. Query is missing data for other months (possible bug)
3. Data is consolidated differently for Expense accounts

**Note:** The large value in March ($49M) suggests this might be a year-to-date or cumulative value, not a monthly value.

---

### 4. OthIncome (Other Income) - ✅ HAS DATA (9/12 months)

| Period | Value | Status |
|--------|-------|--------|
| Jan 2025 | $0.00 | ⚠️ |
| Feb 2025 | $0.00 | ⚠️ |
| Mar 2025 | $0.00 | ⚠️ |
| Apr 2025 | $670,739.00 | ✅ |
| May 2025 | $415,039.00 | ✅ |
| Jun 2025 | $444,226.00 | ✅ |
| Jul 2025 | $421,363.00 | ✅ |
| Aug 2025 | $444,439.00 | ✅ |
| Sep 2025 | $422,589.00 | ✅ |
| Oct 2025 | $196,076.00 | ✅ |
| Nov 2025 | $670,739.00 | ✅ |
| Dec 2025 | $188,526.00 | ✅ |
| **Total** | **~$4,073,736.00** | **9/12 months with data** |

**Finding:** OthIncome has consistent values from Apr through Dec. Jan-Mar are zero, which may be expected.

---

### 5. OthExpense (Other Expense) - ✅ HAS DATA (8/12 months)

| Period | Value | Status |
|--------|-------|--------|
| Jan 2025 | $0.00 | ⚠️ |
| Feb 2025 | $0.00 | ⚠️ |
| Mar 2025 | $0.00 | ⚠️ |
| Apr 2025 | $4,254,166.01 | ✅ |
| May 2025 | $0.00 | ⚠️ |
| Jun 2025 | $7,848,983.09 | ✅ |
| Jul 2025 | $6,304,670.53 | ✅ |
| Aug 2025 | $4,662,120.84 | ✅ |
| Sep 2025 | $5,134,108.51 | ✅ |
| Oct 2025 | $3,794,152.65 | ✅ |
| Nov 2025 | $7,265,014.09 | ✅ |
| Dec 2025 | $210.00 | ✅ |
| **Total** | **~$38,263,425.72** | **8/12 months with data** |

**Finding:** OthExpense has significant values from Apr through Dec (except May). Jan-Mar are zero.

---

## Key Observations

1. **Income is the ONLY account type with ALL zeros** - This is the core bug
2. **Other account types have data** - COGS, OthIncome, OthExpense all work correctly
3. **Expense has limited data** - Only 2 months (Mar and Dec), which is also suspicious
4. **Backend IS returning the Income row** - It's not missing, just all zeros
5. **Cache is being populated correctly** - The zeros are being cached, not a cache issue

## Root Cause Analysis

### Code Changes Made (v4.0.6.83)

**Fix Applied:** Removed `COALESCE` from batch query to match individual query structure:

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

### Hypothesis

Since other account types work but Income doesn't, the issue is likely:

1. **BUILTIN.CONSOLIDATE returns NULL for Income** - If `BUILTIN.CONSOLIDATE` returns NULL, then `TO_NUMBER(NULL) = NULL`, and `NULL * -1 = NULL` (which SUM ignores, resulting in 0)
2. **Income transactions might not exist for Book 2** - But user confirmed they should exist
3. **Sign flip issue** - But the structure matches individual queries now

### Next Steps

1. ✅ **Check backend logs** for `[REVENUE DEBUG]` messages showing:
   - Diagnostic query results (do Income transactions exist?)
   - Test query results (raw vs consolidated amounts)
   - NULL detection in Income results

2. ⬜ **Run backend test script** to get actual values:
   ```bash
   ./test-typebalance-backend.sh http://localhost:5002 2025 "Celigo India Pvt Ltd" 2
   ```

3. ⬜ **Compare with individual query** - Test a single Income query for one period to see if it returns data

4. ⬜ **Check if BUILTIN.CONSOLIDATE returns NULL** - The diagnostic queries in the backend should reveal this

## Test Script

To run the backend test and generate a detailed report:

```bash
# Make sure backend server is running
./test-typebalance-backend.sh http://localhost:5002 2025 "Celigo India Pvt Ltd" 2
```

This will:
- Query the `/batch/typebalance_refresh` endpoint
- Display results in console
- Generate markdown report: `TYPEBALANCE_RESULTS_*.md`
- Save full JSON: `typebalance-results-*.json`

## Backend Logs to Review

After running the test, check backend logs for:

1. `[REVENUE DEBUG]` messages showing Income row analysis
2. Diagnostic query results: "Income transactions EXIST but query returned 0"
3. Test query results comparing raw vs consolidated amounts
4. NULL detection: "Income {Month}: NULL (TO_NUMBER returned NULL)"

These logs will reveal if:
- Income transactions exist in NetSuite
- `BUILTIN.CONSOLIDATE` is returning NULL
- Raw amounts exist but consolidation fails

---

## Summary Table

| Account Type | Months with Data | Total Value | Status |
|--------------|------------------|-------------|--------|
| **Income** | **0/12** | **$0.00** | **❌ BUG** |
| COGS | 7/12 | ~$45M | ✅ Working |
| Expense | 2/12 | ~$56M | ⚠️ Limited |
| OthIncome | 9/12 | ~$4M | ✅ Working |
| OthExpense | 8/12 | ~$38M | ✅ Working |

**Conclusion:** Income is the only account type failing. All other types return data, confirming the issue is specific to Income account handling in the batch query.

