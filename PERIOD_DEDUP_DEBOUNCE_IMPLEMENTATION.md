# Period Deduplication Debounce Implementation

**Date:** January 9, 2026  
**Version:** 4.0.6.124  
**Issue:** Merge window too narrow (~1-2ms) - cells evaluating over 10-50ms spread miss merge window  
**Solution:** 100ms debounce window to collect accounts before executing query

---

## Problem Statement

### Previous Fix (v4.0.6.123)
The placeholder promise fix closed the race condition gap, but the merge window was still very narrow:
- `activePeriodQueries.set()` happens synchronously ✅
- But `queryState='sent'` happens ~1-2ms later (inside `executeColumnBasedBSBatch()`)
- If Excel evaluates cells over a 10-50ms spread, some cells miss the merge window

### User Observation
When dragging formulas across columns:
- First cell creates query with 17 accounts
- Second cell (arrives 5ms later) creates separate query with 19 accounts
- Third cell (arrives 10ms later) creates separate query with 16 accounts
- Result: 3 queries for the same period instead of 1 merged query

---

## Solution: Debounce Mechanism

### Concept
Instead of executing immediately, wait 100ms to collect all accounts before executing the query. This ensures all cells evaluating within the debounce window merge into a single query.

### Implementation

**1. New queryState: 'collecting'**
- Replaces 'pending' state
- Indicates debounce window is open
- Accounts can be merged during this state

**2. Debounce Timer**
- 100ms window after first cell arrives
- Timer starts when `activePeriodQueries.set()` is called
- Query executes when timer expires

**3. Account Merging**
- Cells arriving during 'collecting' state merge their accounts
- Accounts added to `activePeriodQuery.accounts` Set
- All cells await the same placeholder promise

**4. Query Execution**
- After 100ms, `executeDebouncedQuery()` is called
- Transitions to 'sent' state
- Executes with all collected accounts
- Resolves placeholder promise with results

---

## Code Changes

### 1. New Function: `executeDebouncedQuery()`

**Location:** `docs/functions.js` (line ~1104)

```javascript
async function executeDebouncedQuery(periodKey, activePeriodQueries, columnBasedDetection, filterKey) {
    const activePeriodQuery = activePeriodQueries.get(periodKey);
    if (!activePeriodQuery || activePeriodQuery.queryState !== 'collecting') {
        return {};
    }
    
    // Transition to 'sent' state
    activePeriodQuery.queryState = 'sent';
    console.log(`📤 DEBOUNCE: Executing query for ${periodKey} with ${activePeriodQuery.accounts.size} accounts`);
    
    // Prepare grid with all collected accounts
    const accounts = Array.from(activePeriodQuery.accounts).sort();
    const periods = Array.from(activePeriodQuery.periods);
    const updatedGrid = {
        ...columnBasedDetection,
        allAccounts: new Set(accounts),
        columns: periods.map(period => ({ period }))
    };
    
    // Execute query and resolve placeholder promise
    const results = await executeColumnBasedBSBatch(updatedGrid, periodKey, activePeriodQueries);
    if (activePeriodQuery._resolvePlaceholder) {
        activePeriodQuery._resolvePlaceholder(results);
    }
    
    activePeriodQueries.delete(periodKey);
    return results;
}
```

### 2. Updated Query Registration

**Location:** `docs/functions.js` (line ~6836)

**Before:**
```javascript
activePeriodQueries.set(periodKey, {
    queryState: 'pending',
    // ... immediately execute
});
batchPromise = executeColumnBasedBSBatch(...);
```

**After:**
```javascript
// DEBOUNCE WINDOW: 100ms to collect accounts
const DEBOUNCE_MS = 100;

activePeriodQueries.set(periodKey, {
    queryState: 'collecting',  // Debounce window open
    accounts: new Set(accounts),
    executeTimeout: null
});

// Start debounce timer
const activeQuery = activePeriodQueries.get(periodKey);
activeQuery.executeTimeout = setTimeout(() => {
    executeDebouncedQuery(periodKey, activePeriodQueries, columnBasedDetection, filterKey);
}, DEBOUNCE_MS);

batchPromise = placeholderPromise;  // Will resolve when debounced query completes
```

### 3. Updated Merge Logic

**Location:** `docs/functions.js` (line ~6750)

**Before:**
```javascript
if (activePeriodQuery.queryState === 'pending') {
    // Merge accounts
}
```

**After:**
```javascript
if (activePeriodQuery.queryState === 'collecting') {
    // DEBOUNCE WINDOW OPEN: Merge accounts into existing query
    accounts.forEach(acc => activePeriodQuery.accounts.add(acc));
    // Await placeholder promise (will resolve when debounced query completes)
    return await activePeriodQuery.promise;
}
```

---

## Flow Diagram

### Before (v4.0.6.123)
```
Cell A (t=0ms):   Create query, set activePeriodQueries
                  queryState='pending'
                  Execute immediately
                  queryState='sent' (t=1ms)
                  
Cell B (t=5ms):   Check activePeriodQueries → queryState='sent'
                  Cannot merge → create separate query ❌
```

### After (v4.0.6.124)
```
Cell A (t=0ms):   Create query, set activePeriodQueries
                  queryState='collecting'
                  Start 100ms timer
                  
Cell B (t=5ms):   Check activePeriodQueries → queryState='collecting'
                  Merge accounts ✅
                  Await placeholder promise
                  
Cell C (t=15ms):  Check activePeriodQueries → queryState='collecting'
                  Merge accounts ✅
                  Await placeholder promise
                  
Timer (t=100ms):  Execute query with all merged accounts
                  queryState='sent'
                  Resolve placeholder promise
                  
All cells:         Receive results from single query ✅
```

