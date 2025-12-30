# Balance Sheet Batch Query Failure Analysis

## Problem Summary

The synchronous batch eligibility detection is **working correctly** - requests are being identified as eligible for batching. However, **all batch queries are failing** and falling back to the preload path, resulting in the same slow performance as before.

## Evidence from Logs

### ✅ What's Working

1. **Eligibility Detection**: Many requests are correctly identified as eligible:
   ```
   🔍 BATCH CHECK: 10010/Feb 2025 - checking 0 queued + 22 evaluating = 22 total requests
   🔍 BATCH CHECK: ✅ ELIGIBLE - 10010, 2 periods: Jan 2025, Feb 2025
   🎯 BS BATCH ELIGIBLE: 10010, 2 periods
   ```

2. **Batch Query Initiation**: The first query starts correctly:
   ```
   🚀 BS BATCH QUERY (IMMEDIATE): 10010, 2 periods, anchor: 2024-12-31
   📊 Query 1: Opening balance as of 2024-12-31
   🔍 Opening balance URL: https://netsuite-proxy.chris-corcoran.workers.dev/balance?account=10010&anchor_date=2024-12-31
   ```

### ❌ What's Failing

1. **Concurrent Execution Problem**: Multiple requests try to execute batch queries simultaneously:
   - First request (10010/Feb 2025) starts batch query
   - Second request (10011/Mar 2025) sees "batch query already in flight" and waits
   - Third request (10010/Mar 2025) also sees "already in flight" and waits
   - **All subsequent requests** see "already in flight" and wait

2. **Wait Logic Too Brief**: The wait in `executeBalanceSheetBatchQueryImmediate` is only 100ms:
   ```javascript
   if (bsBatchQueryInFlight) {
       console.log('⏳ BS batch query already in flight - waiting briefly...');
       await new Promise(r => setTimeout(r, 100));
       if (bsBatchQueryInFlight) {
           return null; // Fall back to individual requests
       }
   }
   ```
   After 100ms, if the query is still in flight, it returns `null`, causing the fallback.

3. **All Queries Fail**: Every single eligible request eventually shows:
   ```
   ⚠️ BS batch query failed - falling back to existing path
   ```

## Root Cause Analysis

### Issue #1: Race Condition in Concurrent Batch Execution

**Problem**: When Excel evaluates a grid of formulas (e.g., dragging across 5 months × 20 accounts = 100 formulas), all formulas are evaluated in the same wave. Each formula:
1. Checks eligibility → finds other evaluating requests → eligible!
2. Tries to execute batch query immediately
3. But they're all trying to execute **at the same time**

**Current Behavior**:
- Request 1 (10010/Feb): Starts batch query, sets `bsBatchQueryInFlight = true`
- Request 2 (10011/Mar): Sees `bsBatchQueryInFlight = true`, waits 100ms, still in flight → returns `null` → fails
- Request 3 (10010/Mar): Same issue
- Request 4-N: All fail the same way

**Why This Happens**: The `bsBatchQueryInFlight` lock is designed to prevent **multiple different batch queries** from running simultaneously. But in a grid scenario, we have:
- **Multiple accounts** (10010, 10011, 10012, etc.)
- **Each account** needs its own batch query (different account = different query)
- But they're all trying to execute at the same time
- The lock prevents them all, so only the first one (maybe) succeeds, and all others fail

### Issue #2: Single-Flight Lock is Too Restrictive

**Problem**: The `bsBatchQueryInFlight` flag is a **global lock** that prevents ANY batch query from running if another is in flight. This is correct for preventing resource exhaustion, but it's causing legitimate batch queries to fail.

**Current Logic**:
```javascript
if (bsBatchQueryInFlight) {
    // Wait 100ms
    if (bsBatchQueryInFlight) {
        return null; // Give up
    }
}
```

**Why This Fails**: 
- Batch queries can take 5-10 seconds (opening balance + period activity)
- 100ms wait is nowhere near enough
- After 100ms, the function gives up and returns `null`
- This causes the fallback path, which defeats the entire purpose

