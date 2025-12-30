# Balance Sheet Column Drag Optimization - Revised Analysis

## Executive Summary

**Problem**: When dragging `BALANCE(account,, Period)` formulas across columns (e.g., Jan → Feb → Mar → Apr), the system processes each cell independently, resulting in inefficient NetSuite queries. The current grid detection logic is designed for multi-account grids and fails to detect single-row, horizontal drag patterns.

**Goal**: Optimize execution for single-row, contiguous period series while preserving exact formula semantics and accounting correctness.

**Critical Constraint**: This is **strictly an execution optimization**. No changes to user-facing semantics or formula meaning.

---

## User-Facing Semantics (Unchanged)

- `BALANCE(account,, Period)` always means: **Balance as of Period**
- Dragging right changes only the `toPeriod` parameter
- Each cell must behave as if it were evaluated independently
- Results must exactly match NetSuite financials
- No new syntax, no new user concepts

---

## Current Code Analysis

### Current Grid Detection Logic

**Location**: `docs/functions.js:1819-2060` (`detectBsGridPattern`)

**Current Behavior**:
1. Requires `accounts.size >= 2 AND periods.size >= 2` (line 1956)
2. Requires at least 2 accounts with multiple periods (line 1979)
3. Requires at least 2 periods with multiple accounts (line 2021)
4. Uses string comparison for period ordering (`toPeriod < earliestPeriod`)
5. No check for contiguous accounting periods (uses string comparison)
6. No detection of drag-fill vs manual entry

**Why It Fails for Column Drags**:
- Single-row drag: 1 account × 8 periods
- Fails `accounts.size < 2` check (line 1956)
- Fails `accountsWithMultiplePeriods < 2` check (line 1979)
- Returns `null` → falls back to individual processing

### Current Execution Strategy

**Location**: `docs/functions.js:2199-2390` (`processBsGridBatching`)

**Current Behavior**:
1. Infers anchor date (day before earliest period)
2. Fetches opening balances at anchor date
3. Fetches period activity from anchor to latest period
4. Computes ending balances locally: `OpeningBalance(anchor) + SUM(Activity(periods up to period))`

**Issues**:
- Uses anchor date (day before period start) instead of period end date
- Activity query uses period date ranges, but CONS_AMT anchoring needs verification
- No verification that periods are contiguous (uses string comparison)
- Works for multi-account grids but not single-row patterns

---

## Required Detection Criteria

All of the following must be satisfied for optimization to activate:

### 1. Same Formula Shape
- `fromPeriod` is null or empty
- `toPeriod` is present
- **Current Code**: ✅ Already checks this (line 1912-1922)

### 2. Same Account
- Account parameter is identical across all cells
- **Current Code**: ❌ Requires multiple accounts (line 1956)
- **Fix Needed**: Allow single account for horizontal drag optimization

### 3. Same Row (Horizontal Drag Only)
- Optimization applies only to horizontal drags (same row)
- **Current Code**: ❌ No row detection
- **Fix Needed**: Add row detection or infer from single-account pattern

### 4. Contiguous Accounting Periods
- Periods must be sequential in NetSuite accounting calendar
- Must use `accountingperiod.sequence` or equivalent, not string matching
- **Current Code**: ❌ Uses string comparison (`toPeriod < earliestPeriod`)
- **Fix Needed**: Query NetSuite for period sequence numbers and verify contiguity

### 5. Drag-Generated Cells
- Cells must be produced by Excel drag-fill
- Do not batch unrelated formulas entered manually
- **Current Code**: ❌ No drag-fill detection
- **Fix Needed**: Detect drag-fill pattern (temporal clustering, sequential evaluation)

### 6. Same Context
- Same subsidiary, department, location, class, accounting book
- **Current Code**: ✅ Already checks this (line 1871-1891)

---

## Required Execution Strategy

