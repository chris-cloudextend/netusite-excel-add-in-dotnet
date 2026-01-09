# Duplicate Preload Trigger Fix - Summary for Claude

## Overview
This document summarizes the issues encountered with duplicate preload triggers when dragging `XAVI.BALANCE` formulas across multiple columns/periods, and the fixes implemented to prevent these duplicates.

## Issues Identified

### Issue 1: Duplicate Preload Triggers from Individual vs Batch Paths
**Problem**: When dragging formulas across new periods (e.g., from Jan 2025 to Feb 2025 and Mar 2025), the first cell would trigger a preload via the individual API call path, but then the batch processing logic would also trigger a duplicate preload for the same period.

**Root Cause**: The batch preload logic only checked if a period was `"completed"` (fully preloaded), but didn't check if a preload was already `"requested"` or `"running"` (in progress). This caused the batch to trigger a new preload even when one was already in progress.

**Evidence from Logs**:
```
[Log] 🔄 Auto-preload in progress, but Feb 2025 is new period - triggering additional preload
[Log] 🚀 AUTO-PRELOAD: Triggered for new period (10010, Feb 2025)
[Log] 📋 Manifest updated: Feb 2025 status = requested
...
[Log] 🚀 FULL PRELOAD: Fetching ALL accounts for Feb 2025 (same as manual entry)
[Log] 🔄 Auto-preload in progress, but Feb 2025 is new period - triggering additional preload
[Log] 🚀 AUTO-PRELOAD: Triggered for new period (10010, Feb 2025)
```

### Issue 2: Timeout Handling Triggering Duplicate Preloads
**Problem**: When a preload timed out or failed, the code would trigger a new preload even if one was already running, leading to duplicate preload requests.

**Evidence from Logs**:
```
[Warning] ⚠️ FULL PRELOAD: Timeout or failure for Feb 2025 - will use targeted preload as fallback
[Log] 🔬 PRELOAD DECISION DEBUG (chunk processing):
  periodStatus: "running"
  willTriggerFullPreload: true  // ❌ Should be false!
[Log] 🔄 NEW PERIOD: Feb 2025 - triggering FULL preload (not targeted)
```

### Issue 3: Scoping Error in Task Pane
**Problem**: The task pane code had a temporal dead zone (TDZ) error where `preloadFiltersHash` was accessed before initialization, causing the error: "Cannot access 'preloadFiltersHash' before initialization".

**Root Cause**: The variable was declared after it was used in a function closure, causing a JavaScript TDZ error.

## Fixes Implemented

### Fix 1: Detect In-Progress Preloads in Initial Check
**Location**: `docs/functions.js`, lines ~1275-1333

**Before**:
```javascript
const periodStatus = getPeriodStatus(filtersHash, period);
const isFullyPreloaded = periodStatus === "completed";

if (!isFullyPreloaded) {
    // Trigger new preload - ❌ Doesn't check if already in progress
    periodsToPreload.push(period);
}
```

**After**:
```javascript
const periodStatus = getPeriodStatus(filtersHash, period);
const isFullyPreloaded = periodStatus === "completed";
const isPreloadInProgress = periodStatus === "requested" || periodStatus === "running";

if (isFullyPreloaded) {
    console.log(`⚡ ALREADY PRELOADED: ${period} - will check cache`);
} else if (isPreloadInProgress) {
    // Preload is already in progress - wait for it instead of triggering duplicate
    console.log(`⏳ PRELOAD IN PROGRESS: ${period} (status: ${periodStatus}) - waiting for existing preload to complete`);
    periodsToPreload.push(period); // Add to list to wait for, but don't trigger new preload
} else {
    // This period hasn't been preloaded yet - trigger FULL preload
    console.log(`🚀 FULL PRELOAD: Fetching ALL accounts for ${period} (same as manual entry)`);
    periodsToPreload.push(period);
}
```

**Key Changes**:
1. Added `isPreloadInProgress` check for `"requested"` or `"running"` status
2. Separated periods into `periodsToTrigger` (new preloads) and `periodsToWait` (already in progress)
3. Only trigger new preloads for periods that aren't already in progress
4. Wait for all periods (both newly triggered and already in progress) to complete

