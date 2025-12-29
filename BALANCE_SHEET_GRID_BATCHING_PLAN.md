# Balance Sheet Grid Batching Optimization Plan

## Executive Summary

This plan proposes a performance optimization for `XAVI.BALANCE(account, fromDate, toDate)` that detects when users are building Balance Sheet grids across multiple periods and collapses multiple period queries into a single NetSuite API call. This applies **ONLY** to Balance Sheet accounts when both `fromDate` and `toDate` are present. Income and Expense accounts remain completely unchanged.

## Step 0: Rollback Point (REQUIRED)

**Before any implementation:**
- Create git branch: `balance-sheet-before-grid-batching`
- Create annotated tag: `restorepoint/balance-sheet-before-grid-batching`
- Document current behavior baseline
- All new logic must be isolated so reverting fully restores current behavior

**Note**: A feature flag is NOT required. Safety is ensured by:
- Creating a clear rollback checkpoint before implementation
- Isolating all new batching logic behind Balance Sheet account detection
- Ensuring Income and Expense account code paths remain untouched
- If issues arise, reverting to the pre-optimization checkpoint must fully restore previous behavior

## Current Architecture Analysis

### Current Request Flow

1. **Individual Formula Evaluation**
   - Each `BALANCE` formula is evaluated independently by Excel
   - Formula calls `BALANCE()` function in `functions.js`
   - Function checks cache, then queues request in `pendingRequests.balance`
   - Batch processor (`processBatchQueue()`) collects requests and sends to API

2. **Current Batch Processing**
   - `processBatchQueue()` groups requests by filter combinations
   - For period activity queries (both fromPeriod and toPeriod), routes to individual `/balance` API calls
   - For cumulative queries (empty fromPeriod), routes to individual `/balance` API calls
   - Batch endpoint (`/batch/balance`) is used for P&L period ranges only

3. **Current Period Activity Query Path**
   - Period activity queries (BS accounts with both dates) are routed to individual API calls
   - Each period gets its own query: `Balance(toPeriod) - Balance(beforeFromPeriod)`
   - For a 100 accounts × 12 months grid, this results in 1,200 individual API calls

### Current Cache Structure

- **In-memory cache**: `cache.balance` (Map) - keyed by cache key
- **localStorage cache**: Preload cache for cumulative BS queries
- **Cache keys**: Include account, fromPeriod, toPeriod, filters

## Problem Statement

### Current Behavior
- **100 accounts × 12 months = 1,200 individual API calls**
- Each call takes ~2-5 seconds
- Total time: 40-100 minutes
- Excel becomes unresponsive during this time
- High risk of crashes due to event-loop starvation

### Root Cause
- NetSuite query time for one account vs. all accounts for a single period is roughly the same
- Current architecture processes each period independently
- No grid-aware batching for period activity queries

## Proposed Solution: Grid-Aware Batching

### Core Concept

When multiple `BALANCE` formulas are evaluated in quick succession (indicating grid expansion), detect the pattern and:
1. **Defer individual resolutions** temporarily
2. **Collect all requests** in a grid-aware buffer
3. **Detect grid structure** (accounts × periods)
4. **Execute single aggregated query** covering entire range
5. **Cache full result set** locally
6. **Resolve all formulas** from cache

### Key Design Principles

1. **Early Branching**: Detect BS account + period activity immediately, exit early for Income/Expense
2. **Grid Detection**: Identify adjacent formulas with similar patterns
3. **Query Collapsing**: Single query covering full date range and account set
4. **Local Computation**: All cell values computed from cached data
5. **Safety Guards**: Bounded timeouts, fail-fast on errors, no recursive calls

## Detailed Implementation Plan

### Phase 1: Grid Detection Infrastructure

#### 1.1 Grid Detection Window

**Concept**: When multiple `BALANCE` formulas are queued within a short time window, treat as grid expansion.