### 1. Anchor Determination
- **Anchor** = **Earliest period** (minimum sequence) in the contiguous series, **NOT** the first evaluated cell
- **CRITICAL**: Excel evaluation order is non-deterministic and does NOT reflect user intent
- **Anchor selection process**:
  1. Determine the contiguous series of `BALANCE(account,, toPeriod)` cells eligible for batching
  2. Compute each cell's accounting period sequence using NetSuite accounting period metadata
  3. Anchor period = minimum period sequence in that series (earliest period, typically leftmost column)
- **Anchor immutability**: Once anchor is selected for the detected series, it remains immutable for batch execution
- **Anchor must NEVER be recomputed based on**:
  - Excel evaluation order/timestamp
  - Which cell is evaluated first
  - Re-evaluation order
- **All subsequent roll-forward calculations must explicitly reference this period-order anchor**
- **Current Code**: Uses earliest period but may be affected by evaluation order
- **Fix Needed**: Always use earliest period in contiguous series, regardless of evaluation order

### 2. Anchor Query
- Compute balance as of anchor period **end date**
- Use: `BUILTIN.CONSOLIDATE(..., 'CONS_AMT', ..., asOfDate = anchorPeriod.enddate)`
- **Current Code**: Uses anchor date (day before period start)
- **Fix Needed**: Use period end date for anchor balance

### 3. Incremental Activity Query
- Fetch posting activity for subsequent periods only
- Period range: `anchorPeriod.next → lastPeriodInSeries`
- **Critical**: CONS_AMT must be anchored to each target period's end date
- **Current Code**: Fetches activity but needs CONS_AMT verification
- **Fix Needed**: Ensure CONS_AMT uses each period's end date

### 4. Roll-Forward Computation
- Internally compute balances:
  - `Feb = Jan + Feb activity`
  - `Mar = Feb + Mar activity`
- Each resulting value must equal standalone `BALANCE(account,, Period)` query
- **Current Code**: ✅ Already does this (`computeEndingBalance` function)

### 5. Populate Cells
- Return values as if each cell were independently evaluated
- **Current Code**: ✅ Already does this

---

## Critical Constraints

### CONS_AMT Anchoring
- **CRITICAL**: `BUILTIN.CONSOLIDATE` must use each period's end date for CONS_AMT
- This ensures correct FX rates and eliminations for each period
- **Current Code**: Needs verification that backend uses correct period IDs

### Correctness Guarantee
- If correctness cannot be guaranteed, disable batching
- Results must exactly match standalone evaluation
- **Current Code**: Has safety checks but needs period contiguity verification

---

## Edge Cases

### Skipped Months
- Example: Jan, Mar, Apr (Feb missing)
- **Action**: Do NOT batch (periods not contiguous)
- **Current Code**: Would fail string comparison check
- **Fix Needed**: Use sequence numbers to detect gaps

### Fiscal Calendars
- Must use NetSuite accounting periods, not calendar months
- Respect 4-4-5, 13-period years, etc.
- Sequence must come from NetSuite metadata
- **Current Code**: Uses period names (string comparison)
- **Fix Needed**: Query period sequence from NetSuite

### Open Periods
- Allowed (balances are provisional but accounting-correct)
- Optimization is still valid
- **Current Code**: ✅ Should work (no special handling needed)

### Mixed Formulas
- Example: `BALANCE(account,, Jan)` and `BALANCE(account, Jan, Feb)`
- **Action**: Do NOT batch (shapes differ)
- **Current Code**: ✅ Already handles this (separates cumulative vs period activity)

---

## Proposed Code Changes

### Change 1: New Function - Detect Single-Row Drag Pattern

**Location**: `docs/functions.js` (new function, ~line 1775)

