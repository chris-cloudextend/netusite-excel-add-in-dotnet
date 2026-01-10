# Subsidiary Display Rules Based on Accounting Book - Analysis & Required Changes

## Executive Summary

The current implementation **violates several NetSuite rules** for how subsidiaries should be displayed based on accounting book selection. This document outlines the required changes to align with NetSuite's deterministic behavior.

## NetSuite Rules Summary

### Core Rule: Book-Scoped Subsidiary Universe
**Rule 1:** Only subsidiaries explicitly enabled for the selected Accounting Book are eligible. If a subsidiary is not enabled, it is completely excluded, regardless of hierarchy.

### Eligibility Rules
**Rule 2:** A subsidiary appears in the dropdown only if it is enabled for the selected Accounting Book.

### Parent Subsidiary Handling
**Rule 3A:** If a parent is enabled for the book:
- Parent appears in dropdown
- If children are also enabled, parent represents a valid consolidation node

**Rule 3B:** If a child is enabled but parent is NOT:
- Parent is excluded
- Child is treated as top-level for that book

### Consolidation Availability
**Rule 4:** A subsidiary appears as consolidated only if:
- The subsidiary itself is enabled for the book
- At least one of its direct or indirect child subsidiaries is also enabled for the same book

### Single-Subsidiary Books
**Rule 5:** If a book is enabled for exactly one subsidiary (leaf node):
- Only that subsidiary appears
- All parents are removed
- Consolidated selections are not shown
- All amounts in base currency of that subsidiary

### No Cross-Book Hierarchy
**Rule 6:** Hierarchy is evaluated independently per accounting book. Only relationships fully contained within the book are considered valid.

## Current Implementation Issues

### ❌ Issue 1: Including Non-Enabled Parents

**Location:** `backend-dotnet/Controllers/LookupController.cs` lines 262-314

**Current Behavior:**
```csharp
// Includes parents that are NOT enabled for the book
var subsidiariesWithValidChildren = allSubsidiaries
    .Where(s => !subsidiaryIds.Contains(s.Id) && validSubsidiaryIdsWithChildren.Contains(s.Id))
```

**Problem:** This violates **Rule 1** and **Rule 3B**. We're including parent subsidiaries that are NOT enabled for the book, just because they have children that are enabled.

**NetSuite Rule:** If a parent is not enabled, it must be completely excluded, even if children are enabled.

### ❌ Issue 2: Incorrect Consolidation Logic

**Location:** `backend-dotnet/Controllers/LookupController.cs` lines 275-314

**Current Behavior:**
- Traverses up parent chain for ANY enabled subsidiary
- Includes ALL ancestors, even if they're not enabled

**Problem:** This violates **Rule 4**. We're allowing consolidation for parents that aren't enabled for the book.

**NetSuite Rule:** Consolidation is only available if BOTH the parent AND at least one child are enabled for the book.

### ❌ Issue 3: Using Full Hierarchy Instead of Book-Scoped Hierarchy

**Location:** `backend-dotnet/Controllers/LookupController.cs` lines 232-241

**Current Behavior:**
```csharp
var allSubsidiaries = await _lookupService.GetSubsidiariesAsync();
var validSubsidiaries = allSubsidiaries
    .Where(s => subsidiaryIds.Contains(s.Id))
```

**Problem:** We're using the full subsidiary hierarchy from `GetSubsidiariesAsync()`, then filtering. This violates **Rule 6**.

**NetSuite Rule:** Hierarchy must be recomputed using ONLY subsidiaries enabled for the book. Parent-child relationships outside the book-scoped set are ignored.

### ❌ Issue 4: No Single-Subsidiary Book Handling

**Location:** Missing in current implementation

**Problem:** We don't detect or handle single-subsidiary books according to **Rule 5**.

**NetSuite Rule:** If exactly one subsidiary is enabled and it's a leaf node:
- Show only that subsidiary
- Remove all parents
- Disable consolidation
- Use subsidiary base currency

### ❌ Issue 5: Frontend Shows All Subsidiaries Initially

**Location:** `docs/taskpane.html` lines 16935-16961

