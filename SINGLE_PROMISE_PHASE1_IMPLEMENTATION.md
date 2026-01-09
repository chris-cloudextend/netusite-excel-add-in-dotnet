# Single Promise Per Period - Phase 1 Implementation

## Summary

Implemented Phase 1 of Claude's architectural fix: **Single Promise Per Period**. This adds the infrastructure for ensuring all cells for the same period await the EXACT SAME Promise that resolves WITH the balance data, ensuring simultaneous resolution.

## Status

✅ **Phase 1 Complete** - Infrastructure added, **disabled by default** (feature flag)

## What Was Implemented

### 1. Feature Flag
- **Location**: `docs/functions.js`, line 28
- **Flag**: `USE_SINGLE_PROMISE_APPROACH = false`
- **Purpose**: Enable/disable the new single-promise flow without code changes

### 2. Core Infrastructure

#### Single Promise Query Map
- **Location**: `docs/functions.js`, line 6555
- **Structure**: `Map<periodKey, {promise, resolve, reject, period, filtersHash, startTime}>`
- **Key Format**: `${period}:${filtersHash}` (e.g., "Feb 2025:1::::1")

#### Helper Functions
- **Location**: `docs/functions.js`, lines 6560-6585
- **Functions**:
  - `extractSubsidiary(filtersHash)` - Parse subsidiary from filtersHash
  - `extractDepartment(filtersHash)` - Parse department from filtersHash
  - `extractLocation(filtersHash)` - Parse location from filtersHash
  - `extractClass(filtersHash)` - Parse class from filtersHash
  - `extractBook(filtersHash)` - Parse accounting book from filtersHash
  - `writeToLocalStorageCache(balancesByAccount, period, filtersHash)` - Write results to cache

#### Core Functions

**`executeFullPreload(periodKey)`**
- **Location**: `docs/functions.js`, lines 6587-6645
- **Purpose**: Calls `/batch/bs_preload` for a single period and transforms response
- **Response Transformation**:
  - Backend returns: `{ "10010": { "Feb 2025": 12345.67 }, ... }`
  - Transforms to: `{ "10010": 12345.67, ... }`
- **Key Behavior**: Resolves the promise WITH the data, so ALL awaiting cells get results simultaneously

**`singlePromiseFlow(account, toPeriod, filtersHash, cacheKey)`**
- **Location**: `docs/functions.js`, lines 6647-6690
- **Purpose**: Main entry point for single-promise flow
- **Behavior**:
  1. Creates period key: `${toPeriod}:${filtersHash}`
  2. Checks if query already exists for this period
  3. If new, creates promise and starts preload immediately (no debounce)
  4. If existing, reuses the same promise
  5. ALL cells await the EXACT SAME Promise
  6. Extracts balance for specific account from resolved data

### 3. Integration Point

**Location**: `docs/functions.js`, lines 7360-7372

**Integration Logic**:
```javascript
if (USE_SINGLE_PROMISE_APPROACH && isCumulativeQuery && lookupPeriod && isBalanceSheet) {
    console.log(`🔄 SINGLE-PROMISE PATH: account=${account}, period=${lookupPeriod}`);
    try {
        const balance = await singlePromiseFlow(account, lookupPeriod, filtersHash, cacheKey);
        pendingEvaluation.balance.delete(evalKey);
        return balance;
    } catch (error) {
        console.warn(`⚠️ Single-promise flow failed, falling back to existing logic:`, error);
        // Fall through to existing column-based batching logic
    }
}
```

**Placement**: Right after account type check, before column-based batching logic

**Fallback**: If single-promise flow fails, falls back to existing column-based batching

## Key Design Decisions

### 1. No Debounce
- Single-promise approach starts preload **immediately** when first cell arrives
- No debounce window - first cell triggers preload, all subsequent cells await the same promise
- This ensures fastest possible resolution for all cells

### 2. Response Transformation
- Backend returns nested structure: `{ "10010": { "Feb 2025": 12345.67 } }`
- Transforms to flat structure: `{ "10010": 12345.67 }`
- All cells extract their account balance from the same resolved data

### 3. Cache Writing
- Results written to localStorage using format: `balance:${account}:${filtersHash}:${period}`
- Matches existing cache key format for consistency
- Preload marker set: `preload_complete:${period}:${filtersHash}`

### 4. Error Handling
- If preload fails, promise is rejected
- Individual cells catch error and fall back to existing logic
- No silent failures - all errors are logged

## Testing Plan (When Enabled)

### Phase 2 Testing Checklist

1. **Enable Feature Flag**
   - Set `USE_SINGLE_PROMISE_APPROACH = true`
   - Update manifest for cache busting

2. **Test Scenarios**
   - ✅ Single cell: Enter first formula for new period
   - ✅ Drag down: Drag formula down 10 rows
   - ✅ Drag right: Drag formula across 12 columns
   - ✅ Drag both: Drag formula across 12 columns × 100 rows
   - ✅ Multiple periods: Enter formulas for Jan, Feb, Mar simultaneously
   - ✅ Cache hit: Enter formula for period already preloaded

3. **Expected Behavior**
   - First cell triggers preload immediately (no debounce)
   - All cells for same period await same promise
   - All cells resolve simultaneously when promise resolves
   - No individual API calls (all use preload results)
   - Cache populated for future lookups

4. **Performance Metrics**
   - Time to first resolution (should be ~70s for new period)
   - Time to all cells resolved (should be same as first, not sequential)
   - Number of API calls (should be 1 per period, not 1 per cell)

## Next Steps

### Phase 2: Enable and Test
1. Enable feature flag: `USE_SINGLE_PROMISE_APPROACH = true`
2. Test with real Excel scenarios
3. Monitor logs for any issues
4. Compare performance vs. existing approach

### Phase 3: Remove Old Code (If Successful)
1. Remove column-based batching logic
2. Remove debounce mechanisms
3. Simplify codebase to single-promise approach only

## Files Modified

1. **`docs/functions.js`**
   - Added feature flag (line 28)
   - Added single-promise infrastructure (lines 6554-6690)
   - Added integration point (lines 7360-7372)
   - Updated version to 4.0.6.136

## Version History

- **v4.0.6.136**: Phase 1 - Added single-promise infrastructure (disabled by default)
