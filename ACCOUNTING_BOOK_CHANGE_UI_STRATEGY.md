# UI Strategy for Accounting Book Changes in Income Statement & CFO Flash Report

## Problem Statement

**Current Flow:**
1. Income Statement / CFO Flash Report generated with:
   - U3 = "1" (Primary Book)
   - Q3 = Top-level parent subsidiary (e.g., "Celigo Inc. (Consolidated)")

2. User changes U3 to Book 2 (e.g., "2")

3. **Problem:** Excel formulas fire immediately with:
   - Book 2
   - Q3 = Top-level parent subsidiary (which may NOT be enabled for Book 2)

**NetSuite Rule Violation:**
- If top-level parent is not enabled for Book 2, formulas will fail or return incorrect data
- Even if parent has children enabled, if parent itself isn't enabled, it must be excluded

## Proposed Solution: Smart Auto-Correction with User Awareness

### Strategy Overview

When accounting book changes, we need to:
1. **Immediately validate** current Q3 subsidiary against new book
2. **Auto-correct** if invalid, but make it obvious to the user
3. **Prevent formula execution** until valid combination exists
4. **Provide clear feedback** about what changed and why

### Implementation Approach

#### Phase 1: Immediate Validation & Auto-Correction (On U3 Change)

**Location:** `handleAccountingBookChange()` function

**Flow:**
```
1. User changes U3 (accounting book)
2. Read current Q3 (subsidiary)
3. Fetch book-scoped subsidiaries for new book
4. Validate Q3 against enabled list
5. If invalid:
   a. Find best replacement (see logic below)
   b. Update Q3 immediately
   c. Show prominent notification
   d. Clear all caches
   e. Prevent sync until user acknowledges
6. If valid:
   a. Filter subsidiary dropdown
   b. Clear caches
   c. Trigger sync
```

#### Phase 2: Best Replacement Logic

**When Q3 is invalid, choose replacement in this priority:**

1. **Single-subsidiary book:**
   - If book has exactly one enabled subsidiary → use that one
   - No consolidation option

2. **Most common subsidiary:**
   - If book has multiple enabled subsidiaries → use the one with most transactions
   - This matches current `GetSubsidiaryForAccountingBookAsync` logic

3. **First enabled subsidiary:**
   - Fallback if transaction count unavailable
   - Alphabetically first enabled subsidiary

4. **Consolidation preference:**
   - If replacement has children enabled → prefer consolidated version
   - Otherwise → use base subsidiary

**Code Logic:**
```javascript
async function findBestReplacementSubsidiary(accountingBookId, currentSubsidiary) {
    try {
        // Get book-scoped subsidiaries
        const response = await fetch(`${getServerUrl()}/lookups/accountingbook/${accountingBookId}/subsidiaries`);
        if (!response.ok) {
            return null;
        }
        
        const data = await response.json();
        
        if (data.allSubsidiaries) {
            // Primary Book - current subsidiary is valid
            return currentSubsidiary;
        }
        
        const enabledSubs = data.subsidiaries || [];
        
        if (enabledSubs.length === 0) {
            // No subsidiaries enabled - this is an error state
            return null;
        }
        
        // Case 1: Single-subsidiary book
        if (enabledSubs.length === 1) {
            const single = enabledSubs[0];
            return single.name; // No consolidation for single-subsidiary books
        }
        
        // Case 2: Multiple subsidiaries - get most common one
        const mostCommonResponse = await fetch(`${getServerUrl()}/lookups/accountingbook/${accountingBookId}/subsidiary`);
        if (mostCommonResponse.ok) {
            const mostCommonData = await mostCommonResponse.json();
            if (mostCommonData.subsidiaryId) {
                const mostCommon = enabledSubs.find(s => s.id === mostCommonData.subsidiaryId);
                if (mostCommon) {
                    // Prefer consolidated if available
                    if (mostCommon.canConsolidate) {
                        return `${mostCommon.name} (Consolidated)`;
                    }
                    return mostCommon.name;
                }
            }
        }
        
        // Case 3: Fallback to first enabled subsidiary
        const first = enabledSubs[0];
        if (first.canConsolidate) {
            return `${first.name} (Consolidated)`;
        }
        return first.name;
        
    } catch (e) {
        console.error('Error finding replacement subsidiary:', e);
        return null;
    }
}
```

