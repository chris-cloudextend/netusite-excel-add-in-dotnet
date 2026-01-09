# Period-Based Deduplication Implementation Summary

**Version:** 4.0.6.130  
**Date:** January 9, 2026  
**Last Updated:** January 9, 2026  
**Purpose:** Optimize balance sheet batch processing to prevent redundant queries when dragging formulas across columns

**IMPORTANT:** This implementation processes periods one at a time (CHUNK_SIZE = 1) to avoid Cloudflare timeout (524 error). Cloudflare has a ~100 second timeout, but NetSuite queries take 90-150 seconds per period. Once migrated to AWS, this limitation will not apply and we can increase CHUNK_SIZE.

---

## Problem Statement

**Important Context:** The system DOES cache entire periods via auto-preload (`/batch/bs_preload`), which queries ALL balance sheet accounts for a period when the first BS formula is entered. However, when dragging across columns, the column-based batching uses **targeted queries** (`/batch/bs_preload_targeted`) with specific account lists.

**The Problem:** When dragging `XAVI.BALANCE` formulas across multiple columns (periods), the column-based batching was creating multiple redundant **targeted queries** for the same period with different account lists:

- **Example:** Dragging 2 columns resulted in 8+ **targeted queries** for "Jan 2025" with account counts: 13, 20, 10, 11, 21, 12, 16, 19
- **Each targeted query took 93-288 seconds**
- **Total time:** 10x longer than manually entering formulas one column at a time
- **Root cause:** `gridKey` included account list, so as grid grew (19 → 20 → 21 accounts), each new account created a different `gridKey`, triggering new targeted batches
- **Why targeted queries instead of cache?** The localStorage check happens BEFORE batch creation, but if cache is missed (auto-preload didn't complete yet, or account wasn't in preload), it falls back to targeted queries. The problem was these targeted queries were being duplicated instead of merged.

---

## Solution: Period-Based Deduplication

### Core Concept

Instead of tracking batches by `gridKey` (which includes accounts), we now track active queries by **period + filters**. This allows us to:
1. Detect when multiple batches want the same periods
2. Merge account lists before queries are sent
3. Reuse existing queries when accounts overlap

### Key Data Structure

```javascript
// Map<periodKey, { promise, accounts: Set, periods: Set, filters, gridKey }>
// periodKey = `${periods.join(',')}:${filterKey}` (e.g., "Jan 2025,Feb 2025:1::::1")
const activePeriodQueries = new Map();
```

---

## Code Changes

### 1. Added Period-Based Tracking (Line ~5277)

**File:** `docs/functions.js`

```javascript
// PERIOD-BASED DEDUPLICATION: Track active queries per period to merge account lists
// Map<periodKey, { promise, accounts: Set, periods: Set, filters, gridKey }>
// periodKey = `${periods.join(',')}:${filterKey}` (e.g., "Jan 2025,Feb 2025:1::::1")
const activePeriodQueries = new Map();
```

### 2. Period-Based Deduplication Logic (Lines ~6644-6695)

**File:** `docs/functions.js`

```javascript
if (executionCheck.allowed) {
    // PERIOD-BASED DEDUPLICATION: Check for existing queries for same periods FIRST
    // This prevents multiple queries for the same period with different account lists
    const periods = columnBasedDetection.columns.map(col => col.period).sort();
    const filterKey = getFilterKey({
        subsidiary: columnBasedDetection.filters.subsidiary || '',
        department: columnBasedDetection.filters.department || '',
        location: columnBasedDetection.filters.location || '',
        classId: columnBasedDetection.filters.classId || '',
        accountingBook: columnBasedDetection.filters.accountingBook || ''
    });
    
    // Create period key for deduplication (periods + filters, NOT accounts)
    const periodKey = `${periods.join(',')}:${filterKey}`;
    
    // Check if a query for these periods is already active
    let accounts = Array.from(columnBasedDetection.allAccounts);
    let activePeriodQuery = activePeriodQueries.get(periodKey);
    
    if (activePeriodQuery) {
        // Period query already active - check if our account is already in the query
        console.log(`🔄 PERIOD DEDUP: Periods ${periods.join(', ')} already being queried`);
        console.log(`   Existing accounts: ${activePeriodQuery.accounts.size}, Our accounts: ${accounts.length}`);
        
        // Check if our account is already in the active query
        const ourAccountInQuery = accounts.some(acc => activePeriodQuery.accounts.has(acc));
        
        if (ourAccountInQuery) {
            // Our account is already being queried - wait for results
            console.log(`   ✅ Account ${account} already in query, awaiting results...`);
            try {
                const batchResults = await activePeriodQuery.promise;
                const balance = batchResults[account]?.[toPeriod];
                
                if (balance !== undefined && balance !== null && typeof balance === 'number') {
                    cache.balance.set(cacheKey, balance);
                    console.log(`✅ PERIOD DEDUP RESULT: ${account} for ${toPeriod} = ${balance}`);
                    pendingEvaluation.balance.delete(evalKey);
                    return balance;
                }
            } catch (error) {
                console.warn(`⚠️ PERIOD DEDUP: Error in existing query: ${error.message}`);
            }
        } else {
            // Our account is NOT in the active query - merge accounts for future queries
            console.log(`   📊 Account ${account} not in existing query, merging for future batches`);
            accounts.forEach(acc => activePeriodQuery.accounts.add(acc));
            accounts = Array.from(activePeriodQuery.accounts).sort();
            // Continue to create new batch with merged accounts
        }
    }
    
    // No active query for these periods, or we need to create one with merged accounts
    // Create grid key with merged accounts
    const gridKey = `grid:${accounts.join(',')}:${periods.join(',')}:${filterKey}`;
    
    // Check if this exact grid is already being executed
    let batchPromise = activeColumnBatchExecutions.get(gridKey);
    
    // ... (continue with batch creation)
}
```

