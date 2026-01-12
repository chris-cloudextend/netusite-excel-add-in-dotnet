# Refresh All Sequence Analysis

## Issues Found and Fixed

### Issue 1: Version Mismatch (FIXED)
**Problem:** `taskpane.html` was loading `functions.js?v=4.0.6.144` but the actual `functions.js` has version `4.0.6.159`. This version mismatch could cause Excel to:
- Load an old cached version of functions.js
- Open a new add-in window with the old version
- Cause inconsistent behavior

**Fix:** Updated `taskpane.html` line 6080 to use `functions.js?v=4.0.6.159` to match the current version.

### Issue 2: Unnecessary Taskpane Call (FIXED)
**Problem:** In `functions.js` line 11392, there was a call to `Office.addin.showAsTaskpane()` during full year refresh operations. This was causing an empty add-in window to open during Refresh All.

**Fix:** Removed the `Office.addin.showAsTaskpane()` call since:
- The taskpane is already open when Refresh All runs
- Progress is already shown via `updateLoading()` calls in the taskpane UI
- This call was unnecessary and caused the empty window issue

### Issue 3: Cache Not Cleared Before Structure Sync (FIXED)
**Problem:** When Structure Sync runs, it creates new formulas immediately, but the cache wasn't being cleared first. This caused new formulas to use stale cached data, resulting in cache hits when there should be fresh data.

**Fix:** Added cache clearing BEFORE structure sync creates formulas:
- Clears localStorage cache
- Signals functions.js to enter build mode
- Calls `XAVI.BALANCE("__CLEARCACHE__","ALL","")` to clear in-memory cache
- This ensures all new formulas created during structure sync use fresh data

### Issue 4: Second Window Still Opening (INVESTIGATING)
**Problem:** A second taskpane window is still opening during Refresh All.

**Possible Causes:**
1. Excel may have cached an old version of the manifest/files - need to bump version number
2. The `sharedruntime.html` has `Office.addin.showAsTaskpane()` for context menu drill-down, but this shouldn't trigger during refresh all
3. Excel might be loading multiple versions if cache isn't properly cleared

**Next Steps:**
- Bump manifest version to force Excel to reload all files
- Verify no other code paths trigger `showAsTaskpane()`

---

## Refresh All Sequence of Events

When you click "Refresh All" on an Income Statement loaded from Quick Start (which has Structure Sync enabled), here's the exact sequence:

### STEP 0: Connection Check
1. Button is disabled and shows "Checking connection..."
2. Calls `checkConnectionStatus(true)` to verify backend is reachable
3. If connection fails, shows error and exits
4. If connection succeeds, continues to Step 1

### STEP 1: Sheet Type Detection & Structure Sync Check
1. Button shows "Analyzing..."
2. Reads cells V2 (marker) and V3 (sync flag) to check if this is an auto-generated Income Statement
3. Reads cells P3 (year) and Q3 (subsidiary) for sync parameters
4. **If Structure Sync = TRUE:**
   - Sets `shouldSyncStructure = true`
   - Extracts `syncYear` and `syncSubsidiary` from cells
   - **Enters Structure Sync Mode** (see below)
5. **If Structure Sync = FALSE:**
   - Continues to normal refresh flow (Step 2)

### STEP 1A: Structure Sync Mode (When Enabled)
**This is what happens when you load from Quick Start and Structure Sync is enabled:**

1. Shows loading: "Syncing structure for {year}..."
2. Fetches currency format for the subsidiary
3. **Calls API:** `/batch/full_year_refresh` with year and subsidiary
4. Receives account data, account types, and account names
5. **Categorizes accounts** into:
   - Income
   - Other Income
   - COGS
   - Expense
   - Other Expense
6. **Rebuilds the entire sheet structure:**
   - Clears existing content
   - Creates header rows (title, parameters, KPIs)
   - Creates account rows with BALANCE formulas
   - Creates subtotal rows
   - Creates calculated rows (Gross Profit, Operating Income, Net Income)
   - Formats cells with currency
   - Freezes header rows
7. Shows success message: "Structure Synced for {year}"
8. **EXITS EARLY** - does NOT continue to normal refresh flow
9. Formulas are already in place and will resolve automatically

**Note:** After structure sync completes, the formulas are already set up, so they will start evaluating. This is why you see formula evaluations in the log even though structure sync "handles everything."

### STEP 2: Normal Refresh Flow (When Structure Sync = FALSE)
**This only runs if Structure Sync is disabled or not detected:**

1. Shows loading: "Scanning formulas on sheet..."
2. **Scans entire sheet** for XAVI formulas:
   - Collects BALANCE formulas → `cellsToUpdate[]`
   - Collects special formulas (RETAINEDEARNINGS, NETINCOME, CTA) → `specialFormulas[]`
   - Extracts accounts, periods, and years from formulas
3. **Classifies accounts** as P&L vs Balance Sheet:
   - Calls `/batch/account_types` API
   - Or uses smart inference based on period count
4. **Clears caches:**
   - Removes localStorage cache keys
   - Sets build mode flag via localStorage
   - Calls `XAVI.BALANCE("__CLEARCACHE__","ALL","")` to clear functions.js cache
5. **Fetches P&L accounts** (if detected):
   - Calls `/batch/full_year_refresh` with `skip_bs: true`
   - This is where the removed `Office.addin.showAsTaskpane()` call was happening
   - Stores results in `allBalances` object
6. **Fetches Balance Sheet accounts** (if detected):
   - Calls `/batch/full_year_refresh` with `skip_pl: true` (or individual queries)
   - Stores results in `allBalances` object
7. **Re-evaluates BALANCE formulas:**
   - Updates formulas in batches of 100
   - Forces Excel to recalculate with fresh cache
8. **Waits 500ms** to ensure cache is fully populated
9. **Re-evaluates SPECIAL formulas:**
   - Updates formulas in batches of 50
   - Forces fresh API calls to /retained-earnings, /net-income, /cta
10. Shows completion message

---

## Why You See "Unnecessary Things" Before Structure Sync

When Structure Sync is enabled (like in Quick Start Income Statements), the sequence is:

1. **Refresh All starts** → Connection check
2. **Structure Sync check** → Detects Structure Sync = TRUE
3. **Structure Sync runs** → Rebuilds entire sheet
4. **Formulas start evaluating** → This is what you see in the logs
5. **Structure Sync completes** → Shows success message

The "unnecessary things" you're seeing are likely:
- Formula evaluations happening as the sheet is being rebuilt
- Multiple API calls during structure sync
- Cache operations that happen before structure sync completes

The issue was that the old version mismatch and the `Office.addin.showAsTaskpane()` call were causing additional windows to open and unnecessary operations.

---

## Recommendations

1. **After Structure Sync:** Consider adding a small delay before allowing formulas to evaluate, or batch the formula creation to reduce initial evaluation noise.

2. **Logging:** The logs show many individual formula evaluations. Consider adding a summary log entry after structure sync completes showing:
   - Total formulas created
   - Total accounts added
   - Time taken

3. **User Feedback:** The structure sync process could show more granular progress (e.g., "Creating account rows...", "Formatting cells...") to make it clearer what's happening.

---

## Files Modified

1. `docs/taskpane.html` - Fixed version mismatch (line 6080)
2. `docs/functions.js` - Removed unnecessary `Office.addin.showAsTaskpane()` call (line 11386-11396)
