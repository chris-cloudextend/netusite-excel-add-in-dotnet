# Implementation Plan: Balance Sheet Cumulative Grid Batching

## Overview
Optimize balance sheet cumulative formulas dragged across periods by batching queries and computing running balances locally, while completely isolating income statement logic.

---

## Phase 1: Hard Account Type Gate (CRITICAL - Do First)

### Location
`docs/functions.js` - `BALANCE()` function, immediately after parameter normalization (around line ~4590, after cache key generation but BEFORE any manifest/preload logic)

### Implementation
```javascript
// ================================================================
// HARD EXECUTION SPLIT: Account Type Gate
// Income/Expense accounts MUST route to existing IS logic immediately
// They must NEVER enter grid detection, anchor inference, or batching
// ================================================================
// Check account type from cache first (synchronous, fast)
const typeCacheKey = getCacheKey('type', { account });
let accountType = cache.type.has(typeCacheKey) ? cache.type.get(typeCacheKey) : null;

// If not in cache, fetch it (async) - MUST wait before proceeding
if (!accountType) {
    accountType = await getAccountType(account);
}

// INCOME STATEMENT PATH (Hard Return - No BS Logic)
if (accountType && (accountType === 'Income' || accountType === 'COGS' || accountType === 'Expense' || 
    accountType === 'OthIncome' || accountType === 'OthExpense')) {
    // Route to existing income statement logic
    // Continue with existing code path (manifest/preload/API)
    // DO NOT enter grid detection or batching logic below
    // (The existing code will handle IS accounts correctly)
}

// BALANCE SHEET PATH (Continue with existing BS logic + new batching)
// Only reaches here if account is Balance Sheet (or unknown - treated as BS)
```

### Verification
- Income/Expense formulas never enter grid detection
- Income/Expense formulas work exactly as before
- Balance Sheet formulas continue to existing logic

---

## Phase 2: Queue-Based Pattern Detection

### Location
`docs/functions.js` - `processBatchQueue()` function, after routing cumulative requests (around line ~6278)

### Approach
Instead of localStorage-based grid coordination, we'll detect patterns **within the current evaluation wave** by analyzing the `cumulativeRequests` array. This is:
- **Deterministic**: No persistent state
- **Conservative**: False negatives OK, false positives not OK
- **Simple**: No lifecycle management or cleanup needed

### Implementation

#### 2.1: Detect Balance Sheet Grid Pattern
```javascript
/**
 * Detect if cumulative requests form a balance sheet grid pattern.
 * 
 * Conservative detection: Only activates when ALL conditions are met:
 * 1. Account type is Balance Sheet (verified via account type cache)
 * 2. fromPeriod is missing or empty (already filtered by cumulativeRequests)
 * 3. Multiple requests with same account pattern
 * 4. Multiple requests with varying toPeriod
 * 5. Same filters (subsidiary, department, location, class, book)
 * 6. At least 2 different periods (columns)
 * 7. All requests are XAVI.BALANCE (not BALANCECURRENCY)
 * 
 * Returns grouped requests or null if pattern not detected.
 * 
 * @param {Array} cumulativeRequests - Array of [cacheKey, request] tuples
 * @returns {Object|null} - { account, filters, periods, requests } or null
 */
function detectBalanceSheetGridPattern(cumulativeRequests) {
    if (cumulativeRequests.length < 2) {
        return null; // Need at least 2 requests for a grid
    }
    
    // Group requests by account and filters
    // Pattern: Same account + same filters + varying toPeriod = potential grid
    const accountGroups = new Map(); // account+filters -> { account, filters, periods: Set, requests: [] }
    
    for (const [cacheKey, request] of cumulativeRequests) {
        const { account, fromPeriod, toPeriod, subsidiary, department, location, classId, accountingBook } = request.params;
        
        // Skip BALANCECURRENCY requests (they need individual handling)
        const endpoint = request.endpoint || '/balance';
        if (endpoint === '/balancecurrency') {
            continue; // Skip currency requests
        }
        
        // Verify fromPeriod is empty (cumulative)
        if (fromPeriod && fromPeriod !== '') {
            continue; // Not cumulative - skip
        }
        
        // Verify toPeriod exists
        if (!toPeriod || toPeriod === '') {
            continue; // Missing toPeriod - skip
        }
        
        // Create filter key (all filters must match for batching)
        const filterKey = JSON.stringify({ subsidiary, department, location, classId, accountingBook });
        const groupKey = `${account}::${filterKey}`;
        
        if (!accountGroups.has(groupKey)) {
            accountGroups.set(groupKey, {
                account,
                filters: { subsidiary, department, location, classId, accountingBook },
                periods: new Set(),
                requests: []
            });
        }
        
        const group = accountGroups.get(groupKey);
        group.periods.add(toPeriod);
        group.requests.push([cacheKey, request]);
    }
    
    // Find groups that match grid pattern: same account, multiple periods
    for (const [groupKey, group] of accountGroups) {
        // Must have at least 2 different periods (columns)
        if (group.periods.size < 2) {
            continue; // Not a grid - single period
        }
        
        // Must have at least 2 requests (one per period)
        if (group.requests.length < 2) {
            continue; // Not enough requests
        }
        
        // Verify account type is Balance Sheet (check cache)
        // If not in cache, we'll check during batch execution
        const typeCacheKey = getCacheKey('type', { account: group.account });
        const accountType = cache.type.has(typeCacheKey) ? cache.type.get(typeCacheKey) : null;
        
        // If account type is known and is Income/Expense, skip (shouldn't happen, but safety check)
        if (accountType && (accountType === 'Income' || accountType === 'COGS' || accountType === 'Expense' || 
            accountType === 'OthIncome' || accountType === 'OthExpense')) {
            continue; // Income statement - skip grid batching
        }
        
        // Safety limits
        const MAX_ACCOUNTS = 100;
        const MAX_PERIODS = 24;
        
        if (group.periods.size > MAX_PERIODS) {
            continue; // Too many periods - skip batching
        }
        
        // This group matches the pattern!
        return {
            account: group.account,
            filters: group.filters,
            periods: Array.from(group.periods),
            requests: group.requests
        };
    }
    
    return null; // No grid pattern detected
}
```

