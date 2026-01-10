# Accounting Period ID Fix - Detailed Implementation Plan

## 🎯 Goal
Ensure that monthly queries and full-year/batched queries use the exact same AccountingPeriod internal IDs, so results are numerically identical regardless of batching.

## ✅ Completed (Step 0-3A Partial)

### Step 0: Restore Branch
- ✅ Created `restore/accounting-periods-pre-fix` branch
- ✅ Created working branch `fix/accounting-period-ids`

### Step 3A: Period Resolution (Partial)
- ✅ Updated `GetPeriodAsync()` to reject year-only inputs (returns null)
- ✅ Added `GetPeriodsForYearAsync(int year)` - queries all 12 months for a year
- ✅ Added `GetPeriodsForYearAsync(string yearString)` - wrapper for string inputs
- ✅ Added `GetPeriodIdsInRangeAsync()` - helper to get period IDs in a range
- ✅ Updated interface `INetSuiteService` with new methods

### Step 3B: Main Balance Queries (Partial)
- ✅ **Point-in-time queries**: Changed from `t.trandate <= TO_DATE(...)` to `t.postingperiod <= toPeriodId`
- ✅ **BS period activity**: Changed from `ap.startdate >= ... AND ap.enddate <= ...` to `t.postingperiod IN (periodId1, periodId2, ...)`
- ✅ **P&L period activity**: Changed from two cumulative queries to single `t.postingperiod IN (...)` query

---

## 📋 Remaining Work

### 1. Fix Year-Only Input Handling Throughout Codebase

**Files to Update:**
- `backend-dotnet/Services/BalanceService.cs`
- `backend-dotnet/Services/BalanceService.cs` (TypeBalanceAsync)
- `backend-dotnet/Controllers/BalanceController.cs` (if any)

**Current Issue:**
Multiple places use `NetSuiteService.ExpandYearToPeriods()` which creates synthetic "Jan YYYY" to "Dec YYYY" strings. These need to be replaced with actual period lookups.

**Changes Needed:**

#### 1.1 BalanceAsync (Line ~142)
```csharp
// CURRENT:
if (NetSuiteService.IsYearOnly(fromPeriod))
{
    var (from, to) = NetSuiteService.ExpandYearToPeriods(fromPeriod);
    fromPeriod = from;
    toPeriod = to;
}

// NEW:
if (NetSuiteService.IsYearOnly(fromPeriod))
{
    // For year-only, we need to get actual period IDs
    // But this is complex - year-only inputs should be handled differently
    // Option A: Reject year-only in single balance queries (require explicit periods)
    // Option B: Get all 12 months and use period ID range
    // RECOMMENDATION: Option B - get periods and use ID-based filtering
    var yearPeriods = await _netSuiteService.GetPeriodsForYearAsync(fromPeriod);
    if (yearPeriods.Count == 12)
    {
        fromPeriod = yearPeriods.First().PeriodName;
        toPeriod = yearPeriods.Last().PeriodName;
    }
    else
    {
        return new BalanceResponse { Error = "Could not resolve year periods" };
    }
}
```

#### 1.2 BalanceBetaAsync (Line ~720)
Same pattern as above.

#### 1.3 GetBatchBalanceAsync (Line ~1141)
```csharp
// CURRENT:
if (NetSuiteService.IsYearOnly(p))
{
    var (from, to) = NetSuiteService.ExpandYearToPeriods(p);
    // expands to individual months
}

// NEW:
if (NetSuiteService.IsYearOnly(p))
{
    var yearPeriods = await _netSuiteService.GetPeriodsForYearAsync(p);
    foreach (var period in yearPeriods)
    {
        expandedPeriods.Add(period.PeriodName);
    }
}
```

#### 1.4 GetTypeBalanceAsync (Line ~1700)
Same pattern as 1.1.

---

### 2. Fix Batch Balance Queries (GetBatchBalanceAsync)

**File:** `backend-dotnet/Services/BalanceService.cs` (Line ~1433)

