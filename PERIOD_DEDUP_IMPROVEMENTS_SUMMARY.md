# Period-Based Deduplication Improvements Summary

**Version:** 4.0.6.120  
**Date:** January 9, 2026  
**Purpose:** Address race conditions, promise handling, performance, and edge cases in period-based deduplication

---

## Issues Addressed

### 1. ✅ Race Condition - "Account Not in Query" Path
**Problem:** When a cell found an active period query but its account wasn't included, it merged accounts and created a new batch. However, if the query was already in flight, this merge didn't help the current cell.

**Solution:** Added `queryState` tracking (`'pending'` vs `'sent'`) to `activePeriodQueries`:
- **`'pending'`**: Query hasn't been sent yet - accounts can be merged, promise can be replaced
- **`'sent'`**: Query already in flight - await existing promise first, then check if account is in results

**Code Changes:**
- Line ~5280: Added `queryState` field to `activePeriodQueries` Map structure
- Lines ~6664-6695: Enhanced logic to check `queryState`:
  - If `'pending'`: Merge accounts and update query before it's sent
  - If `'sent'`: Await existing promise, check results, only create supplemental query if account missing

**Impact:** Prevents redundant queries when accounts arrive after query is already sent.

---

### 2. ✅ Promise Reference Replacement
**Problem:** At line ~6798, `activePeriodQuery.promise = batchPromise` replaced the promise. Cells already awaiting the old promise wouldn't see the new one.

**Solution:** Chain promises instead of replacing:
- If query state is `'pending'`: Safe to replace (no awaiters yet)
- If query state is `'sent'`: Chain new promise after old one, merge results

**Code Changes:**
- Lines ~6867-6884: Promise chaining logic:
  ```javascript
  if (activePeriodQuery.queryState === 'pending') {
      // Safe to replace - no awaiters yet
      activePeriodQuery.promise = batchPromise;
  } else {
      // Chain promises and merge results
      const oldPromise = activePeriodQuery.promise;
      activePeriodQuery.promise = oldPromise
          .then(oldResults => {
              return batchPromise.then(newResults => {
                  // Merge results: new overrides old
                  const mergedResults = { ...oldResults };
                  for (const acc in newResults) {
                      mergedResults[acc] = { ...mergedResults[acc], ...newResults[acc] };
                  }
                  return mergedResults;
              });
          });
  }
  ```

**Impact:** All cells awaiting a promise will see results, even if query is updated with merged accounts.

---

### 3. ✅ Period Sorting - Lexicographic vs Chronological
**Problem:** At line ~6647, `periods.sort()` used lexicographic sorting ("Jan 2025" < "Jun 2025" < "Mar 2025"), which could cause `periodKey` mismatches.

**Solution:** Use chronological sorting using `parsePeriodToDate()` (same as `executeColumnBasedBSBatch`).

**Code Changes:**
- Lines ~6647-6652: Changed from `periods.sort()` to:
  ```javascript
  const periods = columnBasedDetection.columns.map(col => col.period).sort((a, b) => {
      const aDate = parsePeriodToDate(a);
      const bDate = parsePeriodToDate(b);
      if (!aDate || !bDate) return 0;
      return aDate.getTime() - bDate.getTime();
  });
  ```

**Impact:** Ensures consistent `periodKey` generation regardless of period order in grid.

---

### 4. ✅ localStorage Write Performance
**Problem:** At lines ~1237-1240, `JSON.parse/stringify` of `xavi_balance_cache` happened inside the per-account/period loop. For 100 accounts × 2 periods = 200 parse/stringify cycles.

**Solution:** Batch localStorage writes - parse once before loop, update object, stringify once after loop.

**Code Changes:**
- Lines ~1179-1246: Refactored localStorage writes:
  ```javascript
  // Before loop: Lazy-load localStorage data once per chunk
  let balanceData = null;
  let preloadData = null;
  
  // Inside loop: Update objects (no JSON operations)
  if (balanceData === null) {
      balanceData = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  }
  balanceData[account][period] = accountBalances[period];
  
  // After loop: Write once per chunk
  localStorage.setItem(STORAGE_KEY, JSON.stringify(balanceData));
  localStorage.setItem('xavi_balance_cache', JSON.stringify(preloadData));
  ```

