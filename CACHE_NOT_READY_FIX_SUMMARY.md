# Fix Summary: CACHE_NOT_READY → Promise-Based Retry

## Problem
After stability hardening, all formulas returned `#VALUE` and never recovered. Root cause: Excel treats thrown `Error` objects as **permanent failures** and does NOT auto-retry. The stability hardening plan incorrectly assumed Excel would retry on errors.

## Solution
Replaced all `throw new Error("CACHE_NOT_READY")` with a Promise-based retry mechanism that:
1. **Never throws for transient states** - only resolves to numbers
2. **Retries with bounded delays** - gives cache time to be written
3. **Eventually throws BUSY** - which Excel already handles (used elsewhere in codebase)

## Implementation

### New Helper Function: `retryCacheLookup()`
```javascript
async function retryCacheLookup(
    account, fromPeriod, toPeriod, subsidiary, filtersHash, cacheKey, periodKey,
    checkLocalStorageCacheFn, maxRetries = 10, retryDelay = 500
) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        // Wait before checking (first attempt is immediate, subsequent have delay)
        if (attempt > 0) {
            await new Promise(r => setTimeout(r, retryDelay));
        }
        
        // Check localStorage cache
        const localStorageValue = checkLocalStorageCacheFn(...);
        if (localStorageValue !== null) {
            return localStorageValue; // ✅ Resolves to number
        }
        
        // Check in-memory cache
        if (cache.balance.has(cacheKey)) {
            return cache.balance.get(cacheKey); // ✅ Resolves to number
        }
    }
    
    // After max retries, throw BUSY (Excel already handles this)
    throw new Error('BUSY');
}
```

### Changes Made
- **5 locations** where `CACHE_NOT_READY` was thrown → replaced with `retryCacheLookup()` calls
- All retry logic now uses Promise-based delays (yields to event loop)
- Maximum retry time: 10 attempts × 500ms = 5 seconds total
- After max retries: throws `BUSY` (which Excel handles, unlike `CACHE_NOT_READY`)

## How Excel Retries Are Preserved

1. **Promise resolves to number** - Excel sees a successful resolution, not an error
2. **Bounded delays** - Each retry waits 500ms (yields to event loop, non-blocking)
3. **Multiple attempts** - Up to 10 retries gives cache 5 seconds to be written
4. **BUSY fallback** - If still not found, throws BUSY (which Excel already handles in other code paths)

## Key Differences from Original

| Aspect | Before (Broken) | After (Fixed) |
|--------|----------------|----------------|
| Transient state handling | `throw Error("CACHE_NOT_READY")` | `retryCacheLookup()` → resolves to number |
| Excel behavior | Treats as permanent failure (#VALUE) | Sees successful resolution |
| Retry mechanism | None (Excel doesn't retry errors) | Promise-based retry with delays |
| Max wait time | 2 seconds (then error) | 5 seconds (10 retries × 500ms) |
| Final fallback | `CACHE_NOT_READY` error | `BUSY` error (Excel handles) |

## Validation

✅ **Syntax check:** `node -c docs/functions.js` passes  
✅ **No CACHE_NOT_READY throws:** All replaced  
✅ **Type contract preserved:** Always resolves to `number` or throws `BUSY`  
✅ **Non-blocking:** All delays use `await new Promise(r => setTimeout(r, delay))`  

## Testing Required

1. **Scenario 1:** Formula evaluates when cache is initially missing, then becomes available
   - Expected: Cell shows #BUSY briefly, then resolves to correct number
   
2. **Scenario 2:** Drag-fill with 61 formulas (CFO Flash report)
   - Expected: All formulas eventually resolve to numbers, no #VALUE errors
   
3. **Scenario 3:** Cache write happens during retry window
   - Expected: Formula resolves immediately when cache is found (no need to wait for all retries)

## Files Changed

- `docs/functions.js`: Added `retryCacheLookup()` helper, replaced 5 `CACHE_NOT_READY` throws

---

**Status:** Implementation complete, ready for testing