**Current Issues:**
- Period list queries use `ap.periodname IN (...)` instead of `t.postingperiod IN (periodId1, ...)`
- Period range queries use date-based filtering instead of period IDs

**Changes Needed:**

#### 2.1 Period List Queries (Line ~1437)
```csharp
// CURRENT:
var periodsIn = string.Join(", ", expandedPeriods.Select(p => $"'{NetSuiteService.EscapeSql(p)}'"));
plQuery = $@"
    ...
    AND ap.periodname IN ({periodsIn})
    ...
";

// NEW:
// Get period IDs for all expanded periods
var periodIds = new List<string>();
foreach (var periodName in expandedPeriods)
{
    var periodData = await _netSuiteService.GetPeriodAsync(periodName);
    if (periodData?.Id != null)
        periodIds.Add(periodData.Id);
}
var periodIdList = string.Join(", ", periodIds);
plQuery = $@"
    ...
    AND t.postingperiod IN ({periodIdList})
    ...
    // Remove: JOIN accountingperiod ap ON ap.id = t.postingperiod (if only used for filtering)
";
```

#### 2.2 Period Range Queries (Line ~1331)
```csharp
// CURRENT:
plQuery = BuildPeriodRangeQuery(plAccountFilter, fromStartDate!, toEndDate!, targetSub, signFlip, accountingBook, segmentWhere);
// This uses: ap.startdate >= ... AND ap.enddate <= ...

// NEW:
var periodIdsInRange = await GetPeriodIdsInRangeAsync(fromPeriodForRange, toPeriodForRange);
var periodIdList = string.Join(", ", periodIdsInRange);
plQuery = BuildPeriodRangeQueryByIds(plAccountFilter, periodIdList, targetSub, signFlip, accountingBook, segmentWhere);
// New helper: BuildPeriodRangeQueryByIds uses t.postingperiod IN (...)
```

**New Helper Method Needed:**
```csharp
private string BuildPeriodRangeQueryByIds(
    string accountFilter, 
    string periodIdList, 
    string targetSub, 
    string signFlip, 
    int accountingBook, 
    string segmentWhere)
{
    return $@"
        SELECT 
            a.acctnumber,
            SUM(
                TO_NUMBER(
                    BUILTIN.CONSOLIDATE(
                        tal.amount,
                        'LEDGER',
                        'DEFAULT',
                        'DEFAULT',
                        {targetSub},
                        t.postingperiod,
                        'DEFAULT'
                    )
                ) * {signFlip}
            ) as balance
        FROM transactionaccountingline tal
        JOIN transaction t ON t.id = tal.transaction
        JOIN account a ON a.id = tal.account
        JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
        WHERE t.posting = 'T'
          AND tal.posting = 'T'
          AND {accountFilter}
          AND t.postingperiod IN ({periodIdList})
          AND a.accttype IN ({AccountType.PlTypesSql})
          AND tal.accountingbook = {accountingBook}
          AND {segmentWhere}
        GROUP BY a.acctnumber";
}
```

---

### 3. Fix Full-Year Queries (GetFullYearBalancesAsync)

**File:** `backend-dotnet/Services/BalanceService.cs` (Line ~2582)

**Current Issue:**
Uses `EXTRACT(YEAR FROM startdate) = {year}` which may not match the exact periods selected month-by-month.

**Changes Needed:**

```csharp
// CURRENT:
var periodsQuery = $@"
    SELECT id, periodname, startdate, enddate
    FROM accountingperiod
    WHERE isyear = 'F' AND isquarter = 'F'
      AND EXTRACT(YEAR FROM startdate) = {year}
      AND isadjust = 'F'
    ORDER BY startdate";

// NEW:
// Use GetPeriodsForYearAsync which ensures we get the exact same periods
// that would be selected if user entered all 12 months individually
var periods = await _netSuiteService.GetPeriodsForYearAsync(year);
if (periods.Count != 12)
{
    _logger.LogWarning("Expected 12 periods for year {Year}, got {Count}", year, periods.Count);
    return null;
}

// Rest of the query remains the same (already uses period IDs correctly)
// The query already filters by t.postingperiod IN ({periodFilter})
// where periodFilter is built from period IDs
```

