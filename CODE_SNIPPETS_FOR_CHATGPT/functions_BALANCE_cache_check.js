// ============================================================================
// EXTRACTED FROM: docs/functions.js lines 3920-3962
// Function: BALANCE() - Cache check and preload trigger section
// Purpose: Shows how BALANCE function checks cache and triggers preload
// ============================================================================

// This is inside the BALANCE() function, after parameter normalization

// Check localStorage cache (BUT NOT for subsidiary-filtered queries!)
// localStorage is keyed by account+period only, not subsidiary
// So we skip it when subsidiary is specified to avoid returning wrong values
const localStorageValue = checkLocalStorageCache(account, fromPeriod, toPeriod, subsidiary);
if (localStorageValue !== null) {
    console.log(`✅ localStorage cache hit: ${account} for ${fromPeriod || '(cumulative)'} → ${toPeriod}`);
    cacheStats.hits++;
    // Also save to in-memory cache for next time
    cache.balance.set(cacheKey, localStorageValue);
    return localStorageValue;
} else {
    console.log(`📭 localStorage cache miss: ${account} for ${fromPeriod || '(cumulative)'} → ${toPeriod} (checkLocalStorageCache returned null)`);
    
    // If this is a BS account and the period is not cached, check if preload is in progress
    // If preload is running, wait for it to complete before making API calls
    if (!subsidiary && lookupPeriod) {
        const isPeriodCached = checkIfPeriodIsCached(lookupPeriod);
        if (!isPeriodCached) {
            // Check if auto-preload is in progress (either via flag or localStorage)
            const preloadRunning = autoPreloadInProgress || isPreloadInProgress();
            
            if (preloadRunning) {
                console.log(`⏳ Period ${lookupPeriod} not cached, but preload in progress - waiting for completion...`);
                const preloadCompleted = await waitForPreload(90000); // Wait up to 90s
                
                if (preloadCompleted) {
                    // Preload completed - re-check cache
                    console.log(`✅ Preload completed - re-checking cache for ${account}/${lookupPeriod}`);
                    const retryCacheValue = checkLocalStorageCache(account, fromPeriod, toPeriod, subsidiary);
                    if (retryCacheValue !== null) {
                        console.log(`✅ Post-preload cache hit: ${account} for ${lookupPeriod} = ${retryCacheValue}`);
                        cacheStats.hits++;
                        cache.balance.set(cacheKey, retryCacheValue);
                        return retryCacheValue;
                    }
                }
            } else {
                // No preload in progress - trigger it
                console.log(`🔄 Period ${lookupPeriod} not in cache - triggering auto-preload for this period`);
                triggerAutoPreload(account, lookupPeriod);
            }
        }
    }
}

