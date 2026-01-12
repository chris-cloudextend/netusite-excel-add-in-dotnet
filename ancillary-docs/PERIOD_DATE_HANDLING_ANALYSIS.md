# Period Date Handling Analysis

## Question

If a formula refers to a date like "5/1/2025", does the system:
1. Use the end of month (5/31/2025) ✅ **CORRECT** - This is what we do
2. Use the exact date (5/1/2025) ❌ **INCORRECT**

## Current Implementation Flow

### Frontend (Excel → Backend)

1. **User Input:** User enters date "5/1/2025" in Excel cell
2. **normalizePeriodKey()** (`docs/functions.js:5226-5397`):
   - Parses date string: `new Date("5/1/2025")` → JavaScript Date object
   - Extracts month and year: `date.getMonth()` = 4 (May), `date.getFullYear()` = 2025
   - Converts to period format: **"May 2025"**
   - Returns: `"May 2025"` (not the specific day)

### Backend (Period Name → NetSuite Query)

1. **GetPeriodAsync()** (`backend-dotnet/Services/NetSuiteService.cs:565-624`):
   - Receives: `"May 2025"`
   - Queries NetSuite: `SELECT id, periodname, startdate, enddate FROM AccountingPeriod WHERE periodname = 'May 2025'`
   - NetSuite returns:
     - `startdate`: `"5/1/2025"` (first day of May)
     - `enddate`: `"5/31/2025"` (last day of May)
     - `id`: `"349"` (period ID)

2. **BalanceService.GetBalanceAsync()** (`backend-dotnet/Services/BalanceService.cs:220`):
   - Uses: `toPeriodData.EndDate` ✅ **CORRECT**
   - Converts: `ConvertToYYYYMMDD(toPeriodData.EndDate)` → `"2025-05-31"`
   - Query filter: `t.trandate <= TO_DATE('2025-05-31', 'YYYY-MM-DD')` ✅ **CORRECT**

## Verification

### Code Evidence

**Frontend Date Conversion:**
```javascript
// docs/functions.js:5372-5388
date = new Date(value);  // "5/1/2025" → Date object
const month = monthNames[date.getMonth()];  // Gets month name (May)
const year = date.getFullYear();  // Gets year (2025)
const normalized = `${month} ${year}`;  // Returns "May 2025"
```

**Backend Period Lookup:**
```csharp
// backend-dotnet/Services/NetSuiteService.cs:615-616
StartDate = row.TryGetProperty("startdate", out var sdProp) ? sdProp.GetString() : null,
EndDate = row.TryGetProperty("enddate", out var edProp) ? edProp.GetString() : null,
```

**Backend Date Usage:**
```csharp
// backend-dotnet/Services/BalanceService.cs:220
var toEndDate = ConvertToYYYYMMDD(toPeriodData.EndDate);  // Uses END date ✅

// Query filter:
AND t.trandate <= TO_DATE('{toEndDate}', 'YYYY-MM-DD')  // Uses end of month ✅
```

## Answer

✅ **YES, we are using the end of month correctly.**

When a user enters "5/1/2025":
1. Frontend converts it to period name: **"May 2025"**
2. Backend looks up the period in NetSuite's AccountingPeriod table
3. NetSuite returns `enddate = "5/31/2025"` (end of May)
4. Backend uses `EndDate` (5/31/2025) for cumulative Balance Sheet queries

This matches NetSuite's behavior where selecting "May 2025" in a period dropdown means "end of May" for cumulative balances.

## Potential Issue

However, there's a potential edge case:

**If a user directly passes a date string like "5/1/2025" to the backend** (bypassing the frontend normalization), the backend's `GetPeriodAsync()` might not find a period with that exact name, and the query could fail.

**Current Protection:**
- The frontend `normalizePeriodKey()` function always converts dates to "Mon YYYY" format before sending to backend
- The backend expects period names like "May 2025", not date strings like "5/1/2025"

## Recommendation

The current implementation is **correct** - we always use the period's `EndDate` (end of month) for cumulative Balance Sheet queries, which matches NetSuite's behavior.

**No changes needed** - the system correctly interprets any date in May as "end of May" for cumulative balance calculations.

