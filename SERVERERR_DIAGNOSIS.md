# SERVERERR Diagnosis: Period Activity Breakdown Query

## Issue Summary
The backend is returning `SERVERERR` (BadRequest) when executing period activity breakdown queries with `batch_mode=true` and `include_period_breakdown=true`.

## Error Details
- **Error Code**: `INVALID_PARAMETER`
- **NetSuite Message**: "Invalid search query. Detailed unprocessed description follows. Search error occurred: Invalid or unsupported search."
- **Query Length**: 1207 characters (after CASE statement fix)

## Root Cause Analysis

### The Problematic Query
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
                1,
                ap.id,  -- ⚠️ THIS IS THE PROBLEM
                'DEFAULT'
            )
        ) * CASE WHEN a.accttype IN (...) THEN -1 WHEN a.accttype IN (...) THEN -1 ELSE 1 END
    ) AS period_activity
FROM transactionaccountingline tal
JOIN transaction t ON t.id = tal.transaction
JOIN account a ON a.id = tal.account
JOIN accountingperiod ap ON ap.id = t.postingperiod
WHERE t.posting = 'T'
  AND tal.posting = 'T'
  AND a.acctnumber IN ('10010')
  AND ap.id IN (345)
  AND tal.accountingbook = 1
GROUP BY ap.periodname
ORDER BY ap.startdate
```

### The Issue
**NetSuite's `BUILTIN.CONSOLIDATE` function does not accept a column reference (`ap.id`) as the period parameter.** It requires a literal period ID value or a subquery that returns a single value.

In the query above, we're trying to use `ap.id` (which varies by row) as the period parameter, but NetSuite expects a constant value for currency conversion.

### Comparison with Working Queries

**Working Query Pattern** (from `GetPeriodActivityBatchAsync`):
```sql
BUILTIN.CONSOLIDATE(
    tal.amount,
    'LEDGER',
    'DEFAULT',
    'DEFAULT',
    {targetSub},
    {targetPeriodId},  -- ✅ Constant value
    'DEFAULT'
)
```

**Problematic Query Pattern** (from `GetPeriodActivityBreakdownAsync`):
```sql
BUILTIN.CONSOLIDATE(
    tal.amount,
    'LEDGER',
    'DEFAULT',
    'DEFAULT',
    {targetSub},
    ap.id,  -- ❌ Column reference (varies by row)
    'DEFAULT'
)
```

## Solution Options

### Option 1: Use a Single Period ID (Simplest)
If we're querying a single period (which is the case for `from_period == to_period`), use the period ID directly instead of `ap.id`:

```sql
BUILTIN.CONSOLIDATE(
    tal.amount,
    'LEDGER',
    'DEFAULT',
    'DEFAULT',
    {targetSub},
    {periodId},  -- Use the resolved period ID
    'DEFAULT'
)
```

**Limitation**: This only works for single-period queries. For multi-period queries, we'd need a different approach.

### Option 2: Remove BUILTIN.CONSOLIDATE for Period Activity
Since period activity queries are already filtered by `ap.id IN ({periodIdList})`, and we're grouping by period, we might not need `BUILTIN.CONSOLIDATE` at all if:
- All transactions are already in the base currency, OR
- We can use a different approach for currency conversion

**However**, this might break currency conversion for multi-currency scenarios.

### Option 3: Use a Subquery or CASE Statement
Use a CASE statement to map each `ap.id` to its corresponding period ID, but this is complex and may not work if NetSuite doesn't support it.

### Option 4: Query Each Period Separately
Instead of a single query with `GROUP BY ap.periodname`, execute separate queries for each period. This is less efficient but guaranteed to work.

## Recommended Fix

**For single-period queries** (`from_period == to_period`):
- Use the resolved period ID directly instead of `ap.id`
- This matches the pattern used in other working queries

**For multi-period queries**:
- Consider using Option 4 (separate queries per period) OR
- Investigate if NetSuite supports a different syntax for multi-period consolidation

## Test Case
- **Account**: 10010
- **From Period**: Feb 2025
- **To Period**: Feb 2025
- **Expected**: In-period activity for February 2025
- **Actual**: SERVERERR

## Next Steps
1. Modify `GetPeriodActivityBreakdownAsync` to use the resolved period ID instead of `ap.id` for single-period queries
2. Test with the same parameters
3. If successful, extend to multi-period queries if needed

