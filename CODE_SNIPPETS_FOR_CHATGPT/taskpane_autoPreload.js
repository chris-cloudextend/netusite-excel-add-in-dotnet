// ============================================================================
// EXTRACTED FROM: docs/taskpane.html lines 8483-8710
// Function: Auto-preload trigger handler
// Purpose: Scans sheet for periods and preloads all BS accounts
// ============================================================================

// AUTO-PRELOAD TRIGGER - Automatically preload when first BS formula detected
// No user interaction needed - we scan and preload automatically!
// ================================================================
const autoPreloadJson = localStorage.getItem('netsuite_auto_preload_trigger');
if (autoPreloadJson) {
    const trigger = JSON.parse(autoPreloadJson);
    localStorage.removeItem('netsuite_auto_preload_trigger');
    
    console.log('🚀 AUTO-PRELOAD TRIGGERED:', trigger);
    
    // Show loading overlay immediately
    showLoading(
        '🔍 Balance Sheet Detected!',
        'Scanning your sheet and preloading BS accounts automatically...',
        10
    );
    
    // Small delay to let Excel finish rendering, then scan and preload
    setTimeout(async () => {
        try {
            updateLoading('Scanning Sheet for BS Formulas', 20, 'Finding all Balance Sheet accounts...');
            
            // Scan the sheet for periods used in BS formulas
            // We'll preload ALL BS accounts for these periods (not just specific accounts)
            // This is just as fast as loading one account, and makes all subsequent formulas instant
            const formulaData = await Excel.run(async (context) => {
                const sheet = context.workbook.worksheets.getActiveWorksheet();
                const usedRange = sheet.getUsedRange();
                usedRange.load(['formulas', 'values']);
                await context.sync();
                
                const periods = new Set();
                const formulas = usedRange.formulas;
                const values = usedRange.values;
                
                // Always include the triggering formula's period
                if (trigger.firstPeriod) periods.add(trigger.firstPeriod);
                
                // Scan for XAVI.BALANCE formulas to extract periods
                // We're looking for periods, not accounts - we'll preload ALL BS accounts
                const balanceRegex = /XAVI\.BALANCE(?:CHANGE)?\s*\(\s*"?([^",)]+)"?\s*,\s*"?([^",)]*)"?\s*,\s*"?([^",)]+)"?/gi;
                
                for (let row = 0; row < formulas.length; row++) {
                    for (let col = 0; col < formulas[row].length; col++) {
                        const cell = formulas[row][col];
                        if (typeof cell === 'string' && cell.toUpperCase().includes('XAVI.BALANCE')) {
                            let match;
                            balanceRegex.lastIndex = 0;
                            while ((match = balanceRegex.exec(cell)) !== null) {
                                const toPeriodParam = match[3].replace(/"/g, '').trim();
                                
                                // Check if it's a literal period value
                                if (toPeriodParam && !toPeriodParam.includes('$') && !toPeriodParam.match(/^[A-Z]+\d+$/)) {
                                    periods.add(toPeriodParam);
                                } else if (toPeriodParam && (toPeriodParam.includes('$') || toPeriodParam.match(/^[A-Z]+\d+$/))) {
                                    // It's a cell reference - try to resolve it
                                    try {
                                        const cellRef = toPeriodParam;
                                        const refRange = sheet.getRange(cellRef);
                                        refRange.load(['values', 'formulas']);
                                        await context.sync();
                                        
                                        // Get the actual value from the referenced cell
                                        const cellValue = refRange.values[0][0];
                                        if (cellValue) {
                                            // Convert Excel date to period format if needed
                                            // If it's a date serial number, convert it
                                            let periodValue = cellValue;
                                            if (typeof cellValue === 'number' && cellValue > 1 && cellValue < 1000000) {
                                                // Looks like an Excel date serial - convert to Date
                                                const excelEpoch = new Date(1899, 11, 30);
                                                const date = new Date(excelEpoch.getTime() + cellValue * 24 * 60 * 60 * 1000);
                                                const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                                                periodValue = `${monthNames[date.getMonth()]} ${date.getFullYear()}`;
                                            } else if (cellValue instanceof Date) {
                                                const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                                                periodValue = `${monthNames[cellValue.getMonth()]} ${cellValue.getFullYear()}`;
                                            } else if (typeof cellValue === 'string') {
                                                // Already a string - might be in "Mon YYYY" format
                                                periodValue = cellValue.trim();
                                            }
                                            
                                            // Normalize to title case (e.g., "JAN 2025" → "Jan 2025")
                                            const parts = String(periodValue).split(/\s+/);
                                            if (parts.length === 2) {
                                                const month = parts[0];
                                                const year = parts[1];
                                                const normalizedMonth = month.charAt(0).toUpperCase() + month.slice(1).toLowerCase();
                                                periodValue = `${normalizedMonth} ${year}`;
                                            }
                                            
                                            if (periodValue && /^[A-Za-z]{3}\s+\d{4}$/.test(periodValue)) {
                                                periods.add(periodValue);
                                            }
                                        }
                                    } catch (resolveErr) {
                                        console.warn(`Could not resolve cell reference ${toPeriodParam}:`, resolveErr);
                                    }
                                }
                            }
                        }
                    }
                }
                
                return {
                    periods: Array.from(periods)
                };
            });
            
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
            
            updateLoading(
                `⚡ Preloading ALL Balance Sheet Accounts`,
                40,
                `Loading all BS accounts for ${formulaData.periods.length} period(s). This makes all formulas instant!`
            );
            
            // Preload ALL BS accounts for the identified periods
            // Using /batch/bs_preload (not targeted) - it loads ALL BS accounts, not just specific ones
            // This is just as fast as loading one account, and caches everything for instant subsequent lookups
            const preloadResponse = await fetch(`${getServerUrl()}/batch/bs_preload`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    periods: formulaData.periods,
                    subsidiary: '',  // Will use default/current subsidiary
                    department: '',
                    location: '',
                    class: '',
                    accountingBook: ''
                })
            });
            
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
                
                hideLoading();
                
                const accountCount = result.balances ? Object.keys(result.balances).length : 0;
                showToast({
                    title: '✅ Balance Sheet Ready!',
                    message: `All ${accountCount} Balance Sheet accounts preloaded for ${formulaData.periods.length} period(s). Your formulas will now resolve instantly!`,
                    type: 'success',
                    duration: 5000
                });
                
                console.log(`✅ AUTO-PRELOAD COMPLETE: ${accountCount} BS accounts × ${formulaData.periods.length} period(s) in ${result.elapsed_seconds?.toFixed(1)}s`);
            } else {
                const errorText = await preloadResponse.text();
                throw new Error(`Preload failed: ${preloadResponse.status} - ${errorText}`);
            }
            
        } catch (error) {
            console.error('Auto-preload error:', error);
            hideLoading();
            showToast({
                title: 'Auto-Preload Issue',
                message: 'Could not auto-preload. Use Smart Preload manually for faster results.',
                type: 'warning',
                duration: 8000
            });
        } finally {
            if (window.markAutoPreloadComplete) window.markAutoPreloadComplete();
        }
    }, 500); // Small delay to let formulas settle
}

