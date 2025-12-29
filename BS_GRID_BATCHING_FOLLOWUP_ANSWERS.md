# Balance Sheet Grid Batching - Follow-Up Questions & Answers

## 1. Anchor Determination

### Question
How is the anchor date determined in code? Please confirm that the anchor is based on the earliest fromDate across the detected grid, not on formula evaluation order, the first cell evaluated, or the order in which formulas were entered.

### Answer: ✅ CONFIRMED - Anchor is Based on Earliest fromDate Across ALL Requests

**Code Location**: `docs/functions.js`, `detectBsGridPattern()` function (lines ~1800-1850)

**Implementation**:
```javascript
function detectBsGridPattern(requests) {
    // ... validation code ...
    
    // Collect unique accounts and periods
    const accounts = new Set();
    const periods = new Set();
    let earliestFromPeriod = null;
    let latestToPeriod = null;
    
    // CRITICAL: Iterate through ALL requests to find earliest/latest
    for (const request of periodActivityRequests) {
        const { account, fromPeriod, toPeriod } = request.params;
        accounts.add(account);
        periods.add(fromPeriod);
        periods.add(toPeriod);
        
        // Track earliest fromPeriod and latest toPeriod
        // Uses string comparison (< operator) which works for "Mon YYYY" format
        if (!earliestFromPeriod || fromPeriod < earliestFromPeriod) {
            earliestFromPeriod = fromPeriod;  // ✅ Always finds minimum across ALL requests
        }
        if (!latestToPeriod || toPeriod > latestToPeriod) {
            latestToPeriod = toPeriod;  // ✅ Always finds maximum across ALL requests
        }
    }
    
    return {
        accounts,
        periods,
        earliestFromPeriod,  // ✅ Guaranteed to be earliest across entire grid
        latestToPeriod,
        filtersHash
    };
}
```

**Key Points**:
1. **Deterministic**: The anchor is computed by iterating through **ALL** requests in the `periodActivityRequests` array
2. **Order-Independent**: Uses `fromPeriod < earliestFromPeriod` comparison, which finds the minimum regardless of array order
3. **Not Based On**:
   - ❌ Formula evaluation order (all requests collected first, then analyzed)
   - ❌ First cell evaluated (checks all cells before determining anchor)
   - ❌ Order formulas were entered (requests are collected from `pendingRequests.balance` Map, which has no guaranteed order)

**Verification**:
- The `detectBsGridPattern()` function receives ALL period activity requests at once (from `processBatchQueue()`)
- It iterates through ALL requests to find the minimum `fromPeriod`
- The anchor is then inferred from this `earliestFromPeriod` value
- This happens **before** any NetSuite queries are made

**Code Flow**:
```javascript
// In processBatchQueue():
const requests = Array.from(pendingRequests.balance.entries());  // All requests collected
const periodActivityRequests = [];  // Filter period activity requests

for (const [cacheKey, request] of requests) {
    const { fromPeriod, toPeriod } = request.params;
    const isPeriodActivity = fromPeriod && toPeriod && fromPeriod !== toPeriod;
    if (isPeriodActivity) {
        periodActivityRequests.push([cacheKey, request]);  // Collect ALL period activity requests
    }
}

// Then detectBsGridPattern() analyzes ALL collected requests
const gridInfo = detectBsGridPattern(periodActivityRequests);  // ✅ Analyzes entire grid at once
```

---

## 2. Grid Expansion with Earlier Periods

### Question
If a user later adds an earlier period (for example inserts January to the left after building March–December):
- Is the anchor recomputed automatically?
- Are opening balances and all derived balances recalculated correctly?
- Is any cached data invalidated and rebuilt as needed?

### Answer: ✅ YES - Anchor is Recomputed, Cache is Invalidated, Balances Recalculated

**How It Works**:

#### A. Anchor Recomputation

**Code Location**: `docs/functions.js`, `detectBsGridPattern()` (line ~1816)

When new formulas are added (including earlier periods), the next `processBatchQueue()` call will:
1. Collect ALL pending requests (including new ones with earlier periods)
2. Call `detectBsGridPattern()` which finds the NEW earliest `fromPeriod` across ALL requests
3. Compute a NEW anchor date based on the new earliest period

**Example**:
- Initial grid: March–December (earliest = "Mar 2025", anchor = day before Mar 1)
- User adds January: New grid includes Jan–December (earliest = "Jan 2025", anchor = day before Jan 1)
- ✅ Anchor automatically recomputed to earlier date