**Implementation**:
- Add `gridDetectionWindow` constant: 2000ms (2 seconds)
- Track recent `BALANCE` requests in `recentBalanceRequests` array
- Each request includes: `{account, fromPeriod, toPeriod, timestamp, cacheKey, resolve, reject}`
- When new request arrives:
  - Check if it matches grid pattern (similar accounts, contiguous periods)
  - If yes, add to `gridBuffer` instead of immediate processing
  - Start `gridDetectionTimer` (200ms debounce)
  - When timer fires, analyze buffer for grid structure

**Safety**:
- Maximum buffer size: 500 requests (fail-fast if exceeded)
- Maximum wait time: 3 seconds (resolve individually if exceeded)
- Clear buffer after processing or timeout

#### 1.2 Grid Pattern Detection

**Pattern Recognition**:
- **Account pattern**: Similar account references (e.g., `$C2`, `$C3`, `$C4` or `C$2`, `D$2`, `E$2`)
- **Period pattern**: Contiguous date ranges (e.g., Jan→Feb, Feb→Mar, Mar→Apr)
- **Grid structure**: Detect if requests form a rectangular grid (accounts × periods)

**Algorithm**:
```javascript
function detectGridStructure(requests) {
    // Group by account reference pattern
    // Group by period pattern
    // Check if periods are contiguous
    // Check if accounts are sequential
    // Return: {isGrid: boolean, accounts: Set, periods: Array, dateRange: {min, max}}
}
```

**Edge Cases**:
- Non-contiguous periods: Not a grid, process individually
- Mixed account types: Only include BS accounts in grid
- Mixed query types: Only include period activity queries (both dates)

### Phase 2: Query Collapsing

#### 2.1 Aggregated Query Construction

**For detected grid**:
- **Account set**: All unique accounts in grid
- **Date range**: 
  - `fromDate`: Earliest `fromPeriod` in grid
  - `toDate`: Latest `toPeriod` in grid
- **Query type**: Period activity query (both dates required)

**Backend Requirements**:
- New endpoint: `/batch/balance/period-activity` OR
- Extend existing `/batch/balance` to support period activity queries
- Accept: `{accounts: [], from_period: string, to_period: string, filters: {...}}`
- Return: `{results: {account: {period: balance}}}`
- **CRITICAL**: Must use range-bounded query (not cumulative) for performance

**Query Structure**:
```json
{
  "accounts": ["10010", "10011", "10012", ...],
  "from_period": "Jan 2025",
  "to_period": "Dec 2025",
  "subsidiary": "...",
  "department": "...",
  "location": "...",
  "class": "...",
  "accountingbook": "..."
}
```

**Response Structure**:
```json
{
  "results": {
    "10010": {
      "Jan 2025": 2064705.84,
      "Feb 2025": 381646.48,
      ...
    },
    "10011": {
      "Jan 2025": 123456.78,
      ...
    }
  },
  "query_time": 45.2
}
```

#### 2.2 Backend Implementation (Separate Task)

**New Endpoint**: `/batch/balance/period-activity`

**CRITICAL: Separate Period Activity from Running Balances**

Responsibilities must remain strictly separated:
- **NetSuite queries return only period activity** (transactions in date range)
- **Running balances are computed locally** in a separate step (if needed)
- **Never mix cumulative balance logic** into the NetSuite query path

This prevents accidental reintroduction of cumulative-scan behavior.

**Logic**:
- Accept account list and date range
- For each account, execute range-bounded query (already optimized in `BalanceService.cs`)
- **Return ONLY period activity** (sum of transactions in range)
- **DO NOT** compute running balances or cumulative totals
- Return results keyed by account and period
- Use same optimization as individual period activity queries (single range query per account)

**Response Structure** (Period Activity Only):
```json
{
  "results": {
    "10010": {
      "Jan 2025": 2064705.84,  // Period activity for Jan (not cumulative)
      "Feb 2025": 381646.48,   // Period activity for Feb (not cumulative)
      ...
    }
  },
  "query_time": 45.2
}
```

**Note**: If running balances are needed, they must be computed locally from period activities, not in the NetSuite query.

