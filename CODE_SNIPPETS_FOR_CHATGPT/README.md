# Files to Share with ChatGPT

## Overview
These are extracted code snippets from the larger codebase, focusing on the precaching issue when new columns are added.

## Files to Share (in this order):

1. **PRECACHING_ISSUE_FOR_CHATGPT.md** (from parent directory)
   - Complete problem description and analysis
   - Start with this file

2. **functions_triggerAutoPreload.js**
   - Shows how auto-preload is triggered
   - Location: `docs/functions.js` lines 398-443

3. **functions_checkLocalStorageCache.js**
   - Shows how cache is checked
   - Cache key format: `balance:${account}::${period}`
   - Location: `docs/functions.js` lines 2581-2647

4. **functions_BALANCE_cache_check.js**
   - Shows the cache check logic inside BALANCE function
   - Shows where preload is triggered
   - Location: `docs/functions.js` lines 3920-3962

5. **functions_buildMode.js**
   - Shows build mode batch processor (partial)
   - **CRITICAL**: Check if this checks cache before API calls
   - Location: `docs/functions.js` lines 1317-1450 (partial)

6. **taskpane_autoPreload.js**
   - Shows how taskpane scans sheet and stores cache
   - Shows period normalization
   - Location: `docs/taskpane.html` lines 8483-8710

## Key Questions for ChatGPT:

1. **Period Normalization**: Are periods normalized consistently?
   - Formula execution vs taskpane scanning vs cache storage vs cache lookup

2. **Build Mode Cache Check**: Does build mode check `checkLocalStorageCache()` before making API calls?

3. **Sheet Scanning**: When a new column is added, is it included in `usedRange`?

4. **Cache Key Format**: Does the period format from backend match the lookup format?

## How to Use:

1. Copy all files in this directory to ChatGPT
2. Also copy `PRECACHING_ISSUE_FOR_CHATGPT.md` from the parent directory
3. Use the prompt from the .md file