### 3. Track in activePeriodQueries Before Execution (Lines ~6784-6798)

**File:** `docs/functions.js`

```javascript
// Store in activePeriodQueries BEFORE setting in activeColumnBatchExecutions
// This ensures other cells checking for period overlap will find it
// CRITICAL: Set synchronously to prevent race conditions
if (!activePeriodQuery) {
    activePeriodQueries.set(periodKey, {
        promise: batchPromise,
        accounts: new Set(accounts),
        periods: new Set(periods),
        filters: columnBasedDetection.filters,
        gridKey: gridKey
    });
} else {
    // Update existing period query with merged accounts and new promise
    activePeriodQuery.promise = batchPromise;
    activePeriodQuery.accounts = new Set(accounts);
    activePeriodQuery.gridKey = gridKey;
}
```

### 4. Cleanup on Completion/Error (Lines ~6722-6731, 6778-6782)

**File:** `docs/functions.js`

```javascript
batchPromise = executeColumnBasedBSBatch(updatedGrid)
    .then(results => {
        // Remove from active period queries when complete
        activePeriodQueries.delete(periodKey);
        
        // ... (resolve pending evaluations, cache results, etc.)
        
        return results;
    })
    .catch(error => {
        // Clean up on error
        activeColumnBatchExecutions.delete(gridKey);
        activePeriodQueries.delete(periodKey);
        throw error;
    });
```

### 5. localStorage Check Before Batch Creation (Lines ~6540-6557)

**File:** `docs/functions.js`

```javascript
// ================================================================
// CRITICAL: Check localStorage BEFORE column-based batching
// When dragging down, previous batches may have already cached results
// This prevents redundant batch creation when cache is available
// ================================================================
// Normalize periods and filters early (used in multiple places below)
const filtersHash = getFilterKey({ subsidiary, department, location, classId, accountingBook });
const lookupPeriod = normalizePeriodKey(fromPeriod || toPeriod, false);
const isCumulativeQuery = isCumulativeRequest(fromPeriod);

// Check localStorage cache BEFORE column-based batching
// This ensures dragged cells use cached results instead of creating new batches
if (isCumulativeQuery && lookupPeriod) {
    const localStorageValue = checkLocalStorageCache(account, fromPeriod, toPeriod, subsidiary, filtersHash);
    if (localStorageValue !== null) {
        console.log(`✅ localStorage cache hit BEFORE batch check: ${account}/${lookupPeriod} = ${localStorageValue}`);
        cacheStats.hits++;
        cache.balance.set(cacheKey, localStorageValue);
        pendingEvaluation.balance.delete(evalKey); // Remove from pending since we resolved it
        return localStorageValue;
    }
}
```

### 6. Write to Preload Cache Format (Lines ~1227-1240)

**File:** `docs/functions.js`

```javascript
// ALSO write to preload cache format (xavi_balance_cache) for immediate lookup
// Format: balance:${account}:${filtersHash}:${period}
const filtersHash = getFilterKey({
    subsidiary: filters.subsidiary || '',
    department: filters.department || '',
    location: filters.location || '',
    classId: filters.classId || '',
    accountingBook: filters.accountingBook || ''
});
const preloadKey = `balance:${account}:${filtersHash}:${period}`;
const preloadCache = localStorage.getItem('xavi_balance_cache');
const preloadData = preloadCache ? JSON.parse(preloadCache) : {};
preloadData[preloadKey] = { value: accountBalances[period], timestamp: Date.now() };
localStorage.setItem('xavi_balance_cache', JSON.stringify(preloadData));
```

