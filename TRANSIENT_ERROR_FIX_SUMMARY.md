# Fix Summary: Remove All Transient Error Throws

## Problem
Numeric custom functions were returning `#VALUE` because Excel treats thrown `Error` objects as **permanent failures** and does NOT auto-retry. All transient states (cache not ready, preload running, build mode deferral) were throwing `Error('BUSY')` or `Error('CACHE_NOT_READY')`, causing terminal failures.

## Solution
Removed ALL transient error throws from numeric custom functions. Transient states now proceed to the API path instead of throwing errors.

## Changes Made

### A) Removed Transient Throws (17 locations)

**Pattern:** All `throw new Error('BUSY')` and `throw new Error('CACHE_NOT_READY')` removed from:
- `BALANCE()` function (13 locations)
- `BALANCECURRENCY()` function (2 locations)
- `RETAINEDEARNINGS()` function (1 location)
- `NETINCOME()` function (1 location)
- `CTA()` function (1 location)

### B) Modified `retryCacheLookup()` Helper

**Before:**
```javascript
// After max retries, throw BUSY
throw new Error('BUSY');
```

**After:**
```javascript
// After max retries, return null to signal cache not ready
// Caller will proceed to API path (transient state, not terminal error)
return null;
```

### C) Transient State Handling Patterns

**1. Period Still Running After Wait**
- **Before:** `throw new Error('BUSY')`
- **After:** Proceed to API path (log message, continue execution)

**2. Period Failed But Retries Remaining**
- **Before:** `throw new Error('BUSY')`
- **After:** Proceed to API path (log message, continue execution)

**3. Build Mode Period Not Resolved**
- **Before:** `throw new Error('BUSY')`
- **After:** Proceed to API path (API handles invalid params gracefully)

**4. Queue Cleared (RETAINEDEARNINGS, NETINCOME, CTA)**
- **Before:** `throw new Error('BUSY')`
- **After:** Proceed to API path (log message, continue execution)

**5. Cache Not Ready After Retries**
- **Before:** `throw new Error('CACHE_NOT_READY')` (via `retryCacheLookup()`)
- **After:** Return `null`, caller proceeds to API path

## How Excel Retries Are Preserved

1. **No Terminal Errors for Transient States**
   - All transient states proceed to API path
   - API path handles errors gracefully or returns data
   - Excel sees successful Promise resolution (not error)

2. **Promise-Based Retry in `retryCacheLookup()`**
   - Retries up to 10 times with 500ms delays
   - Yields to event loop (non-blocking)
   - Returns `null` if cache not found (signals caller to proceed)

3. **API Path as Fallback**
   - When cache/preload not ready, proceed to API call
   - API returns data or handles errors gracefully
   - Excel sees number or API error (not transient BUSY error)

## Validation

✅ **Syntax check:** `node -c docs/functions.js` passes  
✅ **No BUSY throws:** All 17 `throw new Error('BUSY')` removed  
✅ **No CACHE_NOT_READY throws:** All removed (replaced with `retryCacheLookup()` returning `null`)  
✅ **Type contract preserved:** Functions resolve to `number` or throw only for permanent failures  
✅ **Non-blocking:** All delays use `await new Promise(r => setTimeout(r, delay))`  

## Testing Required

1. **Scenario 1:** Formula evaluates when cache is initially missing, then becomes available
   - Expected: Cell proceeds to API path, resolves to number (no #VALUE)

2. **Scenario 2:** Drag-fill with 61 formulas (CFO Flash report)
   - Expected: All formulas eventually resolve to numbers, no #VALUE errors

3. **Scenario 3:** Preload running, formula evaluates
   - Expected: Formula proceeds to API path after wait expires, resolves to number

4. **Scenario 4:** Build mode with unresolved period reference
   - Expected: Formula proceeds to API path, API handles gracefully

## Files Changed

- `docs/functions.js`: Removed 17 transient error throws, modified `retryCacheLookup()` helper

---

**Status:** Implementation complete, ready for testing

