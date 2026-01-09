# Batch Resolution and Progress Indicator Issues

**Date:** January 9, 2026  
**Version:** 4.0.6.135  
**Status:** Issues Identified - Needs Fix

---

## Problem Summary

When dragging `XAVI.BALANCE` formulas from January over February and March, three critical issues occur:

1. **Cells resolve one-by-one instead of all at once** - March's first cell resolves first, while the rest show #BUSY. Eventually all resolve, but it takes much longer than expected.
2. **Task pane shows incorrect periods** - Shows "Preloading Feb 2025, Jan 2025 (2 periods)" even after January is complete. When dragging from Jan over Feb and March, it should only show the periods actually being preloaded (Feb, Mar), not Jan.
3. **Progress indicator remains running after completion** - The visual progress indicator continues showing preload in progress even after all periods are complete.

---

## Issue #12: Cells Resolving One-by-One Instead of All at Once

### The Problem

**Expected Behavior:**
- When dragging across columns (Jan → Feb, Mar), all cells in a column should resolve simultaneously when the batch completes
- All cells should show values at once, not one-by-one

**Actual Behavior:**
- March's first cell resolves first (gets a value)
- Rest of March cells and all February cells show #BUSY
- Eventually all resolve, but it takes much longer than if manually entering each column separately

**Evidence from Server Logs:**
```
Line 435: 📊 BS PRELOAD: Starting for 2 period(s): Mar 2025, Jan 2025
Line 531: 📊 BS PRELOAD: Starting for 1 period(s): Feb 2025
Line 587: 🔍 [BALANCE DEBUG] BalanceController.GetBalance: account=10010, to_period=Mar 2025
Line 605: ⚡ CACHE HIT: 10010 for Mar 2025 = $1,021,295.03
```

**Key Observations:**
1. Backend receives request for "Mar 2025, Jan 2025" (line 435) - Jan shouldn't be included
2. Backend also receives separate request for "Feb 2025" (line 531)
3. First cell in March gets a cache hit (full preload completed), but other cells are still showing #BUSY
4. This suggests cells are resolving one-by-one as they re-evaluate, not all at once

### Root Cause Analysis

**How Excel Custom Functions Work:**
1. When a function returns a `Promise`, Excel shows #BUSY
2. When the Promise resolves, Excel **re-evaluates the cell** to get the new value
3. Excel doesn't automatically re-evaluate all cells that were showing #BUSY when a batch completes

**Current Code Flow:**
1. Cells await `batchPromise` (line 7548 in `functions.js`)
2. When batch completes, results are written to cache (lines 7312-7395)
3. `pendingRequests.balance` entries are resolved (line 7368)
4. **BUT**: Excel needs to re-evaluate each cell individually to get the new value
5. Excel re-evaluates cells at different times (not all at once)
6. First cell that re-evaluates gets the result, others still show #BUSY until they re-evaluate

**The Issue:**
- When `batchPromise` resolves, all awaiting cells should get the result simultaneously
- But Excel's re-evaluation mechanism is asynchronous and happens at different times
- Cells that haven't re-evaluated yet still show #BUSY

**Additional Issue:**
- The code resolves `pendingRequests.balance` entries (line 7368), but cells might be awaiting `batchPromise` directly (line 7548)
- If a cell is awaiting `batchPromise` and the promise resolves, it should get the result immediately
- But if Excel hasn't re-evaluated that cell yet, it still shows #BUSY

### Potential Solutions

**Option 1: Force Excel to Re-evaluate All Cells**
- After batch completes, use `Office.context.document.settings.set()` to trigger recalculation
- Or use `Excel.run()` to mark cells as dirty and force re-evaluation
- **Problem**: Excel custom functions don't have direct access to force re-evaluation of other cells

**Option 2: Ensure All Cells Await the Same Promise**
- All cells should await `activePeriodQuery.promise` (not `batchPromise` directly)
- When the promise resolves, all awaiting cells should get results simultaneously
- **Current Issue**: Some cells might be checking cache before the promise resolves, others are awaiting the promise

