# Backend Endpoint Inventory - Finance-Critical Classification

**Date:** January 2, 2025  
**Purpose:** Identify all endpoints that return financial values and classify which are finance-critical

---

## Finance-Critical Endpoints

**Definition:** Endpoints that return numeric financial values (balances, amounts, totals) where a silent 0 would be misleading.

### ✅ Already Fixed (Phase 1)

#### SpecialFormulaController
1. **POST /retained-earnings** ✅
   - Returns: Retained earnings value
   - Status: Uses `QueryRawWithErrorAsync`, checks errors

2. **POST /cta** ✅
   - Returns: CTA (Cumulative Translation Adjustment) value
   - Status: Uses `QueryRawWithErrorAsync`, checks all 6 queries

3. **POST /net-income** ✅
   - Returns: Net income value
   - Status: Uses `QueryRawWithErrorAsync`, checks errors

---

### ⏳ Needs Fix (Phase 2)

#### BalanceController

4. **GET /balance**
   - Returns: Single account balance
   - Finance-Critical: ✅ YES
   - Uses: `BalanceService.GetBalanceAsync` (delegates to service)
   - QueryRawAsync Usage: Indirect (via BalanceService)
   - Priority: **HIGH** - Core balance endpoint

5. **GET /balancebeta**
   - Returns: Single account balance with currency control
   - Finance-Critical: ✅ YES
   - Uses: `BalanceService.GetBalanceBetaAsync` (delegates to service)
   - QueryRawAsync Usage: Indirect (via BalanceService)
   - Priority: **HIGH** - Core balance endpoint

6. **GET /balancecurrency**
   - Returns: Single account balance in specific currency
   - Finance-Critical: ✅ YES
   - Uses: `BalanceService.GetBalanceCurrencyAsync` (delegates to service)
   - QueryRawAsync Usage: Indirect (via BalanceService)
   - Priority: **HIGH** - Core balance endpoint

7. **POST /batch/balance**
   - Returns: Batch balances for multiple accounts
   - Finance-Critical: ✅ YES
   - Uses: `BalanceService.GetBatchBalanceAsync` (delegates to service)
   - QueryRawAsync Usage: Indirect (via BalanceService)
   - Priority: **HIGH** - Batch balance endpoint

9. **POST /batch/full_year_refresh** ⚠️
   - Returns: Full year balances for P&L accounts (12 months)
   - Finance-Critical: ✅ YES
   - QueryRawAsync Usage: **Direct** (line 733: main financial query)
   - Priority: **CRITICAL** - Used by Income Statement reports

10. **POST /batch/balance/year**
    - Returns: Annual P&L totals
    - Finance-Critical: ✅ YES
    - QueryRawAsync Usage: **Direct** (line 904: financial query)
    - Priority: **HIGH** - Year-end totals

11. **POST /batch/bs_preload**
    - Returns: Preloaded balance sheet balances
    - Finance-Critical: ✅ YES
    - Uses: `BalanceService.GetBsPreloadAsync` (delegates to service)
    - QueryRawAsync Usage: Indirect (via BalanceService)
    - Priority: **HIGH** - Balance sheet preload

12. **POST /batch/bs_preload_targeted**
    - Returns: Targeted balance sheet preload
    - Finance-Critical: ✅ YES
    - Uses: `BalanceService.GetBsPreloadTargetedAsync` (delegates to service)
    - QueryRawAsync Usage: Indirect (via BalanceService)
    - Priority: **MEDIUM** - Targeted preload

13. **POST /balance-sheet/report** ⚠️
    - Returns: Balance sheet report with calculated rows (NETINCOME, RETAINEDEARNINGS, CTA)
    - Finance-Critical: ✅ YES
   - QueryRawAsync Usage: **Direct** (lines 2313, 2358, 2379, 2445-2447, 2506, 2508: multiple financial queries)
   - Priority: **CRITICAL** - Balance sheet reports with special formulas

14. **POST /batch/balance/bs-grid-opening**
    - Returns: Opening balances for BS grid
    - Finance-Critical: ✅ YES
    - QueryRawAsync Usage: **Direct** (line 3050: period lookup - non-financial)
    - Priority: **MEDIUM** - Uses QueryRawAsync for period lookup only

15. **POST /batch/balance/bs-grid-activity**
    - Returns: Period activity for BS grid
    - Finance-Critical: ✅ YES
    - Uses: `BalanceService.GetBsGridPeriodActivityAsync` (delegates to service)
    - QueryRawAsync Usage: Indirect (via BalanceService)
    - Priority: **HIGH** - Period activity

#### TypeBalanceController

16. **POST /type-balance**
    - Returns: Balance for all accounts of a specific type
    - Finance-Critical: ✅ YES
    - Uses: `BalanceService.GetTypeBalanceAsync` (delegates to service)
    - QueryRawAsync Usage: Indirect (via BalanceService)
    - Priority: **HIGH** - Type balance endpoint

17. **POST /batch/typebalance_refresh** ⚠️
    - Returns: Batch type balances for full year
    - Finance-Critical: ✅ YES
    - QueryRawAsync Usage: **Direct** (line 202: main financial query)
    - Priority: **CRITICAL** - Used by CFO Flash Report

#### BudgetController

18. **GET /budget**
    - Returns: Budget amount for account/period
    - Finance-Critical: ✅ YES
    - Uses: `BudgetService.GetBudgetAsync` (delegates to service)
    - QueryRawAsync Usage: Indirect (via BudgetService)
    - Priority: **HIGH** - Budget endpoint

