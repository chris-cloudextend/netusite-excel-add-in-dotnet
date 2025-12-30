# Column-Based Balance Sheet Batching - Implementation Plan

## Problem Statement

The current row-by-row batching approach has fundamental performance and correctness issues:
- **Performance**: 84+ accounts × 2 queries each = 168+ queries = 20-40 minutes
- **Correctness**: Incorrect zero values appearing in results
- **Scalability**: Does not scale with grid size

## Solution: Column-Based Batching

Align with income statement batching pattern:
- **One opening balance query** for all accounts (anchor date)
- **One period-activity query per column** (or single multi-period query)
- **Local cumulative math** to derive balances additively from anchor

### Benefits
- **Dramatic query reduction**: 84 accounts × 4 periods = 168 queries → 5 queries (1 opening + 4 period activity)
- **No Cloudflare pressure**: Only 5 concurrent queries max
- **Simpler correctness**: Single source of truth per period
- **Faster execution**: Seconds instead of minutes

## Current Income Statement Batching Pattern

Income statements use `/batch/full_year_refresh` or `/batch/typebalance_refresh`:
- Single query for all accounts × all periods
- Returns `{balances: {account: {period: value}}}`
- Computed server-side, returned as complete grid

## Proposed Column-Based Balance Sheet Pattern

### Grid Detection

**Pattern**: Detect when multiple Balance Sheet accounts are evaluated in the same Excel recalculation wave, with:
- Same `toPeriod` (column-based)
- Missing or empty `fromPeriod` (cumulative)
- Same filters (subsidiary, department, etc.)
- Account type = Balance Sheet

**Detection Logic**:
```javascript
function detectColumnBasedBSGrid(evaluatingRequests) {
    // Group by: toPeriod + filters (not by account)
    const byColumn = new Map(); // Map<columnKey, {period, filters, accounts: Set}>

    for (const request of evaluatingRequests) {
        if (!isBalanceSheetCumulative(request)) continue;
        
        const columnKey = `${request.toPeriod}::${getFilterKey(request.filters)}`;
        if (!byColumn.has(columnKey)) {
            byColumn.set(columnKey, {
                period: request.toPeriod,
                filters: request.filters,
                accounts: new Set()
            });
        }
        byColumn.get(columnKey).accounts.add(request.account);
    }

    // Check if we have multiple columns (periods) and multiple accounts
    if (byColumn.size >= 2 && Array.from(byColumn.values()).some(col => col.accounts.size >= 2)) {
        return {
            eligible: true,
            columns: Array.from(byColumn.values()),
            allAccounts: new Set(Array.from(byColumn.values()).flatMap(col => Array.from(col.accounts)))
        };
    }

    return { eligible: false };
}
```

### Query Strategy

**Step 1: Opening Balance Query (All Accounts)**
```
GET /balance?account=10010,10011,10012,...&anchor_date=2024-12-31&batch_mode=true
```
Returns: `{balances: {account: balance}}`

**Step 2: Period Activity Query (Per Column)**
```
GET /balance?account=10010,10011,10012,...&from_period=Jan+2025&to_period=Jan+2025&batch_mode=true&include_period_breakdown=true
```
Returns: `{period_activity: {account: activity}}`

**OR (Better): Single Multi-Period Query**
```
GET /balance?account=10010,10011,10012,...&from_period=Jan+2025&to_period=Apr+2025&batch_mode=true&include_period_breakdown=true
```
Returns: `{period_activity: {account: {period: activity}}}`

### Local Computation

```javascript
function computeColumnBasedBalances(accounts, periods, openingBalances, periodActivity) {
    const results = {}; // {account: {period: balance}}

    for (const account of accounts) {
        const opening = openingBalances[account] || 0;
        results[account] = {};

        let runningBalance = opening;
        for (const period of periods) {
            const activity = periodActivity[account]?.[period] || 
                           (typeof periodActivity[account] === 'number' ? periodActivity[account] : 0);
            runningBalance += activity;
            results[account][period] = runningBalance;
        }
    }

    return results;
}
```

## Implementation Plan

### Phase 1: Backend Support

**1.1: Multi-Account Opening Balance**
- Extend `/balance` endpoint to accept comma-separated accounts
- Return `{balances: {account: balance}}` when `batch_mode=true` and multiple accounts
- Example: `GET /balance?account=10010,10011,10012&anchor_date=2024-12-31&batch_mode=true`

**1.2: Multi-Account Period Activity**
- Extend `/balance` endpoint to accept comma-separated accounts
- Return `{period_activity: {account: {period: activity}}}` when `batch_mode=true` and `include_period_breakdown=true`
- Example: `GET /balance?account=10010,10011,10012&from_period=Jan+2025&to_period=Apr+2025&batch_mode=true&include_period_breakdown=true`

