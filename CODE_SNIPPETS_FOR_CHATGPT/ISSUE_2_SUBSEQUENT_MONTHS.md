# Issue 2: Precaching for Subsequent Months Not Working

## Problem Description

When a user drags formulas across new months (e.g., dragging 2/1/25 across 3/1/25 and 4/1/25), the auto-preload mechanism does **not** trigger for these new periods. This results in individual API calls for each formula instead of batch preloading.

### Symptoms
- User adds formulas for Jan 2025 and Feb 2025 → preload triggers ✅
- User drags Feb 2025 formula across Mar 2025 and Apr 2025 columns
- **While some cells are still in BUSY state** (from zero balance accounts), user drags formulas
- Mar 2025 and Apr 2025 periods are **not precached**
- Console shows: "Period Mar 2025 not cached, but preload in progress - waiting for completion..."
- After preload completes, Mar/Apr are still not cached
- Individual API calls are made for each formula (~60-90 seconds each)

### Expected Behavior
- When user drags formulas to new periods (Mar, Apr), auto-preload should trigger for those periods
- Preload should complete and cache all accounts for the new periods
- Subsequent formulas should resolve instantly from cache

## Root Cause Analysis

### Current Auto-Preload Trigger Logic

The `triggerAutoPreload()` function in `functions.js` (lines 398-455) is designed to trigger for new periods:

```javascript
function triggerAutoPreload(firstAccount, firstPeriod) {
    const normalizedPeriod = convertToMonthYear(firstPeriod, false);
    
    // Check if this period is already cached
    const isPeriodCached = checkIfPeriodIsCached(normalizedPeriod);
    
    if (isPeriodCached) {
        console.log(`✅ Period ${normalizedPeriod} already cached, skipping auto-preload`);
        return;
    }
    
    // CRITICAL: Allow preload to trigger for NEW periods even if a previous preload is in progress
    if (autoPreloadInProgress) {
        console.log(`🔄 Auto-preload in progress, but ${normalizedPeriod} is new period - triggering additional preload`);
        // Continue to trigger - taskpane will handle merging periods
    }
    
    // ... trigger preload ...
}
```

**Potential Issue:** The function allows triggering for new periods, but there may be a race condition or timing issue.

### Post-Preload Period Check

The `BALANCE()` function (lines 4020-4049) checks if a period is still missing after preload completes:

```javascript
if (preloadRunning) {
    console.log(`⏳ Period ${lookupPeriod} not cached, but preload in progress - waiting for completion...`);
    const preloadCompleted = await waitForPreload(90000);
    
    if (preloadCompleted) {
        // Re-check cache
        const retryCacheValue = checkLocalStorageCache(account, fromPeriod, toPeriod, subsidiary);
        if (retryCacheValue !== null) {
            return retryCacheValue;
        }
        
        // CRITICAL: If period still not cached after preload completed,
        // trigger a new preload for this period
        console.log(`🔄 Period ${lookupPeriod} still not cached after preload - triggering new preload`);
        triggerAutoPreload(account, lookupPeriod);
    }
}
```

**Potential Issue:** This logic triggers a new preload, but if formulas are being dragged while cells are still BUSY, the trigger might not be detected or processed correctly.

### Taskpane Period Inclusion

The taskpane auto-preload handler (lines 8598-8618) ensures the trigger period is included:

```javascript
// CRITICAL: Always ensure trigger.firstPeriod is included (normalized)
if (trigger.firstPeriod) {
    let normalizedPeriod = trigger.firstPeriod.trim();
    // ... normalize ...
    
    // Add to periods set if not already present
    if (!formulaData.periods.includes(normalizedPeriod)) {
        formulaData.periods.push(normalizedPeriod);
        console.log(`➕ Added trigger period to preload: ${normalizedPeriod}`);
    }
}
```

**Potential Issue:** If multiple periods trigger simultaneously (Mar, Apr), the taskpane might only process one or might not merge them correctly.

## What We've Tried

1. **Allow Re-Triggering for New Periods** ✅
   - Modified `triggerAutoPreload()` to allow triggering even if preload is in progress
   - **Result:** Logic is in place, but may not be working as expected

2. **Post-Preload Period Check** ✅
   - Added logic to trigger new preload if period still missing after preload completes
   - **Result:** Logic exists, but timing may be off

3. **Period Normalization** ✅
   - Ensured all periods are normalized consistently
   - **Result:** Normalization works correctly

## Potential Issues

### Issue A: Race Condition During Drag

**Scenario:**
1. User drags Feb formula across Mar and Apr columns
2. Multiple formulas are created simultaneously
3. Some cells (zero balances) are still BUSY from previous preload
4. New formulas for Mar/Apr trigger `triggerAutoPreload()`
5. But `autoPreloadInProgress` flag might be preventing detection

