// ============================================================================
// EXTRACTED FROM: docs/functions.js lines 1317-1450 (partial)
// Function: runBuildModeBatch()
// Purpose: Processes queued formulas in build mode
// CRITICAL: Check if this function checks cache before making API calls
// ============================================================================

async function runBuildModeBatch() {
    const batchStartTime = Date.now();
    const pending = buildModePending.slice();
    buildModePending = [];
    
    if (pending.length === 0) return;
    
    console.log(`🔄 Processing ${pending.length} formulas...`);
    broadcastStatus(`Processing ${pending.length} formulas...`, 5, 'info');
    
    // ================================================================
    // SEPARATE REQUESTS BY TYPE:
    // 1. BALANCECURRENCY requests - must use individual /balancecurrency calls (batch doesn't support currency)
    // 2. CUMULATIVE BS queries - need direct /balance API calls (cumulative from inception)
    // 3. Regular BALANCE requests - can use batch endpoints
    // ================================================================
    const balanceCurrencyItems = [];
    const cumulativeItems = [];
    const regularItems = [];
    
    for (const item of pending) {
        // Check if this is a BALANCECURRENCY request
        const isBalanceCurrency = item.cacheKey && item.cacheKey.includes('"type":"balancecurrency"') ||
                                 (item.params && 'currency' in item.params && item.params.currency);
        
        if (isBalanceCurrency) {
            balanceCurrencyItems.push(item);
        } else {
            const { fromPeriod, toPeriod } = item.params;
            if ((!fromPeriod || fromPeriod === '') && toPeriod && toPeriod !== '') {
                cumulativeItems.push(item);
            } else {
                regularItems.push(item);
            }
        }
    }
    
    // Process BALANCECURRENCY requests FIRST (they need individual API calls)
    if (balanceCurrencyItems.length > 0) {
        console.log(`💱 BUILD MODE: Processing ${balanceCurrencyItems.length} BALANCECURRENCY requests individually (batch endpoint doesn't support currency)`);
        broadcastStatus(`Processing ${balanceCurrencyItems.length} currency conversion(s)...`, 10, 'info');
        
        // Process each BALANCECURRENCY request individually
        for (const item of balanceCurrencyItems) {
            const { account, fromPeriod, toPeriod, subsidiary, currency, department, location, classId, accountingBook } = item.params;
            const cacheKey = item.cacheKey;
            
            try {
                // Check cache first
                if (cache.balance.has(cacheKey)) {
                    const cachedValue = cache.balance.get(cacheKey);
                    console.log(`   ✅ BALANCECURRENCY cache hit: ${account} = ${cachedValue}`);
                    item.resolve(cachedValue);
                    continue;
                }
                
                // ... continues with API call ...
            }
        }
    }
    
    // NOTE: This is a partial extract. The full function also processes:
    // - cumulativeItems (BS accounts)
    // - regularItems (P&L accounts)
    // 
    // QUESTION FOR REVIEW: Does the batch processor check checkLocalStorageCache() 
    // before making API calls for cumulativeItems and regularItems?
}

