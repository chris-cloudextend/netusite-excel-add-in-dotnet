# Income Query Debug - SuiteQL Queries

## Test Results
Both individual and batch queries returned **0** for April 2025, which suggests either:
1. No Income data exists for that period
2. Parameter mismatch (period ID, subsidiary ID, or book)

## Exact Queries to Run in NetSuite

### Individual Query (What TYPEBALANCE uses)
```sql
SELECT SUM(
    TO_NUMBER(
        BUILTIN.CONSOLIDATE(
            tal.amount,
            'LEDGER',
            'DEFAULT',
            'DEFAULT',
            2,
            t.postingperiod,
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

### Batch Query (What /batch/typebalance_refresh uses)
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
                t.postingperiod, 
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

## Parameters Used
- **Subsidiary**: "Celigo India Pvt Ltd" → ID: **2**
- **Book**: **2**
- **Period**: "Apr 2025" → ID: **348**

## Next Steps

1. **Run the individual query above in NetSuite** and see what it returns
2. **Check if period ID 348 is correct** - you can verify by running:
   ```sql
   SELECT id, periodname, startdate, enddate 
   FROM accountingperiod 
   WHERE periodname LIKE '%Apr 2025%'
   ```
3. **Check if subsidiary ID 2 is correct** - verify:
   ```sql
   SELECT id, name 
   FROM subsidiary 
   WHERE name LIKE '%India%'
   ```
4. **If the query returns 0 but you know data exists**, the issue might be:
   - Wrong period ID
   - Wrong subsidiary ID  
   - Wrong accounting book
   - Data is in a different period

## Test Endpoint

You can also test different periods using:
```
http://localhost:5002/api/test/income-apr-2025?subsidiary=Celigo%20India%20Pvt%20Ltd&book=2
```

To test a different period, we'd need to modify the endpoint or check the logs for the actual period IDs being used.

