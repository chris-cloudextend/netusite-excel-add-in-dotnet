# Root Cause Analysis: Drag-Right Not Using Preload Cache

## Issue Summary
When dragging right across columns (adding new periods), Income Statement formulas are resolving row-by-row instead of using the preload cache, causing slow performance.

## Root Cause

### The Problem
The Income Statement preload logic only triggers when `totalIncomeFormulasQueued === 1` (the very first formula ever). When dragging right to new periods (Feb, Mar, etc.), the counter is already > 1, so no preload is triggered for those new periods.

**Current Code (Line 7700-7705 in `docs/functions.js`):**
```javascript
if (window.totalIncomeFormulasQueued === 1) {
    console.log(`🚀 About to trigger income preload for first formula: ${account}/${normalizedToPeriod}`);
    triggerIncomePreload(account, normalizedToPeriod, { subsidiary, department, location, classId, accountingBook });
    console.log(`✅ Income preload trigger call completed`);
    shouldWaitForPreload = true; // Wait for the preload we just triggered
}
```

**What Happens When Dragging Right:**
1. **Jan Column (Row 1):** `totalIncomeFormulasQueued = 1` → Triggers preload for Jan ✅
2. **Feb Column (Row 1):** `totalIncomeFormulasQueued = 2` → Skips preload trigger ❌
3. **Mar Column (Row 1):** `totalIncomeFormulasQueued = 3` → Skips preload trigger ❌
4. Formulas for Feb/Mar go to queue → Processed row-by-row via API calls → Slow ❌

### Comparison with Balance Sheet

**Balance Sheet (Working Correctly):**
- `triggerAutoPreload()` is called for **each new period** that isn't cached
- Uses `checkIfPeriodIsCached()` to determine if preload is needed
- Period-aware: Each period can trigger its own preload independently
- Code path: Balance Sheet formulas check manifest → If period not found → Trigger preload for that period

**Income Statement (Current Bug):**
- `triggerIncomePreload()` is only called when `totalIncomeFormulasQueued === 1`
- Uses a **global counter** instead of period-aware logic
- Only the first formula ever triggers a preload, regardless of period
- New periods (Feb, Mar) never get preloads triggered

## Proposed Fix

### Solution: Period-Aware Preload Triggering

Make Income Statement preload logic period-aware, similar to Balance Sheet. Instead of only triggering on the first formula ever, trigger preload for each **new period** that isn't already cached.

### Code Changes Required

**Location:** `docs/functions.js`, Income Statement path in `BALANCE()` function (around line 7691-7738)

**Current Logic:**
```javascript
// First Income Statement formula - trigger automatic preload!
// Track income formulas to detect first one
if (typeof window.totalIncomeFormulasQueued === 'undefined') {
    window.totalIncomeFormulasQueued = 0;
}
window.totalIncomeFormulasQueued++;
console.log(`🔍 Income preload check: totalIncomeFormulasQueued = ${window.totalIncomeFormulasQueued}, account = ${account}, period = ${normalizedToPeriod}, preloadInProgress = ${preloadInProgress}`);

let shouldWaitForPreload = false;
if (window.totalIncomeFormulasQueued === 1) {
    console.log(`🚀 About to trigger income preload for first formula: ${account}/${normalizedToPeriod}`);
    // CRITICAL: Use normalized period name (not Excel date serial) for preload trigger
    triggerIncomePreload(account, normalizedToPeriod, { subsidiary, department, location, classId, accountingBook });
    console.log(`✅ Income preload trigger call completed`);
    shouldWaitForPreload = true; // Wait for the preload we just triggered
} else if (preloadInProgress) {
    // ... existing wait logic ...
}
```

**Proposed Logic:**
```javascript
// Income Statement preload: Period-aware triggering (similar to Balance Sheet)
// Check if this period is already cached
const isPeriodCached = checkIfPeriodIsCached(normalizedToPeriod);
console.log(`🔍 Income preload check: period = ${normalizedToPeriod}, isPeriodCached = ${isPeriodCached}, preloadInProgress = ${preloadInProgress}`);

let shouldWaitForPreload = false;

// CRITICAL FIX: Trigger preload for NEW periods (not just first formula ever)
// This matches Balance Sheet behavior: each new period gets its own preload
if (!isPeriodCached) {
    console.log(`🚀 Period ${normalizedToPeriod} not cached - triggering income preload`);
    triggerIncomePreload(account, normalizedToPeriod, { subsidiary, department, location, classId, accountingBook });
    console.log(`✅ Income preload trigger call completed`);
    shouldWaitForPreload = true; // Wait for the preload we just triggered
} else if (preloadInProgress) {
    console.log(`⏳ Income preload already in progress - will wait for it to complete`);
    shouldWaitForPreload = true; // Wait for existing preload
} else if (preloadTimestamp && (Date.now() - preloadTimestamp < 10000)) {
    // CRITICAL FIX: If preload was triggered recently (within last 10 seconds), wait for it
    // This handles the race condition where drag-down formulas evaluate before preload status is set
    console.log(`⏳ Income preload was recently triggered (${Math.round((Date.now() - preloadTimestamp) / 1000)}s ago) - will wait for it to complete`);
    shouldWaitForPreload = true;
} else {
    // Period is cached - no need to wait for preload
    console.log(`✅ Period ${normalizedToPeriod} is already cached - no preload needed`);
}
```