**Current Behavior:**
- Shows all subsidiaries initially
- Filters after accounting book is selected

**Problem:** Should only show enabled subsidiaries from the start when a book is selected.

## Required Changes

### Backend Changes

#### 1. New Method: `GetBookScopedSubsidiariesAsync`

**File:** `backend-dotnet/Services/LookupService.cs`

**Purpose:** Return subsidiaries with book-scoped hierarchy and consolidation flags.

**Logic:**
```csharp
public async Task<BookScopedSubsidiariesResponse> GetBookScopedSubsidiariesAsync(string accountingBookId)
{
    // Step 1: Get enabled subsidiaries for this book
    var enabledSubsidiaryIds = await GetSubsidiariesForAccountingBookAsync(accountingBookId);
    
    if (enabledSubsidiaryIds == null || enabledSubsidiaryIds.Count == 0)
    {
        // Primary Book or no subsidiaries - return all
        return new BookScopedSubsidiariesResponse { AllSubsidiaries = true };
    }
    
    // Step 2: Get all subsidiaries (for hierarchy lookup)
    var allSubsidiaries = await GetSubsidiariesAsync();
    
    // Step 3: Filter to ONLY enabled subsidiaries
    var enabledSubsidiaries = allSubsidiaries
        .Where(s => enabledSubsidiaryIds.Contains(s.Id))
        .ToList();
    
    // Step 4: Recompute hierarchy using ONLY enabled subsidiaries
    // Build parent-child relationships within the enabled set
    var bookScopedHierarchy = BuildBookScopedHierarchy(enabledSubsidiaries, allSubsidiaries);
    
    // Step 5: Determine consolidation eligibility
    // A subsidiary can be consolidated if:
    // - It is enabled (already filtered)
    // - It has at least one child in the enabled set
    var consolidationEligible = new HashSet<string>();
    foreach (var sub in enabledSubsidiaries)
    {
        var children = bookScopedHierarchy.GetChildren(sub.Id);
        if (children.Any(c => enabledSubsidiaryIds.Contains(c.Id)))
        {
            consolidationEligible.Add(sub.Id);
        }
    }
    
    // Step 6: Handle single-subsidiary books (Rule 5)
    if (enabledSubsidiaryIds.Count == 1)
    {
        var singleSub = enabledSubsidiaries.First();
        var hasChildren = bookScopedHierarchy.GetChildren(singleSub.Id).Any();
        
        if (!hasChildren)
        {
            // Leaf node - return only this subsidiary, no consolidation
            return new BookScopedSubsidiariesResponse
            {
                AllSubsidiaries = false,
                Subsidiaries = new List<SubsidiaryDisplayItem>
                {
                    new SubsidiaryDisplayItem
                    {
                        Id = singleSub.Id,
                        Name = singleSub.Name,
                        FullName = singleSub.FullName,
                        CanConsolidate = false,
                        IsLeaf = true
                    }
                },
                IsSingleSubsidiaryBook = true
            };
        }
    }
    
    // Step 7: Build response with consolidation flags
    var displayItems = enabledSubsidiaries.Select(s => new SubsidiaryDisplayItem
    {
        Id = s.Id,
        Name = s.Name,
        FullName = s.FullName,
        CanConsolidate = consolidationEligible.Contains(s.Id),
        IsLeaf = !bookScopedHierarchy.GetChildren(s.Id).Any()
    }).ToList();
    
    return new BookScopedSubsidiariesResponse
    {
        AllSubsidiaries = false,
        Subsidiaries = displayItems,
        IsSingleSubsidiaryBook = false
    };
}

private BookScopedHierarchy BuildBookScopedHierarchy(
    List<SubsidiaryItem> enabledSubs, 
    List<SubsidiaryItem> allSubs)
{
    // Build hierarchy using ONLY enabled subsidiaries
    // If a parent is not enabled, the child becomes top-level
    var hierarchy = new BookScopedHierarchy();
    
    foreach (var sub in enabledSubs)
    {
        // Find parent, but only if parent is also enabled
        if (!string.IsNullOrEmpty(sub.Parent))
        {
            var parent = enabledSubs.FirstOrDefault(s => s.Id == sub.Parent);
            if (parent != null)
            {
                hierarchy.AddChild(parent.Id, sub);
            }
            else
            {
                // Parent not enabled - this is a top-level node for this book
                hierarchy.AddTopLevel(sub);
            }
        }
        else
        {
            // No parent - top-level
            hierarchy.AddTopLevel(sub);
        }
    }
    
    return hierarchy;
}
```