---

## User Flow and Expected Behavior

### Scenario 1: User Enters First Formula (Column 1, Row 1)

**Action:** User enters `=XAVI.BALANCE("10010", ,"Jan 2025",$I$1,,,,$J$1)`

**What Happens:**
1. Formula evaluates → checks localStorage (miss)
2. **Auto-preload triggered:** First BS formula triggers auto-preload (`/batch/bs_preload`) which queries **ALL balance sheet accounts** for Jan 2025
3. Formula waits for auto-preload to complete (up to 120s)
4. **Auto-preload caches entire period:**
   - All BS accounts for Jan 2025 are cached in localStorage (`xavi_balance_cache`)
   - Format: `balance:${account}:${filtersHash}:Jan 2025` for each account
5. Formula retrieves result from cache
6. **Alternative path (if auto-preload fails/times out):** Falls back to column-based batching with targeted query (`/batch/bs_preload_targeted`) for account 10010 only

**Result:** Formula resolves, balance displayed. **All accounts for Jan 2025 are now cached** (via auto-preload)

**Key Point:** Auto-preload (`/batch/bs_preload`) caches the **entire period** (all BS accounts), not just the specific account. This is why dragging down (same column) should hit cache immediately.

---

### Scenario 2: User Drags Down (Same Column, Different Rows)

**Action:** User drags formula down to rows 2-25 (same period "Jan 2025", different accounts)

**What Happens:**
1. Each new cell evaluates → checks localStorage **FIRST** (before batch creation)
2. **Cache hit:** `checkLocalStorageCache()` finds `balance:${account}:1::::1:Jan 2025` in `xavi_balance_cache`
3. Returns immediately from cache
4. **No API calls made**
5. **No batch creation**

**Result:** All cells resolve **immediately** (sub-second)

**Key Code Path:**
```javascript
// Line ~6551: Check localStorage BEFORE column-based batching
if (isCumulativeQuery && lookupPeriod) {
    const localStorageValue = checkLocalStorageCache(account, fromPeriod, toPeriod, subsidiary, filtersHash);
    if (localStorageValue !== null) {
        // Return immediately - no batch creation
        return localStorageValue;
    }
}
```

---

### Scenario 3: User Drags Right (Same Row, Different Columns/Periods)

**Action:** User drags formula right across columns (same account, different periods: Jan, Feb, Mar, Apr, May)

**What Happens:**

#### Column 1 (Jan 2025) - First Period
1. Formula evaluates → checks localStorage (miss for this account/period)
2. Creates batch: `grid:10010:Jan 2025:1::::1`
3. Tracks in `activePeriodQueries`: `"Jan 2025:1::::1"` → `{ promise, accounts: Set([10010]), ... }`
4. Queries NetSuite → caches all accounts for Jan 2025
5. Formula resolves

#### Column 2 (Feb 2025) - Second Period
1. Formula evaluates → checks localStorage (miss for Feb 2025)
2. **Auto-preload triggered:** First BS formula for Feb 2025 triggers auto-preload (`/batch/bs_preload`) which queries **ALL balance sheet accounts** for Feb 2025
3. Formula waits for auto-preload to complete
4. **Auto-preload caches entire period:** All BS accounts for Feb 2025 are cached
5. Formula retrieves result from cache
6. **Alternative path (if auto-preload fails/times out):** Falls back to column-based batching with targeted query (`/batch/bs_preload_targeted`). Period-based deduplication ensures only 1-2 targeted queries are made (with merged account lists), not 8+ redundant queries.

**Key Point:** Each new period triggers its own auto-preload. If auto-preload completes, no targeted queries are needed. If it fails/times out, period-based deduplication ensures targeted queries are merged efficiently.

#### Column 3 (Mar 2025) - Third Period
1. Formula evaluates → checks localStorage (miss for Mar 2025)
2. Creates batch: `grid:10010:Mar 2025:1::::1`
3. Tracks in `activePeriodQueries`: `"Mar 2025:1::::1"` → `{ promise, accounts: Set([10010]), ... }`
4. Queries NetSuite → caches all accounts for Mar 2025
5. Formula resolves

**Key Point:** Each period gets **one query** that caches **all accounts** for that period.

---

### Scenario 4: User Drags Across Both Dimensions (Multiple Rows × Multiple Columns)

**Action:** User drags formula across 25 rows × 5 columns (25 accounts × 5 periods = 125 formulas)

