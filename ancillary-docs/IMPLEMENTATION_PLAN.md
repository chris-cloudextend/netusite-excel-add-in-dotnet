# Implementation Plan: Fix Excel Recalculation Order and Poisoned Cache

## Problem Summary

When Accounting Book (U3) changes:
1. Excel immediately recalculates TYPEBALANCE formulas
2. Formulas execute with **old subsidiary (Q3)** + **new book (U3)** = invalid combination
3. Backend returns valid response (often $0.00 for Income in secondary books)
4. Result gets cached with invalid parameter combination
5. When Q3 is updated to correct subsidiary, Excel doesn't invalidate cache
6. Formulas continue returning cached $0.00 values

**Root Cause**: Excel recalculation happens **before** Q3 update completes, causing formulas to cache results for invalid parameter states.

---

## Solution Architecture

### Phase 1: Guard Clause in TYPEBALANCE (Mac-Safe #N/A)

**Goal**: Prevent formula execution when parameters are in invalid/transitional state.

**Approach**: 
- Check for invalid (book, subsidiary) combinations **before** any cache lookup or API call
- Return native Excel #N/A error (Mac-safe) when parameters are invalid
- Do NOT execute backend query when returning #N/A

**Implementation Details**:

1. **Enhanced Validation Function** (`functions.js`, line ~122)
   - Modify `validateSubsidiaryAccountingBook()` to return more granular states:
     - `null` = valid
     - `'INVALID_COMBINATION'` = subsidiary not enabled for book
     - `'INVALID_BOOK'` = book has no enabled subsidiaries
     - `'TRANSITION_IN_PROGRESS'` = book change in progress (Q3 update pending)
     - `'PARAMETERS_UNRESOLVED'` = parameters are empty/incomplete

2. **Transition State Detection** (`functions.js`, TYPEBALANCE function, line ~10342)
   - Before cache lookup, check if we're in a transition state:
     ```javascript
     // Check transition flag - if book changed but Q3 hasn't updated yet
     const transitionKey = `netsuite_book_transition_${bookStr}`;
     const transitionData = localStorage.getItem(transitionKey);
     if (transitionData) {
         const transition = JSON.parse(transitionData);
         const age = Date.now() - transition.timestamp;
         if (age < 5000) { // 5 second window
             // Check if current subsidiary matches the OLD subsidiary from transition
             // If yes, we're in transition state (Q3 hasn't updated yet)
             if (subsidiaryStr === transition.oldSubsidiary) {
                 // Return #N/A - parameters are in transition
                 throw new OfficeExtension.Error(OfficeExtension.ErrorCodes.notAvailable);
             }
         }
     }
     ```

3. **Mac-Safe #N/A Return**
   - **CRITICAL**: TYPEBALANCE is declared as `Promise<number>`, so we **CANNOT** return a string
   - **Research Needed**: Verify if there's a way to throw an Error that Excel displays as #N/A (not #ERROR!)
   - **Option A**: Use `OfficeExtension.Error` with `ErrorCodes.notAvailable` (if available)
   - **Option B**: Throw `new Error('NOT_AVAILABLE')` and check if Excel displays as #N/A
   - **Option C**: Use a special error code that Excel recognizes as #N/A
   - **Fallback**: If #N/A isn't possible, use `#ERROR!` with clear error message, but user prefers #N/A

4. **Validation Order** (in TYPEBALANCE function):
   ```javascript
   // 1. Normalize parameters FIRST
   const subsidiaryStr = String(subsidiary || '').trim();
   const bookStr = String(accountingBook || '').trim();
   
   // 2. Check for transition state BEFORE validation
   if (bookStr && bookStr !== '1') {
       const transitionKey = `netsuite_book_transition_${bookStr}`;
       const transitionData = localStorage.getItem(transitionKey);
       if (transitionData) {
           const transition = JSON.parse(transitionData);
           const age = Date.now() - transition.timestamp;
           if (age < 5000 && subsidiaryStr === transition.oldSubsidiary) {
               // In transition - return #N/A
               throw new OfficeExtension.Error(OfficeExtension.ErrorCodes.notAvailable);
           }
       }
   }
   
   // 3. Validate combination (existing logic)
   const validationError = await validateSubsidiaryAccountingBook(subsidiaryStr, bookStr);
   if (validationError === 'INVALID_COMBINATION' || validationError === 'INVALID_BOOK') {
       // Return #N/A for invalid combinations (not #ERROR!)
       throw new OfficeExtension.Error(OfficeExtension.ErrorCodes.notAvailable);
   }
   
   // 4. NOW proceed with cache lookup and API calls
   ```

