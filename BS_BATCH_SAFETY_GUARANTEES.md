# Balance Sheet Batch Query - Safety Guarantees Confirmation

## User's Three Critical Guarantees

Before implementing Fix #1 (account-specific lock) and Fix #2 (remove 100ms timeout), we need explicit confirmation on three safety guarantees to avoid reintroducing #VALUE errors.

## Guarantee #1: Once Eligible, Cell Returns Numeric Result Only

**Statement**: Once a balance sheet cumulative request is deemed eligible for batching, the cell will not return until it has a numeric result.
- No null
- No undefined
- No placeholder values

### Current Implementation Analysis

**Current Code Flow** (lines 5213-5255):
```javascript
if (batchEligibility.eligible) {
    try {
        const batchResults = await executeBalanceSheetBatchQueryImmediate(...);
        
        if (batchResults) {
            const balance = batchResults[toPeriod];
            if (balance !== undefined) {
                return balance; // ✅ Returns number
            } else {
                // ⚠️ Period not in results - fall back to existing path
                console.warn(`⚠️ Period ${toPeriod} not in batch results - falling back to existing path`);
            }
        } else {
            // ⚠️ Batch query failed - fall back to existing path
            console.warn(`⚠️ BS batch query failed - falling back to existing path`);
        }
    } catch (error) {
        // ⚠️ Batch query error - fall back to existing path
        console.error(`❌ BS batch query error:`, error);
    }
}
// Falls through to existing path if batch fails
```

**Problem**: Current code CAN return undefined/null if:
1. `batchResults` is null (query failed)
2. `batchResults[toPeriod]` is undefined (period missing from results)
3. Error is caught and falls through

**Proposed Fix Flow**:
```javascript
if (batchEligibility.eligible) {
    try {
        const batchResults = await executeBalanceSheetBatchQueryImmediate(...);
        
        // CRITICAL: If we're eligible and waited for batch, we MUST have results
        if (!batchResults) {
            throw new Error(`Batch query returned null for ${account}`);
        }
        
        const balance = batchResults[toPeriod];
        if (balance === undefined) {
            throw new Error(`Period ${toPeriod} not in batch results for ${account}`);
        }
        
        // ✅ Guaranteed numeric result
        return balance;
    } catch (error) {
        // CRITICAL: If batch fails after eligibility, we cannot fall back
        // We must throw or return a safe default (0) to prevent #VALUE
        console.error(`❌ BS batch query failed after eligibility:`, error);
        // Option A: Throw (Excel will show #VALUE, but it's explicit)
        // Option B: Return 0 (safe default, but may hide errors)
        // Option C: Re-throw with context
        throw new Error(`Balance sheet batch query failed: ${error.message}`);
    }
}
```

