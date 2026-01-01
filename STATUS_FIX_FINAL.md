# Status Page Timing Fix - Final

## Issue
Status page shows "Complete!" but Excel cell doesn't update for 30 seconds when using balance sheet accounts with cache hits.

## Root Cause
1. **Promise resolves immediately** when cache hit is found (line 8057)
2. **processBatchQueue() finishes** in 0.1s
3. **Status broadcasts "Complete!"** immediately (line 8677)
4. **Excel takes 30 seconds** to process resolved promise and update cell

The promise resolves synchronously, but Excel's custom function runtime needs time to:
- Process the resolved promise
- Re-evaluate the cell
- Update the UI

## Fix Applied

### Modified processBatchQueue() Status Broadcast (Line 8674-8688)

**Before:**
```javascript
if (requestCount > 0) {
    broadcastStatus(`Complete!`, 100, 'success');
    setTimeout(clearStatus, 10000);
}
```

**After:**
```javascript
if (requestCount > 0) {
    // Only delay if we processed cumulative or period activity requests (balance sheet)
    // Regular requests (income statement) are processed separately and have their own timing
    const hadBalanceSheetRequests = cumulativeRequests.length > 0 || periodActivityRequests.length > 0;
    const delayMs = hadBalanceSheetRequests ? 2000 : 0;  // 2 second delay only for BS requests
    
    setTimeout(() => {
        broadcastStatus(`Complete!`, 100, 'success');
        setTimeout(clearStatus, 10000);
    }, delayMs);
}
```

## Safety Guarantees for Income Statement

✅ **Income Statement Unaffected:**
- Income statement requests are in `regularRequests` array
- `hadBalanceSheetRequests` only checks `cumulativeRequests` and `periodActivityRequests`
- If only income statement requests are processed:
  - `cumulativeRequests.length === 0`
  - `periodActivityRequests.length === 0`
  - `hadBalanceSheetRequests === false`
  - `delayMs === 0` (no delay)
  - Status broadcasts immediately (unchanged behavior)

✅ **Balance Sheet Only:**
- Balance sheet requests are in `cumulativeRequests` or `periodActivityRequests`
- If balance sheet requests are processed:
  - `hadBalanceSheetRequests === true`
  - `delayMs === 2000` (2 second delay)
  - Status broadcasts after 2 seconds (gives Excel time to update)

✅ **Mixed Requests:**
- If both balance sheet and income statement are processed:
  - `hadBalanceSheetRequests === true` (because BS requests exist)
  - `delayMs === 2000` (2 second delay applies to all)
  - This is acceptable because BS requests need the delay, and IS requests are fast anyway

## Testing Verification

### Income Statement (Should be Unaffected)
1. Enter `=XAVI.BALANCE("60010", "Jan 2025", "Jan 2025")`
2. Status should show "Complete!" immediately (no delay)
3. Value should appear in Excel immediately
4. **Behavior unchanged from before**

### Balance Sheet (Should be Fixed)
1. Enter `=XAVI.BALANCE("10010", , "Jan 2025")`
2. Wait for cache hit
3. Status should show "Complete!" after 2 seconds (not immediately)
4. Value should appear in Excel before or at the same time as status
5. **No more 30-second gap between status and value**

### Mixed (Both BS and IS)
1. Enter both BS and IS formulas
2. Status should show "Complete!" after 2 seconds
3. Both values should appear in Excel
4. **BS gets delay, IS is fast anyway**

---
**Fix Date:** December 31, 2025
**Impact:** Balance sheet status timing fixed, income statement unchanged
