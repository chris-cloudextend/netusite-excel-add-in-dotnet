# Balance Sheet Batch Performance Analysis

## Problem Statement

When dragging balance sheet formulas across 12 columns (Jan-Dec) with ~100 rows:
- **Expected**: 1-3 columns batched at a time, ~70 seconds per column = 11-13 minutes total
- **Actual**: Taking much longer, individual queries being sent instead of batch queries

## Current Implementation Analysis

### 1. Column-Based Batching Logic (Frontend)

**Location**: `docs/functions.js` lines 6487-6553

**How it works**:
- `USE_COLUMN_BASED_BS_BATCHING = true` (enabled)
- When a BALANCE formula is evaluated, it checks `pendingEvaluation.balance` for other pending requests
- Calls `detectColumnBasedBSGrid()` to detect if there's a grid pattern
- If eligible, calls `executeColumnBasedBSBatch()` which sends ALL accounts and ALL periods to `/batch/bs_preload_targeted`

**Issue**: The detection happens **per-cell evaluation**, meaning:
- Excel evaluates formulas one at a time
- By the time the second formula is evaluated, the first might have already been sent as an individual query
- The batch detection only sees formulas that are currently in `pendingEvaluation.balance`

### 2. Backend Batch Endpoint

**Location**: `backend-dotnet/Controllers/BalanceController.cs` lines 1140-1341

**How it works**:
- `/batch/bs_preload_targeted` receives: `{accounts: [...], periods: [...], filters: {...}}`
- Processes periods **sequentially** in a foreach loop (line 1195)
- Each period query takes ~70 seconds
- For 12 periods × 100 accounts = 12 queries × ~70s = **~14 minutes minimum**

**Current behavior**:
```csharp
foreach (var periodName in request.Periods) {
    // Query all accounts for this period
    // Takes ~70 seconds per period
    // Processes sequentially, not in parallel
}
```

### 3. What's Actually Happening (From Logs)

The logs show:
- Individual `/balance` queries for each account/period combination
- Cache MISS for each one
- No evidence of batch queries being sent

**Root cause**: The column-based batching detection is not triggering because:
1. Excel evaluates formulas one at a time
2. By the time a formula is evaluated, previous formulas may have already been sent
3. The `pendingEvaluation.balance` queue might not have enough formulas at the right time
4. The batch detection only runs when a formula is evaluated, not proactively

## Performance Impact

### Current (Individual Queries)
- 100 accounts × 12 periods = 1,200 individual queries
- Each query: ~70 seconds
- **Total: 1,200 × 70s = 84,000 seconds = 23+ hours** (if sequential)
- With some parallelism: Still hours

### Expected (Batch Queries)
- 12 batch queries (one per period)
- Each batch: ~70 seconds
- **Total: 12 × 70s = 840 seconds = 14 minutes**

### Actual (What's happening)
- Mix of individual and batch queries
- Some batching occurs, but not consistently
- Takes much longer than 14 minutes

## Proposed Solution: Proactive Batch Detection

### Strategy 1: Defer Individual Queries for Balance Sheet Accounts

**Approach**: When a balance sheet formula is evaluated:
1. Check if there are other pending balance sheet formulas in the queue
2. If yes, **defer** the individual query and wait for batch detection
3. Use a timer-based batch processor that:
   - Waits 500ms-1s for more formulas to accumulate
   - Detects grid patterns across all pending requests
   - Executes batch queries for detected grids
   - Falls back to individual queries if no grid detected

**Implementation Plan**:

1. **Modify `BALANCE()` function** (`docs/functions.js` ~line 5983):
   - For balance sheet accounts, check `pendingEvaluation.balance` size
   - If > threshold (e.g., 10 requests), defer individual query
   - Add to pending queue and trigger batch processor

2. **Enhance batch processor** (`docs/functions.js` `processBatchQueue()`):
   - Group balance sheet requests separately
   - Detect column-based grids across all pending BS requests
   - Execute batch queries in chunks (1-3 periods at a time)
   - Update cache and resolve promises

