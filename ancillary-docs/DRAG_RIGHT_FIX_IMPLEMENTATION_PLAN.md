# Drag-Right 3+ Columns Fix: Implementation Plan for Claude

## Issue Summary

When dragging formulas across 3+ columns (e.g., April to December), formulas resolve cell-by-cell instead of using optimized 3-column batching. Each period triggers its own preload, formulas wait sequentially, and batch processing doesn't detect the grid pattern.

## Root Cause

1. **Individual Preload Triggers**: Each period (Apr, May, Jun, etc.) triggers its own income preload
2. **Sequential Waiting**: Each formula waits for its specific period's preload (up to 120s)
3. **Late Grid Detection**: Grid detection only happens in `processBatchQueue()`, but by then requests may be processed individually
4. **Missing Early Detection**: No grid pattern detection before preload wait logic

## Solution: Early Grid Detection + Skip Preloads

### Concept

Detect grid pattern **BEFORE** triggering individual preloads. If grid detected (3+ periods, 2+ accounts), skip preload waits and let batch processing handle all requests together as a grid.

### Implementation Steps

#### Step 1: Add Early Grid Detection in BALANCE() Function

**Location**: `docs/functions.js`, around line 7742 (before preload trigger logic)

**Code to Add**:

```javascript
// EARLY GRID DETECTION: Check if we're part of a grid pattern before triggering preloads
// This prevents unnecessary preloads and ensures batch processing works correctly
let shouldSkipPreload = false;
if (!isPeriodCached && !isPending) {
    // Check pendingEvaluation for grid pattern
    const evaluatingRequests = Array.from(pendingEvaluation.balance.values());
    if (evaluatingRequests.length >= 2) {
        // Check if we have multiple periods (grid pattern)
        const periods = new Set();
        const accounts = new Set();
        for (const req of evaluatingRequests) {
            if (req.toPeriod) {
                const normalized = normalizePeriodKey(req.toPeriod, false);
                if (normalized) periods.add(normalized);
            }
            if (req.account) accounts.add(req.account);
        }
        
        // Grid pattern: 3+ periods AND 2+ accounts
        if (periods.size >= 3 && accounts.size >= 2) {
            console.log(`🔍 EARLY GRID DETECTION: Detected ${periods.size} periods × ${accounts.size} accounts - skipping individual preloads`);
            shouldSkipPreload = true;
        }
    }
}
```

**Modify Preload Trigger Logic** (around line 7747):

```javascript
// CRITICAL FIX: Trigger preload for NEW periods (not just first formula ever)
// This matches Balance Sheet behavior: each new period gets its own preload
// BUT: Skip if grid pattern detected (batch processing will handle it)
if (!isPeriodCached && !isPending && !shouldSkipPreload) {
    // ... existing preload trigger code ...
}
```

#### Step 2: Enhance Grid Detection in processBatchQueue()

**Location**: `docs/functions.js`, around line 11193

**Current Code** (lines 11193-11197):
```javascript
if (!useFullYearRefreshPatternFinal && !usePeriodRangeOptimization && 
    allAccountsAreIncomeStatement && uncachedRequests.length > 0) {
    // Try column-based grid detection as fallback
    const evaluatingRequests = uncachedRequests.map(r => ({ params: r.request.params }));
    columnBasedPLGrid = detectColumnBasedPLGrid(evaluatingRequests);
```

**Enhancement**: Add logging and ensure it always runs for Income Statement:

```javascript
if (!useFullYearRefreshPatternFinal && !usePeriodRangeOptimization && 
    allAccountsAreIncomeStatement && uncachedRequests.length > 0) {
    // CRITICAL: Always try column-based grid detection for Income Statement
    // This ensures grid batching works even when full-year refresh isn't applicable
    const evaluatingRequests = uncachedRequests.map(r => ({ params: r.request.params }));
    console.log(`  🔍 Attempting column-based PL grid detection: ${evaluatingRequests.length} requests`);
    columnBasedPLGrid = detectColumnBasedPLGrid(evaluatingRequests);
    
    if (!columnBasedPLGrid || !columnBasedPLGrid.eligible) {
        console.log(`  ⚠️ Column-based PL grid detection failed or not eligible`);
        console.log(`     Request count: ${evaluatingRequests.length}`);
        if (evaluatingRequests.length > 0) {
            const sampleRequest = evaluatingRequests[0];
            console.log(`     Sample request: account=${sampleRequest.params?.account}, toPeriod=${sampleRequest.params?.toPeriod}`);
        }
    }
```

#### Step 3: Verify detectColumnBasedPLGrid() Logic

**Location**: `docs/functions.js`, line 838

**Current Requirements** (line 925):
- `allAccounts.size >= 2` AND `byColumn.size >= 2` for primary mode

**Issue**: This should work for Apr-Dec (9 periods), but might fail if:
- Requests are filtered out because they're cached (line 891-895)
- Filters don't match (line 939-940)

**Fix**: Add more logging to debug why detection fails:

