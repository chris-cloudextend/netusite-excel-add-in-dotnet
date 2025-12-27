// ============================================================================
// EXTRACTED FROM: docs/functions.js lines 4020-4049 (in BALANCE function)
// Purpose: After preload completes, check if period is still missing and trigger new preload
// KEY ISSUE: May not work correctly if formulas are dragged while cells are still BUSY
// ============================================================================

// If this is a BS account and the period is not cached, check if preload is in progress
// If preload is running, wait for it to complete before making API calls
// CRITICAL: Also trigger preload for NEW periods even if preload was already triggered before
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
                
                // CRITICAL: If period still not cached after preload completed,
                // it means this is a NEW period that wasn't included in the previous preload
                // Trigger a new preload for this period
                console.log(`🔄 Period ${lookupPeriod} still not cached after preload - triggering new preload for this period`);
                triggerAutoPreload(account, lookupPeriod);
            }
        } else {
            // No preload in progress - trigger it (this handles both first-time and new periods)
            console.log(`🔄 Period ${lookupPeriod} not in cache - triggering auto-preload for this period`);
            triggerAutoPreload(account, lookupPeriod);
        }
    }
}

// POTENTIAL ISSUES:
// 1. If user drags formulas while cells are BUSY, this check might happen before the preload
//    for the new periods is triggered, causing individual API calls
// 2. The waitForPreload() might timeout or return false if preload takes too long
// 3. Multiple formulas triggering simultaneously might cause race conditions

