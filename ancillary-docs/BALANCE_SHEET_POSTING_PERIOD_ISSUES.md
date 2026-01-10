# Balance Sheet Posting Period vs Transaction Date Issues

## Summary

This document identifies instances where Balance Sheet account cumulative balance calculations are using **posting period** (`t.postingperiod`) instead of **transaction date** (`t.trandate`). 

**Key Principle:** 
- **Cumulative Balance Sheet balances** should use `t.trandate <= TO_DATE('{endDate}', 'YYYY-MM-DD')` to match NetSuite's GL Balance report
- **Period Activity queries** (fromPeriod to toPeriod) can use `t.postingperiod IN (...)` as they're calculating activity, not cumulative balance

## Issues Found

### 1. ✅ CORRECT: Period Activity Queries (No Fix Needed)

These queries calculate **period activity** (change between two periods), not cumulative balance, so using `t.postingperiod` is correct:

- **BalanceService.cs:501** - BS period activity range query
  - Query: `t.postingperiod IN ({periodIdList})`
  - Context: Calculates activity between fromPeriod and toPeriod
  - Status: ✅ CORRECT (this is period activity, not cumulative balance)

- **BalanceController.cs:3058** - BS Grid Batching test (period activity)
  - Query: `t.postingperiod IN ({periodIdList})`
  - Context: Returns period activity amounts for grid batching
  - Status: ✅ CORRECT (this is period activity, not cumulative balance)

### 2. ❌ ISSUE: Cumulative Balance Queries (Need Fix)

These queries calculate **cumulative balances** (from inception through period end) and should use transaction date:

#### Issue #1: Batch Balance Query
**File:** `backend-dotnet/Services/BalanceService.cs`  
**Line:** ~1752  
**Method:** `GetBatchBalanceAsync()`  
**Query:**
```csharp
AND t.postingperiod <= {periodId}  // ❌ Should use transaction date
```
**Context:** Batch query for ALL Balance Sheet accounts for a specific period. This calculates cumulative balance from inception through period end.  
**Should be:**
```csharp
AND t.trandate <= TO_DATE('{endDate}', 'YYYY-MM-DD')  // ✅ Correct
```
**Note:** `endDate` is already calculated on line 1717 as `ConvertToYYYYMMDD(info.End)`

---

#### Issue #2: Balance Sheet Report - Posted Retained Earnings
**File:** `backend-dotnet/Controllers/BalanceController.cs`  
**Line:** ~2510  
**Method:** `GenerateBalanceSheetReport()`  
**Query:**
```csharp
AND t.postingperiod <= {targetPeriodId}  // ❌ Should use transaction date
```
**Context:** Calculates cumulative posted Retained Earnings through period end.  
**Should be:**
```csharp
AND t.trandate <= TO_DATE('{periodEndDate}', 'YYYY-MM-DD')  // ✅ Correct
```
**Note:** `periodEndDate` is already calculated on line 1606 as `ConvertToYYYYMMDD(periodData.EndDate)`

---

#### Issue #3: Balance Sheet Report - Total Assets
**File:** `backend-dotnet/Controllers/BalanceController.cs`  
**Line:** ~2551  
**Method:** `GenerateBalanceSheetReport()`  
**Query:**
```csharp
AND t.postingperiod <= {targetPeriodId}  // ❌ Should use transaction date
```
**Context:** Calculates cumulative total assets through period end (for CTA calculation).  
**Should be:**
```csharp
AND t.trandate <= TO_DATE('{periodEndDate}', 'YYYY-MM-DD')  // ✅ Correct
```

---

#### Issue #4: Balance Sheet Report - Total Liabilities
**File:** `backend-dotnet/Controllers/BalanceController.cs`  
**Line:** ~2566  
**Method:** `GenerateBalanceSheetReport()`  
**Query:**
```csharp
AND t.postingperiod <= {targetPeriodId}  // ❌ Should use transaction date
```
**Context:** Calculates cumulative total liabilities through period end (for CTA calculation).  
**Should be:**
```csharp
AND t.trandate <= TO_DATE('{periodEndDate}', 'YYYY-MM-DD')  // ✅ Correct
```

---

#### Issue #5: Balance Sheet Report - Posted Equity (excluding RE)
**File:** `backend-dotnet/Controllers/BalanceController.cs`  
**Line:** ~2582  
**Method:** `GenerateBalanceSheetReport()`  
**Query:**
```csharp
AND t.postingperiod <= {targetPeriodId}  // ❌ Should use transaction date
```
**Context:** Calculates cumulative posted equity (excluding Retained Earnings) through period end (for CTA calculation).  
**Should be:**
```csharp
AND t.trandate <= TO_DATE('{periodEndDate}', 'YYYY-MM-DD')  // ✅ Correct
```

---

#### Issue #6: Balance Sheet Report CTA - Posted Retained Earnings
**File:** `backend-dotnet/Controllers/BalanceController.cs`  
**Line:** ~2665  
**Method:** `GenerateBalanceSheetReport()`  
**Query:**
```csharp
AND t.postingperiod <= {targetPeriodId}  // ❌ Should use transaction date
```
**Context:** Calculates cumulative posted Retained Earnings through period end (for CTA calculation in full year refresh).  
**Should be:**
```csharp
AND t.trandate <= TO_DATE('{periodEndDate}', 'YYYY-MM-DD')  // ✅ Correct
```

