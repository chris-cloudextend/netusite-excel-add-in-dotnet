# Period Activity Query Timeout Analysis

## Date: 2025-01-02
## Issue: 524 Timeout on period activity query `BALANCE(10010, "Jan 2025", "Feb 2025")`

---

## WHAT'S HAPPENING IN THE BACKGROUND

### Current Implementation Flow

When you call `=XAVI.BALANCE($C2,H$1,I$1)` where:
- C2 = 10010
- H1 = 1/1/25 (fromPeriod = "Jan 2025")
- I1 = 2/1/25 (toPeriod = "Feb 2025")

**The backend performs:**

1. **Detects Period Activity Query** (both fromPeriod and toPeriod provided)
2. **Runs TWO Full Cumulative Queries:**
   - **Query 1:** `Balance as of Feb 2025` (cumulative from inception)
     - Scans ALL transactions from beginning of time through Feb 2025
     - Uses `BUILTIN.CONSOLIDATE` at Feb 2025's exchange rate
     - SQL: `WHERE t.trandate <= '2025-02-28'`
   
   - **Query 2:** `Balance as of Dec 31, 2024` (before Jan 2025)
     - Scans ALL transactions from beginning of time through Dec 31, 2024
     - Uses `BUILTIN.CONSOLIDATE` at Feb 2025's exchange rate (same as Query 1)
     - SQL: `WHERE t.trandate <= '2024-12-31'`
   
3. **Calculates Activity:** `Query1 - Query2`

**Code Reference:**
```csharp
// backend-dotnet/Services/BalanceService.cs:307-456
else if (isPeriodActivity)
{
    queryTimeout = 180; // May need two cumulative queries
    
    // Query for balance as of toPeriod (cumulative)
    var toBalanceQuery = $@"
        SELECT SUM(x.cons_amt) AS balance
        FROM (
            SELECT ... BUILTIN.CONSOLIDATE(...) ...
            WHERE t.trandate <= TO_DATE('{toEndDate}', 'YYYY-MM-DD')
            ...
        ) x";
    
    // Query for balance as of period before fromPeriod (cumulative)
    var beforeFromBalanceQuery = $@"
        SELECT SUM(x.cons_amt) AS balance
        FROM (
            SELECT ... BUILTIN.CONSOLIDATE(...) ...
            WHERE t.trandate <= TO_DATE('{beforeFromPeriodEndDate}', 'YYYY-MM-DD')
            ...
        ) x";
    
    // Execute both queries
    var toBalanceResult = await _netSuiteService.QueryRawWithErrorAsync(toBalanceQuery, queryTimeout);
    var beforeFromBalanceResult = await _netSuiteService.QueryRawWithErrorAsync(beforeFromBalanceQuery, queryTimeout);
    
    // Calculate activity
    var activity = toBalance - beforeFromBalance;
}
```

---

## WHY IT'S TIMING OUT

### The Problem

1. **Two Expensive Queries:** The backend runs TWO full cumulative queries, each scanning all historical transactions
2. **No Caching:** The backend doesn't use cached cumulative balances - it always queries NetSuite directly
3. **Cloudflare Timeout:** Cloudflare has a 100-second timeout, but the backend allows 180 seconds
   - Error 524 = Cloudflare timeout (not backend timeout)
   - The queries are taking > 100 seconds, so Cloudflare kills the connection

### Performance Comparison

**What You Expected:**
- Use cached cumulative balance for Jan 2025
- Use cached cumulative balance for Feb 2025
- Subtract: `Feb - Jan = Activity`
- **Time: ~0ms** (if cached) or **~2-5 seconds** (if need to fetch Feb only)

**What Actually Happens:**
- Query 1: Calculate cumulative balance to Feb 2025 (scans all history)
- Query 2: Calculate cumulative balance to Dec 2024 (scans all history)
- Subtract: `Query1 - Query2`
- **Time: 60-120+ seconds** (two full cumulative queries)

---

## WHY CACHED VALUES DON'T HELP (CURRENTLY)

### The Issue

Even if you've already calculated:
- `BALANCE(10010, , "Jan 2025")` = 2,064,705.84 (cached in frontend)
- `BALANCE(10010, , "Feb 2025")` = 381,646.48 (cached in frontend)

**The backend doesn't know about these cached values** and still runs the two full queries.

### Financial Correctness Constraint