**Impact:** Reduces JSON operations from O(accounts × periods) to O(1) per chunk. For 100 accounts × 2 periods, this is 200 operations → 2 operations (100x improvement).

---

### 5. ✅ Cache Staleness (TTL Check)
**Problem:** `checkLocalStorageCache` checked TTL for legacy cache but not for preload cache (`xavi_balance_cache`).

**Solution:** Added TTL check for preload cache entries.

**Code Changes:**
- Lines ~4938-4948: Added TTL check:
  ```javascript
  if (preloadData[preloadKey] && preloadData[preloadKey].value !== undefined) {
      const cachedEntry = preloadData[preloadKey];
      const cachedValue = cachedEntry.value;
      
      // Check cache staleness (TTL check)
      if (cachedEntry.timestamp) {
          const cacheAge = Date.now() - cachedEntry.timestamp;
          if (cacheAge > STORAGE_TTL) {
              // Cache expired - skip this entry
              continue;
          }
      }
      
      return cachedValue;
  }
  ```

**Impact:** Preload cache now respects 5-minute TTL, preventing stale data from being returned.

---

## Testing Checklist

After these changes, verify with drag operations:

- [ ] **Drag 5 columns right with 20+ accounts**
  - Should see 1 query per period (not 8+)
  - Watch for `🔄 PERIOD DEDUP` messages with `queryState: 'pending'` or `'sent'`
  - Verify chronological period sorting in logs

- [ ] **Watch for "Account not in existing query" logs**
  - Should be rare (only when query already sent)
  - Should be followed by successful resolution (either from existing query or supplemental)

- [ ] **Check localStorage performance**
  - Monitor console for localStorage write warnings
  - Should see fewer write operations (batched per chunk)

- [ ] **Verify cache staleness**
  - Wait 5+ minutes after cache is populated
  - Enter formula - should see cache miss (not stale hit)

- [ ] **Promise chaining**
  - Drag across columns rapidly
  - All cells should resolve (no cells stuck waiting)

---

## Log Messages to Watch For

### Query State Tracking
```
🔄 PERIOD DEDUP: Periods Jan 2025 already being queried (state: pending)
   Existing accounts: 19, Our accounts: 1
   📊 Account 10010 not in existing query, merging before query is sent
```

```
🔄 PERIOD DEDUP: Periods Jan 2025 already being queried (state: sent)
   Existing accounts: 19, Our accounts: 1
   ⏳ Account 10010 not in query (already sent) - awaiting results, then checking...
```

### Promise Chaining
```
✅ PERIOD DEDUP RESULT (post-query): 10010 for Jan 2025 = 2064705.84
```

### localStorage Batching
```
⚠️ Failed to write localStorage batch for chunk 1: [error]
```
(Should be rare - indicates localStorage is full or unavailable)

---

## Performance Impact

### Before Improvements
- **localStorage writes:** 200 operations for 100 accounts × 2 periods
- **Period key mismatches:** Possible with lexicographic sorting
- **Supplemental queries:** Common when accounts arrive after query sent
- **Promise issues:** Cells awaiting old promise might not see new results

### After Improvements
- **localStorage writes:** 2 operations per chunk (100x improvement)
- **Period key consistency:** Guaranteed with chronological sorting
- **Supplemental queries:** Rare (only if account truly missing from results)
- **Promise chaining:** All awaiters see merged results

---

## Files Modified

1. **`docs/functions.js`**
   - Added `queryState` to `activePeriodQueries` (line ~5280)
   - Enhanced period deduplication logic with state tracking (lines ~6664-6695)
   - Fixed promise chaining (lines ~6867-6884)
   - Fixed period sorting (lines ~6647-6652)
   - Optimized localStorage writes (lines ~1179-1246)
   - Added TTL check for preload cache (lines ~4938-4948)
   - Updated version to `4.0.6.120`

2. **`excel-addin/manifest.xml`**
   - Updated version to `4.0.6.120`
   - Updated all cache-busting URLs

---

## Summary

These improvements address critical edge cases and performance issues in the period-based deduplication implementation:

1. **Race conditions** are handled with query state tracking
2. **Promise chaining** ensures all awaiters see results
3. **Chronological sorting** prevents period key mismatches
4. **Batched localStorage** reduces write operations by 100x
5. **TTL checking** prevents stale cache hits

**Expected Result:** More reliable batch processing with fewer redundant queries and better performance.
