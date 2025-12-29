# Structural Fix: Early Account Type Gate

## Summary

Implemented a **hard execution split** at the account type level to prevent Income Statement queries from entering the Balance Sheet inference/batching pipeline. This is a structural fix, not a conditional check, ensuring Income/Expense accounts are routed away **before** any BS logic runs.

## Where the Account Type Gate is Enforced

### 1. BALANCE Function - Early Gate (Line ~5363-5450)

**Location**: `docs/functions.js`, immediately after parameter normalization, **before** any manifest/preload logic.

**Implementation**:
```javascript
// Check account type from cache first (synchronous, fast)
const typeCacheKey = getCacheKey('type', { account });
let accountType = cache.type.has(typeCacheKey) ? cache.type.get(typeCacheKey) : null;

// If not in cache, fetch it (async)
if (!accountType) {
    accountType = await getAccountType(account);
}

// INCOME STATEMENT PATH (Hard Return - No BS Logic)
if (accountType && isIncomeStatementType(accountType)) {
    // Check caches, then queue with accountType: 'income_statement' marker
    // HARD RETURN - no BS logic executed
    return new Promise(...);
}

// BALANCE SHEET PATH (Continue with existing BS logic)
// Only reaches here if account is Balance Sheet (or unknown - treated as BS)
```

**Key Points**:
- Account type is checked **synchronously from cache first** (fast path)
- If not in cache, fetched **async** (but we wait before proceeding)
- Income/Expense accounts get **hard return** - no BS logic executed
- Balance Sheet accounts continue to existing BS logic

### 2. processBatchQueue - Routing Split (Line ~7128-7182)

**Location**: `docs/functions.js`, at the start of `processBatchQueue()`, **before** any routing by parameter shape.

**Implementation**:
```javascript
// CRITICAL: ACCOUNT TYPE GATE - Hard execution split
const incomeStatementRequests = [];
const balanceSheetRequests = [];

for (const [cacheKey, request] of requests) {
    if (request.accountType === 'income_statement') {
        // Income Statement request - route immediately to regularRequests
        incomeStatementRequests.push([cacheKey, request]);
    } else {
        // Balance Sheet request - route to BS processing
        balanceSheetRequests.push([cacheKey, request]);
    }
}

// Income Statement requests → regularRequests (no BS logic)
for (const [cacheKey, request] of incomeStatementRequests) {
    regularRequests.push([cacheKey, request]);
}

// Balance Sheet requests → route by parameter shape (BS logic allowed)
for (const [cacheKey, request] of balanceSheetRequests) {
    // Route to cumulativeRequests, periodActivityRequests, or regularRequests
    // BS grid detection, anchor inference, batching logic can run here
}
```

**Key Points**:
- Income Statement requests are identified by `accountType: 'income_statement'` marker
- They are routed **directly to regularRequests** - no BS logic
- Balance Sheet requests are routed by parameter shape and can use BS optimizations

## What Income Statement Queries Cannot Reach

Income Statement queries (marked with `accountType: 'income_statement'`) **cannot** reach:

1. ✅ **Grid detection** (`detectBsGridPattern`) - Only called on `cumulativeRequests` and `periodActivityRequests`, which only contain Balance Sheet requests
2. ✅ **Anchor inference** (`inferAnchorDate`) - Only called from `processBsGridBatching`, which only processes Balance Sheet requests
3. ✅ **BS batching logic** (`processBsGridBatching`) - Only called for Balance Sheet requests
4. ✅ **Manifest/preload coordination** - Income Statement path skips all manifest checks and preload waits
5. ✅ **BS-specific helpers** - All BS-specific logic is gated behind the account type check

## Code Locations

### Account Type Gate Enforcement

1. **BALANCE function** (Line ~5363-5450):
   - Early account type check
   - Hard return for Income/Expense accounts
   - Marks requests with `accountType: 'income_statement'`

2. **processBatchQueue function** (Line ~7128-7182):
   - Routes Income Statement requests to `regularRequests` immediately
   - Routes Balance Sheet requests to BS processing paths

### BS Logic (Only Reached by Balance Sheet Accounts)

1. **Grid detection** (`detectBsGridPattern`) - Line ~1819
   - Only called on `cumulativeRequests` and `periodActivityRequests`
   - These arrays only contain Balance Sheet requests

2. **Anchor inference** (`inferAnchorDate`) - Line ~2113
   - Only called from `processBsGridBatching`
   - `processBsGridBatching` only processes Balance Sheet requests

3. **BS grid batching** (`processBsGridBatching`) - Line ~2195
   - Only called for Balance Sheet requests
   - Processes cumulative and period activity BS queries

## Verification

### Income Statement Path
1. ✅ Account type checked early in BALANCE function
2. ✅ If Income/Expense → hard return (no BS logic)
3. ✅ Request marked with `accountType: 'income_statement'`
4. ✅ In processBatchQueue → routed to `regularRequests` immediately
5. ✅ Never reaches `detectBsGridPattern`, `inferAnchorDate`, or `processBsGridBatching`

### Balance Sheet Path
1. ✅ Account type checked early in BALANCE function
2. ✅ If Balance Sheet → continue to BS logic
3. ✅ Request NOT marked (defaults to Balance Sheet)
4. ✅ In processBatchQueue → routed to BS processing paths
5. ✅ Can use grid detection, anchor inference, and BS batching

## Why This Fixes the Regression

**Previous Issue**: Income Statement queries were entering BS inference/batching pipeline, causing:
- Slow performance (several minutes instead of 26 seconds)
- Requests getting lost in routing
- `#BUSY` states that never resolved

**Root Cause**: Routing was based on parameter shape (`fromPeriod && toPeriod`), not account type. This caught ALL period range queries, including Income/Expense accounts.

**Fix**: Account type is now a **hard execution gate** that routes Income/Expense accounts away **before** any BS logic runs. This ensures:
- Income Statement queries never enter BS pipeline
- BS optimizations can evolve safely without affecting Income Statement
- Clear separation of concerns

## Safety Guarantees

1. ✅ **Hard returns** - Income Statement path uses `return`, not flags
2. ✅ **Early gate** - Account type checked before any BS logic
3. ✅ **No late fallbacks** - Income Statement requests cannot "fall back" to BS logic
4. ✅ **Clear separation** - BS logic only runs on Balance Sheet requests
5. ✅ **No Excel crashes** - All operations are async/await, no blocking, no busy-waits

## Testing Recommendations

1. **Income Statement queries** should:
   - Resolve quickly (26 seconds for large queries)
   - Never show `#BUSY` indefinitely
   - Use batch endpoint (regularRequests path)

2. **Balance Sheet queries** should:
   - Still work correctly
   - Use grid batching when pattern detected
   - Use anchor inference for cumulative queries

3. **Mixed queries** (Income + BS in same batch):
   - Should route correctly based on account type
   - Income Statement queries → regularRequests
   - Balance Sheet queries → BS processing paths

---

**Status**: Implementation complete. Ready for testing.