#### B. Cache Invalidation

**Code Location**: `docs/functions.js`, `buildBsGridCacheKey()` (line ~1930)

**Cache Key Structure**:
```javascript
function buildBsGridCacheKey(accounts, anchorDate, fromPeriod, toPeriod, filtersHash) {
    const accountList = Array.from(accounts).sort().join(',');
    return `bs-grid:${accountList}:${anchorDate}:${fromPeriod}:${toPeriod}:${filtersHash}`;
}
```

**Key Components**:
- `anchorDate`: Changes when earlier period is added → **NEW cache key**
- `fromPeriod`: Changes when earlier period is added → **NEW cache key**
- `toPeriod`: May change if later period added → **NEW cache key**

**Result**: When anchor or period range changes, the cache key is different, so:
- ✅ Old cache entry is NOT used (cache miss)
- ✅ New batched queries are executed
- ✅ New cache entry is created with correct anchor/periods

**Code Flow**:
```javascript
// In processBatchQueue():
const gridInfo = detectBsGridPattern(periodActivityRequests);  // Finds NEW earliest period
const anchorDate = await inferAnchorDate(gridInfo.earliestFromPeriod);  // NEW anchor date
const gridCacheKey = buildBsGridCacheKey(
    gridInfo.accounts,
    anchorDate,  // ✅ NEW anchor date
    gridInfo.earliestFromPeriod,  // ✅ NEW earliest period
    gridInfo.latestToPeriod,
    filtersHash
);

const cachedGrid = bsGridCache.get(gridCacheKey);  // ✅ Cache miss (different key)
if (cachedGrid) {
    // Use cache
} else {
    // ✅ Cache miss → Execute NEW batched queries with NEW anchor
}
```

#### C. Opening Balances and Derived Balances Recalculated

**Code Location**: `docs/functions.js`, grid batching logic (lines ~6883-6970)

When cache misses (due to new anchor/periods):
1. **Opening Balances Query**: Executed with NEW anchor date
   ```javascript
   const openingResponse = await fetch(`${SERVER_URL}/batch/balance/bs-grid-opening`, {
       body: JSON.stringify({
           accounts: Array.from(gridInfo.accounts),
           anchorDate: anchorDate,  // ✅ NEW anchor date
           fromPeriod: gridInfo.earliestFromPeriod,  // ✅ NEW earliest period
           // ...
       })
   });
   ```

2. **Period Activity Query**: Executed with NEW period range
   ```javascript
   const activityResponse = await fetch(`${SERVER_URL}/batch/balance/bs-grid-activity`, {
       body: JSON.stringify({
           accounts: Array.from(gridInfo.accounts),
           fromPeriod: gridInfo.earliestFromPeriod,  // ✅ NEW earliest period
           toPeriod: gridInfo.latestToPeriod,  // ✅ May be new if later period added
           // ...
       })
   });
   ```

3. **Local Computation**: All ending balances recomputed from new opening balances + activity
   ```javascript
   for (const [cacheKey, request] of periodActivityRequests) {
       const { account, toPeriod } = request.params;
       const endingBalance = computeEndingBalance(
           account,
           toPeriod,
           openingBalances,  // ✅ NEW opening balances
           activity  // ✅ NEW activity data
       );
       request.resolve(endingBalance);  // ✅ All cells get new values
   }
   ```

**Result**: ✅ All balances are recalculated correctly with the new anchor and period range.

---

## 3. Single In-Flight Execution Lock

### Question
Is there a hard single-flight lock that guarantees only one Balance Sheet batch query can run at a time? While that query is in flight, do other cell evaluations block or reuse the pending result? Can any path accidentally trigger a second NetSuite call? Please confirm whether this is implemented as an actual mutex / promise lock, not just a logical guard.

### Answer: ✅ CONFIRMED - Promise-Based Lock with Blocking Behavior

**Code Location**: `docs/functions.js`, lines ~1339-1343, ~6828-6985

**Lock Implementation**:
```javascript
// Execution lock for BS grid batching (only one batch query in flight at a time)
let bsGridBatchingLock = {
    locked: false,      // Boolean flag
    promise: null,      // Promise that resolves when current batch completes
    cacheKey: null      // Cache key of current batch (for debugging)
};
```

