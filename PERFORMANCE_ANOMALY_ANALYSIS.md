# Performance Anomaly Analysis: Income Statement Period Range Queries

## Executive Summary

Income Statement period range queries show a dramatic performance degradation when the range includes 2023, jumping from **0.24 seconds** (2024-2025) to **74.64 seconds** (2023-2025). Subsequent year additions only add 5-15 seconds each, suggesting a threshold or data anomaly at 2023.

### Critical Finding: Single Year Performance

Testing individual years reveals:
- **Jan 2023 to Dec 2023**: **14.56 seconds** (not cached)
- **Jan 2024 to Dec 2024**: **17.87 seconds** (not cached)
- **Jan 2025 to Dec 2025**: **0.33 seconds** (cached - query_count: 0)

**Key Insight**: 2023 alone takes 14.56s, but when combined with 2024-2025, it jumps to 74.64s. This suggests the issue is **not** 2023 data volume alone, but rather a **query execution plan threshold** that triggers when combining 2023 with more recent years.

## Performance Data

### Single Year Queries (Baseline)

| Period Range | Query Time | Cached | Notes |
|-------------|------------|--------|-------|
| Jan 2023 to Dec 2023 | **14.56s** | No (query_count: 2) | 2023 alone |
| Jan 2024 to Dec 2024 | **17.87s** | No (query_count: 2) | 2024 alone (slower than 2023!) |
| Jan 2025 to Dec 2025 | **0.33s** | Yes (query_count: 0) | 2025 alone (cached) |

### Multi-Year Range Queries

| From Period | To Period | Years | Query Time | Performance Change |
|------------|-----------|-------|------------|-------------------|
| Jan 2025 | Dec 2025 | 1 | **0.28s** | Baseline (likely cached) |
| Jan 2024 | Dec 2025 | 2 | **0.24s** | Fast (likely cached) |
| Jan 2023 | Dec 2025 | 3 | **74.64s** | **+74.40s (310x slower)** ⚠️ |
| Jan 2022 | Dec 2025 | 4 | **84.87s** | +10.23s |
| Jan 2021 | Dec 2025 | 5 | **81.55s** | -3.32s (faster!) |
| Jan 2020 | Dec 2025 | 6 | **88.23s** | +6.68s |
| Jan 2019 | Dec 2025 | 7 | **76.99s** | -11.24s (faster!) |
| Jan 2018 | Dec 2025 | 8 | **87.90s** | +10.91s |
| Jan 2017 | Dec 2025 | 9 | **77.18s** | -10.72s (faster!) |
| Jan 2016 | Dec 2025 | 10 | **80.84s** | +3.66s |
| Jan 2015 | Dec 2025 | 11 | **81.37s** | +0.53s |

### Key Observations

1. **Massive jump at 2023**: Adding 2023 causes a 310x slowdown (0.24s → 74.64s)
2. **2023 alone is not the problem**: Single year 2023 query takes 14.56s (reasonable), but combining with 2024-2025 causes 74.64s
3. **2024 is actually slower than 2023**: Single year 2024 takes 17.87s vs 14.56s for 2023
4. **Caching effect**: 2025 queries are cached (0.33s), which explains why 2024-2025 is so fast (0.24s)
5. **Inconsistent subsequent performance**: Adding more years sometimes makes queries faster (2021, 2019, 2017)
6. **Stable range after 2023**: All queries 3+ years take 75-88 seconds, regardless of how many additional years are added

### Critical Insight

The performance anomaly is **NOT** caused by 2023 data volume alone. The issue appears when:
- **2023 is combined with 2024-2025**: 74.64s (310x slower)
- **2023 alone**: 14.56s (reasonable)
- **2024-2025 together**: 0.24s (cached)

This strongly suggests NetSuite's query optimizer switches to a **different execution plan** when the date range spans across a certain threshold (likely when combining 2023 with more recent cached data, or when the range exceeds 2 years of recent data).

## Query Being Executed

The backend generates a single SuiteQL query for period ranges:

