# Status Window Timing Issue - Analysis

## Problem
Status window closes, but Excel cells don't update for 30 seconds. The console shows `processBatchQueue()` completes in 0.1s, but Excel takes 30 seconds to actually update cells.

## Root Cause
1. **Promises resolve immediately** when cache hits are found (line 8057: `requests.forEach(r => r.resolve(localStorageValue))`)
2. **processBatchQueue() completes** in 0.1s (all promises resolved)
3. **Excel takes 30 seconds** to process resolved promises and update cells
4. **We cannot detect** when Excel has finished processing - Excel's custom function API doesn't provide a callback

## What Triggers Status Window?

The status window is likely coming from:
1. **Build Mode** (`runBuildModeBatch`) - line 3299 broadcasts "Processing X formulas..."
2. **Taskpane** - shows status for preload operations
3. **NOT from processBatchQueue()** - we've removed status broadcast from here

## The Real Issue

The user is right: **"If the job is truly complete, then maybe the delay is in writing the completed data to Excel?"**

Yes! The job IS complete (all promises resolved), but Excel takes time to:
- Process resolved promises
- Re-evaluate cells
- Update the UI

We cannot detect when Excel has finished this process.

## Solution Applied

**Removed status broadcast from processBatchQueue()** because:
1. We can't detect when Excel has processed resolved promises
2. Promises resolve immediately (0.1s), but Excel takes 30+ seconds
3. Showing status before Excel updates would be misleading
4. Status should only come from build mode (multiple formulas) or taskpane (preload)

## Remaining Issue

If status is coming from build mode, we need to ensure build mode doesn't show "Complete!" until Excel has actually updated. But we can't detect that.

**Possible solutions:**
1. Remove status from build mode for cache hits (only show for API calls)
2. Increase the delay in build mode status (but that's still guessing)
3. Don't show status at all for fast operations (cache hits)

## Next Steps

Need to identify:
1. Where exactly is the status window coming from? (build mode? taskpane?)
2. Can we detect when Excel has processed promises? (probably not)
3. Should we remove status entirely for cache hits? (maybe)

---
**Analysis Date:** December 31, 2025
