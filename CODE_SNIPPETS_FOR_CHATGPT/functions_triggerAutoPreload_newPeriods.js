// ============================================================================
// EXTRACTED FROM: docs/functions.js lines 398-455
// Function: triggerAutoPreload()
// Purpose: Triggers automatic BS preload when first BS formula is detected OR when new period is detected
// KEY CHANGE: Now allows preload to trigger for NEW periods even if a preload is already in progress
// ============================================================================

function triggerAutoPreload(firstAccount, firstPeriod) {
    // CRITICAL: Normalize period before using it (handles Range objects)
    // This ensures cache keys use canonical "Mon YYYY" format, not "[object Object]"
    const normalizedPeriod = convertToMonthYear(firstPeriod, false);
    if (!normalizedPeriod) {
        console.warn(`⚠️ triggerAutoPreload: Could not normalize period "${firstPeriod}", skipping preload`);
        return;
    }
    
    // Check if this period is already cached (using normalized period)
    const isPeriodCached = checkIfPeriodIsCached(normalizedPeriod);
    
    if (isPeriodCached) {
        console.log(`✅ Period ${normalizedPeriod} already cached, skipping auto-preload`);
        return;
    }
    
    // CRITICAL: Allow preload to trigger for NEW periods even if a previous preload is in progress
    // This handles the case where user adds new columns (new periods) after initial preload started
    // We'll let the taskpane handle multiple preload requests by merging periods
    if (autoPreloadInProgress) {
        console.log(`🔄 Auto-preload in progress, but ${normalizedPeriod} is new period - triggering additional preload`);
        // Continue to trigger - taskpane will handle merging periods
    }
    
    // If this is the first time, mark as triggered
    if (!autoPreloadTriggered) {
        autoPreloadTriggered = true;
        console.log(`🚀 AUTO-PRELOAD: Triggered by first BS formula (${firstAccount}, ${normalizedPeriod})`);
    } else {
        console.log(`🚀 AUTO-PRELOAD: Triggered for new period (${firstAccount}, ${normalizedPeriod})`);
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
    // CRITICAL: Use normalized period so taskpane can match cache keys correctly
    // Taskpane will scan the sheet and preload all BS accounts
    try {
        localStorage.setItem('netsuite_auto_preload_trigger', JSON.stringify({
            firstAccount: firstAccount,
            firstPeriod: normalizedPeriod,  // Use normalized period, not raw input
            timestamp: Date.now(),
            reason: autoPreloadTriggered ? `New period detected: ${normalizedPeriod}` : 'First Balance Sheet formula detected'
        }));
    } catch (e) {
        console.warn('Could not trigger auto-preload:', e);
    }
}