```sql
SELECT 
    a.acctnumber,
    SUM(
        TO_NUMBER(
            BUILTIN.CONSOLIDATE(
                tal.amount,
                'LEDGER',
                'DEFAULT',
                'DEFAULT',
                {targetSub},
                t.postingperiod,
                'DEFAULT'
            )
        ) * {signFlip}
    ) as balance
FROM transactionaccountingline tal
JOIN transaction t ON t.id = tal.transaction
JOIN account a ON a.id = tal.account
JOIN accountingperiod ap ON ap.id = t.postingperiod
JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
WHERE t.posting = 'T'
  AND tal.posting = 'T'
  AND {plAccountFilter}  -- e.g., a.acctnumber = '4220'
  AND ap.startdate >= TO_DATE('{fromStartDate}', 'YYYY-MM-DD')  -- e.g., '2013-01-01'
  AND ap.enddate <= TO_DATE('{toEndDate}', 'YYYY-MM-DD')        -- e.g., '2025-12-31'
  AND a.accttype IN ({AccountType.PlTypesSql})  -- Income, Expense, COGS, etc.
  AND tal.accountingbook = {accountingBook}
  AND {segmentWhere}  -- Subsidiary, department, location, class filters
GROUP BY a.acctnumber
```

### Example Query for 2023-2025

```sql
SELECT 
    a.acctnumber,
    SUM(
        TO_NUMBER(
            BUILTIN.CONSOLIDATE(
                tal.amount,
                'LEDGER',
                'DEFAULT',
                'DEFAULT',
                1,  -- targetSub
                t.postingperiod,
                'DEFAULT'
            )
        ) * CASE WHEN a.accttype IN ('Income', 'OthIncome') THEN -1 ELSE 1 END
    ) as balance
FROM transactionaccountingline tal
JOIN transaction t ON t.id = tal.transaction
JOIN account a ON a.id = tal.account
JOIN accountingperiod ap ON ap.id = t.postingperiod
JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
WHERE t.posting = 'T'
  AND tal.posting = 'T'
  AND a.acctnumber = '4220'
  AND ap.startdate >= TO_DATE('2023-01-01', 'YYYY-MM-DD')
  AND ap.enddate <= TO_DATE('2025-12-31', 'YYYY-MM-DD')
  AND a.accttype IN ('Income', 'Expense', 'COGS', 'OthIncome', 'OthExpense')
  AND tal.accountingbook = 1
  AND tl.subsidiary IN (1, 3, 4, 2, 5, 6, 7, 8)
GROUP BY a.acctnumber
```

## Relevant Code

### Backend: BalanceService.cs (Period Range Query)

**Location**: `backend-dotnet/Services/BalanceService.cs`, lines 1299-1377

```csharp
if (isPeriodRange)
{
    // PERIOD RANGE QUERY: Single query summing all periods in range
    isRangeQuery = true;
    plQuery = $@"
        SELECT 
            a.acctnumber,
            SUM(
                TO_NUMBER(
                    BUILTIN.CONSOLIDATE(
                        tal.amount,
                        'LEDGER',
                        'DEFAULT',
                        'DEFAULT',
                        {targetSub},
                        t.postingperiod,
                        'DEFAULT'
                    )
                ) * {signFlip}
            ) as balance
        FROM transactionaccountingline tal
        JOIN transaction t ON t.id = tal.transaction
        JOIN account a ON a.id = tal.account
        JOIN accountingperiod ap ON ap.id = t.postingperiod
        JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
        WHERE t.posting = 'T'
          AND tal.posting = 'T'
          AND {plAccountFilter}
          AND ap.startdate >= TO_DATE('{fromStartDate}', 'YYYY-MM-DD')
          AND ap.enddate <= TO_DATE('{toEndDate}', 'YYYY-MM-DD')
          AND a.accttype IN ({AccountType.PlTypesSql})
          AND tal.accountingbook = {accountingBook}
          AND {segmentWhere}
        GROUP BY a.acctnumber";
    
    _logger.LogInformation("📅 P&L PERIOD RANGE QUERY: {Count} accounts, {From} to {To} ({PeriodCount} periods) - SINGLE QUERY", 
        plAccounts.Count, fromPeriodForRange, toPeriodForRange, expandedPeriods.Count);
}

// Use extended timeout for period range queries
int plQueryTimeout = isRangeQuery ? 300 : 30; // 5 minutes for range, 30s for list
if (isRangeQuery)
{
    _logger.LogInformation("⏱️ Using extended timeout ({Timeout}s) for period range query", plQueryTimeout);
}
var plResult = await _netSuiteService.QueryRawWithErrorAsync(plQuery, plQueryTimeout);
```