**What Happens:**

#### Initial State (Column 1, Row 1)
1. First formula evaluates → creates batch for Jan 2025 with account 10010
2. Batch queries **all balance sheet accounts** for Jan 2025 (via preload endpoint)
3. All accounts for Jan 2025 are cached

#### Dragging Down (Column 1, Rows 2-25)
1. Each new cell checks localStorage **FIRST**
2. **Cache hit:** All accounts for Jan 2025 are already cached
3. Cells resolve **immediately** (no API calls)

#### Dragging Right (Columns 2-5)
**For each new column (period):**

**Column 2 (Feb 2025):**
- Row 1 evaluates → checks localStorage (miss for Feb 2025)
- Creates batch: `grid:10010:Feb 2025:1::::1`
- Tracks in `activePeriodQueries`: `"Feb 2025:1::::1"`
- Queries NetSuite → caches **all accounts** for Feb 2025
- **Period-based deduplication:** Rows 2-25 check `activePeriodQueries` → find active query for Feb 2025
- **If account already in query:** Wait for results (no new query)
- **If account not in query:** Merge accounts, but query already sent → will need supplemental query (limitation)

**Column 3 (Mar 2025):**
- Same pattern as Column 2

**Expected Behavior:**
- **No single-cell resolutions:** All cells in a column should batch together
- **Speed:** Should be same as manually entering each column (one query per period)
- **Performance:** ~100 seconds per period (instead of 800+ seconds with redundant queries)

---

## Performance Expectations

### Before Optimization
- **8+ targeted queries per period** (`/batch/bs_preload_targeted`) with overlapping account lists
- **Each targeted query:** 93-288 seconds
- **Total for 2 columns:** 800+ seconds (13+ minutes)
- **Single-cell resolutions:** Many cells resolved one-by-one
- **Note:** Auto-preload (`/batch/bs_preload`) does cache entire periods, but column-based batching was bypassing cache and making redundant targeted queries

### After Optimization
- **1-2 targeted queries per period** (with all accounts merged before query is sent)
- **Each targeted query:** ~100 seconds (one comprehensive query with merged accounts)
- **Total for 2 columns:** ~200 seconds (3-4 minutes)
- **No single-cell resolutions:** All cells in column batch together
- **Cache-first approach:** localStorage check happens BEFORE batch creation, so if auto-preload completed, no targeted queries are needed

### Drag Down Performance
- **Before:** Each cell made individual API call or waited for batch
- **After:** All cells resolve immediately from localStorage cache

---

## Code Flow Diagram

```
User Enters Formula
    ↓
Check localStorage (BEFORE batch creation)
    ↓
[Cache Hit?] → YES → Return immediately ✅
    ↓ NO
Check activePeriodQueries (period-based deduplication)
    ↓
[Period Already Being Queried?]
    ↓ YES
[Account in Query?] → YES → Wait for existing query ✅
    ↓ NO
Merge accounts, create new batch with merged accounts
    ↓ NO (Period Not Being Queried)
Create new batch
    ↓
Track in activePeriodQueries (periodKey → {promise, accounts, ...})
    ↓
Execute batch query
    ↓
Cache results:
  - In-memory cache
  - localStorage (legacy format)
  - localStorage (preload format: balance:account:filtersHash:period)
    ↓
Resolve all waiting cells
    ↓
Clean up: Remove from activePeriodQueries
```

---

## Key Implementation Details

### 1. Period Key Format
```javascript
const periodKey = `${periods.join(',')}:${filterKey}`;
// Example: "Jan 2025,Feb 2025:1::::1"
```

### 2. Account Merging
```javascript
// When period overlap detected:
accounts.forEach(acc => activePeriodQuery.accounts.add(acc));
accounts = Array.from(activePeriodQuery.accounts).sort();
```

### 3. Atomic Check-and-Set
```javascript
// Check period query BEFORE creating batch
let activePeriodQuery = activePeriodQueries.get(periodKey);

// If found, check if account is already in query
if (activePeriodQuery && activePeriodQuery.accounts.has(account)) {
    // Wait for existing query
    return await activePeriodQuery.promise;
}

// Otherwise, create new batch with merged accounts
```

### 4. localStorage Check Priority
```javascript
// Check localStorage BEFORE column-based batching (line ~6551)
// This ensures dragged cells use cache instead of creating batches
if (isCumulativeQuery && lookupPeriod) {
    const localStorageValue = checkLocalStorageCache(...);
    if (localStorageValue !== null) {
        return localStorageValue; // Immediate return, no batch creation
    }
}
```