**Question:** Should we check `isPreloadInProgress()` (localStorage) instead of just the in-memory flag?

### Issue B: Taskpane Not Processing Multiple Triggers

**Scenario:**
1. Multiple formulas trigger `triggerAutoPreload()` for Mar and Apr
2. Multiple `netsuite_auto_preload_trigger` signals are set in localStorage
3. Taskpane might only process the first one
4. Later triggers might be overwritten

**Question:** Should the taskpane merge all periods from multiple triggers, or should we batch the triggers?

### Issue C: Preload Completes Before New Periods Are Detected

**Scenario:**
1. Initial preload for Jan/Feb starts
2. User drags formulas to Mar/Apr while preload is running
3. Preload completes before Mar/Apr formulas are evaluated
4. Mar/Apr formulas check cache, find nothing, trigger new preload
5. But the trigger might be too late or not processed correctly

**Question:** Should we scan the sheet for ALL periods before starting preload, not just the trigger period?

### Issue D: BUSY State Interference

**User Observation:** "I did drag 2/1/25 across both 3/1 and 4/1 WHILE the transactions with no activity were still in BUSY state"

**Potential Issue:** If cells are still BUSY (waiting for individual API calls), the formulas might not be fully evaluated yet, so the period detection might not work correctly.

**Question:** Should we wait for all formulas to settle before triggering preload? Or should we trigger preload immediately when new periods are detected?

## Proposed Solutions

### Solution 1: Enhanced Period Detection

Before triggering preload, scan the entire sheet for ALL periods in formulas, not just the trigger period:

```javascript
// In triggerAutoPreload or taskpane handler
const allPeriods = scanSheetForAllPeriods();  // Get all periods from all formulas
const uncachedPeriods = allPeriods.filter(p => !checkIfPeriodIsCached(p));

if (uncachedPeriods.length > 0) {
    // Trigger preload for ALL uncached periods
    triggerPreloadForPeriods(uncachedPeriods);
}
```

### Solution 2: Debounce and Batch Triggers

When multiple periods trigger preload simultaneously, batch them:

```javascript
let pendingPreloadPeriods = new Set();

function triggerAutoPreload(account, period) {
    const normalizedPeriod = convertToMonthYear(period, false);
    pendingPreloadPeriods.add(normalizedPeriod);
    
    // Debounce: wait 500ms to collect all periods
    clearTimeout(preloadBatchTimer);
    preloadBatchTimer = setTimeout(() => {
        const periods = Array.from(pendingPreloadPeriods);
        triggerPreloadForPeriods(periods);
        pendingPreloadPeriods.clear();
    }, 500);
}
```

### Solution 3: Check localStorage Flag Instead of In-Memory

Use `isPreloadInProgress()` (checks localStorage) instead of `autoPreloadInProgress` flag:

```javascript
// In BALANCE() function
const preloadRunning = isPreloadInProgress();  // Check localStorage, not just flag
```

### Solution 4: Wait for Formula Settlement

Before triggering preload, wait for all formulas to settle (exit BUSY state):

```javascript
async function triggerAutoPreload(account, period) {
    // Wait for any pending formulas to settle
    await waitForFormulasToSettle(2000);  // Wait up to 2s
    
    // Then trigger preload
    // ...
}
```

## Key Questions for ChatGPT

1. **Race Condition:** Is there a race condition when formulas are dragged while cells are still BUSY? How should we handle this?

2. **Multiple Triggers:** Should we batch multiple preload triggers, or process them sequentially? What's the best approach?

3. **Period Detection:** Should we scan the entire sheet for all periods before preloading, or rely on individual formula triggers?

4. **Timing:** Should we wait for formulas to settle before triggering preload, or trigger immediately?

5. **localStorage vs In-Memory:** Should we use `isPreloadInProgress()` (localStorage) instead of `autoPreloadInProgress` flag for more reliable detection?

## Testing Scenarios

1. **Sequential Periods:**
   - Add Jan → preload triggers ✅
   - Add Feb → preload triggers ✅
   - Add Mar → preload should trigger ❌ (currently doesn't)

2. **Drag Across Multiple Periods:**
   - Drag Feb formula across Mar and Apr
   - Expected: Preload triggers for both Mar and Apr
   - Actual: Preload doesn't trigger, individual API calls made

3. **While BUSY:**
   - Drag formulas while some cells are still BUSY
   - Expected: New periods detected and preloaded
   - Actual: Preload doesn't trigger correctly

4. **Post-Preload Check:**
   - After preload completes, check if new periods are cached
   - Expected: If not cached, trigger new preload
   - Actual: Logic exists but may not be working