**Performance Target**:
- 100 accounts × 12 months: Single query per account (100 queries total)
- Each query: ~2-5 seconds
- Total time: 200-500 seconds (vs. 1,200 queries × 2-5s = 2,400-6,000 seconds)

### Phase 3: Local Computation & Caching

#### 3.1 Result Caching

**CRITICAL: Cache Keys Must Include Full Date Span**

Cache entries must be keyed by all of the following:
- **Account set**: All accounts in grid (or individual account)
- **Earliest fromDate**: Minimum fromPeriod in grid
- **Latest toDate**: Maximum toPeriod in grid
- **Currency context**: If applicable
- **Filter context**: Subsidiary, department, location, class, accountingbook

**Do NOT cache solely by period or month labels.**
**Different date spans must never collide in cache.**

**Cache Structure**:
- **Grid-level cache**: Store full result set with key: `grid:${accountSetHash}:${earliestFromPeriod}:${latestToPeriod}:${filtersHash}`
- **Individual cache**: Populate `cache.balance` with individual period activity results
- **Cache keys**: Must include full date span, not just individual periods

**Caching Strategy**:
```javascript
// After receiving grid query results
// CRITICAL: Cache key includes full date span
const earliestFromPeriod = Math.min(...periods.map(p => getPeriodStart(p)));
const latestToPeriod = Math.max(...periods.map(p => p));

for (const account of accounts) {
    for (const period of periods) {
        const cacheKey = getCacheKey('balance', {
            account,
            fromPeriod: getPeriodStart(period),  // Individual period start
            toPeriod: period,                    // Individual period end
            // CRITICAL: Also include grid context in cache metadata
            gridContext: {
                earliestFrom: earliestFromPeriod,
                latestTo: latestToPeriod,
                accountSet: accounts
            },
            ...filters
        });
        const value = gridResults[account][period];
        cache.balance.set(cacheKey, value);
    }
}
```

**Cache Key Validation**:
- Ensure cache keys are unique for different date spans
- Never reuse cache entries across different date ranges
- Validate cache key includes all required components

#### 3.2 Formula Resolution

**After caching**:
- Resolve all pending requests from cache
- Each formula gets its value immediately (no additional API calls)
- All formulas resolve synchronously from cache

**Code Flow**:
```javascript
// After grid query completes
for (const request of gridBuffer) {
    const cacheKey = request.cacheKey;
    if (cache.balance.has(cacheKey)) {
        request.resolve(cache.balance.get(cacheKey));
    } else {
        // Fallback: resolve with 0 or error
        request.reject(new Error('GRID_CACHE_MISS'));
    }
}
```

### Phase 4: Safety Guards & Edge Cases

#### 4.1 Single In-Flight Execution Lock (CRITICAL)

**Requirement**: At most one NetSuite query related to Balance Sheet batching may be in flight at any time.

**Implementation**:
- Introduce `bsBatchingLock` boolean flag
- Set to `true` when grid query starts
- Set to `false` when grid query completes or fails
- While lock is active:
  - Additional cell evaluations must wait or read from cache
  - They must NEVER trigger a new NetSuite call
  - Queue requests in `gridWaitQueue` if cache miss
  - Resolve from cache if available, otherwise wait for lock release

**Code Structure**:
```javascript
let bsBatchingLock = false;
let gridWaitQueue = [];

async function processGridBatch(gridBuffer) {
    if (bsBatchingLock) {
        // Another batch in progress - queue these requests
        gridWaitQueue.push(...gridBuffer);
        return;
    }
    
    bsBatchingLock = true;
    try {
        // Execute grid query
        const results = await executeGridQuery(gridBuffer);
        // Cache results
        cacheGridResults(results);
        // Resolve all requests
        resolveGridRequests(gridBuffer, results);
        // Process queued requests
        processQueuedRequests();
    } finally {
        bsBatchingLock = false;
    }
}
```

