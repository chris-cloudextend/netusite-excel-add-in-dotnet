# Root Cause Analysis: Precache Not Triggering After Cache Clear

## Problem Summary

After clicking "Clear All Precached Data" in settings:
1. First formula (10010) returns instantly (cache hit) - **cache was NOT fully cleared**
2. Dragged 20 more rows - expected precache to trigger but it didn't
3. All cells show #BUSY and resolve one-by-one slowly (individual API calls)
4. Auto-preload trigger was created but taskpane didn't process it

## Console Log Analysis

### Key Observations from Logs

1. **First Formula - Cache Hit (Should Have Been Cleared)**
   ```
   ✅ Preload cache hit (xavi_balance_cache): 10010 for Jan 2025 = 2064705.84
   ```
   - Cache was NOT cleared from functions.js context
   - Suggests cache clear signal wasn't processed before formula evaluated

2. **Subsequent Formulas - Cache Misses**
   ```
   🔍 Preload cache: xavi_balance_cache not found in localStorage
   📭 localStorage cache miss: 10030 for (cumulative) → Jan 2025
   ```
   - Cache is actually empty for other accounts
   - First account (10010) somehow still cached

3. **Auto-Preload Triggered Too Late**
   ```
   🔨 EXITING BUILD MODE (0 formulas queued)
   🚀 AUTO-PRELOAD: Triggered by first BS formula (10030, Jan 2025)
   📤 Auto-preload trigger queued: netsuite_auto_preload_trigger_1766924267834_ypkoxmm8d
   ```
   - Auto-preload triggered AFTER formulas queued individual API calls
   - Trigger created but taskpane not processing it

4. **Formulas Proceeding with Individual Calls**
   ```
   📥 QUEUED: 10030 for (cumulative) → Jan 2025
   ⏱️ Batch timer FIRED!
   📤 Cumulative API: 10030 through Jan 2025
   ⏱️ SLOW BS QUERY: 10030 took 77.7s
   ```
   - Formulas making individual API calls instead of waiting for preload
   - Each call takes ~77 seconds

## Root Causes Identified

### Root Cause #1: Cache Clear Not Synchronized Across Contexts

**Location**: `docs/taskpane.html:18717-18753` (`clearPreloadCache()`)

**Problem**:
- Taskpane clears `xavi_balance_cache` from its localStorage context
- Sends signal `netsuite_cache_clear_signal` to functions.js
- **BUT**: Functions.js only checks this signal at the START of BALANCE() function
- If formula evaluates BEFORE signal is processed, cache still has old data
- First formula (10010) evaluated immediately after clear → cache hit

**Evidence**:
```javascript
// In BALANCE() function (line 4074):
const clearSignal = localStorage.getItem('netsuite_cache_clear_signal');
if (clearSignal) {
    const { timestamp, reason } = JSON.parse(clearSignal);
    if (Date.now() - timestamp < 10000) {  // Only checks if < 10 seconds old
        // Clear cache...
    }
}
```

**Issue**: 
- Signal might be older than 10 seconds by the time formula evaluates
- Or formula evaluates before signal is set
- Or signal is checked but in-memory cache still has data

**Impact**: First formula returns cached value even after "Clear All Precached Data"

---

### Root Cause #2: Auto-Preload Triggered After Formulas Queued

**Location**: `docs/functions.js:398-458` (`triggerAutoPreload()`)

**Problem**:
- Auto-preload is triggered when cache miss is detected
- **BUT**: This happens AFTER formulas have already queued individual API calls
- Sequence:
  1. Formulas check cache → MISS
  2. Formulas queue for individual API calls (BUILD MODE)
  3. BUILD MODE exits
  4. **THEN** auto-preload is triggered (too late)

**Evidence from Logs**:
```
🔨 EXITING BUILD MODE (0 formulas queued)  ← Formulas already queued
🚀 AUTO-PRELOAD: Triggered by first BS formula (10030, Jan 2025)  ← Too late!
```

**Location in Code**:
```javascript
// In BALANCE() function, around line 4510:
if (status === "not_found") {
    // Period not requested - trigger preload
    addPeriodToRequestQueue(periodKey, {...});
    // ... wait logic ...
}
```

**Issue**: 
- `addPeriodToRequestQueue()` is called AFTER cache miss
- But formulas have already queued individual API calls before this check
- Auto-preload trigger is created but formulas proceed anyway

**Impact**: Preload trigger created but formulas don't wait for it

---

### Root Cause #3: Taskpane Not Processing Auto-Preload Trigger

**Location**: `docs/taskpane.html:8490-8987` (auto-preload trigger handler)

**Problem**:
- Auto-preload trigger is created in localStorage: `netsuite_auto_preload_trigger_<timestamp>_<random>`
- Taskpane scans for these triggers on page load/refresh
- **BUT**: If taskpane is not open/loaded, trigger is never processed
- Trigger sits in localStorage but nothing happens

**Evidence**:
- Logs show trigger created: `📤 Auto-preload trigger queued: netsuite_auto_preload_trigger_...`
- But no logs from taskpane processing it
- No preload started

**Impact**: Preload never starts, formulas proceed with individual calls

---

### Root Cause #4: Formulas Don't Wait for Preload

**Location**: `docs/functions.js:4506-4528` (BALANCE function after cache miss)