### Fix 2: Detect In-Progress Preloads in Chunk Processing
**Location**: `docs/functions.js`, lines ~1459-1503

**Before**:
```javascript
const periodStatus = getPeriodStatus(filtersHash, period);
const isFullyPreloaded = periodStatus === "completed";

if (!isFullyPreloaded) {
    periodsNeedingFullPreload.push(period);
    console.log(`🔄 NEW PERIOD: ${period} - triggering FULL preload (not targeted)`);
}
```

**After**:
```javascript
const periodStatus = getPeriodStatus(filtersHash, period);
const isFullyPreloaded = periodStatus === "completed";
const isPreloadInProgress = periodStatus === "requested" || periodStatus === "running";

if (isFullyPreloaded) {
    console.log(`⚡ ALREADY PRELOADED: ${period} - skipping preload`);
} else if (isPreloadInProgress) {
    // Preload already in progress - wait for it instead of triggering duplicate
    periodsToWaitFor.push(period);
    console.log(`⏳ PRELOAD IN PROGRESS: ${period} (status: ${periodStatus}) - will wait for existing preload`);
} else {
    // New period - trigger full preload
    periodsNeedingFullPreload.push(period);
    console.log(`🔄 NEW PERIOD: ${period} - triggering FULL preload (not targeted)`);
}
```

**Key Changes**:
1. Added `periodsToWaitFor` array to track periods already in progress
2. Added logic to wait for in-progress preloads before proceeding
3. Only trigger new preloads for periods that aren't already in progress

### Fix 3: Wait for In-Progress Preloads
**Location**: `docs/functions.js`, lines ~1505-1530

**New Code Added**:
```javascript
// Wait for any periods that are already in progress
if (periodsToWaitFor.length > 0) {
    console.log(`⏳ WAITING FOR PRELOAD: ${periodsToWaitFor.length} period(s) already in progress: ${periodsToWaitFor.join(', ')}`);
    const maxWait = 120000; // 120 seconds
    for (const period of periodsToWaitFor) {
        const waited = await waitForPeriodCompletion(filtersHash, period, maxWait);
        if (waited) {
            console.log(`✅ PRELOAD COMPLETE: ${period} finished (was already in progress)`);
            // Wait for cache to be populated
            await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second buffer
            
            // Verify cache is populated
            let cachePopulated = false;
            const sampleAccount = accounts.length > 0 ? accounts[0] : null;
            if (sampleAccount) {
                const sampleCached = checkLocalStorageCache(sampleAccount, null, period, filters.subsidiary || '', filtersHash);
                if (sampleCached !== null) {
                    cachePopulated = true;
                    console.log(`✅ Cache verified: ${period} is populated (sample account ${sampleAccount} found)`);
                }
            }
            
            if (!cachePopulated) {
                console.warn(`⚠️ Cache not populated for ${period} after waiting - may need targeted preload`);
            }
        } else {
            console.warn(`⚠️ PRELOAD TIMEOUT: ${period} did not complete within ${maxWait}ms (was already in progress)`);
        }
    }
}
```

**Key Features**:
1. Waits for periods that are already in progress instead of triggering duplicates
2. Verifies cache is populated after waiting
3. Provides clear logging for debugging

### Fix 4: Task Pane Scoping Error
**Location**: `docs/taskpane.html`, lines ~9223-9322

**Problem**: `preloadFiltersHash` was used in `isPeriodCached` function before it was declared.

**Before**:
```javascript
// Helper function defined before variable declaration
function isPeriodCached(period) {
    // Uses preloadFiltersHash - ❌ TDZ error!
    const status = window.getPeriodStatus(preloadFiltersHash, normalizedPeriod);
    // ...
}

// Variables declared later
const preloadFilters = formulaData.filters || {};
const preloadFiltersHash = formulaData.filtersHash || '||||1';
```

**After**:
```javascript
// Variables declared first
const preloadFilters = formulaData.filters || {};
const preloadFiltersHash = formulaData.filtersHash || '||||1';

// Helper function defined after variable declaration (as arrow function)
const isPeriodCached = (period) => {
    // Now preloadFiltersHash is available
    const status = window.getPeriodStatus(preloadFiltersHash, normalizedPeriod);
    // ...
};
```

