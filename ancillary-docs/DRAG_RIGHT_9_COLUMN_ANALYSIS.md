# Analysis: 9-Column Drag-Right Performance Issue

## Problem Summary

User dragged 9 columns (Apr-Dec) and reports it's resolving row-by-row slowly, despite the 3-column batching approach being implemented.

## Key Findings from Logs

### What's Working
1. ✅ **Grid detection is working**: Logs show `GRID MODE DETECTED: 12 periods × 226 accounts`
2. ✅ **Preload wait is being skipped**: Logs show `⏭️ Skipping preload wait - batch queue will use 3-column batching`
3. ✅ **Requests are queuing together**: Queue size grows to 900+ requests

### The Problem
**Grid detection sees 12 periods, not 9**

The logs show:
```
📊 GRID MODE DETECTED: 12 periods × 226 accounts
```

But the user dragged only **9 columns (Apr-Dec)**. This means:
- Grid detection is counting **all periods in the sheet** (likely Jan-Dec), not just the dragged columns
- With 12 periods detected, the code uses **full-year refresh** (line 11281), not 3-column batching
- Full-year refresh shows **no incremental updates** - all data appears at once after the query completes

### Current Logic Flow

```javascript
// Line 11281-11292: If 12+ periods detected
if (yearCount === 1 && periodsInLargestYear >= 12) {
    // Uses full_year_refresh - single query, no incremental updates
    useFullYearRefreshPatternFinal = true;
}
// Line 11293-11297: If 3-11 periods detected  
else if (yearCount === 1 && periodsInLargestYear >= 3 && periodsInLargestYear <= 11) {
    // Uses 3-column batching - incremental updates
    useColumnBasedPLGrid = true;
}
```

### Why Full-Year Refresh Feels Slow

1. **No visual feedback**: User sees nothing for 10-15 seconds while the query runs
2. **All data appears at once**: After the query completes, all cells update simultaneously
3. **Perceived slowness**: Even though it's faster overall, the lack of incremental updates makes it feel slower

### Why 3-Column Batching Would Be Better

1. **Incremental updates**: User sees data appearing in batches (3 columns at a time)
2. **Better UX**: Provides visual feedback that work is happening
3. **Faster perceived performance**: Even if total time is slightly longer, it feels faster

## Root Cause

The grid detection in `processBatchQueue()` counts **all periods in pendingEvaluation**, not just the periods being dragged. If the sheet has formulas for Jan-Mar already (or they're in pendingEvaluation), the detection sees 12 periods total and switches to full-year refresh.

## Solution Options

### Option 1: Change Threshold to 12+ (Recommended)

**Change**: Only use full-year refresh for **12+ periods**, but use 3-column batching for **9-11 periods**.

**Implementation**: Change line 11281 from `>= 12` to `>= 12` (keep as is), but ensure 9-11 periods use 3-column batching.

**Issue**: This doesn't solve the problem if 12 periods are detected.

### Option 2: Use Full-Year Refresh Only for Complete Years (12 months)

**Change**: Only use full-year refresh if the periods form a complete year (Jan-Dec), not just 12+ periods.

**Implementation**: Check if periods are consecutive months from Jan-Dec.

**Pros**: 
- 9 columns (Apr-Dec) would use 3-column batching
- Full year (Jan-Dec) would use full-year refresh

**Cons**: 
- More complex logic
- Partial years with 12+ months (e.g., Apr 2024 - Mar 2025) would use 3-column batching

### Option 3: Revert to Full-Year Refresh for All 3+ Periods (User's Request)

**Change**: Remove 3-column batching, always use full-year refresh for 3+ periods from same year.

**Implementation**: 
- Remove the 3-11 period check (line 11293-11297)
- Always use full-year refresh for 3+ periods from same year
- Keep full-year refresh logic (lines 11281-11292)

**Pros**:
- Simpler code
- Faster overall (single query)
- All data appears at once (no incremental updates)

**Cons**:
- No incremental updates (perceived slowness)
- User sees nothing for 10-15 seconds

### Option 4: Smart Detection - Count Only Dragged Periods

**Change**: Detect which periods are actually being dragged (newly queued) vs. existing periods.

**Implementation**: Track period timestamps or use a different detection method.

**Pros**: 
- Most accurate
- 9 columns would correctly use 3-column batching

**Cons**: 
- Complex implementation
- Requires tracking state

## Recommendation

**Option 3: Revert to Full-Year Refresh** (as user requested)

The user explicitly stated they want to revert to full-year refresh because:
1. The 3-column batching approach isn't providing the expected UX benefit
2. Full-year refresh is faster overall (single query)
3. All data appears at once, which may actually be better UX than incremental updates

## Implementation Plan

1. **Remove 3-column batching logic** (lines 11293-11297)
2. **Use full-year refresh for 3+ periods** from same year (modify line 11281 to `>= 3`)
3. **Keep column-based grid as fallback** for multiple years or edge cases
4. **Update comments** to reflect the change

## Code Changes Required

```javascript
// BEFORE (lines 11281-11297):
if (yearCount === 1 && periodsInLargestYear >= 12) {
    // Full-year refresh
} else if (yearCount === 1 && periodsInLargestYear >= 3 && periodsInLargestYear <= 11) {
    // 3-column batching - REMOVE THIS
} else if (yearCount > 1) {
    // Multiple years
}

// AFTER:
if (yearCount === 1 && periodsInLargestYear >= 3) {
    // Full-year refresh for 3+ periods from same year
} else if (yearCount > 1) {
    // Multiple years - use column-based grid
}
```

## Expected Behavior After Fix

- **3+ columns (same year)**: Single full-year refresh query → all data appears at once
- **Multiple years**: Column-based grid processing (period-by-period)
- **1-2 columns**: Individual queries or preload (existing behavior)

## Testing

1. Drag 9 columns (Apr-Dec) → Should use full-year refresh, all data appears at once
2. Drag 12 columns (Jan-Dec) → Should use full-year refresh
3. Drag 3 columns → Should use full-year refresh
4. Drag across years (Dec 2024 - Feb 2025) → Should use column-based grid
