# Test Plan: BS Preload Query Optimization

## Overview

This document provides a step-by-step plan to test the proposed LEFT JOIN query changes for the BS preload endpoint before implementing them in code.

## Test Endpoint

The backend has a test endpoint at `/test/query` that allows running raw SuiteQL queries:

**Endpoint:** `POST /test/query`  
**Body:** `{ "q": "SELECT ...", "timeout": 180 }`

## Prerequisites

1. Backend server must be running
2. NetSuite credentials must be configured
3. Access to a NetSuite instance with BS accounts
4. Know a test period (e.g., "Feb 2025")
5. Know a test subsidiary (or use default)

## Step 1: Get Required Parameters

Before building the queries, we need to resolve:
- Period ID for the test period
- Subsidiary ID(s) for the test subsidiary
- Accounting book ID (usually 1)

### Get Period ID

```bash
curl -X POST http://localhost:5000/test/query \
  -H "Content-Type: application/json" \
  -d '{
    "q": "SELECT id, periodname, startdate, enddate FROM accountingperiod WHERE periodname = '\''Feb 2025'\'' AND isyear = '\''F'\'' AND isquarter = '\''F'\'' FETCH FIRST 1 ROWS ONLY",
    "timeout": 30
  }'
```

Save the `id` value as `{periodId}`.

### Get Subsidiary ID

```bash
curl -X POST http://localhost:5000/test/query \
  -H "Content-Type: application/json" \
  -d '{
    "q": "SELECT id, name FROM subsidiary WHERE name = '\''Celigo Inc. (Consolidated)'\'' FETCH FIRST 1 ROWS ONLY",
    "timeout": 30
  }'
```

Or use subsidiary ID "1" for the default subsidiary. Save as `{targetSub}`.

### Get Subsidiary Hierarchy

```bash
curl -X POST http://localhost:5000/test/query \
  -H "Content-Type: application/json" \
  -d '{
    "q": "SELECT id FROM subsidiary WHERE id IN (SELECT DISTINCT subsidiary FROM transactionline WHERE subsidiary = {targetSub} OR parent = {targetSub})",
    "timeout": 30
  }'
```

Save as comma-separated list `{subFilter}`.

## Step 2: Build Current Query

Replace the placeholders with actual values from Step 1:

```sql
SELECT 
    a.acctnumber,
    a.accountsearchdisplaynamecopy AS account_name,
    a.accttype,
    SUM(
        TO_NUMBER(
            BUILTIN.CONSOLIDATE(
                tal.amount,
                'LEDGER',
                'DEFAULT',
                'DEFAULT',
                {targetSub},
                {periodId},
                'DEFAULT'
            )
        ) * CASE WHEN a.accttype IN ('AcctPay', 'CredCard', 'OthCurrLiab', 'LongTermLiab', 'DeferRevenue', 'Equity', 'RetainedEarnings') THEN -1 ELSE 1 END
    ) AS balance
FROM transactionaccountingline tal
JOIN transaction t ON t.id = tal.transaction
JOIN account a ON a.id = tal.account
JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
WHERE t.posting = 'T'
  AND tal.posting = 'T'
  AND a.accttype IN ('Bank', 'AcctRec', 'OthCurrAsset', 'FixedAsset', 'OthAsset', 'DeferExpense', 'UnbilledRec', 'AcctPay', 'CredCard', 'OthCurrLiab', 'LongTermLiab', 'DeferRevenue', 'Equity', 'RetainedEarnings')
  AND t.trandate <= TO_DATE('{endDate}', 'YYYY-MM-DD')
  AND tal.accountingbook = 1
  AND tl.subsidiary IN ({subFilter})
GROUP BY a.acctnumber, a.accountsearchdisplaynamecopy, a.accttype
ORDER BY a.acctnumber
```

**Note:** Replace:
- `{targetSub}` with actual subsidiary ID (e.g., "1")
- `{periodId}` with actual period ID (e.g., "123")
- `{endDate}` with period end date (e.g., "2025-02-28")
- `{subFilter}` with comma-separated subsidiary IDs (e.g., "1, 2, 3")

