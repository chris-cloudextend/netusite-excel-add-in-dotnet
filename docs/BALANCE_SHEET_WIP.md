# Balance Sheet Report - Work In Progress

**Status:** ⚠️ Work in Progress - To Be Revisited  
**Last Updated:** 2025-01-22  
**Version:** 3.0.5.285

## Overview

The Balance Sheet report generation is partially implemented with hierarchical structure support, but several issues remain that need to be addressed in a future iteration.

## Intended Structure

The Balance Sheet should match NetSuite's structure:

```
ASSETS (Section Header - Green)
  Current Assets (Subsection Header - Gray)
    Bank (Type Header - Light Gray, Bold)
      10000 - Chase Checking (Account Row with XAVI.BALANCE formula)
      10001 - Chase Money Market (Account Row)
      ...
      Total Bank (Type Subtotal - SUBTOTAL formula)
    Accounts Receivable (Type Header)
      11000 - Accounts Receivable (Account Row)
      15000 - InterCompany Accounts Receivable (Parent Header - if has children)
        15200 - InterCompany Receivable-India-US (Child Account)
        15500 - InterCompany Receivable US US - UK (Child Account)
        Total 15000 - InterCompany Accounts Receivable (Parent Subtotal)
      Total Accounts Receivable (Type Subtotal)
    ...
  Fixed Assets (Subsection Header)
    ...
  TOTAL ASSETS (Section Total - SUBTOTAL formula)

LIABILITIES (Section Header - Red)
  Current Liabilities (Subsection Header)
    ...
  TOTAL LIABILITIES (Section Total)

EQUITY (Section Header - Blue)
  ...
  TOTAL EQUITY (Section Total)
```

## What Has Been Implemented

### Backend (BalanceController.cs)

1. **Hierarchical Structure Building**
   - Section → Subsection → Type → Account hierarchy
   - Parent-child account relationships tracked
   - Type headers generated for each account type (Bank, Accounts Receivable, etc.)
   - Parent headers generated for accounts with children
   - Type subtotals calculated and included

2. **Account Type Ordering**
   - Current Assets: Bank (1), AcctRec (2), OthCurrAsset (3), DeferExpense (4), UnbilledRec (5)
   - Fixed Assets: FixedAsset (1)
   - Current Liabilities: AcctPay (1), CredCard (2), OthCurrLiab (3), DeferRevenue (4)
   - Long Term Liabilities: LongTermLiab (1)
   - Equity: Equity (1), RetainedEarnings (2)

3. **Parent Account Handling**
   - Parent accounts with children are marked as `IsParentHeader = true`
   - If parent has balance, creates both header row and account row
   - Parent subtotals calculated for children

4. **Data Fetching**
   - Includes all accounts from `bs_preload` (including zero-balance accounts)
   - Fetches parent accounts even if they have zero balance (if they have children)
   - Account hierarchy built from NetSuite's `account.parent` field

### Frontend (taskpane.html)

1. **Section Headers**
   - `addSectionHeader()` function renders section headers (ASSETS, LIABILITIES, EQUITY)
   - Color-coded: Assets (green), Liabilities (red), Equity (blue)
   - Section totals use SUBTOTAL formulas

2. **Subsection Headers**
   - `addSubsectionHeader()` function renders subsection headers (Current Assets, Fixed Assets, etc.)
   - Gray background, bold text
   - Subsection subtotals can be added (currently commented/optional)

3. **Type Headers**
   - Type headers (Bank, Accounts Receivable, etc.) rendered with light gray background
   - Bold, size 11 font
   - No formula (just labels)
   - `context.sync()` added after type headers to prevent errors

4. **Account Rows**
   - Regular accounts use `XAVI.BALANCE` formulas
   - Indentation based on `level` property
   - Error handling: writes `#ERROR` to cell if formula fails, continues processing

5. **Subtotals**
   - Type subtotals: Use SUBTOTAL formulas with `typeRowRanges` tracking
   - Parent subtotals: Use SUBTOTAL formulas with `childRowRanges` tracking
   - Both track start/end rows for correct formula ranges

6. **Debug Logging**
   - Added console logs for:
     - Section header addition: `📑 Adding section header`
     - Subsection header addition: `📋 Adding subsection header`
     - Type header addition: `🏷️ Adding type header`

## Known Issues

### Issue 1: First Account in Each Type Section Shows #ERROR
**Status:** Partially Fixed  
**Description:** The first account after a type header sometimes shows `#ERROR` instead of the balance.

**Attempted Fixes:**
- Added `context.sync()` after type headers to ensure they're committed before adding accounts
- Added error handling to write `#ERROR` and continue processing

**Remaining Work:**
- May need to add additional sync points or delay before first account
- Could be related to Excel formula evaluation timing
- May need to batch type header + first account together

### Issue 2: Extra Spacing Between Sections
**Status:** Needs Investigation  
**Description:** There may be extra blank rows between sections that shouldn't be there.

**Current Implementation:**
- One blank row added after section totals (`currentRow += 1`)
- Section headers merge cells A-C

**Remaining Work:**
- Verify spacing matches NetSuite output exactly
- Check if subsection headers are adding extra space
- Review blank row logic after section totals

### Issue 3: Hierarchy Not Fully Reflected in Excel
**Status:** Partially Implemented  
**Description:** The hierarchy structure (Section → Subsection → Type → Parent → Children) may not be rendering correctly in Excel.

**Current Implementation:**
- Backend sends rows in correct hierarchical order
- Frontend has logic to detect section/subsection/type changes
- Type headers are rendered
- Parent headers are rendered