---

### 4. Fix Year Splitting Logic (GenerateYearRangesAsync + GetFullYearBalancesAsync)

**File:** `backend-dotnet/Services/BalanceService.cs` (Line ~2514, ~1355)

**Current Issue:**
`GenerateYearRangesAsync` creates synthetic period name ranges. When these are used with `GetFullYearBalancesAsync`, we need to ensure the period IDs match.

**Changes Needed:**

#### 4.1 GenerateYearRangesAsync
This method is used to split multi-year ranges. It currently creates period name tuples like ("Jan 2023", "Dec 2023"). This is OK for determining year boundaries, but we need to ensure the actual period IDs are used in queries.

**No change needed** - this method is only used to determine year boundaries. The actual period ID resolution happens in `GetFullYearBalancesAsync`.

#### 4.2 Year Splitting in GetBatchBalanceAsync (Line ~1355)
```csharp
// CURRENT:
var yearResult = await GetFullYearBalancesAsync(year, plAccounts, targetSub, accountingBook, segmentWhere);
// Then extracts months based on period names

// NEW:
// GetFullYearBalancesAsync already uses GetPeriodsForYearAsync internally (after our fix)
// So it will return the exact same period IDs
// The extraction logic should work correctly
// BUT: Need to verify that period name matching is correct
```

**Verification Needed:**
- Ensure `GetFullYearBalancesAsync` returns periods with correct period names
- Ensure the extraction logic matches period names correctly

---

### 5. Fix Period Activity Breakdown (GetPeriodActivityBreakdownAsync)

**File:** `backend-dotnet/Services/BalanceService.cs` (Line ~2300+)

**Current Issue:**
Uses `ap.id IN ({periodIdList})` which is correct, but need to verify period ID resolution.

**Changes Needed:**
- Verify that `GetPeriodIdsInRangeAsync` is used correctly
- Ensure period IDs are resolved from period names correctly

**Status:** Likely already correct, but needs verification.

---

### 6. Fix Type Balance Queries (GetTypeBalanceAsync)

**File:** `backend-dotnet/Services/BalanceService.cs` (Line ~1687)

**Current Issue:**
Uses date-based filtering for P&L accounts.

**Changes Needed:**

#### 6.1 P&L Type Balance (Line ~1835)
```csharp
// CURRENT:
// Uses date-based queries similar to main balance queries

// NEW:
// For period activity: Use GetPeriodIdsInRangeAsync and filter by t.postingperiod IN (...)
// For point-in-time: Use t.postingperiod <= toPeriodId
```

---

### 7. Fix Opening Balance Queries

**File:** `backend-dotnet/Services/BalanceService.cs` (GetOpeningBalanceAsync)

**Current Issue:**
Uses `t.trandate <= TO_DATE(...)` for point-in-time balances.

**Changes Needed:**
- Change to `t.postingperiod <= anchorPeriodId`
- Ensure anchor period ID is resolved correctly

---

### 8. Remove Date-Based Period Filtering

**Search for and replace:**
- `ap.startdate >= TO_DATE(...)` → Use period IDs
- `ap.enddate <= TO_DATE(...)` → Use period IDs
- `EXTRACT(YEAR FROM startdate)` → Use `GetPeriodsForYearAsync`
- `t.trandate <= TO_DATE(...)` → Use `t.postingperiod <= periodId` (for point-in-time)