## Step 3: Build Proposed Query (LEFT JOIN)

Same parameters, but with LEFT JOIN structure:

```sql
SELECT 
    a.acctnumber,
    a.accountsearchdisplaynamecopy AS account_name,
    a.accttype,
    COALESCE(SUM(
        TO_NUMBER(
            BUILTIN.CONSOLIDATE(
                tal.amount,
                'LEDGER',
                'DEFAULT',
                'DEFAULT',
                {targetSub},
                {periodId},
                'DEFAULT'
            )
        ) * CASE WHEN a.accttype IN ('AcctPay', 'CredCard', 'OthCurrLiab', 'LongTermLiab', 'DeferRevenue', 'Equity', 'RetainedEarnings') THEN -1 ELSE 1 END
    ), 0) AS balance
FROM account a
LEFT JOIN transactionaccountingline tal ON tal.account = a.id
    AND tal.posting = 'T'
LEFT JOIN transaction t ON t.id = tal.transaction
    AND t.posting = 'T'
    AND t.trandate <= TO_DATE('{endDate}', 'YYYY-MM-DD')
LEFT JOIN TransactionLine tl ON t.id = tl.transaction 
    AND tal.transactionline = tl.id
    AND tl.subsidiary IN ({subFilter})
WHERE a.accttype IN ('Bank', 'AcctRec', 'OthCurrAsset', 'FixedAsset', 'OthAsset', 'DeferExpense', 'UnbilledRec', 'AcctPay', 'CredCard', 'OthCurrLiab', 'LongTermLiab', 'DeferRevenue', 'Equity', 'RetainedEarnings')
  AND a.isinactive = 'F'
  AND (tal.accountingbook = 1 OR tal.accountingbook IS NULL)
GROUP BY a.acctnumber, a.accountsearchdisplaynamecopy, a.accttype
ORDER BY a.acctnumber
```

## Step 4: Execute Both Queries

### Test Current Query

```bash
curl -X POST http://localhost:5000/test/query \
  -H "Content-Type: application/json" \
  -d '{
    "q": "<PASTE_CURRENT_QUERY_HERE>",
    "timeout": 180
  }' | jq '.row_count, .results | length'
```

Save the results to a file:
```bash
curl -X POST http://localhost:5000/test/query \
  -H "Content-Type: application/json" \
  -d '{
    "q": "<PASTE_CURRENT_QUERY_HERE>",
    "timeout": 180
  }' > current_query_results.json
```

### Test Proposed Query

```bash
curl -X POST http://localhost:5000/test/query \
  -H "Content-Type: application/json" \
  -d '{
    "q": "<PASTE_PROPOSED_QUERY_HERE>",
    "timeout": 180
  }' | jq '.row_count, .results | length'
```

Save the results:
```bash
curl -X POST http://localhost:5000/test/query \
  -H "Content-Type: application/json" \
  -d '{
    "q": "<PASTE_PROPOSED_QUERY_HERE>",
    "timeout": 180
  }' > proposed_query_results.json
```

## Step 5: Compare Results

### Validation Checklist

- [ ] **Query executes successfully** (no SQL errors)
- [ ] **Proposed query returns MORE accounts** (includes accounts with zero transactions)
- [ ] **Accounts with transactions have SAME balances** in both queries
- [ ] **Accounts with zero transactions return 0** (not NULL) in proposed query
- [ ] **All account numbers match** between queries (for accounts that exist in both)
- [ ] **Performance is acceptable** (compare execution times)

### Compare Account Counts

```bash
# Count accounts in current query
jq '.results | length' current_query_results.json

# Count accounts in proposed query
jq '.results | length' proposed_query_results.json

# Expected: Proposed query should have MORE accounts
```

### Compare Balances for Common Accounts

```bash
# Extract account numbers and balances from current query
jq '.results[] | {acct: .acctnumber, balance: .balance}' current_query_results.json > current_accounts.json

# Extract account numbers and balances from proposed query
jq '.results[] | {acct: .acctnumber, balance: .balance}' proposed_query_results.json > proposed_accounts.json

# Find accounts only in proposed query (zero-balance accounts)
jq -s '.[0] as $current | .[1] | map(select(.acct | in($current[].acct) | not))' current_accounts.json proposed_accounts.json
```