#### Phase 3: User Notification Strategy

**When Q3 is auto-updated, show:**

1. **Persistent Warning Banner** (in task pane `refreshStatus` area):
   ```
   ⚠️ Accounting Book Changed
   
   The subsidiary was automatically updated from "Celigo Inc. (Consolidated)" 
   to "Celigo India" because the previous selection is not enabled for 
   Accounting Book 2.
   
   [Dismiss] [Review Changes]
   ```

2. **Toast Notification** (temporary, 8 seconds):
   ```
   ⚠️ Subsidiary Auto-Updated
   Changed to "Celigo India" for Accounting Book 2
   ```

3. **Visual Indicator in Q3 Cell** (optional):
   - Highlight Q3 cell with yellow background
   - Add comment: "Auto-updated due to accounting book change"

**Implementation:**
```javascript
async function showSubsidiaryAutoUpdateNotification(oldSub, newSub, accountingBookId, accountingBookName) {
    // 1. Persistent warning in task pane
    const refreshStatus = document.getElementById('refreshStatus');
    if (refreshStatus) {
        refreshStatus.innerHTML = `
            <div class="alert alert-warning" style="margin: 10px 0; padding: 12px; border-left: 4px solid #ff9800;">
                <div style="display: flex; align-items: center; gap: 8px;">
                    <span style="font-size: 18px;">⚠️</span>
                    <div style="flex: 1;">
                        <strong>Accounting Book Changed</strong>
                        <p style="margin: 8px 0 0 0; font-size: 13px;">
                            The subsidiary was automatically updated from 
                            <strong>"${oldSub}"</strong> to <strong>"${newSub}"</strong> 
                            because the previous selection is not enabled for 
                            <strong>${accountingBookName}</strong>.
                        </p>
                        <div style="margin-top: 8px;">
                            <button onclick="this.parentElement.parentElement.parentElement.remove()" 
                                    style="padding: 4px 12px; background: #ff9800; color: white; border: none; border-radius: 4px; cursor: pointer;">
                                Dismiss
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }
    
    // 2. Toast notification
    showToast({
        title: '⚠️ Subsidiary Auto-Updated',
        message: `Changed from "${oldSub}" to "${newSub}" for ${accountingBookName}`,
        type: 'warning',
        icon: '⚠️',
        duration: 8000
    });
    
    // 3. Highlight Q3 cell (optional)
    try {
        await Excel.run(async (context) => {
            const sheet = context.workbook.worksheets.getActiveWorksheet();
            const q3Cell = sheet.getRange("Q3");
            q3Cell.format.fill.color = "#fff3cd"; // Light yellow
            await context.sync();
            
            // Remove highlight after 5 seconds
            setTimeout(async () => {
                try {
                    await Excel.run(async (context) => {
                        const sheet = context.workbook.worksheets.getActiveWorksheet();
                        const q3Cell = sheet.getRange("Q3");
                        q3Cell.format.fill.color = "white";
                        await context.sync();
                    });
                } catch (e) {
                    // Ignore errors
                }
            }, 5000);
        });
    } catch (e) {
        // Ignore if Excel API fails
    }
}
```

#### Phase 4: Prevent Formula Execution Until Valid

**Strategy:** Use a validation flag in a hidden cell (e.g., W3)

**Flow:**
1. When accounting book changes, set W3 = "VALIDATING"
2. Validate Q3
3. If invalid → set W3 = "INVALID", update Q3, set W3 = "VALID"
4. If valid → set W3 = "VALID"
5. Formulas check W3 before executing (or backend validates)

**Alternative:** Use frontend validation to prevent sync until valid

**Implementation:**
```javascript
async function validateAndUpdateSubsidiary(accountingBookId, currentSubsidiary) {
    // Set validation flag
    await Excel.run(async (context) => {
        const sheet = context.workbook.worksheets.getActiveWorksheet();
        const validationCell = sheet.getRange("W3");
        validationCell.values = [["VALIDATING"]];
        await context.sync();
    });
    
    try {
        // Validate current subsidiary
        const isValid = await validateSubsidiaryAccountingBookCombination(currentSubsidiary, accountingBookId);
        
        if (!isValid) {
            // Find replacement
            const replacement = await findBestReplacementSubsidiary(accountingBookId, currentSubsidiary);
            
            if (replacement) {
                // Update Q3
                await Excel.run(async (context) => {
                    const sheet = context.workbook.worksheets.getActiveWorksheet();
                    const q3Cell = sheet.getRange("Q3");
                    q3Cell.values = [[replacement]];
                    await context.sync();
                });
                
                // Show notification
                await showSubsidiaryAutoUpdateNotification(currentSubsidiary, replacement, accountingBookId, "Accounting Book " + accountingBookId);
                
                // Mark as valid
                await Excel.run(async (context) => {
                    const sheet = context.workbook.worksheets.getActiveWorksheet();
                    const validationCell = sheet.getRange("W3");
                    validationCell.values = [["VALID"]];
                    await context.sync();
                });
                
                return replacement;
            } else {
                // No valid replacement found - this is an error
                await Excel.run(async (context) => {
                    const sheet = context.workbook.worksheets.getActiveWorksheet();
                    const validationCell = sheet.getRange("W3");
                    validationCell.values = [["INVALID"]];
                    await context.sync();
                });
                
                showPersistentWarning(
                    `No valid subsidiaries found for Accounting Book ${accountingBookId}. ` +
                    `Please select a different accounting book or contact your administrator.`
                );
                
                return null;
            }
        } else {
            // Current subsidiary is valid
            await Excel.run(async (context) => {
                const sheet = context.workbook.worksheets.getActiveWorksheet();
                const validationCell = sheet.getRange("W3");
                validationCell.values = [["VALID"]];
                await context.sync();
            });
            
            return currentSubsidiary;
        }
    } catch (e) {
        console.error('Validation error:', e);
        // On error, mark as invalid to prevent execution
        await Excel.run(async (context) => {
            const sheet = context.workbook.worksheets.getActiveWorksheet();
            const validationCell = sheet.getRange("W3");
            validationCell.values = [["ERROR"]];
            await context.sync();
        });
        
        return null;
    }
}
```

#### Phase 5: Updated `handleAccountingBookChange` Flow

```javascript
async function handleAccountingBookChange() {
    console.log('📚 handleAccountingBookChange() called');
    
    if (isSyncInProgress) {
        console.log('⏸️ Sync already in progress, skipping...');
        return;
    }
    
    try {
        let year = null;
        let currentSubsidiary = '';
        let accountingBook = '';
        let syncType = null;
        
        // Read current values
        await Excel.run(async (context) => {
            const sheet = context.workbook.worksheets.getActiveWorksheet();
            
            const yearCell = sheet.getRange("P3");
            const subCell = sheet.getRange("Q3");
            const bookCell = sheet.getRange("U3");
            const markerCell = sheet.getRange("V2");
            const syncCell = sheet.getRange("V3");
            
            yearCell.load("values");
            subCell.load("values");
            bookCell.load("values");
            markerCell.load("values");
            syncCell.load("values");
            await context.sync();
            
            year = parseInt(yearCell.values[0][0]) || new Date().getFullYear();
            currentSubsidiary = String(subCell.values[0][0] || '').trim();
            accountingBook = String(bookCell.values[0][0] || '').trim();
            
            const rawMarker = String(markerCell.values[0][0] || '');
            const marker = rawMarker.toLowerCase().trim();
            const rawSync = String(syncCell.values[0][0] || '');
            const sync = rawSync.toUpperCase().trim();
            
            const isCFO = marker.includes('cfo sync') || marker.includes('cfo flash') || marker.includes('cfo');
            const syncEnabled = sync === 'TRUE' || sync === 'YES' || sync === '1';
            
            if (isCFO && syncEnabled) {
                syncType = 'cfo';
            } else if ((marker.includes('structure sync') || (marker.includes('🔄') && !marker.includes('cfo'))) && syncEnabled) {
                syncType = 'income';
            }
        });
        
        if (!accountingBook || accountingBook === '1') {
            // Primary Book - no validation needed
            console.log('📚 Primary Book selected - no validation needed');
            await filterSubsidiaryDropdownByAccountingBook('1');
            return;
        }
        
        // CRITICAL: Validate and update subsidiary BEFORE any sync
        console.log(`📚 Validating subsidiary "${currentSubsidiary}" for accounting book ${accountingBook}...`);
        const validatedSubsidiary = await validateAndUpdateSubsidiary(accountingBook, currentSubsidiary);
        
        if (!validatedSubsidiary) {
            // Invalid combination and no replacement found - stop here
            console.error('❌ No valid subsidiary found for accounting book');
            return;
        }
        
        // Update currentSubsidiary if it was changed
        if (validatedSubsidiary !== currentSubsidiary) {
            currentSubsidiary = validatedSubsidiary;
            console.log(`📚 Subsidiary auto-updated to: "${currentSubsidiary}"`);
        }
        
        // Filter subsidiary dropdown
        await filterSubsidiaryDropdownByAccountingBook(accountingBook);
        
        // Clear all caches
        console.log('🗑️ Clearing all caches due to accounting book change...');
        await clearAllCaches();
        
        // Signal functions.js to clear in-memory cache
        if (window.postMessage) {
            window.postMessage({ type: '__CLEARCACHE__', data: 'ALL' }, '*');
        }
        
        // Trigger sync if report is configured for it
        if (syncType && year) {
            console.log(`🔄 Triggering ${syncType} sync after accounting book change...`);
            isSyncInProgress = true;
            
            try {
                if (syncType === 'cfo') {
                    await performCFOSync(year, currentSubsidiary, '', '', '', accountingBook);
                } else if (syncType === 'income') {
                    await performStructureSync(year, currentSubsidiary, '', '', '', accountingBook);
                }
            } catch (syncError) {
                console.error(`❌ Sync error (${syncType}):`, syncError.message);
            } finally {
                setTimeout(() => {
                    isSyncInProgress = false;
                }, 3000);
            }
        }
        
    } catch (e) {
        console.error('❌ Accounting book change error:', e.message);
        showToast({
            title: 'Error',
            message: 'Could not process accounting book change. Please try again.',
            type: 'error'
        });
    }
}
```

## Edge Cases

### Edge Case 1: Book with No Enabled Subsidiaries
- **Detection:** API returns empty list
- **Action:** Show error, prevent sync, suggest different book

### Edge Case 2: User Manually Changes Q3 After Auto-Update
- **Detection:** Q3 changes after accounting book change
- **Action:** Re-validate immediately, show warning if invalid

### Edge Case 3: Book Change While Formulas Are Calculating
- **Detection:** Formulas in progress when book changes
- **Action:** Cancel in-flight requests, clear cache, wait for validation, then re-trigger

### Edge Case 4: Single-Subsidiary Book with Consolidated Parent Selected
- **Detection:** Book has one enabled subsidiary, Q3 has "(Consolidated)"
- **Action:** Remove "(Consolidated)" suffix, show notification

## User Experience Summary

**Best Case (Valid Subsidiary):**
- User changes U3 → Q3 remains valid → Dropdown filters → Caches clear → Sync runs → Formulas update

**Auto-Correction Case (Invalid Subsidiary):**
- User changes U3 → Q3 invalid → Q3 auto-updated → Notification shown → Dropdown filters → Caches clear → Sync runs → Formulas update

**Error Case (No Valid Subsidiaries):**
- User changes U3 → No enabled subsidiaries → Error shown → Sync prevented → User must select different book

## Benefits

1. **Prevents Invalid Formula Execution:** Formulas never run with invalid combinations
2. **User-Friendly:** Auto-correction with clear notifications
3. **NetSuite-Compliant:** Follows exact NetSuite rules
4. **Transparent:** User always knows what changed and why
5. **Recoverable:** User can manually change Q3 if auto-selection isn't desired

