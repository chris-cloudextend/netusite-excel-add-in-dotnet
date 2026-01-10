# Subsidiary Selection Modal Implementation Plan

## Overview
Replace the automatic subsidiary update with a user-driven modal dialog that:
1. Shows #N/A immediately when accounting book changes (guard clause)
2. Displays a modal dialog asking user to select a valid subsidiary
3. Filters dropdown to only show subsidiaries valid for the selected book
4. User selects subsidiary and clicks "Continue"
5. Updates Q3 and triggers recalculation

## Benefits
- **No timing issues**: User controls when recalculation starts
- **Clear UX**: User explicitly selects the subsidiary they want
- **No race conditions**: Formulas stay at #N/A until user confirms selection
- **Simpler code**: No complex auto-update logic

## Implementation Steps

### 1. Add Modal CSS Styles
Add styles for the subsidiary selection modal dialog.

### 2. Create Modal Function
Create `showSubsidiarySelectionModal(accountingBookId, currentSubsidiary, enabledSubsidiaries)` function.

### 3. Modify handleSheetChange for U3
When U3 changes:
- Set guard clause flag (formulas show #N/A)
- Fetch enabled subsidiaries
- Show modal dialog
- Wait for user selection
- Update Q3
- Clear guard clause
- Trigger recalculation

### 4. Remove Auto-Update Logic
Remove the automatic Q3 update logic - user will select manually.

## Modal Dialog Design
- Title: "Select Subsidiary for Accounting Book [Name]"
- Message: "Please select a subsidiary that is enabled for this accounting book."
- Dropdown: Filtered list of valid subsidiaries
- Buttons: "Continue" (primary) and "Cancel" (secondary)
- Behavior: Modal blocks all interaction until user selects and clicks Continue