**Safety**:
- Prevents recalculation storms
- Prevents Excel freezes
- Ensures single source of truth for grid queries

#### 4.2 Explicit Safety Limits (Fail Fast)

**Hard Limits**:
- Maximum periods per batch: 36 (3 years)
- Maximum accounts per batch: 200 (configurable)
- Maximum total requests in buffer: 500

**Behavior on Limit Exceeded**:
- **DO NOT** attempt partial or fallback queries
- **DO NOT** block Excel
- **DO** fail fast with controlled error: `Error('GRID_LIMIT_EXCEEDED')`
- **DO** log limit exceeded for monitoring
- **DO** process requests individually (existing path)

**Implementation**:
```javascript
function validateGridLimits(accounts, periods) {
    if (periods.length > 36) {
        throw new Error('GRID_LIMIT_EXCEEDED: Maximum 36 periods per batch');
    }
    if (accounts.length > 200) {
        throw new Error('GRID_LIMIT_EXCEEDED: Maximum 200 accounts per batch');
    }
}
```

#### 4.3 Timeout Protection

**Grid Detection Timeout**:
- Maximum wait: 3 seconds
- If grid not detected within timeout, process requests individually
- Prevents indefinite waiting

**Query Timeout**:
- Grid query timeout: 300 seconds (5 minutes)
- If timeout, fail-fast and process requests individually
- Log timeout for monitoring
- Release lock immediately on timeout

#### 4.4 Buffer Size Limits

**Maximum Buffer Size**:
- Hard limit: 500 requests
- If exceeded, fail fast with `Error('BUFFER_LIMIT_EXCEEDED')`
- Process requests individually (existing path)
- Prevents memory growth

#### 4.5 No Partial Fallback Once Batching Is Triggered

**CRITICAL RULE**: Once batching logic is engaged for a grid:
- It must fully own the grid
- **DO NOT** mix batched and per-period queries
- **DO NOT** incrementally fetch additional periods
- **DO NOT** fall back to individual queries for failed accounts

**Behavior on Query Failure**:
- If grid query fails completely:
  - Release lock immediately
  - Reject all requests in grid with error
  - **DO NOT** attempt individual queries
  - **DO NOT** attempt partial fallback
  - Log error for monitoring

**Behavior on Partial Results**:
- If backend returns partial results (some accounts missing):
  - Cache successful results
  - Reject missing accounts with error
  - **DO NOT** attempt individual queries for missing accounts
  - **DO NOT** attempt incremental fetch

**Rationale**:
- Partial fallback paths increase risk of regressions
- Partial fallback paths increase risk of instability
- All-or-nothing approach is safer and more predictable
- Failed grids can be retried by user (Excel recalculation)

**Implementation**:
```javascript
async function processGridBatch(gridBuffer) {
    bsBatchingLock = true;
    try {
        const results = await executeGridQuery(gridBuffer);
        
        // Validate all accounts have results
        const missingAccounts = validateCompleteResults(results, gridBuffer);
        if (missingAccounts.length > 0) {
            // Reject entire grid - no partial fallback
            gridBuffer.forEach(req => req.reject(new Error('GRID_PARTIAL_RESULTS')));
            return;
        }
        
        // Cache and resolve all
        cacheGridResults(results);
        resolveGridRequests(gridBuffer, results);
    } catch (error) {
        // Reject all - no fallback
        gridBuffer.forEach(req => req.reject(error));
    } finally {
        bsBatchingLock = false;
    }
}
```

#### 4.4 Excel Stability

**No Recursive Calls**:
- Grid detection never triggers additional formula evaluations
- All values come from cache or API, never from other formulas

**No Per-Cell Queries**:
- Once grid is detected, no individual API calls
- All values resolved from cached grid results

**Bounded Execution**:
- Maximum grid processing time: 5 minutes
- If exceeded, fail-fast and process individually

## Implementation Phases