### Date Range Calculation

**Location**: `backend-dotnet/Services/BalanceService.cs`, lines 1112-1123

```csharp
var fromPeriodData = await _netSuiteService.GetPeriodAsync(fromPeriodForRange);
var toPeriodData = await _netSuiteService.GetPeriodAsync(toPeriodForRange);

if (fromPeriodData?.StartDate == null || toPeriodData?.EndDate == null)
{
    _logger.LogWarning("Could not resolve period dates for range: {From} to {To}", 
        fromPeriodForRange, toPeriodForRange);
    return result;
}

fromStartDate = ConvertToYYYYMMDD(fromPeriodData.StartDate);
toEndDate = ConvertToYYYYMMDD(toPeriodData.EndDate);
```

## Theories for the 2023 Performance Jump

### Theory 1: Query Execution Plan Threshold (Most Likely)

**Hypothesis**: NetSuite's query optimizer switches to a different execution plan when the date range crosses a certain threshold (likely related to data volume or index statistics).

**Evidence**:
- The jump happens at a specific year (2023), not gradually
- Subsequent years don't proportionally increase query time
- The query time stabilizes around 75-88s regardless of range size

**Investigation Steps**:
1. Check NetSuite query execution plans for 2024-2025 vs 2023-2025
2. Review NetSuite index statistics for `transactionaccountingline` and `accountingperiod` tables
3. Check if there's a data volume threshold that triggers a different plan

### Theory 2: Data Volume Anomaly in 2023

**Hypothesis**: 2023 has significantly more transaction data than 2024-2025, causing the query to scan much more data.

**Evidence**:
- The jump is specific to including 2023
- Performance doesn't degrade proportionally with more years

**Investigation Steps**:
1. Count transactions per year for account 4220:
   ```sql
   SELECT 
       EXTRACT(YEAR FROM ap.startdate) as year,
       COUNT(DISTINCT t.id) as transaction_count,
       COUNT(tal.id) as accounting_line_count
   FROM transactionaccountingline tal
   JOIN transaction t ON t.id = tal.transaction
   JOIN account a ON a.id = tal.account
   JOIN accountingperiod ap ON ap.id = t.postingperiod
   WHERE a.acctnumber = '4220'
     AND t.posting = 'T'
     AND tal.posting = 'T'
   GROUP BY EXTRACT(YEAR FROM ap.startdate)
   ORDER BY year DESC;
   ```

### Theory 3: Index Fragmentation or Missing Index

**Hypothesis**: The date range index on `accountingperiod` or join indexes become inefficient when crossing into 2023.

**Evidence**:
- Specific threshold behavior suggests index-related issue
- Query uses date range filters (`ap.startdate >= ... AND ap.enddate <= ...`)

**Investigation Steps**:
1. Check if NetSuite has indexes on:
   - `accountingperiod.startdate`
   - `accountingperiod.enddate`
   - Composite indexes on `(accountingperiod.id, startdate, enddate)`
2. Review index usage in query execution plan

### Theory 4: BUILTIN.CONSOLIDATE Performance Threshold

**Hypothesis**: The `BUILTIN.CONSOLIDATE` function has performance characteristics that degrade when processing data across a certain time threshold, possibly related to subsidiary hierarchy calculations.

**Evidence**:
- The query uses `BUILTIN.CONSOLIDATE` which is computationally expensive
- The subsidiary hierarchy includes 8 subsidiaries: `(1, 3, 4, 2, 5, 6, 7, 8)`
- Consolidation calculations may have thresholds based on data volume

**Investigation Steps**:
1. Test query without `BUILTIN.CONSOLIDATE` to isolate the issue
2. Check if consolidating fewer subsidiaries improves performance
3. Review NetSuite documentation on `BUILTIN.CONSOLIDATE` performance characteristics

### Theory 5: NetSuite Query Result Caching

**Hypothesis**: 2024-2025 queries are hitting cached results, while 2023-2025 queries are not.

**Evidence**:
- 2024-2025 is extremely fast (0.24s) - suspiciously fast for a full year query
- Subsequent queries (2023-2025, 2022-2025, etc.) are consistently slower

**Investigation Steps**:
1. Clear NetSuite query cache and retest
2. Check if running 2023-2025 first, then 2024-2025 changes the pattern
3. Review NetSuite caching behavior for SuiteQL queries