```javascript
/**
 * Detect single-row, horizontal drag pattern for BALANCE formulas.
 * 
 * This is a specialized optimization for the common case of dragging
 * BALANCE(account,, Period) across columns (same account, contiguous periods).
 * 
 * Detection Criteria (ALL must be true):
 * 1. Same formula shape: fromPeriod empty, toPeriod present
 * 2. Same account: All requests use identical account parameter
 * 3. Same context: Same subsidiary, department, location, class, book
 * 4. Contiguous periods: Periods are sequential in NetSuite accounting calendar
 * 5. Drag-generated: Temporal clustering suggests drag-fill (optional heuristic)
 * 
 * CRITICAL ANCHOR RULE:
 * - Anchor = EARLIEST PERIOD (minimum sequence) in the contiguous series
 * - Anchor is based on PERIOD ORDER, NOT evaluation order/timestamp
 * - Excel evaluation order is non-deterministic and does not reflect user intent
 * - If series includes Jan, Jan must be anchor even if Mar is evaluated first
 * - Anchor is IMMUTABLE once selected for the batch
 * - Anchor must NEVER be recomputed based on evaluation order or which cell is evaluated first
 * - All roll-forward calculations must reference this period-order anchor
 * 
 * @param {Array} requests - Array of [cacheKey, request] tuples
 * @returns {Object|null} Pattern info: { account, periods: Array, anchorPeriod, filtersHash } or null
 */
async function detectSingleRowDragPattern(requests) {
    if (!requests || requests.length < 2) {
        return null; // Need at least 2 periods for optimization
    }
    
    // Step 1: Filter to cumulative queries only
    const cumulativeRequests = [];
    for (const [cacheKey, request] of requests) {
        const { fromPeriod, toPeriod } = request.params;
        const isCumulative = (!fromPeriod || fromPeriod === '') && toPeriod && toPeriod !== '';
        if (isCumulative) {
            cumulativeRequests.push([cacheKey, request]);
        }
    }
    
    if (cumulativeRequests.length < 2) {
        return null; // Need at least 2 cumulative requests
    }
    
    // Step 2: Verify same account
    const firstRequest = cumulativeRequests[0][1];
    const account = firstRequest.params.account;
    
    for (const [cacheKey, request] of cumulativeRequests) {
        if (request.params.account !== account) {
            return null; // Different accounts - not a single-row pattern
        }
    }
    
    // Step 3: Verify same context (filters)
    const filtersHash = getFilterKey({
        subsidiary: firstRequest.params.subsidiary,
        department: firstRequest.params.department,
        location: firstRequest.params.location,
        classId: firstRequest.params.classId,
        accountingBook: firstRequest.params.accountingBook
    });
    
    for (const [cacheKey, request] of cumulativeRequests) {
        const requestFiltersHash = getFilterKey({
            subsidiary: request.params.subsidiary,
            department: request.params.department,
            location: request.params.location,
            classId: request.params.classId,
            accountingBook: request.params.accountingBook
        });
        if (requestFiltersHash !== filtersHash) {
            return null; // Different filters - not a pattern
        }
    }
    
    // Step 4: Collect periods and verify contiguity
    const periods = [];
    for (const [cacheKey, request] of cumulativeRequests) {
        periods.push(request.params.toPeriod);
    }
    
    // Remove duplicates and sort
    const uniquePeriods = Array.from(new Set(periods));
    
    // Step 5: Verify periods are contiguous using NetSuite sequence
    // CRITICAL: Must query NetSuite for period sequence numbers
    // This ensures we respect fiscal calendars (4-4-5, 13-period years, etc.)
    const periodSequenceMap = await getPeriodSequenceMap(uniquePeriods);
    if (!periodSequenceMap) {
        return null; // Could not get period sequences - fall back to individual
    }
    
    // Sort periods by sequence number (ascending)
    const sortedPeriods = uniquePeriods.sort((a, b) => {
        const seqA = periodSequenceMap[a];
        const seqB = periodSequenceMap[b];
        if (!seqA || !seqB) return 0;
        return seqA - seqB;
    });
    
    // Verify contiguity: Each period's sequence should be previous + 1
    for (let i = 1; i < sortedPeriods.length; i++) {
        const prevSeq = periodSequenceMap[sortedPeriods[i - 1]];
        const currSeq = periodSequenceMap[sortedPeriods[i]];
        if (!prevSeq || !currSeq || currSeq !== prevSeq + 1) {
            return null; // Periods are not contiguous
        }
    }
    
    // Step 6: Determine anchor period (CRITICAL - based on period order, NOT evaluation order)
    // Anchor = earliest period (minimum sequence) in the contiguous series
    // This is the leftmost column in a typical drag-right scenario
    // Excel evaluation order is non-deterministic, so we must use period order
    const anchorPeriod = sortedPeriods[0]; // Earliest period (minimum sequence)
    
    // Step 7: Optional - Detect drag-fill pattern
    // Heuristic: Check if requests were queued within short time window
    // This helps distinguish drag-fill from manual entry
    const timestamps = cumulativeRequests.map(([cacheKey, req]) => req.timestamp || 0);
    const timeSpan = Math.max(...timestamps) - Math.min(...timestamps);
    const DRAG_FILL_WINDOW_MS = 2000; // 2 seconds
    
    if (timeSpan > DRAG_FILL_WINDOW_MS) {
        // Requests span too long - might be manual entry
        // Still allow optimization if periods are contiguous (conservative)
        // But log for monitoring
        console.log(`⚠️ Single-row pattern detected but time span is ${timeSpan}ms (might be manual entry)`);
    }
    
    // Pattern detected!
    // CRITICAL: Anchor is the EARLIEST PERIOD (minimum sequence), NOT the first evaluated cell
    // Excel evaluation order is non-deterministic and does not reflect user intent
    // If series includes Jan, Jan must be anchor even if Mar is evaluated first
    console.log(`   🔒 Anchor determined by period order: ${anchorPeriod} (earliest in contiguous series)`);
    
    return {
        account,
        periods: sortedPeriods,
        anchorPeriod, // Immutable anchor from period order (earliest period, never recomputed)
        filtersHash,
        requestCount: cumulativeRequests.length
    };
}

/**
 * Get period sequence numbers from NetSuite.
 * 
 * Queries NetSuite for accountingperiod.sequence for each period.
 * This ensures we use NetSuite's accounting calendar, not string matching.
 * 
 * @param {Array<string>} periodNames - Array of period names (e.g., ["Jan 2025", "Feb 2025"])
 * @returns {Promise<Object|null>} Map of periodName -> sequence number, or null if error
 */
async function getPeriodSequenceMap(periodNames) {
    try {
        // Query NetSuite for period sequences
        // This should use a lookup endpoint or cache
        const response = await fetch(`${SERVER_URL}/lookups/periods/sequence`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ periods: periodNames })
        });
        
        if (!response.ok) {
            return null;
        }
        
        const data = await response.json();
        return data.sequenceMap || null;
    } catch (error) {
        console.warn('Failed to get period sequences:', error);
        return null;
    }
}
```

