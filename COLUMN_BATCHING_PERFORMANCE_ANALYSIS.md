# Column-Based Batching Performance Analysis

## Summary

This document explains the detailed logging added to analyze why column-based balance queries take ~70s per period.

---

## 1. Exact SuiteQL Query Structure

### Column-Based Batching Query (`/batch/bs_preload_targeted`)

**Location**: `BalanceController.cs` lines 1286-1314

**Query Template**:
```sql
SELECT 
    a.acctnumber,
    a.accttype,
    SUM(
        TO_NUMBER(
            BUILTIN.CONSOLIDATE(
                tal.amount,
                'LEDGER',
                'DEFAULT',
                'DEFAULT',
                {targetSub},           -- Consolidation root subsidiary ID
                {periodId},            -- Target period ID (e.g., March 2025's period ID)
                'DEFAULT'
            )
        ) * CASE WHEN a.accttype IN ({signFlipSql}) THEN -1 ELSE 1 END
    ) AS balance
FROM transactionaccountingline tal
JOIN transaction t ON t.id = tal.transaction
JOIN account a ON a.id = tal.account
JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
WHERE t.posting = 'T'
  AND tal.posting = 'T'
  AND a.acctnumber IN ('{accountFilter}')  -- Comma-separated account numbers
  AND t.trandate <= TO_DATE('{endDate}', 'YYYY-MM-DD')  -- ⚠️ ALL transactions from inception
  AND tal.accountingbook = {accountingBook}
  AND {segmentWhere}  -- Subsidiary/department/location/class filters
GROUP BY a.acctnumber, a.accttype
ORDER BY a.acctnumber
```

**Key Placeholders**:
- `{targetSub}`: Consolidation root subsidiary ID (e.g., "1")
- `{periodId}`: Target period's internal ID (e.g., "12345" for March 2025)
- `{accountFilter}`: Comma-separated account numbers (e.g., "'10010', '10020', '10030'")
- `{endDate}`: Period end date in YYYY-MM-DD format (e.g., "2025-01-31")
- `{signFlipSql}`: Account types that need sign flip (Liabilities, Equity)
- `{segmentWhere}`: Segment filters (subsidiary, department, location, class)

---

## 2. Execution Timing Logs

### Column-Based Batching Logs

**Location**: `BalanceController.cs` lines 1316-1338

**Log Format**:
```
═══════════════════════════════════════════════════════
📊 TARGETED BS PRELOAD QUERY - Period: Jan 2025
   Start Time: 2025-01-15 10:20:37.123 UTC
   Accounts: 15 (10010, 10020, 10030, ...)
   Period End Date: 2025-01-31
   Period ID: 12345
   Target Subsidiary: 1 (hierarchy: 1, 2, 3)
   Accounting Book: 1
   Date Scope: ALL transactions from inception through 2025-01-31 (t.trandate <= TO_DATE('2025-01-31', 'YYYY-MM-DD'))
   No lower bound on date - includes all historical transactions
   Query Type: Cumulative Balance Sheet (translated ending balance)
   FX Translation: All transactions use period Jan 2025 exchange rate (periodId=12345)
═══════════════════════════════════════════════════════
EXACT QUERY (placeholders expanded):
[Full query with all placeholders replaced]
═══════════════════════════════════════════════════════
⏱️ TARGETED BS PRELOAD QUERY TIMING - Period: Jan 2025
   Start Time: 2025-01-15 10:20:37.123 UTC
   Query Start: 2025-01-15 10:20:37.456 UTC
   End Time: 2025-01-15 10:21:47.789 UTC
   Query Duration: 70.33s (NetSuite query execution)
   Total Duration: 70.45s (including period lookup + processing)
   Rows Returned: 15 (accounts with balances)
   Accounts Requested: 15
═══════════════════════════════════════════════════════
```

### Single-Account Query Logs (for comparison)

**Location**: `BalanceService.cs` lines 965-980

**Log Format**:
```
═══════════════════════════════════════════════════════
📊 SINGLE-ACCOUNT BALANCE QUERY
   Account: 10010
   Period: Jan 2025 (end date: 2025-01-31)
   Account Type: Balance Sheet
   Start Time: 2025-01-15 10:20:37.123 UTC
   Date Scope: ALL transactions from inception through 2025-01-31 (t.trandate <= TO_DATE('2025-01-31', 'YYYY-MM-DD'))
   No lower bound on date - includes all historical transactions
   Target Period ID: 12345
═══════════════════════════════════════════════════════
⏱️ SINGLE-ACCOUNT QUERY TIMING
   Query Duration: 68.45s
   End Time: 2025-01-15 10:21:45.568 UTC
═══════════════════════════════════════════════════════
```

---

## 3. Data Scope Confirmation

### Date Filter Analysis

