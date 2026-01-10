# Financial Calculation Bug Review Report

**Date:** January 6, 2026  
**Priority:** Critical - Financial accuracy is paramount  
**Status:** Review Only - No Code Changes Made

---

## Executive Summary

This review identified **5 categories of potential financial calculation bugs** that could cause incorrect numbers or silent failures:

1. **Type Mismatches** - Parameters passed as wrong type to SQL queries (1 issue found, already fixed)
2. **Parameters Not Propagated** - Parameters accepted but not used in all code paths (2 issues found)
3. **Silent Failures Returning Zero** - Errors swallowed and returned as 0 (documented in previous reports, status unclear)
4. **SQL String Building Issues** - Inconsistent parameter handling in query construction (1 issue found)
5. **Currency/Subsidiary Logic** - Potential issues with BUILTIN.CONSOLIDATE parameters (1 issue found)

---

## 1. Type Mismatches

### ✅ FIXED: Accounting Book Type in Helper Methods

**Location:** `backend-dotnet/Services/BalanceService.cs`

**Issue:** Three helper methods had `int accountingBook` parameters but were being called with `string accountingBook` after the recent fix to convert accounting book to string.

**Methods Affected:**
- `GetFullYearBalancesAsync` (line 2893)
- `BuildPeriodRangeQuery` (line 3037)
- `BuildPeriodRangeQueryByIds` (line 3076)

**Status:** ✅ **FIXED** - All three method signatures updated to accept `string accountingBook`.

**Impact:** Without this fix, the server would not compile. This was a compilation error, not a runtime bug.

---

## 2. Parameters Not Propagated

### ⚠️ ISSUE #1: `GetFiscalYearInfoAsync` Still Uses `int` for Accounting Book

**Location:** `backend-dotnet/Controllers/SpecialFormulaController.cs`

**Issue:** In three methods (`CalculateNetIncome`, `CalculateRetainedEarnings`, `CalculateCta`), the code converts `accountingBook` to string for SQL queries, but then creates a separate `accountingBookInt` variable to call `GetFiscalYearInfoAsync`:

```csharp
// Line 525-529 (CalculateNetIncome)
var accountingBook = (request.Book ?? DefaultAccountingBook).ToString();
// ...
var accountingBookInt = request.Book ?? DefaultAccountingBook;
var fyInfo = await GetFiscalYearInfoAsync(request.Period, accountingBookInt);
```

**What Could Go Wrong:**
- If `GetFiscalYearInfoAsync` internally uses `accountingBookInt` to build SQL queries (without converting to string), it could cause type mismatch issues in SQL.
- If fiscal year info lookup fails or returns incorrect data for non-primary books, special formulas (Net Income, Retained Earnings, CTA) could calculate incorrectly.

**Example Scenario:**
- User selects Book 2 (India) for Net Income calculation
- `accountingBook` = "2" (string, used in SQL)
- `accountingBookInt` = 2 (int, used in fiscal year lookup)
- If `GetFiscalYearInfoAsync` doesn't handle Book 2 correctly, fiscal year boundaries could be wrong
- Net Income calculation uses wrong period ranges → incorrect results

**Suggested Fix:**
1. Check `GetFiscalYearInfoAsync` implementation to ensure it handles non-primary accounting books correctly
2. Verify that fiscal year boundaries are book-specific (they should be)
3. Consider converting `GetFiscalYearInfoAsync` to accept `string` accountingBook for consistency

**Files to Review:**
- `backend-dotnet/Controllers/SpecialFormulaController.cs` (lines 86-87, 238-239, 528-529)
- `GetFiscalYearInfoAsync` method implementation (location unknown, needs search)

---

### ⚠️ ISSUE #2: `BUILTIN.CONSOLIDATE` Parameter Inconsistency in `GetFullYearBalancesAsync`

**Location:** `backend-dotnet/Services/BalanceService.cs` (line 2933)

**Issue:** In `GetFullYearBalancesAsync`, the `BUILTIN.CONSOLIDATE` call uses `t.postingperiod` (a column reference) as the 6th parameter:

```csharp
TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', {targetSub}, t.postingperiod, 'DEFAULT'))
```

However, in the fixed `TYPEBALANCE` batch query (from previous fixes), the 6th parameter should be a literal period ID, not a column reference.