**Problem**:
- When cache miss detected, formulas check manifest status
- If status is "not_found", they trigger preload and wait
- **BUT**: If preload is already triggered (status = "requested"), formulas proceed with API calls
- No wait mechanism for preload that's already in progress

**Evidence from Code**:
```javascript
// Line 4510-4528:
if (status === "not_found") {
    addPeriodToRequestQueue(periodKey, {...});
    const waited = await waitForPeriodCompletion(filtersHash, periodKey, 180000);
    // ... check cache after wait ...
} else if (status === "running" || status === "requested") {
    // Wait for completion
    const waited = await waitForPeriodCompletion(...);
} else {
    // Proceed with API call
}
```

**Issue**:
- If preload is "requested" but not yet "running", formulas might not wait properly
- Or wait times out and formulas proceed anyway
- Or preload never starts (taskpane not processing trigger)

**Impact**: Formulas make individual API calls instead of using preload

---

### Root Cause #5: Cache Clear Doesn't Clear In-Memory Cache Properly

**Location**: `docs/functions.js:4074-4092` (cache clear signal handler)

**Problem**:
- Cache clear signal is checked at START of BALANCE()
- Clears in-memory cache: `cache.balance.clear()`
- **BUT**: If formula already has value in cache, it returns BEFORE checking signal
- Or signal check happens but cache is repopulated from localStorage

**Evidence**:
```javascript
// Line 4074:
const clearSignal = localStorage.getItem('netsuite_cache_clear_signal');
if (clearSignal) {
    // Clear cache...
    cache.balance.clear();
    // ...
}
```

**Issue**:
- Signal check happens AFTER cache check in some code paths
- Or signal is too old (> 10 seconds) and ignored
- Or localStorage still has data and repopulates in-memory cache

**Impact**: First formula returns cached value even after clear

---

## Sequence of Events (What Actually Happened)

1. **User clicks "Clear All Precached Data"**
   - Taskpane clears `xavi_balance_cache` from localStorage
   - Sends `netsuite_cache_clear_signal` to functions.js
   - **BUT**: Functions.js in-memory cache might still have data

2. **User enters first formula: `=XAVI.BALANCE($C2,,H$1)`**
   - Formula evaluates immediately
   - Checks in-memory cache → **HIT** (cache clear signal not processed yet)
   - Returns instantly: `2064705.84`
   - **Problem**: Cache wasn't fully cleared

3. **User drags down 20 rows**
   - 20 formulas evaluate simultaneously
   - BUILD MODE detected (rapid formula creation)
   - Formulas check cache → **MISS** (cache actually empty now)
   - Formulas queue for individual API calls
   - BUILD MODE exits

4. **Auto-preload triggered (too late)**
   - After BUILD MODE exits, first formula (10030) triggers auto-preload
   - Creates trigger: `netsuite_auto_preload_trigger_...`
   - **BUT**: Formulas already queued individual API calls

5. **Taskpane doesn't process trigger**
   - Trigger sits in localStorage
   - Taskpane not open/loaded → trigger never processed
   - Preload never starts

6. **Formulas proceed with individual calls**
   - Batch queue processes 20 formulas
   - Each makes individual API call (~77 seconds each)
   - All cells show #BUSY
   - Resolve one-by-one slowly

---

## Why Precache Didn't Trigger

1. **Cache clear didn't work properly** - First formula still had cached value
2. **Auto-preload triggered too late** - After formulas already queued
3. **Taskpane not processing trigger** - Trigger created but never processed
4. **Formulas don't wait** - Proceed with individual calls instead of waiting for preload

---

## Recommendations (No Code Changes Yet)

### Fix #1: Synchronize Cache Clear Across Contexts
- Clear in-memory cache BEFORE clearing localStorage
- Use synchronous signal that's checked immediately
- Clear cache in functions.js context directly (not just via signal)

### Fix #2: Trigger Preload Earlier
- Trigger preload when FIRST cache miss is detected (not after BUILD MODE)
- Check for preload trigger BEFORE queuing individual API calls
- Wait for preload if it's in progress

### Fix #3: Ensure Taskpane Processes Triggers
- Check if taskpane is open before creating trigger
- Or use a polling mechanism in functions.js to process triggers
- Or trigger preload directly from functions.js (if possible)

### Fix #4: Make Formulas Wait for Preload
- When preload is triggered, formulas should wait (not proceed immediately)
- Check preload status BEFORE queuing individual API calls
- Wait for preload completion before making API calls

### Fix #5: Improve Cache Clear
- Clear in-memory cache synchronously
- Clear localStorage from both contexts
- Verify cache is actually cleared before proceeding

---

## Files to Review

1. `docs/taskpane.html:18717-18753` - `clearPreloadCache()` function
2. `docs/functions.js:4074-4092` - Cache clear signal handler
3. `docs/functions.js:398-458` - `triggerAutoPreload()` function
4. `docs/functions.js:4506-4528` - BALANCE function cache miss handling
5. `docs/taskpane.html:8490-8987` - Auto-preload trigger processor

---

## Next Steps

1. Review cache clear mechanism - ensure it clears from both contexts
2. Review auto-preload trigger timing - trigger earlier in the flow
3. Review taskpane trigger processing - ensure triggers are processed
4. Review formula wait logic - make formulas wait for preload when appropriate
5. Test with taskpane open vs closed - verify trigger processing

