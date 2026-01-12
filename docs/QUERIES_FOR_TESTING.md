# BS Preload Queries for Testing

## Test Results Summary

✅ **Both queries executed successfully!**

- **Current Query:** 63 seconds, 177 accounts returned
- **Proposed Query:** 67 seconds, 232 accounts returned
- **Improvement:** Proposed query returns **55 more accounts** (includes zero-balance accounts)
- **Performance:** Similar (4 seconds slower, but acceptable for complete coverage)

## Parameters Used

- **Period:** Feb 2025
- **Period ID:** 345
- **End Date:** 2025-02-28
- **Subsidiary ID:** 1
- **Accounting Book:** 1

---

## CURRENT QUERY (Inner Join - Only Accounts with Transactions)

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
                1,
                345,
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
  AND t.trandate <= TO_DATE('2025-02-28', 'YYYY-MM-DD')
  AND tal.accountingbook = 1
  AND tl.subsidiary IN (1)
GROUP BY a.acctnumber, a.accountsearchdisplaynamecopy, a.accttype
ORDER BY a.acctnumber
```

**Note:** Replace parameters:
- `345` → Your period ID
- `2025-02-28` → Your period end date (YYYY-MM-DD format)
- `1` (subsidiary) → Your subsidiary ID(s)
- `1` (accounting book) → Your accounting book ID

---

## PROPOSED QUERY (Left Join - All BS Accounts)

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
                1,
                345,
                'DEFAULT'
            )
        ) * CASE WHEN a.accttype IN ('AcctPay', 'CredCard', 'OthCurrLiab', 'LongTermLiab', 'DeferRevenue', 'Equity', 'RetainedEarnings') THEN -1 ELSE 1 END
    ), 0) AS balance
FROM account a
LEFT JOIN transactionaccountingline tal ON tal.account = a.id
    AND tal.posting = 'T'
LEFT JOIN transaction t ON t.id = tal.transaction
    AND t.posting = 'T'
    AND t.trandate <= TO_DATE('2025-02-28', 'YYYY-MM-DD')
LEFT JOIN TransactionLine tl ON t.id = tl.transaction 
    AND tal.transactionline = tl.id
    AND tl.subsidiary IN (1)
WHERE a.accttype IN ('Bank', 'AcctRec', 'OthCurrAsset', 'FixedAsset', 'OthAsset', 'DeferExpense', 'UnbilledRec', 'AcctPay', 'CredCard', 'OthCurrLiab', 'LongTermLiab', 'DeferRevenue', 'Equity', 'RetainedEarnings')
  AND a.isinactive = 'F'
  AND (tal.accountingbook = 1 OR tal.accountingbook IS NULL)
GROUP BY a.acctnumber, a.accountsearchdisplaynamecopy, a.accttype
ORDER BY a.acctnumber
```

**Key Differences:**
1. Starts from `account` table (not `transactionaccountingline`)
2. Uses `LEFT JOIN` instead of `INNER JOIN`
3. Uses `COALESCE(SUM(...), 0)` to return 0 for accounts with no transactions
4. Includes `a.isinactive = 'F'` to exclude inactive accounts
5. Accounting book filter: `(tal.accountingbook = 1 OR tal.accountingbook IS NULL)`

**Note:** Replace parameters:
- `345` → Your period ID
- `2025-02-28` → Your period end date (YYYY-MM-DD format)
- `1` (subsidiary) → Your subsidiary ID(s)
- `1` (accounting book) → Your accounting book ID

---

## How to Test in Another Environment

### Option 1: Using NetSuite SuiteQL Query Tool

1. Log into NetSuite
2. Go to **Customization > Scripting > SuiteQL Query Tool**
3. Paste one of the queries above (with your parameters)
4. Click **Run Query**
5. Compare results

### Option 2: Using the Backend Test Endpoint

```bash
curl -X POST http://your-backend-url/test/query \
  -H "Content-Type: application/json" \
  -d '{
    "q": "<PASTE_QUERY_HERE>",
    "timeout": 180
  }'
```

### Option 3: Using the Test Script

```bash
# Update parameters in test-queries-direct.sh
TEST_PERIOD="Your Period" BASE_URL="http://your-backend-url" ./test-queries-direct.sh
```

---

## Expected Results

### Current Query
- Returns only accounts that have transactions in the period
- Missing accounts like 10206 (if they have no transactions)
- Typically returns ~150-200 accounts

### Proposed Query
- Returns ALL balance sheet accounts (active, non-inactive)
- Includes accounts with zero transactions (balance = 0)
- Typically returns ~200-250 accounts
- Account 10206 should appear with balance = 0 (if it has no transactions)

---

## Validation Checklist

- [ ] Query executes without SQL errors
- [ ] Proposed query returns MORE accounts than current query
- [ ] Accounts with transactions have SAME balances in both queries
- [ ] Accounts with zero transactions return balance = 0 (not NULL)
- [ ] Account 10206 appears in proposed query results
- [ ] Performance is acceptable (< 90 seconds)

---

## Parameter Lookup Queries

### Get Period ID

```sql
SELECT id, periodname, startdate, enddate 
FROM accountingperiod 
WHERE periodname = 'Feb 2025' 
  AND isyear = 'F' 
  AND isquarter = 'F' 
FETCH FIRST 1 ROWS ONLY
```

### Get Subsidiary ID

```sql
SELECT id, name 
FROM subsidiary 
WHERE name = 'Your Subsidiary Name' 
FETCH FIRST 1 ROWS ONLY
```

### Get Subsidiary Hierarchy (for consolidated)

```sql
SELECT id 
FROM subsidiary 
WHERE id IN (
    SELECT DISTINCT subsidiary 
    FROM transactionline 
    WHERE subsidiary = 1 OR parent = 1
)
```

---

## Notes

- Date format must be `YYYY-MM-DD` for `TO_DATE()` function
- Period ID is numeric (e.g., 345)
- Subsidiary filter can be a single ID or comma-separated list: `(1)` or `(1, 2, 3)`
- Accounting book is typically 1 (primary book)
- The proposed query is slightly slower but provides complete coverage

