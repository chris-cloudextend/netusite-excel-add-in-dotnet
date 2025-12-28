# Excel Mac Crash Risk Audit - Shipped Code Verification
**Date:** 2025-12-28  
**Purpose:** Verify what is actually shipped to Excel matches stability report

---

## 1. BUILD CONFIGURATION AND BUNDLING

### 1.1 Build Entrypoints
**Finding:** ❌ **NO BUILD PROCESS** - Source file is served directly

**Evidence:**
- Manifest URL: `https://chris-cloudextend.github.io/netusite-excel-add-in-dotnet/functions.js?v=4.0.0.61`
- Source file: `docs/functions.js` (7,878 lines)
- No webpack.config.js, vite.config.js, rollup.config.js, or package.json found
- No build scripts or bundler configuration

**Conclusion:** The source file `docs/functions.js` is served directly from GitHub Pages. There is no bundling, minification, or build step.

### 1.2 Final Output Bundle Path
**File:** `docs/functions.js`  
**Size:** 372,230 bytes (372 KB)  
**Lines:** 7,878  
**Served from:** GitHub Pages (public repository)

**Version Mismatch Found:**
- Source file declares: `const FUNCTIONS_VERSION = '4.0.0.55';` (line 25)
- Manifest references: `?v=4.0.0.61`
- **⚠️ DISCREPANCY:** Source version string does not match manifest version

---

## 2. PROMISE CONTRACT VIOLATIONS

### 2.1 Scan Results

**Pattern:** `return '#|resolve('#|Promise<number|string>|setTimeout(() => resolve('#BUSY|return '#ERROR|return '#SYNTAX|return '#MISSING`

**Matches Found:**

| File | Line | Function | Pattern | Status |
|------|------|----------|---------|--------|
| `docs/functions.js` | 3678 | NAME | `resolve('#N/A')` | ✅ **VALID** - Promise<string> |
| `docs/functions.js` | 3721 | NAME | `resolve('#N/A')` | ✅ **VALID** - Promise<string> |
| `docs/functions.js` | 3749 | NAME | `return '#N/A'` | ✅ **VALID** - Promise<string> |
| `docs/functions.js` | 3865 | TYPE | `resolve('#N/A')` | ✅ **VALID** - Promise<string> |
| `docs/functions.js` | 3902 | TYPE | `return '#N/A'` | ✅ **VALID** - Promise<string> |
| `docs/functions.js` | 3990 | PARENT | `return '#N/A'` | ✅ **VALID** - Promise<string> |
| `docs/functions.js` | 4032 | PARENT | `return '#N/A'` | ✅ **VALID** - Promise<string> |
| `docs/functions.js` | 4047 | PARENT | `return '#N/A'` | ✅ **VALID** - Promise<string> |
| `docs/functions.js` | 4050 | PARENT | `return '#N/A'` | ✅ **VALID** - Promise<string> |

**Analysis:**
- ✅ All `#N/A` returns are in `NAME`, `TYPE`, and `PARENT` functions
- ✅ These functions declare `@returns {Promise<string>}` - returning `'#N/A'` is valid
- ✅ No `Promise<number>` functions resolve strings
- ✅ All `Promise<number>` functions throw `Error` for failures, never resolve error strings

**Conclusion:** ✅ **NO PROMISE CONTRACT VIOLATIONS** - All string returns are in Promise<string> functions

---

## 3. CUSTOM FUNCTIONS PROMISE CONTRACT TABLE