**1.3: Single Multi-Period Query (Optional Optimization)**
- If all columns are contiguous, use single query: `from_period=earliest&to_period=latest`
- Backend returns per-period breakdown: `{period_activity: {account: {period: activity}}}`

### Phase 2: Frontend Grid Detection

**2.1: Column-Based Detection**
- Replace `checkBatchEligibilitySynchronous` with `detectColumnBasedBSGrid`
- Group by `toPeriod + filters` (not by account)
- Require: Multiple accounts AND multiple periods (columns)

**2.2: Account Type Gate (Unchanged)**
- Income/Expense accounts still route to existing logic
- Only Balance Sheet accounts enter column-based batching

### Phase 3: Query Execution

**3.1: Opening Balance Query**
```javascript
async function fetchOpeningBalancesForAccounts(accounts, anchorDate, filters) {
    const params = new URLSearchParams();
    params.append('account', accounts.join(',')); // Comma-separated
    params.append('anchor_date', anchorDate);
    params.append('batch_mode', 'true');
    
    // Add filters...
    const url = `${SERVER_URL}/balance?${params.toString()}`;
    const response = await fetch(url);
    const data = await response.json();
    return data.balances || {}; // {account: balance}
}
```

**3.2: Period Activity Query**
```javascript
async function fetchPeriodActivityForAccounts(accounts, fromPeriod, toPeriod, filters) {
    const params = new URLSearchParams();
    params.append('account', accounts.join(',')); // Comma-separated
    params.append('from_period', fromPeriod);
    params.append('to_period', toPeriod);
    params.append('batch_mode', 'true');
    params.append('include_period_breakdown', 'true');
    
    // Add filters...
    const url = `${SERVER_URL}/balance?${params.toString()}`;
    const response = await fetch(url);
    const data = await response.json();
    return data.period_activity || {}; // {account: {period: activity}}
}
```

**3.3: Column-Based Batch Execution**
```javascript
async function executeColumnBasedBSBatch(grid) {
    const { allAccounts, columns, filters } = grid;
    
    // Infer anchor
    const earliestPeriod = columns[0].period; // Assuming sorted
    const anchorDate = inferAnchorDate([earliestPeriod]);
    
    // Query 1: Opening balances for all accounts
    console.log(`📊 Query 1: Opening balances for ${allAccounts.size} accounts as of ${anchorDate}`);
    const openingBalances = await fetchOpeningBalancesForAccounts(
        Array.from(allAccounts),
        anchorDate,
        filters
    );
    
    // Query 2: Period activity (single multi-period query if contiguous, else per-column)
    const periods = columns.map(col => col.period);
    const isContiguous = checkContiguous(periods);
    
    if (isContiguous) {
        // Single query for all periods
        console.log(`📊 Query 2: Period activity for ${allAccounts.size} accounts, ${periods.length} periods`);
        const periodActivity = await fetchPeriodActivityForAccounts(
            Array.from(allAccounts),
            periods[0],
            periods[periods.length - 1],
            filters
        );
        
        // Compute balances
        return computeColumnBasedBalances(allAccounts, periods, openingBalances, periodActivity);
    } else {
        // Per-column queries (fallback)
        const results = {};
        for (const column of columns) {
            const activity = await fetchPeriodActivityForAccounts(
                Array.from(allAccounts),
                column.period,
                column.period,
                filters
            );
            // Merge into results...
        }
        return results;
    }
}
```

### Phase 4: Integration

**4.1: Replace Row-Based Detection**
- Remove `checkBatchEligibilitySynchronous` (row-based)
- Add `detectColumnBasedBSGrid` (column-based)
- Update `BALANCE()` to use column-based detection

**4.2: Deprecate Row-Based Path**
- Remove `executeBalanceSheetBatchQueryImmediate` (row-based)
- Remove `executeBalanceSheetBatchQuery` (row-based)
- Remove semaphore (no longer needed - only 1-5 queries total)
- Keep account-specific lock for same-account deduplication

**4.3: Update BALANCE() Function**
```javascript
async function BALANCE(account, fromPeriod, toPeriod, ...) {
    // Account type gate (unchanged)
    if (isIncomeExpense(accountType)) {
        // Route to existing IS logic
        return await existingISLogic(...);
    }
    
    // Column-based grid detection
    const evalKey = `${account}::${toPeriod}::${getFilterKey(filters)}`;
    pendingEvaluation.balance.set(evalKey, { account, toPeriod, filters });
    
    const gridDetection = detectColumnBasedBSGrid(
        Array.from(pendingEvaluation.balance.values())
    );
    
    if (gridDetection.eligible) {
        // Execute column-based batch
        const results = await executeColumnBasedBSBatch(gridDetection);
        const balance = results[account]?.[toPeriod];
        if (balance !== undefined) {
            pendingEvaluation.balance.delete(evalKey);
            return balance;
        }
    }
    
    // Fallback to existing per-cell path
    pendingEvaluation.balance.delete(evalKey);
    return await existingPerCellLogic(...);
}
```

