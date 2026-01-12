# Retained Earnings and CTA Fix - Research Summary

## Problem
Retained Earnings and CTA formulas stopped working, returning `#VALUE` with error: "Could not find period for fiscal year start: 2025-01-01"

## Root Cause
The `GetFiscalYearInfoAsync` method uses `FETCH FIRST 1 ROWS ONLY` syntax which NetSuite is now rejecting with:
```
syntax error, state:0(10102) near: FETCH(9,17, token code:0)
```

This causes `fyStartPeriodId` to be `null`, which breaks Retained Earnings and CTA calculations.

## What Changed: 4 Weeks Ago vs Now

### 4 Weeks Ago (Dec 20, 2025 - commit 4f8855a)
- `GetFiscalYearInfoAsync` used `FETCH FIRST 1 ROWS ONLY` **without** `ORDER BY`
- It worked correctly
- Did NOT have the second query to get `FyStartPeriodId`
- Retained Earnings used **date-based filtering**: `ap.enddate < TO_DATE('{fyStartDate}', 'YYYY-MM-DD')`

### Jan 2, 2026 (commit 097acb8 - "Eliminate calendar-based period logic")
- **Added** `FyStartPeriodId` property to `FiscalYearInfo`
- **Added** second query to get the first period of the fiscal year
- Changed Retained Earnings to use **period-based filtering**: `t.postingperiod < {fyStartPeriodId}`
- Second query used `FETCH FIRST 1 ROWS ONLY` with `ORDER BY startdate`

### Jan 6, 2026 (commit 99b4d4a)
- Changed `LIMIT 1` to `FETCH FIRST 1 ROWS ONLY` in the first query
- **Added** `ORDER BY tp.id` to the first query

### Jan 8, 2026 (commit 79e961d)
- Changed `LIMIT 1` back to `FETCH FIRST 1 ROWS ONLY` in the second query

## The Issue
When `ORDER BY` was added to queries using `FETCH FIRST 1 ROWS ONLY`, NetSuite started rejecting the syntax. The old code worked because it didn't have `ORDER BY`.

## The Fix
Replace `FETCH FIRST 1 ROWS ONLY` with `OFFSET 0 ROWS FETCH NEXT 1 ROWS ONLY` in both queries in `GetFiscalYearInfoAsync`. This matches the pagination pattern used elsewhere in the codebase (e.g., `NetSuiteService.QueryPaginatedAsync`).

## Files Changed
- `backend-dotnet/Controllers/SpecialFormulaController.cs`
  - Line ~656: Main fiscal year query
  - Line ~689: First period of fiscal year query
