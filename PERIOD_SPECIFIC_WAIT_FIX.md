# Fix: Period-Specific Wait Instead of Global Preload Wait

## Problem Statement

When dragging formulas across 11 months (Feb-Dec 2025), some cells resolve while others stay `#BUSY` in a mixed pattern across periods. This is unexpected - each period should fully resolve once that period's preload completes.

## Root Cause Analysis

### The Issue

**Location:** `docs/functions.js`, lines 4399-4431 (OLD CODE)

**Problem:**
1. Formulas check `isPreloadInProgress()` which checks **global** preload status (`PRELOAD_STATUS_KEY`)
2. If global preload is running, formulas call `waitForPreload()` which waits for **global** status to change from "running" to "complete"
3. When preloading 11 periods sequentially (chunk size 1), each period takes ~60-90 seconds
4. **Global preload status stays "running" until ALL 11 periods complete** (~11-16 minutes total)
5. Feb 2025 completes and is cached after ~60s, but formulas for Feb keep waiting because global status is still "running"
6. Formulas timeout after 120s and throw `BUSY`, even though their period is already cached

### Why Mixed Resolution Pattern?

- **Formulas in BUILD MODE:** Check cache per formula, resolve as periods complete (correct behavior)
- **Formulas in normal mode:** Wait for global preload, stay BUSY until all periods complete (incorrect behavior)

### Evidence from Logs

**Shared Runtime Logs:**
- Lines 110-300: All formulas show "⏳ Preload in progress - waiting for cache"
- These formulas are NOT in BUILD MODE - they're in normal mode
- They're waiting for global preload via `waitForPreload()`

**Taskpane Logs:**
- Line 116: "Periods to preload: Feb 2025, Mar 2025, Apr 2025, May 2025, Jun 2025, Jul 2025, Aug 2025, Sep 2025, Oct 2025, Nov 2025, Dec 2025"
- Lines 120-432: Each period processed sequentially (chunk size 1)
- Each period completes and caches 198 accounts
- Line 433: "✅ AUTO-PRELOAD COMPLETE: 198 BS accounts × 11 period(s)"
- **But global preload status stays "running" until ALL 11 periods complete**

## The Fix

**Changed:** `docs/functions.js`, lines 4395-4484

**Solution:** Use **period-specific waiting** instead of global preload waiting.

### Key Changes

1. **Check manifest for specific period** (not global status):
   ```javascript
   const status = getPeriodStatus(filtersHash, periodKey);
   ```

2. **Wait for specific period** (not global preload):
   ```javascript
   if (status === "running" || status === "requested") {
       await waitForPeriodCompletion(filtersHash, periodKey, maxWait);
   }
   ```

3. **Check cache immediately if period already completed**:
   ```javascript
   else if (status === "completed") {
       // Check cache immediately (no wait needed)
       const localStorageValue = checkLocalStorageCache(...);
       if (localStorageValue !== null) {
           return localStorageValue;
       }
   }
   ```

### Behavior After Fix

**Before:**
- Feb 2025 formulas wait for ALL 11 periods to complete (~11-16 minutes)
- Formulas timeout after 120s, throw BUSY
- Mixed resolution pattern (BUILD MODE vs normal mode)

**After:**
- Feb 2025 formulas wait only for Feb 2025 to complete (~60-90 seconds)
- Formulas resolve as soon as their specific period completes
- Consistent resolution pattern across all formulas

## Code Changes

### OLD CODE (lines 4399-4431):
```javascript
if (isPreloadInProgress()) {
    console.log(`⏳ Preload in progress - waiting for cache (${account}/${fromPeriod || toPeriod})`);
    await waitForPreload(); // ❌ Waits for GLOBAL preload status
    console.log(`✅ Preload complete - checking cache`);
    // ... check cache ...
}
```

### NEW CODE (lines 4404-4484):
```javascript
if (isPreloadInProgress() && lookupPeriod) {
    const periodKey = normalizePeriodKey(lookupPeriod);
    if (periodKey) {
        const filtersHash = getFilterKey({ subsidiary, department, location, classId, accountingBook });
        const status = getPeriodStatus(filtersHash, periodKey); // ✅ Check SPECIFIC period
        
        if (status === "running" || status === "requested") {
            await waitForPeriodCompletion(filtersHash, periodKey, maxWait); // ✅ Wait for SPECIFIC period
            // ... check cache immediately after period completes ...
        } else if (status === "completed") {
            // ✅ Period already completed - check cache immediately (no wait)
            const localStorageValue = checkLocalStorageCache(...);
            if (localStorageValue !== null) {
                return localStorageValue;
            }
        }
    }
}
```

## Expected Behavior After Fix

When dragging 11 months (Feb-Dec 2025):

1. **All formulas enter BUILD MODE or normal mode**
2. **Preload starts processing periods sequentially** (chunk size 1)
3. **Feb 2025 completes after ~60-90s:**
   - Formulas for Feb 2025 check manifest → status = "completed"
   - Formulas check cache → cache hit → **resolve immediately** ✅
4. **Mar 2025 completes after ~60-90s:**
   - Formulas for Mar 2025 check manifest → status = "completed"
   - Formulas check cache → cache hit → **resolve immediately** ✅
5. **And so on for each period...**

**Result:** Each period's formulas resolve as soon as that period completes, not when all periods complete.

## Testing Recommendations

1. **Clear all precached data**
2. **Drag formulas across 11 months** (Feb-Dec 2025)
3. **Observe:**
   - Formulas should resolve period by period as each period completes
   - No mixed BUSY/resolved pattern within the same period
   - All formulas for a period should resolve together when that period completes

## Related Issues

- This fix addresses the same root cause as the "thundering herd" issue
- The manifest-based period tracking was already implemented, but formulas were using global preload wait instead of period-specific wait
- BUILD MODE already had correct behavior (checks cache per formula), but normal mode did not