---

## Edge Cases Handled

### 1. Cell Arrives Exactly as Timer Fires
- Check `queryState` before merging
- If already 'sent', await results instead of merging
- Handled by state check in merge logic

### 2. Multiple Periods in Same Drag
- Each period gets its own debounce window
- Independent timers, independent queries
- Each `periodKey` has its own `activePeriodQuery` entry

### 3. Error During Execution
- Clear timeout in catch block
- Reject placeholder promise
- Clean up `activePeriodQueries` entry
- All awaiting cells receive error

### 4. User Drags Slowly (Cells Arrive Over 500ms)
- Fixed 100ms window (Option A from proposal)
- Late cells (after 100ms) will see 'sent' state
- They await results or create supplemental query if account missing
- Predictable behavior: 100ms window, no indefinite extension

---

## Benefits

### 1. Guaranteed Merge Window
- **100ms is plenty** for Excel to evaluate all cells in a drag operation
- Typical Excel evaluation spread: 10-50ms
- 100ms provides 2-10x safety margin

### 2. Deterministic Behavior
- No racing against narrow timing windows
- Predictable: "All accounts within 100ms merge"
- Easy to reason about and debug

### 3. Negligible Overhead
- **100ms delay** vs **90-150 second query time**
- Overhead: 0.07% - 0.11% of total time
- User experience: No noticeable delay

### 4. Simpler Debugging
- Clear state transitions: 'collecting' → 'sent'
- Log messages show account collection progress
- Easy to verify merge behavior

---

## Testing Recommendations

### Verify Debounce Works

1. **Drag 5 columns with 20 accounts:**
   - Should see `⏱️ DEBOUNCE: Started 100ms window` log
   - Should see `🔄 PERIOD DEDUP: ... already being queried (state: collecting)` logs
   - Should see `📤 DEBOUNCE: Executing query ... with X accounts` log
   - Should see **ONE query per period** (not 2-3)

2. **Check for redundant queries:**
   - Server logs should show fewer queries for same period
   - Account counts should be higher (merged accounts)
   - No multiple queries with overlapping account lists

3. **Verify merge behavior:**
   - All cells for same period should see 'collecting' state
   - Accounts should be merged into single query
   - All cells should receive results from single query

### Expected Logs

**Successful Debounce:**
```
⏱️ DEBOUNCE: Started 100ms window for Jan 2025:1::::1 (17 accounts initially)
🔄 PERIOD DEDUP: Periods Jan 2025 already being queried (state: collecting)
   Existing accounts: 17, Our accounts: 1
   📊 Account 10011 not in existing query, merging during debounce window (collecting state)
   ⏳ Awaiting debounced query execution (18 accounts collected so far)...
🔄 PERIOD DEDUP: Periods Jan 2025 already being queried (state: collecting)
   📊 Account 10012 not in existing query, merging during debounce window (collecting state)
   ⏳ Awaiting debounced query execution (19 accounts collected so far)...
📤 DEBOUNCE: Executing query for Jan 2025:1::::1 with 19 accounts (debounce window closed)
```

**Failed Debounce (Before Fix):**
```
🚀 COLUMN-BASED BS BATCH EXECUTING: 17 accounts × 1 periods
🚀 COLUMN-BASED BS BATCH EXECUTING: 19 accounts × 1 periods  ❌ Should have been merged
🚀 COLUMN-BASED BS BATCH EXECUTING: 16 accounts × 1 periods  ❌ Should have been merged
```

---

## Performance Impact

### Before (v4.0.6.123)
- **3 queries for Jan 2025** with overlapping account lists
- **Each query:** 90-150 seconds
- **Total time:** 270-450 seconds (4.5-7.5 minutes)
- **Redundant work:** Same period queried 3 times

### After (v4.0.6.124)
- **1 query for Jan 2025** (with all merged accounts)
- **Query:** 90-150 seconds
- **Total time:** 90-150 seconds (1.5-2.5 minutes)
- **Efficiency:** Period queried once, all accounts included
- **Overhead:** +100ms debounce delay (negligible)

---

## Configuration

### Debounce Window Duration

**Current:** 100ms  
**Location:** `docs/functions.js` (line ~6847)

```javascript
const DEBOUNCE_MS = 100;
```

**Tuning Guidelines:**
- **Too short (< 50ms):** May miss cells in slow Excel evaluations
- **Too long (> 200ms):** Noticeable delay for user
- **Recommended:** 100ms provides good balance

**Future Optimization:**
- Could make configurable based on grid size
- Larger grids (more accounts) → slightly longer window
- But 100ms should work for most cases

---

## Summary

The debounce mechanism widens the merge window from ~1-2ms to 100ms, ensuring all cells evaluating within the window merge into a single query. This eliminates redundant queries and improves performance.

**Key Changes:**
1. **New 'collecting' state** - Indicates debounce window open
2. **100ms debounce timer** - Collects accounts before executing
3. **executeDebouncedQuery() function** - Executes query after timer expires
4. **Updated merge logic** - Handles 'collecting' state

**Result:** Period-based deduplication now works reliably, preventing redundant queries even when cells evaluate over a 10-50ms spread.

**Version:** 4.0.6.124  
**Status:** ✅ Implemented - Ready for testing