**Exception:** 
- `t.trandate` may still be needed for some edge cases, but should be minimized
- Date-based filtering in `GetPeriodIdsInRangeAsync` is OK (it's used to find periods, not filter transactions)

---

## 🧪 Testing Requirements

### Unit Tests Needed:
1. **Period Resolution:**
   - `GetPeriodsForYearAsync(2025)` returns exactly 12 periods
   - `GetPeriodsForYearAsync("2025")` returns same 12 periods
   - `GetPeriodIdsInRangeAsync("Jan 2023", "Dec 2025")` returns all period IDs in range

2. **Query Consistency:**
   - Single month query vs. full year query (same account) → same period IDs used
   - Month-by-month sum vs. full year batch → identical results

3. **Edge Cases:**
   - Year with 13 periods (adjustment periods)
   - Fiscal year vs. calendar year
   - Periods spanning year boundaries

### Integration Tests Needed:
1. **Numerical Consistency:**
   - `SUM(Jan-Dec monthly results) == full-year batch result` for same account
   - Balance Sheet continuity: `Prior period balance + activity == next period balance`
   - Retained earnings and net income unchanged when switching batching modes

2. **Performance:**
   - Period ID-based queries should be at least as fast as date-based queries
   - Full-year queries should use same period IDs as individual months

---

## ⚠️ Risks and Considerations

### Risk 1: Period ID Resolution Failures
**Impact:** Queries may fail if period IDs cannot be resolved
**Mitigation:** 
- Add comprehensive error handling
- Fallback to date-based filtering with warning (if absolutely necessary)
- Log all period ID resolution failures

### Risk 2: Performance Degradation
**Impact:** Period ID lookups may add overhead
**Mitigation:**
- Cache period lookups aggressively (already done in `GetPeriodAsync`)
- Batch period ID lookups where possible
- Monitor query performance

### Risk 3: Fiscal Year vs. Calendar Year
**Impact:** `GetPeriodsForYearAsync` uses `EXTRACT(YEAR FROM startdate)` which may not match fiscal year
**Mitigation:**
- Verify that NetSuite periods align with calendar years
- If not, may need fiscal year handling

### Risk 4: Adjustment Periods
**Impact:** Some years may have 13 periods (including adjustment periods)
**Mitigation:**
- Filter out adjustment periods: `AND isadjust = 'F'` (already done)
- Verify 12-month assumption holds

### Risk 5: Backward Compatibility
**Impact:** Year-only inputs may behave differently
**Mitigation:**
- Document the change
- Ensure year-only inputs still work (just use actual period IDs)

---

## 📝 Implementation Order

1. **Phase 1: Year-Only Input Handling** (Sections 1.1-1.4)
   - Fix all places that expand year-only inputs
   - Ensure they use `GetPeriodsForYearAsync`

2. **Phase 2: Batch Balance Queries** (Section 2)
   - Fix period list queries
   - Fix period range queries
   - Add `BuildPeriodRangeQueryByIds` helper

3. **Phase 3: Full-Year Queries** (Section 3)
   - Fix `GetFullYearBalancesAsync` to use `GetPeriodsForYearAsync`

4. **Phase 4: Type Balance Queries** (Section 6)
   - Fix P&L type balance queries

5. **Phase 5: Opening Balance Queries** (Section 7)
   - Fix opening balance queries

6. **Phase 6: Verification** (Section 5)
   - Verify period activity breakdown
   - Verify year splitting logic

7. **Phase 7: Cleanup** (Section 8)
   - Remove remaining date-based period filtering
   - Remove unused date-based query builders

---

## ✅ Definition of Done

- [ ] All year-only inputs use `GetPeriodsForYearAsync`
- [ ] All period filtering uses `t.postingperiod IN (periodId1, ...)` or `t.postingperiod <= periodId`
- [ ] No queries use `ap.periodname IN (...)` for filtering
- [ ] No queries use `EXTRACT(YEAR FROM startdate)` for period selection
- [ ] Full-year queries use same period IDs as individual months
- [ ] Monthly and full-year calculations return identical results
- [ ] All tests pass
- [ ] Performance is maintained or improved
- [ ] Restore branch remains untouched

---

## 📌 Notes

- The `GetPeriodIdsInRangeAsync` helper uses date-based queries to find periods, which is acceptable since it's used to resolve period IDs, not filter transactions.
- Some date-based filtering may still be needed for edge cases (e.g., finding periods), but transaction filtering must use period IDs.
- The `BUILTIN.CONSOLIDATE` function still uses period IDs correctly (already implemented).

