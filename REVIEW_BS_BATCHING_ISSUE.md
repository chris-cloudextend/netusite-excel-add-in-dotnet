# Review: Balance Sheet Grid Batching Not Triggering

## Issue Summary
User dragged formula from January to April, but batching did not trigger. Server logs show multiple individual queries instead of a single batched query.

## Server Log Analysis

### What I See in Logs:
1. **Multiple individual queries**: Many `QueryRawAsync: Starting query` entries
2. **BS PRELOAD queries**: Old preload logic is still running (Jan 2025, Feb 2025, Mar 2025)
3. **No batch mode parameters**: No `anchor_date`, `batch_mode`, or `include_period_breakdown` in server logs
4. **No frontend batching logs**: No "BS GRID PATTERN DETECTED" or "BS BATCH QUERY" messages

### What This Indicates:
- Pattern detection is **not triggering** OR
- Pattern detection is **failing silently** OR
- Requests are being **processed individually before batching can occur**

---

## Code Flow Analysis

### 1. Request Queuing (BALANCE function)
**Location**: `docs/functions.js` ~line 5650

```javascript
pendingRequests.balance.set(cacheKey, {
    params,
    resolve,
    reject,
    timestamp: Date.now()
});
```

**Issue**: Requests are queued with `{params, resolve, reject, timestamp}` but **NO `endpoint` property** for regular BALANCE calls.

**Impact**: In `detectBalanceSheetGridPattern()` at line 495, it checks:
```javascript
const endpoint = request.endpoint || '/balance';
```

This should work (defaults to '/balance'), but let's verify requests have the right structure.

---

### 2. Pattern Detection (processBatchQueue)
**Location**: `docs/functions.js` ~line 6652

**Flow**:
1. `processBatchQueue()` extracts requests from `pendingRequests.balance`
2. Routes to `cumulativeRequests` array (if `fromPeriod` is empty)
3. Calls `detectBalanceSheetGridPattern(cumulativeRequests)`

**Potential Issues**:

#### Issue A: Account Type Check Too Early
**Location**: Line 512-519

```javascript
const typeCacheKey = getCacheKey('type', { account });
const accountType = cache.type.has(typeCacheKey) ? cache.type.get(typeCacheKey) : null;

if (accountType && (accountType === 'Income' || accountType === 'COGS' || ...)) {
    continue; // Skip grid batching
}
```

**Problem**: If account type is **not in cache** (null), it should proceed. But if account type is fetched in BALANCE() function (line 4942), it might not be in cache when pattern detection runs.

**Question**: Is account type being cached properly after the gate check in BALANCE()?

#### Issue B: Pattern Detection Requirements
**Location**: Line 482-567

Requirements for pattern detection:
1. ✅ At least 2 requests (`cumulativeRequests.length >= 2`)
2. ✅ Same account + same filters
3. ✅ At least 2 different periods (`group.periods.size >= 2`)
4. ✅ At least 2 requests (`group.requests.length >= 2`)
5. ⚠️ Account type check (may skip if not in cache or wrong type)

**Potential Issue**: If account type is not in cache during pattern detection, it should proceed (null is OK). But if account type was fetched in BALANCE() and not cached, or if there's a timing issue...

#### Issue C: Timing Issue - Requests Processed Before Pattern Detection
**Location**: Line 6646-6700

The pattern detection happens **after** requests are extracted from the queue. But if:
- Requests are processed in separate `processBatchQueue()` calls
- Each call has only 1-2 requests
- Pattern detection needs all requests in the same batch

**This could explain why batching isn't triggering**: Each cell might trigger its own `processBatchQueue()` call before all cells are queued.

---

### 3. Account Type Gate (BALANCE function)
**Location**: `docs/functions.js` ~line 4932-4957

**Flow**:
1. Check account type from cache (synchronous)
2. If not in cache, fetch it (async) - **WAITS**
3. If Income/Expense, continue with existing logic (no queuing)
4. If BS or unknown, continue to queuing

**Potential Issue**: Account type is fetched and checked, but is it being **cached** properly?

Looking at line 4942:
```javascript
if (!accountType) {
    accountType = await getAccountType(account);
}
```

The `getAccountType()` function should cache the result (line 1740-1762), but let's verify it's being called correctly.

---

## Potential Root Causes

### 1. **Account Type Not Cached After Gate Check**
- Account type is fetched in BALANCE() but might not be in cache when pattern detection runs
- Pattern detection checks cache again (line 512) - if not there, should proceed (null is OK)
- But if there's a race condition or cache miss...

### 2. **Requests Processed Individually Before Batching**
- Each cell might trigger `processBatchQueue()` separately
- Pattern detection needs all requests in the same batch
- If requests arrive in separate batches, pattern won't be detected

### 3. **Pattern Detection Logic Issue**
- Account type check might be too strict
- Filter matching might be failing
- Period grouping might not be working correctly

### 4. **Backend Not Supporting New Parameters**
- Frontend tries to use `anchor_date` and `batch_mode` parameters
- Backend might not support them yet (returns error)
- Frontend falls back to individual requests silently

---

## Questions to Answer

1. **Are console logs showing pattern detection attempts?**
   - Look for: `🎯 BS GRID PATTERN DETECTED` or `📊 Processing X CUMULATIVE (BS) requests`
   - If not, pattern detection isn't running

2. **Are requests being queued together?**
   - Check: `📥 QUEUED` logs - are they all in the same batch?
   - Or are they processed separately?

3. **Is account type in cache when pattern detection runs?**
   - Check: Account type cache hits/misses
   - If not cached, pattern detection should still work (null is OK)

4. **Are backend errors being logged?**
   - Check for 400/500 errors when using `anchor_date` or `batch_mode`
   - Frontend might be falling back silently

---

## Recommended Debugging Steps

1. **Add more logging to pattern detection**:
   - Log when pattern detection is called
   - Log account groups found
   - Log why patterns are rejected (account type, period count, etc.)

2. **Check request structure**:
   - Log the structure of requests in `cumulativeRequests`
   - Verify `endpoint` property exists (or defaults correctly)

3. **Verify account type caching**:
   - Log account type cache hits/misses
   - Verify account type is cached after gate check

4. **Check timing**:
   - Log when `processBatchQueue()` is called
   - Log how many requests are in the queue each time
   - Verify all requests arrive in the same batch

5. **Test backend parameters**:
   - Manually test `/balance?anchor_date=...` endpoint
   - Manually test `/balance?batch_mode=true&include_period_breakdown=true`
   - Verify backend supports these parameters

---

## Most Likely Issue

Based on the server logs showing individual queries and no batch mode parameters, I suspect:

**Pattern detection is not finding a match** because:
1. Requests might be processed in separate batches (timing issue)
2. Account type check might be rejecting requests (even though null should be OK)
3. Filter matching might be failing (subsidiary, department, etc.)

**OR**

**Backend doesn't support new parameters yet**, so:
1. Frontend tries batch query
2. Backend returns error (400/500)
3. Frontend falls back to individual requests silently
4. No error logged (catch block returns null)

---

## Next Steps (No Code Changes Yet)

1. Check browser console for frontend logs
2. Verify backend supports `anchor_date` and `batch_mode` parameters
3. Add more detailed logging to pattern detection
4. Check if requests are arriving in the same batch or separately

