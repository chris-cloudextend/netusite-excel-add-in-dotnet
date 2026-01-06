# Preload Caching Proof: How Column Caching Works for Balance Sheet Accounts

## Summary

**YES, the column WILL be cached** - but through the preload mechanism, not column-based batching.

## How It Works

### Step 1: First Formula Triggers Preload (Line 7096)

When you enter the first formula `=XAVI.BALANCE("10010", ,"May 2025")`:

```7090:7096:docs/functions.js
                                console.log(`🔄 BS account: Period May 2025 not in manifest - triggering preload before queuing API calls`);
                                addPeriodToRequestQueue(periodKey, { subsidiary, department, location, classId, accountingBook });
                                
                                // CRITICAL FIX: Trigger auto-preload for ALL BS accounts, including those with subsidiary filters
                                // Backend preload endpoints support subsidiary filters, so this check was incorrectly blocking preload
                                // This was causing formulas with subsidiaries to wait 120s timeout instead of triggering preload
                                triggerAutoPreload(account, periodKey);
```

**Result**: Preload is triggered for period "May 2025"

### Step 2: Preload Fetches ALL Balance Sheet Accounts (Backend)

The `/batch/bs_preload` endpoint is called, which:

```981:993:backend-dotnet/Controllers/BalanceController.cs
    /// <summary>
    /// Preload ALL Balance Sheet accounts for a given period.
    /// This is critical for performance - BS cumulative queries are slow (~70s),
    /// but batching ALL BS accounts into one query takes only slightly longer.
    /// After preload, individual BS formulas hit cache and are instant.
    /// </summary>
    /// <remarks>
    /// Performance benchmarks:
    /// - 1 BS account: ~74 seconds
    /// - 10 BS accounts: ~66 seconds (batched)
    /// - 30 BS accounts: ~66 seconds (batched)
    /// - 100+ BS accounts: ~70 seconds (batched)
    /// </remarks>
    [HttpPost("/batch/bs_preload")]
    public async Task<IActionResult> PreloadBalanceSheetAccounts([FromBody] BsPreloadRequest request)
```

**Key Point**: The endpoint fetches **ALL Balance Sheet accounts** (not just account 10010), because:
- It takes ~70 seconds to query 1 account
- It takes ~70 seconds to query 100+ accounts (batched)
- So we fetch ALL accounts to cache them all

### Step 3: Preload Caches ALL Accounts (Taskpane)

The taskpane receives the preload response and caches ALL accounts:

```9461:9491:docs/taskpane.html
                                        for (const [account, periodBalances] of Object.entries(result.balances)) {
                                            accountCount++;
                                            if (typeof periodBalances === 'object') {
                                                for (const [pName, balance] of Object.entries(periodBalances)) {
                                                    // Cache key format: balance:${account}:${filtersHash}:${period}
                                                    // This matches the format expected by checkLocalStorageCache
                                                    const cacheKey = `balance:${account}:${filtersHash}:${pName}`;
                                                    cacheEntries[cacheKey] = { value: balance, timestamp: Date.now() };
                                                    
                                                    // Also store without filters for backward compatibility (if filters are empty/default)
                                                    // This ensures old cache lookups still work
                                                    if (filtersHash === '||||1' || filtersHash === '||||') {
                                                        const legacyKey = `balance:${account}::${pName}`;
                                                        cacheEntries[legacyKey] = { value: balance, timestamp: Date.now() };
                                                    }
                                                    
                                                    if (balance === 0 || balance === '0' || parseFloat(balance) === 0) {
                                                        zeroBalanceCount++;
                                                    }
                                                    
                                                    if (['10413', '10206', '10411'].includes(account)) {
                                                        console.log(`   🔍 Problematic account ${account} cached: balance = ${balance} for ${pName}`);
                                                    }
                                                }
                                            }
                                        }
                                        try {
                                            const existing = JSON.parse(localStorage.getItem('xavi_balance_cache') || '{}');
                                            const merged = { ...existing, ...cacheEntries };
                                            localStorage.setItem('xavi_balance_cache', JSON.stringify(merged));
                                            console.log(`✅ Cached ${accountCount} BS accounts for chunk (${zeroBalanceCount} with zero balances)`);
```

**Result**: ALL Balance Sheet accounts for "May 2025" are cached in `localStorage` with keys like:
- `balance:10010:${filtersHash}:May 2025`
- `balance:10011:${filtersHash}:May 2025`
- `balance:10012:${filtersHash}:May 2025`
- ... (all other BS accounts)

### Step 4: Subsequent Formulas Check Cache (Line 6737)

When you drag the column down and Excel evaluates subsequent formulas, they check the cache:

```6737:6743:docs/functions.js
                const localStorageValue = checkLocalStorageCache(account, fromPeriod, toPeriod, subsidiary, filtersHash);
                if (localStorageValue !== null) {
                    console.log(`✅ Post-preload cache hit (localStorage): ${account}`);
                    cacheStats.hits++;
                    cache.balance.set(cacheKey, localStorageValue);
                    
                    return localStorageValue;
                }
```

**Result**: Subsequent formulas (10011, 10012, etc.) will find their values in the preload cache and return instantly.

## Why Column-Based Batching Shows "Not Eligible"

The log shows:
```
⏸️ [BATCH DEBUG] Grid not eligible for column-based batching: ... evaluatingRequests=1
```

This is **expected** because:
- Column-based batching requires **2+ accounts** to be eligible (line 775: `allAccounts.size >= 2`)
- When you enter the first formula, there's only 1 account being evaluated
- So it falls back to the preload path (which is correct!)

## Answer to Your Question

**YES, the column WILL be cached** through the preload mechanism:

1. ✅ First formula triggers preload
2. ✅ Preload fetches **ALL Balance Sheet accounts** for that period (~70 seconds)
3. ✅ Preload caches **ALL accounts** in localStorage
4. ✅ When you drag the column down, subsequent formulas hit the cache instantly

The taskpane progress window message you saw confirms this - it said it cached all BS accounts, not just account 10010.

## Cache Key Format

The cache uses this format:
```
balance:${account}:${filtersHash}:${period}
```

Where `filtersHash` = `${subsidiary}|${department}|${location}|${class}|${book}`

This ensures that:
- Different filter combinations use different cache keys
- Formulas with the same filters can share the cache
- Formulas with different filters don't interfere with each other

