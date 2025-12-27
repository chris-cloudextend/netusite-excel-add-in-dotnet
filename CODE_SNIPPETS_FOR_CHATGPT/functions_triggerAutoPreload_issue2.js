// ============================================================================
// EXTRACTED FROM: docs/functions.js lines 398-455
// Function: triggerAutoPreload()
// Purpose: Triggers automatic BS preload when first BS formula is detected OR when new period is detected
// KEY ISSUE: May not trigger correctly for new periods when formulas are dragged while cells are BUSY
// ============================================================================

function triggerAutoPreload(firstAccount, firstPeriod) {
    // CRITICAL: Normalize period before using it (handles Range objects)
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
    try {
        localStorage.setItem(PRELOAD_STATUS_KEY, 'running');
        localStorage.setItem(PRELOAD_TIMESTAMP_KEY, Date.now().toString());
    } catch (e) {
        console.warn('Could not set preload status:', e);
    }
    
    // Send signal to taskpane to trigger auto-preload
    // CRITICAL: Use normalized period so taskpane can match cache keys correctly
    try {
        localStorage.setItem('netsuite_auto_preload_trigger', JSON.stringify({
            firstAccount: firstAccount,
            firstPeriod: normalizedPeriod,
            timestamp: Date.now(),
            reason: autoPreloadTriggered ? `New period detected: ${normalizedPeriod}` : 'First Balance Sheet formula detected'
        }));
    } catch (e) {
        console.warn('Could not trigger auto-preload:', e);
    }
}

// POTENTIAL ISSUES:
// 1. If multiple formulas trigger simultaneously (drag across Mar, Apr), multiple localStorage
//    signals might overwrite each other instead of merging periods
// 2. The autoPreloadInProgress flag might not reflect the actual state if preload is running
//    in a different context (taskpane vs functions.js)
// 3. If formulas are dragged while cells are BUSY, the trigger might not be evaluated correctly

