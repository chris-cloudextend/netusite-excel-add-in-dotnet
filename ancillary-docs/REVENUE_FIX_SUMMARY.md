# Revenue Not Showing on First Book Change - Fix Summary

## Problem
When changing from Accounting Book 1 to Book 2, revenue values were not appearing the first time, even though the backend was returning data correctly.

## Root Cause
The cache was being cleared **too early** in `handleSheetChange` (before Q3 subsidiary cell was updated), causing a race condition:

1. **U3 (Accounting Book) changes** → `handleSheetChange` fires
2. **Cache is cleared immediately** (line 17948-17958) - **TOO EARLY**
3. Excel formulas try to read from cache → see empty cache → return $0.00
4. **Q3 (Subsidiary) is updated** (line 18065-18070)
5. `performCFOSync` runs → clears cache AGAIN (redundant)
6. `performCFOSync` fetches data and populates cache
7. But Excel has already cached the "empty" result from step 3

## Solution
**Removed early cache clearing from `handleSheetChange`** - let `performCFOSync` handle all cache clearing AFTER Q3 is updated.

### Changes Made

1. **`docs/taskpane.html` (line ~17945-17960)**:
   - **REMOVED**: Early cache clearing in `handleSheetChange` before Q3 update
   - **REASON**: Cache was being cleared before Q3 was updated, causing formulas to see empty cache
   - **RESULT**: Cache is now only cleared in `performCFOSync` AFTER Q3 is updated

2. **Enhanced Debug Logging**:
   - Added `[REVENUE DEBUG]` logging to track cache key construction
   - Added logging to show exact values used for cache keys (subsidiary, book, etc.)
   - Added logging to verify cache is populated before formula recalculation

### Code Flow (After Fix)

1. **U3 (Accounting Book) changes** → `handleSheetChange` fires
2. **Q3 (Subsidiary) is updated synchronously** (line 18065-18070) - **BEFORE any cache clearing**
3. `handleAccountingBookChange` is called after 500ms debounce
4. `performCFOSync` runs:
   - Clears cache (line 19773-19786) - **NOW happens AFTER Q3 is updated**
   - Fetches data from backend
   - Populates cache with correct subsidiary/book combination
   - Waits 200ms to ensure localStorage is written
   - Triggers formula recalculation
5. Excel formulas read from populated cache → return correct values

## Testing
To verify the fix works:

1. Start with Book 1, consolidated subsidiary
2. Change to Book 2
3. Verify revenue values appear immediately (no need to refresh)
4. Check console logs for `[REVENUE DEBUG]` messages showing:
   - Cache keys being constructed
   - Cache being populated
   - Formulas reading from cache

## Version
- **Version**: 4.0.6.75
- **Files Changed**: 
  - `docs/taskpane.html`
  - `docs/functions.js` (version number only)

## Related Issues
- This fix addresses the issue where revenue was not showing on the first book change from 1 to 2
- The COALESCE fix (v4.0.6.74) ensures backend returns data correctly for single subsidiaries
- This fix ensures frontend cache is populated correctly before formulas read it