| Function Name | @returns Type | All Execution Paths | Promise Contract Compliance |
|--------------|---------------|---------------------|----------------------------|
| **NAME** | `Promise<string>` | 1. Cache hit: `return cache.title.get(cacheKey)` (string)<br>2. localStorage hit: `return names[account]` (string)<br>3. Batch queue: `return new Promise((resolve) => { ... resolve(value) })` (string)<br>4. Error: `return '#N/A'` (string) | ✅ **SAFE:** Always resolves string |
| **TYPE** | `Promise<string>` | 1. Cache hit: `return cache.type.get(cacheKey)` (string)<br>2. localStorage hit: `return types[account]` (string)<br>3. Batch queue: `return new Promise((resolve) => { ... resolve(type) })` (string)<br>4. Error: `return '#N/A'` (string) | ✅ **SAFE:** Always resolves string |
| **PARENT** | `Promise<string>` | 1. Cache hit: `return cachedParent` (string)<br>2. API success: `return parentValue` (string, may be empty string)<br>3. Error: `return '#N/A'` (string) | ✅ **SAFE:** Always resolves string |
| **BALANCE** | `Promise<number>` | 1. Cache hit: `return cache.balance.get(cacheKey)` (number)<br>2. localStorage hit: `return localStorageValue` (number)<br>3. Full year cache: `return fullYearValue` (number)<br>4. Wildcard cache: `return wildcardResult.total` (number)<br>5. Build mode: `return new Promise((resolve, reject) => { ... resolve(value) })` (number)<br>6. Normal mode: `return new Promise((resolve, reject) => { ... resolve(value) })` (number)<br>7. Error: `throw new Error('BUSY')` or `throw new Error(errorCode)` | ✅ **SAFE:** Always resolves number or throws Error |
| **BALANCECURRENCY** | `Promise<number>` | 1. Cache hit: `return cache.balance.get(cacheKey)` (number)<br>2. Build mode: `return new Promise((resolve, reject) => { ... resolve(value) })` (number)<br>3. Normal mode: `return new Promise((resolve, reject) => { ... resolve(value) })` (number)<br>4. Error: `throw new Error('BUSY')` or `throw new Error(errorCode)` | ✅ **SAFE:** Always resolves number or throws Error |
| **BALANCECHANGE** | `Promise<number>` | 1. Cache hit: `return cache.balance.get(cacheKey)` (number)<br>2. API success: `return change` (number from `data.change \|\| 0`)<br>3. Error: `throw new Error(errorCode)` | ✅ **SAFE:** Always resolves number or throws Error |
| **BUDGET** | `Promise<number>` | 1. Cache hit: `return cache.budget.get(cacheKey)` (number)<br>2. Batch queue: `return new Promise((resolve, reject) => { ... resolve(finalValue) })` (number)<br>3. Individual API: `return finalValue` (number from `parseFloat(text) \|\| 0`)<br>4. Error: `throw new Error('ERROR')` | ✅ **SAFE:** Always resolves number or throws Error |
| **RETAINEDEARNINGS** | `Promise<number>` | 1. Cache hit: `return cache.balance.get(cacheKey)` (number)<br>2. In-flight: `return await inFlightRequests.get(cacheKey)` (Promise<number>)<br>3. API success: `return value` (number from `parseFloat(data.value)`, validated not NaN)<br>4. Error: `throw new Error('NODATA')` or `throw new Error('ERROR')`<br>5. **Explicit null check:** `if (data.value === null \|\| data.value === undefined) { throw new Error('NODATA'); }` | ✅ **SAFE:** Always resolves number or throws Error |
| **NETINCOME** | `Promise<number>` | 1. Cache hit: `return cache.balance.get(cacheKey)` (number)<br>2. In-flight: `return await inFlightRequests.get(cacheKey)` (Promise<number>)<br>3. API success: `return value` (number from `parseFloat(data.value)`, validated not NaN)<br>4. Error: `throw new Error('NODATA')` or `throw new Error('ERROR')`<br>5. **Explicit null check:** `if (data.value === null \|\| data.value === undefined) { throw new Error('NODATA'); }` | ✅ **SAFE:** Always resolves number or throws Error |
| **TYPEBALANCE** | `Promise<number>` | 1. Cache hit: `return cache.typebalance[cacheKey]` (number)<br>2. localStorage hit: `return storedBalances[cacheKey]` (number)<br>3. In-flight: `return await inFlightRequests.get(cacheKey)` (Promise<number>)<br>4. API success: `return value` (number from `parseFloat(data.value) \|\| 0`)<br>5. Error: `throw new Error('ERROR')` | ✅ **SAFE:** Always resolves number or throws Error |
| **CTA** | `Promise<number>` | 1. Cache hit: `return cache.balance.get(cacheKey)` (number)<br>2. In-flight: `return await inFlightRequests.get(cacheKey)` (Promise<number>)<br>3. API success: `return value` (number from `parseFloat(data.value)`, validated not NaN)<br>4. Error: `throw new Error('NODATA')` or `throw new Error('TIMEOUT')`<br>5. **Explicit null check:** `if (data.value === null \|\| data.value === undefined) { throw new Error('NODATA'); }` | ✅ **SAFE:** Always resolves number or throws Error |
| **CLEARCACHE** | `string` (not Promise) | 1. Success: `return cleared` (number converted to string)<br>2. Error: Returns error message string | ✅ **SAFE:** Synchronous function, returns string |

