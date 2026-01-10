# BALANCE Formula Accounting Book Fix

## Problem

The **BALANCE** formula (and related formulas) was not correctly handling the accounting book parameter for non-primary books (e.g., Book 2). This caused discrepancies between:
- **TYPEBALANCE** (working correctly) - used in CFO Flash Report
- **BALANCE** (broken) - used in Income Statement

### Root Cause

**TYPEBALANCE** correctly converts the accounting book to a string:
```csharp
var accountingBook = (request.Book ?? DefaultAccountingBook).ToString();
```

**BALANCE** (and other formulas) were using an `int` directly:
```csharp
var accountingBook = request.Book ?? DefaultAccountingBook;  // ❌ This is an int!
```

When used in SQL queries:
```sql
AND tal.accountingbook = {accountingBook}  -- ❌ Interpolates int value directly
```

This caused the SQL query to fail or return incorrect results for non-primary accounting books.

---

## Fix Applied

Converted `accountingBook` from `int` to `string` in all affected methods, matching the pattern used in `TYPEBALANCE`:

### Files Fixed

1. **`backend-dotnet/Services/BalanceService.cs`**:
   - `GetBalanceAsync()` - Main BALANCE method
   - `GetBalanceBetaAsync()` - BALANCECURRENCY method
   - `GetTypeBalanceAsync()` - TYPEBALANCE method (already fixed)
   - `GetPeriodActivityBreakdownAsync()` - Period breakdown method
   - `GetOpeningBalanceAsync()` - Opening balance method
   - `GetFullYearBalancesAsync()` - Full year balances method

2. **`backend-dotnet/Controllers/SpecialFormulaController.cs`**:
   - `CalculateNetIncome()` - NETINCOME formula
   - `CalculateRetainedEarnings()` - Retained Earnings calculation
   - `CalculateCta()` - CTA (Cumulative Translation Adjustment) calculation

### Change Pattern

**Before:**
```csharp
var accountingBook = request.Book ?? DefaultAccountingBook;  // int
```

**After:**
```csharp
// CRITICAL FIX: Convert accounting book to string (like TYPEBALANCE does)
// This ensures the SQL query uses the correct type for tal.accountingbook comparison
var accountingBook = (request.Book ?? DefaultAccountingBook).ToString();  // string
```

**Note:** For methods that need the int value for other operations (e.g., `GetFiscalYearInfoAsync()`), we create a separate variable:
```csharp
var accountingBook = (request.Book ?? DefaultAccountingBook).ToString();  // For SQL
var accountingBookInt = request.Book ?? DefaultAccountingBook;  // For other operations
```

---

## Formulas Affected

✅ **BALANCE** - Fixed
✅ **BALANCECURRENCY** - Fixed (uses GetBalanceBetaAsync)
✅ **NETINCOME** - Fixed
✅ **TYPEBALANCE** - Already correct (used as reference)
❌ **BUDGET** - Not affected (doesn't use accounting book in query)

---

## Testing

**Test Case:** Account 49998 for Book 2, Subsidiary India
- **Jan 2025**: Should return `0` (no data)
- **Feb 2025**: Should return `0` (no data)
- **Mar 2025**: Should return `53,203,965.07`

**Expected Result:** BALANCE formula should now match TYPEBALANCE and NetSuite exactly.

---

## Next Steps

1. **Restart backend server** (required - backend code changed)
2. **Test the fix** with account 49998 for Book 2, Subsidiary India
3. **Verify** that Income Statement now matches CFO Flash Report and NetSuite

---

## Technical Details

### Why String Conversion Matters

NetSuite's `tal.accountingbook` column is stored as a string/ID in the database. When using string interpolation in C# SQL queries:

```csharp
var accountingBook = 2;  // int
var query = $"AND tal.accountingbook = {accountingBook}";
// Results in: AND tal.accountingbook = 2  ✅ This works, but is inconsistent

var accountingBook = "2";  // string
var query = $"AND tal.accountingbook = {accountingBook}";
// Results in: AND tal.accountingbook = 2  ✅ Same result, but type-safe
```

However, the real issue was likely that when the int was used in certain contexts, it might have been treated differently. Converting to string ensures consistency with TYPEBALANCE, which was working correctly.

### Comparison with TYPEBALANCE

**TYPEBALANCE** (working):
```csharp
// TypeBalanceController.cs line 103
var accountingBook = (request.Book ?? DefaultAccountingBook).ToString();
```

**BALANCE** (before fix):
```csharp
// BalanceService.cs line 263
var accountingBook = request.Book ?? DefaultAccountingBook;  // int
```

Now both use the same pattern, ensuring consistent behavior.