**Option 3: Write Results to Cache Before Promise Resolves**
- Write results to cache immediately when batch completes
- Cells that check cache after batch completes will get results immediately
- Cells awaiting the promise will get results when promise resolves
- **Current Issue**: Cache write happens in the promise handler, so there's a timing gap

**Option 4: Use Office.context.document.settings to Notify Cells**
- When batch completes, write a flag to `Office.context.document.settings`
- Cells check this flag and re-evaluate if needed
- **Problem**: Custom functions can't directly trigger re-evaluation of other cells

### Recommended Fix

**The real issue is likely that cells are resolving at different times because:**
1. Batch completes and writes to cache
2. First cell that re-evaluates checks cache, gets result, resolves
3. Other cells haven't re-evaluated yet, still show #BUSY
4. Excel eventually re-evaluates all cells, but it's not instantaneous

**Solution:**
- Ensure cache is written **before** the promise resolves
- All cells should await the same promise (`activePeriodQuery.promise`)
- When promise resolves, all awaiting cells should get results simultaneously
- Excel will re-evaluate all cells, but they should all get results from the resolved promise

**Code Changes Needed:**
1. Write results to cache **before** resolving the placeholder promise
2. Ensure all cells await `activePeriodQuery.promise` (not `batchPromise` directly)
3. When promise resolves, all cells should get results from the promise, not from cache lookup

---

## Issue #13: Task Pane Shows Incorrect Periods

### The Problem

**Expected Behavior:**
- When dragging from Jan over Feb and March, task pane should show "Preloading Feb 2025, Mar 2025 (2 periods)"
- Should NOT include Jan 2025 (already cached)

**Actual Behavior:**
- Task pane shows "Preloading Feb 2025, Jan 2025 (2 periods)"
- Includes Jan 2025 even though it's already cached and complete

**Evidence from Server Logs:**
```
Line 435: 📊 BS PRELOAD: Starting for 2 period(s): Mar 2025, Jan 2025
```

The backend is receiving a request for Mar 2025 and Jan 2025, when it should only receive Mar 2025 (and Feb 2025 if needed).

### Root Cause Analysis

**Where the Period List Comes From:**
- The task pane scans formulas to find periods (line ~9212 in `taskpane.html`)
- Task pane filters out cached periods (lines 9295-9314)
- Task pane sends `uncachedPeriods` to backend (line 9403)
- **BUT**: `executeColumnBasedBSBatch` also calls `triggerAutoPreload` for each period (lines 1282-1293 in `functions.js`)
- This creates **multiple preload requests** from different sources

**Evidence from Server Logs:**
```
Line 435: 📊 BS PRELOAD: Starting for 2 period(s): Mar 2025, Jan 2025
Line 531: 📊 BS PRELOAD: Starting for 1 period(s): Feb 2025
```

**The Issue:**
- **Two separate preload requests are being sent:**
  1. One from task pane: "Mar 2025, Jan 2025" (includes Jan incorrectly)
  2. One from `executeColumnBasedBSBatch`: "Feb 2025" (correct)
- The task pane request includes Jan because:
  - Formula scan finds Jan in formulas (user dragged from Jan)
  - Cache check might happen before Jan is fully cached (race condition)
  - Or cache check is not working correctly for the filtersHash being used
- The progress indicator shows "Feb 2025, Jan 2025" because it's showing periods from the task pane request, which includes Jan incorrectly

### Recommended Fix

**Filter out cached periods before sending preload request:**
1. Before calling `triggerAutoPreload()`, check if period is already cached
2. Only include uncached periods in the preload request
3. Update task pane to show only the periods actually being preloaded

**Code Changes Needed:**
1. In `executeColumnBasedBSBatch()`, filter out cached periods before triggering full preload
2. In `triggerAutoPreload()`, filter out cached periods before sending request
3. In task pane, update progress indicator to show only active periods, not completed ones

---

## Issue #14: Progress Indicator Remains Running After Completion

### The Problem

**Expected Behavior:**
- Progress indicator should hide or show "Complete" when all periods are preloaded
- Should not continue showing "Preloading..." after completion