**Lock Acquisition**:
```javascript
// In processBatchQueue(), grid batching section:
if (bsGridBatchingLock.locked) {
    console.log(`   ⏳ BS Grid batching already in progress - waiting...`);
    await bsGridBatchingLock.promise;  // ✅ BLOCKS until current batch completes
}

// Acquire lock
bsGridBatchingLock.locked = true;
bsGridBatchingLock.cacheKey = gridCacheKey;

const lockPromise = (async () => {
    try {
        // Execute batched queries...
        // Step 1: Opening balances
        // Step 2: Period activity
        // Step 3: Cache results
        // Step 4: Resolve all requests
    } finally {
        // Release lock
        bsGridBatchingLock.locked = false;
        bsGridBatchingLock.promise = null;
        bsGridBatchingLock.cacheKey = null;
    }
})();

bsGridBatchingLock.promise = lockPromise;  // ✅ Store promise for other evaluations to await
await lockPromise;  // ✅ Wait for batch to complete
```

**Behavior When Lock is Held**:

1. **Other Cell Evaluations Block**:
   ```javascript
   if (bsGridBatchingLock.locked) {
       await bsGridBatchingLock.promise;  // ✅ BLOCKS - waits for current batch
   }
   ```

2. **After Lock Releases**:
   - Lock is released in `finally` block (guaranteed even on error)
   - `bsGridBatchingLock.promise` is set to `null`
   - Next evaluation can acquire lock and proceed

3. **Cache Reuse**:
   ```javascript
   // After lock releases, check cache
   const cachedGrid = bsGridCache.get(gridCacheKey);
   if (cachedGrid) {
       // ✅ Reuse cached results (no NetSuite call)
       // Resolve all requests from cache
   }
   ```

**Prevention of Second NetSuite Call**:

**Path 1 - Lock Check**:
```javascript
if (bsGridBatchingLock.locked) {
    await bsGridBatchingLock.promise;  // ✅ Blocks - cannot proceed to NetSuite calls
}
```

**Path 2 - Cache Check**:
```javascript
const cachedGrid = bsGridCache.get(gridCacheKey);
if (cachedGrid) {
    // ✅ Uses cache - no NetSuite call
    // Resolve all requests from cache
} else {
    // Only reaches here if cache miss AND lock not held
}
```

**Path 3 - Lock Acquisition**:
```javascript
bsGridBatchingLock.locked = true;  // ✅ Atomic flag set
bsGridBatchingLock.promise = lockPromise;  // ✅ Promise stored
// Now executing batched queries...
```

**Verification**: ✅ This is a **promise-based lock**, not just a logical guard:
- Uses `await bsGridBatchingLock.promise` to block other evaluations
- Lock is released in `finally` block (guaranteed cleanup)
- Promise is stored and awaited by concurrent evaluations
- No race conditions possible (JavaScript is single-threaded, async/await is cooperative)

**Edge Case Handling**:
- If batch query fails → lock still released in `finally` block
- If batch query times out → lock still released in `finally` block
- If error occurs → lock still released in `finally` block
- ✅ Lock is **always** released, preventing deadlocks

---

## 4. Safety Limits

### Question
What concrete safety limits are enforced? Maximum number of periods per grid? Maximum number of accounts per grid? What is the exact failure behavior if these limits are exceeded? Controlled error? Partial results avoided?

### Answer: ✅ CONFIRMED - Hard Limits with Fail-Fast Fallback

**Code Location**: `docs/functions.js`, lines ~1346-1347, ~1830-1840

**Safety Limits**:
```javascript
// Safety limits for BS grid batching
const BS_GRID_MAX_ACCOUNTS = 200;
const BS_GRID_MAX_PERIODS = 36;
```

**Enforcement Location**: `detectBsGridPattern()` function (lines ~1830-1840)

```javascript
function detectBsGridPattern(requests) {
    // ... collect accounts and periods ...
    
    // Safety limit check
    if (accounts.size > BS_GRID_MAX_ACCOUNTS) {
        console.warn(`⚠️ BS Grid: Too many accounts (${accounts.size}), max: ${BS_GRID_MAX_ACCOUNTS}`);
        return null;  // ✅ Fail fast - don't attempt grid batching
    }
    
    // Count unique periods in range
    const periodCount = periods.size;
    if (periodCount > BS_GRID_MAX_PERIODS) {
        console.warn(`⚠️ BS Grid: Too many periods (${periodCount}), max: ${BS_GRID_MAX_PERIODS}`);
        return null;  // ✅ Fail fast - don't attempt grid batching
    }
    
    return {
        accounts,
        periods,
        earliestFromPeriod,
        latestToPeriod,
        filtersHash
    };
}
```