---

## Phase 3: Anchor Inference

### Location
`docs/functions.js` - New helper function after pattern detection (around line ~407)

### Implementation
```javascript
/**
 * Infer anchor date for balance sheet grid batching.
 * Anchor = day before the earliest toPeriod in the grid.
 * 
 * @param {Array<string>} periods - Array of period strings (e.g., ["Jan 2025", "Feb 2025"])
 * @returns {string} - Anchor date in "YYYY-MM-DD" format, or null if invalid
 */
function inferAnchorDate(periods) {
    if (!periods || periods.length === 0) return null;
    
    // Find earliest period
    const sortedPeriods = periods
        .map(p => parsePeriodToDate(p))
        .filter(d => d !== null)
        .sort((a, b) => a.getTime() - b.getTime());
    
    if (sortedPeriods.length === 0) return null;
    
    const earliestDate = sortedPeriods[0];
    
    // Anchor = day before earliest period (last day of previous month)
    const anchorDate = new Date(earliestDate);
    anchorDate.setDate(0); // Last day of previous month
    
    // Format as YYYY-MM-DD
    const year = anchorDate.getFullYear();
    const month = String(anchorDate.getMonth() + 1).padStart(2, '0');
    const day = String(anchorDate.getDate()).padStart(2, '0');
    
    return `${year}-${month}-${day}`;
}

/**
 * Parse period string (e.g., "Jan 2025") to Date object (first day of month).
 */
function parsePeriodToDate(period) {
    if (!period || typeof period !== 'string') return null;
    
    const match = period.match(/^([A-Za-z]{3})\s+(\d{4})$/);
    if (!match) return null;
    
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 
                        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthStr = match[1];
    const year = parseInt(match[2], 10);
    const month = monthNames.indexOf(monthStr);
    
    if (month === -1) return null;
    
    return new Date(year, month, 1);
}
```

---

## Phase 4: Batched Query Execution

### Location
`docs/functions.js` - New function for batch query execution (around line ~407, after anchor inference)