**Actual Behavior:**
- Progress indicator continues showing "Preloading Feb 2025, Jan 2025 (2 periods)" even after January is complete
- Remains running for a long time after the job is actually complete

### Root Cause Analysis

**How Progress Indicator Updates:**
- Task pane calls `updateLoading()` to show progress (line 9386 in `taskpane.html`)
- Calls `hideLoading()` when all periods complete (line 9633)
- **Issue**: `hideLoading()` might not be called if there are errors or if the completion check fails

**The Issue:**
- Progress indicator is updated when preload starts (line 9386)
- But might not be updated when preload completes if:
  - There are errors in the completion check
  - The completion check doesn't detect that all periods are done
  - The task pane is showing stale data from a previous request

### Recommended Fix

**Ensure progress indicator is updated correctly:**
1. Update progress indicator when each period completes
2. Hide progress indicator when all periods are complete
3. Clear stale progress data when new preload starts

**Code Changes Needed:**
1. In task pane, update progress indicator when each period completes (not just at the end)
2. Ensure `hideLoading()` is called even if there are errors
3. Clear progress indicator when new preload starts (don't show stale data)

---

## Expected Behavior After Fixes

### Scenario: Drag from Jan over Feb and March

**Timeline:**
1. User drags formulas from Jan column to Feb and Mar columns
2. Grid detection identifies: Jan (cached), Feb (needs preload), Mar (needs preload)
3. **Task pane shows**: "Preloading Feb 2025, Mar 2025 (2 periods)" ✅
4. Full preload triggered for Feb and Mar (not Jan) ✅
5. When Feb preload completes:
   - All Feb cells resolve simultaneously ✅
   - Task pane updates to show "Preloading Mar 2025 (1 period)" ✅
6. When Mar preload completes:
   - All Mar cells resolve simultaneously ✅
   - Task pane shows "Complete" or hides ✅

**Performance:**
- Total time should be ~160 seconds (80s for Feb + 80s for Mar)
- Should NOT be longer than manually entering each column separately
- All cells in a column should resolve at once, not one-by-one

---

## Code Locations to Review

1. **Cell Resolution (Issue #12):**
   - `docs/functions.js` lines 7312-7395: Batch results handler
   - `docs/functions.js` lines 7540-7572: Cell awaiting batch promise
   - `docs/functions.js` lines 7070-7085: Cell awaiting activePeriodQuery.promise

2. **Period Filtering (Issue #13):**
   - `docs/functions.js` lines 1264-1278: Full preload check
   - `docs/functions.js` lines 2436-2504: triggerAutoPreload function
   - `docs/taskpane.html` lines 9372-9390: Progress indicator update

3. **Progress Indicator (Issue #14):**
   - `docs/taskpane.html` lines 9386-9390: updateLoading call
   - `docs/taskpane.html` lines 9633: hideLoading call
   - `docs/taskpane.html` lines 9616-9630: Completion status update

---

## Questions for Claude

1. **Issue #12 (Cells resolving one-by-one):**
   - Is the issue that Excel re-evaluates cells at different times, or is there a code bug?
   - Should all cells await the same promise, or should they check cache after batch completes?
   - Is there a way to force Excel to re-evaluate all cells simultaneously when batch completes?

2. **Issue #13 (Task pane showing wrong periods):**
   - Where is the period list coming from that includes Jan 2025?
   - Should we filter out cached periods before sending the preload request?
   - Or should the task pane filter out completed periods when displaying?

3. **Issue #14 (Progress indicator not updating):**
   - Why is the progress indicator showing stale data?
   - Should we update it when each period completes, or only at the end?
   - Is there a race condition where new preload starts before old one finishes?

---

## Search Patterns

Find these in the codebase:
- `triggerAutoPreload` - function that triggers full preload
- `executeColumnBasedBSBatch` - where full preload check happens
- `updateLoading` / `hideLoading` - task pane progress indicator functions
- `pendingRequests.balance.resolve` - where cells are resolved
- `activePeriodQuery.promise` - promise that cells await
- `periodsText` - variable that holds period list for task pane display