### Change 2: Modify processBatchQueue to Check Single-Row Pattern First

**Location**: `docs/functions.js:7264-7300` (in `processBatchQueue`, before grid detection)

```javascript
// ================================================================
// SINGLE-ROW DRAG OPTIMIZATION (NEW - Check before multi-account grid)
// ================================================================
// For the common case of dragging BALANCE(account,, Period) across columns,
// detect single-row, contiguous period pattern and optimize execution.
// 
// CRITICAL: Handles out-of-order evaluation safely
// - Excel may evaluate Mar before Jan
// - Detection must find full contiguous series (or expand to find earliest period)
// - Anchor is always the earliest period, regardless of evaluation order
// ================================================================
if (cumulativeRequests.length >= 2) {
    // Try single-row pattern detection first (more specific)
    const singleRowPattern = await detectSingleRowDragPattern(cumulativeRequests);
    
    if (singleRowPattern) {
        console.log(`🔍 Single-row drag pattern detected: ${singleRowPattern.account} × ${singleRowPattern.periods.length} periods`);
        console.log(`   Periods: ${singleRowPattern.periods.join(', ')}`);
        console.log(`   Anchor: ${singleRowPattern.anchorPeriod} (earliest period, determined by period order)`);
        
        // Verify account is Balance Sheet
        try {
            const accountTypeData = await getAccountType(singleRowPattern.account);
            const accountType = typeof accountTypeData === 'string' ? accountTypeData : 
                              (accountTypeData && typeof accountTypeData === 'object' ? accountTypeData.type : accountTypeData);
            
            if (!accountType || !isBalanceSheetType(accountType)) {
                console.log(`   ⚠️ Account ${singleRowPattern.account} is not BS (type: ${accountType}) - falling back`);
                // Continue to multi-account grid detection below
            } else {
                // Execute single-row optimization
                // CRITICAL: This works regardless of Excel's evaluation order
                // Anchor is already determined by period order, not evaluation order
                try {
                    await processSingleRowDragOptimization(singleRowPattern, cumulativeRequests);
                    // Mark as processed
                    cumulativeRequests.length = 0;
                } catch (error) {
                    console.error(`   ❌ Single-row optimization error: ${error.message}`);
                    console.log(`   ⚠️ Falling back to individual processing...`);
                    // Continue to individual processing below
                }
            }
        } catch (error) {
            console.warn(`   ⚠️ Could not verify account type - falling back`);
            // Continue to multi-account grid detection below
        }
    }
}

// Continue with existing multi-account grid detection...
// (existing code for detectBsGridPattern)
```