## Backend API Changes

### BalanceController.cs

```csharp
[HttpGet("/balance")]
public async Task<IActionResult> GetBalance(
    [FromQuery] string account,  // Can be comma-separated: "10010,10011,10012"
    [FromQuery] string? from_period = null,
    [FromQuery] string? to_period = null,
    [FromQuery] string? anchor_date = null,
    [FromQuery] bool batch_mode = false,
    [FromQuery] bool include_period_breakdown = false,
    // ... filters ...
)
{
    // Parse comma-separated accounts
    var accounts = account.Split(',', StringSplitOptions.RemoveEmptyEntries)
                          .Select(a => a.Trim())
                          .ToList();
    
    if (accounts.Count == 0)
        return BadRequest(new { error = "At least one account is required" });
    
    // If batch_mode and multiple accounts, return batch response
    if (batch_mode && accounts.Count > 1) {
        if (!string.IsNullOrEmpty(anchor_date)) {
            // Opening balances for all accounts
            var openingBalances = new Dictionary<string, decimal>();
            foreach (var acc in accounts) {
                var balance = await _balanceService.GetOpeningBalanceAsync(acc, anchor_date, filters);
                openingBalances[acc] = balance;
            }
            return Ok(new { balances = openingBalances });
        }
        
        if (include_period_breakdown && !string.IsNullOrEmpty(from_period) && !string.IsNullOrEmpty(to_period)) {
            // Period activity for all accounts with breakdown
            var periodActivity = new Dictionary<string, Dictionary<string, decimal>>();
            foreach (var acc in accounts) {
                var activity = await _balanceService.GetPeriodActivityBreakdownAsync(
                    acc, from_period, to_period, filters);
                periodActivity[acc] = activity;
            }
            return Ok(new { period_activity = periodActivity });
        }
    }
    
    // Single account (existing behavior)
    // ...
}
```

### BalanceService.cs

**Optimization**: If multiple accounts requested, consider batching NetSuite queries:
- Single SuiteQL query with `IN (account1, account2, ...)`
- Reduces NetSuite round-trips

## Migration Strategy

### Step 1: Add Column-Based Detection (Parallel)
- Implement `detectColumnBasedBSGrid` alongside existing row-based detection
- Add feature flag: `USE_COLUMN_BASED_BS_BATCHING = true`

### Step 2: Backend Support
- Implement multi-account support in backend
- Test with single account first (backward compatible)
- Then test with multiple accounts

### Step 3: Frontend Integration
- Replace row-based detection with column-based
- Update `BALANCE()` to use column-based path
- Keep fallback to per-cell path

### Step 4: Deprecation
- Remove row-based batch code
- Remove semaphore
- Clean up unused functions

## Testing Strategy

### Unit Tests
- Grid detection: Multiple accounts, multiple periods
- Query building: Comma-separated accounts, filters
- Balance computation: Opening + activity = ending

### Integration Tests
- Small grid: 3 accounts × 3 periods = 1 opening + 1 period query = 2 queries
- Large grid: 20 accounts × 12 periods = 1 opening + 1 period query = 2 queries
- Non-contiguous periods: 1 opening + N period queries (one per column)

### Performance Tests
- Compare: Row-based (168 queries) vs Column-based (2 queries)
- Measure: Query count, total time, correctness

## Success Criteria

- **Query Reduction**: 84 accounts × 4 periods = 168 queries → 2-5 queries
- **Performance**: Total time < 2 minutes (vs 20-40 minutes)
- **Correctness**: All balances match NetSuite exactly
- **No 524 Errors**: Only 1-5 concurrent queries
- **Backward Compatibility**: Single-account formulas still work

## Risk Mitigation

1. **Backend Changes**: Start with single-account support, then add multi-account
2. **Grid Detection**: Conservative - require multiple accounts AND multiple periods
3. **Fallback**: Always fall back to per-cell path if detection fails
4. **Testing**: Test with small grids first, then scale up

## Timeline Estimate

- **Phase 1 (Backend)**: 2-3 days
- **Phase 2 (Frontend Detection)**: 1-2 days
- **Phase 3 (Query Execution)**: 2-3 days
- **Phase 4 (Integration & Testing)**: 2-3 days
- **Total**: ~1-2 weeks

## Open Questions

1. **Backend Optimization**: Should we batch NetSuite queries (single SuiteQL with `IN` clause)?
2. **Period Contiguity**: Always use single multi-period query, or per-column fallback?
3. **Filter Variations**: What if accounts have different filters? (Currently assume same filters)
4. **Account Limit**: Max accounts per batch? (Safety limit)