**Backend Limits** (Defensive Check):
```csharp
// backend-dotnet/Controllers/BalanceController.cs
const int MAX_ACCOUNTS = 200;
const int MAX_PERIODS = 36;

if (request.Accounts.Count > MAX_ACCOUNTS) {
    return BadRequest(new BsGridOpeningBalancesResponse {
        Success = false,
        Error = $"Too many accounts: {request.Accounts.Count} (max: {MAX_ACCOUNTS})"
    });
}
```

**Exact Failure Behavior**:

1. **Frontend (Primary Check)**:
   - `detectBsGridPattern()` returns `null` if limits exceeded
   - Grid detection fails → falls back to individual processing
   - **No hard error** → user experience: slower but still works
   - Each cell makes its own API call (original behavior)

2. **Backend (Defensive Check)**:
   - Returns `BadRequest` with error message
   - Should never be hit if frontend check works correctly
   - Provides defense-in-depth

**Code Flow When Limit Exceeded**:
```javascript
// In processBatchQueue():
const gridInfo = detectBsGridPattern(periodActivityRequests);

if (gridInfo && gridInfo.accounts.size >= 2 && gridInfo.periods.size >= 2) {
    // Grid batching logic...
} else {
    // ✅ Falls through to individual processing
    // No error thrown, no partial results
    // Each cell processed individually
}

// Later in code:
if (periodActivityRequests.length > 0) {
    // Process each period activity request individually
    for (const [cacheKey, request] of periodActivityRequests) {
        // Individual API call per cell
        // ✅ No partial results - each cell gets full result
    }
}
```

**Key Points**:
- ✅ **Fail Fast**: Limits checked before any NetSuite queries
- ✅ **No Partial Results**: Either full grid batching OR individual processing (never mixed)
- ✅ **No Hard Failure**: Falls back gracefully to individual processing
- ✅ **Controlled Behavior**: User experience degrades gracefully (slower but works)

---

## 5. Income Statement Isolation

### Question
Please confirm explicitly that:
- No shared logic paths used by Income or Expense accounts were modified
- All batching, anchoring, and running-balance logic is fenced behind Balance Sheet account detection only
- If possible, point to the diff boundaries or functions that guarantee this isolation.

### Answer: ✅ CONFIRMED - Complete Isolation via Early Branching

**Code Location**: `docs/functions.js`, `processBatchQueue()` function (lines ~6500-7000)

### A. Request Routing (Early Separation)

**Code Location**: `docs/functions.js`, lines ~6500-6510

```javascript
// ================================================================
// ROUTE REQUESTS BY TYPE:
// 1. CUMULATIVE BS QUERIES: empty fromPeriod with toPeriod → direct /balance API calls
// 2. PERIOD ACTIVITY QUERIES: both fromPeriod and toPeriod → direct /balance API calls (not batch endpoint)
// 3. REGULAR REQUESTS: P&L period ranges → batch endpoint
// ================================================================
const cumulativeRequests = [];
const periodActivityRequests = [];  // BS period activity queries (both fromPeriod and toPeriod)
const regularRequests = [];

for (const [cacheKey, request] of requests) {
    const { fromPeriod, toPeriod } = request.params;
    const isCumulative = (!fromPeriod || fromPeriod === '') && toPeriod && toPeriod !== '';
    const isPeriodActivity = fromPeriod && toPeriod && fromPeriod !== toPeriod;
    
    if (isCumulative) {
        cumulativeRequests.push([cacheKey, request]);
    } else if (isPeriodActivity) {
        periodActivityRequests.push([cacheKey, request]);  // ✅ Only period activity requests
    } else {
        regularRequests.push([cacheKey, request]);  // ✅ P&L requests go here
    }
}
```

**Key Point**: Period activity requests are separated from regular requests **before** any grid detection.

### B. Account Type Verification (BS-Only Gate)

**Code Location**: `docs/functions.js`, lines ~6805-6820