**Files to Modify**:
- `docs/functions.js`:
  - Line ~122: Enhance `validateSubsidiaryAccountingBook()` return values
  - Line ~10342: Add transition state check BEFORE validation
  - Line ~10344-10350: Change error handling to use `OfficeExtension.Error` for #N/A

**Dependencies**:
- Need to import `OfficeExtension` at top of `functions.js`
- Verify Office.js API supports `OfficeExtension.Error` and `ErrorCodes.notAvailable`

---

### Phase 2: Deterministic Recalculation Control

**Goal**: Ensure formulas never execute with mismatched parameters by controlling Excel's recalculation timing.

**Current State**:
- Q3 is updated in same `Excel.run()` batch (line ~18056-18060)
- But Excel may still recalculate formulas between batches
- Transition flag exists but may not be checked early enough

**Implementation Details**:

1. **Suspend Calculation Mode** (if supported by Excel.js API)
   - Check if `context.application.calculationMode` can be set to `Excel.CalculationMode.manual`
   - Set to manual before updating Q3
   - Update Q3
   - Force recalculation
   - Restore calculation mode

2. **Alternative: Enhanced Transition Flag System**
   - If calculation suspension isn't supported, use a more aggressive transition flag:
   - Set transition flag **BEFORE** updating U3 (in `handleSheetChange`)
   - Transition flag includes:
     - `oldBook`: Previous book value
     - `newBook`: New book value
     - `oldSubsidiary`: Current subsidiary (before update)
     - `newSubsidiary`: Target subsidiary (after update)
     - `timestamp`: When transition started
   - TYPEBALANCE checks: "If current (book, subsidiary) matches (newBook, oldSubsidiary), return #N/A"

3. **Force Recalculation After Q3 Update**
   - After Q3 is updated, explicitly trigger recalculation:
   ```javascript
   await Excel.run(async (context) => {
       const sheet = context.workbook.worksheets.getActiveWorksheet();
       // Force recalculation of all formulas
       sheet.getUsedRange().calculate(true);
       await context.sync();
   });
   ```

**Files to Modify**:
- `docs/taskpane.html`:
  - Line ~17908: Set transition flag **before** any async operations
  - Line ~18056: After Q3 update, force recalculation
  - Line ~18065: Clear transition flag after recalculation completes

**Challenges**:
- Excel.js API may not support suspending calculation mode
- Need to test if `calculate(true)` forces immediate recalculation
- Transition flag timing must be precise

---

### Phase 3: Cache Key Hardening

**Goal**: Ensure cache keys include ALL effective parameters and cannot be reused from invalid states.

**Current State**:
- Cache keys already include: accountType, fromPeriod, toPeriod, subsidiary, department, location, class, book, specialFlag
- Keys are correctly formatted and normalized

**Implementation Details**:

1. **Verify Cache Key Completeness**
   - Audit all cache key constructions in TYPEBALANCE
   - Ensure no parameters are missing
   - Add validation logging to catch key mismatches

2. **Cache Invalidation on Parameter Change**
   - When Q3 (subsidiary) is programmatically updated, invalidate all TYPEBALANCE cache entries for that subsidiary
   - When U3 (book) is programmatically updated, invalidate all TYPEBALANCE cache entries for that book
   - Use a cache version/timestamp system:
     ```javascript
     // In taskpane.html, after updating Q3:
     const cacheVersion = Date.now();
     localStorage.setItem('netsuite_cache_version', cacheVersion.toString());
     
     // In functions.js, before cache lookup:
     const cacheVersion = parseInt(localStorage.getItem('netsuite_cache_version') || '0');
     const cacheDataVersion = parseInt(storageData.timestamp || '0');
     if (cacheDataVersion < cacheVersion) {
         // Cache is stale - don't use it
         return; // Proceed to API call
     }
     ```