### Verify Zero Balances

```bash
# Check that accounts with no transactions return 0 (not NULL)
jq '.results[] | select(.balance == 0) | .acctnumber' proposed_query_results.json

# Should see account 10206 (or other accounts with no transactions)
```

## Step 6: Performance Comparison

### Measure Execution Time

```bash
# Current query
time curl -X POST http://localhost:5000/test/query \
  -H "Content-Type: application/json" \
  -d '{
    "q": "<CURRENT_QUERY>",
    "timeout": 180
  }' > /dev/null

# Proposed query
time curl -X POST http://localhost:5000/test/query \
  -H "Content-Type: application/json" \
  -d '{
    "q": "<PROPOSED_QUERY>",
    "timeout": 180
  }' > /dev/null
```

**Expected:** Proposed query should be similar or faster.

## Step 7: Test Edge Cases

### Test with Different Periods

- [ ] Test with a period that has many transactions
- [ ] Test with a period that has few transactions
- [ ] Test with a period that has no transactions (should return all BS accounts with 0)

### Test with Different Subsidiaries

- [ ] Test with single subsidiary
- [ ] Test with consolidated subsidiary (multiple subsidiaries)
- [ ] Test with subsidiary that has no transactions

### Test Segment Filters

- [ ] Test with department filter
- [ ] Test with class filter
- [ ] Test with location filter
- [ ] Test with multiple segment filters

## Step 8: Validate Specific Account (10206)

Since account 10206 was the one that wasn't cached, verify it appears in the proposed query:

```bash
jq '.results[] | select(.acctnumber == "10206")' proposed_query_results.json
```

**Expected:** Should return account 10206 with balance 0 (or actual balance if it has transactions).

## Step 9: Test with Actual BS Preload Endpoint

Once queries are validated, test the actual endpoint:

```bash
curl -X POST http://localhost:5000/batch/bs_preload \
  -H "Content-Type: application/json" \
  -d '{
    "periods": ["Feb 2025"],
    "subsidiary": "Celigo Inc. (Consolidated)"
  }'
```

Then verify account 10206 is in the response:

```bash
curl -X POST http://localhost:5000/batch/bs_preload \
  -H "Content-Type: application/json" \
  -d '{
    "periods": ["Feb 2025"],
    "subsidiary": "Celigo Inc. (Consolidated)"
  }' | jq '.balances."10206"'
```

**Expected:** Should return balance for account 10206 (even if 0).

## Troubleshooting

### Query Fails with Syntax Error

- Check that all placeholders are replaced with actual values
- Verify period ID and subsidiary IDs are correct
- Check that date format is correct (YYYY-MM-DD)

### LEFT JOIN Returns NULL Instead of 0

- Verify `COALESCE(SUM(...), 0)` is used
- Check that GROUP BY includes all non-aggregated columns

### Segment Filters Not Working

- Verify segment filters are in the LEFT JOIN conditions, not WHERE clause
- Check that subsidiary filter uses correct syntax

### Performance Worse Than Expected

- Check NetSuite query execution plan (if available)
- Verify indexes exist on account table
- Consider the hybrid approach (two queries) if needed

## Success Criteria

✅ **Query executes successfully**  
✅ **Returns all BS accounts** (including those with zero transactions)  
✅ **Balances match** for accounts with transactions  
✅ **Zero balances return 0** (not NULL)  
✅ **Performance is acceptable** (similar or better than current)  
✅ **Account 10206 appears** in results for Feb 2025  

## Next Steps After Testing

If all tests pass:
1. Implement the query changes in `BalanceController.cs`
2. Update unit tests if they exist
3. Deploy to staging environment
4. Monitor performance in production
5. Verify account 10206 is now cached correctly

If tests fail:
1. Document the failure
2. Consider the hybrid approach (two queries)
3. Re-evaluate the query structure
4. Consult NetSuite SuiteQL documentation

