// ============================================================================
// EXTRACTED FROM: docs/taskpane.html lines 8651-8680
// Purpose: Cache preload results including zero balances
// KEY CHANGE: Explicitly cache zero balances (0) as valid values
// ============================================================================

if (preloadResponse.ok) {
    const result = await preloadResponse.json();
    
    // Cache results - this caches ALL BS accounts for the period(s)
    // CRITICAL: Cache ALL balances, including zero balances (0)
    // Zero balances are valid and must be cached to avoid redundant API calls
    if (result.balances) {
        const cacheEntries = {};
        let accountCount = 0;
        let zeroBalanceCount = 0;
        for (const [account, periodBalances] of Object.entries(result.balances)) {
            accountCount++;
            if (typeof periodBalances === 'object') {
                for (const [pName, balance] of Object.entries(periodBalances)) {
                    // Cache ALL balances, including zero (0 is a valid balance)
                    // This ensures accounts with no transactions are cached and don't trigger individual API calls
                    const cacheKey = `balance:${account}::${pName}`;
                    cacheEntries[cacheKey] = { value: balance, timestamp: Date.now() };
                    
                    // Track zero balances for logging
                    if (balance === 0 || balance === '0' || parseFloat(balance) === 0) {
                        zeroBalanceCount++;
                    }
                }
            }
        }
        try {
            const existing = JSON.parse(localStorage.getItem('xavi_balance_cache') || '{}');
            const merged = { ...existing, ...cacheEntries };
            localStorage.setItem('xavi_balance_cache', JSON.stringify(merged));
            console.log(`✅ Cached ${accountCount} BS accounts for ${formulaData.periods.length} period(s) (${zeroBalanceCount} with zero balances)`);
        } catch (e) {
            console.warn('Cache save error:', e);
        }
    }
}

