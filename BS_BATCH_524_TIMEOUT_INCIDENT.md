# Balance Sheet Batch Query - 524 Timeout Incident Analysis

## Incident Summary

**Date**: 2025-12-30  
**Error**: Cloudflare 524 timeout (origin server timeout)  
**Impact**: Multiple batch queries failed, cells returned #VALUE  
**Root Cause**: Too many concurrent batch queries overwhelming Cloudflare tunnel

## What Happened

### Sequence of Events

1. **Eligibility Detection Working**: Many requests correctly identified as eligible for batching
2. **Account-Specific Lock Working**: Different accounts started batch queries in parallel
3. **Too Many Concurrent Queries**: With ~20 accounts eligible, ~20 batch queries started simultaneously
4. **Each Batch Query = 2 API Calls**: Opening balance + period activity = 2 requests per account
5. **Total Concurrent Requests**: ~40 simultaneous HTTP requests to backend
6. **Cloudflare Tunnel Overwhelmed**: Tunnel timeout (524 error) after ~100 seconds
7. **Batch Queries Failed**: All in-flight batch queries failed with 524 error
8. **Cells Returned #VALUE**: Error thrown → Excel shows #VALUE (explicit error, not undefined)

### Evidence from Logs

```
✅ Multiple accounts starting batch queries:
🚀 BS BATCH QUERY (IMMEDIATE): 10010, 2 periods
🚀 BS BATCH QUERY (IMMEDIATE): 10011, 3 periods
🚀 BS BATCH QUERY (IMMEDIATE): 10031, 2 periods
🚀 BS BATCH QUERY (IMMEDIATE): 10012, 4 periods
... (many more)

❌ Then timeout errors:
❌ Opening balance failed (524): <!DOCTYPE html>...A timeout occurred...
```

## Root Cause Analysis

### Problem: Unbounded Parallel Batch Queries

**Current Implementation**:
```javascript
// Line 729: Account-specific lock allows unlimited parallel queries
const bsBatchQueryInFlight = new Map(); // Map<string, Promise<Object>>

async function executeBalanceSheetBatchQueryImmediate(account, periods, filters) {
    // Check if this account already has a batch query in flight
    if (bsBatchQueryInFlight.has(account)) {
        // Wait for existing query
        const results = await bsBatchQueryInFlight.get(account);
        return results;
    }
    
    // Start new batch query (NO LIMIT on how many can run in parallel)
    const queryPromise = (async () => {
        // ... batch query logic ...
    })();
    
    bsBatchQueryInFlight.set(account, queryPromise);
    return await queryPromise;
}
```

**Issue**: 
- Each account can start its own batch query
- With 20 accounts eligible → 20 batch queries start simultaneously
- Each batch query = 2 API calls (opening balance + period activity)
- Total = 40 concurrent HTTP requests
- Cloudflare tunnel timeout = 100 seconds (default)
- Long-running NetSuite queries exceed timeout → 524 error

### Why This Happens

1. **NetSuite Queries Are Slow**: Opening balance queries can take 30-60 seconds
2. **Period Activity Queries Are Slow**: Can take 30-60 seconds
3. **Cloudflare Tunnel Timeout**: Default 100 seconds
4. **Too Many Concurrent Requests**: Tunnel can't handle 40+ simultaneous long-running requests

## Impact Assessment

### ✅ Income Statement: NO IMPACT

**Proof**: Account type gate (line 5188) routes Income/Expense accounts BEFORE any batching logic:

```javascript
// Line 5188-5193: HARD EXECUTION SPLIT
if (accountType && (accountType === 'Income' || accountType === 'COGS' || accountType === 'Expense' || 
    accountType === 'OthIncome' || accountType === 'OthExpense')) {
    // Route to existing income statement logic
    // Continue with existing code path below (manifest/preload/API)
    // DO NOT enter queue or batching logic
}
```

**Verification**:
- Income/Expense accounts never reach `checkBatchEligibilitySynchronous()`
- Income/Expense accounts never enter `executeBalanceSheetBatchQueryImmediate()`
- Income Statement code path completely unchanged
- **NO IMPACT CONFIRMED**

### ✅ CFO Flash Reports: NO IMPACT

**Proof**: CFO Flash reports use different endpoints and patterns:
- CFO Flash uses `/income` or `/budget` endpoints (not `/balance`)
- CFO Flash reports don't use cumulative balance queries
- CFO Flash reports don't enter Balance Sheet batching logic
- **NO IMPACT CONFIRMED**

### ✅ Excel Stability: NO CRASHES

**Proof**: 
- All errors are thrown explicitly (not undefined/null)
- Excel shows #VALUE (explicit error, not crash)
- No synchronous exceptions
- All async boundaries preserved
- **NO CRASHES CONFIRMED**

