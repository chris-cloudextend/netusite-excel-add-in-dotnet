# Single Period Timeout Analysis

## Problem
When `fromPeriod === toPeriod` for income statement accounts (e.g., "Jan 2025" to "Jan 2025"), the query times out after 125+ seconds.

## Root Cause

### Current Logic (Line 168-169 in BalanceService.cs)
```csharp
bool isPointInTime = !hasFromPeriod && hasToPeriod;
bool isPeriodActivity = hasFromPeriod && hasToPeriod;
```

**Issue:** When `fromPeriod === toPeriod`, `isPeriodActivity` is still `true` because both periods are provided.

### What Happens for P&L Period Activity (Line 476-578)

For P&L accounts with period activity, the code does:
1. **Balance(toPeriod)** - Cumulative query scanning ALL history up to toPeriod
   - Query: `t.trandate <= TO_DATE('{toEndDate}', 'YYYY-MM-DD')`
   - Scans all transactions from inception through toPeriod
   
2. **Balance(before fromPeriod)** - Cumulative query scanning ALL history up to day before fromPeriod
   - Query: `t.trandate <= TO_DATE('{beforeFromPeriodEndDate}', 'YYYY-MM-DD')`
   - Scans all transactions from inception through the day before fromPeriod starts
   
3. **Result = Balance(toPeriod) - Balance(before fromPeriod)**

### Why This Times Out

When `fromPeriod === toPeriod`:
- Both queries scan **all historical transactions** (potentially 13+ years)
- The "before fromPeriod" date is just one day before the period starts
- So it's doing two full cumulative scans for essentially the same period
- This is extremely inefficient and causes timeouts

### Example for "Jan 2025" to "Jan 2025"
- Query 1: Scan all transactions from inception through Jan 31, 2025
- Query 2: Scan all transactions from inception through Dec 31, 2024
- Result: Subtract Query 2 from Query 1

**This is wrong!** It should just query transactions posted in Jan 2025 directly.

## Solution

### Option 1: Detect Single Period Early (Recommended)
Add a check before the period activity logic:

```csharp
bool isPeriodActivity = hasFromPeriod && hasToPeriod && fromPeriod != toPeriod;
```

Then add a special case for single period:

```csharp
if (hasFromPeriod && hasToPeriod && fromPeriod == toPeriod)
{
    // Single period query - use accounting period filter directly
    // Similar to TypeBalance query (line 1555-1558)
    query = $@"
        SELECT SUM(...) AS balance
        FROM transactionaccountingline tal
        JOIN transaction t ON t.id = tal.transaction
        JOIN account a ON a.id = tal.account
        JOIN accountingperiod ap ON ap.id = t.postingperiod
        WHERE ...
          AND ap.startdate >= TO_DATE('{fromStartDate}', 'YYYY-MM-DD')
          AND ap.enddate <= TO_DATE('{toEndDate}', 'YYYY-MM-DD')
          ...";
}
```

### Option 2: Use Range Query for Single Period
When `fromPeriod === toPeriod`, use the same range-bounded query approach as Balance Sheet accounts (line 406-433), but for P&L accounts.

## Performance Impact

**Current (Broken):**
- Two cumulative queries scanning all history
- Timeout after 125+ seconds

**Fixed (Single Period Query):**
- One indexed query scanning just that period
- Expected time: < 5 seconds (similar to year endpoint performance)

## Code Location

- **File:** `backend-dotnet/Services/BalanceService.cs`
- **Line 168-169:** Period activity detection
- **Line 476-578:** P&L period activity calculation (needs fix)

---
**Analysis Date:** December 31, 2025