### Implementation
```javascript
/**
 * Execute batched balance sheet query for a detected grid pattern.
 * 
 * Strategy:
 * 1. Disable per-period auto-preload entirely (skip manifest/preload logic)
 * 2. Execute exactly two NetSuite queries using existing /balance endpoint:
 *    - Opening balance as of anchor (all accounts) - via /balance with anchor_date parameter
 *    - Period activity for: earliest toPeriod → latest toPeriod - via /balance with batch parameters
 * 3. Compute ending balances locally
 * 
 * @param {Object} gridPattern - Pattern from detectBalanceSheetGridPattern()
 * @returns {Promise<Object>} - Map of {period: balance} for the account
 */
let bsBatchQueryInFlight = false; // Single-flight promise lock

async function executeBalanceSheetBatchQuery(gridPattern) {
    // Single-flight lock
    if (bsBatchQueryInFlight) {
        console.log('⏳ BS batch query already in flight - waiting...');
        // Wait for existing query to complete
        while (bsBatchQueryInFlight) {
            await new Promise(r => setTimeout(r, 100));
        }
        // Return null to indicate we should fall back to individual requests
        return null;
    }
    
    bsBatchQueryInFlight = true;
    
    try {
        const { account, filters, periods } = gridPattern;
        
        // Safety limits (fail fast before NetSuite calls)
        const MAX_PERIODS = 24; // 2 years max
        
        if (periods.length > MAX_PERIODS) {
            throw new Error(`Too many periods: ${periods.length} (max: ${MAX_PERIODS})`);
        }
        
        // Verify account type is Balance Sheet (if not in cache, fetch it)
        const typeCacheKey = getCacheKey('type', { account });
        let accountType = cache.type.has(typeCacheKey) ? cache.type.get(typeCacheKey) : null;
        
        if (!accountType) {
            accountType = await getAccountType(account);
        }
        
        // CRITICAL: If account is Income/Expense, abort batching immediately
        if (accountType && (accountType === 'Income' || accountType === 'COGS' || accountType === 'Expense' || 
            accountType === 'OthIncome' || accountType === 'OthExpense')) {
            throw new Error('Account is Income/Expense - should not enter batch path');
        }
        
        // Infer anchor date
        const anchorDate = inferAnchorDate(periods);
        if (!anchorDate) {
            throw new Error('Could not infer anchor date');
        }
        
        console.log(`🚀 BS BATCH QUERY: ${account}, ${periods.length} periods, anchor: ${anchorDate}`);
        
        // Sort periods chronologically
        const sortedPeriods = periods
            .map(p => ({ period: p, date: parsePeriodToDate(p) }))
            .filter(p => p.date !== null)
            .sort((a, b) => a.date.getTime() - b.date.getTime());
        
        if (sortedPeriods.length === 0) {
            throw new Error('No valid periods after sorting');
        }
        
        const earliestPeriod = sortedPeriods[0].period;
        const latestPeriod = sortedPeriods[sortedPeriods.length - 1].period;
        
        // Query 1: Opening balance as of anchor (using existing /balance endpoint)
        console.log(`📊 Query 1: Opening balance as of ${anchorDate}`);
        const openingBalance = await fetchOpeningBalance(account, anchorDate, filters);
        
        // Query 2: Period activity for earliest → latest period (using existing /balance endpoint with batch parameters)
        console.log(`📊 Query 2: Period activity from ${earliestPeriod} to ${latestPeriod}`);
        const periodActivity = await fetchPeriodActivityBatch(account, earliestPeriod, latestPeriod, filters);
        
        // Compute ending balances locally
        const results = computeRunningBalances(
            sortedPeriods.map(p => p.period),
            openingBalance,
            periodActivity
        );
        
        console.log(`✅ BS BATCH QUERY COMPLETE: ${Object.keys(results).length} period results`);
        
        return results; // {period: balance}
        
    } catch (error) {
        console.error('❌ BS batch query failed:', error);
        // Return null to indicate fallback to individual requests
        return null;
    } finally {
        bsBatchQueryInFlight = false;
    }
}

/**
 * Fetch opening balance for account as of anchor date.
 * Uses existing /balance endpoint with anchor_date parameter.
 */
async function fetchOpeningBalance(account, anchorDate, filters) {
    const params = new URLSearchParams({
        account: account,
        from_period: '',  // Empty = cumulative from inception
        to_period: '',    // Empty with anchor_date = opening balance as of anchor
        anchor_date: anchorDate,  // NEW PARAMETER: anchor date
        subsidiary: filters.subsidiary || '',
        department: filters.department || '',
        location: filters.location || '',
        class: filters.classId || '',
        accountingbook: filters.accountingBook || ''
    });
    
    const response = await fetch(`${SERVER_URL}/balance?${params.toString()}`);
    if (!response.ok) {
        throw new Error(`Opening balance query failed: ${response.status}`);
    }
    
    const value = parseFloat(await response.text());
    return isNaN(value) ? 0 : value;
}

/**
 * Fetch period activity for account across period range.
 * Uses existing /balance endpoint with batch parameters.
 */
async function fetchPeriodActivityBatch(account, fromPeriod, toPeriod, filters) {
    const params = new URLSearchParams({
        account: account,
        from_period: fromPeriod,
        to_period: toPeriod,
        batch_mode: 'true',  // NEW PARAMETER: enable batch mode
        include_period_breakdown: 'true',  // NEW PARAMETER: return per-period activity
        subsidiary: filters.subsidiary || '',
        department: filters.department || '',
        location: filters.location || '',
        class: filters.classId || '',
        accountingbook: filters.accountingBook || ''
    });
    
    const response = await fetch(`${SERVER_URL}/balance?${params.toString()}`);
    if (!response.ok) {
        throw new Error(`Period activity query failed: ${response.status}`);
    }
    
    // Backend should return JSON with period breakdown when batch_mode=true
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
        const data = await response.json();
        return data.period_activity || {}; // {period: activity}
    } else {
        // Fallback: single value (shouldn't happen with batch_mode)
        throw new Error('Expected JSON response with period breakdown');
    }
}

/**
 * Compute running balances from opening balance and period activity.
 */
function computeRunningBalances(periods, openingBalance, periodActivity) {
    const results = {};
    let runningBalance = openingBalance || 0;
    
    for (const period of periods) {
        const activity = periodActivity[period] || 0;
        runningBalance += activity;
        results[period] = runningBalance;
    }
    
    return results; // {period: balance}
}
```

