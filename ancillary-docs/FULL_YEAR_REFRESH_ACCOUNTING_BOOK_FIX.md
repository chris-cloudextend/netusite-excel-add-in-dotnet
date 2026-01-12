# Full Year Refresh Accounting Book Fix

**Date:** January 6, 2026  
**Issue:** Full Year Refresh may not be passing accounting book correctly, causing cache to be populated with wrong book data

---

## Problem

When a user changes U3 (accounting book) from "1" to "2", the cache may still contain Book 1 data from a previous full year refresh. Even though cache keys include `accountingBook`, if the full year refresh was run with Book 1, all cache entries will have Book 1 in the key.

**Critical Issue:** If full year refresh reads the accounting book from the first request in the queue, and that request was queued BEFORE U3 was changed, it will use Book 1 even though U3 is now "2".

---

## Fixes Applied

### 1. Backend: Convert Accounting Book to String ✅

**File:** `backend-dotnet/Controllers/BalanceController.cs` (line 636)

**Before:**
```csharp
var accountingBook = request.Book ?? DefaultAccountingBook;
```

**After:**
```csharp
// CRITICAL FIX: Convert accounting book to string (like all other methods)
var accountingBook = (request.Book ?? DefaultAccountingBook).ToString();

// CRITICAL DEBUG: Log accounting book to verify it's being used
_logger.LogInformation("🔍 [FULL YEAR REFRESH DEBUG] Year={Year}, accountingBook={Book} (request.Book={RequestBook}, Default={Default})", 
    fiscalYear, accountingBook, request.Book?.ToString() ?? "null", DefaultAccountingBook);
```

**Why:** Ensures consistency with all other methods that use `string accountingBook` in SQL queries.

---

### 2. Frontend: Debug Logging for Full Year Refresh ✅

**File:** `docs/functions.js` (lines 7953-7957, 7968-7969)

**Added:**
```javascript
// CRITICAL DEBUG: Log accounting book to verify it's being passed
console.log(`   🔍 DEBUG: accountingBook="${filters.accountingBook || ''}" (from first request)`);

// CRITICAL DEBUG: Log payload to verify accounting book is included
console.log(`   🔍 DEBUG: Payload includes accountingBook="${payload.accountingBook || ''}"`);
```

**Why:** Helps identify if accounting book is being passed correctly from frontend to backend.

---

## Verification

### Frontend Console (F12)
Look for:
- `🔍 DEBUG: accountingBook="2"` in Full Refresh Request logs
- `🔍 DEBUG: Payload includes accountingBook="2"` before API call

### Backend Logs
Look for:
- `🔍 [FULL YEAR REFRESH DEBUG] accountingBook=2` (should show "2", not "1")
- SQL query should contain `tal.accountingbook = 2` (not `= 1`)

---

## Root Cause Analysis

The issue is likely one of these:

1. **Full Year Refresh uses first request's accounting book** - If the first request in the queue was queued before U3 changed, it will have Book 1
2. **Cache not cleared when U3 changes** - If cache isn't cleared automatically, old Book 1 entries remain
3. **Timing issue** - Full year refresh runs before U3 change is detected

---

## Next Steps

1. **Test with debug logging** - Run full year refresh with Book 2 and check logs
2. **Verify cache clearing** - Check if cache is automatically cleared when U3 changes
3. **Check request queue** - Verify that requests in the queue have the correct accounting book

---

**End of Document**