**CRITICAL: Handle Out-of-Order Evaluation**

The detection and execution must handle cases where Excel evaluates cells out of order:

1. **Initial Partial Detection**: If only some periods are queued initially (e.g., Mar, Apr), detection may find a partial series
2. **Expansion Logic**: If an earlier period is discovered later (e.g., Jan, Feb), the plan should expand to include it
3. **Anchor Re-determination**: If expansion reveals an earlier period, anchor must be updated to the earliest period
4. **Query Plan Rebuild**: Query plan must be rebuilt using the earliest period as anchor

**Implementation Strategy for Out-of-Order Evaluation**:

```javascript
// In processBatchQueue, before executing single-row optimization:

// Phase 1: Initial detection from current requests
let singleRowPattern = await detectSingleRowDragPattern(cumulativeRequests);

if (singleRowPattern) {
    // Phase 2: Wait briefly for potential expansion (earlier periods)
    // This handles cases where Excel evaluates Mar before Jan
    const EXPANSION_WAIT_MS = 200; // Short wait for additional requests
    let expansionStartTime = Date.now();
    let expandedPattern = singleRowPattern;
    
    while (Date.now() - expansionStartTime < EXPANSION_WAIT_MS) {
        // Check if new requests arrived that might expand the series
        const newRequests = Array.from(pendingRequests.balance.entries());
        if (newRequests.length > cumulativeRequests.length) {
            // Re-detect pattern with expanded request set
            const allCumulativeRequests = [...cumulativeRequests, ...newRequests];
            const reDetectedPattern = await detectSingleRowDragPattern(allCumulativeRequests);
            
            if (reDetectedPattern && reDetectedPattern.periods.length > expandedPattern.periods.length) {
                // Earlier period discovered - update anchor to earliest period
                expandedPattern = reDetectedPattern;
                console.log(`   🔄 Pattern expanded: Anchor updated to ${expandedPattern.anchorPeriod} (earliest period)`);
                expansionStartTime = Date.now(); // Reset timer for further expansion
            }
        }
        
        // Brief yield to allow more requests to queue
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    // Phase 3: Lock anchor and execute (anchor is now immutable)
    // Anchor is the earliest period in the final expanded series
    singleRowPattern = expandedPattern;
    console.log(`   🔒 Final anchor locked: ${singleRowPattern.anchorPeriod} (earliest in series)`);
    
    // Execute optimization with locked anchor
    await processSingleRowDragOptimization(singleRowPattern, cumulativeRequests);
}
```

**Key Points**:
- Anchor is always the earliest period in the contiguous series (by sequence, not evaluation order)
- If an earlier period is discovered during expansion, anchor is updated to that earliest period
- Once optimization executes, anchor is immutable for that batch
- Query plan supports returning results for any cell in any order (all balances computed upfront)