There's a critical constraint: **Both cumulative balances must use the SAME exchange rate** (toPeriod's rate) for the subtraction to be financially correct.

- If Jan balance was calculated at Jan's exchange rate
- And Feb balance was calculated at Feb's exchange rate
- Then `Feb - Jan` would be **financially incorrect** (mixing exchange rates)

**Current Implementation:**
- Both queries use `targetPeriodId = toPeriod` (Feb 2025's rate)
- This ensures financial correctness
- But requires recalculating both balances at the target rate

---

## OPTIMIZATION OPPORTUNITIES

### Option 1: Frontend Cache Check (Fast Path)

**If we have cached cumulative balances at the target period's rate:**
- Check if `BALANCE(account, , toPeriod)` is cached
- Check if `BALANCE(account, , beforeFromPeriod)` is cached
- If both cached, calculate: `cachedToBalance - cachedBeforeFromBalance`
- **No backend call needed!**

**Implementation:**
```javascript
// In BALANCE function, before API call:
if (!isCumulativeQuery && lookupPeriod) {
    // Period activity query
    const toPeriodCacheKey = getCacheKey('balance', { account, fromPeriod: '', toPeriod, ... });
    const beforeFromPeriod = getPeriodBefore(fromPeriod);
    const beforeFromCacheKey = getCacheKey('balance', { account, fromPeriod: '', toPeriod: beforeFromPeriod, ... });
    
    if (cache.balance.has(toPeriodCacheKey) && cache.balance.has(beforeFromCacheKey)) {
        const toBalance = cache.balance.get(toPeriodCacheKey);
        const beforeFromBalance = cache.balance.get(beforeFromCacheKey);
        const activity = toBalance - beforeFromBalance;
        return activity; // ✅ Fast path - no backend call
    }
}
```

**Challenge:** We need to ensure both cached values are at the same exchange rate (toPeriod's rate).

### Option 2: Backend Optimization (If Frontend Cache Miss)

**If frontend cache misses, backend could:**
- Check if it has cached cumulative balances
- Recalculate only if needed at target rate
- But this requires backend caching infrastructure

### Option 3: Single Query Optimization

**Instead of two cumulative queries, use a single period-range query:**
- Query transactions only between Jan 1, 2025 and Feb 28, 2025
- Apply `BUILTIN.CONSOLIDATE` at Feb 2025's rate
- **Much faster** (only scans 2 months of data, not all history)

**Current Limitation:** The current implementation uses cumulative queries to ensure financial correctness with exchange rates.

---

## RECOMMENDED FIX

### Immediate Fix: Frontend Cache Check

1. **Before making API call for period activity:**
   - Check if cumulative balance for `toPeriod` is cached
   - Check if cumulative balance for `beforeFromPeriod` is cached
   - If both exist, calculate activity from cache (no backend call)

2. **Cache Key Format:**
   - Cumulative balance cache keys: `balance:${account}::${period}`
   - Period activity cache keys: `balance:${account}:${fromPeriod}:${toPeriod}`
   - Need to check both cumulative keys

3. **Financial Correctness:**
   - Only use cached values if they were calculated at the same exchange rate
   - This requires storing exchange rate info in cache (or recalculating if rates differ)

### Long-Term Fix: Backend Single Query

1. **Use period-range query instead of two cumulative queries:**
   - Query: `WHERE t.trandate >= fromStartDate AND t.trandate <= toEndDate`
   - Apply `BUILTIN.CONSOLIDATE` at toPeriod's rate
   - **Much faster** (only scans period range, not all history)

2. **Financial Correctness:**
   - All transactions in the range use the same exchange rate (toPeriod's)
   - Mathematically equivalent to `Balance(toPeriod) - Balance(beforeFromPeriod)`
   - But much more efficient

---

## SUMMARY

**What's Happening:**
- Backend runs TWO full cumulative queries (scans all history twice)
- Each query takes 60-120+ seconds
- Cloudflare times out at 100 seconds (524 error)

**Why Cached Values Don't Help:**
- Backend doesn't know about frontend cache
- Even if cached, both balances need to be at same exchange rate (toPeriod's)
- Current implementation recalculates to ensure correctness

**Expected vs Reality:**
- **Expected:** Use cached cumulative balances, subtract = instant
- **Reality:** Two full cumulative queries = 120+ seconds = timeout

**Solution:**
- Add frontend cache check before API call
- If both cumulative balances cached, calculate activity from cache
- Fall back to backend query only if cache miss