### 5. Dual Cache Format
```javascript
// Write to BOTH formats:
// 1. Legacy: netsuite_balance_cache (for backward compatibility)
// 2. Preload: xavi_balance_cache (for immediate lookup)
// Format: balance:${account}:${filtersHash}:${period}
```

---

## Limitations and Future Improvements

### Current Limitation
If a **targeted query** for a period is **already in flight** when a new batch wants to add accounts:
- The query was already sent with the original account list
- New accounts are merged into `activePeriodQuery.accounts`
- But the in-flight query won't include them
- Result: Supplemental targeted query may still be needed

**Note:** This limitation only affects targeted queries. If auto-preload (`/batch/bs_preload`) has already completed and cached the entire period, the localStorage check (which happens BEFORE batch creation) will return immediately, and no targeted queries will be needed.

### Potential Future Improvement
Track query state (pending vs. sent):
- If query not yet sent → merge accounts and update query
- If query already sent → wait for results, then check if supplemental query needed

---

## Testing Checklist

- [ ] Enter formula in first cell → resolves correctly
- [ ] Drag down (same column) → all cells resolve immediately from cache
- [ ] Drag right (same row, different periods) → one query per period
- [ ] Drag across both dimensions → no single-cell resolutions
- [ ] Performance: 5 columns should take ~500 seconds (same as 5 manual entries)
- [ ] Check logs for `🔄 PERIOD DEDUP` messages
- [ ] Verify `activePeriodQueries` is being used correctly
- [ ] Verify localStorage cache is being checked before batch creation

---

## Log Messages to Watch For

### Successful Period Deduplication
```
🔄 PERIOD DEDUP: Periods Jan 2025 already being queried
   Existing accounts: 19, Our accounts: 1
   ✅ Account 10010 already in query, awaiting results...
✅ PERIOD DEDUP RESULT: 10010 for Jan 2025 = 2064705.84
```

### Account Merging with Rolling Debounce
```
🔄 PERIOD DEDUP: Periods Jan 2025 already being queried
   Existing accounts: 19, Our accounts: 1
   📊 Account 10011 not in existing query, merging during debounce window (collecting state)
🔍 MERGE: Adding account 10011 to existing query, now 20 accounts (was 19)
⏱️ DEBOUNCE: Resetting timer for Jan 2025:1::::1 - 20 accounts, 150ms elapsed, 200ms remaining
⏱️ DEBOUNCE FIRED: Jan 2025:1::::1 with 20 accounts after 350ms
```

### localStorage Cache Hit (Drag Down)
```
✅ localStorage cache hit BEFORE batch check: 10010/Jan 2025 = 2064705.84
```

### Cache Check Before Individual Call
```
⚠️ FALLBACK TO INDIVIDUAL: account=10010, period=Feb 2025 - cache miss, will queue individual API call
✅ POST-BATCH CACHE HIT: 10010/Feb 2025 = 381646.48 (batch query completed, using cached result)
```

### Rolling Debounce Timer Creation
```
🔍 DEBOUNCE: Creating new query for Jan 2025:1::::1, starting 200ms rolling timer (2 accounts initially)
⏱️ DEBOUNCE: Started 200ms window for Jan 2025:1::::1 (2 accounts initially)
```

---

## Files Modified

1. **`docs/functions.js`**
   - Added `activePeriodQueries` Map (line ~5277)
   - Added period-based deduplication logic (lines ~6644-6695)
   - Added localStorage check before batch creation (lines ~6540-6557)
   - Updated batch execution to track in `activePeriodQueries` (lines ~6719-6748)
   - Updated cleanup to remove from `activePeriodQueries` (lines ~6722-6731, 6778-6782)
   - Updated batch write to preload cache format (lines ~1227-1240)

2. **`excel-addin/manifest.xml`**
   - Updated version to `4.0.6.130`
   - Updated all cache-busting URLs

3. **`docs/taskpane.html`, `docs/sharedruntime.html`, `docs/functions.html`**
   - Updated functions.js script references to v4.0.6.130

4. **`PERIOD_DEDUPLICATION_PLAN.md`** (new file)
   - Implementation plan and analysis

---

## Summary

This implementation introduces **period-based deduplication** to prevent redundant queries when dragging formulas across columns. The key improvements are:

1. **localStorage check BEFORE batch creation** - Dragged cells in same column resolve immediately
2. **Period-based tracking** - Queries are tracked by period, not by account list
3. **Account merging** - Multiple batches for same period merge their account lists
4. **Dual cache format** - Results written to both legacy and preload cache formats

**Expected Result:** Dragging across 5 columns should take the same time as manually entering 5 formulas (one query per period), with no single-cell resolutions.