### Phase 1: Infrastructure (No Behavior Change)
1. Create rollback branch/tag: `balance-sheet-before-grid-batching`
2. Add grid detection infrastructure (isolated behind BS account check)
3. Add grid buffer and timer logic
4. Add single execution lock (`bsBatchingLock`)
5. Add grid pattern detection (logging only)
6. Add explicit safety limits (fail-fast validation)
7. Verify no behavior changes (Income/Expense paths untouched)

### Phase 2: Grid Detection (Logging Only)
1. Enable grid detection
2. Log detected grids (no query collapsing yet)
3. Process requests individually (existing behavior)
4. Verify logs show correct grid detection

### Phase 3: Backend Support
1. Implement `/batch/balance/period-activity` endpoint
2. Test with sample grid queries
3. Verify performance improvement
4. Deploy backend changes

### Phase 4: Query Collapsing (Frontend)
1. Enable query collapsing for detected grids
2. Implement aggregated query construction (with full date span)
3. Implement single execution lock (prevent concurrent queries)
4. Implement result caching (with full date span in cache keys)
5. Implement formula resolution from cache (no partial fallback)
6. Test with small grids (5 accounts × 3 months)

### Phase 5: Testing & Validation
1. Test with medium grids (20 accounts × 12 months)
2. Test with large grids (100 accounts × 12 months)
3. Verify Income/Expense accounts unchanged
4. Verify Excel stability (no crashes, freezes)
5. Performance benchmarking

### Phase 6: Production Rollout
1. Enable feature flag
2. Monitor error rates
3. Monitor performance improvements
4. Gradual rollout if needed

## Code Isolation Strategy

### New Files
- `grid-detection.js` (if needed, or add to `functions.js` with clear section markers)
- **Note**: Feature flag NOT required - safety ensured by rollback checkpoint

### Modified Files
- `docs/functions.js`: Add grid detection logic in isolated section
- `backend-dotnet/Controllers/BalanceController.cs`: Add new endpoint
- `backend-dotnet/Services/BalanceService.cs`: Add grid query method (if needed)

### Isolation Markers
```javascript
// ============================================================================
// GRID BATCHING OPTIMIZATION (BALANCE SHEET ONLY)
// Rollback: balance-sheet-before-grid-batching branch/tag
// Safety: Isolated behind BS account detection, Income/Expense paths untouched
// ============================================================================
// ... grid detection code ...
// ============================================================================
// END GRID BATCHING OPTIMIZATION
// ============================================================================
```

## Safety Guarantees

### Income/Expense Account Protection
- **Early exit**: Check account type before grid detection
- **No shared code paths**: Grid logic only executes for BS period activity queries
- **Isolated conditionals**: All grid code wrapped in `if (isBSAccount && isPeriodActivity && ENABLE_GRID_BATCHING)`

### Excel Stability Protection
- **No recursive calls**: Grid detection never triggers formula re-evaluation
- **Bounded execution**: Maximum timeouts prevent indefinite waits
- **Fail-fast**: Errors trigger immediate fallback to individual processing
- **Memory limits**: Buffer size limits prevent memory growth

### Rollback Safety
- **Feature flag**: Can disable without code changes
- **Isolated code**: All changes in clearly marked sections
- **Git branch**: Easy rollback to `balance-sheet-before-grid-batching`

## Performance Targets

### Current Performance
- **100 accounts × 12 months**: 1,200 API calls, ~40-100 minutes
- **Excel responsiveness**: Poor (unresponsive during queries)

### Target Performance
- **100 accounts × 12 months**: 100 API calls (one per account), ~3-8 minutes
- **Excel responsiveness**: Good (queries run in background, cells populate from cache)
- **Improvement**: 10-12x faster, 90% reduction in API calls

## Testing Strategy

### Unit Tests
- Grid pattern detection algorithm
- Cache key generation
- Formula resolution from cache

### Integration Tests
- Small grid (5 accounts × 3 months)
- Medium grid (20 accounts × 12 months)
- Large grid (100 accounts × 12 months)
- Mixed account types (BS + P&L)
- Non-grid patterns (should process individually)