```javascript
// Step 4: Primary mode - Multiple accounts + Multiple periods
if (allAccounts.size >= 2 && byColumn.size >= 2) {
    // ... existing filter matching code ...
    
    if (!allFiltersMatch) {
        console.log(`🔍 COLUMN-BASED PL DETECT: Filters differ - first: ${firstFilterKey}, mismatched column filters: ${Array.from(byColumn.values()).map(c => normalizeFiltersForColumnBatching(c.filters)).join(', ')}`);
        return { eligible: false };
    }
    
    console.log(`🔍 COLUMN-BASED PL DETECT: ✅ PRIMARY MODE - ${allAccounts.size} accounts, ${byColumn.size} periods`);
    // ... rest of code ...
}
```

#### Step 4: Add Fallback for Grid Detection Failure

**Location**: `docs/functions.js`, around line 11250

**If grid detection fails**, add fallback to still batch periods together:

```javascript
} else {
    // Fallback: Use column-based grid processing
    useColumnBasedPLGrid = true;
    console.log(`  ✅ COLUMN-BASED PL GRID DETECTED: ${columnBasedPLGrid.allAccounts.size} accounts × ${columnBasedPLGrid.columns.length} periods`);
    console.log(`     Will process periods column-by-column (faster than row-by-row)`);
}

// NEW: If grid detection completely failed, still try to batch by period
if (!useColumnBasedPLGrid && !useFullYearRefreshPatternFinal && 
    allAccountsAreIncomeStatement && uncachedRequests.length > 0) {
    // Group requests by period and batch them
    const requestsByPeriod = new Map();
    for (const {cacheKey, request} of uncachedRequests) {
        const period = request.params.toPeriod;
        if (!requestsByPeriod.has(period)) {
            requestsByPeriod.set(period, []);
        }
        requestsByPeriod.get(period).push({cacheKey, request});
    }
    
    // If we have 3+ periods, use 3-column batching
    if (requestsByPeriod.size >= 3) {
        console.log(`  🔄 FALLBACK: Grouping ${uncachedRequests.length} requests into ${requestsByPeriod.size} periods for batching`);
        // Process in batches of 3 periods
        const periods = Array.from(requestsByPeriod.keys()).sort();
        // ... implement 3-column batching fallback ...
    }
}
```

## Code Locations Reference

### File: `docs/functions.js`

1. **Early Grid Detection** (around line 7742):
   - Add before preload trigger logic
   - Check `pendingEvaluation.balance` for grid pattern
   - Set `shouldSkipPreload` flag if grid detected

2. **Preload Skip Logic** (around line 7747):
   - Modify condition: `if (!isPeriodCached && !isPending && !shouldSkipPreload)`
   - Skip preload trigger if grid detected

3. **Enhanced Grid Detection** (around line 11193):
   - Add logging to debug why detection might fail
   - Ensure detection always runs for Income Statement

4. **detectColumnBasedPLGrid()** (line 838):
   - Add logging for filter mismatches
   - Verify detection requirements

5. **Fallback Batching** (around line 11250):
   - Add fallback if grid detection fails
   - Group by period and batch manually

## Testing Checklist

1. ✅ Drag 2 columns - should work as before
2. ✅ Drag 3-11 columns - should use 3-column batching
3. ✅ Drag 12+ columns - should use full-year refresh
4. ✅ Verify no individual preloads triggered when grid detected
5. ✅ Verify batch processing logs show grid detection
6. ✅ Verify incremental updates (3 periods at a time)

## Expected Logs After Fix

```
🔍 EARLY GRID DETECTION: Detected 9 periods × 50 accounts - skipping individual preloads
⏱️ SKIPPING timer reset (rapid requests: 45ms apart, queue: 450)
⏱️ Batch timer FIRED!
🔄 processBatchQueue() CALLED
  🔍 Attempting column-based PL grid detection: 450 requests
🔍 COLUMN-BASED PL DETECT: ✅ PRIMARY MODE - 50 accounts, 9 periods
  ✅ COLUMN-BASED PL GRID DETECTED: 50 accounts × 9 periods
     Using 3-column batching for incremental updates (3-11 periods, single year)
  📦 Processing batch 1/3: Apr 2025, May 2025, Jun 2025 (50 accounts)
  ✅ Batch 1 complete: 50 accounts in 4.2s
  📦 Processing batch 2/3: Jul 2025, Aug 2025, Sep 2025 (50 accounts)
  ✅ Batch 2 complete: 50 accounts in 4.1s
  📦 Processing batch 3/3: Oct 2025, Nov 2025, Dec 2025 (50 accounts)
  ✅ Batch 3 complete: 50 accounts in 4.3s
```

## Key Changes Summary

1. **Early Grid Detection**: Detect grid pattern before preload triggers
2. **Skip Preloads**: Don't trigger individual preloads if grid detected
3. **Enhanced Logging**: Add logs to debug grid detection failures
4. **Fallback Batching**: Manual period grouping if grid detection fails

## Notes

- Early detection uses `pendingEvaluation.balance` which tracks requests currently being evaluated
- Grid detection requires: 3+ periods AND 2+ accounts
- Preload skip only applies when grid is detected early
- Batch processing still handles the actual batching logic