### Issue #3: No Coordination Between Concurrent Requests

**Problem**: When multiple requests for the **same account** are eligible (e.g., 10010/Jan, 10010/Feb, 10010/Mar), they should:
1. **First request** executes the batch query for all periods
2. **Subsequent requests** wait for the batch query to complete
3. **All requests** get their results from the same batch query

But the current implementation doesn't coordinate this. Each request tries to execute its own batch query independently.

## Proposed Fixes

### Fix #1: Account-Specific Batch Query Lock

**Change**: Instead of a global `bsBatchQueryInFlight` flag, use an account-specific lock:

```javascript
const bsBatchQueryInFlight = new Map(); // Map<account, Promise<results>>

async function executeBalanceSheetBatchQueryImmediate(account, periods, filters) {
    // Check if this account already has a batch query in flight
    if (bsBatchQueryInFlight.has(account)) {
        console.log(`⏳ BS batch query for ${account} already in flight - waiting for results...`);
        // Wait for the existing query to complete
        const results = await bsBatchQueryInFlight.get(account);
        return results; // Return the shared results
    }
    
    // Start new batch query
    const queryPromise = (async () => {
        bsBatchQueryInFlight.set(account, queryPromise);
        try {
            // ... existing batch query logic ...
            return results;
        } finally {
            bsBatchQueryInFlight.delete(account);
        }
    })();
    
    return await queryPromise;
}
```

**Benefits**:
- Different accounts can batch in parallel (10010, 10011, etc.)
- Same account requests share the same batch query
- No artificial 100ms timeout - requests wait for actual completion

### Fix #2: Remove 100ms Timeout, Wait for Actual Completion

**Change**: Instead of waiting 100ms and giving up, wait for the actual batch query to complete:

```javascript
if (bsBatchQueryInFlight.has(account)) {
    // Wait for the existing query to complete (no timeout)
    const results = await bsBatchQueryInFlight.get(account);
    return results;
}
```

**Benefits**:
- Requests don't give up prematurely
- All requests for the same account get results from the same batch query
- No wasted network calls

### Fix #3: Add Error Handling and Logging

**Change**: Add detailed error logging to understand why batch queries fail:

```javascript
try {
    const batchResults = await executeBalanceSheetBatchQueryImmediate(...);
    if (batchResults) {
        // Success
    } else {
        console.error(`❌ BS batch query returned null for ${account}`);
        // Fall back
    }
} catch (error) {
    console.error(`❌ BS batch query error for ${account}:`, error);
    // Fall back
}
```

**Benefits**:
- Better visibility into why queries fail
- Can identify network errors, timeout errors, etc.

## Implementation Priority

1. **High Priority**: Fix #1 (Account-specific lock) - This is the core issue
2. **High Priority**: Fix #2 (Remove timeout) - This prevents premature failures
3. **Medium Priority**: Fix #3 (Error logging) - This helps diagnose remaining issues

## Expected Behavior After Fixes

1. **First request for account 10010** (e.g., 10010/Feb):
   - Detects eligibility (2+ periods)
   - Starts batch query
   - Sets account-specific lock

2. **Subsequent requests for account 10010** (e.g., 10010/Mar, 10010/Apr):
   - Detect eligibility
   - See batch query in flight for 10010
   - **Wait for the batch query to complete** (not just 100ms)
   - Get results from the shared batch query

3. **Requests for different accounts** (e.g., 10011/Mar):
   - Can execute their own batch query in parallel
   - Don't block each other

4. **Result**: 
   - One batch query per account
   - All requests for the same account share results
   - Fast, efficient execution
   - No fallback to preload path

## Testing Checklist

After implementing fixes:
- [ ] Single account, multiple periods: All periods resolve from one batch query
- [ ] Multiple accounts, multiple periods: Each account gets its own batch query
- [ ] No "batch query failed" warnings
- [ ] No fallback to preload path for eligible requests
- [ ] Results are correct (match individual queries)