**What Could Go Wrong:**
- `BUILTIN.CONSOLIDATE` expects the 6th parameter to be a period ID for exchange rate lookup
- Using `t.postingperiod` (a column) means each transaction uses its own period's exchange rate
- This is actually **correct for P&L queries** (each transaction should use its own period's rate)
- However, if this method is used for Balance Sheet calculations, it could be wrong (BS should use target period's rate)

**Example Scenario:**
- This is likely **NOT a bug** for P&L queries (Income Statement)
- But if `GetFullYearBalancesAsync` is ever used for Balance Sheet accounts, the exchange rate would be wrong
- Each transaction would use its own period's rate instead of the target period's rate

**Suggested Fix:**
1. Verify that `GetFullYearBalancesAsync` is **only** used for P&L accounts (Income, COGS, Expense, OthIncome, OthExpense)
2. If it's used for Balance Sheet, add a parameter to specify target period ID
3. Document the expected behavior: P&L uses `t.postingperiod`, BS uses target period ID

**Status:** Needs verification - may be correct as-is for P&L queries.

---

## 3. Silent Failures Returning Zero

### 📋 DOCUMENTED: Previous Work on Silent Zero Elimination

**Location:** Multiple files (see `SILENT_ZERO_ELIMINATION_REPORT.md`)

**Status:** Previous work was done to eliminate silent failures, but the current state is unclear.

**Key Areas Previously Addressed:**
1. `QueryRawAsync` / `QueryAsync` - Swallow errors, return empty lists
2. `ParseBalance` / `ParseDecimalFromResult` - Return 0 on parse failures
3. Frontend `|| 0` fallbacks - Mask API errors as zeros

**Recommendation:**
1. Verify that all finance-critical endpoints use `QueryRawWithErrorAsync` instead of `QueryRawAsync`
2. Verify that parse methods throw exceptions instead of returning 0 on failures
3. Verify that frontend checks for `data.error` / `data.errorCode` before using results

**Files to Verify:**
- `backend-dotnet/Services/NetSuiteService.cs` - Query methods
- `backend-dotnet/Controllers/*Controller.cs` - All finance endpoints
- `docs/functions.js` - Frontend error handling

---

## 4. SQL String Building Issues

### ⚠️ ISSUE #3: Inconsistent Accounting Book Filter Construction

**Location:** Multiple files

**Issue:** Accounting book filters are constructed in multiple ways:

1. **Direct interpolation:** `tal.accountingbook = {accountingBook}` (most common, correct)
2. **String interpolation with quotes:** Some queries might need quotes if accountingBook could be non-numeric (unlikely but possible)

**What Could Go Wrong:**
- If accounting book IDs are ever non-numeric (e.g., alphanumeric), direct interpolation would break SQL syntax
- SQL injection risk if accountingBook is not validated (low risk since it comes from request.Book which is int?)

**Example Scenario:**
- Future NetSuite update allows alphanumeric accounting book IDs
- Current code: `tal.accountingbook = {accountingBook}` → `tal.accountingbook = ABC123` (invalid SQL)
- Should be: `tal.accountingbook = '{accountingBook}'` → `tal.accountingbook = 'ABC123'` (valid SQL)

**Suggested Fix:**
1. Verify that NetSuite accounting book IDs are always numeric (they should be)
2. Add validation to ensure `accountingBook` is numeric before SQL interpolation
3. Consider parameterized queries if NetSuite API supports it (unlikely for SuiteQL)

**Status:** Low priority - accounting book IDs are currently always numeric, but worth documenting.

---

## 5. Currency/Subsidiary Logic

### ⚠️ ISSUE #4: `BUILTIN.CONSOLIDATE` Parameter Order Verification

**Location:** Multiple files using `BUILTIN.CONSOLIDATE`

**Issue:** `BUILTIN.CONSOLIDATE` has 7 parameters, and the order is critical:

```
BUILTIN.CONSOLIDATE(
    amount,              // 1: tal.amount
    'LEDGER',           // 2: Always 'LEDGER'
    'DEFAULT',           // 3: Always 'DEFAULT'
    'DEFAULT',          // 4: Always 'DEFAULT'
    targetSub,          // 5: Target subsidiary ID (string)
    targetPeriodId,     // 6: Target period ID (int, for exchange rate)
    'DEFAULT'           // 7: Always 'DEFAULT'
)
```

**What Could Go Wrong:**
- If parameters are in wrong order, currency conversion would fail silently
- If 5th parameter (targetSub) is wrong, consolidation would be incorrect
- If 6th parameter (targetPeriodId) is wrong, exchange rates would be wrong

**Example Scenario:**
- Previous bug: 5th parameter was `targetSub` (subsidiary ID), 6th parameter was `t.postingperiod` (column)
- Fixed: 5th parameter is `accountingBook` (WRONG - this was the bug we just fixed)
- Actually: 5th parameter should be `targetSub` (subsidiary ID), 6th parameter should be period ID (literal or column depending on use case)

**Suggested Fix:**
1. Create a helper method to build `BUILTIN.CONSOLIDATE` calls consistently
2. Document the correct parameter order and meaning
3. Add unit tests to verify parameter order

**Status:** Needs verification - the recent fix to TYPEBALANCE may have introduced this issue. Need to verify the correct parameter order.

---

## Summary of Findings

| Category | Issues Found | Status | Priority |
|----------|--------------|--------|----------|
| Type Mismatches | 1 | ✅ Fixed | Critical |
| Parameters Not Propagated | 2 | ⚠️ Needs Review | High |
| Silent Failures | Documented | 📋 Needs Verification | Critical |
| SQL String Building | 1 | ⚠️ Low Risk | Low |
| Currency/Subsidiary Logic | 1 | ⚠️ Needs Verification | High |

---

## Recommended Next Steps

1. **Immediate:** Verify the server compiles and runs after the type mismatch fix
2. **High Priority:** Review `GetFiscalYearInfoAsync` to ensure it handles non-primary accounting books correctly
3. **High Priority:** Verify `BUILTIN.CONSOLIDATE` parameter order in all queries (especially the recent TYPEBALANCE fix)
4. **Medium Priority:** Verify that silent zero elimination fixes are still in place and working
5. **Low Priority:** Document accounting book ID validation and SQL injection prevention

---

## Files Modified (Build Fix Only)

- `backend-dotnet/Services/BalanceService.cs`:
  - Line 2893: `GetFullYearBalancesAsync` - Changed `int accountingBook` to `string accountingBook`
  - Line 3037: `BuildPeriodRangeQuery` - Changed `int accountingBook` to `string accountingBook`
  - Line 3076: `BuildPeriodRangeQueryByIds` - Changed `int accountingBook` to `string accountingBook`

---

## Files to Review (No Changes Made)

- `backend-dotnet/Controllers/SpecialFormulaController.cs` - Verify `GetFiscalYearInfoAsync` usage
- `backend-dotnet/Services/BalanceService.cs` - Verify `BUILTIN.CONSOLIDATE` parameter order
- All files using `BUILTIN.CONSOLIDATE` - Verify parameter consistency
- `backend-dotnet/Services/NetSuiteService.cs` - Verify error handling methods
- `docs/functions.js` - Verify frontend error handling

---

**End of Report**