---

#### Issue #7: Opening Balances Query
**File:** `backend-dotnet/Controllers/BalanceController.cs`  
**Line:** ~3336  
**Method:** `GetBsGridOpeningBalances()`  
**Query:**
```csharp
AND t.postingperiod <= {anchorPeriodId}  // ❌ Should use transaction date
```
**Context:** Calculates cumulative opening balances for Balance Sheet accounts at anchor date.  
**Should be:**
```csharp
AND t.trandate <= TO_DATE('{anchorDateStr}', 'YYYY-MM-DD')  // ✅ Correct
```
**Note:** `anchorDateStr` is already calculated earlier in the method

---

#### Issue #8: Opening Balance Query (BalanceService)
**File:** `backend-dotnet/Services/BalanceService.cs`  
**Line:** ~2520  
**Method:** `GetOpeningBalanceAsync()`  
**Query:**
```csharp
AND t.postingperiod <= {anchorPeriodId}  // ❌ Should use transaction date
```
**Context:** Calculates cumulative opening balance for a Balance Sheet account at anchor date.  
**Should be:**
```csharp
AND t.trandate <= TO_DATE('{anchorDateStr}', 'YYYY-MM-DD')  // ✅ Correct
```
**Note:** `anchorDateStr` is already calculated earlier in the method (line ~2406)

---

## Special Cases (P&L Accounts - No Fix Needed)

The following queries are for **P&L accounts** (Income/Expense), which correctly use `t.postingperiod`:

- **BalanceController.cs:2430-2431** - Net Income query (P&L accounts)
- **BalanceController.cs:2483** - Prior P&L query (P&L accounts)
- **BalanceController.cs:2649** - Prior P&L query for CTA (P&L accounts)

These are correct because:
1. They filter by `a.accttype IN ({plTypesSql})` - P&L account types
2. P&L accounts use posting period for period-specific activity
3. These are not cumulative Balance Sheet calculations

## Summary Table

| File | Line | Method | Query Type | Current Filter | Should Be | Priority |
|------|------|--------|------------|----------------|-----------|----------|
| BalanceService.cs | ~1752 | `GetBatchBalanceAsync` | Cumulative BS Balance | `t.postingperiod <= {periodId}` | `t.trandate <= TO_DATE('{endDate}', 'YYYY-MM-DD')` | HIGH |
| BalanceController.cs | ~2510 | `GenerateBalanceSheetReport` | Posted RE (cumulative) | `t.postingperiod <= {targetPeriodId}` | `t.trandate <= TO_DATE('{periodEndDate}', 'YYYY-MM-DD')` | HIGH |
| BalanceController.cs | ~2551 | `GenerateBalanceSheetReport` | Total Assets (cumulative) | `t.postingperiod <= {targetPeriodId}` | `t.trandate <= TO_DATE('{periodEndDate}', 'YYYY-MM-DD')` | HIGH |
| BalanceController.cs | ~2566 | `GenerateBalanceSheetReport` | Total Liabilities (cumulative) | `t.postingperiod <= {targetPeriodId}` | `t.trandate <= TO_DATE('{periodEndDate}', 'YYYY-MM-DD')` | HIGH |
| BalanceController.cs | ~2582 | `GenerateBalanceSheetReport` | Posted Equity (cumulative) | `t.postingperiod <= {targetPeriodId}` | `t.trandate <= TO_DATE('{periodEndDate}', 'YYYY-MM-DD')` | HIGH |
| BalanceController.cs | ~2665 | `GenerateBalanceSheetReport` | Posted RE for CTA (cumulative) | `t.postingperiod <= {targetPeriodId}` | `t.trandate <= TO_DATE('{periodEndDate}', 'YYYY-MM-DD')` | HIGH |
| BalanceController.cs | ~3336 | `GetBsGridOpeningBalances` | Opening Balances (cumulative) | `t.postingperiod <= {anchorPeriodId}` | `t.trandate <= TO_DATE('{anchorDateStr}', 'YYYY-MM-DD')` | HIGH |
| BalanceService.cs | ~2520 | `GetOpeningBalanceAsync` | Opening Balance (cumulative) | `t.postingperiod <= {anchorPeriodId}` | `t.trandate <= TO_DATE('{anchorDateStr}', 'YYYY-MM-DD')` | HIGH |

## Impact

These issues could cause:
- Incorrect cumulative Balance Sheet balances
- Mismatches with NetSuite's GL Balance report
- Incorrect Balance Sheet report calculations
- Incorrect opening balance calculations
- Incorrect CTA (Cumulative Translation Adjustment) calculations

## Testing Recommendations

After fixes are applied, verify:
1. Batch balance queries return same values as individual queries
2. Balance Sheet report totals match NetSuite's GL Balance report
3. Opening balances match NetSuite's opening balance report
4. CTA calculations are correct (Assets = Liabilities + Equity)

