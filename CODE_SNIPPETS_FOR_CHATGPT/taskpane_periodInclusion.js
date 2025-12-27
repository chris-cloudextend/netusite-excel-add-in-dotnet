// ============================================================================
// EXTRACTED FROM: docs/taskpane.html lines 8598-8618
// Purpose: Ensure trigger period is always included in preload list
// KEY CHANGE: Always add trigger.firstPeriod to periods list, even if not found in sheet scan
// ============================================================================

console.log(`📊 Auto-scan found ${formulaData.periods.length} period(s) in formulas`);

// CRITICAL: Always ensure trigger.firstPeriod is included (normalized)
// This handles cases where user adds a NEW period that isn't in existing formulas
if (trigger.firstPeriod) {
    // Normalize the period to ensure it matches cache key format
    let normalizedPeriod = trigger.firstPeriod.trim();
    const parts = normalizedPeriod.split(/\s+/);
    if (parts.length === 2) {
        const month = parts[0];
        const year = parts[1];
        const normalizedMonth = month.charAt(0).toUpperCase() + month.slice(1).toLowerCase();
        normalizedPeriod = `${normalizedMonth} ${year}`;
    }
    
    // Add to periods set if not already present
    if (!formulaData.periods.includes(normalizedPeriod)) {
        formulaData.periods.push(normalizedPeriod);
        console.log(`➕ Added trigger period to preload: ${normalizedPeriod}`);
    }
}

if (formulaData.periods.length === 0) {
    hideLoading();
    console.warn('No periods found for BS preload');
    if (window.markAutoPreloadComplete) window.markAutoPreloadComplete();
    return;
}

console.log(`📋 Final periods to preload: ${formulaData.periods.join(', ')}`);