#### 2. Update `GetSubsidiariesForAccountingBook` Endpoint

**File:** `backend-dotnet/Controllers/LookupController.cs`

**Change:** Replace current logic with call to `GetBookScopedSubsidiariesAsync`.

**New Response Format:**
```json
{
  "allSubsidiaries": false,
  "subsidiaries": [
    {
      "id": "123",
      "name": "Celigo Inc",
      "fullName": "Celigo Inc",
      "canConsolidate": true,
      "isLeaf": false
    },
    {
      "id": "456",
      "name": "Celigo India",
      "fullName": "Celigo India",
      "canConsolidate": false,
      "isLeaf": true
    }
  ],
  "isSingleSubsidiaryBook": false
}
```

#### 3. New Response Models

**File:** `backend-dotnet/Models/LookupModels.cs`

```csharp
public class BookScopedSubsidiariesResponse
{
    public bool AllSubsidiaries { get; set; }
    public List<SubsidiaryDisplayItem> Subsidiaries { get; set; } = new();
    public bool IsSingleSubsidiaryBook { get; set; }
}

public class SubsidiaryDisplayItem
{
    public string Id { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string? FullName { get; set; }
    public bool CanConsolidate { get; set; }
    public bool IsLeaf { get; set; }
}
```

### Frontend Changes

#### 1. Update `filterSubsidiaryDropdownByAccountingBook`

**File:** `docs/taskpane.html`

**Current:** Filters from all subsidiaries, includes parents not enabled.

**New:** Only show subsidiaries from API response, respect `canConsolidate` flag.

```javascript
async function filterSubsidiaryDropdownByAccountingBook(selectedBookId) {
    if (!selectedBookId || selectedBookId === '1') {
        // Primary Book - show all subsidiaries
        if (window.allSubsidiaries) {
            await populateSubsidiaryDropdown(window.allSubsidiaries);
        }
        return;
    }
    
    try {
        const response = await fetch(`${getServerUrl()}/lookups/accountingbook/${selectedBookId}/subsidiaries`);
        if (response.ok) {
            const data = await response.json();
            
            if (data.allSubsidiaries) {
                // Primary Book - show all
                if (window.allSubsidiaries) {
                    await populateSubsidiaryDropdown(window.allSubsidiaries);
                }
                return;
            }
            
            // Build dropdown options from book-scoped subsidiaries
            const subSelect = document.getElementById('subsidiarySelect');
            if (subSelect) {
                subSelect.innerHTML = '<option value="">Select Subsidiary...</option>';
                
                // Single-subsidiary book - no consolidation option
                if (data.isSingleSubsidiaryBook && data.subsidiaries.length === 1) {
                    const sub = data.subsidiaries[0];
                    const option = document.createElement('option');
                    option.value = sub.name;
                    option.textContent = sub.name;
                    subSelect.appendChild(option);
                    return;
                }
                
                // Multiple subsidiaries - show with consolidation where applicable
                for (const sub of data.subsidiaries) {
                    // Always show the base subsidiary
                    const baseOption = document.createElement('option');
                    baseOption.value = sub.name;
                    baseOption.textContent = sub.name;
                    subSelect.appendChild(baseOption);
                    
                    // Show consolidated version only if canConsolidate is true
                    if (sub.canConsolidate) {
                        const consolidatedOption = document.createElement('option');
                        consolidatedOption.value = `${sub.name} (Consolidated)`;
                        consolidatedOption.textContent = `${sub.name} (Consolidated)`;
                        subSelect.appendChild(consolidatedOption);
                    }
                }
            }
        }
    } catch (e) {
        console.error('Error filtering subsidiaries:', e);
        showToast({
            title: 'Error',
            message: 'Could not load subsidiaries for this accounting book.',
            type: 'error'
        });
    }
}
```