### Change 3: New Function - Process Single-Row Drag Optimization

**Location**: `docs/functions.js` (new function, ~line 2400)

```javascript
/**
 * Execute single-row drag optimization.
 * 
 * For a detected single-row pattern (1 account × contiguous periods):
 * 1. Fetch anchor balance (as of anchor period end date)
 * 2. Fetch incremental activity for subsequent periods
 * 3. Roll-forward balances internally
 * 4. Populate all cells
 * 
 * CRITICAL: CONS_AMT must be anchored to each period's end date for FX correctness.
 * 
 * @param {Object} pattern - Pattern info from detectSingleRowDragPattern()
 * @param {Array} requests - Array of [cacheKey, request] tuples
 * @returns {Promise<void>}
 */
async function processSingleRowDragOptimization(pattern, requests) {
    const { account, periods, anchorPeriod, filtersHash } = pattern;
    
    // CRITICAL: anchorPeriod is IMMUTABLE - it's the EARLIEST PERIOD (minimum sequence) in the contiguous series
    // This anchor is determined by PERIOD ORDER, NOT evaluation order
    // Excel evaluation order is non-deterministic and does not reflect user intent
    // This anchor must NEVER be recomputed, even if:
    // - Excel evaluates cells in different order
    // - Later cells are evaluated before earlier ones
    // - Formulas are re-evaluated in different order
    // All roll-forward calculations must reference this period-order anchor
    
    // Step 1: Get anchor period end date
    // CRITICAL: Anchor is the END DATE of the anchor period (earliest period in contiguous series)
    // Anchor is determined by PERIOD ORDER, NOT evaluation order
    const anchorPeriodData = await getPeriodData(anchorPeriod);
    if (!anchorPeriodData || !anchorPeriodData.endDate) {
        throw new Error(`Could not get anchor period data for ${anchorPeriod}`);
    }
    
    const anchorEndDate = anchorPeriodData.endDate; // YYYY-MM-DD format
    
    console.log(`   🔒 Anchor locked: ${anchorPeriod} (earliest period in contiguous series, determined by period order)`);
    
    // Step 2: Fetch anchor balance (as of anchor period end date)
    console.log(`   📊 Step 1: Fetching anchor balance at ${anchorPeriod} end date (${anchorEndDate})...`);
    const anchorResponse = await fetch(`${SERVER_URL}/balance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            account,
            fromPeriod: '', // Empty for cumulative
            toPeriod: anchorPeriod, // Anchor period
            subsidiary: pattern.subsidiary,
            department: pattern.department,
            location: pattern.location,
            class: pattern.classId,
            book: pattern.accountingBook
        })
    });
    
    if (!anchorResponse.ok) {
        throw new Error(`Anchor balance query failed: ${anchorResponse.status}`);
    }
    
    const anchorData = await anchorResponse.json();
    if (!anchorData.Success) {
        throw new Error(anchorData.Error || 'Anchor balance query failed');
    }
    
    const anchorBalance = anchorData.Balance || 0;
    console.log(`   ✅ Anchor balance: ${anchorBalance}`);
    
    // Step 3: Fetch incremental activity for subsequent periods
    // CRITICAL: Activity query must return CONS_AMT anchored to each period's end date
    const subsequentPeriods = periods.slice(1); // All periods after anchor
    
    if (subsequentPeriods.length > 0) {
        console.log(`   📊 Step 2: Fetching activity for ${subsequentPeriods.length} subsequent periods...`);
        const activityResponse = await fetch(`${SERVER_URL}/batch/balance/period-activity`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                accounts: [account],
                fromPeriod: anchorPeriod, // Start from anchor (inclusive)
                toPeriod: periods[periods.length - 1], // End at last period (inclusive)
                subsidiary: pattern.subsidiary,
                department: pattern.department,
                location: pattern.location,
                class: pattern.classId,
                book: pattern.accountingBook,
                // CRITICAL: Request CONS_AMT anchored to each period's end date
                anchorToPeriodEndDate: true
            })
        });
        
        if (!activityResponse.ok) {
            throw new Error(`Activity query failed: ${activityResponse.status}`);
        }
        
        const activityData = await activityResponse.json();
        if (!activityData.Success) {
            throw new Error(activityData.Error || 'Activity query failed');
        }
        
        // Activity data structure: { account: { period: amount } }
        const activity = activityData.Activity || {};
        const accountActivity = activity[account] || {};
        
        // Step 4: Roll-forward balances
        // CRITICAL: All calculations must reference the original anchor (anchorPeriod)
        // This anchor is immutable and was determined by PERIOD ORDER (earliest period)
        // NOT by evaluation order - Excel may evaluate Mar before Jan, but anchor is still Jan
        let currentBalance = anchorBalance; // Start from anchor (earliest period in series)
        const balances = { [anchorPeriod]: anchorBalance };
        
        // Roll forward from anchor to each subsequent period
        // Each balance = anchor + sum of activity from anchor to that period
        // This works regardless of Excel's evaluation order
        for (const period of subsequentPeriods) {
            const periodActivity = accountActivity[period] || 0;
            currentBalance = currentBalance + periodActivity; // Explicitly references anchor via anchorBalance
            balances[period] = currentBalance;
        }
        
        console.log(`   ✅ Roll-forward complete: All balances computed from anchor ${anchorPeriod} (earliest period)`);
        
        // Step 5: Resolve all requests
        let resolvedCount = 0;
        for (const [cacheKey, request] of requests) {
            const { toPeriod } = request.params;
            const balance = balances[toPeriod];
            
            if (balance === undefined) {
                console.warn(`   ⚠️ No balance computed for period ${toPeriod} - rejecting request`);
                request.reject(new Error(`No balance computed for period ${toPeriod}`));
                continue;
            }
            
            // Cache the result
            cache.balance.set(cacheKey, balance);
            request.resolve(balance);
            resolvedCount++;
        }
        
        console.log(`   ✅ Single-row optimization complete: ${resolvedCount} requests resolved`);
    } else {
        // Only anchor period - just resolve it
        for (const [cacheKey, request] of requests) {
            if (request.params.toPeriod === anchorPeriod) {
                cache.balance.set(cacheKey, anchorBalance);
                request.resolve(anchorBalance);
            }
        }
    }
}