---

## Phase 5: Integration into processBatchQueue

### Location
`docs/functions.js` - `processBatchQueue()` function, after routing cumulative requests (around line ~6278)

### Implementation
```javascript
// In processBatchQueue(), after routing to cumulativeRequests (line ~6278):

if (cumulativeRequests.length > 0) {
    console.log(`📊 Processing ${cumulativeRequests.length} CUMULATIVE (BS) requests separately...`);
    
    // ================================================================
    // BALANCE SHEET GRID BATCHING: Detect grid pattern and batch if applicable
    // ================================================================
    const gridPattern = detectBalanceSheetGridPattern(cumulativeRequests);
    
    if (gridPattern) {
        console.log(`🎯 BS GRID PATTERN DETECTED: ${gridPattern.account}, ${gridPattern.periods.length} periods`);
        
        try {
            // Execute batched query
            const batchResults = await executeBalanceSheetBatchQuery(gridPattern);
            
            if (batchResults) {
                // Batch query succeeded - resolve all matching requests
                let resolvedCount = 0;
                for (const [cacheKey, request] of gridPattern.requests) {
                    const { toPeriod } = request.params;
                    const balance = batchResults[toPeriod];
                    
                    if (balance !== undefined) {
                        // Cache the result
                        cache.balance.set(cacheKey, balance);
                        // Resolve the promise
                        request.resolve(balance);
                        resolvedCount++;
                    } else {
                        // Period not in results - fall back to individual request
                        console.warn(`⚠️ Period ${toPeriod} not in batch results - falling back to individual request`);
                        // Add back to cumulativeRequests for individual processing
                        cumulativeRequests.push([cacheKey, request]);
                    }
                }
                
                console.log(`✅ BS BATCH RESOLVED: ${resolvedCount}/${gridPattern.requests.length} requests`);
                
                // Remove batched requests from cumulativeRequests
                const batchedCacheKeys = new Set(gridPattern.requests.map(([key]) => key));
                cumulativeRequests = cumulativeRequests.filter(([key]) => !batchedCacheKeys.has(key));
            } else {
                // Batch query failed - fall back to individual requests
                console.log(`⚠️ BS batch query failed - falling back to individual requests`);
            }
        } catch (error) {
            // Batch query error - fall back to individual requests
            console.error(`❌ BS batch query error:`, error);
            // Continue with individual processing below
        }
    }
    
    // Continue with existing individual cumulative request processing...
    // (Existing code handles remaining cumulativeRequests)
}
```

---

## Phase 6: Backend API Extensions (Required)

### Extend Existing `/balance` Endpoint

**Approach**: Reuse existing `/balance` endpoint and extend with new optional parameters rather than creating new endpoints.

#### 6.1: Opening Balance Query (anchor_date parameter)

**Existing Endpoint**: `/balance`

**New Parameter**: `anchor_date` (YYYY-MM-DD format)