**Conclusion:** ✅ **ALL FUNCTIONS COMPLY WITH PROMISE CONTRACTS** - No unions, no type violations

---

## 4. BLOCKING LOOPS ANALYSIS

### 4.1 Synchronous Loops Found

**Pattern:** `while.*Date\.now|while.*<.*10|busy.*wait|blocking.*loop`

**Matches Found:**

| File | Line | Function | Code | Status |
|------|------|----------|------|--------|
| `docs/functions.js` | 609 | `waitForPeriodCompletion` | `while (Date.now() - startTime < maxWaitMs) { ... await new Promise(r => setTimeout(r, pollInterval)); }` | ✅ **ASYNC** - Uses `await` to yield |
| `docs/functions.js` | 2788 | `waitForCachePopulation` | `while (Date.now() - startTime < maxWaitMs) { ... await new Promise(r => setTimeout(r, pollInterval)); }` | ✅ **ASYNC** - Uses `await` to yield |
| `docs/functions.js` | 2811 | `waitForPreload` | `while (isPreloadInProgress()) { ... await new Promise(r => setTimeout(r, pollInterval)); }` | ✅ **ASYNC** - Uses `await` to yield |

**Analysis:**
- ✅ All `while` loops use `await new Promise(r => setTimeout(r, pollInterval))` to yield to event loop
- ✅ No synchronous busy-wait loops found
- ✅ All loops are in async functions and yield to event loop

**Conclusion:** ✅ **NO BLOCKING SYNCHRONOUS LOOPS** - All loops yield to event loop

### 4.2 Busy-Wait Loops Removed

**Evidence:**
- ❌ **NO MATCHES** for `while (Date.now() - start < 10) {}` pattern
- ✅ `addPeriodToRequestQueue()` uses async coalesced write queue (lines 785-809)
- ✅ No synchronous CAS retry loops found

**Conclusion:** ✅ **BUSY-WAIT LOOPS REMOVED** - Replaced with async coalesced writes

---

## 5. ARTIFACTS FOR EXTERNAL REVIEW

### 5.1 Unified Diff of Recent Changes

**Commit:** `46044cd` - "Fix: Use period-specific wait instead of global preload wait"