19. **POST /batch/budget**
    - Returns: Batch budget amounts
    - Finance-Critical: ✅ YES
    - Uses: `BudgetService.GetBatchBudgetAsync` (delegates to service)
    - QueryRawAsync Usage: Indirect (via BudgetService)
    - Priority: **HIGH** - Batch budget endpoint

20. **GET /budget/all**
    - Returns: All budgets for a year
    - Finance-Critical: ✅ YES
    - Uses: `BudgetService.GetAllBudgetsAsync` (delegates to service)
    - QueryRawAsync Usage: Indirect (via BudgetService)
    - Priority: **MEDIUM** - All budgets endpoint

---

## Non-Finance-Critical Endpoints

**Definition:** Endpoints that return metadata, lookups, or non-financial data. These do NOT need error-aware queries.

### LookupController
- GET /lookups/all
- GET /subsidiaries
- GET /departments
- GET /classes
- GET /locations
- GET /lookups/accountingbooks
- GET /lookups/budget-categories
- GET /lookups/currencies
- GET /periods/from-year

**Status:** ✅ No changes needed - these return metadata, not financial values

### AccountController
- GET /accounts/with-activity
- POST /accounts/types
- GET /accounts/search
- POST /account/name
- GET /account/{account_number}/name
- POST /account/type
- GET /account/{account_number}/type
- POST /account/parent
- GET /account/{account_number}/parent
- GET /account/preload_titles
- POST /batch/account_types
- POST /account/names
- GET /accounts/by-type

**Status:** ✅ No changes needed - these return account metadata, not balances

### TransactionController
- GET /transactions

**Status:** ✅ No changes needed - returns transaction list, not balances

### HealthController
- GET /
- GET /health
- GET /metrics
- GET /test
- GET /check-permissions
- POST /test/query
- POST /test/raw

**Status:** ✅ No changes needed - health checks and testing endpoints

---

## Direct QueryRawAsync Usage in Finance-Critical Endpoints

### BalanceController

1. **FullYearRefresh** (line 733)
   - Query: Main financial query for full year P&L balances
   - **Action Required:** Replace with `QueryRawWithErrorAsync`, check errors

2. **GetBalanceYear** (line 904)
   - Query: Annual P&L totals query
   - **Action Required:** Replace with `QueryRawWithErrorAsync`, check errors

3. **GenerateBalanceSheetReport** (lines 2313, 2358, 2379, 2445-2447, 2506, 2508)
   - Queries: Multiple queries for NETINCOME, RETAINEDEARNINGS, CTA, Assets, Liabilities, Equity
   - **Action Required:** Replace all with `QueryRawWithErrorAsync`, check each query


5. **GetBsGridOpeningBalances** (line 3050)
   - Query: Period lookup (non-financial)
   - **Action Required:** ⚠️ Low priority - only used for period resolution

### TypeBalanceController

1. **BatchTypeBalanceRefresh** (line 202)
   - Query: Main financial query for type balances
   - **Action Required:** Replace with `QueryRawWithErrorAsync`, check errors

### SpecialFormulaController (Helper Methods)

1. **GetFiscalYearInfoAsync** (lines 647, 680)
   - Queries: Period and fiscal year lookups (non-financial)
   - **Action Required:** ⚠️ Low priority - helper method, returns null on failure (handled by caller)

---

## Service Layer QueryRawAsync Usage

### BalanceService
- Uses `QueryRawAsync` internally via `_netSuiteService`
- **Action Required:** Review service methods that use `QueryRawAsync` directly
- **Note:** Most controller endpoints delegate to service methods, so service layer needs review

### BudgetService
- Uses `QueryRawAsync` internally via `_netSuiteService`
- **Action Required:** Review service methods that use `QueryRawAsync` directly

---

## Priority Classification

### 🔴 CRITICAL (Fix First)
1. **BalanceController.FullYearRefresh** - Used by Income Statement
2. **TypeBalanceController.BatchTypeBalanceRefresh** - Used by CFO Flash Report
3. **BalanceController.GenerateBalanceSheetReport** - Balance sheet with special formulas

### 🟠 HIGH (Fix Next)
4. **BalanceController.GetBalanceYear** - Year-end totals
5. **BalanceService methods** - Core balance service
6. **BudgetService methods** - Budget service layer

### 🟡 MEDIUM (Fix After)
7. **BalanceController.GetBsGridOpeningBalances** - Period lookup only
8. **SpecialFormulaController.GetFiscalYearInfoAsync** - Helper method (returns null on failure)

---

## Summary

**Total Finance-Critical Endpoints:** 20  
**Already Fixed:** 3 (SpecialFormulaController)  
**Needs Fix:** 17  

**Direct QueryRawAsync Usage:**
- **CRITICAL:** 3 endpoints (FullYearRefresh, BatchTypeBalanceRefresh, GenerateBalanceSheetReport)
- **HIGH:** 1 endpoint (GetBalanceYear)
- **MEDIUM:** 2 endpoints (helper methods, lookups only)

**Service Layer:**
- **BalanceService:** Needs review for internal QueryRawAsync usage
- **BudgetService:** Needs review for internal QueryRawAsync usage

---

## Next Steps

1. Fix CRITICAL endpoints first (FullYearRefresh, BatchTypeBalanceRefresh, GenerateBalanceSheetReport)
2. Review and fix BalanceService internal QueryRawAsync usage
3. Review and fix BudgetService internal QueryRawAsync usage
4. Fix HIGH priority endpoints
5. Fix MEDIUM priority endpoints (if needed)

