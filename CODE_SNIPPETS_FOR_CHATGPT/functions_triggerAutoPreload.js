// ============================================================================
// EXTRACTED FROM: docs/functions.js lines 398-443
// Function: triggerAutoPreload()
// Purpose: Triggers automatic BS preload when first BS formula is detected
// ============================================================================

function triggerAutoPreload(firstAccount, firstPeriod) {
    if (autoPreloadInProgress) {
        console.log('🔄 Auto-preload already in progress');
        return;
    }
    
    // Check if this period is already cached
    const isPeriodCached = checkIfPeriodIsCached(firstPeriod);
    
    if (isPeriodCached) {
        console.log(`✅ Period ${firstPeriod} already cached, skipping auto-preload`);
        return;
    }
    
    // If this is the first time, mark as triggered
    if (!autoPreloadTriggered) {
        autoPreloadTriggered = true;
        console.log(`🚀 AUTO-PRELOAD: Triggered by first BS formula (${firstAccount}, ${firstPeriod})`);
    } else {
        console.log(`🚀 AUTO-PRELOAD: Triggered for new period (${firstAccount}, ${firstPeriod})`);
    }
    
    autoPreloadInProgress = true;
    
    // Set localStorage flag so waitForPreload() can detect it
    // This allows formulas to wait for auto-preload to complete
    try {
        localStorage.setItem(PRELOAD_STATUS_KEY, 'running');
        localStorage.setItem(PRELOAD_TIMESTAMP_KEY, Date.now().toString());
    } catch (e) {
        console.warn('Could not set preload status:', e);
    }
    
    // Send signal to taskpane to trigger auto-preload
    // Taskpane will scan the sheet and preload all BS accounts
    try {
        localStorage.setItem('netsuite_auto_preload_trigger', JSON.stringify({
            firstAccount: firstAccount,
            firstPeriod: firstPeriod,
            timestamp: Date.now(),
            reason: autoPreloadTriggered ? `New period detected: ${firstPeriod}` : 'First Balance Sheet formula detected'
        }));
    } catch (e) {
        console.warn('Could not trigger auto-preload:', e);
    }
}

