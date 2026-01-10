# Guard Clause Implementation Summary

## Overview

Implemented a state-based guard clause in `TYPEBALANCE` that prevents execution during invalid parameter states (Accounting Book changed but Subsidiary not yet updated). This addresses all concerns raised by GPT.

---

## Concerns Addressed

### 1. ✅ Native Excel Error vs Text (CRITICAL)

**Concern**: #N/A must be returned as native Excel error object, not string.

**Implementation**:
- Uses `CustomFunctions.Error(CustomFunctions.ErrorCode.notAvailable)` - proper native Excel error
- No string returns anywhere in the code path
- Fallback returns `undefined` (Excel displays as #N/A) instead of throwing Error

**Code Location**: `docs/functions.js` lines 10367-10374, 10397-10403, 10407-10413

---

### 2. ✅ Error Message Stability (IMPORTANT)

**Concern**: Dynamic error messages can cause recalculation instability.

**Implementation**:
- **No message parameter** - `CustomFunctions.Error(CustomFunctions.ErrorCode.notAvailable)` with no message
- Static, consistent error object across all recalculations
- No dynamic strings that could change

**Code Location**: `docs/functions.js` lines 10368, 10398, 10408

---

### 3. ✅ Backend Execution and Caching (CRITICAL)

**Concern**: Backend query must not run, cache must not be written when returning #N/A.

**Implementation**:
- Guard clause is placed **BEFORE** validation, cache lookup, and API calls
- Short-circuits execution immediately when invalid state detected
- No cache writes possible because execution never reaches cache code
- No API calls possible because execution never reaches API code

**Code Location**: `docs/functions.js` lines 10342-10391 (guard clause), 10392+ (validation/cache/API)

**Execution Order**:
1. Normalize parameters
2. **GUARD CLAUSE** (returns #N/A if invalid state) ← **STOPS HERE**
3. Validation
4. Cache lookup
5. API calls

---

### 4. ✅ Fallback Behavior on Mac (IMPORTANT)

**Concern**: Throwing regular Error on Mac reintroduces crash risk.

**Implementation**:
- Fallback returns `undefined` instead of throwing `Error`
- Excel displays `undefined` as #N/A in Promise<number> functions (Mac-safe)
- No Error objects thrown in fallback path

**Code Location**: `docs/functions.js` lines 10370-10373, 10400-10402, 10410-10412

**Fallback Logic**:
```javascript
if (typeof CustomFunctions !== 'undefined' && CustomFunctions.Error && CustomFunctions.ErrorCode) {
    throw new CustomFunctions.Error(CustomFunctions.ErrorCode.notAvailable);
} else {
    // Fallback: Return undefined (safer on Mac than throwing Error)
    return undefined;
}
```

---

### 5. ✅ State-Based Guard Logic (CRITICAL)

**Concern**: Time-based windows are fragile. Guard should unlock when (book, subsidiary) are confirmed compatible.

**Implementation**:
- **State-based check**: Compares current subsidiary to `oldSubsidiary` and `newSubsidiary` from transition flag
- **Unlocks when**: Current subsidiary matches `newSubsidiary` (transition complete)
- **Time-based failsafe**: Only removes stale flags (>10s), not primary condition

**Code Location**: `docs/functions.js` lines 10356-10383

**State Logic**:
```javascript
const isOldSubsidiary = subsidiaryStr === transition.oldSubsidiary;
const isNewSubsidiary = transition.newSubsidiary && subsidiaryStr === transition.newSubsidiary;

if (isOldSubsidiary && !isNewSubsidiary) {
    // Invalid state - return #N/A
} else if (isNewSubsidiary) {
    // Valid state - clear flag, proceed
} else if (age > 10000) {
    // Stale flag - remove (failsafe only)
}
```

**Transition Flag Structure**:
```javascript
{
    timestamp: Date.now(),
    oldSubsidiary: "Celigo Inc. (Consolidated)",  // Invalid for new book
    newBook: "2",
    newSubsidiary: "Celigo India Pvt Ltd"  // Valid for new book
}
```

---

### 6. ✅ Recalculation Sequencing (IMPORTANT)

**Concern**: Recalculation must happen after parameters are stable, guard must allow execution at that point.

**Implementation**:
- Transition flag is updated with `newSubsidiary` **before** Q3 is updated
- When Q3 is updated, formulas see new subsidiary value
- Guard clause detects `newSubsidiary` match and **automatically clears flag**
- Recalculation happens after Q3 update, guard already allows execution

**Code Location**: 
- `docs/taskpane.html` lines 18037-18047 (update transition flag with newSubsidiary)
- `docs/functions.js` lines 10375-10378 (guard detects newSubsidiary and clears flag)

**Sequence**:
1. U3 changes → transition flag set with `oldSubsidiary`
2. Fetch valid subsidiaries → update flag with `newSubsidiary`
3. Update Q3 with `newSubsidiary`
4. Excel recalculates → guard sees `newSubsidiary` match → clears flag → proceeds normally

---

## Implementation Details

### Guard Clause Location

**File**: `docs/functions.js`  
**Lines**: 10342-10391  
**Position**: **BEFORE** validation, cache lookup, and API calls

### Transition Flag Management

**File**: `docs/taskpane.html`  
**Lines**: 17977-18047

**Flag Structure**:
```javascript
{
    timestamp: number,
    oldSubsidiary: string,    // Invalid for new book
    newBook: string,          // New accounting book ID
    newSubsidiary: string     // Valid for new book (set when determined)
}
```

**Flag Lifecycle**:
1. **Set**: When U3 changes, includes `oldSubsidiary` and `newBook`
2. **Updated**: When valid subsidiary determined, adds `newSubsidiary`
3. **Cleared**: Automatically when guard detects `newSubsidiary` match (or failsafe after 10s)

---

## Testing Checklist

- [ ] Change Accounting Book from 1 to 2
  - [ ] Formulas show #N/A immediately (guard triggered)
  - [ ] Q3 updates to valid subsidiary
  - [ ] Formulas automatically resolve to correct values
  - [ ] No $0.00 values persist

- [ ] Verify no cache writes during guard
  - [ ] Check localStorage - no entries with old subsidiary for new book
  - [ ] Check console - no API calls logged during guard

- [ ] Verify state-based unlocking
  - [ ] Set transition flag manually
  - [ ] Call TYPEBALANCE with old subsidiary → #N/A
  - [ ] Call TYPEBALANCE with new subsidiary → proceeds normally

- [ ] Verify Mac safety
  - [ ] Test on Excel for Mac
  - [ ] No crashes when CustomFunctions.Error not available
  - [ ] #N/A displays correctly in all cases

---

## Success Criteria

✅ Changing Accounting Book never produces persistent zero values  
✅ Formulas may briefly show #N/A  
✅ Values resolve deterministically once parameters stabilize  
✅ No cache clearing or formula re-entry required  
✅ No Excel for Mac crashes or recalc loops  
✅ All account types (Income, COGS, Expense) work correctly

---

## Code Changes Summary

### `docs/functions.js`
- **Lines 10342-10391**: Added state-based guard clause BEFORE validation/cache/API
- **Lines 10393-10414**: Updated validation errors to use CustomFunctions.Error with undefined fallback

### `docs/taskpane.html`
- **Lines 17977-17985**: Updated transition flag to include `newSubsidiary` field
- **Lines 18037-18047**: Update transition flag with `newSubsidiary` when determined
- **Lines 18063-18069**: Removed timeout-based flag clearing (now state-based)

---

## Notes

- **No string returns**: All error paths use CustomFunctions.Error or undefined
- **No dynamic messages**: Error objects have no message parameter
- **State-based**: Guard unlocks based on subsidiary match, not time
- **Mac-safe fallback**: Returns undefined instead of throwing Error
- **Execution order**: Guard is first, prevents all downstream execution