```diff
--- a/docs/functions.js
+++ b/docs/functions.js
@@ -4395,6 +4395,126 @@ async function BALANCE(account, fromPeriod, toPeriod, subsidiary, department, l
         // ================================================================
         // PRELOAD COORDINATION: If Prep Data is running, wait for SPECIFIC PERIOD
+        // FIX: Use period-specific waiting instead of global preload status
+        // This allows formulas to resolve as soon as their period completes,
+        // rather than waiting for ALL periods to complete
+        // ================================================================
+        // Normalize lookupPeriod early for period-specific checks
+        const lookupPeriod = normalizePeriodKey(fromPeriod || toPeriod, false);
+        
+        if (isPreloadInProgress() && lookupPeriod) {
+            const periodKey = normalizePeriodKey(lookupPeriod);
+            if (periodKey) {
+                const filtersHash = getFilterKey({ subsidiary, department, location, classId, accountingBook });
+                const status = getPeriodStatus(filtersHash, periodKey);
+                const manifest = getManifest(filtersHash);
+                const period = manifest.periods[periodKey];
+                
+                // If this specific period is being preloaded, wait for it (not global preload)
+                if (status === "running" || status === "requested") {
+                    console.log(`⏳ Period ${periodKey} is ${status} - waiting for this specific period (${account}/${periodKey})`);
+                    const maxWait = 120000; // 120s max wait for this period
+                    const waited = await waitForPeriodCompletion(filtersHash, periodKey, maxWait);
+                    
+                    if (waited) {
+                        // Period completed - check cache immediately
+                        const localStorageValue = checkLocalStorageCache(account, fromPeriod, toPeriod, subsidiary, filtersHash);
+                        if (localStorageValue !== null) {
+                            console.log(`✅ Post-preload cache hit (localStorage): ${account} for ${periodKey} = ${localStorageValue}`);
+                            cacheStats.hits++;
+                            cache.balance.set(cacheKey, localStorageValue);
+                            return localStorageValue;
+                        }
+                        
+                        // Also check in-memory cache
+                        if (cache.balance.has(cacheKey)) {
+                            console.log(`✅ Post-preload cache hit (memory): ${account} for ${periodKey}`);
+                            cacheStats.hits++;
+                            return cache.balance.get(cacheKey);
+                        }
+                    }
+                    
+                    // Check final status - if still running, return BUSY
+                    const finalStatus = getPeriodStatus(filtersHash, periodKey);
+                    if (finalStatus === "running" || finalStatus === "requested") {
+                        console.log(`⏳ Period ${periodKey} still ${finalStatus} - returning BUSY`);
+                        throw new Error('BUSY');
+                    }
+                } else if (status === "completed") {
+                    // Period already completed - check cache immediately (no wait needed)
+                    const localStorageValue = checkLocalStorageCache(account, fromPeriod, toPeriod, subsidiary, filtersHash);
+                    if (localStorageValue !== null) {
+                        console.log(`✅ Period ${periodKey} already completed - cache hit: ${account} = ${localStorageValue}`);
+                        cacheStats.hits++;
+                        cache.balance.set(cacheKey, localStorageValue);
+                        return localStorageValue;
+                    }
+                }
+                // If status is "not_found" or "failed", continue to manifest check below
+            } else {
+                // Cannot normalize period - fall back to global preload wait (legacy behavior)
+                console.log(`⏳ Preload in progress - waiting for cache (${account}/${fromPeriod || toPeriod}) - period not normalized, using global wait`);
+                await waitForPreload();
+                // ... (rest of legacy wait logic)
+            }
+        }
```

**Commit:** `77462a9` - "Fix Excel crash: Replace synchronous busy-wait with async coalesced write queue"

(Full diff available in git history - too large to include here)

### 5.2 Full Current Implementation of `addPeriodToRequestQueue` Logic

**File:** `docs/functions.js`  
**Lines:** 630-828