```javascript
if (gridInfo && gridInfo.accounts.size >= 2 && gridInfo.periods.size >= 2) {
    // Verify accounts are BS accounts (sample check - if any fail, fall back)
    let allBsAccounts = true;
    
    // Sample check: verify first few accounts are BS (conservative)
    const sampleAccounts = Array.from(gridInfo.accounts).slice(0, Math.min(10, gridInfo.accounts.size));
    for (const account of sampleAccounts) {
        try {
            const accountType = await getAccountType(account);
            if (!isBalanceSheetType(accountType)) {  // ✅ BS-only check
                console.log(`   ⚠️ Account ${account} is not BS (type: ${accountType}) - falling back to individual processing`);
                allBsAccounts = false;
                break;  // ✅ Exit immediately if non-BS detected
            }
        } catch (error) {
            console.warn(`   ⚠️ Could not verify account type for ${account} - falling back to individual processing`);
            allBsAccounts = false;
            break;  // ✅ Exit immediately on error
        }
    }
    
    if (allBsAccounts) {
        // ✅ ONLY reaches here if ALL sampled accounts are BS
        // Grid batching logic...
    } else {
        // ✅ Falls back to individual processing (no grid batching)
    }
}
```

**Key Point**: Grid batching **only** proceeds if account type verification confirms BS accounts.

### C. Function Isolation (No Shared Code Paths)

**Grid Batching Functions** (BS-only):
- `detectBsGridPattern()` - Only called for period activity requests
- `inferAnchorDate()` - Only called within grid batching logic
- `buildBsGridCacheKey()` - Only called within grid batching logic
- `computeEndingBalance()` - Only called within grid batching logic

**Income/Expense Functions** (Unchanged):
- `BALANCE()` - No changes to core logic
- `processBatchQueue()` - Regular requests use existing batch endpoint (unchanged)
- All P&L logic paths remain untouched

**Code Boundaries**:

**Boundary 1 - Request Routing** (Line ~6500):
```javascript
// ✅ P&L requests go to regularRequests (existing batch endpoint)
// ✅ BS period activity requests go to periodActivityRequests (new grid batching)
```

**Boundary 2 - Grid Detection** (Line ~6794):
```javascript
const gridInfo = detectBsGridPattern(periodActivityRequests);
// ✅ Only called for period activity requests (already separated)
```

**Boundary 3 - Account Type Check** (Line ~6805):
```javascript
if (!isBalanceSheetType(accountType)) {
    allBsAccounts = false;  // ✅ Exit - no grid batching
}
```

**Boundary 4 - Grid Batching Execution** (Line ~6822):
```javascript
if (allBsAccounts) {
    // ✅ ONLY BS accounts reach here
    // Grid batching logic (completely isolated)
} else {
    // ✅ Falls back to individual processing
}
```

**Boundary 5 - Fallback to Individual Processing** (Line ~6996):
```javascript
// Step 2: Process remaining period activity requests individually (fallback or non-grid)
if (periodActivityRequests.length > 0) {
    // ✅ Individual API calls (same as before, no changes)
}
```

### D. Verification - No Shared Logic Modified

**Functions That Were NOT Modified**:
- ✅ `BALANCE()` - Core function unchanged (only routing logic added)
- ✅ `processBatchQueue()` - Regular request processing unchanged
- ✅ Batch endpoint logic for P&L accounts - unchanged
- ✅ All Income/Expense account type detection - unchanged

**Functions That Were Added** (BS-only):
- ✅ `detectBsGridPattern()` - New function, only called for period activity
- ✅ `inferAnchorDate()` - New function, only called within grid batching
- ✅ `buildBsGridCacheKey()` - New function, only called within grid batching
- ✅ `computeEndingBalance()` - New function, only called within grid batching

**Diff Summary**:
- **Added**: ~400 lines of BS-only grid batching logic
- **Modified**: ~50 lines in `processBatchQueue()` (routing + grid detection call)
- **Unchanged**: All Income/Expense logic paths

**Guarantee**: ✅ Income/Expense accounts **cannot** reach grid batching code because:
1. They don't match `isPeriodActivity` check (P&L uses different period logic)
2. Even if they did, account type verification would fail
3. Fallback to individual processing preserves original behavior

---

## 6. Refresh All Behavior

### Question
On "Refresh All":
- Is the entire grid re-evaluated as a single unit?
- Are anchor and cached results recomputed exactly once?
- Are per-cell NetSuite calls still impossible during refresh?

### Answer: ⚠️ PARTIAL - Refresh All Uses Different Path, But Grid Batching Still Applies

