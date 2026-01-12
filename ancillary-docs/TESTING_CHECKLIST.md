# Testing Checklist: Guard Clause Implementation (v4.0.6.77)

## Pre-Testing Setup

### ✅ 1. Code Changes
- [x] Guard clause implemented in `docs/functions.js` (lines 10342-10391)
- [x] Transition flag management updated in `docs/taskpane.html` (lines 17977-18069)
- [x] Version updated to `4.0.6.77` in all files

### ✅ 2. Version Updates (Cache Busting)
- [x] `docs/functions.js` - FUNCTIONS_VERSION = '4.0.6.77'
- [x] `excel-addin/manifest.xml` - Version tag and all ?v= URLs
- [x] `docs/taskpane.html` - functions.js script src
- [x] `docs/sharedruntime.html` - functions.js script src
- [x] `docs/functions.html` - functions.js script src

### ⏳ 3. Git Push
- [ ] Commit changes
- [ ] Push to GitHub (main branch)
- [ ] Wait for GitHub Pages deployment (~2-3 minutes)
- [ ] Verify deployment at: https://github.com/chris-cloudextend/netusite-excel-add-in-dotnet/actions

### ⏳ 4. Server Status
- [ ] **NO SERVER RESTART NEEDED** - These are frontend JavaScript changes only
- [ ] Backend server can continue running (no changes to backend code)

### ⏳ 5. Excel Cache Clear (Recommended)
- [ ] Close Excel completely
- [ ] Run `./excel-addin/useful-commands/clear-excel-cache.sh` (if on Mac)
- [ ] Or manually clear Excel caches
- [ ] Reopen Excel

### ⏳ 6. Add-in Reload
- [ ] Remove existing add-in from Excel
- [ ] Re-add add-in using updated manifest.xml
- [ ] Or: Excel should auto-reload if manifest URL changed

---

## Testing Scenarios

### Test 1: Basic Book Change → #N/A → Correct Values

**Steps**:
1. Open CFO Flash Report with Book 1, Subsidiary "Celigo Inc. (Consolidated)"
2. Verify revenue values are displayed correctly
3. Change U3 (Accounting Book) from "1" to "2"
4. **Expected**: 
   - Formulas immediately show #N/A (guard clause triggered)
   - "Updating Accounting Book" overlay appears
   - Q3 updates to "Celigo India Pvt Ltd" (within 500ms)
   - Formulas automatically resolve to correct values (not $0.00)
   - No persistent zero values

**Console Checks**:
- Look for: `⏸️ TYPEBALANCE: Transition in progress`
- Look for: `🔒 [GUARD CLAUSE] Set transition flag`
- Look for: `✅ TYPEBALANCE: Transition complete`

---

### Test 2: Verify No Cache Writes During Guard

**Steps**:
1. Open Developer Tools → Application → Local Storage
2. Note current cache entries count
3. Change Accounting Book from 1 to 2
4. **Expected**:
   - Formulas show #N/A immediately
   - Check localStorage - NO new entries with old subsidiary for new book
   - Console shows no API calls during guard period

**Console Checks**:
- Should NOT see: `📋 TYPEBALANCE cache hit` during guard
- Should NOT see: API fetch logs during guard
- Should see: `⏸️ TYPEBALANCE: Transition in progress` (execution stopped)

---

### Test 3: State-Based Guard Unlocking

**Steps**:
1. Change Accounting Book from 1 to 2
2. Monitor console logs
3. **Expected**:
   - Guard detects old subsidiary → returns #N/A
   - Q3 updates to new subsidiary
   - Guard detects new subsidiary match → clears flag automatically
   - Formulas proceed normally

**Console Checks**:
- Look for: `🔒 [GUARD CLAUSE] Updated transition flag - newSub: "Celigo India Pvt Ltd"`
- Look for: `✅ TYPEBALANCE: Transition complete - subsidiary updated to "Celigo India Pvt Ltd"`
- Should NOT see: Timeout-based flag clearing (no 5-second delay)

---

### Test 4: Mac Safety (if testing on Mac)

**Steps**:
1. Test on Excel for Mac
2. Change Accounting Book multiple times rapidly
3. **Expected**:
   - No crashes
   - #N/A displays correctly
   - No type errors in console

**Console Checks**:
- If CustomFunctions.Error not available, should see: `⚠️ CustomFunctions.Error not available, returning undefined`
- Excel should still display #N/A correctly

---

### Test 5: All Account Types

**Steps**:
1. Change Accounting Book from 1 to 2
2. Verify all P&L account types resolve correctly:
   - Revenue (Income)
   - COGS
   - Operating Expenses
   - Other Income
   - Other Expenses
3. **Expected**: All types show #N/A briefly, then resolve to correct values

---

### Test 6: Rapid Book Changes

**Steps**:
1. Change Book 1 → 2 → 1 → 2 rapidly
2. **Expected**:
   - Each change shows #N/A briefly
   - No crashes or errors
   - Final state resolves correctly

---

## Success Criteria

✅ Changing Accounting Book never produces persistent $0.00 values  
✅ Formulas may briefly show #N/A but resolve deterministically  
✅ No cache clearing or formula re-entry required  
✅ No Excel for Mac crashes or recalc loops  
✅ All account types (Income, COGS, Expense) work correctly  
✅ Guard clause prevents execution during invalid states  
✅ State-based unlocking works correctly  

---

## Troubleshooting

### Issue: Formulas still show $0.00
- **Check**: Console for guard clause logs
- **Check**: Transition flag in localStorage
- **Fix**: Clear Excel cache and reload add-in

### Issue: #N/A doesn't appear
- **Check**: CustomFunctions.Error availability in console
- **Check**: Version number matches (4.0.6.77)
- **Fix**: Verify manifest.xml is updated and deployed

### Issue: Formulas stuck on #N/A
- **Check**: Transition flag in localStorage - should auto-clear
- **Check**: Q3 was updated correctly
- **Fix**: Manually clear transition flag: `localStorage.removeItem('netsuite_book_transition_2')`

---

## Post-Testing

- [ ] Document any issues found
- [ ] Verify all success criteria met
- [ ] Update version number if fixes needed
- [ ] Push final version to git