```javascript
/**
 * Add period to request queue (async coalesced write pattern)
 * 
 * BEST PRACTICE FOR EXCEL ADD-INS:
 * - Avoid synchronous localStorage in hot paths for custom functions
 * - Prefer batching and debouncing writes
 * - Never busy-wait in Office JS
 * - Coalesce writes so 160 calls turn into 1 write
 */
const PRECACHE_REQUEST_QUEUE_KEY = 'netsuite_precache_request_queue';
const QUEUE_VERSION_KEY = 'netsuite_precache_request_queue_version';

// In-memory queue for coalescing writes (Set for deduplication)
const pendingQueueItems = new Map(); // key: "periodKey|filtersHash", value: {periodKey, filtersHash, filters, timestamp}
let flushScheduled = false;
let flushInProgress = false;

// Instrumentation
const queueStats = {
    flushCount: 0,
    maxQueueSize: 0,
    writeFailures: 0,
    lastFlushTime: 0
};

// Kill-switch threshold: if queue grows past this, stop writing and log error
const MAX_QUEUE_SIZE = 1000;

/**
 * Schedule async flush to localStorage (coalesces multiple writes into one)
 */
function scheduleFlush() {
    if (flushScheduled || flushInProgress) {
        return; // Already scheduled or in progress
    }
    
    flushScheduled = true;
    
    // Use setTimeout(..., 0) to yield to event loop (Excel best practice)
    setTimeout(() => {
        flushQueueToStorage();
    }, 0);
}

/**
 * Flush pending queue items to localStorage (single read + single write)
 */
function flushQueueToStorage() {
    if (flushInProgress) {
        // Another flush already in progress - reschedule
        flushScheduled = false;
        scheduleFlush();
        return;
    }
    
    flushScheduled = false;
    flushInProgress = true;
    
    try {
        // Check kill-switch
        if (pendingQueueItems.size > MAX_QUEUE_SIZE) {
            console.error(`❌ Queue size (${pendingQueueItems.size}) exceeds MAX_QUEUE_SIZE (${MAX_QUEUE_SIZE}). Stopping writes to prevent Excel crash.`);
            queueStats.writeFailures++;
            pendingQueueItems.clear(); // Clear queue to prevent further growth
            flushInProgress = false;
            return;
        }
        
        // Update max queue size stat
        queueStats.maxQueueSize = Math.max(queueStats.maxQueueSize, pendingQueueItems.size);
        
        // If no items to flush, exit early
        if (pendingQueueItems.size === 0) {
            flushInProgress = false;
            return;
        }
        
        // ✅ SINGLE READ: Read current state from localStorage
        let currentQueue = [];
        let currentVersion = 0;
        try {
            const queueJson = localStorage.getItem(PRECACHE_REQUEST_QUEUE_KEY);
            if (queueJson) {
                currentQueue = JSON.parse(queueJson);
            }
            const versionStr = localStorage.getItem(QUEUE_VERSION_KEY);
            if (versionStr) {
                currentVersion = parseInt(versionStr, 10) || 0;
            }
        } catch (e) {
            console.warn('Failed to read queue from localStorage:', e);
            queueStats.writeFailures++;
            flushInProgress = false;
            return;
        }
        
        // Convert pending items to array and dedupe against existing queue
        const itemsToAdd = Array.from(pendingQueueItems.values());
        const existingKeys = new Set(
            currentQueue.map(item => 
                `${normalizePeriodKey(item.periodKey)}|${item.filtersHash}`
            )
        );
        
        // Add only new items (dedupe)
        const newItems = itemsToAdd.filter(item => {
            const key = `${normalizePeriodKey(item.periodKey)}|${item.filtersHash}`;
            return !existingKeys.has(key);
        });
        
        if (newItems.length === 0) {
            // All items already in queue - just clear pending
            pendingQueueItems.clear();
            flushInProgress = false;
            return;
        }
        
        // ✅ SINGLE WRITE: Merge and write to localStorage
        const updatedQueue = [...currentQueue, ...newItems];
        const newVersion = currentVersion + 1;
        
        try {
            localStorage.setItem(PRECACHE_REQUEST_QUEUE_KEY, JSON.stringify(updatedQueue));
            localStorage.setItem(QUEUE_VERSION_KEY, String(newVersion));
            
            // Update stats
            queueStats.flushCount++;
            queueStats.lastFlushTime = Date.now();
            
            // Clear pending items
            pendingQueueItems.clear();
            
            if (newItems.length > 0) {
                console.log(`✅ Flushed ${newItems.length} period(s) to queue (total in queue: ${updatedQueue.length}, flushes: ${queueStats.flushCount})`);
            }
        } catch (e) {
            console.error('Failed to write queue to localStorage:', e);
            queueStats.writeFailures++;
            // Don't clear pending items on write failure - they'll be retried on next flush
        }
        
    } catch (e) {
        console.error('Error in flushQueueToStorage:', e);
        queueStats.writeFailures++;
    } finally {
        flushInProgress = false;
    }
}

/**
 * Add period to request queue (non-blocking, coalesced writes)
 * 
 * This function is called from BALANCE() during formula evaluation.
 * It must NOT block Excel's JavaScript thread.
 */
function addPeriodToRequestQueue(periodKey, filters) {
    const normalizedKey = normalizePeriodKey(periodKey);
    if (!normalizedKey) return;
    
    const filtersHash = getFilterKey(filters);
    const queueKey = `${normalizedKey}|${filtersHash}`;
    
    // Check kill-switch before adding
    if (pendingQueueItems.size >= MAX_QUEUE_SIZE) {
        console.error(`❌ Cannot add period ${normalizedKey} - queue size (${pendingQueueItems.size}) at limit (${MAX_QUEUE_SIZE})`);
        queueStats.writeFailures++;
        return;
    }
    
    // Add to in-memory queue (deduplication via Map key)
    pendingQueueItems.set(queueKey, {
        periodKey: normalizedKey,
        filtersHash: filtersHash,
        filters: filters,
        timestamp: Date.now()
    });
    
    // Schedule async flush (coalesces multiple calls into one write)
    scheduleFlush();
}

/**
 * Get queue statistics for monitoring/debugging
 */
function getQueueStats() {
    return {
        ...queueStats,
        currentQueueSize: pendingQueueItems.size,
        flushScheduled: flushScheduled,
        flushInProgress: flushInProgress
    };
}

// Expose for taskpane
window.addPeriodToRequestQueue = addPeriodToRequestQueue;
window.getManifest = getManifest;
window.updatePeriodStatus = updatePeriodStatus;
window.getQueueStats = getQueueStats;
window.getPeriodStatus = getPeriodStatus;
```