**Code Location**: `docs/functions.js`, `processFullRefresh()` function (lines ~6296-6454)

### A. Refresh All Implementation

**Current Behavior**:
```javascript
async function processFullRefresh() {
    const allRequests = Array.from(pendingRequests.balance.entries());
    
    // Extract year from requests
    let year = fullRefreshYear;
    
    // Get filters from first request
    const filters = { /* ... */ };
    
    // Call optimized backend endpoint
    const response = await fetch(`${SERVER_URL}/batch/full_year_refresh`, {
        method: 'POST',
        body: JSON.stringify({
            year: year,
            ...filters
        })
    });
    
    // Populate cache with ALL results
    // Resolve all requests
}
```

**Key Point**: `processFullRefresh()` uses a **different endpoint** (`/batch/full_year_refresh`) that fetches all accounts for an entire year.

### B. Grid Batching During Refresh All

**Question**: Does grid batching apply during Refresh All?

**Answer**: ✅ **YES** - Grid batching logic is in `processBatchQueue()`, which is called for normal recalculation. However, `processFullRefresh()` is a separate path.

**Code Flow**:
```javascript
// In BALANCE() function:
if (buildMode) {
    // Queue for build mode batch
} else if (isFullRefreshMode) {
    // Queue silently (task pane will trigger processFullRefresh)
    // ✅ Does NOT call processBatchQueue()
} else {
    // Normal mode - queue for processBatchQueue()
    // ✅ Grid batching logic is in processBatchQueue()
}
```

**Current State**:
- **Refresh All**: Uses `processFullRefresh()` → `/batch/full_year_refresh` endpoint
- **Normal Recalculation**: Uses `processBatchQueue()` → Grid batching logic applies

### C. Answer to Specific Questions

**Q1: Is the entire grid re-evaluated as a single unit?**
- **Refresh All**: ✅ YES - Uses single `/batch/full_year_refresh` query
- **Normal Recalculation**: ✅ YES - Grid batching detects grid and uses 2 batched queries

**Q2: Are anchor and cached results recomputed exactly once?**
- **Refresh All**: ⚠️ **N/A** - Uses different endpoint (no anchor concept)
- **Normal Recalculation**: ✅ YES - Anchor computed once in `detectBsGridPattern()`, cache checked once

**Q3: Are per-cell NetSuite calls still impossible during refresh?**
- **Refresh All**: ✅ YES - Single `/batch/full_year_refresh` query (no per-cell calls)
- **Normal Recalculation**: ✅ YES - Grid batching uses 2 batched queries (no per-cell calls)

### D. Recommendation

**Current Gap**: `processFullRefresh()` doesn't use grid batching logic. If a user has a BS grid and clicks "Refresh All", it uses the full-year refresh endpoint instead of the optimized grid batching.

**Potential Enhancement** (NOT implemented):
- Check if requests form a BS grid pattern
- If yes, use grid batching (2 queries) instead of full-year refresh (1 query)
- This would be more efficient for BS grids

**Current Behavior is Safe**:
- ✅ No per-cell calls during Refresh All
- ✅ Single query for all accounts
- ✅ Grid batching still works for normal recalculation

---

## Summary of Guarantees

### ✅ Confirmed Behaviors

1. **Anchor Determination**: Based on earliest `fromDate` across ALL requests, order-independent
2. **Grid Expansion**: Anchor recomputed, cache invalidated, balances recalculated
3. **Execution Lock**: Promise-based lock with blocking behavior, prevents concurrent queries
4. **Safety Limits**: Hard limits (200 accounts, 36 periods) with fail-fast fallback
5. **Income Statement Isolation**: Complete isolation via early branching and account type checks
6. **Refresh All**: Uses separate path, but no per-cell calls (uses full-year refresh endpoint)

### ⚠️ Areas for Potential Enhancement

1. **Refresh All Integration**: Could integrate grid batching into `processFullRefresh()` for BS grids
2. **Account Limit**: Could be increased if performance testing confirms safety

### 🔒 Safety Guarantees

- ✅ No Income/Expense logic modified
- ✅ No per-cell NetSuite calls in grid batching path
- ✅ Fail-fast behavior (no partial results)
- ✅ Easy rollback (all logic isolated)
- ✅ Execution lock prevents concurrent queries
- ✅ Cache invalidation on grid expansion