**Usage**:
```
GET /balance?account=10010&from_period=&to_period=&anchor_date=2024-12-31&subsidiary=&department=&location=&class=&accountingbook=
```

**Behavior**:
- When `anchor_date` is provided with empty `from_period` and `to_period`:
  - Return opening balance as of the anchor date (last day of previous month)
  - Equivalent to cumulative balance from inception through anchor date

**Response**: Same as existing (number as text or JSON)

---

#### 6.2: Period Activity Query (batch_mode parameter)

**Existing Endpoint**: `/balance`

**New Parameters**:
- `batch_mode=true`: Enable batch mode
- `include_period_breakdown=true`: Return per-period activity breakdown

**Usage**:
```
GET /balance?account=10010&from_period=Jan 2025&to_period=Dec 2025&batch_mode=true&include_period_breakdown=true&subsidiary=&department=&location=&class=&accountingbook=
```

**Behavior**:
- When `batch_mode=true` and `include_period_breakdown=true`:
  - Calculate period activity for each month in the range
  - Return JSON with per-period breakdown instead of single value

**Response** (when batch_mode=true):
```json
{
  "total": 50000.00,
  "period_activity": {
    "Jan 2025": 5000.00,
    "Feb 2025": -2000.00,
    "Mar 2025": 3000.00,
    ...
  }
}
```

**Response** (when batch_mode=false or not provided):
- Same as existing (number as text or JSON with total only)

---

### Implementation Notes

1. **Backward Compatibility**: All new parameters are optional. Existing calls work unchanged.

2. **Error Handling**: If `anchor_date` is invalid or `batch_mode` parameters are malformed, return error response (same as existing error handling).

3. **Performance**: Batch mode may be slower for large period ranges. Consider adding limits (e.g., max 24 periods).

4. **Flag if Limitation Found**: If the existing `/balance` endpoint architecture truly cannot support these parameters (e.g., requires major refactor), flag it explicitly before proceeding.

---

## Phase 7: Testing & Validation

### Test Scenarios

1. **Income Statement Isolation**
   - Formula: `=XAVI.BALANCE("40000", "Jan 2025", "Jan 2025")`
   - Expected: Works exactly as before, no grid detection, no batching

2. **Balance Sheet Single Cell**
   - Formula: `=XAVI.BALANCE("10010", , "Jan 2025")`
   - Expected: Works as before (no grid, uses existing logic)

3. **Balance Sheet Grid (Success Case)**
   - Formula: `=XAVI.BALANCE("10010", , C$2)` dragged across 12 months
   - Expected:
     - One batched query (2 API calls)
     - Inferred anchor
     - Correct ending balances
     - No per-period preload logs
     - Fast resolution

4. **Balance Sheet Grid (Failure Cases)**
   - Mixed formulas (some XAVI.BALANCE, some not)
   - Accounts vary by column (not row)
   - Periods vary by row (not column)
   - Expected: Falls back to existing logic

5. **Grid Edge Cases**
   - Single row, multiple columns
   - Multiple rows, single column
   - Non-contiguous grid
   - Expected: Falls back to existing logic

---

## Implementation Order

1. ✅ **Phase 1**: Hard Account Type Gate (CRITICAL - Do First)
2. ✅ **Phase 2**: Queue-Based Pattern Detection
3. ✅ **Phase 3**: Anchor Inference
4. ✅ **Phase 4**: Batched Query Execution
5. ✅ **Phase 5**: Integration into processBatchQueue
6. ⚠️ **Phase 6**: Backend API Extensions (Requires .NET backend changes)
7. ✅ **Phase 7**: Testing & Validation

---

## Critical Constraints

1. **Income/Expense Isolation**: Must NEVER enter grid detection or batching
2. **Conservative Trigger**: All 8 conditions must be met
3. **Single-Flight Lock**: Only one batch query at a time
4. **Safety Limits**: Fail fast before NetSuite calls
5. **Fallback**: Always fall back to existing logic if batching fails

---

## Success Criteria

After implementation:
- ✅ Dragging `=XAVI.BALANCE("10010", , C$2)` across 12 months:
  - Triggers one batched query (2 API calls)
  - Uses inferred anchor
  - Produces correct ending balances
  - Eliminates repeated preload logs
  - Resolves quickly and smoothly

- ✅ Income statement formulas work exactly as before
- ✅ January balances match NetSuite exactly (validates anchor math)

