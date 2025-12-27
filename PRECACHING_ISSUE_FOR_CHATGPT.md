# Precaching Issue Analysis - For ChatGPT Review

## Problem Statement

When a user adds a **new column** to their Excel sheet and fills in the **top cell** with a Balance Sheet formula (e.g., `=XAVI.BALANCE("10010",, "Apr 2025")`), the precaching system is not working correctly. The formula triggers auto-preload, but when the user drags down to fill additional rows, those formulas are not using the preloaded cache and instead make individual API calls.

## Expected Behavior

1. User adds new column (e.g., "Apr 2025")
2. User enters formula in top cell: `=XAVI.BALANCE("10010",, "Apr 2025")`
3. System detects new period and triggers auto-preload
4. Auto-preload scans sheet and preloads ALL Balance Sheet accounts for "Apr 2025"
5. User drags down to fill additional rows
6. **All subsequent formulas should use the preloaded cache and resolve instantly**

## Actual Behavior

1. User adds new column and enters formula in top cell ✅
2. Auto-preload is triggered ✅
3. Preload completes ✅
4. User drags down to fill additional rows ❌
5. **Subsequent formulas make individual API calls instead of using cache** ❌

## How Precaching Currently Works

### 1. Formula Execution Flow (functions.js)

When a BALANCE formula is evaluated:

**Location: `docs/functions.js` lines 3504-4050**

```javascript
async function BALANCE(account, fromPeriod, toPeriod, subsidiary, department, location, classId, accountingBook) {
    // ... parameter normalization ...
    
    // Check localStorage cache
    const localStorageValue = checkLocalStorageCache(account, fromPeriod, toPeriod, subsidiary);
    if (localStorageValue !== null) {
        return localStorageValue; // Cache hit - return immediately
    }
    
    // Cache miss - check if period is cached
    if (!subsidiary && lookupPeriod) {
        const isPeriodCached = checkIfPeriodIsCached(lookupPeriod);
        if (!isPeriodCached) {
            const preloadRunning = autoPreloadInProgress || isPreloadInProgress();
            
            if (preloadRunning) {
                // Wait for preload to complete
                await waitForPreload(90000);
                // Re-check cache after preload
                const retryCacheValue = checkLocalStorageCache(account, fromPeriod, toPeriod, subsidiary);
                if (retryCacheValue !== null) {
                    return retryCacheValue;
                }
            } else {
                // No preload in progress - trigger it
                triggerAutoPreload(account, lookupPeriod); // LINE 3958
            }
        }
    }
    
    // Continue with API call if cache still miss...
}
```

**Key Function: `triggerAutoPreload()`**
- **Location: `docs/functions.js` lines 398-443**
- Sets `autoPreloadInProgress = true`
- Stores localStorage flag: `netsuite_auto_preload_trigger`
- Includes `firstAccount` and `firstPeriod` in the trigger

**Key Function: `checkLocalStorageCache()`**
- **Location: `docs/functions.js` lines 2581-2650**
- Checks `xavi_balance_cache` in localStorage
- Cache key format: `balance:${account}::${period}`
- Example: `balance:10010::Apr 2025`

### 2. Taskpane Auto-Preload Handler (taskpane.html)

The taskpane polls for the auto-preload trigger and executes the preload:

**Location: `docs/taskpane.html` lines 8483-8710**