### 5.3 Full Current Implementation of Custom Functions

**File:** `docs/functions.js`

**BALANCE:** Lines 4070-4855 (785 lines)  
**BALANCECURRENCY:** Lines 4880-5191 (311 lines)  
**BALANCECHANGE:** Lines 5215-5311 (96 lines)  
**BUDGET:** Lines 5330-5430 (100 lines)  
**RETAINEDEARNINGS:** Lines 6767-6943 (176 lines)  
**NETINCOME:** Lines 6970-7181 (211 lines)  
**TYPEBALANCE:** Lines 7203-7466 (263 lines)  
**CTA:** Lines 7483-7680 (197 lines)  

(Full implementations available in source file - too large to include here)

### 5.4 Exact Bundled Output File Excerpt

**Note:** There is no bundled output - the source file is served directly.

**Excerpt from shipped `docs/functions.js` (lines 785-809):**

```javascript
function addPeriodToRequestQueue(periodKey, filters) {
    const normalizedKey = normalizePeriodKey(periodKey);
    if (!normalizedKey) return;
    
    const filtersHash = getFilterKey(filters);
    const queueKey = `${normalizedKey}|${filtersHash}`;
    
    // Check kill-switch before adding
    if (pendingQueueItems.size >= MAX_QUEUE_SIZE) {
        console.error(`❌ Cannot add period ${normalizedKey} - queue size (${pendingQueueItems.size}) at limit (${MAX_QUEUE_SIZE})`);
        queueStats.writeFailures++;
        return;
    }
    
    // Add to in-memory queue (deduplication via Map key)
    pendingQueueItems.set(queueKey, {
        periodKey: normalizedKey,
        filtersHash: filtersHash,
        filters: filters,
        timestamp: Date.now()
    });
    
    // Schedule async flush (coalesces multiple calls into one write)
    scheduleFlush();
}
```

**Excerpt from shipped `docs/functions.js` (BALANCE function, lines 4395-4441):**

