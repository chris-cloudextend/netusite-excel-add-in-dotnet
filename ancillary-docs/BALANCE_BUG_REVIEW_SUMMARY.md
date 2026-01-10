# BALANCE Formula Accounting Book Bug - Review Summary

**Date:** January 6, 2026  
**Status:** Debug Logging Added - Ready for Testing

---

## All Bugs from Financial Calculation Bug Review - Status

### ✅ FIXED: Type Mismatches
- All helper methods now accept `string accountingBook` (was `int`)
- **Status:** Fixed - Server compiles successfully

### ✅ VERIFIED: Parameters Propagated Correctly
- All SQL queries include `AND tal.accountingbook = {accountingBook}`
- All methods convert `accountingBook` to string correctly
- Frontend passes `accountingbook` parameter in API calls
- Cache keys include `accountingBook` in hash

### ✅ VERIFIED: GetFiscalYearInfoAsync
- Does NOT use accounting book in SQL (fiscal years are not book-specific)
- **Does NOT affect BALANCE formula** (BALANCE doesn't use this method)
- Only affects special formulas (Net Income, RE, CTA) if books have different fiscal calendars

### ✅ VERIFIED: BUILTIN.CONSOLIDATE Parameter Order
- All calls use correct parameter order
- 5th parameter = `targetSub` (subsidiary ID) ✅
- 6th parameter = `targetPeriodId` or `t.postingperiod` ✅
- Accounting book is in WHERE clause, not in BUILTIN.CONSOLIDATE ✅

### ✅ VERIFIED: SQL String Building
- All queries use `tal.accountingbook = {accountingBook}` correctly
- Accounting book is converted to string before SQL interpolation

### ✅ VERIFIED: Cache Keys
- `getFilterKey` includes `accountingBook` (line 3361)
- `getCacheKey` includes `accountingBook` (line 5406)
- Cache collisions between books should not occur

---

## Debug Logging Added

### Frontend (functions.js)
1. **Line 6214:** Logs `accountingBook` value when BALANCE function is called
2. **Lines 8409-8411:** Logs `accountingbook` parameter in API call
3. **Line 8423:** Logs full API URL with all parameters

### Backend
1. **BalanceController.cs (line 177):** Logs incoming `book` parameter
2. **BalanceService.cs (line 265):** Logs `accountingBook` after conversion
3. **BalanceService.cs (line 381):** Logs SQL query (first 500 chars) for point-in-time queries

---

## Root Cause Hypothesis

Since all code paths are verified correct, the issue is likely:

1. **Excel cell U3 not being read** - The formula might not be referencing U3, or U3 contains "1" instead of "2"
2. **Default value being used** - If `accountingBook` is empty/undefined, it defaults to `''`, which becomes Book 1 on backend
3. **Timing issue** - Formula executes before U3 is updated

---

## Testing Instructions

1. **Restart backend server**
2. **Clear all caches** (in-memory and localStorage)
3. **Verify Excel cell U3 contains "2"** (click on it to verify)
4. **Run BALANCE formula:** `=XAVI.BALANCE("49998", "Jan 2025", "Jan 2025", Q3, "", "", "", U3)`
5. **Check logs:**

### Frontend Console (F12)
- Look for: `🔍 BALANCE DEBUG: account=49998, accountingBook="2"`
- Look for: `🔍 DEBUG: API params - accountingbook="2"`
- Look for: `accountingbook=2` in the API URL

### Backend Logs
- Look for: `🔍 [BALANCE DEBUG] BalanceController.GetBalance: book=2`
- Look for: `🔍 [BALANCE DEBUG] GetBalanceAsync: accountingBook=2`
- Look for: `tal.accountingbook = 2` in the SQL query

---

## Expected Results

If accounting book is being passed correctly:
- Frontend logs should show `accountingBook="2"`
- API URL should contain `accountingbook=2`
- Backend logs should show `accountingBook=2`
- SQL query should contain `tal.accountingbook = 2`

If accounting book is NOT being passed:
- Frontend logs will show `accountingBook=""` or `accountingBook="1"`
- API URL will contain `accountingbook=` or `accountingbook=1`
- Backend will default to Book 1

---

**End of Summary**