### Key Differences from Current Implementation

1. **Period-Aware Check:** Uses `checkIfPeriodIsCached(normalizedToPeriod)` instead of `totalIncomeFormulasQueued === 1`
2. **Removes Global Counter Dependency:** No longer relies on `totalIncomeFormulasQueued` to determine if preload should trigger
3. **Matches Balance Sheet Pattern:** Each new period triggers its own preload, just like BS accounts
4. **Maintains Race Condition Fixes:** Keeps the recent timestamp check and re-check logic for drag-down scenarios

### Why This Works

1. **First Period (Jan):** Not cached → Triggers preload → Waits → Uses cache ✅
2. **Second Period (Feb):** Not cached → Triggers preload → Waits → Uses cache ✅
3. **Third Period (Mar):** Not cached → Triggers preload → Waits → Uses cache ✅
4. **Subsequent Formulas for Same Period:** Already cached → Instant resolution ✅

### Taskpane Already Supports This

The taskpane's `processIncomePreloadTriggers()` function already:
- Collects all periods from multiple triggers (line 8886: `const allPeriods = new Set()`)
- Merges periods from different triggers (line 8905: `allPeriods.add(trigger.firstPeriod)`)
- Processes all periods in a single preload operation (line 8964-9067)

So triggering preload for each new period will work seamlessly - the taskpane will merge them.

## Differences: Balance Sheet vs Income Statement

| Aspect | Balance Sheet | Income Statement (Current) | Income Statement (Proposed) |
|--------|--------------|---------------------------|----------------------------|
| **Preload Trigger** | Period-aware: Each new period triggers preload | Global counter: Only first formula ever | Period-aware: Each new period triggers preload |
| **Cache Check** | `checkIfPeriodIsCached()` before triggering | Not used for trigger decision | `checkIfPeriodIsCached()` before triggering |
| **Counter Logic** | No global counter | `totalIncomeFormulasQueued` global counter | No global counter needed |
| **Drag-Right Behavior** | ✅ Each new period gets preload | ❌ Only first period gets preload | ✅ Each new period gets preload |
| **Taskpane Support** | ✅ Merges multiple periods | ✅ Merges multiple periods | ✅ Merges multiple periods |

## Testing Scenarios

### Scenario 1: Drag Down Then Right
1. Enter formula for Jan (Row 1) → Should trigger preload for Jan
2. Drag down 200 rows → Should wait for Jan preload, then use cache
3. Drag right to Feb → Should trigger preload for Feb
4. Drag down 200 rows → Should wait for Feb preload, then use cache
5. Drag right to Mar → Should trigger preload for Mar
6. Drag down 200 rows → Should wait for Mar preload, then use cache

**Expected:** All formulas resolve quickly using preload cache

### Scenario 2: Drag Right First
1. Enter formula for Jan (Row 1) → Should trigger preload for Jan
2. Drag right to Feb → Should trigger preload for Feb
3. Drag right to Mar → Should trigger preload for Mar
4. Drag down 200 rows → Should use cache for all three periods

**Expected:** All formulas resolve quickly using preload cache

### Scenario 3: Already Cached Periods
1. Enter formula for Jan (Row 1) → Triggers preload for Jan
2. Wait for preload to complete
3. Enter formula for Feb (Row 1) → Should detect Jan is cached, trigger preload for Feb
4. Enter formula for Mar (Row 1) → Should detect Jan/Feb are cached, trigger preload for Mar

**Expected:** Only new periods trigger preloads, cached periods skip preload

## Implementation Notes

1. **Remove or Repurpose `totalIncomeFormulasQueued`:** This counter is no longer needed for preload triggering. It could be kept for logging/debugging purposes, but should not be used to determine if preload should trigger.

2. **Keep Race Condition Fixes:** The recent timestamp check (10 seconds) and re-check logic (for first 20 formulas) should be maintained to handle drag-down race conditions.

3. **Backward Compatibility:** The `triggerIncomePreload()` function already supports multiple periods (line 2922-2925), and the taskpane merges them, so this change is backward compatible.

4. **Performance:** This change will trigger more preloads (one per new period), but:
   - Preloads are fast for Income Statement (5-15 seconds for full year)
   - Taskpane merges multiple triggers efficiently
   - The benefit (instant drag-down/right) outweighs the cost (one preload per period)

## Code Review Checklist

- [ ] Replace `totalIncomeFormulasQueued === 1` check with `!checkIfPeriodIsCached(normalizedToPeriod)`
- [ ] Keep race condition fixes (timestamp check, re-check logic)
- [ ] Update logging to reflect period-aware logic
- [ ] Test drag-right scenario (new periods)
- [ ] Test drag-down scenario (same period)
- [ ] Test mixed scenario (drag down then right)
- [ ] Verify taskpane merges multiple period triggers correctly
- [ ] Verify cache is populated correctly for each period