**Query Filter**: `t.trandate <= TO_DATE('{endDate}', 'YYYY-MM-DD')`

**What This Means**:
- ✅ **Includes ALL transactions from inception** (no lower bound)
- ✅ **Includes transactions from all prior periods** (January, February, March, etc.)
- ✅ **Includes transactions from prior years** (2024, 2023, etc.)
- ✅ **Includes all historical transactions** up to and including the period end date

**Example for January 2025**:
- Includes: All transactions from company inception through January 31, 2025
- Excludes: Transactions after January 31, 2025

### Why This Is Expensive

1. **Full Historical Scan**: NetSuite must scan ALL transactions from company inception
2. **FX Translation**: Each transaction must be converted using the target period's exchange rate
3. **Consolidation**: Each transaction must be consolidated to the target subsidiary
4. **Aggregation**: All transactions must be summed per account

**This is inherently expensive** because:
- Balance Sheet accounts are cumulative (inception through period end)
- NetSuite must process potentially millions of historical transactions
- FX translation and consolidation add computational overhead

---

## 4. Timing Comparison

### Expected Results

**Column-Based Batching (15 accounts × 1 period)**:
- Query Duration: ~70s
- Accounts: 15
- Transactions Scanned: ALL from inception through period end
- FX Translation: All transactions use period-end exchange rate

**Single-Account Query (1 account × 1 period)**:
- Query Duration: ~68-70s
- Accounts: 1
- Transactions Scanned: ALL from inception through period end (same scope)
- FX Translation: All transactions use period-end exchange rate (same logic)

### Why They're Similar

Both queries:
1. Scan the same transaction scope (all historical transactions)
2. Use the same FX translation logic (target period's exchange rate)
3. Use the same consolidation logic (target subsidiary)
4. Process the same amount of data per account

**The difference**: Column-based batching processes multiple accounts in one query, but NetSuite still scans all historical transactions for each account.

---

## 5. Performance Characteristics

### What Makes This Expensive

1. **No Date Lower Bound**: Query scans ALL transactions from inception
   - For a 10-year-old company: potentially millions of transactions
   - No optimization possible (Balance Sheet is cumulative)

2. **FX Translation Per Transaction**: Each transaction must be converted
   - `BUILTIN.CONSOLIDATE` processes each transaction individually
   - Exchange rate lookup for each transaction
   - Currency conversion calculation for each transaction

3. **Consolidation Per Transaction**: Each transaction must be consolidated
   - Subsidiary hierarchy resolution
   - Segment matching (department, location, class)
   - Consolidation calculation

4. **NetSuite Query Engine**: SuiteQL queries are executed server-side
   - No client-side optimization possible
   - NetSuite's query engine must process all transactions
   - Network latency is minimal (query execution is the bottleneck)

### Why This Is Acceptable

1. **Exact Parity**: Matches NetSuite Balance Sheet reports exactly
2. **Correct FX**: Uses period-end exchange rate for all transactions
3. **One Query Per Period**: Better than one query per account
4. **Caching**: Results are cached, so subsequent requests are instant

---

## 6. Optimization Options

### Option 1: Accept the Cost (Current Approach)

**Pros**:
- ✅ Exact parity with NetSuite Balance Sheet reports
- ✅ Correct FX translation
- ✅ Simple implementation
- ✅ Results are cached

**Cons**:
- ❌ ~70s per period (inherent NetSuite limitation)

### Option 2: Hybrid Approach

**Concept**: Use period activity for recent periods, cumulative for older periods

**Pros**:
- ✅ Faster for recent periods
- ✅ Still accurate for current year

**Cons**:
- ❌ Complex implementation
- ❌ May not match NetSuite exactly
- ❌ Still need cumulative for older periods

### Option 3: Snapshot-Based Optimization

**Concept**: Store period-end balances in a snapshot table, query snapshots instead of transactions

**Pros**:
- ✅ Much faster (query snapshots instead of transactions)
- ✅ Can still maintain accuracy

**Cons**:
- ❌ Requires snapshot infrastructure
- ❌ Snapshot maintenance overhead
- ❌ May not match NetSuite exactly if snapshots are stale

---

## 7. Conclusion

**The ~70s per period is expected** because:

1. ✅ Query scans ALL transactions from inception (no lower bound)
2. ✅ Each transaction requires FX translation and consolidation
3. ✅ This matches NetSuite Balance Sheet report behavior exactly
4. ✅ Single-account queries take the same time (same transaction scope)

**The logs will confirm**:
- Exact query structure with placeholders expanded
- Start/end times and duration
- Row counts returned
- Transaction scope (all from inception)
- Comparison with single-account query timing

**Next Steps**:
1. Review server logs after next column-based batch query
2. Compare timing with single-account query
3. Decide whether to accept the cost or explore optimizations