#### 2. Update Validation Logic

**File:** `docs/taskpane.html`

**Current:** Checks if subsidiary is in valid list, allows parents with valid children.

**New:** Only allow subsidiaries explicitly returned by API. No exceptions.

```javascript
async function validateSubsidiaryAccountingBookCombination(subsidiaryName, accountingBookId) {
    if (!subsidiaryName || !accountingBookId || accountingBookId === '1') {
        return true; // Primary Book - always valid
    }
    
    try {
        const response = await fetch(`${getServerUrl()}/lookups/accountingbook/${accountingBookId}/subsidiaries`);
        if (response.ok) {
            const data = await response.json();
            
            if (data.allSubsidiaries) {
                return true; // Primary Book
            }
            
            // Check if subsidiary name (with or without "Consolidated") is in the list
            const baseName = subsidiaryName.replace(' (Consolidated)', '');
            const validSubs = data.subsidiaries || [];
            
            const isValid = validSubs.some(s => {
                if (s.name === baseName) {
                    // Check if consolidated version is allowed
                    if (subsidiaryName.includes('(Consolidated)')) {
                        return s.canConsolidate;
                    }
                    return true; // Base subsidiary is always valid if in list
                }
                return false;
            });
            
            if (!isValid) {
                showPersistentWarning(
                    `Subsidiary "${subsidiaryName}" is not enabled for this accounting book. ` +
                    `Please select a subsidiary from the filtered list.`
                );
                return false;
            }
            
            return true;
        }
    } catch (e) {
        console.error('Validation error:', e);
        return false;
    }
    
    return false;
}
```

#### 3. Update Error Messages

**File:** `docs/taskpane.html`

**Current:** Generic "not valid" messages.

**New:** Specific messages based on NetSuite rules:
- "This subsidiary is not enabled for the selected accounting book."
- "Consolidation is not available for this subsidiary in this accounting book."
- "This accounting book is configured for a single subsidiary. Consolidation is not available."

## Implementation Priority

### Phase 1: Backend Core Logic (High Priority)
1. Implement `GetBookScopedSubsidiariesAsync` method
2. Update `GetSubsidiariesForAccountingBook` endpoint
3. Add response models
4. Test with single-subsidiary books

### Phase 2: Frontend Filtering (High Priority)
1. Update `filterSubsidiaryDropdownByAccountingBook`
2. Respect `canConsolidate` flag
3. Handle single-subsidiary books

### Phase 3: Validation & Error Messages (Medium Priority)
1. Update validation logic
2. Improve error messages
3. Add persistent warnings

### Phase 4: Testing & Edge Cases (Medium Priority)
1. Test with various book configurations
2. Test parent/child scenarios
3. Test single-subsidiary books
4. Test consolidation availability

## Testing Scenarios

### Scenario 1: Parent Enabled, Child Enabled
- **Setup:** Book 2 enabled for "Celigo Inc" (parent) and "Celigo India" (child)
- **Expected:** Both appear, "Celigo Inc" shows consolidation option

### Scenario 2: Parent NOT Enabled, Child Enabled
- **Setup:** Book 2 enabled only for "Celigo India" (child), not "Celigo Inc" (parent)
- **Expected:** Only "Celigo India" appears, no parent, no consolidation

### Scenario 3: Single-Subsidiary Book
- **Setup:** Book 2 enabled only for "Celigo India" (leaf node)
- **Expected:** Only "Celigo India" appears, no consolidation option, no parents

### Scenario 4: Multiple Enabled, No Hierarchy
- **Setup:** Book 2 enabled for "Celigo India" and "Celigo Australia" (siblings, no parent)
- **Expected:** Both appear as top-level, no consolidation options

## Conclusion

The current implementation violates NetSuite's rules by:
1. Including non-enabled parents
2. Allowing consolidation for non-enabled parents
3. Using full hierarchy instead of book-scoped hierarchy
4. Not handling single-subsidiary books

**Required:** Complete rewrite of subsidiary filtering logic to follow NetSuite's deterministic rules exactly.