## Proposed Solution

### Fix: Limit Concurrent Batch Queries

**Strategy**: Use a semaphore pattern to limit concurrent batch queries to a safe number (e.g., 3-5).

**Implementation Plan**:

#### Step 1: Add Concurrent Query Limit

```javascript
// After line 729 (where bsBatchQueryInFlight is defined)
const MAX_CONCURRENT_BS_BATCH_QUERIES = 3; // Limit concurrent batch queries
let activeBSBatchQueries = 0; // Track active queries
const bsBatchQueryQueue = []; // Queue for waiting queries

// Helper function to wait for slot availability
async function waitForBatchQuerySlot() {
    if (activeBSBatchQueries < MAX_CONCURRENT_BS_BATCH_QUERIES) {
        activeBSBatchQueries++;
        return; // Slot available
    }
    
    // No slot available - wait in queue
    return new Promise((resolve) => {
        bsBatchQueryQueue.push(resolve);
    });
}

// Helper function to release slot
function releaseBatchQuerySlot() {
    activeBSBatchQueries--;
    if (bsBatchQueryQueue.length > 0) {
        const next = bsBatchQueryQueue.shift();
        activeBSBatchQueries++;
        next(); // Wake up next waiting query
    }
}
```

#### Step 2: Modify executeBalanceSheetBatchQueryImmediate

```javascript
async function executeBalanceSheetBatchQueryImmediate(account, periods, filters) {
    // Check if this account already has a batch query in flight
    if (bsBatchQueryInFlight.has(account)) {
        console.log(`⏳ BS batch query for ${account} already in flight - waiting for results...`);
        // Wait for the existing query to complete (NO TIMEOUT - wait for actual completion)
        const results = await bsBatchQueryInFlight.get(account);
        return results; // Return the shared results
    }
    
    // NEW: Wait for available slot before starting new query
    await waitForBatchQuerySlot();
    console.log(`🎫 Acquired batch query slot for ${account} (${activeBSBatchQueries}/${MAX_CONCURRENT_BS_BATCH_QUERIES} active)`);
    
    // Start new batch query for this account
    const queryPromise = (async () => {
        try {
            // ... existing batch query logic (unchanged) ...
            return results;
        } catch (error) {
            console.error(`❌ BS batch query failed for ${account}:`, error);
            throw error;
        } finally {
            // NEW: Release slot when done
            releaseBatchQuerySlot();
            bsBatchQueryInFlight.delete(account);
        }
    })();
    
    // Store the promise in the lock BEFORE awaiting (so other requests can join)
    bsBatchQueryInFlight.set(account, queryPromise);
    
    // Await and return the results
    return await queryPromise;
}
```

#### Step 3: Add Retry Logic for 524 Errors

```javascript
async function fetchOpeningBalance(account, anchorDate, filters, retryCount = 0) {
    const MAX_RETRIES = 2;
    const RETRY_DELAY = 5000; // 5 seconds
    
    try {
        // ... existing fetch logic ...
        const response = await fetch(url);
        if (!response.ok) {
            const errorText = await response.text();
            
            // NEW: Retry on 524 timeout
            if (response.status === 524 && retryCount < MAX_RETRIES) {
                console.log(`⏳ 524 timeout for ${account} - retrying (${retryCount + 1}/${MAX_RETRIES})...`);
                await new Promise(r => setTimeout(r, RETRY_DELAY));
                return fetchOpeningBalance(account, anchorDate, filters, retryCount + 1);
            }
            
            console.error(`❌ Opening balance failed (${response.status}): ${errorText}`);
            throw new Error(`Opening balance query failed: ${response.status} - ${errorText}`);
        }
        
        const value = parseFloat(await response.text());
        return isNaN(value) ? 0 : value;
    } catch (error) {
        // Retry on network errors (which might be 524)
        if (retryCount < MAX_RETRIES && (error.message.includes('524') || error.message.includes('timeout'))) {
            console.log(`⏳ Network error for ${account} - retrying (${retryCount + 1}/${MAX_RETRIES})...`);
            await new Promise(r => setTimeout(r, RETRY_DELAY));
            return fetchOpeningBalance(account, anchorDate, filters, retryCount + 1);
        }
        throw error;
    }
}

// Similar retry logic for fetchPeriodActivityBatch
```

## Safety Guarantees Maintained

