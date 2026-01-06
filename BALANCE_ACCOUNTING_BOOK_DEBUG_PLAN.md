# BALANCE Formula Accounting Book Debug Plan

**Date:** January 6, 2026  
**Issue:** BALANCE formula returns Book 1 data when Book 2 is selected, even after clearing cache

---

## Debug Logging Added

### Frontend (functions.js)

1. **BALANCE function entry** (line 6214):
   - Logs: `accountingBook` value, raw value, and type
   - Shows what Excel is passing to the function

2. **Batch processor API call** (lines 8409-8411):
   - Logs: `accountingbook` parameter value and type
   - Logs: Full API URL with all parameters
   - Shows what's being sent to the backend

### Backend (BalanceController.cs & BalanceService.cs)

1. **BalanceController.GetBalance** (line 177):
   - Logs: Incoming `book` parameter from query string
   - Logs: `BalanceRequest.Book` value after creating request object

2. **BalanceService.GetBalanceAsync** (line 265):
   - Logs: `accountingBook` value after conversion to string
   - Logs: `request.Book` and `DefaultAccountingBook` for comparison

3. **SQL Query Logging** (lines 381, 589):
   - Logs: First 500 characters of actual SQL query
   - Verifies `tal.accountingbook = {accountingBook}` is in the query

---

## Next Steps for Testing

1. **Restart backend server** to apply logging changes
2. **Clear Excel cache** completely
3. **Set U3 to "2"** (verify the cell actually contains "2")
4. **Run BALANCE formula** for account 49998, Jan 2025
5. **Check logs:**

### Frontend Console (Browser F12)
Look for:
- `🔍 BALANCE DEBUG: account=49998, accountingBook="2"` - Should show "2", not empty or "1"
- `🔍 DEBUG: API params - accountingbook="2"` - Should show "2"
- `🔍 DEBUG: Full API URL:` - Check if `accountingbook=2` is in the URL

### Backend Logs
Look for:
- `🔍 [BALANCE DEBUG] BalanceController.GetBalance: book=2` - Should show 2, not null or 1
- `🔍 [BALANCE DEBUG] BalanceRequest created: Book=2` - Should show 2
- `🔍 [BALANCE DEBUG] GetBalanceAsync: accountingBook=2` - Should show "2" (string)
- `🔍 [BALANCE DEBUG] Point-in-time query SQL:` - Check if `tal.accountingbook = 2` is in the SQL

---

## Potential Root Causes

1. **Excel cell U3 not being read** - Formula might not be referencing U3
2. **Excel cell U3 contains "1" or empty** - User thinks it's "2" but it's not
3. **Cache collision** - Old Book 1 cache entries still present (unlikely since cache keys include book)
4. **Default value being used** - `accountingBook || ''` defaults to empty, which becomes Book 1 on backend

---

## Verification Checklist

- [ ] Frontend logs show `accountingBook="2"` (not empty or "1")
- [ ] API URL contains `accountingbook=2`
- [ ] Backend logs show `book=2` in controller
- [ ] Backend logs show `accountingBook=2` in service
- [ ] SQL query contains `tal.accountingbook = 2` (not `= 1`)
- [ ] Excel cell U3 actually contains "2" (verify by clicking on it)

---

**End of Plan**