## Recommended Investigation

### Immediate Actions

1. **Execute EXPLAIN PLAN** on both queries:
   - Run `EXPLAIN PLAN` for 2024-2025 range
   - Run `EXPLAIN PLAN` for 2023-2025 range
   - Compare execution plans to identify differences

2. **Check data volume by year**:
   ```sql
   SELECT 
       EXTRACT(YEAR FROM ap.startdate) as year,
       COUNT(DISTINCT t.id) as transactions,
       COUNT(tal.id) as accounting_lines,
       SUM(ABS(tal.amount)) as total_amount
   FROM transactionaccountingline tal
   JOIN transaction t ON t.id = tal.transaction
   JOIN account a ON a.id = tal.account
   JOIN accountingperiod ap ON ap.id = t.postingperiod
   WHERE a.acctnumber = '4220'
     AND t.posting = 'T'
     AND tal.posting = 'T'
   GROUP BY EXTRACT(YEAR FROM ap.startdate)
   ORDER BY year DESC;
   ```

3. **Test query without date range** to isolate the issue:
   - Test with `ap.periodname IN ('Jan 2024', 'Dec 2024', 'Jan 2025', 'Dec 2025')` vs date range
   - Test with `ap.periodname IN ('Jan 2023', 'Dec 2023', 'Jan 2024', 'Dec 2024', 'Jan 2025', 'Dec 2025')` vs date range

4. **Check for data anomalies in 2023**:
   - Unusually large transactions
   - Missing or incorrect period data
   - Index maintenance issues

### Code Changes to Consider

1. **Add query execution plan logging**:
   ```csharp
   // After query execution, log execution plan if available
   _logger.LogInformation("Query execution plan: {Plan}", executionPlan);
   ```

2. **Add performance metrics per year**:
   ```csharp
   // Log query time and result count
   _logger.LogInformation("Period range query: {From} to {To} took {Elapsed}s, returned {Count} rows", 
       fromPeriodForRange, toPeriodForRange, elapsed, resultCount);
   ```

3. **Consider splitting large ranges**:
   - If range > 2 years, split into multiple queries and combine results
   - This might avoid the execution plan threshold issue

## Performance Optimization: Individual Years vs Single Range

### Test Results: 2023 + 2024 + 2025

**Individual Year Queries (Summed)**:
- Jan 2023 - Dec 2023: ~14.56s
- Jan 2024 - Dec 2024: ~17.87s  
- Jan 2025 - Dec 2025: ~0.33s (cached)
- **Total Time: ~32.76 seconds**

**Single Range Query (2023-2025)**:
- Jan 2023 - Dec 2025: **74.64 seconds**

**Performance Gain**: Individual years are **2.28x faster** than single range query.

### Recommendation

For users querying multiple years, **summing individual year queries is significantly faster** than using a single period range query when the range exceeds 2 years.

**Example**:
- ❌ Slow: `=XAVI.BALANCE("4220", "Jan 2023", "Dec 2025")` → 74.64s
- ✅ Fast: `=XAVI.BALANCE("4220", "Jan 2023", "Dec 2023") + XAVI.BALANCE("4220", "Jan 2024", "Dec 2024") + XAVI.BALANCE("4220", "Jan 2025", "Dec 2025")` → ~32.76s

### Implementation Consideration

The backend could automatically split large ranges (>2 years) into individual year queries and sum the results, providing better performance without requiring users to manually split their formulas.

## Conclusion

The performance anomaly at 2023 suggests a **query execution plan threshold** or **data volume anomaly** rather than a linear scaling issue. The fact that adding more years doesn't proportionally increase query time, and sometimes makes it faster, strongly suggests NetSuite is using different execution strategies based on range size or data characteristics.

**Most Likely Cause**: NetSuite's query optimizer switches execution plans when the date range exceeds a certain threshold (likely 2-3 years of data), and the new plan is significantly slower but more stable across larger ranges.

**Recommended Solutions**:
1. **Short-term**: Document that users should sum individual year queries for ranges >2 years
2. **Long-term**: Implement automatic range splitting in the backend for ranges >2 years
3. **Investigation**: Execute EXPLAIN PLAN queries in NetSuite to compare execution plans between 2024-2025 and 2023-2025 ranges

