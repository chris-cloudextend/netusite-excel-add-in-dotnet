# Period-Based Deduplication Implementation Plan

## Problem
When dragging formulas across columns, multiple batches are created for the same periods (e.g., Jan 2025) with different account lists (13, 20, 10, 11, 21, 12, 16, 19 accounts). This causes:
- 8+ redundant queries for the same period
- Each query taking 93-288 seconds
- Total time: 10x longer than manual entry

## Root Cause
The `gridKey` includes the account list, so as the grid grows (19 → 20 → 21 → 22 accounts), each new account creates a different `gridKey`, triggering a new batch even though the periods are the same.

## Solution: Period-Based Deduplication

### Approach 1: Track Active Period Queries (Recommended)
1. Create `activePeriodQueries` Map: `Map<periodKey, { promise, accounts: Set, periods: Set, filters }>`
2. When a batch wants a period:
   - Check if that period is already being queried (same filters)
   - If yes: Add accounts to the existing query's account set, await the existing promise
   - If no: Create new query, track it in `activePeriodQueries`
3. When query completes: Remove from `activePeriodQueries`, resolve all waiting promises

### Approach 2: Merge Account Lists Before Batch Creation (Simpler)
1. Before creating a batch, check all existing batches for period overlap
2. If overlap found: Merge account lists, update the existing batch's account set
3. Create batch with merged accounts
4. All batches for the same periods share the same query

### Implementation Notes
- Need to modify `executeColumnBasedBSBatch` to accept dynamic account lists
- Need to ensure all waiting cells get results even if they weren't in the original account list
- Need to handle cleanup when batches complete

## Expected Result
- Only 1 query per period (instead of 8+)
- Total time: ~100 seconds (instead of 800+ seconds)
- 8x performance improvement
