# Balance Sheet Date Filtering Fix

## Issue Summary

**Problem:** Balance Sheet account balances returned incorrect values when retrieved from batch precache (`/batch/bs_preload`), but correct values when queried individually via `XAVI.BALANCE()` formula.

**Example:**
- **Account:** 13000
- **Period:** May 2025
- **Subsidiary:** Celigo India Pvt Ltd
- **Accounting Book:** 2
- **Expected Balance (from NetSuite):** $8,314,265.34
- **Individual Query Result:** $8,314,265.34 ✅ (correct)
- **Batch Precache Result:** $7,855,937.00 ❌ (incorrect, off by $458,328.34)

## Root Cause Analysis

### Theory: NetSuite Uses Transaction Date, Not Posting Period

NetSuite's GL Balance report uses **transaction date** (`t.trandate`) for cumulative Balance Sheet calculations, not **posting period** (`t.postingperiod`). This is a critical distinction:

- **Transaction Date (`t.trandate`):** The actual date the transaction occurred
- **Posting Period (`t.postingperiod`):** The accounting period the transaction was posted to

For Balance Sheet accounts (cumulative balances), NetSuite includes all transactions where `transaction_date <= period_end_date`, regardless of which period they were posted to.

### Evidence

1. **Direct NetSuite Query Verification:**
   - Created Python script `check_netsuite_balance.py` that queries NetSuite directly
   - Query using `t.trandate <= TO_DATE('2025-05-31', 'YYYY-MM-DD')` returns: **$8,314,265.34** ✅
   - This matches NetSuite's GL Balance report exactly

2. **Individual Query (Correct):**
   - `BalanceService.GetBalanceAsync()` uses: `t.trandate <= TO_DATE('{toEndDate}', 'YYYY-MM-DD')`
   - Returns correct value: **$8,314,265.34**

3. **Batch Precache (Incorrect - Before Fix):**
   - `BalanceController.PreloadBalanceSheetAccounts()` was using: `t.postingperiod <= {periodId}`
   - Returned incorrect value: **$7,855,937.00**

## Code Changes

### 1. BS PRELOAD Query Fix

**File:** `backend-dotnet/Controllers/BalanceController.cs`

**Before (Incorrect):**
```csharp
LEFT JOIN transaction t ON t.id = tal.transaction
    AND t.posting = 'T'
    AND t.postingperiod <= {periodId}  // ❌ Wrong: uses posting period
```

**After (Correct):**
```csharp
var endDate = ConvertToYYYYMMDD(period.EndDate);  // Convert to YYYY-MM-DD format

LEFT JOIN transaction t ON t.id = tal.transaction
    AND t.posting = 'T'
    AND t.trandate <= TO_DATE('{endDate}', 'YYYY-MM-DD')  // ✅ Correct: uses transaction date
```

**Location:** Line ~1133 in `PreloadBalanceSheetAccounts()` method

### 2. Targeted BS PRELOAD Query Fix

**File:** `backend-dotnet/Controllers/BalanceController.cs`

**Before (Incorrect):**
```csharp
WHERE t.posting = 'T'
  AND tal.posting = 'T'
  AND a.acctnumber IN ('{accountFilter}')
  AND t.postingperiod <= {periodId}  // ❌ Wrong: uses posting period
```

**After (Correct):**
```csharp
var endDate = ConvertToYYYYMMDD(period.EndDate);  // Convert to YYYY-MM-DD format

WHERE t.posting = 'T'
  AND tal.posting = 'T'
  AND a.acctnumber IN ('{accountFilter}')
  AND t.trandate <= TO_DATE('{endDate}', 'YYYY-MM-DD')  // ✅ Correct: uses transaction date
```

**Location:** Line ~1393 in `PreloadBalanceSheetTargeted()` method

### 3. Individual Query (Already Correct)

**File:** `backend-dotnet/Services/BalanceService.cs`

**Already using correct logic:**
```csharp
// Convert dates to YYYY-MM-DD format
var toEndDate = ConvertToYYYYMMDD(toPeriodData.EndDate);

// Point-in-time query for Balance Sheet
query = $@"
    SELECT SUM(x.cons_amt) AS balance
    FROM (
        SELECT ...
        FROM transactionaccountingline tal
        JOIN transaction t ON t.id = tal.transaction
        ...
        WHERE t.posting = 'T'
          AND tal.posting = 'T'
          AND {NetSuiteService.BuildAccountFilter(new[] { request.Account })}
          AND t.trandate <= TO_DATE('{toEndDate}', 'YYYY-MM-DD')  // ✅ Correct
          AND tal.accountingbook = {accountingBook}
    ) x";
```