3. **Backend optimization** (`backend-dotnet/Controllers/BalanceController.cs`):
   - Keep current sequential processing (it's correct)
   - Add logging to show batch vs individual query ratio

### Strategy 2: Column-Based Chunking (Recommended)

**Approach**: Process periods in chunks of 1-3 at a time, updating cells as each chunk completes.

**Benefits**:
- User sees progress (cells update incrementally)
- Reduces timeout risk (smaller batches)
- Better user experience

**Implementation Plan**:

1. **Frontend**: Modify `executeColumnBasedBSBatch()`:
   ```javascript
   async function executeColumnBasedBSBatch(grid) {
       const { allAccounts, columns, filters } = grid;
       const accounts = Array.from(allAccounts);
       const periods = columns.map(col => col.period).sort(...);
       
       // Process in chunks of 2-3 periods
       const CHUNK_SIZE = 2;
       const results = {};
       
       for (let i = 0; i < periods.length; i += CHUNK_SIZE) {
           const chunk = periods.slice(i, i + CHUNK_SIZE);
           
           // Query this chunk
           const chunkResults = await fetchBSBatchChunk(accounts, chunk, filters);
           
           // Merge results
           Object.assign(results, chunkResults);
           
           // Update cache and resolve promises for this chunk
           updateCacheAndResolve(chunkResults, accounts, chunk);
       }
       
       return results;
   }
   ```

2. **Backend**: Keep `/batch/bs_preload_targeted` as-is (it already handles multiple periods)

3. **Cache Updates**: After each chunk:
   - Update cache with results
   - Resolve promises for completed cells
   - Cells update in Excel incrementally

### Strategy 3: Parallel Period Processing (Backend)

**Approach**: Process multiple periods in parallel on the backend.

**Benefits**:
- Faster overall execution
- Still maintains correctness

**Implementation Plan**:

1. **Backend**: Modify `PreloadBalanceSheetTargeted()`:
   ```csharp
   // Process periods in parallel (limit concurrency)
   const int MAX_CONCURRENT_PERIODS = 3;
   var semaphore = new SemaphoreSlim(MAX_CONCURRENT_PERIODS);
   
   var periodTasks = request.Periods.Select(async periodName => {
       await semaphore.WaitAsync();
       try {
           // Query this period
           return await QueryPeriod(periodName, ...);
       } finally {
           semaphore.Release();
       }
   });
   
   var periodResults = await Task.WhenAll(periodTasks);
   ```

2. **Considerations**:
   - NetSuite governor limits concurrency (currently max 3)
   - Need to coordinate with governor to avoid overload
   - May need to adjust governor limits for batch operations

## Recommended Approach: Hybrid Strategy

Combine **Strategy 1** (defer individual queries) + **Strategy 2** (chunked processing):

1. **Defer individual queries** for balance sheet accounts when batch is likely
2. **Process in chunks** of 2-3 periods at a time
3. **Update cache incrementally** so users see progress
4. **Fall back to individual queries** if batch detection fails

## Implementation Steps

### Phase 1: Defer Individual Queries
1. Modify `BALANCE()` to defer BS queries when queue size > threshold
2. Add batch detection timer (500ms-1s delay)
3. Test with small grid (5 accounts × 3 periods)

### Phase 2: Chunked Processing
1. Modify `executeColumnBasedBSBatch()` to process in chunks
2. Add cache update logic after each chunk
3. Test with full grid (100 accounts × 12 periods)

### Phase 3: Optimization
1. Tune chunk size based on performance
2. Add progress indicators
3. Monitor batch vs individual query ratio

## Expected Performance

### After Fix
- **Batch queries**: 12 periods ÷ 2 (chunk size) = 6 batch requests
- **Each batch**: 2 periods × ~70s = ~140s per batch
- **Total**: 6 × 140s = 840s = **14 minutes** (matches expectation)
- **User experience**: Cells update every ~2 minutes as chunks complete

## Testing Plan

1. **Small grid**: 10 accounts × 3 periods
   - Verify batch detection works
   - Verify chunks process correctly
   - Verify cache updates incrementally

2. **Medium grid**: 50 accounts × 6 periods
   - Verify performance improvement
   - Verify no timeouts

3. **Large grid**: 100 accounts × 12 periods
   - Verify completes in ~14 minutes
   - Verify all cells update correctly
   - Verify cache is populated

## Monitoring

Add logging to track:
- Batch detection rate (how often batches are detected)
- Chunk processing time
- Individual vs batch query ratio
- Cache hit rate after batch completion
