# Backend Batch Period Activity Issue Analysis

## Problem
Batch period activity queries return `BalanceResponse` with `error: "SERVERERR"` instead of `BatchPeriodActivityResponse` with `period_activity` dictionary.

## Code Review Findings

### 1. Controller Path (BalanceController.cs:128-158)
- **Line 134**: Calls `GetPeriodsInRangeAsync()` - potential exception point
- **Line 138**: Calls `GetPeriodActivityBatchAsync()` - main execution point
- **Line 154-157**: Catch block returns `StatusCode(500, new { error = ex.Message })`

**Issue**: The response we're seeing is HTTP 200 with `BalanceResponse`, not HTTP 500. This suggests:
- Exception is being caught and transformed by middleware/global error handler
- OR exception is happening in a different code path
- OR response is being transformed somewhere

### 2. Service Implementation (BalanceService.cs:2499-2707)
The `GetPeriodActivityBatchAsync` method looks correct:
- Gets periods in range (line 2513)
- Resolves subsidiary and filters (lines 2523-2550)
- Builds SQL query with sign flip (lines 2555-2628)
- Loops through accounts and queries each (lines 2594-2681)
- Returns `BatchPeriodActivityResponse` (lines 2703-2706)

**Potential Issues**:
1. **Line 2557-2558**: Uses `AccountType.SignFlipTypesSql` and `AccountType.IncomeTypesSql` in SQL string interpolation
   - These are properties that call `FormatForSql()` which should work
   - But if `SignFlipTypes` is empty or null, could cause SQL syntax error

2. **Line 2628**: `ORDER BY ap.startdate` - this is used in other working queries, so should be fine

3. **Line 2633**: `QueryRawWithErrorAsync(query, 300)` - if query fails, it should be caught and logged

### 3. Query Structure Comparison
Comparing with working single-account version (`GetPeriodActivityBreakdownAsync`, line 2050-2078):
- Same query structure
- Same ORDER BY clause
- Same sign flip logic
- **Difference**: Single-account version works, batch version fails

### 4. Exception Handling
- Individual account errors are caught (line 2676-2680) and added to `errors` list
- Method continues processing other accounts
- Final response includes errors if any (lines 2694-2700)

## Root Cause Hypothesis

The most likely issue is that an exception is being thrown **before** `GetPeriodActivityBatchAsync` is called, specifically in:
1. **Line 134**: `GetPeriodsInRangeAsync()` - if this throws, it's caught by controller catch block
2. **Line 135-136**: Period count check - if this fails, returns BadRequest (not our case)

But the response structure suggests the exception might be happening in a way that causes the code to fall through to the single-account path, which then returns a `BalanceResponse` with error.

## Recommended Fixes

### Fix 1: Add Better Error Logging
Add detailed logging at the start of `GetPeriodActivityBatchAsync`:

```csharp
public async Task<BatchPeriodActivityResponse> GetPeriodActivityBatchAsync(...)
{
    try
    {
        _logger.LogInformation("Batch period activity: {AccountCount} accounts, from_period={FromPeriod}, to_period={ToPeriod}", 
            accounts.Count, fromPeriod, toPeriod);
        
        // Get all periods between fromPeriod and toPeriod
        var periods = await GetPeriodsInRangeAsync(fromPeriod, toPeriod);
        _logger.LogDebug("Found {PeriodCount} periods in range", periods.Count);
        
        if (!periods.Any())
        {
            _logger.LogWarning("No periods found in range {FromPeriod} to {ToPeriod}", fromPeriod, toPeriod);
            return new BatchPeriodActivityResponse
            {
                Error = "Could not find periods in range"
            };
        }
        // ... rest of method
    }
    catch (Exception ex)
    {
        _logger.LogError(ex, "Exception in GetPeriodActivityBatchAsync: {Message}", ex.Message);
        return new BatchPeriodActivityResponse
        {
            Error = $"SERVERERR: {ex.Message}"
        };
    }
}
```

### Fix 2: Verify AccountType Properties
Add null/empty checks for SQL string properties:

```csharp
var signFlipTypes = AccountType.SignFlipTypesSql;
var incomeTypes = AccountType.IncomeTypesSql;

if (string.IsNullOrEmpty(signFlipTypes) || string.IsNullOrEmpty(incomeTypes))
{
    _logger.LogError("AccountType SQL properties are null or empty");
    return new BatchPeriodActivityResponse
    {
        Error = "Configuration error: AccountType SQL properties missing"
    };
}
```

### Fix 3: Add Try-Catch in Controller
Wrap the `GetPeriodsInRangeAsync` call separately:

```csharp
List<string> periods;
try
{
    periods = await _balanceService.GetPeriodsInRangeAsync(from_period, to_period);
}
catch (Exception ex)
{
    _logger.LogError(ex, "Error getting periods in range: {FromPeriod} to {ToPeriod}", from_period, to_period);
    return StatusCode(500, new { error = $"Period resolution failed: {ex.Message}" });
}

if (periods.Count > MAX_PERIODS_PER_BATCH)
    return BadRequest(new { error = $"Too many periods: {periods.Count} (max: {MAX_PERIODS_PER_BATCH})" });
```

## Next Steps

1. **Check Server Logs**: Review actual exception stack trace from server logs
2. **Add Logging**: Implement Fix 1 to get better visibility
3. **Test Period Resolution**: Verify "Feb 2025" and "Mar 2025" resolve correctly
4. **Test Single Account**: Verify single-account batch mode works (should fall through to `GetPeriodActivityBreakdownAsync`)

## Test Query

The failing query structure:
```sql
SELECT 
    ap.periodname AS period_name,
    SUM(
        TO_NUMBER(
            BUILTIN.CONSOLIDATE(
                tal.amount,
                'LEDGER',
                'DEFAULT',
                'DEFAULT',
                {targetSub},
                ap.id,
                'DEFAULT'
            )
        ) * {signFlip}
    ) AS period_activity
FROM transactionaccountingline tal
JOIN transaction t ON t.id = tal.transaction
JOIN account a ON a.id = tal.account
JOIN accountingperiod ap ON ap.id = t.postingperiod
{tlJoin}
WHERE t.posting = 'T'
  AND tal.posting = 'T'
  AND {NetSuiteService.BuildAccountFilter(new[] { account })}
  AND ap.id IN ({periodIdList})
  AND tal.accountingbook = {accountingBook}
  {whereSegment}
GROUP BY ap.periodname
ORDER BY ap.startdate
```

This query structure is identical to the working single-account version, so the issue is likely in:
- Period resolution
- Account filter construction
- Exception handling/transformation

