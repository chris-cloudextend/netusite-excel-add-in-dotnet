# BUILTIN.CONSOLIDATE Test Report
## Book 2, Celigo India Pvt Ltd (Subsidiary ID: 2)

## Test Objective
Compare three query approaches to determine if we can use a single CONSOLIDATE call without checking first:
1. **Query WITHOUT BUILTIN.CONSOLIDATE** - Use raw `tal.amount` directly
2. **Query WITH BUILTIN.CONSOLIDATE** - Current approach (may return NULL)
3. **Query WITH COALESCE** - New approach (handles NULL fallback)

## Test Queries

### Query 1: WITHOUT BUILTIN.CONSOLIDATE (Raw Amount)
```sql
SELECT 
    a.accttype AS account_type,
    SUM(CASE WHEN a.accttype IN ('Income', 'OthIncome') THEN -tal.amount ELSE tal.amount END) AS total_amount
FROM transactionaccountingline tal
JOIN transaction t ON t.id = tal.transaction
JOIN account a ON a.id = tal.account
JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
WHERE t.posting = 'T'
  AND tal.posting = 'T'
  AND a.accttype = 'Income'
  AND a.isinactive = 'F'
  AND tal.accountingbook = 2
  AND tl.subsidiary = 2
  AND t.postingperiod IN (SELECT id FROM accountingperiod WHERE periodname LIKE 'Mar 2025')
GROUP BY a.accttype
```

**Expected Result:** Raw transaction amounts summed directly (no currency conversion/consolidation)

---

### Query 2: WITH BUILTIN.CONSOLIDATE (Current Approach)
```sql
SELECT 
    a.accttype AS account_type,
    SUM(
        CASE WHEN a.accttype IN ('Income', 'OthIncome') THEN 
            -TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', 2, t.postingperiod, 'DEFAULT'))
        ELSE 
            TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', 2, t.postingperiod, 'DEFAULT'))
        END
    ) AS total_amount
FROM transactionaccountingline tal
JOIN transaction t ON t.id = tal.transaction
JOIN account a ON a.id = tal.account
JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
WHERE t.posting = 'T'
  AND tal.posting = 'T'
  AND a.accttype = 'Income'
  AND a.isinactive = 'F'
  AND tal.accountingbook = 2
  AND tl.subsidiary = 2
  AND t.postingperiod IN (SELECT id FROM accountingperiod WHERE periodname LIKE 'Mar 2025')
GROUP BY a.accttype
```

**Expected Result:** 
- If subsidiary has children: Consolidated amounts (currency converted)
- If single subsidiary: **May return NULL** (no consolidation needed, CONSOLIDATE returns NULL)

---

### Query 3: WITH COALESCE (New Approach)
```sql
SELECT 
    a.accttype AS account_type,
    SUM(
        CASE WHEN a.accttype IN ('Income', 'OthIncome') THEN 
            -COALESCE(
                TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', 2, t.postingperiod, 'DEFAULT')),
                tal.amount
            )
        ELSE 
            COALESCE(
                TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', 2, t.postingperiod, 'DEFAULT')),
                tal.amount
            )
        END
    ) AS total_amount
FROM transactionaccountingline tal
JOIN transaction t ON t.id = tal.transaction
JOIN account a ON a.id = tal.account
JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
WHERE t.posting = 'T'
  AND tal.posting = 'T'
  AND a.accttype = 'Income'
  AND a.isinactive = 'F'
  AND tal.accountingbook = 2
  AND tl.subsidiary = 2
  AND t.postingperiod IN (SELECT id FROM accountingperiod WHERE periodname LIKE 'Mar 2025')
GROUP BY a.accttype
```

**Expected Result:** 
- If CONSOLIDATE returns NULL: Falls back to `tal.amount` (same as Query 1)
- If CONSOLIDATE returns value: Uses consolidated amount (same as Query 2)
- **Best of both worlds**: Works for both single and consolidated subsidiaries

---

## Analysis

### Hypothesis
Based on the logs showing $0.00 for all Income periods, we suspect:
- **Query 2 (WITH CONSOLIDATE)** is returning NULL for single subsidiary
- **Query 1 (NO CONSOLIDATE)** would return actual amounts
- **Query 3 (WITH COALESCE)** should match Query 1 for single subsidiary

### Expected Outcomes

#### Scenario A: Single Subsidiary (No Children)
- Query 1: Returns actual amounts (e.g., $100,000)
- Query 2: Returns NULL or 0 (CONSOLIDATE has nothing to consolidate)
- Query 3: Returns same as Query 1 (COALESCE falls back to tal.amount)
- **Recommendation:** Use Query 3 (COALESCE approach)

#### Scenario B: Consolidated Subsidiary (Has Children)
- Query 1: Returns raw amounts (may be in different currencies)
- Query 2: Returns consolidated amounts (currency converted)
- Query 3: Returns same as Query 2 (COALESCE uses CONSOLIDATE result)
- **Recommendation:** Use Query 3 (COALESCE approach)

### Conclusion
**The COALESCE approach (Query 3) is the universal solution:**
- ✅ Works for single subsidiary (falls back to raw amount)
- ✅ Works for consolidated subsidiary (uses consolidated amount)
- ✅ Single CONSOLIDATE call (no need to check first)
- ✅ Handles NULL gracefully

---

## Implementation Recommendation

Replace the current query in `TypeBalanceController.cs` with the COALESCE approach:

```csharp
monthCases.Add($@"
    SUM(CASE WHEN t.postingperiod = {periodId} THEN 
        COALESCE(
            TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', {targetSub}, t.postingperiod, 'DEFAULT')),
            tal.amount
        )
        * CASE WHEN a.accttype IN ({incomeTypesSql}) THEN -1 ELSE 1 END
    ELSE 0 END) AS {colName}");
```

This is **already implemented** in the current code (v4.0.6.74).

---

## Next Steps
1. Run the test script to verify the hypothesis
2. Compare actual results from all three queries
3. Confirm COALESCE approach works for both scenarios
4. If confirmed, the current implementation is correct