3. **Cache Key Validation**
   - Before using cached value, verify the cache key matches current parameters exactly
   - Log mismatches for debugging

**Files to Modify**:
- `docs/taskpane.html`:
  - Line ~18063: After Q3 update, increment cache version
  - Line ~19773: After cache clear, increment cache version
- `docs/functions.js`:
  - Line ~10370: Check cache version before using cached values
  - Line ~10352: Add cache key validation logging

---

### Phase 4: Explicit Cache Invalidation on Parameter Updates

**Goal**: When parameters are programmatically updated, immediately invalidate related cache entries.

**Implementation Details**:

1. **Cache Invalidation Function**
   ```javascript
   // In functions.js
   function invalidateTypeBalanceCache(book, subsidiary) {
       // Clear in-memory cache
       if (cache.typebalance) {
           if (book) {
               // Clear all entries for this book
               Object.keys(cache.typebalance).forEach(key => {
                   if (key.includes(`:${book}:`)) {
                       delete cache.typebalance[key];
                   }
               });
           }
           if (subsidiary) {
               // Clear all entries for this subsidiary
               Object.keys(cache.typebalance).forEach(key => {
                   if (key.includes(`:${subsidiary}:`)) {
                       delete cache.typebalance[key];
                   }
               });
           }
       }
       
       // Clear localStorage cache
       const stored = localStorage.getItem('netsuite_typebalance_cache');
       if (stored) {
           const storageData = JSON.parse(stored);
           const balances = storageData.balances || {};
           const newBalances = {};
           Object.keys(balances).forEach(key => {
               const shouldKeep = (!book || !key.includes(`:${book}:`)) &&
                                  (!subsidiary || !key.includes(`:${subsidiary}:`));
               if (shouldKeep) {
                   newBalances[key] = balances[key];
               }
           });
           storageData.balances = newBalances;
           storageData.timestamp = Date.now();
           localStorage.setItem('netsuite_typebalance_cache', JSON.stringify(storageData));
       }
   }
   ```

2. **Call Invalidation on Q3 Update**
   - In `taskpane.html`, after updating Q3 (line ~18063):
   ```javascript
   // Invalidate cache for old subsidiary
   if (window.invalidateTypeBalanceCache) {
       window.invalidateTypeBalanceCache(null, currentSubsidiary);
   }
   ```

3. **Call Invalidation on U3 Change**
   - In `taskpane.html`, when U3 changes (line ~17908):
   ```javascript
   // Invalidate cache for old book
   if (window.invalidateTypeBalanceCache) {
       window.invalidateTypeBalanceCache(previousU3Value, null);
   }
   ```

**Files to Modify**:
- `docs/functions.js`: Add `invalidateTypeBalanceCache()` function
- `docs/taskpane.html`: Call invalidation after Q3 and U3 updates

---

## Implementation Order

### Step 1: Research OfficeExtension.Error API
- Verify `OfficeExtension.Error` and `ErrorCodes.notAvailable` are available
- Test if this returns native Excel #N/A in Mac
- If not available, find alternative Mac-safe #N/A method

### Step 2: Implement Guard Clause (Phase 1)
- Enhance validation function
- Add transition state detection
- Implement #N/A return for invalid states
- Test: Changing book should show #N/A briefly, then resolve

### Step 3: Implement Cache Invalidation (Phase 4)
- Add invalidation function
- Call on Q3 and U3 updates
- Test: Cache should be cleared when parameters change

### Step 4: Implement Recalculation Control (Phase 2)
- Test calculation mode suspension (if supported)
- Implement force recalculation after Q3 update
- Test: Formulas should recalculate after Q3 update

### Step 5: Verify Cache Key Hardening (Phase 3)
- Audit cache keys
- Add version checking
- Test: Cache should not be reused from invalid states

---

## Testing Strategy

