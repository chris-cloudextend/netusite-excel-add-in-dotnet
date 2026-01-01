# Income Statement Period Range Optimization Plan

## Problem
`XAVI.BALANCE("4220", "Jan 2012", "Jan 2025")` takes too long because it processes periods in chunks of 3, making 33+ separate API calls instead of a single query.

## Root Cause Analysis

### Current Flow for "Jan 2012" to "Jan 2025" (156 months)

1. **Frontend (line 8438)**: Expands period range into individual months
   - "Jan 2012" to "Jan 2025" → 156 individual period strings
   - Log: `📅 Expanding Jan 2012 to Jan 2025 → 156 months`

2. **Frontend (line 8503-8505)**: Chunks periods by `MAX_PERIODS_PER_BATCH = 3`
   - 156 periods ÷ 3 = 52 chunks
   - Log: `Split into 1 account chunk(s) × 52 period chunk(s) = 52 total batches`

3. **Frontend (line 8606-8618)**: Makes separate API call for each chunk
   - Chunk 1: `/batch/balance` with periods: ["Jan 2012", "Feb 2012", "Mar 2012"]
   - Chunk 2: `/batch/balance` with periods: ["Apr 2012", "May 2012", "Jun 2012"]
   - ... (52 total API calls)
   - Each call takes 1-3 seconds + 300ms delay = ~2-3 seconds per chunk
   - Total time: 52 chunks × 2.5s = **130+ seconds**

4. **Backend (line 1200-1229)**: Processes each chunk with query:
   ```sql
   SELECT a.acctnumber, ap.periodname, SUM(...) as balance
   FROM transactionaccountingline tal
   JOIN accountingperiod ap ON ap.id = t.postingperiod
   WHERE ...
     AND ap.periodname IN ('Jan 2012', 'Feb 2012', 'Mar 2012')
   GROUP BY a.acctnumber, ap.periodname
   ```
   - This is efficient for small chunks, but requires 52 separate queries

## Current Query (Per Chunk)

**Backend Query (line 1200-1229):**
```sql
SELECT 
    a.acctnumber,
    ap.periodname,
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
JOIN accountingperiod ap ON ap.id = t.postingperiod
JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
WHERE t.posting = 'T'
  AND tal.posting = 'T'
  AND {plAccountFilter}
  AND ap.periodname IN ('Jan 2012', 'Feb 2012', 'Mar 2012')  -- Only 3 periods per chunk
  AND a.accttype IN ({AccountType.PlTypesSql})
  AND tal.accountingbook = {accountingBook}
  AND {segmentWhere}
GROUP BY a.acctnumber, ap.periodname
```

**Problem:** This query is called 52 times (once per chunk), each with only 3 periods.

## Proposed Solution: Single Query for Period Range

### Option 1: Use Date Range Instead of Period List (Recommended)

**New Backend Query:**
```sql
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
JOIN accountingperiod ap ON ap.id = t.postingperiod
JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
WHERE t.posting = 'T'
  AND tal.posting = 'T'
  AND {plAccountFilter}
  AND ap.startdate >= TO_DATE('{fromStartDate}', 'YYYY-MM-DD')  -- Date range instead of period list
  AND ap.enddate <= TO_DATE('{toEndDate}', 'YYYY-MM-DD')
  AND a.accttype IN ({AccountType.PlTypesSql})
  AND tal.accountingbook = {accountingBook}
  AND {segmentWhere}
GROUP BY a.acctnumber  -- No GROUP BY periodname - we want total sum
```

**Key Changes:**
1. Use date range (`ap.startdate >= fromStartDate AND ap.enddate <= toEndDate`) instead of period list
2. Remove `ap.periodname` from SELECT and GROUP BY (we want total sum, not per-period breakdown)
3. Single query for entire range instead of 52 queries

### Option 2: Detect Period Range and Send Range to Backend

**Frontend Changes:**
- When all requests in a group have the same period range (fromPeriod → toPeriod)
- Instead of expanding to individual periods, send the range to backend
- Backend receives: `{ fromPeriod: "Jan 2012", toPeriod: "Jan 2025" }` instead of `{ periods: ["Jan 2012", "Feb 2012", ...] }`

**Backend Changes:**
- Add new endpoint or parameter: `/batch/balance/range` or add `from_period`/`to_period` to existing endpoint
- Use date range query (same as Option 1)

## Performance Impact

**Current (Broken):**
- 52 API calls × 2.5s = **130+ seconds**
- Each call queries 3 periods

**Fixed (Single Query):**
- 1 API call × 3-5s = **3-5 seconds**
- Single query sums all 156 periods at once

**Expected Speedup:** ~25-40x faster

## Implementation Plan

### Phase 1: Backend Support for Period Range
1. Add `from_period` and `to_period` parameters to `/batch/balance endpoint
2. When `from_period` and `to_period` are provided (and `periods` array is empty), use date range query
3. Query uses `ap.startdate >= fromStartDate AND ap.enddate <= toEndDate`
4. Return single total (not per-period breakdown)

### Phase 2: Frontend Optimization
1. Detect when all requests in a group have the same period range
2. Instead of expanding periods, send `from_period` and `to_period` to backend
3. Skip chunking logic for period ranges (only chunk accounts if needed)

## Code Locations

**Frontend:**
- `docs/functions.js` line 8414-8462: Period expansion logic
- `docs/functions.js` line 8502-8505: Period chunking logic
- `docs/functions.js` line 8606-8618: API call with periods array

**Backend:**
- `backend-dotnet/Controllers/BalanceController.cs` line 539: `/batch/balance` endpoint
- `backend-dotnet/Services/BalanceService.cs` line 1072: `GetBatchBalanceAsync` method
- `backend-dotnet/Services/BalanceService.cs` line 1194-1262: P&L batch query (needs modification)

---
**Analysis Date:** December 31, 2025
