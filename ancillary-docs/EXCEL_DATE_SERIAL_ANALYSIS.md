# Excel Date Serial Conversion Analysis

## Problem
Periods are showing as Excel date serials (45689, 45658, 45717) instead of normalized period names ("Jan 2025", "Feb 2025", "Mar 2025") in logs, preventing income preload from triggering.

## Root Cause Analysis

### Test Results
✅ **Normalization function works correctly:**
- Excel date serial `45689` → `"Feb 2025"` ✓
- Excel date serial `45658` → `"Jan 2025"` ✓
- Excel date serial `45717` → `"Mar 2025"` ✓
- String versions also work correctly ✓
- Already-normalized periods are recognized correctly ✓

### Potential Issues

1. **Timing Issue**: Periods might be logged before normalization occurs
2. **Range Object Extraction**: If Excel passes Range objects, `extractValueFromRange` might not extract the value correctly
3. **Normalization Failure**: `normalizePeriodKey` might return `null` in edge cases, causing fallback to original value
4. **Type Mismatch**: The value might be in an unexpected format that the normalization doesn't handle

## Code Flow

1. **Line 7302-7303**: Periods are normalized early in `BALANCE` function
   ```javascript
   fromPeriod = normalizePeriodKey(fromPeriod, true) || fromPeriod;
   toPeriod = normalizePeriodKey(toPeriod, false) || toPeriod;
   ```
   - If normalization returns `null`, fallback uses original value
   - This could explain why Excel date serials persist

2. **Line 7448**: Income statement path re-normalizes `toPeriod`
   ```javascript
   const normalizedToPeriod = normalizePeriodKey(toPeriod, false);
   ```
   - This should catch cases where initial normalization failed
   - But if `toPeriod` is still an Excel date serial, this should work

3. **Line 7472**: Preload trigger uses normalized period
   ```javascript
   triggerIncomePreload(account, normalizedToPeriod, { ... });
   ```
   - Should receive "Jan 2025" format, not Excel date serial

## Fixes Applied

1. ✅ **Re-normalization in income statement path** (line 7448)
   - Ensures period is normalized before preload trigger
   - Uses normalized period for cache lookups

2. ✅ **Debug logging added** (line 7302-7310)
   - Warns if normalization fails for Excel date serials
   - Helps identify when/why normalization fails

3. ✅ **Normalized period used for preload** (line 7472)
   - Preload trigger now receives "Mon YYYY" format

## Next Steps for Verification

1. **Check console logs** for the warning message:
   ```
   ⚠️ Period normalization failed for Excel date serial: 45689
   ```
   - If this appears, normalization is failing
   - If it doesn't appear, normalization is working but periods are logged before normalization

2. **Check for preload trigger logs**:
   ```
   🚀 INCOME PRELOAD: Triggered by first P&L formula
   ```
   - Should appear when first income statement formula is evaluated
   - Should show normalized period name, not Excel date serial

3. **Check queue logs**:
   ```
   📥 QUEUED [Income Statement]: 4450 for (cumulative) → Jan 2025
   ```
   - Should show normalized period name, not Excel date serial

## Expected Behavior After Fix

- Periods should be normalized to "Mon YYYY" format
- Preload should trigger with normalized period names
- Cache lookups should use normalized period names
- Logs should show "Jan 2025" not "45689"