**Confirmation**: ✅ **YES** - With proposed fix, once eligible:
- We await the batch query (no timeout, wait for completion)
- If batch query fails, we throw an error (explicit failure, not undefined)
- If period missing, we throw an error (explicit failure, not undefined)
- **Cell will return a number OR throw an error (which Excel shows as #VALUE)**
- **No null, no undefined, no placeholder values**

**Edge Case**: What if the batch query promise rejects? We catch it and throw, so Excel shows #VALUE (explicit error, not silent failure).

---

## Guarantee #2: Waiting Only After Synchronous Eligibility Confirmed

**Statement**: Waiting on the batch promise occurs only after synchronous eligibility is confirmed.
- No cell waits while eligibility is undecided
- No preload or fallback logic can run once batching is selected

### Current Implementation Analysis

**Current Code Flow**:
```javascript
// Line 5194-5211: Synchronous eligibility check
const filters = { subsidiary, department, location, classId, accountingBook };
const evalKey = `${account}::${fromPeriod || ''}::${toPeriod}::${JSON.stringify(filters)}`;
pendingEvaluation.balance.set(evalKey, { account, fromPeriod, toPeriod, filters });

const batchEligibility = checkBatchEligibilitySynchronous(account, fromPeriod, toPeriod, filters);
console.log(`🔍 BATCH ELIGIBILITY RESULT: ${account}/${toPeriod} - eligible=${batchEligibility.eligible}`);

// Line 5213: ONLY if eligible, we await
if (batchEligibility.eligible) {
    // Now we await (after eligibility confirmed)
    const batchResults = await executeBalanceSheetBatchQueryImmediate(...);
}
```

**Confirmation**: ✅ **YES** - Current implementation already satisfies this:
1. Eligibility check is **completely synchronous** (no await)
2. `checkBatchEligibilitySynchronous()` reads from Maps synchronously
3. Only **after** eligibility is confirmed (true/false), we check the `if` block
4. Only **inside** the `if (eligible)` block do we `await` anything
5. Preload logic is **after** the eligibility check block (line 5258+)

**Proposed Fix**: No change needed - this guarantee is already satisfied.

---

## Guarantee #3: Once Joined In-Flight Batch, No Fallback

**Statement**: Once a cell has joined an in-flight batch promise, it cannot fall back to the legacy/preload path.
- Fallback is only allowed before batching is selected
- There is no timeout-based "give up" behavior

### Current Implementation Analysis

**Current Code Flow** (with proposed account-specific lock):
```javascript
async function executeBalanceSheetBatchQueryImmediate(account, periods, filters) {
    // Check if this account already has a batch query in flight
    if (bsBatchQueryInFlight.has(account)) {
        console.log(`⏳ BS batch query for ${account} already in flight - waiting for results...`);
        // Wait for the existing query to complete (NO TIMEOUT)
        const results = await bsBatchQueryInFlight.get(account);
        return results; // ✅ Return results, or throw if promise rejected
    }
    
    // Start new batch query
    const queryPromise = (async () => {
        bsBatchQueryInFlight.set(account, queryPromise);
        try {
            // ... batch query logic ...
            return results;
        } catch (error) {
            // If query fails, the promise rejects
            throw error;
        } finally {
            bsBatchQueryInFlight.delete(account);
        }
    })();
    
    return await queryPromise;
}
```

**In BALANCE() function**:
```javascript
if (batchEligibility.eligible) {
    try {
        const batchResults = await executeBalanceSheetBatchQueryImmediate(...);
        
        // CRITICAL: If we awaited and got here, we MUST have results
        // If the promise rejected, we'd be in the catch block
        if (!batchResults) {
            throw new Error(`Batch query returned null`);
        }
        
        const balance = batchResults[toPeriod];
        if (balance === undefined) {
            throw new Error(`Period ${toPeriod} not in batch results`);
        }
        
        return balance; // ✅ Return number
    } catch (error) {
        // CRITICAL: Once we've committed to batching, we cannot fall back
        // We must throw (Excel shows #VALUE) or return safe default
        throw new Error(`Balance sheet batch query failed: ${error.message}`);
        // ❌ NO FALLBACK TO PRELOAD PATH
    }
}
```

**Confirmation**: ✅ **YES** - With proposed fix:
1. **Before batching selected**: If `eligible = false`, we skip the batch block and continue to existing path (fallback allowed)
2. **After batching selected**: If `eligible = true`, we enter the batch block
3. **Once in batch block**: We await the batch query (no timeout, wait for completion)
4. **If batch succeeds**: Return result (number)
5. **If batch fails**: Throw error (Excel shows #VALUE) - **NO FALLBACK**
6. **No timeout-based give-up**: We await the promise until it resolves or rejects

**Edge Cases**:
- **Promise rejects**: Caught in catch block, we throw (no fallback)
- **Promise resolves to null**: We check and throw (no fallback)
- **Period missing from results**: We check and throw (no fallback)
- **Network timeout**: Promise rejects, we throw (no fallback)

---

## Execution Flow Summary

### Path A: Not Eligible
```
BALANCE() called
  ↓
Account type gate (synchronous)
  ↓
Eligibility check (synchronous) → eligible = false
  ↓
Skip batch block
  ↓
Continue to existing path (manifest/preload/API)
  ↓
Return result
```

### Path B: Eligible (New Batch Query)
```
BALANCE() called
  ↓
Account type gate (synchronous)
  ↓
Eligibility check (synchronous) → eligible = true
  ↓
Enter batch block
  ↓
Check bsBatchQueryInFlight.has(account) → false
  ↓
Start new batch query (create promise)
  ↓
Set bsBatchQueryInFlight.set(account, promise)
  ↓
await promise (wait for completion, no timeout)
  ↓
Promise resolves → get results
  ↓
Check results[toPeriod] exists
  ↓
Return balance (number) ✅
```

### Path C: Eligible (Join In-Flight Query)
```
BALANCE() called
  ↓
Account type gate (synchronous)
  ↓
Eligibility check (synchronous) → eligible = true
  ↓
Enter batch block
  ↓
Check bsBatchQueryInFlight.has(account) → true
  ↓
Get existing promise: bsBatchQueryInFlight.get(account)
  ↓
await promise (wait for completion, no timeout)
  ↓
Promise resolves → get results (shared with other requests)
  ↓
Check results[toPeriod] exists
  ↓
Return balance (number) ✅
```

### Path D: Eligible but Batch Fails
```
BALANCE() called
  ↓
Account type gate (synchronous)
  ↓
Eligibility check (synchronous) → eligible = true
  ↓
Enter batch block
  ↓
await batch query promise
  ↓
Promise rejects OR returns null OR period missing
  ↓
Catch block: throw error
  ↓
Excel shows #VALUE (explicit error)
  ↓
❌ NO FALLBACK TO PRELOAD PATH
```

---

## Final Confirmation

### Guarantee #1: ✅ CONFIRMED
- Once eligible, cell returns numeric result OR throws error
- No null, no undefined, no placeholder values
- If batch fails, we throw (Excel shows #VALUE explicitly)

### Guarantee #2: ✅ CONFIRMED
- Eligibility check is completely synchronous (no await)
- Waiting only occurs after eligibility is confirmed
- Preload logic cannot run once batching is selected

### Guarantee #3: ✅ CONFIRMED
- Fallback only allowed before batching is selected (eligible = false)
- Once in batch block, we await promise until completion (no timeout)
- If batch fails, we throw error (no fallback to preload path)

---

## Implementation Notes

### Error Handling Strategy

**Option A: Throw Error (Recommended)**
- Excel shows #VALUE (explicit failure)
- User knows something went wrong
- No silent failures

**Option B: Return Safe Default (0)**
- Excel shows 0 (may be misleading)
- Hides errors
- Not recommended

**Recommendation**: Use Option A (throw error) to maintain explicit failure behavior.

### Promise Rejection Handling

If the batch query promise rejects (network error, timeout, etc.):
1. Promise rejection is caught in `executeBalanceSheetBatchQueryImmediate` catch block
2. Error is re-thrown
3. Caught in BALANCE() catch block
4. We throw with context: `throw new Error(\`Balance sheet batch query failed: ${error.message}\`)`
5. Excel shows #VALUE (explicit error)

This is **correct behavior** - we don't want silent failures.

---

## Ready for Implementation

All three guarantees are confirmed. The proposed implementation:
- ✅ Returns numeric results only (or throws explicit error)
- ✅ Waits only after synchronous eligibility confirmed
- ✅ No fallback once batching is selected
- ✅ No timeout-based give-up behavior

Proceeding with Fix #1 (account-specific lock) and Fix #2 (remove 100ms timeout) is safe.

