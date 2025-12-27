# Analysis: Auto-Preload Issues for New Periods

## Problem Statement

When user adds a formula for a new period (e.g., Apr 2025), the first formula resolves, but when dragging down, subsequent formulas make individual API calls instead of using the preload cache.

## Root Causes Identified

### 1. **Race Condition - Preload Takes Time**
- Auto-preload is triggered when first formula for Apr 2025 is entered
- Preload takes 60-80 seconds to complete
- First formula resolves via individual API call (doesn't wait for preload)
- User drags down BEFORE preload completes
- Formulas check cache, find nothing, make individual API calls

### 2. **Timing Issue - No Wait Mechanism**
- `triggerAutoPreload()` sets `autoPreloadInProgress = true`
- But formulas don't wait for preload to complete
- Formulas check cache immediately, find nothing, proceed with API calls
- Even if preload completes later, formulas already started won't re-check cache

### 3. **Cache Check Timing**
- Cache check happens in `checkLocalStorageCache()` BEFORE queuing
- If preload is in progress, cache won't have data yet
- Formulas proceed to queue and make API calls
- No mechanism to wait for preload or re-check cache after preload completes

### 4. **Period Normalization Consistency**
- Frontend normalizes periods via `convertToMonthYear()` → "Apr 2025" (title case)
- Backend uses period name as-is from request
- Cache keys use: `balance:${account}::${periodName}`
- Need to ensure period names match exactly between:
  - Request to backend
  - Response from backend
  - Cache key lookup

## Current Flow (Problematic)

1. User enters formula: `=XAVI.BALANCE("10010",, "Apr 2025")`
2. Formula normalizes period: "Apr 2025"
3. Cache check: `checkLocalStorageCache()` → MISS (Apr 2025 not cached)
4. Triggers auto-preload: `triggerAutoPreload("10010", "Apr 2025")`
5. Sets `autoPreloadInProgress = true`
6. Formula continues: Queues request, makes API call
7. First formula resolves (60-80 seconds)
8. **User drags down** (preload might still be in progress)
9. New formulas check cache: MISS (preload not complete yet)
10. New formulas make individual API calls

## Optimizations Needed

### Optimization 1: Wait for Preload When In Progress
**Problem**: Formulas don't wait for preload to complete
**Solution**: Check if preload is in progress, and if so, wait for it before making API calls

```javascript
// In BALANCE function, before queuing:
if (autoPreloadInProgress && !subsidiary && lookupPeriod) {
    const isPeriodCached = checkIfPeriodIsCached(lookupPeriod);
    if (!isPeriodCached) {
        console.log(`⏳ Preload in progress for ${lookupPeriod} - waiting...`);
        await waitForPreloadToComplete(lookupPeriod, 90000); // Wait up to 90s
        // Re-check cache after preload completes
        const localStorageValue = checkLocalStorageCache(account, fromPeriod, toPeriod, subsidiary);
        if (localStorageValue !== null) {
            return localStorageValue;
        }
    }
}
```

### Optimization 2: Batch Queue When Preload In Progress
**Problem**: Individual API calls are made while preload is running
**Solution**: Queue formulas and batch them, but wait for preload to complete first

### Optimization 3: Period Normalization Verification
**Problem**: Period format might not match between request/response/cache
**Solution**: Ensure consistent normalization:
- Normalize period before sending to backend
- Normalize period when storing in cache
- Normalize period when looking up in cache

### Optimization 4: Preload Completion Notification
**Problem**: Formulas don't know when preload completes
**Solution**: Use localStorage event or polling to detect when preload cache is updated

## Recommended Solution

### Approach: Wait for Preload + Re-check Cache

1. **When cache miss detected and preload in progress:**
   - Wait for preload to complete (with timeout)
   - Re-check cache after preload completes
   - If cache hit, return immediately
   - If still miss, proceed with API call

2. **Implementation:**
   - Add `waitForPreloadToComplete(period, timeout)` function
   - Poll `xavi_balance_cache` for the period
   - Return when period appears in cache or timeout
   - Re-check cache after wait completes

3. **Benefits:**
   - Formulas wait for preload when appropriate
   - Reduces redundant API calls
   - Better user experience (faster after preload)

## Alternative: Optimistic Preload

Instead of waiting, we could:
1. Trigger preload immediately when new period detected
2. Show user a message: "Preloading Apr 2025... formulas will be instant in ~60s"
3. Formulas proceed with individual calls for first batch
4. Subsequent formulas (after preload completes) use cache

But this doesn't solve the drag-down issue - user still gets slow first batch.

## Best Solution: Wait + Batch

1. Detect new period → trigger preload
2. First formula waits for preload (up to 90s)
3. While waiting, queue other formulas
4. When preload completes, batch process all queued formulas from cache
5. All formulas resolve instantly

This requires:
- Wait mechanism for preload
- Queue management during preload
- Batch processing from cache after preload

