# Files to Share with ChatGPT - Issues 1 & 2

## Overview
These documents describe two critical precaching issues:
1. **Issue 1:** Zero balance accounts not being cached during preload
2. **Issue 2:** Subsequent months (Mar, Apr) not being precached when formulas are dragged

## Files to Share (in this order):

1. **ISSUE_1_ZERO_BALANCE_ACCOUNTS.md** (this directory)
   - Complete problem description for zero balance accounts
   - Root cause analysis (backend query structure)
   - What we've tried
   - Proposed solutions
   - Key questions for ChatGPT

2. **ISSUE_2_SUBSEQUENT_MONTHS.md** (this directory)
   - Complete problem description for subsequent months
   - Root cause analysis (race conditions, timing)
   - What we've tried
   - Proposed solutions
   - Key questions for ChatGPT

3. **backend_bs_preload_query.cs** (this directory)
   - Extracted from `backend-dotnet/Controllers/BalanceController.cs` lines 812-853
   - Shows the SQL query with LEFT JOIN (should include zero balances but may have issues)
   - Key question: Does the WHERE clause filter exclude accounts with no transactions?

4. **taskpane_zeroBalanceCaching.js** (this directory)
   - Extracted from `docs/taskpane.html` lines 8651-8686
   - Shows how zero balances are cached in the frontend
   - Frontend is ready to cache zeros, but backend may not be returning them

5. **taskpane_periodInclusion.js** (this directory)
   - Extracted from `docs/taskpane.html` lines 8598-8618
   - Shows how trigger period is included in preload list
   - May not handle multiple simultaneous triggers correctly

6. **functions_triggerAutoPreload_issue2.js** (this directory)
   - Extracted from `docs/functions.js` lines 398-455
   - Shows auto-preload trigger logic
   - Potential issues: Multiple triggers overwriting each other, flag not reflecting actual state

7. **functions_BALANCE_postPreloadCheck_issue2.js** (this directory)
   - Extracted from `docs/functions.js` lines 4020-4049
   - Shows post-preload period check logic
   - Potential issues: Race conditions when formulas dragged while BUSY

8. **functions_checkLocalStorageCache_zeroBalance.js** (this directory)
   - Extracted from `docs/functions.js` lines 2648-2682
   - Shows how zero balances are handled in cache lookup
   - Cache lookup works correctly, but accounts may not be in cache

## Key Questions for ChatGPT

### Issue 1: Zero Balance Accounts
1. Is the LEFT JOIN approach the best way to include zero balance accounts?
2. Does NetSuite's SuiteQL support LEFT JOINs with BUILTIN.CONSOLIDATE?
3. What's the performance impact of including all BS accounts?
4. Are there alternative approaches?

### Issue 2: Subsequent Months
1. Is there a race condition when formulas are dragged while cells are BUSY?
2. Should we batch multiple preload triggers or process sequentially?
3. Should we scan the entire sheet for all periods before preloading?
4. Should we wait for formulas to settle before triggering preload?
5. Should we use localStorage flag instead of in-memory flag?

## How to Use

1. Copy both issue documents to ChatGPT
2. Share the relevant code snippets in order
3. Ask ChatGPT to:
   - Review the root cause analysis
   - Validate the proposed solutions
   - Suggest improvements or alternative approaches
   - Identify any edge cases we're missing

## Additional Context

- **Issue 1** is primarily a **backend query problem** - the SQL query doesn't return zero balance accounts
- **Issue 2** is primarily a **frontend timing/race condition problem** - new periods aren't being detected or triggered correctly
- Both issues are related to the auto-preload mechanism
- The frontend is ready to handle zero balances, but the backend doesn't provide them
- The frontend has logic to trigger preload for new periods, but timing/race conditions may be preventing it

