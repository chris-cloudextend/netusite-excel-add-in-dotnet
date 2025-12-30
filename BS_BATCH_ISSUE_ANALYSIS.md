# Balance Sheet Batch Query - Current Issue Analysis

## Problem: Still in Slow Mode

**Console Output Analysis**: The logs show the system is still using the OLD slow per-period preload path instead of the new batch query path.

### Evidence from Console Logs:
```
📭 Cache miss: 10010/Mar 2025
🔄 BS account: Period Mar 2025 not in manifest - triggering preload before queuing API calls
⏳ Waiting for preload to start/complete (max 120s)...
```

**This is the OLD behavior** - each period triggers individual preload, then waits 120 seconds.

### Expected Behavior (Batch Mode):
```
🎯 BS GRID PATTERN DETECTED: 10010, 4 periods
🚀 BS BATCH QUERY: 10010, 4 periods, anchor: 2025-01-31
✅ BS BATCH QUERY COMPLETE: 4 period results
```

## Root Cause

**The preload logic runs BEFORE requests are queued**, preventing batch detection from ever running.

### Code Flow (Current - BROKEN):
1. `BALANCE()` function called
2. Cache check (miss)
3. **Manifest check** (line 5477-5493)
4. **Trigger preload** (line 5484-5489)
5. **WAIT for preload** (line 5513-5514) - **BLOCKS FOR 120 SECONDS**
6. Only AFTER waiting → Queue request (line 5655)
7. Batch detection runs (line 6663) - **BUT TOO LATE!**

### The Problem:
- Batch detection happens in `processBatchQueue()` (line 6663)
- But requests don't reach the queue until AFTER preload wait completes
- So batch detection never sees the grid pattern in time
- Each request waits individually for preload, then gets processed individually

## Solution

**Skip preload wait when we detect a potential grid scenario.**

### Approach 1: Queue First, Detect Pattern, Skip Preload
- Queue requests immediately (don't wait for preload)
- Let batch detection run quickly
- If pattern detected → skip preload, use batch query
- If no pattern → fall back to preload logic

### Approach 2: Early Grid Detection
- Detect grid pattern BEFORE queuing
- If grid detected → skip preload entirely
- Queue requests immediately for batch processing

### Recommended: Approach 1 (Simpler, Less Risky)
- Change: Remove preload wait for BS accounts when requests are queued quickly
- Add: Check if multiple requests queued within short time window
- If yes → skip preload wait, let batch detection handle it

## Code Changes Needed

### File: `docs/functions.js`

**Location**: Around line 5509-5562 (preload wait logic)

**Current Code**:
```javascript
if (isBSAccount && !isPeriodActivity) {
    // Wait for preload with bounded timeout (120s max)
    const maxWait = 120000;
    console.log(`⏳ Waiting for preload to start/complete (max ${maxWait/1000}s)...`);
    const waited = await waitForPeriodCompletion(filtersHash, periodKey, maxWait);
    // ... rest of wait logic
}
```

**Proposed Change**:
```javascript
if (isBSAccount && !isPeriodActivity) {
    // CHECK: Are multiple BS requests queued quickly? (potential grid scenario)
    // If yes, skip preload wait and let batch detection handle it
    const recentBSRequests = getRecentBSRequests(5000); // Last 5 seconds
    if (recentBSRequests.length >= 2) {
        console.log(`🎯 Potential grid detected (${recentBSRequests.length} recent BS requests) - skipping preload wait, using batch path`);
        // Skip preload wait, proceed to queue immediately
    } else {
        // Normal path: wait for preload
        const maxWait = 120000;
        console.log(`⏳ Waiting for preload to start/complete (max ${maxWait/1000}s)...`);
        const waited = await waitForPeriodCompletion(filtersHash, periodKey, maxWait);
        // ... rest of wait logic
    }
}
```

**Alternative (Simpler)**: Just reduce/remove the preload wait for BS accounts when multiple periods are involved. The batch detection will handle it.

## Backend Status

**Backend is working correctly** - no issues found:
- ✅ Accepts `anchor_date` parameter
- ✅ Returns opening balance correctly
- ✅ Supports `batch_mode` and `include_period_breakdown`
- ✅ Server is running and healthy

**The issue is 100% frontend** - preload logic is blocking batch detection.

## Next Steps

1. **Immediate Fix**: Skip or reduce preload wait when multiple BS requests are queued quickly
2. **Test**: Verify batch detection triggers correctly
3. **Verify**: Check that no individual queries are made (server logs)
4. **Measure**: Performance should improve from 70+ seconds to ~30 seconds