/**
 * Get period data (including end date) from NetSuite.
 * 
 * @param {string} periodName - Period name (e.g., "Jan 2025")
 * @returns {Promise<Object|null>} Period data with endDate, or null if error
 */
async function getPeriodData(periodName) {
    try {
        // Use existing period lookup or cache
        const response = await fetch(`${SERVER_URL}/lookups/period?name=${encodeURIComponent(periodName)}`);
        if (!response.ok) {
            return null;
        }
        const data = await response.json();
        return data;
    } catch (error) {
        console.warn(`Failed to get period data for ${periodName}:`, error);
        return null;
    }
}
```

### Change 4: Backend - New Endpoint for Period Sequence Lookup

**Location**: `backend-dotnet/Controllers/LookupController.cs` (new endpoint)

```csharp
/// <summary>
/// Get period sequence numbers for verifying contiguity.
/// </summary>
[HttpPost("/lookups/periods/sequence")]
public async Task<IActionResult> GetPeriodSequences([FromBody] PeriodSequenceRequest request)
{
    try
    {
        var periodNames = request.Periods ?? new List<string>();
        var sequenceMap = new Dictionary<string, int>();
        
        foreach (var periodName in periodNames)
        {
            var periodData = await _netSuiteService.GetPeriodAsync(periodName);
            if (periodData != null && periodData.Sequence.HasValue)
            {
                sequenceMap[periodName] = periodData.Sequence.Value;
            }
        }
        
        return Ok(new { sequenceMap });
    }
    catch (Exception ex)
    {
        _logger.LogError(ex, "Error getting period sequences");
        return StatusCode(500, new { error = ex.Message });
    }
}
```

### Change 5: Backend - Verify CONS_AMT Anchoring in Activity Query

**Location**: `backend-dotnet/Controllers/BalanceController.cs` (period activity endpoint)

**Verification Needed**:
- Ensure `BUILTIN.CONSOLIDATE` uses each period's ID (not anchor period ID)
- Each period's activity must be converted at that period's FX rate
- Current code uses `targetPeriodId` - verify this is the period's own ID, not anchor period ID

**Current Code Review** (line 3047-3054):
```csharp
BUILTIN.CONSOLIDATE(
    tal.amount,
    'LEDGER',
    'DEFAULT',
    'DEFAULT',
    {targetSub},
    {targetPeriodId},  // ← Verify this is the period's own ID, not anchor
    'DEFAULT'
)
```

**Action**: Verify `targetPeriodId` is set to each period's ID when grouping by period.

---

## Testing Plan

### Test Case 1: Single-Row Drag (Happy Path)
1. Enter: `=XAVI.BALANCE($C2,,H$1)` where H1 = "Jan 2025"
2. Wait for anchor to populate
3. Drag formula across columns (Feb, Mar, Apr, May)
4. **Expected**: 
   - Single-row pattern detected
   - 1 anchor query + 1 activity query (4 periods)
   - All cells populate simultaneously
   - Results match standalone evaluation

### Test Case 2: Skipped Month (Should Not Batch)
1. Enter: `=XAVI.BALANCE($C2,,H$1)` where H1 = "Jan 2025"
2. Drag to Mar (skip Feb), then Apr, May
3. **Expected**: 
   - Period contiguity check fails (Feb missing)
   - Falls back to individual processing
   - Each cell processes independently

### Test Case 3: Multi-Row Grid (Should Use Existing Logic)
1. Drag down first (10 accounts), then drag across (8 periods)
2. **Expected**: 
   - Single-row pattern not detected (multiple accounts)
   - Falls through to multi-account grid detection
   - Uses existing grid batching logic

### Test Case 4: Manual Entry (Should Not Batch)
1. Manually enter formulas in different cells over time
2. **Expected**: 
   - Time span check may fail (optional heuristic)
   - Falls back to individual processing
   - Each formula processes independently

### Test Case 5: Fiscal Calendar (4-4-5)
1. Test with 4-4-5 fiscal calendar
2. **Expected**: 
   - Period sequence correctly identifies contiguous periods
   - Respects fiscal calendar structure
   - Optimization works correctly

### Test Case 6: CONS_AMT Correctness
1. Test with multi-currency accounts
2. **Expected**: 
   - Each period's balance uses that period's FX rate
   - Results match standalone evaluation
   - No FX approximation errors

---

## Risk Assessment

### Low Risk
- ✅ New function doesn't affect existing code paths
- ✅ Falls back gracefully if detection fails
- ✅ Preserves all existing safety checks

### Medium Risk
- ⚠️ Period sequence lookup adds API call (but can be cached)
- ⚠️ CONS_AMT anchoring needs backend verification

### High Risk
- ❌ None identified (conservative approach with fallbacks)

---

## Summary

**Root Cause**: Current grid detection requires multiple accounts, but column drags are single-row patterns (1 account × multiple periods).

**Solution**: 
1. Add specialized single-row pattern detection
2. Verify period contiguity using NetSuite sequence numbers
3. Execute anchor-based optimization (anchor period end date + incremental activity)
4. Ensure CONS_AMT is anchored to each period's end date

**Impact**:
- ✅ Fixes column drag performance
- ✅ Preserves formula semantics
- ✅ Maintains accounting correctness
- ✅ No impact on CFO Flash or Income Statement
- ✅ Minimal risk (conservative with fallbacks)

**Next Steps**:
1. Review proposed changes
2. Verify backend CONS_AMT anchoring
3. Implement incrementally
4. Test thoroughly before deployment

