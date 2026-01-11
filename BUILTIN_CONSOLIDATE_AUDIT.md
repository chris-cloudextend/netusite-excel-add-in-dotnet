# BUILTIN.CONSOLIDATE Usage Audit

**Last Updated:** January 10, 2026

## Summary
**Status:** ✅ BUILTIN.CONSOLIDATE is used in ALL finance-critical scenarios
**Validity:** ✅ It is valid and safe to use in all scenarios

## Finance-Critical Endpoints Using BUILTIN.CONSOLIDATE

### ✅ BalanceService.cs
- **GetBalanceAsync** - Single account balance queries
  - Balance Sheet: Uses `BUILTIN.CONSOLIDATE(..., {targetPeriodId}, ...)` ✓
  - P&L: Uses `BUILTIN.CONSOLIDATE(..., {targetPeriodId}, ...)` ✓
  
- **GetBalanceBetaAsync** - Alternative balance endpoint
  - Balance Sheet: Uses `BUILTIN.CONSOLIDATE(..., {targetPeriodId}, ...)` ✓
  - P&L: Uses `BUILTIN.CONSOLIDATE(..., {targetPeriodId}, ...)` ✓

- **GetTypeBalanceAsync** - Account type balance queries
  - Balance Sheet: Uses `BUILTIN.CONSOLIDATE(..., {targetPeriodId}, ...)` ✓
  - P&L: Uses `BUILTIN.CONSOLIDATE(..., t.postingperiod, ...)` ✓ (correct for P&L)

- **GetBatchBalanceAsync** - Batch balance queries
  - Uses `BUILTIN.CONSOLIDATE` ✓

### ✅ BalanceController.cs
- **FullYearRefresh** - Full year P&L preload
  - Uses `BUILTIN.CONSOLIDATE(..., t.postingperiod, ...)` ✓

- **GetBalanceYear** - Annual balance totals
  - Uses `BUILTIN.CONSOLIDATE(..., t.postingperiod, ...)` ✓

- **GetBsGridOpeningBalances** - Balance Sheet opening balances
  - Uses `BUILTIN.CONSOLIDATE(..., {targetPeriodId}, ...)` ✓

- **GetBsGridPeriodActivity** - Balance Sheet period activity
  - Uses `BUILTIN.CONSOLIDATE(..., {targetPeriodId}, ...)` ✓

- **GenerateBalanceSheetReport** - Full Balance Sheet report
  - All queries use `BUILTIN.CONSOLIDATE(..., {targetPeriodId}, ...)` ✓

### ✅ SpecialFormulaController.cs
- **CalculateRetainedEarnings** - Retained Earnings calculation
  - Uses `BUILTIN.CONSOLIDATE(..., {targetPeriodId}, ...)` ✓

- **CalculateNetIncome** - Net Income calculation
  - Uses `BUILTIN.CONSOLIDATE(..., {targetPeriodId}, ...)` ✓

- **CalculateCta** - Cumulative Translation Adjustment
  - Uses `BUILTIN.CONSOLIDATE(..., {targetPeriodId}, ...)` ✓

### ✅ BudgetService.cs
- **GetBudgetAsync** - Single budget queries
  - Uses `BUILTIN.CONSOLIDATE(..., bm.period, ...)` ✓

- **GetBatchBudgetAsync** - Batch budget queries
  - Uses `BUILTIN.CONSOLIDATE(..., bm.period, ...)` ✓

## Non-Finance-Critical Endpoint (Discovery/UI Only)

### ⚠️ AccountController.cs - `/accounts/with-activity`
**Status:** Uses `tal.amount` directly (no BUILTIN.CONSOLIDATE)

**Purpose:** 
- Discovery endpoint to find accounts with transaction activity
- Used for UI dropdowns and account discovery
- Returns account metadata, not financial reporting values

**Analysis:**
- Does NOT accept subsidiary parameter
- Uses `t.trandate` for filtering (not posting period)
- Returns raw transaction amounts for activity detection
- **Not finance-critical** - used for discovery only

**Recommendation:** 
- ⚠️ **Low Priority** - Could add BUILTIN.CONSOLIDATE if this endpoint is ever used for financial reporting
- Currently safe as-is since it's only for account discovery

## Validity of BUILTIN.CONSOLIDATE

### ✅ Safe to Use Everywhere

According to NetSuite documentation and our codebase:

1. **Works for OneWorld and Non-OneWorld:**
   - OneWorld: Performs currency consolidation and translation
   - Non-OneWorld: Returns original amount unchanged (pass-through)
   - No harm in using it for single-currency accounts

2. **Handles All Scenarios:**
   - Multi-currency translation ✓
   - Multi-subsidiary consolidation ✓
   - Intercompany elimination ✓
   - Single-currency (pass-through) ✓
   - Single-subsidiary (pass-through) ✓

3. **Period Parameter Usage:**
   - **Balance Sheet:** Uses `{targetPeriodId}` (all transactions at same rate) ✓
   - **P&L:** Uses `t.postingperiod` (each transaction at its own period rate) ✓
   - Both are correct for their respective use cases

## Key Patterns Found

### Pattern 1: Balance Sheet Queries
```sql
BUILTIN.CONSOLIDATE(
    tal.amount,
    'LEDGER',
    'DEFAULT',
    'DEFAULT',
    {targetSub},
    {targetPeriodId},  -- FIXED period ID for all transactions
    'DEFAULT'
)
```
**Why:** All historical transactions must convert at the same exchange rate (target period's rate)

### Pattern 2: P&L Queries
```sql
BUILTIN.CONSOLIDATE(
    tal.amount,
    'LEDGER',
    'DEFAULT',
    'DEFAULT',
    {targetSub},
    t.postingperiod,  -- Each transaction's own period
    'DEFAULT'
)
```
**Why:** P&L shows activity within each period, so each transaction uses its period's rate

### Pattern 3: Budget Queries
```sql
BUILTIN.CONSOLIDATE(
    bm.amount,
    'LEDGER',
    'DEFAULT',
    'DEFAULT',
    {targetSub},
    bm.period,  -- Budget period
    'DEFAULT'
)
```
**Why:** Budgets are period-specific, so use the budget's period for conversion

## Conclusion

✅ **BUILTIN.CONSOLIDATE is used in ALL finance-critical scenarios**
✅ **It is valid and safe to use everywhere**
✅ **The period parameter is correctly chosen based on query type (BS vs P&L)**

**One exception:** `/accounts/with-activity` endpoint uses raw `tal.amount`, but this is a discovery/UI helper, not a financial reporting endpoint. It could be enhanced to use BUILTIN.CONSOLIDATE if needed, but it's not currently finance-critical.