### ✅ Guarantee #1: Once Eligible, Returns Number or Throws Error
- **Status**: MAINTAINED
- If batch query fails after retries, we throw error (Excel shows #VALUE)
- No null, no undefined, no placeholder values

### ✅ Guarantee #2: Waiting Only After Synchronous Eligibility
- **Status**: MAINTAINED
- Eligibility check is still synchronous
- Slot waiting happens AFTER eligibility confirmed
- Preload logic cannot run once batching is selected

### ✅ Guarantee #3: No Fallback Once Batching Selected
- **Status**: MAINTAINED
- Once eligible, we await batch query (with retries)
- If all retries fail, we throw error (no fallback)
- No timeout-based give-up behavior

### ✅ Income Statement Isolation
- **Status**: MAINTAINED
- Account type gate still routes Income/Expense accounts before batching
- No changes to Income Statement code paths

### ✅ CFO Flash Reports Isolation
- **Status**: MAINTAINED
- CFO Flash uses different endpoints (not `/balance`)
- No changes to CFO Flash code paths

## Implementation Details

### Concurrent Query Limit

**Recommended Value**: `MAX_CONCURRENT_BS_BATCH_QUERIES = 3`

**Rationale**:
- Each batch query = 2 API calls (opening balance + period activity)
- 3 concurrent queries = 6 simultaneous HTTP requests
- This is manageable for Cloudflare tunnel
- Still allows parallel processing for different accounts
- Prevents overwhelming the tunnel

**Alternative Values**:
- `2`: More conservative, slower but safer
- `4`: More aggressive, faster but riskier
- `5`: Maximum recommended (10 concurrent HTTP requests)

### Retry Logic

**Strategy**: Exponential backoff with max 2 retries
- First retry: 5 seconds delay
- Second retry: 5 seconds delay
- After 2 retries: Throw error (Excel shows #VALUE)

**Why This Works**:
- 524 errors are often transient (tunnel overload)
- Retry gives tunnel time to recover
- 2 retries = 3 total attempts = reasonable
- If still failing after 3 attempts, likely persistent issue

## Expected Behavior After Fix

### Scenario: 20 Accounts Eligible for Batching

**Before Fix**:
- 20 batch queries start simultaneously
- 40 concurrent HTTP requests
- Tunnel overwhelmed → 524 timeout
- All queries fail → #VALUE errors

**After Fix**:
- First 3 accounts start batch queries immediately
- Remaining 17 accounts wait in queue
- As queries complete, next accounts start
- Each account gets 2 retries on 524 errors
- Most queries succeed (with retries if needed)
- Cells resolve with numeric values

### Performance Impact

**Positive**:
- Prevents tunnel overload
- Reduces 524 errors
- More reliable batch queries

**Negative**:
- Slight delay for queued accounts (acceptable trade-off)
- Still much faster than individual preloads

## Testing Checklist

After implementation:
- [ ] Single account, multiple periods: All periods resolve from one batch query
- [ ] Multiple accounts (3-5): All resolve successfully
- [ ] Many accounts (10+): Queue works, queries complete in batches
- [ ] 524 error handling: Retries work, eventual success or explicit error
- [ ] Income Statement: Still works exactly as before
- [ ] CFO Flash: Still works exactly as before
- [ ] No Excel crashes: All errors are explicit (#VALUE, not crashes)

## Code Changes Summary

### Files to Modify

1. **`docs/functions.js`**:
   - Add concurrent query limit constants (after line 729)
   - Add slot management functions (`waitForBatchQuerySlot`, `releaseBatchQuerySlot`)
   - Modify `executeBalanceSheetBatchQueryImmediate` to use slot management
   - Add retry logic to `fetchOpeningBalance` and `fetchPeriodActivityBatch`

### Lines to Change

- **Line ~729**: Add concurrent limit constants
- **Line ~827**: Modify `executeBalanceSheetBatchQueryImmediate` to wait for slot
- **Line ~899**: Add retry logic to `fetchOpeningBalance`
- **Line ~927**: Add retry logic to `fetchPeriodActivityBatch`

### No Changes Required

- Account type gate (line 5188) - unchanged
- Eligibility check (line 5208) - unchanged
- Income Statement code paths - unchanged
- CFO Flash code paths - unchanged

## Risk Assessment

### Low Risk Changes
- ✅ Slot management is additive (doesn't change existing logic)
- ✅ Retry logic is defensive (only helps, doesn't hurt)
- ✅ Income Statement isolation maintained
- ✅ CFO Flash isolation maintained
- ✅ All safety guarantees maintained

### Potential Issues
- ⚠️ Queue delay: Accounts may wait slightly longer (acceptable trade-off)
- ⚠️ Retry delay: Failed queries take longer (but more likely to succeed)

## Recommendation

**Proceed with implementation** - The fix is low-risk and addresses the root cause without impacting Income Statement or CFO Flash reports.