**Remaining Work:**
- Verify subsection headers are being added correctly
- Check if parent headers are showing when they should
- Ensure children are properly indented under parents
- Verify type subtotals are calculating correctly
- Test with real NetSuite data to compare structure

### Issue 4: Type Subtotals May Not Be Calculating Correctly
**Status:** Needs Testing  
**Description:** Type subtotals (e.g., "Total Bank") may not be using correct row ranges in SUBTOTAL formulas.

**Current Implementation:**
- `typeRowRanges` Map tracks start/end rows for each account type
- Type subtotals use `SUBTOTAL(109, C{start}:C{end})` formulas
- Range tracking updated as accounts are added

**Remaining Work:**
- Verify `typeRowRanges` is being populated correctly
- Test SUBTOTAL formulas with actual data
- Ensure ranges exclude type headers and include all accounts of that type
- Check if parent accounts with balances are included in type totals

### Issue 5: Parent Account Handling
**Status:** Partially Implemented  
**Description:** Parent accounts that have both children and balances may not be rendering correctly.

**Current Implementation:**
- Backend creates two rows for parent accounts with balances:
  1. Header row (`IsParentHeader = true`, `Source = "ParentHeader"`, `Balance = 0`)
  2. Account row (`IsParentHeader = false`, `Source = "Account"`, `Balance = actual balance`)

**Remaining Work:**
- Verify both rows are rendering correctly
- Ensure parent account row appears after header, before children
- Test parent subtotals are calculating correctly
- Check if parent account balance is included in type totals

## Code Locations

### Backend
- **Main Controller:** `backend-dotnet/Controllers/BalanceController.cs`
  - `GenerateBalanceSheetReport()` method (line ~1100)
  - `AddAccountHierarchy()` recursive function (line ~1474)
  - Hierarchy building logic (line ~1567-1789)

### Frontend
- **Main Logic:** `docs/taskpane.html`
  - `generateBalanceSheetReport()` function (line ~10596)
  - `addAccountRow()` function (line ~10941)
  - Section/subsection/type header rendering (line ~11280-11407)

### Models
- **Balance Models:** `backend-dotnet/Models/BalanceModels.cs`
  - `BalanceSheetRow` class with hierarchy properties:
    - `IsParentHeader`
    - `IsSubtotal`
    - `IsTypeHeader`
    - `TypeCategory`
    - `SubtotalFor`
    - `Level`

## Testing Checklist (For Future Work)

- [ ] Verify section headers appear correctly (ASSETS, LIABILITIES, EQUITY)
- [ ] Verify subsection headers appear correctly (Current Assets, Fixed Assets, etc.)
- [ ] Verify type headers appear correctly (Bank, Accounts Receivable, etc.)
- [ ] Verify first account in each type section does NOT show #ERROR
- [ ] Verify spacing between sections matches NetSuite (no extra blank rows)
- [ ] Verify parent headers appear when accounts have children
- [ ] Verify children are properly indented under parents
- [ ] Verify parent subtotals calculate correctly
- [ ] Verify type subtotals calculate correctly (e.g., "Total Bank")
- [ ] Verify section totals calculate correctly
- [ ] Compare full structure with NetSuite Balance Sheet report
- [ ] Test with accounts that have zero balances
- [ ] Test with accounts that have parents but no children
- [ ] Test with accounts that are parents AND have balances

## Debugging Tips

1. **Check Console Logs:**
   - Look for `📑 Adding section header`
   - Look for `📋 Adding subsection header`
   - Look for `🏷️ Adding type header`
   - These confirm the hierarchy is being detected

2. **Check Excel Formulas:**
   - Type subtotals should use: `=SUBTOTAL(109, C{start}:C{end})`
   - Parent subtotals should use: `=SUBTOTAL(109, C{start}:C{end})`
   - Account rows should use: `=XAVI.BALANCE("account", , $D$2)`

3. **Check Row Ranges:**
   - `typeRowRanges` Map should have entries for each account type
   - `childRowRanges` Map should have entries for each parent account
   - Ranges should have both `startRow` and `endRow` set

4. **Compare with NetSuite:**
   - Export Balance Sheet from NetSuite
   - Compare structure row-by-row
   - Note any differences in hierarchy, spacing, or totals

## Related Files

- `BALANCE_SHEET_HIERARCHY_DESIGN.md` - Original design document
- `excel-addin/manifest-claude.xml` - Manifest with version 3.0.5.285
- `docs/functions.js` - XAVI.BALANCE custom function implementation

## Notes for Future Development

1. **Priority:** Fix Issue 1 (first account #ERROR) as it affects data accuracy
2. **Priority:** Verify Issue 3 (hierarchy structure) matches NetSuite exactly
3. **Consider:** Adding visual indicators (icons, borders) to make hierarchy more obvious
4. **Consider:** Adding expand/collapse functionality for parent accounts (future enhancement)
5. **Consider:** Adding subsection subtotals if NetSuite shows them

## Version History

- **3.0.5.285** - Added debug logging, fixed type subtotal formulas, added sync after type headers
- **3.0.5.284** - Initial hierarchy implementation with type headers and parent headers
- **3.0.5.283** - Previous version before hierarchy work

---

**Next Steps When Revisiting:**
1. Test with real NetSuite data
2. Compare output structure with NetSuite Balance Sheet
3. Fix remaining issues one by one
4. Add comprehensive tests
5. Update documentation with final structure

