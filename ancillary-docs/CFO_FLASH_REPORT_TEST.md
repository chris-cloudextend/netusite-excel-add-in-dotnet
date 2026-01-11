# CFO Flash Report & Income Statement Test Checklist

## CFO Flash Report - What I'll Verify

### Expected Behavior (Correct)

1. **Period Resolution:**
   - Should use `GetPeriodsForYearAsync` for year-only inputs
   - Should use `GetPeriodAsync` for individual periods
   - Should use `GetPeriodIdsInRangeAsync` for period ranges

2. **TYPEBALANCE Queries:**
   - Should use `t.postingperiod IN (periodIds)` for period ranges
   - Should use `t.postingperiod <= periodId` for point-in-time
   - Should NOT use `EXTRACT(YEAR FROM startdate)` in financial queries
   - Should NOT use `ap.startdate` or `ap.enddate` for financial filtering

3. **Endpoint Calls:**
   - `/typebalance` or `/typebalance/batch` endpoints
   - Period IDs used in queries

### Red Flags (Incorrect)

- `EXTRACT(YEAR FROM startdate)` in TYPEBALANCE queries
- `ap.startdate >= TO_DATE(...)` in financial queries
- Date-based period filtering
- `ExpandYearToPeriods` being called

---

## Income Statement - What I'll Verify

### Expected Behavior (Correct)

1. **Full Year Refresh:**
   - Should use `GetPeriodsForYearAsync` for period retrieval
   - Should use `t.postingperiod IN (periodIds)` in queries
   - Should use `FyStartPeriodId` for fiscal year start (not date-based)

2. **Period Resolution:**
   - All periods resolved using shared resolvers
   - Period IDs used consistently

3. **Special Formulas (if calculated):**
   - Retained Earnings: Uses `FyStartPeriodId` (period-based)
   - Net Income: Uses period IDs (not dates)
   - CTA: Uses `FyStartPeriodId` (period-based)

### Red Flags (Incorrect)

- `EXTRACT(YEAR FROM startdate)` in FullYearRefresh
- Date-based fiscal year start lookups
- `t.trandate` used for financial scoping
- Calendar inference for fiscal years

---

## Ready to Monitor

I'm ready! When you run:
1. **CFO Flash Report** - I'll check TYPEBALANCE queries
2. **Income Statement** - I'll check FullYearRefresh and period resolution

Just let me know when you've run each one!