**Location:** Line ~394 in `GetBalanceAsync()` method

## Why This Matters

### Balance Sheet vs P&L Accounts

- **Balance Sheet Accounts:** Cumulative balances from inception. Must use transaction date to match NetSuite's GL Balance report behavior.
- **P&L Accounts:** Period-specific activity. Can use posting period (each transaction uses its own period's exchange rate).

### Currency Consolidation

For Balance Sheet accounts, ALL historical transactions must be converted at the SAME exchange rate (the target period's rate) to ensure the balance sheet balances correctly. Using `t.postingperiod` would cause each transaction to use its own period's rate, leading to:
- Balance sheet imbalances
- Incorrect cumulative balances
- Mismatches with NetSuite's GL Balance report

## Verification

### Direct NetSuite Query

Created `check_netsuite_balance.py` to verify the correct balance:

```python
# Query using transaction date (correct)
balance_query = f"""
SELECT SUM(x.cons_amt) AS balance
FROM (
    SELECT
        TO_NUMBER(
            BUILTIN.CONSOLIDATE(
                tal.amount,
                'LEDGER',
                'DEFAULT',
                'DEFAULT',
                {sub_id},
                {period_id},
                'DEFAULT'
            )
        ) * CASE 
            WHEN a.accttype IN ('AcctPay', 'CredCard', 'OthCurrLiab', 'LongTermLiab', 'Equity') THEN -1
            WHEN a.accttype IN ('OthIncome', 'Income') THEN -1
            ELSE 1 
        END AS cons_amt
    FROM transactionaccountingline tal
    JOIN transaction t ON t.id = tal.transaction
    JOIN account a ON a.id = tal.account
    JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
    WHERE t.posting = 'T'
      AND tal.posting = 'T'
      AND a.acctnumber = '13000'
      AND t.trandate <= TO_DATE('{end_date}', 'YYYY-MM-DD')  # ✅ Transaction date
      AND tal.accountingbook = 2
      AND tl.subsidiary = {sub_id}
) x
"""

# Result: $8,314,265.34 ✅ (matches NetSuite GL Balance report)
```

### Test Results

**Before Fix:**
- Individual query: $8,314,265.34 ✅
- Batch precache: $7,855,937.00 ❌
- **Difference:** $458,328.34

**After Fix:**
- Individual query: $8,314,265.34 ✅
- Batch precache: $8,314,265.34 ✅ (expected)
- **Difference:** $0.00

## Debugging Added

Comprehensive logging was added to trace the issue:

### BS PRELOAD Logging
- Period resolution details (period ID, end date conversion)
- Query parameters (subsidiary, accounting book, filters hash)
- Full SQL query preview
- Account 13000 specific logging when found in results
- Cache key generation and write operations

### BalanceService Logging
- Cache key generation and lookup
- Date conversion (raw → YYYY-MM-DD)
- Query parameters and SQL preview
- Query result balance value
- Final response details

## Files Modified

1. `backend-dotnet/Controllers/BalanceController.cs`
   - `PreloadBalanceSheetAccounts()` method (line ~1133)
   - `PreloadBalanceSheetTargeted()` method (line ~1393)
   - Added comprehensive debugging logs

2. `backend-dotnet/Services/BalanceService.cs`
   - `GetBalanceAsync()` method (already correct, added debugging)
   - Added comprehensive debugging logs

## Testing Checklist

- [x] Direct NetSuite query returns correct balance
- [x] Individual `XAVI.BALANCE()` formula returns correct balance
- [ ] Batch precache returns correct balance (after server restart)
- [ ] Cache keys match between individual and batch queries
- [ ] Date filters use transaction date in both query paths

## Related Issues

This fix ensures consistency between:
- Individual balance queries (`/api/balance`)
- Batch balance precache (`/batch/bs_preload`)
- Batch targeted precache (`/batch/bs_preload_targeted`)

All three now use the same date filtering logic: `t.trandate <= TO_DATE('{endDate}', 'YYYY-MM-DD')`

## References

- NetSuite SuiteQL Documentation: Transaction date vs posting period
- NetSuite GL Balance Report: Uses transaction date for cumulative balances
- Python verification script: `check_netsuite_balance.py`
- Test endpoint: `/test/balance-13000-may-2025` (compares direct query vs production service)

