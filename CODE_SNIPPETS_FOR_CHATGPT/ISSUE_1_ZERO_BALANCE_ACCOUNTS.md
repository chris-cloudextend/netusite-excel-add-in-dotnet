# Issue 1: Zero Balance Accounts Not Cached During Preload

## Problem Description

When a user selects the first cell in a column and enters a Balance Sheet formula, the auto-preload process runs. However, accounts with zero balances (accounts that have no transactions for that period) are **not being cached** as part of the preload.

### Symptoms
- Cells showing `0` (zero balance accounts) remain in BUSY state for a long time
- These cells eventually resolve after making individual API calls (~60-90 seconds each)
- Console logs show: "This likely means account X has no transactions for Y, so it wasn't returned by the preload query"
- The preload cache does not contain entries for these zero-balance accounts

### Expected Behavior
- Zero balance accounts should be cached during preload with a value of `0`
- When formulas are dragged down, zero balance accounts should resolve instantly from cache
- No individual API calls should be needed for zero balance accounts

## Root Cause Analysis

### Current Backend Query Structure

The `bs_preload` endpoint in `BalanceController.cs` uses a SQL query that **starts from `transactionaccountingline`** with INNER JOINs:

```sql
SELECT 
    a.acctnumber,
    SUM(tal.amount * CASE WHEN a.accttype IN (...) THEN -1 ELSE 1 END) AS balance
FROM transactionaccountingline tal          -- ⚠️ Starts here (inner join)
JOIN transaction t ON t.id = tal.transaction
JOIN account a ON a.id = tal.account
WHERE t.posting = 'T'
  AND tal.posting = 'T'
  AND a.accttype IN ({bsTypesSql})
  AND t.trandate <= TO_DATE('{endDate}', 'YYYY-MM-DD')
GROUP BY a.acctnumber
```

**Problem:** Starting from `transactionaccountingline` with INNER JOINs means:
- Only accounts with at least one transaction line are returned
- Accounts with zero transactions are **excluded** from results
- These accounts never make it into the preload cache

### Frontend Caching Logic

The frontend (`taskpane.html`) correctly attempts to cache zero balances:

```javascript
// Cache ALL balances, including zero (0 is a valid balance)
// This ensures accounts with no transactions are cached and don't trigger individual API calls
const cacheKey = `balance:${account}::${pName}`;
cacheEntries[cacheKey] = { value: balance, timestamp: Date.now() };

// Track zero balances for logging
if (balance === 0 || balance === '0' || parseFloat(balance) === 0) {
    zeroBalanceCount++;
}
```

**However:** If the backend doesn't return these accounts, the frontend has nothing to cache.

### Cache Lookup Logic

The cache lookup in `functions.js` correctly handles zero balances:

```javascript
if (preloadData[preloadKey] && preloadData[preloadKey].value !== undefined) {
    const cachedValue = preloadData[preloadKey].value;
    // CRITICAL: Zero balances (0) are valid cached values and must be returned
    console.log(`✅ Preload cache hit: ${account} for ${lookupPeriod} = ${cachedValue}`);
    return cachedValue;
} else {
    // Account not in preload cache - likely has no transactions for this period
    // The preload query only returns accounts with transactions, so accounts with zero transactions won't be cached
    console.log(`💡 This likely means account ${account} has no transactions for ${lookupPeriod}, so it wasn't returned by the preload query.`);
}
```

## What We've Tried

1. **Frontend Zero Balance Caching** ✅
   - Modified `taskpane.html` to explicitly cache zero balances (lines 8655-8674)
   - Added logging to track zero balance counts
   - **Result:** Frontend is ready to cache zeros, but backend doesn't return them

2. **Cache Lookup Enhancement** ✅
   - Modified `checkLocalStorageCache()` to explicitly return zero balances (lines 2658-2663)
   - Added debug logging to identify when accounts are missing from cache
   - **Result:** Cache lookup works correctly, but accounts aren't in cache to begin with

3. **Backend Query Analysis** 🔍
   - Identified that the query starts from `transactionaccountingline` (inner join)
   - Found documentation (`ANALYSIS_BS_PRELOAD_QUERY_OPTIMIZATION.md`) suggesting a LEFT JOIN approach
   - **Status:** Not yet implemented

## Proposed Solution

### Option 1: Modify Backend Query (Recommended)

Change the SQL query to start from the `account` table with a LEFT JOIN to `transactionaccountingline`:

```sql
SELECT 
    a.acctnumber,
    COALESCE(SUM(
        TO_NUMBER(BUILTIN.CONSOLIDATE(...)) * CASE WHEN a.accttype IN (...) THEN -1 ELSE 1 END
    ), 0) AS balance
FROM account a                                    -- ✅ Start here
LEFT JOIN transactionaccountingline tal ON tal.account = a.id
LEFT JOIN transaction t ON t.id = tal.transaction
LEFT JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
WHERE a.accttype IN ({bsTypesSql})
  AND (t.posting = 'T' OR t.posting IS NULL)    -- Include accounts with no transactions
  AND (tal.posting = 'T' OR tal.posting IS NULL)
  AND (t.trandate <= TO_DATE('{endDate}', 'YYYY-MM-DD') OR t.trandate IS NULL)
GROUP BY a.acctnumber
```

**Benefits:**
- Returns ALL BS accounts, including those with zero transactions
- Zero balance accounts will have `balance = 0` in results
- Frontend can cache them immediately
- No individual API calls needed

### Option 2: Post-Process Backend Results

After the query, identify all BS accounts and add missing ones with zero balance:

```csharp
// Get all BS accounts
var allBsAccounts = await GetAllBalanceSheetAccounts();

// Add missing accounts with zero balance
foreach (var account in allBsAccounts)
{
    if (!allBalances.ContainsKey(account))
    {
        allBalances[account] = new Dictionary<string, decimal> { { periodName, 0 } };
    }
}
```

**Drawbacks:**
- Requires an additional query to get all BS accounts
- Less efficient than fixing the main query

## Key Questions for ChatGPT

1. **Query Structure:** Is the LEFT JOIN approach the best way to include zero balance accounts? Are there performance implications?

2. **NetSuite Limitations:** Does NetSuite's SuiteQL support LEFT JOINs with the BUILTIN.CONSOLIDATE function? Are there any restrictions?

3. **Performance Impact:** Will including all BS accounts (even with zeros) significantly slow down the query? How many BS accounts are typically in a system?

4. **Alternative Approaches:** Are there other ways to ensure zero balance accounts are included without changing the query structure?

5. **Edge Cases:** What about accounts that exist but have never had any transactions? Should these be included?

## Testing Scenarios

1. **Zero Balance Account:** Account 10206 has no transactions in Feb 2025
   - Expected: Preload returns `{ "10206": { "Feb 2025": 0 } }`
   - Actual: Account 10206 not in preload results

2. **Multiple Zero Balances:** Several accounts have zero balances for a period
   - Expected: All returned with `balance = 0`
   - Actual: None returned

3. **Mixed Balances:** Some accounts have transactions, some don't
   - Expected: All BS accounts returned (non-zero and zero)
   - Actual: Only accounts with transactions returned

