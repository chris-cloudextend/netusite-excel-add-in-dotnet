# Full Year Refresh Accounting Book Fix

**Date:** January 6, 2026  
**Issue:** Full Year Refresh receiving `request.Book=null`, defaulting to Book 1 instead of Book 2

---

## Root Cause

**Problem:** Frontend was sending `accountingBook` in the payload, but backend model expects `book`.

**Backend Model:**
```csharp
[JsonPropertyName("book")]
[JsonConverter(typeof(FlexibleIntConverter))]
public int? Book { get; set; }
```

**Frontend Payload (BEFORE FIX):**
```javascript
const payload = {
    year: year,
    ...filters  // This includes accountingBook, not book!
};
```

**Result:** `request.Book` was `null` because JSON property name didn't match, so it defaulted to `DefaultAccountingBook` (1).

---

## Fix Applied

**File:** `docs/functions.js` (line 7963)

**Before:**
```javascript
const payload = {
    year: year,
    ...filters
};
```

**After:**
```javascript
// CRITICAL FIX: Backend expects "book" not "accountingBook"
const payload = {
    year: year,
    subsidiary: filters.subsidiary || '',
    department: filters.department || '',
    location: filters.location || '',
    class: filters.class || '',
    book: filters.accountingBook || ''  // Backend expects "book" property name
};
```

**Debug Logging Updated:**
```javascript
console.log(`   🔍 DEBUG: Payload includes book="${payload.book || ''}" (was accountingBook="${filters.accountingBook || ''}")`);
```

---

## Verification

### Before Fix:
```
🔍 [FULL YEAR REFRESH DEBUG] Year=2025, accountingBook=1 (request.Book=null, Default=1)
```

### After Fix (Expected):
```
🔍 [FULL YEAR REFRESH DEBUG] Year=2025, accountingBook=2 (request.Book=2, Default=1)
```

---

## Testing

1. **Set U3 to "2"** (verify cell contains "2")
2. **Run Structure Sync** (CFO Flash Report or Income Statement)
3. **Check Backend Logs:**
   ```bash
   bash excel-addin/useful-commands/check-balance-logs.sh
   ```
4. **Verify:**
   - `request.Book=2` (not null)
   - `accountingBook=2` (not 1)
   - SQL query contains `tal.accountingbook = 2` (not `= 1`)

---

**End of Document**

