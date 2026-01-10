# Income April 2025 - SuiteQL Query for Manual Testing

## Problem
Income is returning 0 in the batch query, but drill-down shows transaction for 143,480,988.56

## First: Get the Period ID for April 2025

Run this in NetSuite to find the period ID:

```sql
SELECT id, periodname, startdate, enddate 
FROM accountingperiod 
WHERE periodname = 'Apr 2025'
   OR periodname LIKE '%Apr 2025%'
ORDER BY startdate
```

**Expected result**: Should return period ID **348** (or similar)

---

## Second: Get the Subsidiary ID

Run this to verify the subsidiary ID:

```sql
SELECT id, name 
FROM subsidiary 
WHERE name = 'Celigo India Pvt Ltd'
   OR name LIKE '%India%'
ORDER BY id
```

**Expected result**: Should return subsidiary ID **2** (or similar)

---

## Third: Test the CORRECTED Batch Query

This is the query the batch endpoint should be using (with literal period ID):

```sql
SELECT 
    a.accttype AS account_type,
    SUM(CASE WHEN t.postingperiod = 348 THEN 
        TO_NUMBER(
            BUILTIN.CONSOLIDATE(
                tal.amount, 
                'LEDGER', 
                'DEFAULT', 
                'DEFAULT', 
                2, 
                348, 
                'DEFAULT'
            )
        ) * CASE WHEN a.accttype IN ('Income', 'OthIncome') THEN -1 ELSE 1 END
    ELSE 0 END) AS apr
FROM transactionaccountingline tal
JOIN transaction t ON t.id = tal.transaction
JOIN account a ON a.id = tal.account
JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
WHERE t.posting = 'T'
  AND tal.posting = 'T'
  AND a.accttype IN ('Income', 'COGS', 'Expense', 'OthIncome', 'OthExpense')
  AND t.postingperiod IN (348)
  AND tal.accountingbook = 2
  AND tl.subsidiary IN (2)
GROUP BY a.accttype
ORDER BY a.accttype
```

**Key difference**: Line 11 uses **348** (literal) instead of **t.postingperiod** (column)

---

## Fourth: Test Individual Query (for comparison)

This is what the individual TYPEBALANCE query uses:

```sql
SELECT SUM(
    TO_NUMBER(
        BUILTIN.CONSOLIDATE(
            tal.amount,
            'LEDGER',
            'DEFAULT',
            'DEFAULT',
            2,
            348,
            'DEFAULT'
        )
    ) * CASE WHEN a.accttype IN ('Income', 'OthIncome') THEN -1 ELSE 1 END
) AS balance
FROM transactionaccountingline tal
JOIN transaction t ON t.id = tal.transaction
JOIN account a ON a.id = tal.account
JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
WHERE t.posting = 'T'
  AND tal.posting = 'T'
  AND a.accttype IN ('Income')
  AND t.postingperiod IN (348)
  AND tal.accountingbook = 2
  AND tl.subsidiary IN (2)
```

**Expected result**: Should return **143480988.56** (or close to it)

---

## Fifth: Check if Transactions Exist (Raw, No Consolidation)

If both queries return 0, check if raw transactions exist:

```sql
SELECT 
    COUNT(*) as transaction_count,
    SUM(ABS(tal.amount)) as total_amount,
    MIN(tal.amount) as min_amount,
    MAX(tal.amount) as max_amount
FROM transactionaccountingline tal
JOIN transaction t ON t.id = tal.transaction
JOIN account a ON a.id = tal.account
JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
WHERE t.posting = 'T'
  AND tal.posting = 'T'
  AND a.accttype = 'Income'
  AND t.postingperiod = 348
  AND tal.accountingbook = 2
  AND tl.subsidiary = 2
```

**Expected result**: Should show transaction_count > 0 and total_amount > 0

---

## Sixth: Test BUILTIN.CONSOLIDATE Directly

If raw transactions exist but consolidated returns 0, test BUILTIN.CONSOLIDATE:

```sql
SELECT 
    COUNT(*) as count,
    SUM(TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', 2, 348, 'DEFAULT'))) as consolidated_sum,
    SUM(tal.amount) as raw_sum
FROM transactionaccountingline tal
JOIN transaction t ON t.id = tal.transaction
JOIN account a ON a.id = tal.account
JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
WHERE t.posting = 'T'
  AND tal.posting = 'T'
  AND a.accttype = 'Income'
  AND t.postingperiod = 348
  AND tal.accountingbook = 2
  AND tl.subsidiary = 2
```

**Expected result**: 
- `count` should be > 0
- `raw_sum` should be > 0
- `consolidated_sum` should match `raw_sum` (or be close if currency conversion applies)

---

## Parameters Summary

- **Subsidiary**: "Celigo India Pvt Ltd" → ID: **2**
- **Book**: **2**
- **Period**: "Apr 2025" → ID: **348** (verify with first query)
- **Target Subsidiary for BUILTIN.CONSOLIDATE**: **2** (5th parameter)
- **Period ID for BUILTIN.CONSOLIDATE**: **348** (6th parameter - MUST be literal, not column)

---

## What to Check

1. ✅ Period ID 348 is correct for April 2025
2. ✅ Subsidiary ID 2 is correct for "Celigo India Pvt Ltd"
3. ✅ Raw transactions exist (query #5)
4. ✅ BUILTIN.CONSOLIDATE works (query #6)
5. ✅ Batch query uses literal period ID (348) not column (t.postingperiod)

If all checks pass but batch query still returns 0, the issue is in the code logic, not the query structure.

