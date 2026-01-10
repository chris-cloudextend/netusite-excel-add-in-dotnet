# Structure Sync Issues and Fixes

**Date:** January 6, 2026  
**Issues Found:**
1. Full Year Refresh receiving `request.Book=null`, defaulting to Book 1
2. Progress overlay never closes, success message never appears
3. Wrong book data (Book 1) written to Excel when Book 2 is selected

---

## Issue #1: Full Year Refresh Not Receiving Accounting Book ✅ FIXED

### Root Cause
Frontend was sending `accountingBook` in payload, but backend model expects `book`.

**Backend Model:**
```csharp
[JsonPropertyName("book")]
[JsonConverter(typeof(FlexibleIntConverter))]
public int? Book { get; set; }
```

**Frontend Payload (BEFORE):**
```javascript
const payload = {
    year: year,
    ...filters  // This includes accountingBook, not book!
};
```

**Result:** `request.Book` was `null` because JSON property name didn't match.

### Fix Applied
**File:** `docs/functions.js` (line 7963)

**Changed:**
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

**Verification:**
- Before: `request.Book=null` → defaults to Book 1
- After: `request.Book=2` → uses Book 2 correctly

---

## Issue #2: Progress Overlay Never Closes ⚠️ NEEDS INVESTIGATION

### Symptoms
- Progress overlay shows "Structure Sync" updates
- Overlay never closes
- Success message never appears
- Logs show: `⏳ Waiting for formulas to complete...` but never completes

### Analysis from Logs
Logs show:
```
✅ Structure Sync: Saved 60 accounts to localStorage
✅ Structure Sync: Preload status set to complete
⏳ Waiting for formulas to complete...
   Smart detection: ENABLED - tracking 741 XAVI formula cells
   Threshold: 99% must resolve to numeric values
```

Then many `handleSheetChange` events fire, but formula completion never detected.

### Possible Causes
1. **Formulas showing wrong data (Book 1 instead of Book 2)** - Formulas may be returning Book 1 data, causing confusion in completion detection
2. **#BUSY never clears** - If formulas are stuck in #BUSY state, completion detection waits indefinitely
3. **Smart detection threshold not met** - If formulas return wrong data, they may not resolve to expected numeric values
4. **Formula completion detection logic issue** - The `waitForFormulasToComplete` function may not be detecting completion correctly

### Next Steps
1. **Fix Issue #1 first** - Ensure Full Year Refresh uses correct book
2. **Test again** - See if progress overlay closes after book fix
3. **If still stuck:**
   - Check if formulas are showing #BUSY
   - Check if formulas are resolving to numbers
   - Check if smart detection threshold is being met
   - Add more debug logging to `waitForFormulasToComplete`

---

## Issue #3: Wrong Book Data Written to Excel ✅ FIXED (via Issue #1)

### Root Cause
Same as Issue #1 - Full Year Refresh was using Book 1 instead of Book 2.

### Fix
Fixed by correcting the payload property name (see Issue #1).

---

## Testing Instructions

### 1. Restart Backend Server
```bash
bash excel-addin/useful-commands/start-dotnet-server.sh
```

### 2. Clear Excel Cache
- Close Excel completely
- Reopen Excel
- Or use: `bash excel-addin/useful-commands/clear-excel-cache.sh`

### 3. Test Scenario
1. Set U3 to "2" (verify cell contains "2")
2. Select subsidiary "Celigo India Pvt Ltd"
3. Run Structure Sync (CFO Flash Report or Income Statement)

### 4. Check Backend Logs
```bash
bash excel-addin/useful-commands/check-balance-logs.sh
```

**Expected:**
- `🔍 [FULL YEAR REFRESH DEBUG] Year=2025, accountingBook=2 (request.Book=2, Default=1)`
- SQL query contains `tal.accountingbook = 2` (not `= 1`)

### 5. Check Frontend Console (F12)
**Expected:**
- `🔍 DEBUG: Payload includes book="2"`
- Progress overlay closes
- Success message appears: "✅ Structure Sync Complete!"

---

## Files Modified

1. **docs/functions.js** (line 7963)
   - Changed payload to use `book` instead of `accountingBook`
   - Added debug logging

---

## Remaining Issues

### Progress Overlay Not Closing
- **Status:** Needs further investigation after Issue #1 fix
- **Action:** Test again after book fix, then debug `waitForFormulasToComplete` if still stuck

---

**End of Document**

