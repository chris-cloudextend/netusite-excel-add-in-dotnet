# Query Performance Test Results

## Test Account: 4220 (Income Statement Account)

### Test 1: Full Range (Jan 2012 to Jan 2025)
- **Periods:** 13 years (156 months)
- **Time:** 77.9 seconds
- **Status:** ✅ SUCCESS (200)
- **Result:** $23,419,748.97
- **Note:** Correctly sums all periods from Jan 2012 through Jan 2025

### Test 2: Single Year (Jan 2025 to Jan 2025)
- **Periods:** 1 month
- **Time:** 125.5 seconds
- **Status:** ❌ TIMEOUT (524)
- **Result:** Failed
- **Issue:** Query times out when from_period equals to_period

### Test 3: Year Endpoint (2025)
- **Periods:** Full year (12 months)
- **Time:** 20.4 seconds
- **Status:** ✅ SUCCESS (200)
- **Result:** $3,815,677.22 (FY 2025 total)
- **Note:** Year endpoint is much faster but returns full year, not single month

## Analysis

1. **Full range query works correctly** - Sums all 156 months in 77.9 seconds
2. **Single period query times out** - There's a bug when from_period === to_period
3. **Year endpoint is fastest** - But returns full year total, not single month

## Issue Identified

When `from_period === to_period` for income statement accounts, the backend appears to be doing a complex period activity calculation that times out. This should be a simple single-period query.

## Recommendation

For single period queries (from_period === to_period), the backend should:
- Detect this case early
- Use a simpler query that just gets that one period's value
- Avoid the period activity calculation path

---
**Test Date:** December 31, 2025
