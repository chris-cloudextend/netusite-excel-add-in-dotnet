# Status Page Timing Analysis

## Issue Description

When entering a formula for a balance sheet account:
1. ✅ Visual status page appears in task pane (good)
2. ✅ Status page disappears showing success
3. ❌ Takes another 30 seconds for the number to appear in Excel and in console log

## Root Cause Analysis

### Status Broadcast Locations

The status "Complete!" or "Updated X cells" is broadcast from only **2 locations**:

1. **Line 3636** - In build mode when `regularItems.length === 0`:
   ```javascript
   if (regularItems.length === 0) {
       const elapsed = ((Date.now() - batchStartTime) / 1000).toFixed(2);
       broadcastStatus(`Complete!`, 100, 'success');
       return;
   }
   ```
   **Problem:** This fires BEFORE cumulative (balance sheet) requests are processed!

2. **Line 4239** - In `resolvePendingRequests()` (called by taskpane after preload):
   ```javascript
   broadcastStatus(msg, 100, 'success');
   setTimeout(clearStatus, 10000);
   ```

### Promise Resolution Locations

Promises are resolved in `processBatchQueue()` at multiple points:
- **Line 7944**: `request.resolve(balance)` - BS grid batch query
- **Line 8051**: `requests.forEach(r => r.resolve(localStorageValue))` - Preload cache hit
- **Line 8068**: `requests.forEach(r => r.resolve(wildcardResult.total))` - Wildcard cache hit
- **Line 8141**: `requests.forEach(r => r.resolve(total))` - Wildcard API response
- **Line 8192**: `requests.forEach(r => r.resolve(value))` - Regular API response
- **Line 8631**: `request.resolve(activity)` - Period activity response
- **Line 8643**: `request.resolve(value)` - Period activity fallback

### The Problem

**`processBatchQueue()` does NOT broadcast status when it completes!**

Looking at the end of `processBatchQueue()` (lines 8663-8667):
```javascript
const totalBatchTime = ((Date.now() - batchStartTime) / 1000).toFixed(1);
console.log('========================================');
console.log(`✅ BATCH PROCESSING COMPLETE in ${totalBatchTime}s`);
console.log('========================================\n');
// NO broadcastStatus() call here!
```

### What's Happening

1. User enters balance sheet account formula
2. Formula queues request and returns Promise
3. `processBatchQueue()` is called (via timer or build mode)
4. `processBatchQueue()` makes API call
5. API response comes back, promise is resolved immediately (`request.resolve(balance)`)
6. **BUT:** `processBatchQueue()` never broadcasts "Complete!" status
7. The status that shows "Complete!" is from:
   - Build mode (line 3636) - which fires BEFORE cumulative requests are processed
   - OR from `resolvePendingRequests()` - which is called by taskpane after preload
8. Excel cell updates when promise resolves, but there's a delay between:
   - Promise resolution (immediate)
   - Excel recalculating the cell (30 seconds delay)

### The 30-Second Delay

The delay between status showing "Complete!" and value appearing in Excel is likely:

1. **Promise resolves immediately** when API call completes
2. **Status shows "Complete!"** from build mode (line 3636) - but this fires BEFORE cumulative requests are processed
3. **Excel takes time to recalculate** - Excel's custom function runtime may have delays in:
   - Re-evaluating formulas after promise resolution
   - Updating the UI
   - Console logging

OR:

1. **Status shows "Complete!"** from `resolvePendingRequests()` (line 4239)
2. **But `processBatchQueue()` is still running** in the background
3. **Promise resolves 30 seconds later** when `processBatchQueue()` finishes

### Key Finding

**Line 3636 is the culprit:**
```javascript
if (regularItems.length === 0) {
    broadcastStatus(`Complete!`, 100, 'success');
    return;  // Exits BEFORE processing cumulativeRequests!
}
```

This broadcasts "Complete!" and exits BEFORE processing cumulative (balance sheet) requests. So:
- Status shows "Complete!" immediately
- But cumulative requests are still being processed
- Promises resolve 30 seconds later when API calls complete

## Recommended Fix

1. **Remove early exit in build mode** - Don't broadcast "Complete!" until ALL requests (including cumulative) are processed
2. **Add status broadcast to `processBatchQueue()`** - Broadcast "Complete!" at the END of `processBatchQueue()` after all requests are resolved
3. **Track request completion** - Only broadcast "Complete!" when ALL promises are actually resolved

## Code Locations to Review

- **Line 3636**: Early exit in build mode - broadcasts "Complete!" too early
- **Line 8667**: End of `processBatchQueue()` - should broadcast status here
- **Lines 7944-8643**: Promise resolution points - verify all resolve before status shows

## Next Steps

1. Review if build mode early exit (line 3636) should be removed
2. Add status broadcast at end of `processBatchQueue()` (line 8667)
3. Ensure status only shows "Complete!" after ALL promises are resolved
4. Test timing to verify fix