### Test Case 1: Book Change → #N/A → Correct Value
1. Start with Book 1, Subsidiary "Celigo Inc. (Consolidated)"
2. Change U3 to Book 2
3. **Expected**: Formulas show #N/A briefly (during transition)
4. **Expected**: Q3 updates to "Celigo India Pvt Ltd"
5. **Expected**: Formulas resolve to correct values (not $0.00)

### Test Case 2: Cache Invalidation
1. Load report with Book 1, get revenue values
2. Change to Book 2
3. **Expected**: Cache for Book 1 is invalidated
4. **Expected**: New cache entries created for Book 2
5. **Expected**: No stale Book 1 values appear

### Test Case 3: Transition State Detection
1. Set transition flag manually
2. Call TYPEBALANCE with old subsidiary
3. **Expected**: Returns #N/A (not cached value, not API call)
4. Wait 6 seconds (transition expires)
5. **Expected**: Normal validation proceeds

### Test Case 4: Mac Compatibility
1. Test in Excel for Mac
2. Change book multiple times
3. **Expected**: No crashes, no type errors
4. **Expected**: #N/A displays correctly (not as string)

---

## Risk Assessment

### High Risk
- **OfficeExtension.Error API**: May not be available or may not work as expected
  - **Mitigation**: Research API documentation, test thoroughly, have fallback plan

### Medium Risk
- **Calculation Mode Suspension**: May not be supported by Excel.js API
  - **Mitigation**: Use transition flag system as primary mechanism, calculation suspension as enhancement

### Low Risk
- **Cache Invalidation**: Straightforward implementation
- **Cache Key Hardening**: Already mostly correct, just needs verification

---

## Alternative Approaches (If Primary Fails)

### Alternative 1: Use #ERROR! Instead of #N/A
- If native #N/A isn't possible from Promise<number>, use `throw new Error('INVALID_PARAMS')`
- Excel will display `#ERROR!` which is still better than cached $0.00
- Add clear error message: "Invalid book/subsidiary combination - please wait for update"
- **Risk**: User sees #ERROR! instead of #N/A, but still prevents poisoned cache

### Alternative 2: Return 0 with Special Marker
- If #N/A isn't possible, return 0 but mark cache entry as "transitional"
- On next evaluation, if not transitional, proceed normally
- **Risk**: May still cache incorrect values

### Alternative 3: Delay Formula Execution
- Use `setTimeout` to delay TYPEBALANCE execution by 100ms
- Check if parameters are still invalid after delay
- **Risk**: Adds latency, may not prevent all race conditions

### Alternative 4: Two-Phase Cache
- Cache entries have "pending" and "confirmed" states
- Only use "confirmed" entries
- Mark as "confirmed" only after parameters are validated
- **Risk**: More complex, may still have timing issues

### Alternative 5: Change TYPEBALANCE to Promise<string>
- **NOT RECOMMENDED**: Would break existing formulas and violate contract
- Would allow returning "#N/A" as string
- **Risk**: High - breaks all existing TYPEBALANCE formulas

---

## Success Criteria

After implementation:
- ✅ Changing Accounting Book never results in persistent $0.00 values
- ✅ No cache clearing or formula re-entry required
- ✅ Formulas may briefly show #N/A but resolve deterministically
- ✅ Behavior matches fresh formula entry/drag-fill
- ✅ No Excel for Mac crashes or type errors
- ✅ All account types (Income, COGS, Expense) work correctly

---

## Code Locations Summary

| Component | File | Lines |
|-----------|------|-------|
| **Validation Function** | `docs/functions.js` | ~122-199 |
| **TYPEBALANCE Function** | `docs/functions.js` | ~10241-10648 |
| **Book Change Handler** | `docs/taskpane.html` | ~17908-18100 |
| **Q3 Update Logic** | `docs/taskpane.html` | ~18044-18090 |
| **Cache Population** | `docs/taskpane.html` | ~19863-19979 |

---

## Next Steps

1. **Research Phase**: Verify OfficeExtension.Error API availability and usage
2. **Prototype Phase**: Implement guard clause with #N/A return
3. **Test Phase**: Verify #N/A displays correctly in Excel for Mac
4. **Integration Phase**: Add cache invalidation and recalculation control
5. **Validation Phase**: Test all scenarios with real data

