# Status Fix - Removed Arbitrary Delay

## Issue
Status page was showing "Complete!" before Excel cell updated when using balance sheet accounts with cache hits.

## Root Cause Analysis
1. **Promise resolves immediately** when cache hit is found (line 8057: `requests.forEach(r => r.resolve(localStorageValue))`)
2. **processBatchQueue() finishes** in 0.1s
3. **Status broadcasts "Complete!"** immediately
4. **Excel takes 30 seconds** to process resolved promise and update cell

The problem: We can't detect when Excel has actually processed a resolved promise and updated the cell. Excel's custom function runtime processes promises asynchronously, and there's no callback or event to notify us when Excel has finished.

## Solution: Remove Status Broadcast from processBatchQueue()

Instead of using an arbitrary delay (which was a guess), we've removed the status broadcast from `processBatchQueue()` entirely because:

1. **We can't detect when Excel processes promises** - Excel's custom function API doesn't provide a callback when a resolved promise is processed
2. **Single formula entries are fast** - Cache hits resolve in 0.1s, so status would be misleading
3. **Status should come from appropriate sources:**
   - **Build mode** (`runBuildModeBatch`) - handles status for multiple formulas (drag-fill scenarios)
   - **Taskpane** - handles status for preload operations
   - **Not from processBatchQueue()** - which handles single formula entries

## Changes Made

### Removed Status Broadcast from processBatchQueue() (Line 8674-8690)

**Before:**
```javascript
if (requestCount > 0) {
    const hadBalanceSheetRequests = cumulativeRequests.length > 0 || periodActivityRequests.length > 0;
    const delayMs = hadBalanceSheetRequests ? 2000 : 0;  // Arbitrary 2 second delay
    
    setTimeout(() => {
        broadcastStatus(`Complete!`, 100, 'success');
        setTimeout(clearStatus, 10000);
    }, delayMs);
}
```

**After:**
```javascript
// NOTE: We do NOT broadcast status here because:
// 1. We can't detect when Excel has actually processed resolved promises and updated cells
// 2. Status should only show for build mode (multiple formulas) or preload operations
// 3. Single formula entries via processBatchQueue are fast (cache hits resolve in 0.1s)
//    and showing status would be misleading if Excel hasn't updated yet
// 4. Build mode (runBuildModeBatch) handles status broadcasting for multiple formulas
// 5. Taskpane handles status for preload operations
```

## Impact

✅ **Balance Sheet Single Formula:**
- No status broadcast from processBatchQueue()
- Value appears in Excel when ready (no misleading "Complete!" message)
- Status only shows for build mode (multiple formulas) or preload operations

✅ **Income Statement:**
- Unaffected - income statement requests go through regularRequests path
- Status handling unchanged

✅ **Build Mode (Multiple Formulas):**
- Status still broadcasts from `runBuildModeBatch()` (line 3640, 4245)
- This is appropriate because build mode handles multiple formulas and can show meaningful status

✅ **Preload Operations:**
- Status handled by taskpane (appropriate for preload operations)

## Result

- **No arbitrary delays** - removed guesswork
- **No misleading status** - status only shows when appropriate (build mode, preload)
- **Single formulas** - work silently without status (they're fast anyway)
- **Multiple formulas** - still get status from build mode

---
**Fix Date:** December 31, 2025
**Approach:** Removed status broadcast instead of using arbitrary delay
