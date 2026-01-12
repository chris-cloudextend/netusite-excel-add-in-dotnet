# Final Implementation Plan: Fix Excel Recalculation Order and Poisoned Cache

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

## Solution: Three-Phase Approach

### Phase 1: Guard Clause (Sentinel) - Prevent Execution During Invalid States ⭐ **HIGHEST PRIORITY**

**Goal**: Prevent TYPEBALANCE from executing queries or reading cache when parameters are invalid/transitional.

**Approach**: 
- Check for invalid (book, subsidiary) combinations **before** any cache lookup or API call
- Throw `CustomFunctions.Error` with `ErrorCode.notAvailable` (Excel will display #N/A - proper Excel error)
- Do NOT execute backend query when throwing error
- Do NOT read from cache when throwing error

**Implementation**:

1. **Enhanced Transition State Detection** (`docs/functions.js`, TYPEBALANCE function, ~line 10342)
   - Check transition flag **BEFORE** validation and cache lookup
   - If in transition state (book changed, Q3 not yet updated), throw Error immediately
   ```javascript
   // Check transition state FIRST - before validation, before cache lookup
   const bookStr = String(accountingBook || '').trim();
   const subsidiaryStr = String(subsidiary || '').trim();
   
   if (bookStr && bookStr !== '1') {
       const transitionKey = `netsuite_book_transition_${bookStr}`;
       try {
           const transitionData = localStorage.getItem(transitionKey);
           if (transitionData) {
               const transition = JSON.parse(transitionData);
               const age = Date.now() - transition.timestamp;
               if (age < 5000) { // 5 second window
                   // Check if current subsidiary matches OLD subsidiary from transition
                   // This means Q3 hasn't been updated yet
                   if (subsidiaryStr === transition.oldSubsidiary) {
                       console.log(`⏸️ TYPEBALANCE: Transition in progress - book changed, Q3 update pending`);
                       // Use CustomFunctions.Error for proper #N/A display (Mac-safe)
                       if (typeof CustomFunctions !== 'undefined' && CustomFunctions.Error) {
                           throw new CustomFunctions.Error(
                               CustomFunctions.ErrorCode.notAvailable,
                               'Data not available - parameters updating'
                           );
                       } else {
                           // Fallback to regular Error if CustomFunctions not available
                           throw new Error('TRANSITION_IN_PROGRESS');
                       }
                   }
               } else {
                   // Stale transition flag - remove it
                   localStorage.removeItem(transitionKey);
               }
           }
       } catch (e) {
           // Ignore transition check errors, proceed to validation
       }
   }
   ```

2. **Enhanced Validation** (existing code, ~line 10343)
   - Keep existing validation logic
   - Throw Error for invalid combinations (already does this)
   - This will show #ERROR! or #VALUE! in Excel (acceptable per user)

3. **Execution Order** (critical):
   ```javascript
   // 1. Normalize parameters
   const subsidiaryStr = String(subsidiary || '').trim();
   const bookStr = String(accountingBook || '').trim();
   
   // 2. Check transition state FIRST (before anything else)
   // ... transition check code above ...
   
   // 3. Validate combination (existing code)
   const validationError = await validateSubsidiaryAccountingBook(subsidiaryStr, bookStr);
   if (validationError === 'INVALID_COMBINATION' || validationError === 'INVALID_BOOK') {
       // Use CustomFunctions.Error for proper #N/A display (Mac-safe)
       if (typeof CustomFunctions !== 'undefined' && CustomFunctions.Error) {
           throw new CustomFunctions.Error(
               CustomFunctions.ErrorCode.notAvailable,
               'Invalid book/subsidiary combination'
           );
       } else {
           // Fallback to regular Error if CustomFunctions not available
           throw new Error('INVALID_COMBINATION');
       }
   }
   
   // 4. NOW proceed with cache lookup and API calls (only if we get here)
   // ... rest of function ...
   ```

**Files to Modify**:
- `docs/functions.js`:
  - Line ~10336-10350: Add transition state check BEFORE validation
  - Keep existing validation and error throwing (no change needed)

**Expected Behavior**:
- When U3 changes, formulas immediately throw `CustomFunctions.Error` (show #N/A)
- Excel will automatically re-evaluate when Q3 is updated
- No poisoned cache entries created
- No backend queries executed with invalid parameters
- #N/A is the proper Excel error for "data not available" and is Mac-safe when using CustomFunctions.Error

---

### Phase 2: Force Recalculation After Q3 Update

**Goal**: Ensure Excel recalculates formulas immediately after Q3 is updated with correct subsidiary.

**Research Findings**:
- Excel.js API does **NOT** support programmatic control of calculation mode (Automatic/Manual)
- Excel.js API does **NOT** support suspending calculation during updates
- **Available**: `range.calculate(true)` forces recalculation of a specific range

**Implementation**:

1. **Force Recalculation After Q3 Update** (`docs/taskpane.html`, ~line 18063)
   ```javascript
   // After Q3 is updated (line ~18063)
   await Excel.run(async (context) => {
       const sheet = context.workbook.worksheets.getActiveWorksheet();
       const q3Cell = sheet.getRange("Q3");
       q3Cell.values = [[replacementSub]];
       await context.sync();
       
       // Force recalculation of all formulas that depend on Q3
       // This ensures formulas re-evaluate with the new subsidiary value
       const usedRange = sheet.getUsedRange();
       usedRange.load('address');
       await context.sync();
       
       // Force recalculation of the entire used range
       usedRange.calculate(true);
       await context.sync();
       
       console.log(`🔄 Forced recalculation of formulas after Q3 update`);
   });
   ```

2. **Alternative: Recalculate Only TYPEBALANCE Formulas**
   - More targeted approach - only recalculate cells with TYPEBALANCE formulas
   - Requires scanning for formulas, but more efficient
   ```javascript
   // After Q3 update, find and recalculate TYPEBALANCE formulas
   await Excel.run(async (context) => {
       const sheet = context.workbook.worksheets.getActiveWorksheet();
       const usedRange = sheet.getUsedRange();
       usedRange.load(['formulas', 'rowCount', 'columnCount']);
       await context.sync();
       
       const formulas = usedRange.formulas;
       const typebalanceCells = [];
       
       for (let row = 0; row < usedRange.rowCount; row++) {
           for (let col = 0; col < usedRange.columnCount; col++) {
               const formula = formulas[row][col];
               if (typeof formula === 'string' && formula.toUpperCase().includes('XAVI.TYPEBALANCE')) {
                   typebalanceCells.push(usedRange.getCell(row, col));
               }
           }
       }
       
       // Force recalculation of TYPEBALANCE formulas only
       for (const cell of typebalanceCells) {
           cell.calculate(true);
       }
       await context.sync();
       
       console.log(`🔄 Forced recalculation of ${typebalanceCells.length} TYPEBALANCE formulas`);
   });
   ```

**Files to Modify**:
- `docs/taskpane.html`: Add recalculation logic after Q3 update (~line 18063)

**Expected Behavior**:
- After Q3 is updated, Excel immediately recalculates affected formulas
- Formulas will hit the guard clause if still in transition, or proceed normally if transition complete
- Ensures formulas see the new Q3 value quickly

---

### Phase 3: Cache Invalidation as Safety Net

**Goal**: When Q3 or U3 is programmatically updated, immediately invalidate related cache entries as a defensive measure.

**Rationale**:
- **Primary protection**: Phase 1 (Guard Clause) prevents execution during invalid states, so cache invalidation is less critical
- **Safety net**: Cache invalidation ensures no stale data persists if guard clause somehow misses an edge case
- **Defensive programming**: Better to be safe than sorry - clear cache when parameters change

**Implementation**:

1. **Cache Invalidation Function** (`docs/functions.js`, add new function)
   ```javascript
   // Add to functions.js (around line 200, near other utility functions)
   function invalidateTypeBalanceCache(book, subsidiary) {
       // Clear in-memory cache
       if (cache.typebalance) {
           const keysToDelete = [];
           Object.keys(cache.typebalance).forEach(key => {
               if (book && key.includes(`:${book}:`)) {
                   keysToDelete.push(key);
               }
               if (subsidiary && key.includes(`:${subsidiary}:`)) {
                   keysToDelete.push(key);
               }
           });
           keysToDelete.forEach(key => delete cache.typebalance[key]);
           if (keysToDelete.length > 0) {
               console.log(`🗑️ Invalidated ${keysToDelete.length} TYPEBALANCE cache entries`);
           }
       }
       
       // Clear localStorage cache entries
       try {
           const stored = localStorage.getItem('netsuite_typebalance_cache');
           if (stored) {
               const storageData = JSON.parse(stored);
               const balances = storageData.balances || {};
               const newBalances = {};
               let removedCount = 0;
               
               Object.keys(balances).forEach(key => {
                   const shouldRemove = (book && key.includes(`:${book}:`)) ||
                                       (subsidiary && key.includes(`:${subsidiary}:`));
                   if (shouldRemove) {
                       removedCount++;
                   } else {
                       newBalances[key] = balances[key];
                   }
               });
               
               if (removedCount > 0) {
                   storageData.balances = newBalances;
                   storageData.timestamp = Date.now();
                   localStorage.setItem('netsuite_typebalance_cache', JSON.stringify(storageData));
                   console.log(`🗑️ Invalidated ${removedCount} localStorage TYPEBALANCE cache entries`);
               }
           }
       } catch (e) {
           console.warn('Cache invalidation error:', e.message);
       }
   }
   
   // Make it globally accessible for taskpane.html
   window.invalidateTypeBalanceCache = invalidateTypeBalanceCache;
   ```

2. **Call Invalidation on Q3 Update** (`docs/taskpane.html`, ~line 18063)
   ```javascript
   // After Q3 is updated (line ~18063)
   console.log(`✅ [CRITICAL FIX] Q3 updated to "${replacementSub}" - formulas will use valid combination`);
   
   // Invalidate cache for old subsidiary (safety net)
   if (window.invalidateTypeBalanceCache) {
       window.invalidateTypeBalanceCache(null, currentSubsidiary);
       console.log(`🗑️ Invalidated cache for old subsidiary: "${currentSubsidiary}"`);
   }
   ```

3. **Call Invalidation on U3 Change** (`docs/taskpane.html`, ~line 17908)
   ```javascript
   // When U3 changes (line ~17908, after reading previousU3Value)
   const previousU3Value = lastU3Value;
   lastU3Value = currentU3Value;
   
   // Invalidate cache for old book (safety net)
   if (previousU3Value && previousU3Value !== '1' && window.invalidateTypeBalanceCache) {
       window.invalidateTypeBalanceCache(previousU3Value, null);
       console.log(`🗑️ Invalidated cache for old book: ${previousU3Value}`);
   }
   ```

**Files to Modify**:
- `docs/functions.js`: Add `invalidateTypeBalanceCache()` function
- `docs/taskpane.html`: Call invalidation after Q3 and U3 updates

**Expected Behavior**:
- When Q3 is updated, all cache entries for old subsidiary are cleared (defensive measure)
- When U3 changes, all cache entries for old book are cleared (defensive measure)
- Even if guard clause somehow misses an edge case, stale cache won't be used

---

## Implementation Order

### Step 1: Implement Guard Clause (Phase 1) ⭐ **DO THIS FIRST**
- Add transition state check BEFORE validation in TYPEBALANCE
- Use `CustomFunctions.Error` with `ErrorCode.notAvailable` for #N/A
- Test: Changing book should show #N/A briefly, then resolve
- **This prevents the root cause** - no poisoned cache entries
- **This is the primary fix** - everything else is secondary

### Step 2: Implement Force Recalculation (Phase 2)
- Add recalculation after Q3 update
- Test: Formulas should recalculate immediately after Q3 update
- **This ensures formulas see new Q3 value quickly**

### Step 3: Implement Cache Invalidation (Phase 3) - Safety Net
- Add invalidation function
- Call on Q3 and U3 updates
- Test: Cache should be cleared when parameters change
- **This is a safety net** - guard clause should prevent most issues, but this adds defense-in-depth

---

## Testing Strategy

### Test Case 1: Book Change → #N/A → Correct Value
1. Start with Book 1, Subsidiary "Celigo Inc. (Consolidated)"
2. Change U3 to Book 2
3. **Expected**: Formulas show #N/A immediately (guard clause triggered)
4. **Expected**: Q3 updates to "Celigo India Pvt Ltd" (within 500ms)
5. **Expected**: Formulas automatically re-evaluate and show correct values (not $0.00)

### Test Case 2: Transition State Detection
1. Set transition flag manually in localStorage
2. Call TYPEBALANCE with old subsidiary
3. **Expected**: Returns CustomFunctions.Error immediately (no cache lookup, no API call)
4. **Expected**: Excel shows #N/A
5. Wait 6 seconds (transition expires)
6. **Expected**: Normal validation proceeds

### Test Case 3: Recalculation Timing
1. Change book from 1 to 2
2. Monitor console logs
3. **Expected**: Q3 update happens within 500ms
4. **Expected**: Recalculation triggered immediately after Q3 update
5. **Expected**: Formulas resolve within 1-2 seconds total

### Test Case 4: Cache Invalidation (Safety Net)
1. Load report with Book 1, get revenue values (cache populated)
2. Change to Book 2
3. **Expected**: Cache for Book 1 is invalidated (safety net)
4. **Expected**: New cache entries created for Book 2
5. **Expected**: No stale Book 1 values appear

---

## Error Display Behavior

**Proper #N/A Implementation**:
- **Correct Approach**: Use `CustomFunctions.Error` with `ErrorCode.notAvailable` to return #N/A from `Promise<number>` functions
- **Why This Works**: `CustomFunctions.Error` is a special Error object that Excel recognizes, allowing #N/A without violating the Promise contract
- **Mac-Safe**: This is the official Microsoft API for returning #N/A from custom functions, and it's safe on Mac
- **Fallback**: If `CustomFunctions.Error` is not available, fall back to regular `Error` (shows #ERROR!)

**Implementation**:
```javascript
// Proper way to return #N/A from Promise<number> function
if (typeof CustomFunctions !== 'undefined' && CustomFunctions.Error) {
    throw new CustomFunctions.Error(
        CustomFunctions.ErrorCode.notAvailable,
        'Data not available - parameters updating'
    );
} else {
    // Fallback if CustomFunctions not available
    throw new Error('TRANSITION_IN_PROGRESS');
}
```

**Why #N/A is Better**:
- #N/A is the standard Excel error for "data not available"
- More intuitive for users than #ERROR! or #VALUE!
- Excel automatically re-evaluates when parameters become valid
- Proper use of CustomFunctions.Error maintains Promise contract (Mac-safe)

---

## Code Locations Summary

| Component | File | Lines | Action |
|-----------|------|-------|--------|
| **Transition Check** | `docs/functions.js` | ~10336-10350 | Add BEFORE validation |
| **Force Recalculation** | `docs/taskpane.html` | ~18063 | Add after Q3 update |
| **Cache Invalidation Function** | `docs/functions.js` | ~200 (new) | Add new function |
| **Q3 Update** | `docs/taskpane.html` | ~18063 | Add invalidation call |
| **U3 Change** | `docs/taskpane.html` | ~17908 | Add invalidation call |

---

## Success Criteria

After implementation:
- ✅ Changing Accounting Book never results in persistent $0.00 values
- ✅ No cache clearing or formula re-entry required
- ✅ Formulas may briefly show #ERROR! or #VALUE! but resolve deterministically
- ✅ Behavior matches fresh formula entry/drag-fill
- ✅ No Excel for Mac crashes or type errors
- ✅ All account types (Income, COGS, Expense) work correctly

---

## Risk Assessment

### Low Risk ✅
- **Guard Clause**: Straightforward implementation, prevents root cause
- **Force Recalculation**: Standard Excel.js API call
- **Cache Invalidation**: Simple function, well-understood pattern (safety net)

### No High Risk Items
- All approaches use standard Excel.js APIs
- No experimental or unsupported features
- Error handling follows established patterns

---

## Next Steps

1. **Implement Phase 1 (Guard Clause)** - This is the critical fix
2. **Test Phase 1** - Verify #ERROR! appears and resolves correctly
3. **Implement Phase 2 (Force Recalculation)** - Improve timing
4. **Implement Phase 3 (Cache Invalidation)** - Add safety net
5. **End-to-End Testing** - Test all scenarios with real data

---

## Notes

- **#N/A Implementation**: Using `CustomFunctions.Error` with `ErrorCode.notAvailable` is the proper way to return #N/A from `Promise<number>` functions. This is Mac-safe and maintains the Promise contract.
- **CustomFunctions API**: The `CustomFunctions.Error` object is part of the Office.js API and should be available when custom functions are registered. We include a fallback to regular `Error` if it's not available.
- **Calculation Mode**: Excel.js doesn't support programmatic control, so we use transition flags + force recalculation
- **Timing**: Transition flag window (5 seconds) may need adjustment based on testing
- **Cache Keys**: Already correct, no changes needed
- **Phase Order Rationale**: Guard clause prevents execution (primary fix), force recalculation ensures timing (secondary), cache invalidation is safety net (tertiary)
