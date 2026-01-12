# Bug Report: Drag-Right 3+ Columns Resolving Cell-by-Cell

## Issue Summary

When dragging formulas across 3+ columns (e.g., April to December), the system is resolving formulas cell-by-cell instead of using optimized 3-column batching. This results in much slower performance compared to dragging 2 columns.

## Root Cause Analysis

### What's Happening

1. **Individual Preload Triggers**: Each period (Apr, May, Jun, etc.) triggers its own income preload
2. **Sequential Waiting**: Each formula waits for its specific period's preload to complete (up to 120s timeout)
3. **No Batch Processing**: After preloads complete, requests are queued but processed individually instead of as a grid batch
4. **Missing Grid Detection**: The column-based grid detection in `processBatchQueue()` never runs or doesn't detect the pattern

### Evidence from Logs

- **No batch processing logs**: No "COLUMN-BASED PL GRID DETECTED" or "Processing batch" messages
- **Multiple preload waits**: Many "Waiting for income preload to complete" messages for different periods
- **Cache misses**: "Cache miss" followed by "will queue for API call" for each cell
- **No timer firing**: No "Batch timer FIRED" or "processBatchQueue() CALLED" messages

### Why 2 Columns Works

- Fewer requests = timer can fire before 3rd column
- Preloads complete faster (2 periods)
- Some requests resolve from cache
- Batch processing happens before too many requests accumulate

### Why 3+ Columns Fails

- Many requests accumulate rapidly
- Each period triggers its own preload
- Formulas wait for preloads sequentially
- By the time preloads complete, requests are processed individually
- Column-based grid detection doesn't run or doesn't match

## Technical Details

### Current Flow (Broken)

1. User drags Apr-Dec (9 periods × N accounts = many formulas)
2. Each formula evaluates → triggers preload for its period
3. Formula waits for preload (up to 120s)
4. Preload completes → formula checks cache → cache miss
5. Formula queues request
6. Timer fires (smart timer fix works)
7. `processBatchQueue()` runs
8. **BUT**: Column-based grid detection doesn't work because:
   - Requests are already resolved individually, OR
   - Grid detection logic doesn't match the pattern, OR
   - Preloads have already populated cache but formulas still queue

### Expected Flow (Should Work)

1. User drags Apr-Dec (9 periods)
2. First formula triggers preload for Apr
3. Subsequent formulas detect grid pattern BEFORE queuing
4. Skip individual preloads for other periods
5. Batch all requests together
6. Use 3-column batching (3 periods at a time)
7. Process in batches: [Apr,May,Jun], [Jul,Aug,Sep], [Oct,Nov,Dec]

## Proposed Solution

### Option 1: Early Grid Detection (Recommended)

**Concept**: Detect grid pattern BEFORE individual preloads trigger, skip preloads, and batch immediately.

**Implementation**:
1. Before triggering preload in `BALANCE()` function, check `pendingEvaluation.balance` for grid pattern
2. If grid detected (3+ periods, 2+ accounts), skip individual preloads
3. Queue request normally (timer will fire)
4. In `processBatchQueue()`, grid detection should work because all requests are in queue together
5. Use 3-column batching for 3-11 periods

**Pros**:
- Prevents unnecessary preloads
- Ensures grid detection works
- Maintains existing batch processing flow

**Cons**:
- Requires early detection logic
- May need to handle race conditions

### Option 2: Force Grid Processing in processBatchQueue

**Concept**: Ensure column-based grid detection always runs and processes requests as a grid.

**Implementation**:
1. In `processBatchQueue()`, always check for grid pattern first
2. If grid detected, skip individual processing
3. Process as grid batch (3-column batching)
4. Only fall back to individual processing if grid detection fails

**Pros**:
- Simpler - only changes `processBatchQueue()`
- Doesn't affect preload logic

**Cons**:
- Still triggers unnecessary preloads
- May not catch all grid patterns

### Option 3: Hybrid Approach (Best)

**Concept**: Combine early detection with forced grid processing.

**Implementation**:
1. **Early Detection**: Check for grid pattern before preload (skip preloads if grid detected)
2. **Forced Grid Processing**: In `processBatchQueue()`, prioritize grid detection
3. **Fallback**: If grid detection fails, use individual processing

**Pros**:
- Prevents unnecessary preloads
- Ensures grid processing works
- Has fallback for edge cases

**Cons**:
- More complex implementation
- Requires changes in multiple places

## Recommended Solution: Option 3 (Hybrid)

### Implementation Plan

1. **Early Grid Detection in BALANCE()**:
   - Before triggering preload (line ~7742), check `pendingEvaluation.balance`
   - If grid pattern detected (3+ periods, 2+ accounts), set a flag to skip preload
   - Still queue the request normally

2. **Enhanced Grid Detection in processBatchQueue()**:
   - Ensure `detectColumnBasedPLGrid()` always runs for Income Statement requests
   - If grid detected, force use of column-based processing
   - Add logging to debug why grid detection might fail

3. **Preload Skip Logic**:
   - If grid detected early, don't trigger individual preloads
   - Let batch processing handle all periods together

4. **Debug Logging**:
   - Add logs to show when grid is detected early
   - Add logs to show when grid detection runs in processBatchQueue
   - Add logs to show why grid processing might be skipped

## Code Locations

### Files to Modify

1. **`docs/functions.js`**:
   - `BALANCE()` function (around line 7742) - Add early grid detection
   - `processBatchQueue()` function (around line 11158) - Enhance grid detection
   - `detectColumnBasedPLGrid()` function (line 838) - Verify detection logic

### Key Code Sections

See attached code document for specific line numbers and code blocks.

## Testing Plan

1. **Test 2 columns**: Should still work as before
2. **Test 3-11 columns**: Should use 3-column batching with incremental updates
3. **Test 12+ columns**: Should use full-year refresh
4. **Test multiple years**: Should handle year boundaries correctly
5. **Test with preload cache**: Should skip preloads if grid detected

## Success Criteria

- Dragging 3+ columns resolves in batches (3 periods at a time)
- No individual cell-by-cell resolution
- Incremental updates visible to user
- Performance similar to or better than 2-column drag