```javascript
// Poll for auto-preload trigger
const autoPreloadJson = localStorage.getItem('netsuite_auto_preload_trigger');
if (autoPreloadJson) {
    const trigger = JSON.parse(autoPreloadJson);
    localStorage.removeItem('netsuite_auto_preload_trigger');
    
    // Scan the sheet for periods used in BS formulas
    const formulaData = await Excel.run(async (context) => {
        const sheet = context.workbook.worksheets.getActiveWorksheet();
        const usedRange = sheet.getUsedRange();
        usedRange.load(['formulas', 'values']);
        await context.sync();
        
        const periods = new Set();
        const formulas = usedRange.formulas;
        
        // Always include the triggering formula's period
        if (trigger.firstPeriod) periods.add(trigger.firstPeriod);
        
        // Scan for XAVI.BALANCE formulas to extract periods
        const balanceRegex = /XAVI\.BALANCE(?:CHANGE)?\s*\(\s*"?([^",)]+)"?\s*,\s*"?([^",)]*)"?\s*,\s*"?([^",)]+)"?/gi;
        
        for (let row = 0; row < formulas.length; row++) {
            for (let col = 0; col < formulas[row].length; col++) {
                const cell = formulas[row][col];
                if (typeof cell === 'string' && cell.toUpperCase().includes('XAVI.BALANCE')) {
                    // Extract period from formula...
                    // Handle cell references vs literal values...
                }
            }
        }
        
        return { periods: Array.from(periods) };
    });
    
    // Normalize trigger period and ensure it's included
    if (trigger.firstPeriod) {
        let normalizedPeriod = trigger.firstPeriod.trim();
        const parts = normalizedPeriod.split(/\s+/);
        if (parts.length === 2) {
            const month = parts[0];
            const year = parts[1];
            const normalizedMonth = month.charAt(0).toUpperCase() + month.slice(1).toLowerCase();
            normalizedPeriod = `${normalizedMonth} ${year}`;
        }
        
        if (!formulaData.periods.includes(normalizedPeriod)) {
            formulaData.periods.push(normalizedPeriod);
        }
    }
    
    // Call backend to preload ALL BS accounts for these periods
    const preloadResponse = await fetch(`${getServerUrl()}/batch/bs_preload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            periods: formulaData.periods,
            subsidiary: '',
            department: '',
            location: '',
            class: '',
            accountingBook: ''
        })
    });
    
    // Cache results in localStorage
    if (result.balances) {
        const cacheEntries = {};
        for (const [account, periodBalances] of Object.entries(result.balances)) {
            if (typeof periodBalances === 'object') {
                for (const [pName, balance] of Object.entries(periodBalances)) {
                    const cacheKey = `balance:${account}::${pName}`;
                    cacheEntries[cacheKey] = { value: balance, timestamp: Date.now() };
                }
            }
        }
        
        const existing = JSON.parse(localStorage.getItem('xavi_balance_cache') || '{}');
        const merged = { ...existing, ...cacheEntries };
        localStorage.setItem('xavi_balance_cache', JSON.stringify(merged));
    }
}
```

### 3. Period Normalization

Periods are normalized to "Mon YYYY" format (e.g., "Apr 2025"):

**Location: `docs/functions.js` - `convertToMonthYear()` function**
- Converts Excel dates, date serials, and various string formats
- Output format: "Jan 2025", "Feb 2025", etc. (title case)

**Location: `docs/taskpane.html` lines 8594-8612**
- Normalizes trigger period to ensure it matches cache key format
- Uses same normalization logic: first letter uppercase, rest lowercase

## Potential Issues to Investigate

### Issue 1: Timing Race Condition
- Formula triggers preload, but continues execution
- User drags down before preload completes
- Formulas check cache, find nothing, make API calls
- **Check**: Does `waitForPreload()` properly wait when preload is in progress?

### Issue 2: Period Normalization Mismatch
- Formula normalizes period one way
- Taskpane normalizes period differently
- Cache key doesn't match lookup key
- **Check**: Are periods normalized consistently between:
  - Formula execution (`convertToMonthYear()`)
  - Taskpane scanning (lines 8598-8604)
  - Cache key creation (line 8661: `balance:${account}::${pName}`)
  - Cache lookup (line 2598: `balance:${account}::${lookupPeriod}`)

### Issue 3: Sheet Scanning Misses New Column
- Taskpane scans `usedRange` to find formulas
- New column might not be in `usedRange` yet
- Or formula in new column not detected by regex
- **Check**: Does `usedRange` include the new column when scanning?

### Issue 4: Cache Key Format Mismatch
- Backend returns periods in one format
- Frontend stores in cache with different format
- Lookup uses yet another format
- **Check**: What format does backend return for period names?
  - Cache storage: `balance:${account}::${pName}` (line 8661)
  - Cache lookup: `balance:${account}::${lookupPeriod}` (line 2598)
  - Are `pName` and `lookupPeriod` in the same format?

### Issue 5: Build Mode Interference
- When dragging down, formulas enter "build mode"
- Build mode might bypass cache checks
- **Check**: Does build mode check cache before queuing?

**Location: `docs/functions.js` lines 3999-4012**
```javascript
if (buildMode) {
    // Skip requests where toPeriod is empty
    if (!toPeriod || toPeriod === '') {
        throw new Error('BUSY');
    }
    
    // Queue for batch processing
    return new Promise((resolve, reject) => {
        buildModePending.push({ cacheKey, params, resolve, reject });
    });
}
```

**Check**: Does the build mode batch processor check cache before making API calls?

## Files to Review

1. **`docs/functions.js`**
   - Lines 398-443: `triggerAutoPreload()` function
   - Lines 448-467: `checkIfPeriodIsCached()` function
   - Lines 2581-2650: `checkLocalStorageCache()` function
   - Lines 3504-4050: `BALANCE()` function (especially lines 3922-3962)
   - Lines 1077-1115: Build mode detection and processing
   - Lines 1300-1800: Build mode batch processor (check if it uses cache)

2. **`docs/taskpane.html`**
   - Lines 8483-8710: Auto-preload trigger handler
   - Lines 8508-8590: Sheet scanning logic
   - Lines 8594-8612: Period normalization
   - Lines 8632-8678: Cache storage logic

3. **`docs/ANALYSIS_AUTO_PRELOAD_ISSUES.md`**
   - Contains previous analysis of similar issues
   - Documents race conditions and timing issues

## Specific Questions for ChatGPT

1. **Period Normalization**: Are periods normalized consistently throughout the flow? Check:
   - Formula execution: `convertToMonthYear()` output
   - Taskpane scanning: period extraction and normalization
   - Cache storage: what format is `pName` from backend?
   - Cache lookup: what format is `lookupPeriod`?

2. **Cache Check Timing**: When does `checkLocalStorageCache()` get called?
   - Before build mode queuing?
   - After build mode batch processing?
   - During build mode batch processing?

3. **Build Mode Cache Usage**: Does the build mode batch processor check cache before making API calls?
   - Location: `docs/functions.js` lines 1300-1800
   - Does it call `checkLocalStorageCache()` for each queued item?

4. **Sheet Scanning**: When a new column is added:
   - Is it included in `usedRange`?
   - Is the formula detected by the regex?
   - Is the period extracted correctly?

5. **Race Condition**: If preload is in progress:
   - Does `waitForPreload()` properly wait?
   - Do formulas re-check cache after preload completes?
   - What happens if user drags down while preload is running?

## Debugging Suggestions

1. Add console logs to track period normalization:
   - In `triggerAutoPreload()`: log the period being triggered
   - In taskpane scanning: log extracted periods
   - In cache storage: log the cache keys being created
   - In cache lookup: log the cache keys being searched

2. Add console logs to track cache hits/misses:
   - In `checkLocalStorageCache()`: log what keys are available
   - In build mode batch processor: log if cache is checked

3. Verify `usedRange` includes new column:
   - Log `usedRange.address` and `usedRange.columnCount` in taskpane
   - Check if new column is within the range

4. Verify period format from backend:
   - Log the `result.balances` structure from backend
   - Check what format `pName` is in (keys of `periodBalances`)

## Expected Cache Key Format

Cache keys should be in format: `balance:${account}::${period}`

Where:
- `account` is the account number (e.g., "10010")
- `period` is normalized to "Mon YYYY" format (e.g., "Apr 2025")

Example cache keys:
- `balance:10010::Apr 2025`
- `balance:10020::Apr 2025`
- `balance:10030::Apr 2025`

## Summary

The issue is that when a new column is added and the top cell is filled, precaching is triggered but subsequent formulas (when dragging down) are not using the cache. The root cause could be:

1. Period normalization mismatch between storage and lookup
2. Build mode not checking cache before queuing
3. Sheet scanning missing the new column
4. Race condition where formulas execute before preload completes
5. Cache key format mismatch

Please review the code in the specified locations and identify where the issue occurs.