### Excel Stability Tests
- Drag-fill 100 accounts × 12 months
- Verify no crashes
- Verify no freezes
- Verify all cells populate correctly

### Regression Tests
- Income account queries (must be unchanged)
- Expense account queries (must be unchanged)
- Single period queries (must be unchanged)
- Cumulative queries (must be unchanged)

## Documentation Requirements

### Code Comments
- Explain why grid batching exists
- Explain why it applies only to BS accounts
- Explain why Income accounts must not use this path
- Document all safety guards

### User Documentation
- Explain performance improvement
- Explain when optimization applies
- Explain expected behavior

## Risk Assessment

### Low Risk
- Isolated code allows easy rollback (no feature flag needed)
- Early branching protects Income/Expense accounts
- Single execution lock prevents recalculation storms
- Explicit safety limits prevent overload

### Medium Risk
- Grid detection may have false positives/negatives
- Backend endpoint needs careful implementation
- Cache consistency needs verification (full date span in keys)
- No partial fallback means failed grids must be retried

### Mitigation
- Extensive testing before production
- Single execution lock prevents concurrent queries
- Explicit safety limits with fail-fast behavior
- Clear rollback procedure (checkpoint branch/tag)
- Monitoring and alerting for grid query failures

## Success Criteria

1. **Performance**: 100 accounts × 12 months completes in <10 minutes (vs. 40-100 minutes)
2. **Stability**: No Excel crashes or freezes during grid expansion
3. **Correctness**: All cell values match individual query results
4. **Regression**: Income/Expense accounts behave identically to before
5. **Rollback**: Can revert to `balance-sheet-before-grid-batching` without issues

## Next Steps

1. **Review this plan with ChatGPT** for feedback and validation
2. **Create rollback branch/tag** before any implementation
3. **Implement Phase 1** (infrastructure, isolated behind BS account check)
4. **Test Phase 1** (verify no behavior changes, Income/Expense paths untouched)
5. **Proceed with remaining phases** incrementally

---

## Final Reminders

### Critical Safety Rules

1. **Single In-Flight Execution Lock (CRITICAL)**
   - At most one NetSuite query related to Balance Sheet batching may be in flight at any time
   - While a batch query is running, additional cell evaluations must wait or read from cache
   - They must never trigger a new NetSuite call
   - This lock is required to prevent recalculation storms and Excel freezes

2. **Cache Keys Must Include Full Date Span**
   - Cache entries must be keyed by: account set, earliest fromDate, latest toDate, currency context
   - Do not cache solely by period or month labels
   - Different date spans must never collide in cache

3. **Separate Period Activity from Running Balances**
   - NetSuite queries return only period activity
   - Running balances are computed locally in a separate step
   - Never mix cumulative balance logic into the NetSuite query path
   - This prevents accidental reintroduction of cumulative-scan behavior

4. **Explicit Safety Limits (Fail Fast)**
   - Maximum number of periods per batch: 36
   - Maximum number of accounts per batch: 200 (configurable)
   - If limits are exceeded: fail fast with a controlled error, do not attempt partial or fallback queries, do not block Excel

5. **No Partial Fallback Once Batching Is Triggered**
   - Once batching logic is engaged for a grid, it must fully own the grid
   - Do not mix batched and per-period queries
   - Do not incrementally fetch additional periods
   - Partial fallback paths increase the risk of regressions and instability

6. **Rollback Guidance (No Feature Flag Required)**
   - A feature flag is not required
   - Safety is ensured by: creating a clear rollback checkpoint, isolating all new batching logic behind Balance Sheet account detection, ensuring Income and Expense account code paths remain untouched
   - If issues arise, reverting to the pre-optimization checkpoint must fully restore previous behavior

### Core Principles

- **This optimization applies only to Balance Sheet accounts**
- **Income and Expense behavior must remain byte-for-byte unchanged**
- **Excel stability and predictability take priority over aggressive batching**
- **Conservatism is preferred over cleverness**

---

**END OF PLAN**