**Key Changes**:
1. Moved variable declarations to before function definition
2. Changed function declaration to arrow function expression to avoid hoisting issues
3. Added comment explaining the ordering requirement

## Code References

### Primary Fix Locations

1. **Initial Preload Check** (`docs/functions.js`):
   - Lines ~1275-1333: Main preload decision logic
   - Lines ~1314-1333: Separation of periods to trigger vs wait for

2. **Chunk Processing Preload Check** (`docs/functions.js`):
   - Lines ~1459-1503: Chunk processing preload decision
   - Lines ~1505-1530: Wait for in-progress preloads

3. **Task Pane Scoping Fix** (`docs/taskpane.html`):
   - Lines ~9223-9225: Variable declarations moved early
   - Lines ~9278-9322: Function definition moved after variables

### Supporting Functions

- `getPeriodStatus(filtersHash, period)`: Returns period status (`"completed"`, `"running"`, `"requested"`, `"not_found"`)
- `waitForPeriodCompletion(filtersHash, period, maxWait)`: Waits for a period to complete preload
- `triggerAutoPreload(account, period, filters)`: Triggers full preload for a period
- `checkLocalStorageCache(account, fromPeriod, toPeriod, subsidiary, filtersHash)`: Checks if data is cached

## Expected Behavior After Fixes

### Scenario: Dragging Formulas Across New Periods

**Before Fix**:
1. First cell (10010, Feb 2025) triggers preload → status="requested"
2. Batch detects Feb 2025 not "completed" → triggers duplicate preload
3. Two preload requests sent to backend
4. Race condition and wasted resources

**After Fix**:
1. First cell (10010, Feb 2025) triggers preload → status="requested"
2. Batch detects Feb 2025 is "requested" (in progress) → waits for existing preload
3. Only one preload request sent to backend
4. All cells resolve once preload completes

### Log Output After Fix

**Expected logs**:
```
[Log] 🔍 PRELOAD CHECK: period=Feb 2025, status=requested, fullyPreloaded=false, inProgress=true
[Log] ⏳ PRELOAD IN PROGRESS: Feb 2025 (status: requested) - waiting for existing preload to complete
[Log] ⏳ WAITING FOR PRELOAD: 1 period(s) already in progress: Feb 2025
[Log] ✅ PRELOAD COMPLETE: Feb 2025 finished (was already in progress)
[Log] ✅ Cache verified: Feb 2025 is populated (sample account 10010 found)
```

**Should NOT see**:
```
[Log] 🔄 NEW PERIOD: Feb 2025 - triggering FULL preload (not targeted)  // ❌ Duplicate!
[Log] 🚀 FULL PRELOAD: Triggering for 1 period(s): Feb 2025  // ❌ Duplicate!
```

## Testing Recommendations

1. **Test dragging across new periods**: Drag formulas from Jan 2025 to Feb 2025 and Mar 2025
   - Verify only one preload is triggered per period
   - Check logs for "PRELOAD IN PROGRESS" messages
   - Verify no duplicate preload triggers

2. **Test timeout scenarios**: If a preload times out, verify it doesn't trigger a duplicate
   - Check that status="running" periods are waited for, not re-triggered

3. **Test task pane auto-preload**: Verify no "Cannot access 'preloadFiltersHash' before initialization" errors
   - Check task pane console for errors
   - Verify preload UI shows correct status

## Related Files

- `docs/functions.js`: Main batching and preload logic
- `docs/taskpane.html`: Task pane auto-preload trigger processing
- `backend-dotnet/Controllers/BalanceController.cs`: Backend preload endpoints
- `PERIOD_DEDUPLICATION_IMPLEMENTATION_SUMMARY.md`: Previous optimization work

## Summary

The fixes ensure that:
1. ✅ Preloads already in progress are detected and waited for, not duplicated
2. ✅ Timeout scenarios don't trigger duplicate preloads
3. ✅ Task pane scoping errors are resolved
4. ✅ All cells resolve efficiently once preload completes
5. ✅ No wasted backend resources from duplicate preload requests

The key insight is that the preload status can be `"requested"`, `"running"`, or `"completed"`, and we need to handle all three states appropriately:
- `"completed"`: Skip preload, use cache
- `"requested"` or `"running"`: Wait for existing preload
- `"not_found"` or unknown: Trigger new preload
