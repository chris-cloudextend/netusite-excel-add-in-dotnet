// ============================================================================
// EXTRACTED FROM: docs/functions.js lines 2581-2647
// Function: checkLocalStorageCache()
// Purpose: Checks localStorage for cached balance values
// Key: Cache key format is "balance:${account}::${period}"
// ============================================================================

function checkLocalStorageCache(account, period, toPeriod = null, subsidiary = '') {
    try {
        // Skip localStorage when subsidiary filter is specified (not subsidiary-aware)
        if (subsidiary && subsidiary !== '') return null;
        
        const lookupPeriod = (period && period !== '') ? period : toPeriod;
        if (!lookupPeriod) return null;
        
        // ================================================================
        // CHECK PRELOAD CACHE FIRST (xavi_balance_cache)
        // Preload stores data with keys like: balance:${account}::${period}
        // ================================================================
        try {
            const preloadCache = localStorage.getItem('xavi_balance_cache');
            if (preloadCache) {
                const preloadData = JSON.parse(preloadCache);
                // Preload format: { "balance:10010::Jan 2025": { value: 2064705.84, timestamp: ... }, ... }
                const preloadKey = `balance:${account}::${lookupPeriod}`;
                if (preloadData[preloadKey] && preloadData[preloadKey].value !== undefined) {
                    const cachedValue = preloadData[preloadKey].value;
                    // CRITICAL: Zero balances (0) are valid cached values and must be returned
                    // This prevents redundant API calls for accounts with no transactions
                    console.log(`✅ Preload cache hit (xavi_balance_cache): ${account} for ${lookupPeriod} = ${cachedValue} (${cachedValue === 0 ? 'zero balance' : 'non-zero'})`);
                    return cachedValue;
                } else {
                    // Debug: Log what keys are available (first 5) to help diagnose mismatches
                    const availableKeys = Object.keys(preloadData).filter(k => k.startsWith(`balance:${account}::`));
                    if (availableKeys.length > 0) {
                        console.log(`🔍 Preload cache: Found ${availableKeys.length} keys for account ${account}, but not for period "${lookupPeriod}". Available periods: ${availableKeys.slice(0, 3).map(k => k.split('::')[1]).join(', ')}`);
                    } else {
                        // Account not in preload cache - likely has no transactions for this period
                        // The preload query only returns accounts with transactions, so accounts with zero transactions won't be cached
                        console.log(`🔍 Preload cache: No keys found for account ${account} (looking for: ${preloadKey})`);
                        console.log(`   💡 This likely means account ${account} has no transactions for ${lookupPeriod}, so it wasn't returned by the preload query. Will need to query backend.`);
                    }
                }
            } else {
                console.log(`🔍 Preload cache: xavi_balance_cache not found in localStorage`);
            }
        } catch (preloadErr) {
            console.warn(`⚠️ Preload cache lookup error:`, preloadErr);
            // Ignore preload cache errors, fall through to legacy cache
        }
        
        // ================================================================
        // CHECK LEGACY CACHE (netsuite_balance_cache)
        // Legacy format: { "10010": { "Jan 2025": 2064705.84, ... }, ... }
        // ================================================================
        const timestamp = localStorage.getItem(STORAGE_TIMESTAMP_KEY);
        if (!timestamp) return null;
        
        const cacheAge = Date.now() - parseInt(timestamp);
        if (cacheAge > STORAGE_TTL) return null;
        
        const cached = localStorage.getItem(STORAGE_KEY);
        if (!cached) return null;
        
        const balances = JSON.parse(cached);
        
        if (lookupPeriod && balances[account] && balances[account][lookupPeriod] !== undefined) {
            return balances[account][lookupPeriod];
        }
        return null;
    } catch (e) {
        return null;
    }
}

