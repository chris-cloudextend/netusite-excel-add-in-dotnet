# Budget Report Test Checklist

## Test to Run

1. **Open Excel task pane**
2. **Go to Quick Start section**
3. **Click "Budget Comparison" or "Load Budget Report"**
4. **Select a year** (e.g., 2025 or 2011)
5. **Click the button to generate the report**

## What I'll Check in Backend Logs

### ✅ Expected Logs (Correct Behavior)

1. **Period Resolution:**
   ```
   GetPeriodsForYearAsync: Executing query for year 2025
   GetPeriodsForYearAsync: Successfully deserialized 12 periods
   ```

2. **Budget Query Using Period IDs:**
   ```
   bm.period IN (344, 345, 346, ..., 355)
   ```
   Should NOT see:
   - `EXTRACT(YEAR FROM startdate) = 2025` in budget queries
   - `ExpandYearToPeriods` being called
   - Date-based period filtering

3. **Budget Endpoint Calls:**
   ```
   GET /budget?account=...&fromPeriod=...&toPeriod=...
   ```
   or
   ```
   POST /budget/batch
   ```

4. **Period ID Usage:**
   - Should see `bm.period IN (periodId1, periodId2, ...)` in queries
   - Should NOT see date ranges like `ap.startdate >= TO_DATE(...)`

### ❌ Red Flags (Incorrect Behavior)

- `ExpandYearToPeriods` being called
- `EXTRACT(YEAR FROM startdate)` in budget queries
- Date-based period filtering in budget queries
- Period names used instead of period IDs in `bm.period` filter

---

## After You Run It

Just let me know when you've run the budget report, and I'll check the logs to verify:
1. Period resolution is using `GetPeriodsForYearAsync`
2. Budget queries are using `bm.period IN (periodIds)`
3. No calendar inference or date-based filtering