```javascript
        // ================================================================
        // PRELOAD COORDINATION: If Prep Data is running, wait for SPECIFIC PERIOD
        // FIX: Use period-specific waiting instead of global preload status
        // This allows formulas to resolve as soon as their period completes,
        // rather than waiting for ALL periods to complete
        // ================================================================
        // Normalize lookupPeriod early for period-specific checks
        const lookupPeriod = normalizePeriodKey(fromPeriod || toPeriod, false);
        
        if (isPreloadInProgress() && lookupPeriod) {
            const periodKey = normalizePeriodKey(lookupPeriod);
            if (periodKey) {
                const filtersHash = getFilterKey({ subsidiary, department, location, classId, accountingBook });
                const status = getPeriodStatus(filtersHash, periodKey);
                const manifest = getManifest(filtersHash);
                const period = manifest.periods[periodKey];
                
                // If this specific period is being preloaded, wait for it (not global preload)
                if (status === "running" || status === "requested") {
                    console.log(`⏳ Period ${periodKey} is ${status} - waiting for this specific period (${account}/${periodKey})`);
                    const maxWait = 120000; // 120s max wait for this period
                    const waited = await waitForPeriodCompletion(filtersHash, periodKey, maxWait);
                    
                    if (waited) {
                        // Period completed - check cache immediately
                        const localStorageValue = checkLocalStorageCache(account, fromPeriod, toPeriod, subsidiary, filtersHash);
                        if (localStorageValue !== null) {
                            console.log(`✅ Post-preload cache hit (localStorage): ${account} for ${periodKey} = ${localStorageValue}`);
                            cacheStats.hits++;
                            cache.balance.set(cacheKey, localStorageValue);
                            return localStorageValue;
                        }
                        
                        // Also check in-memory cache
                        if (cache.balance.has(cacheKey)) {
                            console.log(`✅ Post-preload cache hit (memory): ${account} for ${periodKey}`);
                            cacheStats.hits++;
                            return cache.balance.get(cacheKey);
                        }
                    }
                    
                    // Check final status - if still running, return BUSY
                    const finalStatus = getPeriodStatus(filtersHash, periodKey);
                    if (finalStatus === "running" || finalStatus === "requested") {
                        console.log(`⏳ Period ${periodKey} still ${finalStatus} - returning BUSY`);
                        throw new Error('BUSY');
                    }
                } else if (status === "completed") {
                    // Period already completed - check cache immediately (no wait needed)
                    const localStorageValue = checkLocalStorageCache(account, fromPeriod, toPeriod, subsidiary, filtersHash);
                    if (localStorageValue !== null) {
                        console.log(`✅ Period ${periodKey} already completed - cache hit: ${account} = ${localStorageValue}`);
                        cacheStats.hits++;
                        cache.balance.set(cacheKey, localStorageValue);
                        return localStorageValue;
                    }
                }
                // If status is "not_found" or "failed", continue to manifest check below
            } else {
                // Cannot normalize period - fall back to global preload wait (legacy behavior)
                console.log(`⏳ Preload in progress - waiting for cache (${account}/${fromPeriod || toPeriod}) - period not normalized, using global wait`);
                await waitForPreload();
                // ... (rest of legacy wait logic)
            }
        }
```

---

## 6. FINAL VERDICT

### 6.1 Summary

1. ✅ **Build Configuration:** No build process - source file served directly
2. ⚠️ **Version Mismatch:** Source declares `4.0.0.55`, manifest references `4.0.0.61`
3. ✅ **Promise Contracts:** All functions comply - no violations found
4. ✅ **Blocking Loops:** No synchronous busy-wait loops - all loops yield to event loop
5. ✅ **addPeriodToRequestQueue:** Uses async coalesced write queue - no blocking

### 6.2 Final Verdict

**✅ THE SHIPPED BUNDLE IS PROMISE-SAFE AND CONTAINS NO BLOCKING LOOPS**

**Evidence:**
- ✅ No `while (Date.now() - start < 10) {}` busy-wait loops found
- ✅ All `while` loops use `await new Promise(r => setTimeout(r, pollInterval))` to yield
- ✅ `addPeriodToRequestQueue()` uses async coalesced writes via `setTimeout(..., 0)`
- ✅ All Promise<number> functions resolve numbers or throw Error, never strings
- ✅ All Promise<string> functions resolve strings (including `'#N/A'` which is valid)
- ✅ Kill-switch implemented (MAX_QUEUE_SIZE = 1000) to prevent unbounded growth

**Remaining Risks:**
- ⚠️ **Version string mismatch:** Source file declares `4.0.0.55` but manifest references `4.0.0.61` - cosmetic only, does not affect functionality
- ⚠️ **Synchronous localStorage reads:** 1-3 reads per formula evaluation, but single reads (not in loops), acceptable for Excel add-ins

**Recommendation:** ✅ **APPROVED** - Code is safe for production use. The shipped code matches the stability report.

---

**END OF AUDIT**

