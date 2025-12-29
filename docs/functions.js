/**
 * XAVI for NetSuite - Excel Custom Functions
 * 
 * Copyright (c) 2025 Celigo, Inc.
 * All rights reserved.
 * 
 * This source code is proprietary and confidential. Unauthorized copying,
 * modification, distribution, or use of this software, via any medium,
 * is strictly prohibited without the express written permission of Celigo, Inc.
 * 
 * For licensing inquiries, contact: legal@celigo.com
 * 
 * ---
 * 
 * KEY DESIGN PRINCIPLES:
 * 1. Cache AGGRESSIVELY - never clear unless user clicks button
 * 2. Batch CONSERVATIVELY - small batches, long delays
 * 3. Single cell updates = individual API call (fast)
 * 4. Bulk updates (drag/insert row) = smart batching
 * 5. Deduplication - never make same request twice
 */

const SERVER_URL = 'https://netsuite-proxy.chris-corcoran.workers.dev';
const REQUEST_TIMEOUT = 30000;  // 30 second timeout for NetSuite queries
const FUNCTIONS_VERSION = '4.0.0.97';  // FIX: Add missing closing brace for cumulativeRequests if block
console.log(`📦 XAVI functions.js loaded - version ${FUNCTIONS_VERSION}`);

// ============================================================================
// LRU CACHE - Bounded cache with Least Recently Used eviction
// Prevents memory growth over long Excel sessions
// Must be defined early because it's used for manifestCache and statusChangeCache
// ============================================================================
class LRUCache {
    constructor(maxSize = 5000, name = 'cache') {
        this.maxSize = maxSize;
        this.name = name;
        this.cache = new Map();
    }
    
    get(key) {
        if (!this.cache.has(key)) return undefined;
        // Move to end (most recently used)
        const value = this.cache.get(key);
        this.cache.delete(key);
        this.cache.set(key, value);
        return value;
    }
    
    set(key, value) {
        // Delete first to update position if exists
        if (this.cache.has(key)) {
            this.cache.delete(key);
        }
        this.cache.set(key, value);
        
        // Evict oldest entries if over limit
        if (this.cache.size > this.maxSize) {
            const evictCount = Math.floor(this.maxSize * 0.1); // Evict 10%
            let evicted = 0;
            for (const oldKey of this.cache.keys()) {
                if (evicted >= evictCount) break;
                this.cache.delete(oldKey);
                evicted++;
            }
            console.log(`🗑️ ${this.name}: Evicted ${evicted} old entries (size: ${this.cache.size})`);
        }
    }
    
    has(key) {
        return this.cache.has(key);
    }
    
    delete(key) {
        return this.cache.delete(key);
    }
    
    clear() {
        this.cache.clear();
    }
    
    get size() {
        return this.cache.size;
    }
    
    keys() {
        return this.cache.keys();
    }
    
    entries() {
        return this.cache.entries();
    }
    
    // For iteration support
    [Symbol.iterator]() {
        return this.cache[Symbol.iterator]();
    }
    
    /**
     * Atomic check-and-set for in-flight request tracking
     * Returns existing value if key exists, otherwise sets and returns the new value
     * This prevents race conditions where two concurrent calls both pass has() check
     */
    getOrSet(key, valueFactory) {
        if (this.cache.has(key)) {
            // Move to end (most recently used) and return existing
            const value = this.cache.get(key);
            this.cache.delete(key);
            this.cache.set(key, value);
            return { exists: true, value };
        }
        // Create new value and store
        const newValue = valueFactory();
        this.set(key, newValue);
        return { exists: false, value: newValue };
    }
}

// ============================================================================
// UTILITY: Expand period range from "Jan 2025" to "Dec 2025" → all 12 months
// Must be defined early because it's used in batch processing
// ============================================================================
function expandPeriodRangeFromTo(fromPeriod, toPeriod) {
    if (!fromPeriod) {
        return [];
    }
    
            const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 
                               'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    
    // Helper: Check if a period is year-only (e.g., "2024")
    const isYearOnly = (period) => {
        if (!period) return false;
        const str = String(period).trim();
        return /^\d{4}$/.test(str);
    };
    
    // Helper: Expand year-only to (Jan YYYY, Dec YYYY)
    const expandYear = (year) => {
        return { fromMonth: 0, toMonth: 11, year: parseInt(year) };
    };
    
    // Helper: Parse "Mon YYYY" format
    const parseMonthYear = (period) => {
        const match = String(period).match(/^([A-Za-z]+)\s+(\d{4})$/);
        if (!match) return null;
            const monthIndex = monthNames.findIndex(m => m === match[1]);
            if (monthIndex === -1) return null;
            return { month: monthIndex, year: parseInt(match[2]) };
        };
        
    try {
        // CASE 1: Both are year-only (e.g., "2024", "2024" or "2023", "2025")
        if (isYearOnly(fromPeriod) && isYearOnly(toPeriod)) {
            const fromYear = parseInt(fromPeriod);
            const toYear = parseInt(toPeriod);
            const result = [];
            
            for (let y = fromYear; y <= toYear; y++) {
                for (let m = 0; m <= 11; m++) {
                    result.push(`${monthNames[m]} ${y}`);
                }
            }
            console.log(`   📅 Year-only expansion: ${fromPeriod} to ${toPeriod} → ${result.length} months`);
            return result;
        }
        
        // CASE 2: From is year-only, to is month (expand from Jan of year to the to month)
        if (isYearOnly(fromPeriod) && !isYearOnly(toPeriod)) {
            const fromYear = parseInt(fromPeriod);
            const to = parseMonthYear(toPeriod);
            if (to) {
                const result = [];
                let y = fromYear, m = 0;
                while (y < to.year || (y === to.year && m <= to.month)) {
                    result.push(`${monthNames[m]} ${y}`);
                    m++;
                    if (m > 11) { m = 0; y++; }
                }
                return result;
            }
        }
        
        // CASE 3: From is month, to is year-only (expand from month to Dec of year)
        if (!isYearOnly(fromPeriod) && isYearOnly(toPeriod)) {
            const from = parseMonthYear(fromPeriod);
            const toYear = parseInt(toPeriod);
            if (from) {
                const result = [];
                let y = from.year, m = from.month;
                while (y < toYear || (y === toYear && m <= 11)) {
                    result.push(`${monthNames[m]} ${y}`);
                    m++;
                    if (m > 11) { m = 0; y++; }
                }
                return result;
            }
        }
        
        // CASE 4: Same period (single period or same year)
        if (!toPeriod || fromPeriod === toPeriod) {
            // If it's year-only, expand to 12 months
            if (isYearOnly(fromPeriod)) {
                const year = parseInt(fromPeriod);
                const result = monthNames.map(m => `${m} ${year}`);
                console.log(`   📅 Single year expansion: ${fromPeriod} → ${result.length} months`);
                return result;
            }
            return [fromPeriod];
        }
        
        // CASE 5: Both are "Mon YYYY" format
        const from = parseMonthYear(fromPeriod);
        const to = parseMonthYear(toPeriod);
        
        if (!from || !to) {
            // Can't parse - return original periods
            console.warn(`   ⚠️ Could not parse period range: ${fromPeriod} to ${toPeriod}`);
            return [fromPeriod, toPeriod];
        }
        
        // Generate all months in range
        const result = [];
        let currentMonth = from.month;
        let currentYear = from.year;
        
        while (currentYear < to.year || (currentYear === to.year && currentMonth <= to.month)) {
            result.push(`${monthNames[currentMonth]} ${currentYear}`);
            currentMonth++;
            if (currentMonth > 11) {
                currentMonth = 0;
                currentYear++;
            }
        }
        
        return result;
        
    } catch (error) {
        console.error('Error expanding period range:', error);
        return [fromPeriod, toPeriod];
    }
}

// ============================================================================
// SAFE LOCALSTORAGE - Handles quota exceeded errors gracefully
// ============================================================================
const STORAGE_QUOTA_WARNING_LOGGED = { warned: false };

function safeLocalStorageSet(key, value) {
    try {
        localStorage.setItem(key, value);
        return true;
    } catch (e) {
        // QuotaExceededError - localStorage is full
        if (e.name === 'QuotaExceededError' || e.code === 22) {
            if (!STORAGE_QUOTA_WARNING_LOGGED.warned) {
                console.warn('⚠️ localStorage quota exceeded - attempting cleanup');
                STORAGE_QUOTA_WARNING_LOGGED.warned = true;
            }
            
            // Try to free space by removing old cache data
            const keysToEvict = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                // Only evict cache keys, not settings/state
                if (k && (k.includes('_cache') || k.includes('_timestamp'))) {
                    keysToEvict.push(k);
                }
            }
            
            // Evict oldest cache entries (up to 5 keys)
            const toRemove = keysToEvict.slice(0, 5);
            toRemove.forEach(k => {
                try { localStorage.removeItem(k); } catch (e2) {}
            });
            
            if (toRemove.length > 0) {
                console.log(`🗑️ Evicted ${toRemove.length} cache entries to free space`);
                
                // Retry the set
                try {
                    localStorage.setItem(key, value);
                    return true;
                } catch (e3) {
                    console.error('❌ localStorage still full after eviction');
                    return false;
                }
            }
        }
        // Other error - ignore silently
        return false;
    }
}

function safeLocalStorageGet(key) {
    try {
        return localStorage.getItem(key);
    } catch (e) {
        return null;
    }
}

// ============================================================================
// STATUS BROADCAST - Communicate progress to taskpane via localStorage
// ============================================================================
function broadcastStatus(message, progress = 0, type = 'info') {
    safeLocalStorageSet('netsuite_status', JSON.stringify({
        message,
        progress,
        type,
        timestamp: Date.now()
    }));
}

function clearStatus() {
    try {
        localStorage.removeItem('netsuite_status');
    } catch (e) {}
}

// ============================================================================
// TOAST BROADCAST - Send toast notifications to taskpane via localStorage
// ============================================================================
let toastIdCounter = 0;

function broadcastToast(title, message, type = 'info', duration = 5000) {
    // INVERTED LOGIC: Only show toasts when explicitly enabled
    // This prevents toasts from appearing during sheet open auto-recalculation
    // Toasts are only shown when 'netsuite_show_toasts' is explicitly set to 'true'
    const showToastsFlag = localStorage.getItem('netsuite_show_toasts');
    if (showToastsFlag !== 'true') {
        console.log(`🔕 Toast suppressed (not explicitly enabled): ${title}`);
        return null; // Return null to indicate no toast was created
    }
    
    try {
        const toastId = `toast-${++toastIdCounter}-${Date.now()}`;
        localStorage.setItem('netsuite_toast', JSON.stringify({
            id: toastId,
            title,
            message,
            type,
            duration,
            timestamp: Date.now()
        }));
        return toastId;
    } catch (e) {
        console.warn('Could not broadcast toast:', e);
        return null;
    }
}

function updateBroadcastToast(toastId, title, message, type) {
    try {
        localStorage.setItem('netsuite_toast_update', JSON.stringify({
            id: toastId,
            title,
            message,
            type,
            timestamp: Date.now()
        }));
    } catch (e) {}
}

function removeBroadcastToast(toastId) {
    try {
        localStorage.setItem('netsuite_toast_remove', JSON.stringify({
            id: toastId,
            timestamp: Date.now()
        }));
    } catch (e) {}
}

// ============================================================================
// BS PRELOAD SUGGESTION - Auto-suggest when BS queries are slow
// This bypasses the normal toast suppression for important performance tips
// ============================================================================
let bsSlowQueryCount = 0;          // Track consecutive slow BS queries
let lastBsPreloadSuggestion = 0;   // Prevent spamming suggestions
const BS_SLOW_THRESHOLD_MS = 30000; // 30 seconds = slow query
const BS_SUGGESTION_COOLDOWN_MS = 300000; // Only suggest every 5 minutes

// ============================================================================
// BS FORMULA DETECTION & USER GUIDANCE
// Proactively guide users when they're entering BS formulas
// ============================================================================
let bsFormulaEducationShown = false;  // Only show "BS accounts are slow" once per session
let bsBuildModeWarningShown = false;  // Only show BUILD MODE warning once
let totalBSFormulasQueued = 0;        // Track total BS formulas this session
const BS_MULTI_FORMULA_THRESHOLD = 3; // Show warning after this many BS formulas queued

/**
 * Detect if an account is Balance Sheet type.
 * Used for early detection and user guidance.
 */
const BS_ACCOUNT_TYPES = ['Bank', 'AcctRec', 'OthCurrAsset', 'FixedAsset', 'OthAsset', 
                          'AcctPay', 'CredCard', 'OthCurrLiab', 'LongTermLiab', 'DeferRevenue',
                          'Equity', 'RetainedEarnings', 'UnbilledRec'];

/**
 * Check if a request is for a point-in-time (cumulative) query.
 * Point-in-time queries have no fromPeriod (cumulative from inception).
 * Period activity queries have both fromPeriod and toPeriod.
 */
function isCumulativeRequest(fromPeriod) {
    return !fromPeriod || fromPeriod === '';
}

/**
 * Extract actual value from Excel Range object or primitive value.
 * Excel custom functions with @requiresAddress receive Range objects for cell references.
 * This function handles all possible Range object formats.
 * 
 * @param {any} value - The value to extract (may be Range object, string, number, etc.)
 * @param {string} paramName - Name of parameter (for logging)
 * @returns {string} - Extracted string value, or empty string if extraction fails
 */
function extractValueFromRange(value, paramName = 'parameter') {
    // If already a primitive, return as string
    if (value === null || value === undefined) {
        return '';
    }
    
    if (typeof value !== 'object') {
        return String(value).trim();
    }
    
    // It's an object - try to extract value from Range object
    const originalValue = value;
    
    // Method 1: Range.values array (most common format)
    // Format: { values: [[cellValue]] }
    if (value.values && Array.isArray(value.values)) {
        if (value.values[0] && Array.isArray(value.values[0])) {
            const cellValue = value.values[0][0];
            if (cellValue !== undefined && cellValue !== null) {
                const extracted = String(cellValue).trim();
                console.log(`🔍 extractValueFromRange(${paramName}): Extracted from Range.values[0][0]: "${cellValue}" → "${extracted}"`);
                return extracted;
            }
        }
        // Try single-level array
        if (value.values[0] !== undefined && !Array.isArray(value.values[0])) {
            const extracted = String(value.values[0]).trim();
            console.log(`🔍 extractValueFromRange(${paramName}): Extracted from Range.values[0]: "${value.values[0]}" → "${extracted}"`);
            return extracted;
        }
    }
    
    // Method 2: Range.value property
    if (value.value !== undefined) {
        const extracted = String(value.value).trim();
        console.log(`🔍 extractValueFromRange(${paramName}): Extracted from Range.value: "${value.value}" → "${extracted}"`);
        return extracted;
    }
    
    // Method 3: Range.text property (formatted display value)
    if (value.text !== undefined) {
        const extracted = String(value.text).trim();
        console.log(`🔍 extractValueFromRange(${paramName}): Extracted from Range.text: "${value.text}" → "${extracted}"`);
        return extracted;
    }
    
    // Method 4: Direct properties (some Range objects expose values directly)
    if (value.formattedValue !== undefined) {
        const extracted = String(value.formattedValue).trim();
        console.log(`🔍 extractValueFromRange(${paramName}): Extracted from Range.formattedValue: "${value.formattedValue}" → "${extracted}"`);
        return extracted;
    }
    
    // Method 5: Try to stringify (fallback)
    const stringified = String(value);
    if (stringified !== '[object Object]' && stringified.trim() !== '') {
        console.log(`🔍 extractValueFromRange(${paramName}): Extracted from stringify: "${stringified}"`);
        return stringified.trim();
    }
    
    // Method 6: Log full object structure for debugging
    console.warn(`⚠️ extractValueFromRange(${paramName}): Could not extract value from Range object. Structure:`, JSON.stringify(value, null, 2));
    return '';
}

/**
 * Trigger automatic BS preload when first BS formula is detected.
 * This removes user interaction - we automatically scan and preload.
 */
let autoPreloadTriggered = false;
let autoPreloadInProgress = false;

function triggerAutoPreload(firstAccount, firstPeriod) {
    // CRITICAL: Normalize period before using it (handles Range objects)
    // This ensures cache keys use canonical "Mon YYYY" format, not "[object Object]"
    const normalizedPeriod = normalizePeriodKey(firstPeriod, false);
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
    // CRITICAL: Use queue pattern with unique keys to prevent overwrites (Issue 2A Fix)
    // Multiple triggers (e.g., dragging across Mar and Apr) will all be processed
    // Format: netsuite_auto_preload_trigger_<timestamp>_<random>
    try {
        const triggerId = `netsuite_auto_preload_trigger_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        localStorage.setItem(triggerId, JSON.stringify({
            firstAccount: firstAccount,
            firstPeriod: normalizedPeriod,  // Use normalized period, not raw input
            timestamp: Date.now(),
            reason: autoPreloadTriggered ? `New period detected: ${normalizedPeriod}` : 'First Balance Sheet formula detected'
        }));
        console.log(`📤 Auto-preload trigger queued: ${triggerId} (period: ${normalizedPeriod})`);
    } catch (e) {
        console.warn('Could not trigger auto-preload:', e);
    }
}

/**
 * Check if a period is already cached in the preload cache
 * CRITICAL: Normalizes period to ensure cache key matching works correctly
 */
function checkIfPeriodIsCached(period) {
    try {
        // Normalize period to ensure it matches cache key format
        // This handles Range objects and various period formats
        // ✅ Use normalizePeriodKey (synchronous, no await needed)
        const normalizedPeriod = normalizePeriodKey(period, false);
        if (!normalizedPeriod) return false;
        
        const preloadCache = localStorage.getItem('xavi_balance_cache');
        if (!preloadCache) return false;
        
        const preloadData = JSON.parse(preloadCache);
        // Check if any account has this period cached
        // We just need to find one account with this period to know it's cached
        // Cache keys are in format: balance:${account}::${normalizedPeriod}
        const periodKey = `::${normalizedPeriod}`;
        for (const key in preloadData) {
            if (key.endsWith(periodKey)) {
                return true;
            }
        }
        return false;
    } catch (e) {
        console.warn('Error checking period cache:', e);
        return false;
    }
}

/**
 * Mark auto-preload as complete (called from taskpane)
 */
function markAutoPreloadComplete() {
    autoPreloadInProgress = false;
    
    // Clear localStorage flag so waitForPreload() knows it's done
    try {
        localStorage.setItem(PRELOAD_STATUS_KEY, 'complete');
        localStorage.setItem(PRELOAD_TIMESTAMP_KEY, Date.now().toString());
    } catch (e) {
        console.warn('Could not update preload status:', e);
    }
    
    console.log('✅ AUTO-PRELOAD: Complete');
}

// Expose for taskpane
window.markAutoPreloadComplete = markAutoPreloadComplete;

// ============================================================================
// PRECACHE MANIFEST - Per-period tracking scoped by filtersHash
// ============================================================================

// In-memory cache for manifest data (keyed by filtersHash)
// Bounded to prevent unbounded growth
const manifestCache = new LRUCache(100, 'manifest'); // key: filtersHash, value: {manifest, version}
const MANIFEST_VERSION_KEY = 'netsuite_precache_manifest_version';

// In-memory cache for status change detection (keyed by statusChangeKey)
// Bounded to prevent unbounded growth
const statusChangeCache = new LRUCache(500, 'statusChange'); // key: statusChangeKey, value: status string
let statusChangeWriteScheduled = false;

/**
 * Get status change key for a filtersHash and periodKey
 */
function getStatusChangeKey(filtersHash, periodKey) {
    return `precache_status_${filtersHash}_${periodKey}`;
}

/**
 * Get status change from cache or localStorage
 */
function getStatusChange(filtersHash, periodKey) {
    const key = getStatusChangeKey(filtersHash, periodKey);
    
    // Check in-memory cache first
    if (statusChangeCache.has(key)) {
        return statusChangeCache.get(key);
    }
    
    // Cache miss - read from localStorage (one-time cost)
    try {
        const stored = localStorage.getItem(key);
        if (stored) {
            statusChangeCache.set(key, stored);
        }
        return stored;
    } catch (e) {
        return null;
    }
}

/**
 * Set status change (updates in-memory cache immediately, schedules async write)
 */
function setStatusChange(filtersHash, periodKey, status, immediate = false) {
    const key = getStatusChangeKey(filtersHash, periodKey);
    
    // Update in-memory cache immediately (for reads)
    statusChangeCache.set(key, status);
    
    // Completion events MUST trigger immediate flush (not debounced)
    if (immediate) {
        // Immediate flush for completion events
        try {
            localStorage.setItem(key, status);
        } catch (e) {
            // Ignore errors
        }
        return;
    }
    
    // Schedule async write (non-blocking) for intermediate state updates
    if (!statusChangeWriteScheduled) {
        statusChangeWriteScheduled = true;
        setTimeout(() => {
            flushStatusChangeWrites();
            statusChangeWriteScheduled = false;
        }, 0);
    }
}

/**
 * Flush all pending status change writes to localStorage
 */
function flushStatusChangeWrites() {
    // Batch write all pending status changes
    // Note: LRUCache iteration - entries are automatically managed
    for (const [key, status] of statusChangeCache.entries()) {
        try {
            localStorage.setItem(key, status);
        } catch (e) {
            // Ignore errors
        }
    }
}

/**
 * Get manifest for a specific filtersHash
 */
function getManifest(filtersHash) {
    // Check in-memory cache first
    if (manifestCache.has(filtersHash)) {
        const cached = manifestCache.get(filtersHash);
        
        // Verify version hasn't changed (cross-context invalidation)
        try {
            const currentVersion = localStorage.getItem(MANIFEST_VERSION_KEY);
            if (currentVersion && cached.version !== currentVersion) {
                // Version changed - cache is stale, invalidate
                manifestCache.delete(filtersHash);
            } else {
                // Version matches or no version yet - use cached data
                return cached.manifest;
            }
        } catch (e) {
            // Version check failed - use cached data (safe fallback)
            return cached.manifest;
        }
    }
    
    // Cache miss - read from localStorage (one-time cost)
    try {
        const stored = localStorage.getItem('netsuite_precache_manifest');
        if (!stored) {
            const manifest = { periods: {}, lastUpdated: Date.now() };
            const version = localStorage.getItem(MANIFEST_VERSION_KEY) || '0';
            manifestCache.set(filtersHash, { manifest, version });
            return manifest;
        }
        const all = JSON.parse(stored);
        const manifest = all[filtersHash] || { periods: {}, lastUpdated: Date.now() };
        
        // Get current version for cache entry
        const version = localStorage.getItem(MANIFEST_VERSION_KEY) || '0';
        
        // Cache for future calls (with version for invalidation)
        manifestCache.set(filtersHash, { manifest, version });
        return manifest;
    } catch (e) {
        console.warn('Error reading manifest:', e);
        const manifest = { periods: {}, lastUpdated: Date.now() };
        const version = localStorage.getItem(MANIFEST_VERSION_KEY) || '0';
        manifestCache.set(filtersHash, { manifest, version });
        return manifest;
    }
}

/**
 * Update period status in manifest (scoped by filtersHash)
 */
function updatePeriodStatus(filtersHash, periodKey, updates) {
    const normalizedKey = normalizePeriodKey(periodKey);
    if (!normalizedKey) return;
    
    try {
        const stored = localStorage.getItem('netsuite_precache_manifest');
        const all = stored ? JSON.parse(stored) : {};
        
        if (!all[filtersHash]) {
            all[filtersHash] = { periods: {}, lastUpdated: Date.now() };
        }
        
        const manifest = all[filtersHash];
        
        if (!manifest.periods[normalizedKey]) {
            manifest.periods[normalizedKey] = {
                requestedAt: Date.now(),
                completedAt: null,
                failedAt: null,
                attemptCount: 0,
                lastError: null,
                batchId: null,
                status: "requested"
            };
        }
        
        const period = manifest.periods[normalizedKey];
        
        if (updates.status === "running") {
            period.status = "running";
            period.batchId = updates.batchId || period.batchId;
        } else if (updates.status === "completed") {
            period.status = "completed";
            period.completedAt = Date.now();
            period.lastError = null;
        } else if (updates.status === "failed") {
            period.status = "failed";
            period.failedAt = Date.now();
            period.lastError = updates.error || "UNKNOWN_ERROR";
            period.attemptCount = (period.attemptCount || 0) + 1;
        }
        
        manifest.lastUpdated = Date.now();
        all[filtersHash] = manifest;
        
        // ✅ Atomic write of entire manifest structure
        localStorage.setItem('netsuite_precache_manifest', JSON.stringify(all));
        
        // Increment version to invalidate all cached reads (cross-context)
        const currentVersion = parseInt(localStorage.getItem(MANIFEST_VERSION_KEY) || '0', 10);
        const newVersion = String(currentVersion + 1);
        localStorage.setItem(MANIFEST_VERSION_KEY, newVersion);
        
        // Invalidate cache so next getManifest() reads fresh data
        manifestCache.delete(filtersHash);
    } catch (e) {
        console.warn('Error updating manifest:', e);
    }
}

/**
 * Get period status from manifest (scoped by filtersHash)
 */
function getPeriodStatus(filtersHash, periodKey) {
    const normalizedKey = normalizePeriodKey(periodKey);
    if (!normalizedKey) return "not_found";
    
    const manifest = getManifest(filtersHash);
    const period = manifest.periods[normalizedKey];
    if (!period) return "not_found";
    
    return period.status;
}

/**
 * Wait for period completion (bounded wait)
 */
async function waitForPeriodCompletion(filtersHash, periodKey, maxWaitMs) {
    const startTime = Date.now();
    const pollInterval = 1000;  // Check every 1s
    
    while (Date.now() - startTime < maxWaitMs) {
        const status = getPeriodStatus(filtersHash, periodKey);
        const manifest = getManifest(filtersHash);
        const period = manifest.periods[normalizePeriodKey(periodKey)];
        
        if (status === "completed") {
            return true;  // Period is now cached
        } else if (status === "failed") {
            // Check if retries exhausted
            if (period && period.attemptCount >= 3) {
                return false;  // Retries exhausted, proceed with API
            }
            // Retries remaining - continue waiting
        }
        
        await new Promise(r => setTimeout(r, pollInterval));
    }
    
    return false;  // Timeout
}

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

/**
 * Show first-time BS education toast.
 * Only shown once per session when first BS formula is detected.
 * NOW: Also triggers automatic preload!
 */
function showBSEducationToast(account, period) {
    if (bsFormulaEducationShown) return;
    bsFormulaEducationShown = true;
    
    // AUTOMATIC PRELOAD: Instead of just showing a toast, trigger auto-preload
    triggerAutoPreload(account, period);
    
    console.log('💡 BS EDUCATION: First BS formula detected, triggering auto-preload');
}

/**
 * Show BUILD MODE warning when multiple BS formulas are detected.
 * Warns user that drag-fill on BS accounts will be slow without preload.
 */
function showBSBuildModeWarning(bsCount, periods) {
    if (bsBuildModeWarningShown) return;
    bsBuildModeWarningShown = true;
    
    // Send special signal to taskpane to show prominent modal
    try {
        localStorage.setItem('netsuite_bs_buildmode_warning', JSON.stringify({
            bsCount: bsCount,
            periods: periods,
            timestamp: Date.now(),
            message: `You're adding ${bsCount} Balance Sheet formulas. Each takes 60-90 seconds individually. Smart Preload can load them all at once in ~30 seconds!`
        }));
    } catch (e) {}
    
    broadcastToast({
        id: 'bs-buildmode-' + Date.now(),
        title: '⚠️ Multiple BS Formulas Detected',
        message: `${bsCount} BS formulas queued. Without preload, this could take ${bsCount * 60}+ seconds. Click "Smart Preload" to speed this up!`,
        type: 'warning',
        duration: 15000,
        priority: 'critical'
    });
    console.log(`⚠️ BS BUILD MODE WARNING: ${bsCount} BS formulas detected`);
}

/**
 * Analyze pending requests and detect BS formula patterns.
 * Called before processing batch to provide guidance.
 */
function analyzePendingBSRequests(pendingMap) {
    let bsCount = 0;
    const bsPeriods = new Set();
    const bsAccounts = new Set();
    
    for (const [cacheKey, request] of pendingMap) {
        if (isCumulativeRequest(request.params.fromPeriod)) {
            bsCount++;
            bsAccounts.add(request.params.account);
            if (request.params.toPeriod) {
                bsPeriods.add(request.params.toPeriod);
            }
        }
    }
    
    return {
        bsCount,
        bsAccounts: Array.from(bsAccounts),
        bsPeriods: Array.from(bsPeriods),
        hasBSFormulas: bsCount > 0
    };
}

/**
 * Suggest BS preload after detecting slow queries.
 * This uses a special localStorage key that taskpane always listens to.
 * 
 * NOTE: Since auto-preload is now automatic, we suppress suggestions when:
 * - Auto-preload is in progress
 * - Auto-preload was recently completed (within last 2 minutes)
 * - Periods are already cached (preload already happened)
 */
function suggestBSPreload(periods, queryTimeMs) {
    const now = Date.now();
    
    // Don't spam suggestions
    if (now - lastBsPreloadSuggestion < BS_SUGGESTION_COOLDOWN_MS) {
        console.log(`🔇 BS preload suggestion suppressed (cooldown)`);
        return;
    }
    
    // SUPPRESS if auto-preload is currently in progress
    if (autoPreloadInProgress || isPreloadInProgress()) {
        console.log(`🔇 BS preload suggestion suppressed (auto-preload in progress)`);
        return;
    }
    
    // SUPPRESS if periods are already cached (preload already happened)
    let allPeriodsCached = true;
    for (const period of periods) {
        if (!checkIfPeriodIsCached(period)) {
            allPeriodsCached = false;
            break;
        }
    }
    if (allPeriodsCached) {
        console.log(`🔇 BS preload suggestion suppressed (periods already cached)`);
        return;
    }
    
    // SUPPRESS if auto-preload was recently completed (within last 2 minutes)
    try {
        const preloadStatus = localStorage.getItem(PRELOAD_STATUS_KEY);
        const preloadTimestamp = localStorage.getItem(PRELOAD_TIMESTAMP_KEY);
        if (preloadStatus === 'complete' && preloadTimestamp) {
            const timeSincePreload = now - parseInt(preloadTimestamp);
            if (timeSincePreload < 120000) { // 2 minutes
                console.log(`🔇 BS preload suggestion suppressed (auto-preload completed ${(timeSincePreload / 1000).toFixed(0)}s ago)`);
                return;
            }
        }
    } catch (e) {
        // Ignore localStorage errors
    }
    
    lastBsPreloadSuggestion = now;
    
    // Send suggestion to taskpane via special localStorage key
    // Taskpane will show a persistent toast with action button
    // NOTE: This should rarely trigger now since auto-preload handles most cases
    try {
        localStorage.setItem('netsuite_bs_preload_suggestion', JSON.stringify({
            periods: periods,
            queryTimeMs: queryTimeMs,
            timestamp: now,
            message: `Balance Sheet query took ${(queryTimeMs / 1000).toFixed(0)}s. Preload ALL BS accounts to make future lookups instant!`
        }));
        console.log(`💡 BS PRELOAD SUGGESTION: ${periods.join(', ')} (query took ${(queryTimeMs / 1000).toFixed(1)}s)`);
    } catch (e) {
        console.warn('Could not send BS preload suggestion:', e);
    }
}

/**
 * Track BS periods seen in formulas for smart multi-period detection.
 * Used to suggest preloading multiple periods at once.
 */
const bsPeriodsSeenThisSession = new Set();

function trackBSPeriod(period) {
    if (period && typeof period === 'string') {
        bsPeriodsSeenThisSession.add(period);
    }
}

function getSeenBSPeriods() {
    return Array.from(bsPeriodsSeenThisSession);
}

// ============================================================================
// PERIOD EXPANSION - Intelligently expand period ranges for better caching
// ============================================================================
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 
                     'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Parse period string into {month: 0-11, year: YYYY}
 * Supports both "Mon YYYY" format and year-only "YYYY" format
 * For year-only, returns month: 0 (Jan) as the starting month
 * 
 * Used by BS grid batching for anchor date inference.
 */
function parsePeriod(periodStr) {
    if (!periodStr || typeof periodStr !== 'string') return null;
    
    // Check for year-only format (e.g., "2024")
    const yearOnlyMatch = periodStr.match(/^(\d{4})$/);
    if (yearOnlyMatch) {
        return { month: 0, year: parseInt(yearOnlyMatch[1]), isYearOnly: true };
    }
    
    // Check for "Mon YYYY" format
    const match = periodStr.match(/^([A-Za-z]{3})\s+(\d{4})$/);
    if (!match) return null;
    const monthIndex = MONTH_NAMES.findIndex(m => m.toLowerCase() === match[1].toLowerCase());
    if (monthIndex === -1) return null;
    return { month: monthIndex, year: parseInt(match[2]) };
}

/**
 * Convert {month, year} back to "Mon YYYY" string
 */
function formatPeriod(month, year) {
    return `${MONTH_NAMES[month]} ${year}`;
}

/**
 * Expand a list of periods to include adjacent months for better cache coverage.
 * This ensures that when dragging formulas, nearby periods are pre-fetched.
 * 
 * @param {string[]} periods - Array of "Mon YYYY" strings (e.g., ["Jan 2025", "Feb 2025"])
 * @param {number} expandBefore - Number of months to add before the earliest period (default: 1)
 * @param {number} expandAfter - Number of months to add after the latest period (default: 1)
 * @returns {string[]} Expanded array of periods
 */
function expandPeriodRange(periods, expandBefore = 1, expandAfter = 1) {
    if (!periods || periods.length === 0) return periods;
    
    // Parse all periods
    const parsed = periods.map(parsePeriod).filter(p => p !== null);
    if (parsed.length === 0) return periods;
    
    // Find min and max dates
    let minMonth = parsed[0].month;
    let minYear = parsed[0].year;
    let maxMonth = parsed[0].month;
    let maxYear = parsed[0].year;
    
    for (const p of parsed) {
        const pTotal = p.year * 12 + p.month;
        const minTotal = minYear * 12 + minMonth;
        const maxTotal = maxYear * 12 + maxMonth;
        
        if (pTotal < minTotal) {
            minMonth = p.month;
            minYear = p.year;
        }
        if (pTotal > maxTotal) {
            maxMonth = p.month;
            maxYear = p.year;
        }
    }
    
    // Expand backward
    for (let i = 0; i < expandBefore; i++) {
        minMonth--;
        if (minMonth < 0) {
            minMonth = 11;
            minYear--;
        }
    }
    
    // Expand forward
    for (let i = 0; i < expandAfter; i++) {
        maxMonth++;
        if (maxMonth > 11) {
            maxMonth = 0;
            maxYear++;
        }
    }
    
    // Generate all periods in the expanded range
    const expanded = [];
    let currentMonth = minMonth;
    let currentYear = minYear;
    
    while (currentYear < maxYear || (currentYear === maxYear && currentMonth <= maxMonth)) {
        expanded.push(formatPeriod(currentMonth, currentYear));
        currentMonth++;
        if (currentMonth > 11) {
            currentMonth = 0;
            currentYear++;
        }
    }
    
    return expanded;
}

// ============================================================================
// CACHE - Bounded LRU caches prevent memory growth over long sessions
// ============================================================================
const cache = {
    balance: new LRUCache(10000, 'balance'),   // Balance cache (largest - periods * accounts)
    title: new LRUCache(5000, 'title'),        // Account title cache  
    budget: new LRUCache(5000, 'budget'),      // Budget cache
    type: new LRUCache(2000, 'type'),          // Account type cache (smaller - just metadata)
    parent: new LRUCache(2000, 'parent')       // Parent account cache (smaller - just metadata)
};

// In-flight request tracking for expensive calculations (RE, NI, CTA)
// This prevents duplicate concurrent API calls for the same period
// Bounded to prevent memory issues if requests never complete
const inFlightRequests = new LRUCache(500, 'inFlight');

// ============================================================================
// BALANCE SHEET GRID BATCHING - With Inferred Anchors
// ============================================================================
// Cache for BS grid batching results (opening balances + period activity)
// Key: "bs-grid:{accountSetHash}:{anchorDate}:{fromPeriod}:{toPeriod}:{filtersHash}"
// Value: { openingBalances: {account: balance}, activity: {account: {period: amount}}, timestamp }
const bsGridCache = new LRUCache(100, 'bsGrid');

// ============================================================================
// EXECUTION LOCK - Single-Flight Promise-Based Mutex
// ============================================================================
// CRITICAL: This is a true single-flight lock (promise-based mutex), not just a boolean flag.
// 
// Guarantees:
// - Only one Balance Sheet batch query can run at a time
// - Concurrent evaluations block via await lock.promise
// - No overlapping NetSuite calls possible under any recalculation scenario
// - Lock is always released in finally block (prevents deadlocks)
//
// Implementation: Promise-based mutex pattern
// - locked: Boolean flag indicating if batch query is in flight
// - promise: Promise that resolves when current batch completes (awaited by concurrent evaluations)
// - cacheKey: Cache key of current batch (for debugging/logging)
// ============================================================================
let bsGridBatchingLock = {
    locked: false,
    promise: null,
    cacheKey: null
};

// Safety limits for BS grid batching
const BS_GRID_MAX_ACCOUNTS = 200;
const BS_GRID_MAX_PERIODS = 36;

// ============================================================================
// SPECIAL FORMULA SEMAPHORE - Ensures only ONE special formula runs at a time
// This prevents the backend from being overwhelmed with parallel queries
// Queue: NETINCOME → RETAINEDEARNINGS → CTA (in order of complexity)
// ============================================================================
let specialFormulaSemaphore = {
    locked: false,
    queue: [],
    currentKey: null
};

/**
 * Acquire the special formula lock - only one formula can run at a time
 * Returns a promise that resolves when the lock is acquired
 */
async function acquireSpecialFormulaLock(cacheKey, formulaType) {
    // Define priority: NETINCOME (1) < RETAINEDEARNINGS (2) < CTA (3)
    const priority = formulaType === 'NETINCOME' ? 1 : 
                    formulaType === 'RETAINEDEARNINGS' ? 2 : 3;
    
    return new Promise((resolve, reject) => {
        const tryAcquire = () => {
            if (!specialFormulaSemaphore.locked) {
                specialFormulaSemaphore.locked = true;
                specialFormulaSemaphore.currentKey = cacheKey;
                console.log(`🔒 SPECIAL LOCK ACQUIRED: ${formulaType} - ${cacheKey}`);
                resolve();
            } else {
                // Already locked - add to priority queue
                specialFormulaSemaphore.queue.push({ 
                    cacheKey, 
                    formulaType,
                    priority,
                    tryAcquire,
                    reject
                });
                // Sort queue by priority (lower = higher priority)
                specialFormulaSemaphore.queue.sort((a, b) => a.priority - b.priority);
                console.log(`⏳ SPECIAL LOCK QUEUED: ${formulaType} - ${cacheKey} (queue: ${specialFormulaSemaphore.queue.length}, current: ${specialFormulaSemaphore.currentKey})`);
            }
        };
        tryAcquire();
    });
}

/**
 * Release the special formula lock and process next in queue
 */
function releaseSpecialFormulaLock(cacheKey) {
    console.log(`🔓 SPECIAL LOCK RELEASED: ${cacheKey}`);
    specialFormulaSemaphore.locked = false;
    specialFormulaSemaphore.currentKey = null;
    
    // Process next in queue (already sorted by priority)
    if (specialFormulaSemaphore.queue.length > 0) {
        const next = specialFormulaSemaphore.queue.shift();
        console.log(`🔄 SPECIAL LOCK: Processing next in queue: ${next.formulaType} - ${next.cacheKey}`);
        // Small delay to prevent stack overflow and allow Excel to update
        setTimeout(() => next.tryAcquire(), 100);
    }
}

/**
 * Check if special formulas are currently being processed
 */
function isSpecialFormulaLocked() {
    return specialFormulaSemaphore.locked;
}

/**
 * Clear the special formula queue (used during cache clear)
 */
function clearSpecialFormulaQueue() {
    const queueLength = specialFormulaSemaphore.queue.length;
    
    // CRITICAL: Reject all queued promises before clearing
    // This prevents formulas from hanging indefinitely
    if (queueLength > 0) {
        console.log(`🧹 SPECIAL LOCK: Rejecting ${queueLength} queued formulas...`);
        for (const item of specialFormulaSemaphore.queue) {
            if (item.reject) {
                try {
                    item.reject(new Error('QUEUE_CLEARED'));
                    console.log(`   ✗ Rejected: ${item.formulaType} - ${item.cacheKey}`);
                } catch (e) {
                    // Ignore rejection errors
                }
            }
        }
    }
    
    specialFormulaSemaphore.queue = [];
    specialFormulaSemaphore.locked = false;
    specialFormulaSemaphore.currentKey = null;
    console.log(`🧹 SPECIAL LOCK: Queue cleared (${queueLength} items rejected)`);
}

// Track last access time to implement LRU if needed
const cacheStats = {
    hits: 0,
    misses: 0,
    size: () => cache.balance.size + cache.title.size + cache.budget.size + cache.type.size + cache.parent.size
};

// ============================================================================
// GLOBAL CACHE CONTROL - Accessible from taskpane
// ============================================================================
window.clearAllCaches = function() {
    console.log('🗑️  CLEARING ALL CACHES...');
    console.log(`  Before: ${cache.balance.size} balances, ${cache.title.size} titles, ${cache.budget.size} budgets`);
    
    cache.balance.clear();
    cache.title.clear();
    cache.budget.clear();
    cache.type.clear();
    cache.parent.clear();
    
    // Clear in-flight requests for special formulas (RETAINEDEARNINGS, NETINCOME, CTA)
    // This ensures fresh API calls will be made when formulas re-evaluate
    if (inFlightRequests && inFlightRequests.size > 0) {
        console.log(`  Clearing ${inFlightRequests.size} in-flight requests...`);
        inFlightRequests.clear();
    }
    
    // Clear the special formula semaphore queue
    // This prevents old queued formulas from running after cache is cleared
    clearSpecialFormulaQueue();
    
    // Reset stats
    cacheStats.hits = 0;
    cacheStats.misses = 0;
    
    console.log('✅ ALL CACHES CLEARED');
    return true;
};

/**
 * Selectively clear cache for specific account/period combinations
 * Use this for "Refresh Selected" to avoid clearing ALL cached data
 * Clears from: 1) in-memory cache, 2) fullYearCache, 3) localStorage
 * @param {Array<{account: string, period: string}>} items - Array of {account, period} to clear
 * @returns {number} Number of cache entries cleared
 */
window.clearCacheForItems = function(items) {
    console.log(`🎯 SELECTIVE CACHE CLEAR: ${items.length} items`);
    let cleared = 0;
    
    // Also clear from localStorage - this is critical!
    let localStorageCleared = 0;
    try {
        const STORAGE_KEY = 'netsuite_balance_cache';
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
            const balanceData = JSON.parse(stored);
            let modified = false;
            
            for (const item of items) {
                const acct = String(item.account);
                if (balanceData[acct] && balanceData[acct][item.period] !== undefined) {
                    delete balanceData[acct][item.period];
                    localStorageCleared++;
                    modified = true;
                    console.log(`   ✓ Cleared localStorage: ${acct}/${item.period}`);
                }
            }
            
            if (modified) {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(balanceData));
                console.log(`   💾 Updated localStorage (removed ${localStorageCleared} entries)`);
            }
        }
    } catch (e) {
        console.warn('   ⚠️ Error clearing localStorage:', e);
    }
    
    for (const item of items) {
        // Use getCacheKey to ensure exact same format as BALANCE
        const cacheKey = getCacheKey('balance', {
            account: String(item.account),
            fromPeriod: item.period,
            toPeriod: item.period,
            subsidiary: item.subsidiary || '',
            department: item.department || '',
            location: item.location || '',
            classId: item.classId || ''
        });
        
        if (cache.balance.has(cacheKey)) {
            cache.balance.delete(cacheKey);
            cleared++;
            console.log(`   ✓ Cleared in-memory: ${item.account}/${item.period}`);
        }
        
        // Also clear from fullYearCache if it exists
        if (fullYearCache && fullYearCache[item.account]) {
            if (fullYearCache[item.account][item.period] !== undefined) {
                delete fullYearCache[item.account][item.period];
                console.log(`   ✓ Cleared fullYearCache: ${item.account}/${item.period}`);
            }
        }
    }
    
    const totalCleared = cleared + localStorageCleared;
    console.log(`   📊 Cleared ${totalCleared} total cache entries (${cleared} in-memory, ${localStorageCleared} localStorage)`);
    return totalCleared;
};

// ============================================================================
// FULL REFRESH MODE - Optimized for bulk sheet refresh
// ============================================================================
let isFullRefreshMode = false;
let fullRefreshResolver = null;
let fullRefreshYear = null;

// CACHE READY SEMAPHORE - Prevents premature formula evaluation
// Formulas check this before returning values during full refresh
window.__NS_CACHE_READY = true;  // Default to true for normal operation

window.enterFullRefreshMode = function(year) {
    console.log('🚀 ENTERING FULL REFRESH MODE');
    console.log(`   Year: ${year || 'auto-detect'}`);
    isFullRefreshMode = true;
    fullRefreshYear = year || null;
    window.__NS_CACHE_READY = false;  // Block premature evaluations
    
    // Clear cache to force fresh data
    window.clearAllCaches();
    
    // Return a Promise that resolves when full refresh completes
    return new Promise((resolve, reject) => {
        fullRefreshResolver = resolve;
    });
};

window.exitFullRefreshMode = function() {
    console.log('✅ EXITING FULL REFRESH MODE');
    isFullRefreshMode = false;
    fullRefreshYear = null;
    window.__NS_CACHE_READY = true;  // Allow normal evaluation
    if (fullRefreshResolver) {
        fullRefreshResolver();
        fullRefreshResolver = null;
    }
};

// Mark cache as ready (called by taskpane after populating cache)
window.markCacheReady = function() {
    console.log('✅ CACHE MARKED AS READY');
    window.__NS_CACHE_READY = true;
};

// ============================================================================
// BUILD MODE - Instant drag-and-drop performance
// When user drags formulas rapidly, we defer NetSuite calls until they stop
// 
// KEY INSIGHT: We DON'T return 0 placeholder - that looks like real data!
// Instead, we return a Promise that resolves after the batch completes.
// This shows #BUSY briefly but ensures correct values.
// ============================================================================
let buildMode = false;
let buildModeLastEvent = 0;
let buildModePending = [];  // Collect pending requests: { cacheKey, params, resolve, reject }
let buildModeTimer = null;
let formulaCreationCount = 0;
let formulaCountResetTimer = null;

const BUILD_MODE_THRESHOLD = 2;     // Enter build mode after 2+ rapid formulas (trigger earlier)
const BUILD_MODE_SETTLE_MS = 500;   // Wait 500ms after last formula before batch
const BUILD_MODE_WINDOW_MS = 800;   // Time window to count formulas (wider!)

function enterBuildMode() {
    if (!buildMode) {
        console.log('🔨 ENTERING BUILD MODE (rapid formula creation detected)');
        buildMode = true;
        
        // CRITICAL: Cancel the regular batch timer to prevent race condition!
        if (batchTimer) {
            console.log('   ⏹️ Cancelled regular batch timer');
            clearTimeout(batchTimer);
            batchTimer = null;
        }
        
        // Move any already-pending requests into build mode queue
        // This prevents them from being processed by the regular batch
        for (const [cacheKey, request] of pendingRequests.balance.entries()) {
            buildModePending.push({
                cacheKey,
                params: request.params,
                resolve: request.resolve,
                reject: request.reject
            });
        }
        if (pendingRequests.balance.size > 0) {
            console.log(`   📦 Moved ${pendingRequests.balance.size} pending requests to build mode`);
            pendingRequests.balance.clear();
        }
    }
}

function exitBuildModeAndProcess() {
    if (!buildMode) return;
    
    const count = buildModePending.length;
    console.log(`🔨 EXITING BUILD MODE (${count} formulas queued)`);
    buildMode = false;
    formulaCreationCount = 0;
    
    // Process all queued formulas in one batch
    if (count > 0) {
        runBuildModeBatch();
    }
}

// ============================================================================
// NETSUITE ACCOUNT TYPES - Complete Reference
// ============================================================================
// 
// BALANCE SHEET ACCOUNTS:
// -----------------------
// ASSETS (Natural Debit Balance - stored POSITIVE in NetSuite)
//   SuiteQL Value     | Description              | Sign in Report
//   ------------------|--------------------------|----------------
//   Bank              | Bank/Cash accounts       | + (no flip)
//   AcctRec           | Accounts Receivable      | + (no flip)
//   OthCurrAsset      | Other Current Asset      | + (no flip)
//   FixedAsset        | Fixed Asset              | + (no flip)
//   OthAsset          | Other Asset              | + (no flip)
//   DeferExpense      | Deferred Expense         | + (no flip)
//   UnbilledRec       | Unbilled Receivable      | + (no flip)
//
// LIABILITIES (Natural Credit Balance - stored NEGATIVE in NetSuite)
//   SuiteQL Value     | Description              | Sign in Report
//   ------------------|--------------------------|----------------
//   AcctPay           | Accounts Payable         | + (flip × -1)
//   CredCard          | Credit Card              | + (flip × -1)
//   OthCurrLiab       | Other Current Liability  | + (flip × -1)
//   LongTermLiab      | Long Term Liability      | + (flip × -1)
//   DeferRevenue      | Deferred Revenue         | + (flip × -1)
//
// EQUITY (Natural Credit Balance - stored NEGATIVE in NetSuite)
//   SuiteQL Value     | Description              | Sign in Report
//   ------------------|--------------------------|----------------
//   Equity            | Equity accounts          | + (flip × -1)
//   RetainedEarnings  | Retained Earnings        | + (flip × -1)
//
// PROFIT & LOSS ACCOUNTS:
// -----------------------
// INCOME (Natural Credit Balance - stored NEGATIVE in NetSuite)
//   SuiteQL Value     | Description              | Sign in Report
//   ------------------|--------------------------|----------------
//   Income            | Revenue/Sales            | + (flip × -1)
//   OthIncome         | Other Income             | + (flip × -1)
//
// EXPENSES (Natural Debit Balance - stored POSITIVE in NetSuite)
//   SuiteQL Value     | Description              | Sign in Report
//   ------------------|--------------------------|----------------
//   COGS              | Cost of Goods Sold       | + (no flip)
//   Expense           | Operating Expense        | + (no flip)
//   OthExpense        | Other Expense            | + (no flip)
//
// OTHER ACCOUNT TYPES:
// --------------------
//   NonPosting        | Non-posting/Statistical  | N/A (no transactions)
//   Stat              | Statistical accounts     | N/A (no transactions)
//
// ============================================================================

// Helper: Check if account type is Balance Sheet
function isBalanceSheetType(acctType) {
    if (!acctType) return false;
    // All Balance Sheet account types (Assets, Liabilities, Equity)
    const bsTypes = [
        // Assets (Debit balance)
        'Bank',           // Bank/Cash accounts
        'AcctRec',        // Accounts Receivable
        'OthCurrAsset',   // Other Current Asset
        'FixedAsset',     // Fixed Asset
        'OthAsset',       // Other Asset
        'DeferExpense',   // Deferred Expense (prepaid expenses)
        'UnbilledRec',    // Unbilled Receivable
        // Liabilities (Credit balance)
        'AcctPay',        // Accounts Payable
        'CredCard',       // Credit Card (NOT 'CreditCard')
        'OthCurrLiab',    // Other Current Liability
        'LongTermLiab',   // Long Term Liability
        'DeferRevenue',   // Deferred Revenue (unearned revenue)
        // Equity (Credit balance)
        'Equity',         // Equity accounts
        'RetainedEarnings' // Retained Earnings
    ];
    return bsTypes.includes(acctType);
}

// Helper: Check if account type is Income Statement (Income or Expense)
function isIncomeStatementType(acctType) {
    if (!acctType) return false;
    // All Income Statement account types (Income and Expense)
    const plTypes = [
        // Income (Natural Credit Balance)
        'Income',         // Revenue/Sales
        'OthIncome',      // Other Income
        // Expenses (Natural Debit Balance)
        'COGS',           // Cost of Goods Sold
        'Expense',        // Operating Expense
        'OthExpense'      // Other Expense
    ];
    return plTypes.includes(acctType);
}

// ============================================================================
// BALANCE SHEET GRID BATCHING HELPERS
// ============================================================================

/**
 * Detect if a set of requests forms a Balance Sheet grid pattern.
 * 
 * ============================================================================
 * GRID DETECTION - Supports Two Query Types
 * ============================================================================
 * 
 * CASE 1 - CUMULATIVE QUERIES (fromPeriod empty):
 *   Formula: BALANCE(account, , toPeriod)
 *   - Most common CPA workflow
 *   - Anchor = day before earliest toPeriod in grid
 *   - EndingBalance(period) = OpeningBalance(anchor) + SUM(Activity(periods up to period))
 * 
 * CASE 2 - PERIOD ACTIVITY QUERIES (both fromPeriod and toPeriod):
 *   Formula: BALANCE(account, fromPeriod, toPeriod)
 *   - Explicit period range query
 *   - Anchor = day before earliest fromPeriod in grid
 *   - Result(period) = SUM(Activity(fromPeriod → toPeriod))
 * 
 * CONSERVATIVE TRIGGER CONDITIONS (ALL must be true for cumulative queries):
 * 1. Account type is Balance Sheet (verified separately in processBatchQueue)
 * 2. fromPeriod is empty (verified here)
 * 3. The formula appears in a contiguous grid (verified via request count vs expected grid size)
 * 4. There are multiple adjacent columns (periods.size >= 2, verified here)
 * 5. toPeriod differs across those columns (periods.size >= 2, verified here)
 * 6. All formulas in the detected block are XAVI.BALANCE (implicit - only BALANCE requests processed)
 * 7. Account references vary only by row (verified via account-to-period mapping)
 * 8. Period references vary only by column (verified via period-to-account mapping)
 * 
 * Additional conservative checks:
 * - All requests are the SAME query type (all cumulative OR all period activity)
 * - Same filters (subsidiary, department, location, class, book)
 * - Grid coverage >= 50% (allows some missing cells but ensures grid-like structure)
 * 
 * CRITICAL SAFETY: Safety limits are enforced HERE, before any NetSuite work begins.
 * This ensures fail-fast behavior with zero network activity if limits are exceeded.
 * 
 * If intent is unclear, returns null (fall back to existing behavior).
 * 
 * @param {Array} requests - Array of [cacheKey, request] tuples
 * @returns {Object|null} Grid info: { queryType: 'cumulative'|'periodActivity', accounts: Set, periods: Set, earliestPeriod, latestPeriod, filtersHash } or null
 */
function detectBsGridPattern(requests) {
    if (!requests || requests.length < 2) {
        return null; // Need at least 2 requests to form a grid
    }
    
    // ============================================================================
    // STEP 1: Separate cumulative and period activity requests
    // ============================================================================
    // CRITICAL: All requests in a grid must be the SAME query type.
    // Mixed types indicate ambiguous intent → fall back to individual processing.
    // ============================================================================
    const cumulativeRequests = [];
    const periodActivityRequests = [];
    
    for (const [cacheKey, request] of requests) {
        const { fromPeriod, toPeriod } = request.params;
        const isCumulative = (!fromPeriod || fromPeriod === '') && toPeriod && toPeriod !== '';
        const isPeriodActivity = fromPeriod && toPeriod && fromPeriod !== toPeriod;
        
        if (isCumulative) {
            cumulativeRequests.push(request);
        } else if (isPeriodActivity) {
            periodActivityRequests.push(request);
        }
        // Ignore other types (they don't form grids)
    }
    
    // Determine which query type to process (must be homogeneous)
    let queryType = null;
    let selectedRequests = [];
    
    if (cumulativeRequests.length >= 2 && periodActivityRequests.length === 0) {
        // CASE 1: All cumulative queries
        queryType = 'cumulative';
        selectedRequests = cumulativeRequests;
    } else if (periodActivityRequests.length >= 2 && cumulativeRequests.length === 0) {
        // CASE 2: All period activity queries
        queryType = 'periodActivity';
        selectedRequests = periodActivityRequests;
    } else {
        // Mixed types or insufficient requests → not a grid
        return null;
    }
    
    if (selectedRequests.length < 2) {
        return null; // Need at least 2 requests of the same type
    }
    
    // ============================================================================
    // STEP 2: Verify all requests share the same filters
    // ============================================================================
    const firstRequest = selectedRequests[0];
    const filtersHash = getFilterKey({
        subsidiary: firstRequest.params.subsidiary,
        department: firstRequest.params.department,
        location: firstRequest.params.location,
        classId: firstRequest.params.classId,
        accountingBook: firstRequest.params.accountingBook
    });
    
    // Verify all requests have same filters
    for (const request of selectedRequests) {
        const requestFiltersHash = getFilterKey({
            subsidiary: request.params.subsidiary,
            department: request.params.department,
            location: request.params.location,
            classId: request.params.classId,
            accountingBook: request.params.accountingBook
        });
        if (requestFiltersHash !== filtersHash) {
            return null; // Different filters - not a grid
        }
    }
    
    // ============================================================================
    // STEP 3: Collect unique accounts and periods
    // ============================================================================
    // CRITICAL CONSERVATIVE CHECKS FOR CUMULATIVE QUERIES:
    // For cumulative queries, we require VERY strict conditions to ensure
    // grid intent is unmistakable before enabling inferred-anchor batching.
    // ============================================================================
    const accounts = new Set();
    const periods = new Set();
    let earliestPeriod = null;
    let latestPeriod = null;
    
    // For cumulative queries: Track account-to-period mappings to verify grid structure
    const accountPeriodMap = new Map(); // account -> Set of periods
    
    for (const request of selectedRequests) {
        const { account, fromPeriod, toPeriod } = request.params;
        
        // CRITICAL CHECK 1: For cumulative queries, fromPeriod MUST be empty
        if (queryType === 'cumulative') {
            if (fromPeriod && fromPeriod !== '') {
                console.warn(`⚠️ BS Grid: Cumulative query has non-empty fromPeriod - not a grid`);
                return null; // Not a cumulative query
            }
            
            // CRITICAL CHECK 2: toPeriod MUST be present and non-empty
            if (!toPeriod || toPeriod === '') {
                console.warn(`⚠️ BS Grid: Cumulative query missing toPeriod - not a grid`);
                return null;
            }
            
            // Track account-to-period mappings
            if (!accountPeriodMap.has(account)) {
                accountPeriodMap.set(account, new Set());
            }
            accountPeriodMap.get(account).add(toPeriod);
            
            accounts.add(account);
            periods.add(toPeriod);
            
            if (!earliestPeriod || toPeriod < earliestPeriod) {
                earliestPeriod = toPeriod;
            }
            if (!latestPeriod || toPeriod > latestPeriod) {
                latestPeriod = toPeriod;
            }
        } else {
            // For period activity queries, track both fromPeriod and toPeriod
            periods.add(fromPeriod);
            periods.add(toPeriod);
            if (!earliestPeriod || fromPeriod < earliestPeriod) {
                earliestPeriod = fromPeriod;
            }
            if (!latestPeriod || toPeriod > latestPeriod) {
                latestPeriod = toPeriod;
            }
            accounts.add(account);
        }
    }
    
    // ============================================================================
    // CRITICAL CHECK 3: Need multiple accounts AND multiple periods
    // ============================================================================
    if (accounts.size < 2 || periods.size < 2) {
        console.warn(`⚠️ BS Grid: Insufficient variety (${accounts.size} accounts, ${periods.size} periods) - not a grid`);
        return null; // Not enough variety to be a grid
    }
    
    // ============================================================================
    // CRITICAL CHECK 4: For cumulative queries, verify grid-like structure
    // ============================================================================
    // We can't verify actual cell positions, but we can verify that:
    // - Each account appears with multiple periods (suggests columns)
    // - Each period appears with multiple accounts (suggests rows)
    // - The total request count is reasonable for a grid (accounts × periods, or close)
    // ============================================================================
    if (queryType === 'cumulative') {
        // CRITICAL CHECK 4A: Each account should appear with multiple periods (columns)
        let accountsWithMultiplePeriods = 0;
        for (const [account, periodSet] of accountPeriodMap) {
            if (periodSet.size >= 2) {
                accountsWithMultiplePeriods++;
            }
        }
        
        // At least 2 accounts must have multiple periods (suggests multiple columns)
        if (accountsWithMultiplePeriods < 2) {
            console.warn(`⚠️ BS Grid: Only ${accountsWithMultiplePeriods} accounts have multiple periods - not a clear grid pattern`);
            return null;
        }
        
        // CRITICAL CHECK 4B: Verify periods differ across requests (multiple columns)
        // This is already verified by periods.size >= 2, but add explicit check
        if (periods.size < 2) {
            console.warn(`⚠️ BS Grid: Only ${periods.size} unique period(s) - need multiple columns`);
            return null;
        }
        
        // CRITICAL CHECK 4C: Verify reasonable grid size
        // Expected: accounts × periods (or close, allowing for some missing cells)
        const expectedGridSize = accounts.size * periods.size;
        const actualRequestCount = selectedRequests.length;
        const gridCoverage = actualRequestCount / expectedGridSize;
        
        // Require at least 50% coverage (allows for some missing cells but ensures grid-like structure)
        if (gridCoverage < 0.5) {
            console.warn(`⚠️ BS Grid: Request count (${actualRequestCount}) doesn't match grid pattern (expected ~${expectedGridSize}, coverage: ${(gridCoverage * 100).toFixed(1)}%)`);
            return null; // Not a clear grid pattern
        }
        
        // CRITICAL CHECK 4D: Verify each period appears with multiple accounts (suggests multiple rows)
        const periodAccountMap = new Map(); // period -> Set of accounts
        for (const request of selectedRequests) {
            const { account, toPeriod } = request.params;
            if (!periodAccountMap.has(toPeriod)) {
                periodAccountMap.set(toPeriod, new Set());
            }
            periodAccountMap.get(toPeriod).add(account);
        }
        
        let periodsWithMultipleAccounts = 0;
        for (const [period, accountSet] of periodAccountMap) {
            if (accountSet.size >= 2) {
                periodsWithMultipleAccounts++;
            }
        }
        
        // At least 2 periods must have multiple accounts (suggests multiple rows)
        if (periodsWithMultipleAccounts < 2) {
            console.warn(`⚠️ BS Grid: Only ${periodsWithMultipleAccounts} periods have multiple accounts - not a clear grid pattern`);
            return null;
        }
    }
    
    // ============================================================================
    // SAFETY LIMITS ENFORCEMENT - Fail Fast Before Any NetSuite Work
    // ============================================================================
    // CRITICAL: These limits are enforced HERE, before:
    // - Anchor computation (inferAnchorDate)
    // - Batch query construction
    // - Any NetSuite API calls
    // 
    // If limits are exceeded, this function returns null, causing fallback to
    // individual processing. This ensures zero network activity and fail-fast behavior.
    // ============================================================================
    if (accounts.size > BS_GRID_MAX_ACCOUNTS) {
        console.warn(`⚠️ BS Grid: Too many accounts (${accounts.size}), max: ${BS_GRID_MAX_ACCOUNTS} - failing fast before any NetSuite work`);
        return null; // Fail fast - don't attempt grid batching
    }
    
    // Count unique periods in range
    const periodCount = periods.size;
    if (periodCount > BS_GRID_MAX_PERIODS) {
        console.warn(`⚠️ BS Grid: Too many periods (${periodCount}), max: ${BS_GRID_MAX_PERIODS} - failing fast before any NetSuite work`);
        return null; // Fail fast - don't attempt grid batching
    }
    
    return {
        queryType,  // 'cumulative' or 'periodActivity'
        accounts,
        periods,
        earliestPeriod,  // Earliest period in grid (toPeriod for cumulative, fromPeriod for period activity)
        latestPeriod,    // Latest period in grid (toPeriod for both types)
        filtersHash,
        requestCount: selectedRequests.length,
        requests: selectedRequests  // Store requests for processing
    };
}

/**
 * Infer anchor date from earliest period in grid.
 * 
 * ============================================================================
 * ANCHOR CONTRACT - Balance Sheet Grid Batching
 * ============================================================================
 * 
 * HOW THE ANCHOR IS INFERRED:
 * 
 * CASE 1 - CUMULATIVE QUERIES (fromPeriod empty):
 *   - Anchor date = day before earliest toPeriod's start date
 *   - Example: If earliest toPeriod is "Jan 2025" (starts Jan 1, 2025),
 *     anchor date is Dec 31, 2024 (day before Jan 1)
 *   - The anchor represents the opening balance date for ALL accounts in the grid
 *   - All subsequent columns build forward from this anchor
 * 
 * CASE 2 - PERIOD ACTIVITY QUERIES (both fromPeriod and toPeriod):
 *   - Anchor date = day before earliest fromPeriod's start date
 *   - Example: If earliest fromPeriod is "Jan 2025" (starts Jan 1, 2025),
 *     anchor date is Dec 31, 2024 (day before Jan 1)
 *   - The anchor represents the opening balance date for period activity calculations
 * 
 * KEY PRINCIPLE: For Balance Sheet grids, the lowest period in the grid defines
 * the anchor. All subsequent columns build forward from that anchor.
 * 
 * WHY THIS APPLIES ONLY TO BALANCE SHEET ACCOUNTS:
 * - Balance Sheet accounts use cumulative balances (from inception)
 * - The anchor provides a common starting point for all accounts in the grid
 * - Income/Expense accounts use period activity (sum of transactions), not
 *   cumulative balances, so they don't need an anchor
 * - Account type verification (isBalanceSheetType) ensures only BS accounts
 *   reach this code path
 * 
 * WHY ENDING BALANCES ARE DERIVED LOCALLY:
 * - EndingBalance(period) = OpeningBalance(anchor) + SUM(Activity(periods up to period))
 * - This runs entirely in-memory (no NetSuite calls)
 * - Provides instant results after batched queries complete
 * - Mathematically equivalent to: Balance(toPeriod) - Balance(before fromPeriod)
 *   but uses indexed date filters instead of cumulative scans (much faster)
 * 
 * FINANCIAL CORRECTNESS:
 * - All amounts (opening balances and period activity) are converted at the
 *   same exchange rate (toPeriod's rate) via BUILTIN.CONSOLIDATE
 * - This ensures the balance sheet balances correctly
 * - Local computation preserves this correctness (no currency conversion needed)
 * 
 * ============================================================================
 * 
 * @param {string} earliestPeriod - Period name (e.g., "Jan 2025") - toPeriod for cumulative, fromPeriod for period activity
 * @returns {Promise<string|null>} Anchor date in YYYY-MM-DD format, or null if error
 */
async function inferAnchorDate(earliestPeriod) {
    try {
        // Parse period to get month and year
        const parsed = parsePeriod(earliestPeriod);
        if (!parsed) {
            console.warn(`⚠️ Could not parse period: ${earliestPeriod}`);
            return null;
        }
        
        // Get period data from backend to find start date
        // Use the period lookup endpoint that returns period details
        const response = await fetch(`${SERVER_URL}/lookups/periods?period=${encodeURIComponent(earliestPeriod)}`);
        if (!response.ok) {
            console.warn(`⚠️ Could not fetch period data for ${earliestPeriod}`);
            // Fallback: calculate anchor date from period name
            // Assume period starts on the 1st of the month
            const month = parsed.month;
            const year = parsed.year;
            const startDate = new Date(year, month, 1);
            startDate.setDate(startDate.getDate() - 1); // Day before period start
            
            const anchorYear = startDate.getFullYear();
            const anchorMonth = String(startDate.getMonth() + 1).padStart(2, '0');
            const anchorDay = String(startDate.getDate()).padStart(2, '0');
            return `${anchorYear}-${anchorMonth}-${anchorDay}`;
        }
        
        const data = await response.json();
        if (!data || !data.startDate) {
            console.warn(`⚠️ Period ${earliestPeriod} has no startDate - using fallback calculation`);
            // Fallback: calculate from period name
            const month = parsed.month;
            const year = parsed.year;
            const startDate = new Date(year, month, 1);
            startDate.setDate(startDate.getDate() - 1);
            
            const anchorYear = startDate.getFullYear();
            const anchorMonth = String(startDate.getMonth() + 1).padStart(2, '0');
            const anchorDay = String(startDate.getDate()).padStart(2, '0');
            return `${anchorYear}-${anchorMonth}-${anchorDay}`;
        }
        
        // Parse start date and subtract 1 day
        const startDate = new Date(data.startDate);
        startDate.setDate(startDate.getDate() - 1);
        
        // Format as YYYY-MM-DD
        const year = startDate.getFullYear();
        const month = String(startDate.getMonth() + 1).padStart(2, '0');
        const day = String(startDate.getDate()).padStart(2, '0');
        
        return `${year}-${month}-${day}`;
    } catch (error) {
        console.error(`❌ Error inferring anchor date:`, error);
        return null;
    }
}

/**
 * Build cache key for BS grid batching results.
 * 
 * @param {Set} accounts - Set of account numbers
 * @param {string} anchorDate - Anchor date (YYYY-MM-DD)
 * @param {string} earliestPeriod - Earliest period in grid
 * @param {string} latestPeriod - Latest period in grid
 * @param {string} filtersHash - Filters hash
 * @param {string} queryType - 'cumulative' or 'periodActivity'
 * @returns {string} Cache key
 */
function buildBsGridCacheKey(accounts, anchorDate, earliestPeriod, latestPeriod, filtersHash, queryType) {
    // Sort accounts for consistent hashing
    const accountList = Array.from(accounts).sort().join(',');
    return `bs-grid:${queryType}:${accountList}:${anchorDate}:${earliestPeriod}:${latestPeriod}:${filtersHash}`;
}

/**
 * Process BS Grid Batching for both cumulative and period activity queries.
 * 
 * This unified function handles:
 * - CASE 1: Cumulative queries (BALANCE(account, , toPeriod))
 * - CASE 2: Period activity queries (BALANCE(account, fromPeriod, toPeriod))
 * 
 * @param {Object} gridInfo - Grid detection result from detectBsGridPattern()
 * @param {Array} requests - Array of [cacheKey, request] tuples
 * @returns {Promise<void>}
 */
async function processBsGridBatching(gridInfo, requests) {
    if (!gridInfo || !requests || requests.length === 0) {
        return;
    }
    
    const { queryType, accounts, earliestPeriod, latestPeriod, filtersHash } = gridInfo;
    
    // Infer anchor date based on query type
    const anchorDate = await inferAnchorDate(earliestPeriod);
    if (!anchorDate) {
        console.warn(`   ⚠️ Could not infer anchor date - falling back to individual processing`);
        throw new Error('Could not infer anchor date');
    }
    
    const firstRequest = requests[0][1];
    const gridCacheKey = buildBsGridCacheKey(
        accounts,
        anchorDate,
        earliestPeriod,
        latestPeriod,
        filtersHash,
        queryType
    );
    
    // Check cache first
    const cachedGrid = bsGridCache.get(gridCacheKey);
    if (cachedGrid) {
        console.log(`   ✅ BS Grid cache hit - using cached results`);
        
        // Resolve all requests from cache
        let resolvedCount = 0;
        for (const [cacheKey, request] of requests) {
            const { account, toPeriod, fromPeriod } = request.params;
            const endingBalance = computeEndingBalance(
                account,
                toPeriod,
                cachedGrid.openingBalances,
                cachedGrid.activity,
                queryType,
                fromPeriod
            );
            
            cache.balance.set(cacheKey, endingBalance);
            request.resolve(endingBalance);
            resolvedCount++;
        }
        
        console.log(`   ✅ Resolved ${resolvedCount} requests from BS Grid cache`);
        return;
    }
    
    // Cache miss - check execution lock
    if (bsGridBatchingLock.locked) {
        console.log(`   ⏳ BS Grid batching already in progress - waiting for lock...`);
        await bsGridBatchingLock.promise;
        
        // After lock releases, check cache again (may have been populated)
        const cachedGridAfterLock = bsGridCache.get(gridCacheKey);
        if (cachedGridAfterLock) {
            console.log(`   ✅ BS Grid cache hit after lock release - using cached results`);
            
            let resolvedCount = 0;
            for (const [cacheKey, request] of requests) {
                const { account, toPeriod, fromPeriod } = request.params;
                const endingBalance = computeEndingBalance(
                    account,
                    toPeriod,
                    cachedGridAfterLock.openingBalances,
                    cachedGridAfterLock.activity,
                    queryType,
                    fromPeriod
                );
                
                cache.balance.set(cacheKey, endingBalance);
                request.resolve(endingBalance);
                resolvedCount++;
            }
            
            console.log(`   ✅ Resolved ${resolvedCount} requests from BS Grid cache (after lock)`);
            return;
        }
    }
    
    // Acquire lock and execute batched queries
    console.log(`   📤 BS Grid cache miss - executing batched queries (${queryType})...`);
    
    bsGridBatchingLock.locked = true;
    bsGridBatchingLock.cacheKey = gridCacheKey;
    
    const lockPromise = (async () => {
        try {
            // Step 1: Get opening balances
            console.log(`   📊 Step 1: Fetching opening balances at anchor date ${anchorDate}...`);
            const openingResponse = await fetch(`${SERVER_URL}/batch/balance/bs-grid-opening`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    accounts: Array.from(accounts),
                    anchorDate: anchorDate,
                    fromPeriod: earliestPeriod,  // For cumulative, this is earliest toPeriod; for period activity, this is earliest fromPeriod
                    subsidiary: firstRequest.params.subsidiary,
                    department: firstRequest.params.department,
                    location: firstRequest.params.location,
                    class: firstRequest.params.classId,
                    book: firstRequest.params.accountingBook
                })
            });
            
            if (!openingResponse.ok) {
                throw new Error(`Opening balances query failed: ${openingResponse.status}`);
            }
            
            const openingData = await openingResponse.json();
            if (!openingData.Success) {
                throw new Error(openingData.Error || 'Opening balances query failed');
            }
            
            const openingBalances = openingData.OpeningBalances || {};
            console.log(`   ✅ Opening balances: ${Object.keys(openingBalances).length} accounts`);
            
            // Step 2: Get period activity
            // For cumulative queries: fetch activity from anchor to latest toPeriod
            // For period activity queries: fetch activity from earliest fromPeriod to latest toPeriod
            console.log(`   📊 Step 2: Fetching period activity...`);
            const activityResponse = await fetch(`${SERVER_URL}/batch/balance/bs-grid-activity`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    accounts: Array.from(accounts),
                    anchorDate: anchorDate,
                    fromPeriod: earliestPeriod,  // For cumulative, this is earliest toPeriod; for period activity, this is earliest fromPeriod
                    toPeriod: latestPeriod,      // Latest period in grid
                    subsidiary: firstRequest.params.subsidiary,
                    department: firstRequest.params.department,
                    location: firstRequest.params.location,
                    class: firstRequest.params.classId,
                    book: firstRequest.params.accountingBook
                })
            });
            
            if (!activityResponse.ok) {
                throw new Error(`Period activity query failed: ${activityResponse.status}`);
            }
            
            const activityData = await activityResponse.json();
            if (!activityData.Success) {
                throw new Error(activityData.Error || 'Period activity query failed');
            }
            
            const activity = activityData.Activity || {};
            console.log(`   ✅ Period activity: ${activityData.TotalRows} rows`);
            
            // Step 3: Cache results
            bsGridCache.set(gridCacheKey, {
                openingBalances,
                activity,
                timestamp: Date.now()
            });
            
            // Step 4: Compute ending balances and resolve all requests
            let resolvedCount = 0;
            for (const [cacheKey, request] of requests) {
                const { account, toPeriod, fromPeriod } = request.params;
                const endingBalance = computeEndingBalance(
                    account,
                    toPeriod,
                    openingBalances,
                    activity,
                    queryType,
                    fromPeriod
                );
                
                cache.balance.set(cacheKey, endingBalance);
                request.resolve(endingBalance);
                resolvedCount++;
            }
            
            console.log(`   ✅ BS Grid batching complete: ${resolvedCount} requests resolved`);
        } catch (error) {
            console.error(`   ❌ BS Grid batching failed: ${error.message}`);
            throw error; // Re-throw to be caught by caller
        } finally {
            // Release lock
            bsGridBatchingLock.locked = false;
            bsGridBatchingLock.promise = null;
            bsGridBatchingLock.cacheKey = null;
        }
    })();
    
    bsGridBatchingLock.promise = lockPromise;
    await lockPromise;
}

/**
 * Compute ending balances locally from opening balances + period activity.
 * 
 * ============================================================================
 * LOCAL COMPUTATION CONTRACT - Balance Sheet Grid Batching
 * ============================================================================
 * 
 * CASE 1 - CUMULATIVE QUERIES (fromPeriod empty):
 *   FORMULA: EndingBalance(period) = OpeningBalance(anchor) + SUM(Activity(periods up to and including period))
 *   
 *   This is the most common CPA workflow. The formula BALANCE(account, , toPeriod)
 *   is reinterpreted internally as a cumulative balance building from the anchor.
 *   From the user's perspective, the semantics don't change - they still get the
 *   ending balance for that period, but computed efficiently via grid batching.
 * 
 * CASE 2 - PERIOD ACTIVITY QUERIES (both fromPeriod and toPeriod):
 *   FORMULA: Result(period) = SUM(Activity(fromPeriod → toPeriod))
 *   
 *   This respects the user's explicit intent for period activity. The result is
 *   the net change during the period, not a cumulative balance.
 * 
 * WHY LOCAL COMPUTATION:
 * - Runs entirely in-memory (no NetSuite calls)
 * - Provides instant results after batched queries complete
 * - Mathematically equivalent to: Balance(toPeriod) - Balance(before fromPeriod)
 *   but uses indexed date filters instead of cumulative scans (much faster)
 * 
 * FINANCIAL CORRECTNESS:
 * - Opening balances are computed at anchor date using toPeriod's exchange rate
 * - Period activity is computed using toPeriod's exchange rate
 * - Local computation preserves this correctness (no additional currency conversion)
 * - All amounts are already in the same currency/rate from batched queries
 * 
 * EXAMPLE (Cumulative):
 * - Opening balance (Dec 31, 2024): 2,064,705.84
 * - Activity: {"Jan 2025": 381646.48, "Feb 2025": -50000.00}
 * - Ending balance (Jan 2025): 2,064,705.84 + 381,646.48 = 2,446,352.32
 * - Ending balance (Feb 2025): 2,446,352.32 + (-50,000.00) = 2,396,352.32
 * 
 * ============================================================================
 * 
 * @param {string} account - Account number
 * @param {string} targetPeriod - Target period (e.g., "Feb 2025")
 * @param {Object} openingBalances - {account: balance} - Opening balances at anchor date
 * @param {Object} activity - {account: {period: amount}} - Period activity amounts
 * @param {string} queryType - 'cumulative' or 'periodActivity'
 * @param {string} fromPeriod - Optional: fromPeriod for period activity queries
 * @returns {number} Ending balance for the account at target period
 */
function computeEndingBalance(account, targetPeriod, openingBalances, activity, queryType = 'cumulative', fromPeriod = null) {
    if (queryType === 'periodActivity' && fromPeriod) {
        // CASE 2: Period activity query - return activity for the specific period range
        // For period activity, we need to sum activity from fromPeriod to toPeriod
        // The activity object contains period-level activity, so we sum all periods
        // between fromPeriod and toPeriod (inclusive)
        if (!activity[account]) {
            return 0; // No activity for this account in this period
        }
        
        const accountActivity = activity[account];
        const allPeriods = Object.keys(accountActivity).sort();
        
        // Sum activity for all periods between fromPeriod and targetPeriod (inclusive)
        let periodActivity = 0;
        for (const period of allPeriods) {
            if (period >= fromPeriod && period <= targetPeriod) {
                periodActivity += accountActivity[period] || 0;
            }
        }
        
        return periodActivity;
    } else {
        // CASE 1: Cumulative query - build ending balance from anchor
        const openingBalance = openingBalances[account] || 0;
        
        if (!activity[account]) {
            return openingBalance; // No activity for this account
        }
        
        // Get all periods up to and including target period
        const accountActivity = activity[account];
        const allPeriods = Object.keys(accountActivity).sort();
        
        // Sum activity for all periods <= targetPeriod
        let cumulativeActivity = 0;
        for (const period of allPeriods) {
            if (period <= targetPeriod) {
                cumulativeActivity += accountActivity[period] || 0;
            }
        }
        
        return openingBalance + cumulativeActivity;
    }
}

// Helper: Check if account type needs sign flip for Balance Sheet display
// Liabilities and Equity are stored as negative credits but display as positive
function needsSignFlip(acctType) {
    if (!acctType) return false;
    const flipTypes = [
        // Liabilities (stored negative, display positive)
        'AcctPay',        // Accounts Payable
        'CredCard',       // Credit Card
        'OthCurrLiab',    // Other Current Liability
        'LongTermLiab',   // Long Term Liability
        'DeferRevenue',   // Deferred Revenue
        // Equity (stored negative, display positive)
        'Equity',         // Equity
        'RetainedEarnings' // Retained Earnings
    ];
    return flipTypes.includes(acctType);
}

// Helper: Get account type from cache or fetch it
async function getAccountType(account) {
    const cacheKey = getCacheKey('type', { account });
    if (cache.type.has(cacheKey)) {
        const cached = cache.type.get(cacheKey);
        // Handle both string and object responses (cache may contain either)
        if (typeof cached === 'string') return cached;
        if (cached && typeof cached === 'object' && cached.type) return cached.type;
        return cached;
    }
    
    try {
        // Use POST to avoid exposing account numbers in URLs/logs
        const response = await fetch(`${SERVER_URL}/account/type`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ account: String(account) })
        });
        if (response.ok) {
            // Backend returns JSON object: { account, type, display_name }
            const data = await response.json();
            const type = data.type || data; // Extract type property, or use data if it's already a string
            cache.type.set(cacheKey, type); // Store just the type string for consistency
            return type;
        }
    } catch (e) {
        console.warn(`   ⚠️ Failed to get type for ${account}:`, e.message);
    }
    return null;
}

// Helper: Batch get account types (much faster than individual calls)
async function batchGetAccountTypes(accounts) {
    const result = {};
    const uncached = [];
    
    // First check cache
    for (const acct of accounts) {
        const cacheKey = getCacheKey('type', { account: acct });
        if (cache.type.has(cacheKey)) {
            result[acct] = cache.type.get(cacheKey);
        } else {
            uncached.push(acct);
        }
    }
    
    // Fetch uncached in batch
    if (uncached.length > 0) {
        try {
            const response = await fetch(`${SERVER_URL}/batch/account_types`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ accounts: uncached })  // Backend expects 'accounts'
            });
            if (response.ok) {
                const data = await response.json();
                // Backend returns 'account_types' not 'types'
                const types = data.account_types || data.types || {};
                for (const acct of uncached) {
                    const type = types[acct] || null;
                    result[acct] = type;
                    // Cache for future use
                    const cacheKey = getCacheKey('type', { account: acct });
                    cache.type.set(cacheKey, type);
                }
            }
        } catch (e) {
            console.warn(`   ⚠️ Batch account types failed:`, e.message);
        }
    }
    
    return result;
}

// Helper function to create a filter key for grouping
// Helper function to create a filter key for grouping
// ✅ Includes accounting book for manifest scoping
function getFilterKey(params) {
    const sub = String(params.subsidiary || '').trim();
    const dept = String(params.department || '').trim();
    const loc = String(params.location || '').trim();
    const cls = String(params.classId || '').trim();
    const book = String(params.accountingBook || '').trim();
    return `${sub}|${dept}|${loc}|${cls}|${book}`;
}

// Helper function to parse filter key back to filter object
// ✅ Updated to include accounting book
function parseFilterKey(filterKey) {
    const parts = filterKey.split('|');
    return {
        subsidiary: parts[0] || '',
        department: parts[1] || '',
        location: parts[2] || '',
        classId: parts[3] || '',
        accountingBook: parts[4] || ''
    };
}

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
                
                // Handle period ranges - make single API call with full range
                const fromPeriodStr = String(fromPeriod || '').trim();
                const toPeriodStr = String(toPeriod || '').trim();
                const isPeriodRange = fromPeriodStr && toPeriodStr && fromPeriodStr !== toPeriodStr;
                
                if (isPeriodRange) {
                    // Single API call for full period range
                    const apiParams = new URLSearchParams({
                        account: account,
                        from_period: fromPeriodStr,
                        to_period: toPeriodStr,
                        subsidiary: subsidiary || '',
                        currency: currency || '',
                        department: department || '',
                        location: location || '',
                        class: classId || '',
                        book: accountingBook || ''
                    });
                    
                    console.log(`   📤 BALANCECURRENCY API (range ${fromPeriodStr} to ${toPeriodStr}): ${account} (currency: ${currency || 'default'})`);
                    
                    const response = await fetch(`${SERVER_URL}/balancecurrency?${apiParams.toString()}`);
                    
                    if (response.ok) {
                        const data = await response.json();
                        const value = data.balance ?? 0;
                        const errorCode = data.error;
                        
                        if (errorCode) {
                            console.log(`   ⚠️ BALANCECURRENCY range result: ${account} = ${errorCode}`);
                            item.reject(new Error(errorCode));
                        } else {
                            console.log(`   ✅ BALANCECURRENCY range result: ${account} = ${value.toLocaleString()} (period range ${fromPeriodStr} to ${toPeriodStr})`);
                            cache.balance.set(cacheKey, value);
                            item.resolve(value);
                        }
                    } else {
                        const errorCode = response.status === 408 || response.status === 504 ? 'TIMEOUT' : 'APIERR';
                        console.error(`   ❌ BALANCECURRENCY range API error: ${response.status} → ${errorCode}`);
                        item.reject(new Error(errorCode));
                    }
                } else {
                    // Single period or cumulative
                    const apiParams = new URLSearchParams({
                        account: account,
                        from_period: fromPeriod || '',
                        to_period: toPeriod,
                        subsidiary: subsidiary || '',
                        currency: currency || '',
                        department: department || '',
                        location: location || '',
                        class: classId || '',
                        book: accountingBook || ''
                    });
                    
                    console.log(`   📤 BALANCECURRENCY API: ${account} for ${fromPeriod || '(cumulative)'} → ${toPeriod} (currency: ${currency || 'default'})`);
                    
                    const response = await fetch(`${SERVER_URL}/balancecurrency?${apiParams.toString()}`);
                    
                    if (response.ok) {
                        const data = await response.json();
                        const value = data.balance ?? 0;
                        const errorCode = data.error;
                        
                        if (errorCode) {
                            console.log(`   ⚠️ BALANCECURRENCY result: ${account} = ${errorCode}`);
                            item.reject(new Error(errorCode));
                        } else {
                            console.log(`   ✅ BALANCECURRENCY result: ${account} = ${value.toLocaleString()}`);
                            cache.balance.set(cacheKey, value);
                            item.resolve(value);
                        }
                    } else {
                        const errorCode = response.status === 408 || response.status === 504 ? 'TIMEOUT' : 'APIERR';
                        console.error(`   ❌ BALANCECURRENCY API error: ${response.status} → ${errorCode}`);
                        item.reject(new Error(errorCode));
                    }
                }
            } catch (error) {
                const errorCode = error.name === 'AbortError' ? 'TIMEOUT' : 'NETFAIL';
                console.error(`   ❌ BALANCECURRENCY fetch error: ${error.message} → ${errorCode}`);
                item.reject(new Error(errorCode));
            }
        }
    }
    
    if (cumulativeItems.length > 0) {
        console.log(`📊 BUILD MODE: Processing ${cumulativeItems.length} CUMULATIVE (BS) requests...`);
        broadcastStatus(`Processing ${cumulativeItems.length} cumulative balance(s)...`, 10, 'info');
        
        let cacheHits = 0;
        let apiCalls = 0;
        let deduplicated = 0;
        
        // ================================================================
        // DEDUPLICATION: Group identical requests by cache key
        // INVARIANT: Identical formulas must collapse into a single API call
        // ================================================================
        const uniqueRequests = new Map(); // cacheKey -> { params, items: [] }
        for (const item of cumulativeItems) {
            const cacheKey = getCacheKey('balance', item.params);
            if (!uniqueRequests.has(cacheKey)) {
                uniqueRequests.set(cacheKey, { params: item.params, items: [item] });
            } else {
                uniqueRequests.get(cacheKey).items.push(item);
                deduplicated++;
            }
        }
        
        if (deduplicated > 0) {
            console.log(`   🔄 DEDUPLICATED: ${cumulativeItems.length} requests → ${uniqueRequests.size} unique (saved ${deduplicated} API calls)`);
        }
        
        // Rate limiting to avoid NetSuite 429 CONCURRENCY_LIMIT_EXCEEDED errors
        // NetSuite allows ~5-10 concurrent requests; we serialize to be safe
        const RATE_LIMIT_DELAY = 150; // ms between API calls
        const rateLimitSleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
        
        // Process each UNIQUE request once
        for (const [cacheKey, { params, items }] of uniqueRequests) {
            const { account, fromPeriod, toPeriod, subsidiary, currency, department, location, classId, accountingBook } = params;
            
            // ================================================================
            // TRY WILDCARD CACHE RESOLUTION FIRST
            // If account has *, try to sum matching accounts from cache
            // ================================================================
            if (account.includes('*')) {
                const wildcardResult = resolveWildcardFromCache(account, fromPeriod, toPeriod, subsidiary);
                if (wildcardResult !== null) {
                    console.log(`   🎯 Wildcard cache hit: ${account} = ${wildcardResult.total.toLocaleString()} (${wildcardResult.matchCount} accounts)`);
                    cache.balance.set(cacheKey, wildcardResult.total);
                    // Resolve ALL items waiting for this result
                    items.forEach(item => item.resolve(wildcardResult.total));
                    cacheHits++;
                    continue; // Skip API call
                }
            }
            
            // ================================================================
            // CHECK LOCALSTORAGE PRELOAD CACHE (Issue 2B Fix - Build Mode)
            // CRITICAL: Check preload cache before making API calls
            // This ensures build mode uses preloaded data instead of making redundant API calls
            // ================================================================
            if (!subsidiary) {  // Skip for subsidiary-filtered queries (localStorage not subsidiary-aware)
                const localStorageValue = checkLocalStorageCache(account, fromPeriod, toPeriod, subsidiary);
                if (localStorageValue !== null) {
                    console.log(`   ✅ Preload cache hit (build mode - cumulative): ${account} for ${fromPeriod || '(cumulative)'} → ${toPeriod} = ${localStorageValue}`);
                    cache.balance.set(cacheKey, localStorageValue);
                    // Resolve ALL items waiting for this result
                    items.forEach(item => item.resolve(localStorageValue));
                    cacheHits++;
                    continue; // Skip API call
                }
            }
            
            // ================================================================
            // CACHE MISS - Call API (ONCE for all identical requests)
            // For wildcards, request breakdown so we can cache individual accounts
            // ================================================================
            try {
                const isWildcard = account.includes('*');
                const params = new URLSearchParams({
                    account: account,
                    from_period: '',
                    to_period: toPeriod,
                    subsidiary: subsidiary || '',
                    department: department || '',
                    location: location || '',
                    class: classId || '',
                    accountingbook: accountingBook || ''
                });
                
                // Request breakdown for wildcards so we can cache individual accounts
                if (isWildcard) {
                    params.append('include_breakdown', 'true');
                }
                
                const waitingCount = items.length > 1 ? ` (${items.length} formulas waiting)` : '';
                console.log(`   📤 Cumulative API: ${account} through ${toPeriod}${isWildcard ? ' (with breakdown)' : ''}${waitingCount}`);
                
                // Rate limit: wait before making request if we've already made calls
                // Prevents NetSuite 429 CONCURRENCY_LIMIT_EXCEEDED errors
                if (apiCalls > 0) {
                    await rateLimitSleep(RATE_LIMIT_DELAY);
                }
                apiCalls++;
                
                const response = await fetch(`${SERVER_URL}/balance?${params.toString()}`);
                
                if (response.ok) {
                    const contentType = response.headers.get('content-type') || '';
                    
                    if (isWildcard && contentType.includes('application/json')) {
                        // Parse JSON response with breakdown
                        const data = await response.json();
                        const total = data.total || 0;
                        const accounts = data.accounts || {};
                        const period = data.period || toPeriod;
                        
                        console.log(`   ✅ Wildcard result: ${account} = ${total.toLocaleString()} (${Object.keys(accounts).length} accounts)`);
                        
                        // Cache the total for this wildcard pattern
                        cache.balance.set(cacheKey, total);
                        
                        // CRITICAL: Cache individual accounts for future wildcard resolution!
                        // This enables other wildcards like "101*" to resolve from cache
                        cacheIndividualAccounts(accounts, period, subsidiary);
                        
                        // Resolve ALL items waiting for this result
                        items.forEach(item => item.resolve(total));
                    } else {
                        // Parse JSON response for balance and error
                        let value = 0;
                        let errorCode = null;
                        
                        try {
                            const data = await response.json();
                            // DEBUG: Log raw response to catch parsing issues
                            console.log(`   📋 Raw JSON response:`, JSON.stringify(data).substring(0, 200));
                            
                            // Handle balance - could be number or null
                            if (typeof data.balance === 'number') {
                                value = data.balance;
                            } else if (data.balance !== null && data.balance !== undefined) {
                                value = parseFloat(data.balance) || 0;
                            }
                            errorCode = data.error || null;
                            
                            // CRITICAL: For BALANCECURRENCY, if balance is null and no explicit error code,
                            // check if currency was requested. If so, this likely means BUILTIN.CONSOLIDATE
                            // returned NULL for all transactions (invalid currency conversion path).
                            // Return INV_SUB_CUR instead of 0 to prevent misleading data.
                            // Note: Check cacheKey to detect BALANCECURRENCY requests
                            const isBalanceCurrency = cacheKey.includes('"type":"balancecurrency"');
                            if (isBalanceCurrency && data.balance === null && !errorCode) {
                                // Extract currency from params (params is destructured from uniqueRequests)
                                const currency = params.currency;
                                if (currency) {
                                    console.warn(`   ⚠️ BALANCECURRENCY: Balance is null for currency ${currency} - likely invalid conversion path`);
                                    errorCode = 'INV_SUB_CUR';
                                }
                            }
                        } catch (parseError) {
                            // JSON parsing failed - try to get raw text for debugging
                            console.error(`   ❌ JSON parse failed: ${parseError.message}`);
                            // Note: response body already consumed, can't read again
                            value = 0;
                        }
                        
                        if (errorCode) {
                            // Reject with error code - Excel will display #ERROR!
                            // CRITICAL: Do NOT cache error codes - they should be re-evaluated
                            console.log(`   ⚠️ Cumulative result: ${account} = ${errorCode}`);
                            items.forEach(item => item.reject(new Error(errorCode)));
                        } else {
                            console.log(`   ✅ Cumulative result: ${account} = ${value.toLocaleString()}`);
                            // Only cache valid numeric values, not errors or null
                            cache.balance.set(cacheKey, value);
                            // Resolve ALL items waiting for this result
                            items.forEach(item => item.resolve(value));
                        }
                    }
                } else {
                    // HTTP error - reject with informative error code
                    // 522/523/524 are Cloudflare timeout errors
                    const errorCode = [408, 504, 522, 523, 524].includes(response.status) ? 'TIMEOUT' :
                                     response.status === 429 ? 'RATELIMIT' :
                                     response.status === 401 || response.status === 403 ? 'AUTHERR' :
                                     response.status >= 500 ? 'SERVERR' :
                                     'APIERR';
                    console.error(`   ❌ Cumulative API error: ${response.status} → ${errorCode}`);
                    items.forEach(item => item.reject(new Error(errorCode)));
                }
            } catch (error) {
                // Network error - reject with informative error code
                const errorCode = error.name === 'AbortError' ? 'TIMEOUT' : 'NETFAIL';
                console.error(`   ❌ Cumulative fetch error: ${error.message} → ${errorCode}`);
                items.forEach(item => item.reject(new Error(errorCode)));
            }
        }
        
        if (cacheHits > 0 || apiCalls > 0 || deduplicated > 0) {
            console.log(`   📊 Cumulative summary: ${cacheHits} cache hits, ${apiCalls} API calls, ${deduplicated} deduplicated`);
        }
    }
    
    // If no regular items, we're done
    if (regularItems.length === 0) {
        const elapsed = ((Date.now() - batchStartTime) / 1000).toFixed(2);
        console.log(`✅ BUILD MODE COMPLETE in ${elapsed}s (${cumulativeItems.length} cumulative only)`);
        broadcastStatus(`Complete!`, 100, 'success');
        return;
    }
    
    console.log(`📦 BUILD MODE: Processing ${regularItems.length} regular (period-based) requests...`);
    
    // Group pending formulas by their filter combination
    const filterGroups = new Map();
    for (const item of regularItems) {
        const filterKey = getFilterKey(item.params);
        if (!filterGroups.has(filterKey)) {
            filterGroups.set(filterKey, []);
        }
        filterGroups.get(filterKey).push(item);
    }
    
    const groupCount = filterGroups.size;
    
    // Collect ALL unique accounts to detect types
    const allAccountsSet = new Set();
    for (const item of regularItems) {
        allAccountsSet.add(item.params.account);
    }
    const allAccountsArray = Array.from(allAccountsSet);
    
    // Detect account types ONCE
    broadcastStatus(`Detecting account types...`, 5, 'info');
    const accountTypes = await batchGetAccountTypes(allAccountsArray);
    
    // STEP 3: Process each filter group separately
    let groupIndex = 0;
    let totalResolved = 0;
    let totalZeros = 0;
    
    for (const [filterKey, groupItemsArray] of filterGroups) {
        groupIndex++;
        const filters = parseFilterKey(filterKey);
        
        // CRITICAL: Check if this group contains BALANCECURRENCY requests
        // BALANCECURRENCY requests cannot use /batch/balance (doesn't support currency)
        // They must be processed individually using /balancecurrency endpoint
        const balanceCurrencyItems = [];
        const regularBalanceItems = [];
        
        // Use groupItemsArray to avoid variable shadowing issues
        for (const item of groupItemsArray) {
            // Check if this is a BALANCECURRENCY request
            const isBalanceCurrency = item.cacheKey && item.cacheKey.includes('"type":"balancecurrency"') ||
                                     (item.params && 'currency' in item.params && item.params.currency);
            
            if (isBalanceCurrency) {
                balanceCurrencyItems.push(item);
            } else {
                regularBalanceItems.push(item);
            }
        }
        
        // Process BALANCECURRENCY requests separately (they need individual /balancecurrency calls)
        if (balanceCurrencyItems.length > 0) {
            console.log(`   💱 BUILD MODE: Processing ${balanceCurrencyItems.length} BALANCECURRENCY requests individually (batch endpoint doesn't support currency)`);
            broadcastStatus(`Processing ${balanceCurrencyItems.length} currency conversion(s)...`, 50, 'info');
            
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
                    
                    // Make individual API call
                    const apiParams = new URLSearchParams({
                        account: account,
                        from_period: fromPeriod || '',
                        to_period: toPeriod,
                        subsidiary: subsidiary || '',
                        currency: currency || '',
                        department: department || '',
                        location: location || '',
                        class: classId || '',
                        book: accountingBook || ''
                    });
                    
                    console.log(`   📤 BALANCECURRENCY API: ${account} for ${fromPeriod || '(cumulative)'} → ${toPeriod} (currency: ${currency || 'default'})`);
                    
                    const response = await fetch(`${SERVER_URL}/balancecurrency?${apiParams.toString()}`);
                    
                    if (response.ok) {
                        const data = await response.json();
                        const value = data.balance ?? 0;
                        const errorCode = data.error;
                        
                        if (errorCode) {
                            console.log(`   ⚠️ BALANCECURRENCY result: ${account} = ${errorCode}`);
                            item.reject(new Error(errorCode));
                        } else {
                            console.log(`   ✅ BALANCECURRENCY result: ${account} = ${value.toLocaleString()}`);
                            cache.balance.set(cacheKey, value);
                            item.resolve(value);
                        }
                    } else {
                        const errorCode = response.status === 408 || response.status === 504 ? 'TIMEOUT' : 'APIERR';
                        console.error(`   ❌ BALANCECURRENCY API error: ${response.status} → ${errorCode}`);
                        item.reject(new Error(errorCode));
                    }
                } catch (error) {
                    const errorCode = error.name === 'AbortError' ? 'TIMEOUT' : 'NETFAIL';
                    console.error(`   ❌ BALANCECURRENCY fetch error: ${error.message} → ${errorCode}`);
                    item.reject(new Error(errorCode));
                }
            }
        }
        
        // Skip regular batch processing if all items were BALANCECURRENCY
        if (regularBalanceItems.length === 0) {
            continue; // Move to next filter group
        }
        
        // Continue with regular BALANCE processing for non-BALANCECURRENCY items
        // Note: groupItems is already declared in the loop destructuring above, so we reassign it
        // groupItems = regularBalanceItems; // Use only regular items for batch processing
        // Actually, we should use regularBalanceItems directly instead of reassigning groupItems
        // to avoid confusion. Let's create a new variable for clarity.
        const regularGroupItems = regularBalanceItems; // Use only regular items for batch processing
        
        // Collect unique accounts and periods for THIS filter group (regular items only)
        const accounts = new Set();
        const periods = new Set();
        
        for (const item of regularGroupItems) {
            const p = item.params;
            accounts.add(p.account);
            
            // DEBUG: Log what we're processing
            console.log(`   📅 Processing: ${p.account} from=${p.fromPeriod} to=${p.toPeriod}`);
            
            // Helper to check if a period is year-only (e.g., "2024")
            const isYearOnly = (str) => str && /^\d{4}$/.test(String(str).trim());
            
            // If there's a date RANGE (fromPeriod !== toPeriod), expand to all months
            if (p.fromPeriod && p.toPeriod && p.fromPeriod !== p.toPeriod) {
                // Use the second expandPeriodRange function that takes (from, to) 
                const expandedPeriods = expandPeriodRangeFromTo(p.fromPeriod, p.toPeriod);
                console.log(`   📅 EXPANDING range: ${p.fromPeriod} to ${p.toPeriod} → ${expandedPeriods.length} periods`);
                for (const period of expandedPeriods) {
                    periods.add(period);
                }
            } else if (p.fromPeriod && p.fromPeriod !== '') {
                // Check if it's a year-only period that needs expansion
                if (isYearOnly(p.fromPeriod)) {
                    const expandedPeriods = expandPeriodRangeFromTo(p.fromPeriod, p.fromPeriod);
                    console.log(`   📅 Year-only period: ${p.fromPeriod} → ${expandedPeriods.length} months`);
                    for (const period of expandedPeriods) {
                        periods.add(period);
                    }
                } else {
                console.log(`   📅 Single period (from): ${p.fromPeriod}`);
                periods.add(p.fromPeriod);
                }
            } else if (p.toPeriod && p.toPeriod !== '') {
                // Check if it's a year-only period that needs expansion
                if (isYearOnly(p.toPeriod)) {
                    const expandedPeriods = expandPeriodRangeFromTo(p.toPeriod, p.toPeriod);
                    console.log(`   📅 Year-only period: ${p.toPeriod} → ${expandedPeriods.length} months`);
                    for (const period of expandedPeriods) {
                        periods.add(period);
                    }
                } else {
                console.log(`   📅 Single period (to): ${p.toPeriod}`);
                periods.add(p.toPeriod);
                }
            }
        }
        
        const periodsArray = Array.from(periods).filter(p => p && p !== '');
        const accountsArray = Array.from(accounts);
        
        const allBalances = {};
        let hasError = false;
        
        // Detect years from periods (handles both "Mon YYYY" and year-only "YYYY" formats)
        const years = new Set(periodsArray.map(p => {
            if (!p) return null;
            // Year-only format (e.g., "2024")
            if (/^\d{4}$/.test(p)) return p;
            // "Mon YYYY" format
            if (p.includes(' ')) return p.split(' ')[1];
            return null;
        }).filter(y => y && !isNaN(parseInt(y))));
        const yearsArray = Array.from(years);
        
        // Classify accounts
        const plAccounts = [];
        const bsAccounts = [];
        for (const acct of accountsArray) {
            if (isBalanceSheetType(accountTypes[acct])) {
                bsAccounts.push(acct);
            } else {
                plAccounts.push(acct);
            }
        }
        
        const usePLFullYear = yearsArray.length > 0 && plAccounts.length >= 5;
        
        // STEP 4: Fetch Balance Sheet accounts for this filter group
        if (bsAccounts.length > 0 && periodsArray.length > 0) {
            // Expand period range for better cache coverage
            const expandedBSPeriods = expandPeriodRange(periodsArray, 1, 1);
            
            // CHECK CACHE FIRST (using EXPANDED periods)
            let allBSInCache = true;
            let cachedBSValues = {};
            
            for (const acct of bsAccounts) {
                cachedBSValues[acct] = {};
                for (const period of expandedBSPeriods) {
                    const ck = getCacheKey('balance', {
                        account: acct,
                        fromPeriod: period,
                        toPeriod: period,
                        subsidiary: filters.subsidiary,
                        department: filters.department,
                        location: filters.location,
                        classId: filters.classId
                    });
                    
                    if (cache.balance.has(ck)) {
                        cachedBSValues[acct][period] = cache.balance.get(ck);
                    } else {
                        allBSInCache = false;
                        break;
                    }
                }
                if (!allBSInCache) break;
            }
            
            if (allBSInCache) {
                broadcastStatus(`Using cached Balance Sheet data`, 20, 'info');
                
                for (const acct of bsAccounts) {
                    if (!allBalances[acct]) allBalances[acct] = {};
                    for (const period of expandedBSPeriods) {
                        allBalances[acct][period] = cachedBSValues[acct][period];
                    }
                }
            } else {
                console.log(`   📊 Fetching Balance Sheet accounts (${expandedBSPeriods.length} periods, expanded from ${periodsArray.length})...`);
                broadcastStatus(`Fetching Balance Sheet data...`, 15, 'info');
                
                const bsStartTime = Date.now();
                try {
                    const response = await fetch(`${SERVER_URL}/batch/bs_periods`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            periods: expandedBSPeriods,  // Use expanded periods!
                            subsidiary: filters.subsidiary,
                            department: filters.department,
                            location: filters.location,
                            class: filters.classId,
                            accountingbook: filters.accountingBook || ''  // Multi-Book Accounting support
                        })
                    });
                    
                    if (response.ok) {
                        const data = await response.json();
                        const bsBalances = data.balances || {};
                        const bsTime = ((Date.now() - bsStartTime) / 1000).toFixed(1);
                        const bsAccountCount = Object.keys(bsBalances).length;
                        console.log(`   ✅ BS: ${bsAccountCount} accounts in ${bsTime}s`);
                        
                        // Cache ALL Balance Sheet accounts with THIS filter group's filters
                        let bsCached = 0;
                        for (const acct in bsBalances) {
                            if (!allBalances[acct]) allBalances[acct] = {};
                            for (const period in bsBalances[acct]) {
                                allBalances[acct][period] = bsBalances[acct][period];
                                const ck = getCacheKey('balance', {
                                    account: acct,
                                    fromPeriod: period,
                                    toPeriod: period,
                                    subsidiary: filters.subsidiary,
                                    department: filters.department,
                                    location: filters.location,
                                    classId: filters.classId
                                });
                                cache.balance.set(ck, bsBalances[acct][period]);
                                bsCached++;
                            }
                        }
                        console.log(`   💾 Cached ${bsCached} BS values with filters: sub="${filters.subsidiary}"`);
                    } else {
                        console.error(`   ❌ BS multi-period error: ${response.status}`);
                        hasError = true;
                    }
                } catch (error) {
                    console.error(`   ❌ BS fetch error:`, error);
                    hasError = true;
                }
            }
        }
        
        // STEP 5: Fetch P&L accounts for this filter group
        // NOTE: BALANCECURRENCY requests are already processed above, so this only handles regular BALANCE requests
        if (plAccounts.length > 0 && yearsArray.length > 0) {
            // CHECK CACHE FIRST for P&L accounts
            let allPLInCache = true;
            let cachedPLValues = {};
            
            for (const acct of plAccounts) {
                cachedPLValues[acct] = {};
                for (const period of periodsArray) {
                    const ck = getCacheKey('balance', {
                        account: acct,
                        fromPeriod: period,
                        toPeriod: period,
                        subsidiary: filters.subsidiary,
                        department: filters.department,
                        location: filters.location,
                        classId: filters.classId
                    });
                    
                    if (cache.balance.has(ck)) {
                        cachedPLValues[acct][period] = cache.balance.get(ck);
                    } else {
                        allPLInCache = false;
                        break;
                    }
                }
                if (!allPLInCache) break;
            }
            
            if (allPLInCache) {
                broadcastStatus(`Using cached P&L data`, 70, 'info');
                
                for (const acct of plAccounts) {
                    if (!allBalances[acct]) allBalances[acct] = {};
                    for (const period of periodsArray) {
                        allBalances[acct][period] = cachedPLValues[acct][period];
                    }
                }
            } else if (usePLFullYear) {
                console.log(`   ⚡ P&L FAST PATH: full_year_refresh for ${yearsArray.length} year(s)`);
                broadcastStatus(`Fetching P&L data for ${yearsArray.join(', ')}...`, 60, 'info');
                
                try {
                    for (const year of yearsArray) {
                        const yearStartTime = Date.now();
                        console.log(`   📡 Fetching P&L year ${year}...`);
                        
                        const response = await fetch(`${SERVER_URL}/batch/full_year_refresh`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                year: parseInt(year),
                                subsidiary: filters.subsidiary,
                                department: filters.department,
                                location: filters.location,
                                class: filters.classId,
                                skip_bs: true,
                                accountingbook: filters.accountingBook || ''  // Multi-Book Accounting support
                            })
                        });
                        
                        if (response.ok) {
                            const data = await response.json();
                            const yearBalances = data.balances || {};
                            const yearTime = ((Date.now() - yearStartTime) / 1000).toFixed(1);
                            console.log(`   ✅ P&L Year ${year}: ${Object.keys(yearBalances).length} accounts in ${yearTime}s`);
                            
                            // Cache with THIS filter group's filters
                            let plCached = 0;
                            for (const acct in yearBalances) {
                                if (!allBalances[acct]) allBalances[acct] = {};
                                for (const period in yearBalances[acct]) {
                                    allBalances[acct][period] = yearBalances[acct][period];
                                    const ck = getCacheKey('balance', {
                                        account: acct,
                                        fromPeriod: period,
                                        toPeriod: period,
                                        subsidiary: filters.subsidiary,
                                        department: filters.department,
                                        location: filters.location,
                                        classId: filters.classId
                                    });
                                    cache.balance.set(ck, yearBalances[acct][period]);
                                    plCached++;
                                }
                            }
                            console.log(`   💾 Cached ${plCached} P&L values`);
                        } else {
                            console.error(`   ❌ P&L Year ${year} error: ${response.status}`);
                            hasError = true;
                        }
                    }
                } catch (error) {
                    console.error(`   ❌ P&L full_year_refresh error:`, error);
                    hasError = true;
                }
            } else {
                // SMART PERIOD EXPANSION: Same as BS, include adjacent months
                const expandedPLPeriods = expandPeriodRange(periodsArray, 1, 1);
                console.log(`   📦 P&L: Using batch/balance for ${plAccounts.length} accounts (${expandedPLPeriods.length} periods, expanded from ${periodsArray.length})`);
                broadcastStatus(`Fetching P&L data...`, 60, 'info');
                
                try {
                    const response = await fetch(`${SERVER_URL}/batch/balance`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            accounts: plAccounts,
                            periods: expandedPLPeriods,  // Use expanded periods!
                            subsidiary: filters.subsidiary,
                            department: filters.department,
                            location: filters.location,
                            class: filters.classId,
                            accountingbook: filters.accountingBook || ''  // Multi-Book Accounting support
                        })
                    });
                    
                    if (response.ok) {
                        const data = await response.json();
                        const balances = data.balances || {};
                        console.log(`   ✅ P&L batch: ${Object.keys(balances).length} accounts`);
                        
                        // Cache with THIS filter group's filters
                        for (const acct in balances) {
                            if (!allBalances[acct]) allBalances[acct] = {};
                            for (const period in balances[acct]) {
                                allBalances[acct][period] = balances[acct][period];
                                const ck = getCacheKey('balance', {
                                    account: acct,
                                    fromPeriod: period,
                                    toPeriod: period,
                                    subsidiary: filters.subsidiary,
                                    department: filters.department,
                                    location: filters.location,
                                    classId: filters.classId
                                });
                                cache.balance.set(ck, balances[acct][period]);
                            }
                        }
                        
                        // Cache $0 for P&L accounts not returned (for expanded periods)
                        for (const acct of plAccounts) {
                            if (!allBalances[acct]) allBalances[acct] = {};
                            for (const period of expandedPLPeriods) {
                                if (allBalances[acct][period] === undefined) {
                                    allBalances[acct][period] = 0;
                                    const ck = getCacheKey('balance', {
                                        account: acct,
                                        fromPeriod: period,
                                        toPeriod: period,
                                        subsidiary: filters.subsidiary,
                                        department: filters.department,
                                        location: filters.location,
                                        classId: filters.classId
                                    });
                                    cache.balance.set(ck, 0);
                                }
                            }
                        }
                    } else {
                        console.error(`   ❌ P&L batch error: ${response.status}`);
                        hasError = true;
                    }
                } catch (error) {
                    console.error(`   ❌ P&L batch fetch error:`, error);
                    hasError = true;
                }
            }
        }
        
        // Ensure all requested BS accounts have values (even if 0)
        // IMPORTANT: Also cache $0 values with the normalized key so future lookups find them!
        let zeroCached = 0;
        for (const acct of bsAccounts) {
            if (!allBalances[acct]) allBalances[acct] = {};
            for (const period of periodsArray) {
                if (allBalances[acct][period] === undefined) {
                    allBalances[acct][period] = 0;
                    
                    // Cache $0 with the normalized key (fromPeriod = period, toPeriod = period)
                    // This ensures the next drag finds it in cache!
                    const ck = getCacheKey('balance', {
                        account: acct,
                        fromPeriod: period,
                        toPeriod: period,
                        subsidiary: filters.subsidiary,
                        department: filters.department,
                        location: filters.location,
                        classId: filters.classId
                    });
                    cache.balance.set(ck, 0);
                    zeroCached++;
                }
            }
        }
        if (zeroCached > 0) {
            console.log(`   💾 Cached ${zeroCached} zero-balance BS values`);
        }
        
        console.log(`   📊 Total accounts with data: ${Object.keys(allBalances).join(', ') || 'none'}`);
        
        // Track which periods had successful responses
        const successfulPeriods = new Set();
        for (const acct in allBalances) {
            for (const period in allBalances[acct]) {
                successfulPeriods.add(period);
            }
        }
        
        // STEP 6: Resolve all pending promises for THIS filter group (regular items only)
        // Note: balanceCurrencyItems were already resolved individually above
        for (const item of regularGroupItems) {
            const { params, resolve, cacheKey } = item;
            const { account, fromPeriod, toPeriod } = params;
            
            // If there's a date RANGE, sum ALL months in that range
            let value = 0;
            let foundAny = false;
            
            // WILDCARD SUPPORT: If account contains *, check if pre-summed result exists
            const isWildcard = account && account.includes('*');
            const wildcardPrefix = isWildcard ? account.replace('*', '') : null;
            
            // Get the list of accounts to sum (single account or all matching wildcard)
            // IMPORTANT: If the wildcard key itself exists (e.g., "4*"), use it directly!
            // This handles the case where /batch/balance returns a pre-summed wildcard.
            // Don't sum individual accounts again or we'll double-count.
            let accountsToSum;
            if (isWildcard && allBalances[account]) {
                // Pre-summed wildcard exists - use it directly
                accountsToSum = [account];
                console.log(`   🎯 Wildcard ${account}: using pre-summed value from backend`);
            } else if (isWildcard) {
                // No pre-summed value - sum matching accounts manually
                accountsToSum = Object.keys(allBalances).filter(acct => acct.startsWith(wildcardPrefix) && !acct.includes('*'));
                console.log(`   🔍 Wildcard ${account}: summing ${accountsToSum.length} matching accounts`);
            } else {
                accountsToSum = (allBalances[account] ? [account] : []);
            }
            
            if (fromPeriod && toPeriod && fromPeriod !== toPeriod) {
                // SUM all months in the range for all matching accounts
                const periodsToSum = expandPeriodRangeFromTo(fromPeriod, toPeriod);
                for (const acct of accountsToSum) {
                    for (const period of periodsToSum) {
                        if (allBalances[acct] && allBalances[acct][period] !== undefined) {
                            value += allBalances[acct][period];
                            foundAny = true;
                        }
                    }
                }
            } else {
                // Single period lookup - sum all matching accounts for this period
                const lookupPeriod = (fromPeriod && fromPeriod !== '') ? fromPeriod : toPeriod;
                for (const acct of accountsToSum) {
                    if (allBalances[acct] && allBalances[acct][lookupPeriod] !== undefined) {
                        value += allBalances[acct][lookupPeriod];
                        foundAny = true;
                    }
                }
            }
            
            if (isWildcard && foundAny) {
                console.log(`   🔍 Wildcard ${account} for ${fromPeriod}: summed ${accountsToSum.length} accounts = ${value.toFixed(2)}`);
            }
            
            if (foundAny) {
                // Cache with the ORIGINAL request's cacheKey (includes its own filters)
                cache.balance.set(cacheKey, value);
                resolve(value);
                totalResolved++;
            } else if (hasError) {
                resolve('');
                totalZeros++;
            } else {
                cache.balance.set(cacheKey, 0);
                resolve(0);
                totalZeros++;
            }
        }
    } // End of filter group loop
    
    const totalTime = ((Date.now() - batchStartTime) / 1000).toFixed(1);
    console.log(`   📊 Resolved: ${totalResolved} with values, ${totalZeros} zeros/errors`);
    console.log(`   ⏱️ TOTAL BUILD MODE TIME: ${totalTime}s`);
    
    // Calculate totals for user-friendly status message
    const requestedCells = pending.length;  // What user actually asked for
    // Note: We can't easily count total preloaded across filter groups, so just report requested cells
    
    // Broadcast completion with helpful info
    const anyError = totalZeros > 0 && totalResolved === 0;
    if (anyError) {
        broadcastStatus(`Completed with errors (${totalTime}s)`, 100, 'error');
    } else {
        // User-friendly message
        let msg = `✅ Updated ${requestedCells} cells`;
        if (groupCount > 1) {
            msg += ` (${groupCount} filter groups)`;
        }
        msg += ` (${totalTime}s)`;
        broadcastStatus(msg, 100, 'success');
    }
    // Clear status after delay
    setTimeout(clearStatus, 10000);  // Extended to 10s so user can read the helpful info
}

// Resolve ALL pending balance requests from cache (called by taskpane after cache is ready)
window.resolvePendingRequests = function() {
    console.log('🔄 RESOLVING ALL PENDING REQUESTS FROM CACHE...');
    let resolved = 0;
    let failed = 0;
    
    for (const [cacheKey, request] of Array.from(pendingRequests.balance.entries())) {
        const { params, resolve } = request;
        const { account, fromPeriod, toPeriod, subsidiary, currency } = params;
        
        // CRITICAL: Skip currency-agnostic cache lookups for BALANCECURRENCY requests
        // localStorage and fullYearCache don't support currency, so they would return
        // BALANCE values (in subsidiary's base currency) instead of converted amounts
        const isBalanceCurrency = cacheKey.includes('"type":"balancecurrency"') || (currency && currency !== '');
        
        let value = null;
        
        if (!isBalanceCurrency) {
            // For regular BALANCE requests, use currency-agnostic caches
            // For cumulative queries (empty fromPeriod), use toPeriod for lookup
            const lookupPeriod = (fromPeriod && fromPeriod !== '') ? fromPeriod : toPeriod;
            
            // Try to get value from localStorage cache (skip if subsidiary filter)
            value = checkLocalStorageCache(account, fromPeriod, toPeriod, subsidiary);
            
            // Fallback to fullYearCache (skip if subsidiary filter)
            if (value === null) {
                value = checkFullYearCache(account, lookupPeriod, subsidiary);
            }
        }
        // For BALANCECURRENCY, value remains null - will be resolved by batch processor
        
        if (value !== null) {
            resolve(value);
            cache.balance.set(cacheKey, value);
            resolved++;
        } else {
            // No value found in currency-agnostic caches
            // For BALANCECURRENCY, this is expected - batch processor will handle it
            // For BALANCE, DO NOT resolve with 0 - leave in queue for normal API batch path
            // ✅ CORRECTNESS: Never return 0 unless explicitly cached from NetSuite
            if (!isBalanceCurrency) {
                // Leave in pendingRequests - normal batch path will handle it
                // This ensures we never return phantom zeros
                failed++;
            }
            // For BALANCECURRENCY, leave in queue for batch processor
        }
        
        // Only delete from queue if we resolved it (BALANCE with cache hit, or BALANCE with no transactions)
        if (value !== null || !isBalanceCurrency) {
            pendingRequests.balance.delete(cacheKey);
        }
    }
    
    console.log(`   Resolved: ${resolved}, Not in cache (left in queue for API): ${failed}`);
    console.log(`   Remaining pending: ${pendingRequests.balance.size}`);
    return { resolved, failed };
};

// ============================================================================
// SHARED STORAGE CACHE - Uses localStorage for cross-context communication
// This works even when Shared Runtime is NOT active!
// ============================================================================
const STORAGE_KEY = 'netsuite_balance_cache';
const STORAGE_TIMESTAMP_KEY = 'netsuite_balance_cache_timestamp';
const STORAGE_TTL = 300000; // 5 minutes in milliseconds

// TYPEBALANCE localStorage cache - critical for pre-fetch before functions.html loads!
const TYPEBALANCE_STORAGE_KEY = 'netsuite_typebalance_cache';
const TYPEBALANCE_STORAGE_TIMESTAMP_KEY = 'netsuite_typebalance_cache_timestamp';

// In-memory cache that can be populated via window function
// This is populated by taskpane when full_year_refresh completes
let fullYearCache = null;
let fullYearCacheTimestamp = null;

// Preload coordination - prevents formulas from making redundant queries while Prep Data is running
// Uses localStorage for cross-context communication (works between taskpane iframe and custom functions)
const PRELOAD_STATUS_KEY = 'netsuite_preload_status';
const PRELOAD_TIMESTAMP_KEY = 'netsuite_preload_timestamp';

function isPreloadInProgress() {
    try {
        const status = localStorage.getItem(PRELOAD_STATUS_KEY);
        const timestamp = localStorage.getItem(PRELOAD_TIMESTAMP_KEY);
        
        // Only 'running' means preload is in progress
        // 'complete', 'error', or anything else means done
        if (status === 'running' && timestamp) {
            // Check if preload started within last 3 minutes (avoid stale flags)
            const elapsed = Date.now() - parseInt(timestamp);
            if (elapsed < 180000) { // 3 minutes max wait
                return true;
            }
            // Stale preload flag - clear it
            console.log('⚠️ Stale preload flag detected - clearing');
            localStorage.removeItem(PRELOAD_STATUS_KEY);
        }
        return false;
    } catch (e) {
        return false;
    }
}

// Check if localStorage has cache data (taskpane may have saved it)
function hasLocalStorageCache() {
    try {
        const stored = localStorage.getItem(TYPEBALANCE_STORAGE_KEY);
        if (!stored) return false;
        const data = JSON.parse(stored);
        return data && data.balances && Object.keys(data.balances).length > 0;
    } catch (e) {
        return false;
    }
}

// Wait for cache to be populated (with timeout)
async function waitForCachePopulation(maxWaitMs = 10000) {
    const startTime = Date.now();
    const pollInterval = 300;
    let checkCount = 0;
    
    while (Date.now() - startTime < maxWaitMs) {
        checkCount++;
        // Check if preload status changed to 'running' (taskpane started)
        if (isPreloadInProgress()) {
            console.log(`✅ Preload detected on check #${checkCount} - will wait for completion`);
            return 'preload_started';
        }
        // Check if cache has been populated
        if (hasLocalStorageCache()) {
            console.log(`✅ Cache populated on check #${checkCount} - can use cache`);
            return 'cache_ready';
        }
        await new Promise(r => setTimeout(r, pollInterval));
    }
    console.log(`⏰ Cache wait timeout (${maxWaitMs}ms) - proceeding without cache`);
    return 'timeout';
}

// Wait for preload to complete (polls localStorage)
async function waitForPreload(maxWaitMs = 120000) {
    const startTime = Date.now();
    const pollInterval = 500; // Check every 500ms
    
    while (isPreloadInProgress()) {
        if (Date.now() - startTime > maxWaitMs) {
            console.log('⏰ Preload wait timeout - proceeding with formula');
            return false; // Timeout - proceed anyway
        }
        await new Promise(r => setTimeout(r, pollInterval));
    }
    return true; // Preload completed
}

// These are called by taskpane via localStorage (cross-context compatible)
window.startPreload = function() {
    console.log('========================================');
    console.log('🔄 PRELOAD STARTED - formulas will wait for cache');
    console.log('========================================');
    try {
        localStorage.setItem(PRELOAD_STATUS_KEY, 'running');
        localStorage.setItem(PRELOAD_TIMESTAMP_KEY, Date.now().toString());
    } catch (e) {
        console.warn('Could not set preload status:', e);
    }
    return true;
};

window.finishPreload = function() {
    console.log('========================================');
    console.log('✅ PRELOAD FINISHED - formulas can proceed');
    console.log('========================================');
    try {
        localStorage.setItem(PRELOAD_STATUS_KEY, 'complete');
    } catch (e) {
        console.warn('Could not set preload status:', e);
    }
    return true;
};

// Function to populate the cache from taskpane (via Shared Runtime if available)
window.setFullYearCache = function(balances) {
    console.log('========================================');
    console.log('📦 SETTING FULL YEAR CACHE IN FUNCTIONS.JS');
    console.log(`   Accounts: ${Object.keys(balances).length}`);
    console.log('========================================');
    fullYearCache = balances;
    fullYearCacheTimestamp = Date.now();
    return true;
};

// Function to populate the account TYPE cache from taskpane
// This ensures XAVI.TYPE formulas resolve instantly from cache
window.setAccountTypeCache = function(accountTypes) {
    console.log('========================================');
    console.log('📦 SETTING ACCOUNT TYPE CACHE IN FUNCTIONS.JS');
    console.log(`   Account types: ${Object.keys(accountTypes).length}`);
    console.log('========================================');
    
    // Clear existing type cache to prevent stale data
    cache.type.clear();
    
    // Populate type cache with fresh data
    for (const acctNum in accountTypes) {
        const cacheKey = getCacheKey('type', { account: acctNum });
        cache.type.set(cacheKey, accountTypes[acctNum]);
    }
    
    console.log(`   Type cache now has ${cache.type.size} entries`);
    return true;
};

// Function to populate the account NAME (title) cache from taskpane
// This prevents 35+ parallel requests and NetSuite 429 errors!
window.setAccountNameCache = function(accountNames) {
    console.log('========================================');
    console.log('📦 SETTING ACCOUNT NAME CACHE IN FUNCTIONS.JS');
    console.log(`   Account names: ${Object.keys(accountNames).length}`);
    console.log('========================================');
    
    // Clear existing title cache to prevent stale data
    cache.title.clear();
    
    // Populate title cache with fresh data
    for (const acctNum in accountNames) {
        const cacheKey = getCacheKey('title', { account: acctNum });
        cache.title.set(cacheKey, accountNames[acctNum]);
    }
    
    console.log(`   Title cache now has ${cache.title.size} entries`);
    return true;
};

// Function to populate the TYPEBALANCE cache from taskpane batch refresh
// This dramatically reduces NetSuite API calls for reports with TYPEBALANCE formulas
// Format: { "Income": { "Jan 2025": 8289880.01, ... }, "COGS": {...}, ... }
window.setTypeBalanceCache = function(balances, year, subsidiary = '', department = '', location = '', classId = '', accountingBook = '', useSpecial = false) {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║  📦 setTypeBalanceCache CALLED in functions.js               ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log(`   Account types received: ${Object.keys(balances).length}`);
    console.log(`   Year: ${year}`);
    console.log(`   Subsidiary: "${subsidiary}"`);
    console.log(`   Other filters: dept="${department}", loc="${location}", class="${classId}", book="${accountingBook}"`);
    console.log(`   useSpecial: ${useSpecial}`);
    
    // Initialize typebalance cache if needed
    if (!cache.typebalance) cache.typebalance = {};
    
    const specialFlag = useSpecial ? '1' : '0';
    let cachedCount = 0;
    
    // Populate cache with format matching TYPEBALANCE function cache keys:
    // typebalance:${normalizedType}:${convertedFromPeriod}:${convertedToPeriod}:${subsidiaryStr}:${departmentStr}:${locationStr}:${classStr}:${bookStr}:${specialFlag}
    for (const accountType in balances) {
        const monthData = balances[accountType];
        
        for (const period in monthData) {
            const value = monthData[period];
            
            // For P&L types, fromPeriod and toPeriod can be the same (single month)
            // or we can cache the cumulative as Jan -> period
            // Cache SINGLE MONTH entries (fromPeriod = toPeriod = period)
            const cacheKey = `typebalance:${accountType}:${period}:${period}:${subsidiary}:${department}:${location}:${classId}:${accountingBook}:${specialFlag}`;
            cache.typebalance[cacheKey] = value;
            cachedCount++;
            
            // Also cache cumulative YTD values (Jan -> each month)
            // This helps when TYPEBALANCE is called with a date range like Jan 2025 -> Mar 2025
            const janPeriod = `Jan ${year}`;
            if (period !== janPeriod) {
                // Calculate cumulative from Jan to this period
                let ytdValue = 0;
                const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                const periodMonth = period.split(' ')[0];
                const periodMonthIndex = months.indexOf(periodMonth);
                
                for (let i = 0; i <= periodMonthIndex; i++) {
                    const mp = `${months[i]} ${year}`;
                    ytdValue += (monthData[mp] || 0);
                }
                
                const ytdCacheKey = `typebalance:${accountType}:${janPeriod}:${period}:${subsidiary}:${department}:${location}:${classId}:${accountingBook}:${specialFlag}`;
                cache.typebalance[ytdCacheKey] = ytdValue;
                cachedCount++;
            }
        }
    }
    
    console.log(`   ✅ TypeBalance in-memory cache now has ${cachedCount} entries`);
    
    // CRITICAL: Also save to localStorage for cross-context communication
    // This ensures the cache is available even if functions.html loads AFTER taskpane populates
    try {
        const storageData = {
            balances: cache.typebalance,
            year: year,
            subsidiary: subsidiary,
            timestamp: Date.now()
        };
        localStorage.setItem(TYPEBALANCE_STORAGE_KEY, JSON.stringify(storageData));
        localStorage.setItem(TYPEBALANCE_STORAGE_TIMESTAMP_KEY, Date.now().toString());
        console.log(`   💾 Also saved to localStorage (${cachedCount} entries)`);
    } catch (e) {
        console.warn('   ⚠️ localStorage save failed:', e.message);
    }
    
    // Log a sample key to help debug cache misses
    const sampleKeys = Object.keys(cache.typebalance).slice(0, 3);
    console.log(`   Sample cache keys:`);
    sampleKeys.forEach(k => console.log(`      "${k}"`));
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║  ✅ setTypeBalanceCache COMPLETED                            ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');
    return true;
};

// Check localStorage for cached data
// Structure: { "4220": { "Apr 2024": 123.45, ... }, ... }
// ✅ Updated to accept filtersHash parameter for manifest-aware caching
function checkLocalStorageCache(account, period, toPeriod = null, subsidiary = '', filtersHash = null) {
    try {
        // Skip localStorage when subsidiary filter is specified (not subsidiary-aware)
        if (subsidiary && subsidiary !== '') return null;
        
        // CRITICAL: Normalize lookupPeriod to ensure cache key matching works
        // This ensures periods are in consistent "Mon YYYY" format before building cache keys
        let lookupPeriod = (period && period !== '') ? period : toPeriod;
        if (!lookupPeriod) return null;
        
        // Normalize period to ensure cache keys match (handles Range objects, date serials, etc.)
        // ✅ Use normalizePeriodKey (synchronous, no await needed)
        lookupPeriod = normalizePeriodKey(lookupPeriod, false);
        if (!lookupPeriod) return null; // If normalization fails, can't look up cache
        
        // ================================================================
        // CHECK PRELOAD CACHE FIRST (xavi_balance_cache)
        // Preload stores data with keys like: balance:${account}::${period}
        // ================================================================
        try {
            const preloadCache = localStorage.getItem('xavi_balance_cache');
            if (preloadCache) {
                const preloadData = JSON.parse(preloadCache);
                // Preload format: { "balance:10010::Jan 2025": { value: 2064705.84, timestamp: ... }, ... }
                const preloadKey = `balance:${account}::${lookupPeriod}`;
                if (preloadData[preloadKey] && preloadData[preloadKey].value !== undefined) {
                    const cachedValue = preloadData[preloadKey].value;
                    // CRITICAL: Zero balances (0) are valid cached values and must be returned
                    // This prevents redundant API calls for accounts with no transactions
                    // Reduced logging - only log first few hits to reduce noise
                    if (cacheStats.hits < 3) {
                        console.log(`✅ Preload cache hit: ${account}/${lookupPeriod} = ${cachedValue}`);
                    }
                    return cachedValue;
                }
                // Reduced logging - only log if debugging is needed
            }
        } catch (preloadErr) {
            console.warn(`⚠️ Preload cache lookup error:`, preloadErr);
            // Ignore preload cache errors, fall through to legacy cache
        }
        
        // ================================================================
        // CHECK LEGACY CACHE (netsuite_balance_cache)
        // Legacy format: { "10010": { "Jan 2025": 2064705.84, ... }, ... }
        // ================================================================
        const timestamp = localStorage.getItem(STORAGE_TIMESTAMP_KEY);
        if (!timestamp) {
            // Only log if this is likely an Income Statement lookup (P&L account)
            return null;
        }
        
        const cacheAge = Date.now() - parseInt(timestamp);
        if (cacheAge > STORAGE_TTL) {
            return null;
        }
        
        const cached = localStorage.getItem(STORAGE_KEY);
        if (!cached) {
            return null;
        }
        
        const balances = JSON.parse(cached);
        
        // CRITICAL: Account might be string or number - try both formats
        const accountStr = String(account);
        const accountKey = balances[accountStr] !== undefined ? accountStr : 
                          (balances[account] !== undefined ? account : null);
        
        if (lookupPeriod && accountKey && balances[accountKey]) {
            const accountData = balances[accountKey];
            if (accountData[lookupPeriod] !== undefined) {
                const value = accountData[lookupPeriod];
                return value;
            } else {
                // Period not found - log available periods for first few misses (debugging)
                const availablePeriods = Object.keys(accountData).slice(0, 3);
                if (cacheStats.misses < 5) {
                    console.log(`⚠️ Cache: Account ${account} found, but period "${lookupPeriod}" not found. Available: ${availablePeriods.join(', ')}`);
                }
            }
        } else {
            // Account not found - log for first few misses (debugging)
            if (cacheStats.misses < 5) {
                const sampleAccounts = Object.keys(balances).slice(0, 3);
                console.log(`⚠️ Cache: Account ${account} not found. Sample accounts: ${sampleAccounts.join(', ')}`);
            }
        }
        
        return null;
    } catch (e) {
        return null;
    }
}

// Check in-memory full year cache (backup for Shared Runtime)
function checkFullYearCache(account, period, subsidiary = '') {
    // Skip when subsidiary filter is specified (not subsidiary-aware)
    if (subsidiary && subsidiary !== '') return null;
    if (!fullYearCache || !fullYearCacheTimestamp) return null;
    
    // Cache expires after 5 minutes
    if (Date.now() - fullYearCacheTimestamp > 300000) {
        fullYearCache = null;
        fullYearCacheTimestamp = null;
        return null;
    }
    
    if (fullYearCache[account] && fullYearCache[account][period] !== undefined) {
        return fullYearCache[account][period];
    }
    return null;
}

// ============================================================================
// WILDCARD RESOLUTION FROM CACHE
// For patterns like "100*", find all matching accounts and sum their values
// Returns { total, matchCount } if ALL matching accounts are in cache, null otherwise
// ============================================================================
function resolveWildcardFromCache(accountPattern, fromPeriod, toPeriod, subsidiary = '') {
    // Extract prefix (everything before *)
    const prefix = accountPattern.replace('*', '').trim();
    if (!prefix) return null; // Can't resolve "*" alone
    
    // Determine which period to look up
    // For cumulative BS queries (empty fromPeriod), use toPeriod
    const lookupPeriod = (fromPeriod && fromPeriod !== '') ? fromPeriod : toPeriod;
    if (!lookupPeriod) return null;
    
    // For period ranges, we'd need to sum multiple periods - skip for now
    // (This handles the simple cumulative BS case)
    if (fromPeriod && toPeriod && fromPeriod !== toPeriod && fromPeriod !== '') {
        console.log(`   📭 Wildcard range queries not yet supported from cache`);
        return null;
    }
    
    let total = 0;
    let matchCount = 0;
    let cacheSource = null;
    
    // Try localStorage first (has account structure we can iterate)
    try {
        // Skip localStorage when subsidiary filter is specified (not subsidiary-aware)
        if (!subsidiary || subsidiary === '') {
            const timestamp = localStorage.getItem(STORAGE_TIMESTAMP_KEY);
            if (timestamp) {
                const age = Date.now() - parseInt(timestamp);
                if (age < 300000) { // 5 minute expiry
                    const stored = localStorage.getItem(STORAGE_KEY);
                    if (stored) {
                        const balanceData = JSON.parse(stored);
                        
                        // Find all accounts matching the prefix
                        for (const acct in balanceData) {
                            if (acct.startsWith(prefix)) {
                                const periodData = balanceData[acct];
                                if (periodData && periodData[lookupPeriod] !== undefined) {
                                    total += periodData[lookupPeriod];
                                    matchCount++;
                                }
                            }
                        }
                        
                        if (matchCount > 0) {
                            cacheSource = 'localStorage';
                        }
                    }
                }
            }
        }
    } catch (e) {
        console.warn('   ⚠️ Wildcard localStorage check failed:', e.message);
    }
    
    // If localStorage didn't have it, try fullYearCache
    if (matchCount === 0 && fullYearCache && fullYearCacheTimestamp) {
        // Skip when subsidiary filter is specified (not subsidiary-aware)
        if (!subsidiary || subsidiary === '') {
            const age = Date.now() - fullYearCacheTimestamp;
            if (age < 300000) { // 5 minute expiry
                for (const acct in fullYearCache) {
                    if (acct.startsWith(prefix)) {
                        const periodData = fullYearCache[acct];
                        if (periodData && periodData[lookupPeriod] !== undefined) {
                            total += periodData[lookupPeriod];
                            matchCount++;
                        }
                    }
                }
                
                if (matchCount > 0) {
                    cacheSource = 'fullYearCache';
                }
            }
        }
    }
    
    // If we found matches, return the result
    if (matchCount > 0) {
        console.log(`   ✅ Wildcard "${accountPattern}" → ${matchCount} accounts from ${cacheSource}`);
        return { total, matchCount };
    }
    
    return null;
}

// ============================================================================
// CACHE INDIVIDUAL ACCOUNTS FROM WILDCARD BREAKDOWN
// When a wildcard query returns individual account balances, cache them
// so future wildcards can resolve from cache
// ============================================================================
function cacheIndividualAccounts(accounts, period, subsidiary = '') {
    if (!accounts || typeof accounts !== 'object') return;
    
    const accountCount = Object.keys(accounts).length;
    if (accountCount === 0) return;
    
    console.log(`   💾 Caching ${accountCount} individual accounts for period ${period}`);
    
    // Add to localStorage cache (if no subsidiary filter - localStorage is not subsidiary-aware)
    if (!subsidiary || subsidiary === '') {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            const balanceData = stored ? JSON.parse(stored) : {};
            
            for (const [acct, value] of Object.entries(accounts)) {
                if (!balanceData[acct]) {
                    balanceData[acct] = {};
                }
                balanceData[acct][period] = value;
            }
            
            localStorage.setItem(STORAGE_KEY, JSON.stringify(balanceData));
            localStorage.setItem(STORAGE_TIMESTAMP_KEY, Date.now().toString());
            
            console.log(`   ✅ Saved to localStorage`);
        } catch (e) {
            console.warn(`   ⚠️ localStorage save failed:`, e.message);
        }
    }
    
    // Also add to fullYearCache for in-memory access
    if (!fullYearCache) {
        fullYearCache = {};
        fullYearCacheTimestamp = Date.now();
    }
    
    for (const [acct, value] of Object.entries(accounts)) {
        if (!fullYearCache[acct]) {
            fullYearCache[acct] = {};
        }
        fullYearCache[acct][period] = value;
    }
    
    console.log(`   ✅ Cached to fullYearCache`);
}

// Save balances to localStorage (called by taskpane via window function)
window.saveBalancesToLocalStorage = function(balances) {
    try {
        console.log('💾 Saving balances to localStorage...');
        localStorage.setItem(STORAGE_KEY, JSON.stringify(balances));
        localStorage.setItem(STORAGE_TIMESTAMP_KEY, Date.now().toString());
        console.log(`✅ Saved ${Object.keys(balances).length} accounts to localStorage`);
        return true;
    } catch (e) {
        console.error('localStorage write error:', e);
        return false;
    }
};

// Also keep the window function for Shared Runtime compatibility
window.populateFrontendCache = function(balances, filters = {}) {
    console.log('========================================');
    console.log('📦 POPULATING FRONTEND CACHE');
    console.log('========================================');
    
    const subsidiary = filters.subsidiary || '';
    const department = filters.department || '';
    const location = filters.location || '';
    const classId = filters.class || '';
    
    let cacheCount = 0;
    let resolvedCount = 0;
    
    // First, populate the in-memory cache
    // CRITICAL: Use getCacheKey to ensure format matches formula lookups!
    for (const [account, periods] of Object.entries(balances)) {
        for (const [period, amount] of Object.entries(periods)) {
            const cacheKey = getCacheKey('balance', {
                account: account,
                fromPeriod: period,
                toPeriod: period,
                subsidiary: subsidiary,
                department: department,
                location: location,
                classId: classId
            });
            cache.balance.set(cacheKey, amount);
            cacheCount++;
        }
    }
    
    // Also save to localStorage for cross-context access
    window.saveBalancesToLocalStorage(balances);
    
    console.log(`✅ Cached ${cacheCount} values in frontend`);
    
    // Resolve pending promises
    console.log(`\n🔄 Checking ${pendingRequests.balance.size} pending requests...`);
    
    for (const [cacheKey, request] of Array.from(pendingRequests.balance.entries())) {
        const { account, fromPeriod, toPeriod } = request.params;
        let value = 0;
        
        // Handle year-only periods by summing all 12 months
        if (fromPeriod && /^\d{4}$/.test(fromPeriod)) {
            const expanded = expandPeriodRangeFromTo(fromPeriod, toPeriod || fromPeriod);
            for (const period of expanded) {
                if (balances[account] && balances[account][period] !== undefined) {
                    value += balances[account][period];
                }
            }
        } else if (balances[account] && balances[account][fromPeriod] !== undefined) {
            value = balances[account][fromPeriod];
        }
        
        try {
            request.resolve(value);
            pendingRequests.balance.delete(cacheKey);
            resolvedCount++;
        } catch (err) {
            console.error(`   ❌ Failed:`, err);
        }
    }
    
    console.log(`✅ Resolved ${resolvedCount} pending requests`);
    console.log('========================================');
    
    return { cacheCount, resolvedCount };
};

// ============================================================================
// REQUEST QUEUE - Collects requests for intelligent batching (Phase 3)
// ============================================================================
const pendingRequests = {
    balance: new Map(),    // Map<cacheKey, {params, resolve, reject}>
    budget: new Map(),
    type: new Map(),       // Map<account, {resolve, reject}> - for TYPE batching
    title: new Map()       // Map<account, {resolve, reject}> - for NAME/title batching
};

let batchTimer = null;  // Timer reference for BALANCE batching
let typeBatchTimer = null;  // Timer reference for TYPE batching
let budgetBatchTimer = null;  // Timer reference for BUDGET batching
let titleBatchTimer = null;  // Timer reference for NAME/title batching
const BATCH_DELAY = 500;           // Wait 500ms to collect multiple requests (matches build mode settle)
const BUDGET_BATCH_DELAY = 300;    // Faster batch delay for BUDGET (simpler queries)
const TITLE_BATCH_DELAY = 100;     // Fast batch delay for titles (simple lookups)
const TYPE_BATCH_DELAY = 150;      // Faster batch delay for TYPE (lightweight queries)
const CHUNK_SIZE = 50;             // Max 50 accounts per batch (balances NetSuite limits)
const MAX_PERIODS_PER_BATCH = 3;   // Max 3 periods per batch (prevents backend timeout for high-volume accounts)
const CHUNK_DELAY = 300;           // Wait 300ms between chunks (prevent rate limiting)
const MAX_RETRIES = 2;             // Retry 429 errors up to 2 times
const RETRY_DELAY = 2000;          // Wait 2s before retrying 429 errors

// ============================================================================
// PERIOD MAP CACHE - Cached mapping of periodId -> "Mon YYYY" and "Mon YYYY" -> "Mon YYYY"
// ============================================================================
let periodMapCache = null;

function getPeriodMapCache() {
    if (periodMapCache === null) {
        try {
            const stored = localStorage.getItem('netsuite_period_map_cache');
            periodMapCache = stored ? JSON.parse(stored) : { byId: {}, byName: {} };
        } catch (e) {
            periodMapCache = { byId: {}, byName: {} };
        }
    }
    return periodMapCache;
}

function savePeriodMapCache() {
    if (periodMapCache) {
        try {
            localStorage.setItem('netsuite_period_map_cache', JSON.stringify(periodMapCache));
        } catch (e) {
            console.warn('Failed to save period map cache:', e);
        }
    }
}

// ============================================================================
// UTILITY: Normalize period to canonical "Mon YYYY" format (SYNCHRONOUS)
// 
// CENTRALIZED PERIOD NORMALIZATION - Single source of truth for period format
// This function handles:
// - Range objects (Excel cell references) - extracts value first
// - Date serials (Excel date numbers)
// - Date objects
// - String dates
// - Year-only format ("2025" → "Jan 2025" or "Dec 2025")
// - Already normalized strings ("Mon YYYY") - normalizes case
// - Numeric period IDs - checks cache, returns null if not cached (use resolvePeriodIdToName)
// 
// Output format: Always "Mon YYYY" (e.g., "Jan 2025", "Mar 2025")
// This ensures cache keys are consistent throughout the application.
// 
// IMPORTANT: Use this function for ALL period normalization to avoid cache key mismatches.
// This function is SYNCHRONOUS - no await needed.
// For numeric period IDs not in cache, use resolvePeriodIdToName() separately.
// ============================================================================
function normalizePeriodKey(value, isFromPeriod = true) {
    // If empty, return null
    if (!value || value === '') return null;
    
    const cache = getPeriodMapCache();
    
    // CRITICAL: Handle Range objects (Excel cell references)
    // Extract the actual value from the Range object before processing
    if (typeof value === 'object' && value !== null && !(value instanceof Date)) {
        const extracted = extractValueFromRange(value, 'period');
        if (extracted === '') return null;
        value = extracted;
    }
    
    // If numeric string (periodId/internalId), lookup in cache
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
        const periodId = value.trim();
        if (cache.byId[periodId]) {
            return cache.byId[periodId];  // Return cached "Mon YYYY"
        }
        // Not in cache - return null (will need to be resolved via resolvePeriodIdToName)
        return null;
    }
    
    // If already in "Mon YYYY" format, normalize case and return
    if (typeof value === 'string' && /^[A-Za-z]{3}\s+\d{4}$/.test(value.trim())) {
        const trimmed = value.trim();
        // Normalize month to title case (e.g., "JAN 2025" → "Jan 2025")
        const parts = trimmed.split(/\s+/);
        if (parts.length === 2) {
            const month = parts[0];
            const year = parts[1];
            // Convert month to title case: first letter uppercase, rest lowercase
            const normalizedMonth = month.charAt(0).toUpperCase() + month.slice(1).toLowerCase();
            const normalized = `${normalizedMonth} ${year}`;
            // Cache it
            if (!cache.byName[normalized]) {
                cache.byName[normalized] = normalized;
                savePeriodMapCache();
            }
            return normalized;
        }
        return trimmed;
    }
    
    // YEAR-ONLY FORMAT: "2025" or 2025 -> expand to "Jan 2025" or "Dec 2025"
    // Handle both string "2025" and number 2025 (Excel often passes numbers)
    // This avoids timezone bugs where new Date("2025") becomes Dec 31, 2024 in local time
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (/^\d{4}$/.test(trimmed)) {
            const year = parseInt(trimmed, 10);
            if (year >= 1900 && year <= 2100) {
                // For fromPeriod, use Jan; for toPeriod, use Dec
                const normalized = isFromPeriod ? `Jan ${year}` : `Dec ${year}`;
                // Cache it
                if (!cache.byName[normalized]) {
                    cache.byName[normalized] = normalized;
                    savePeriodMapCache();
                }
                return normalized;
            }
        }
        
        // CRITICAL: Handle string representations of Excel date serials
        // When extractValueFromRange extracts a date serial from a Range object,
        // it returns a string like "45658" (not a number)
        // Excel date serials are typically 5+ digits and > 40000 (dates after ~2009)
        // We need to detect these and convert them to numbers before processing
        if (/^\d+$/.test(trimmed)) {
            const numValue = parseFloat(trimmed);
            // Excel date serials are typically 5+ digits (dates after ~2009)
            // Year 2000 = 36526, Year 2025 = ~45658
            if (numValue >= 1 && numValue <= 1000000 && Number.isFinite(numValue)) {
                // This looks like an Excel date serial - convert to number and process below
                value = numValue;
            }
        }
    }
    
    // IMPORTANT: Handle numeric year (Excel passes cell value 2024 as number, not string)
    // Check if the number looks like a year (1900-2100) rather than an Excel date serial
    // Excel date serial for year 2024 would be around 45,000+
    if (typeof value === 'number' && value >= 1900 && value <= 2100 && Number.isInteger(value)) {
        const normalized = isFromPeriod ? `Jan ${value}` : `Dec ${value}`;
        // Cache it
        if (!cache.byName[normalized]) {
            cache.byName[normalized] = normalized;
            savePeriodMapCache();
        }
        return normalized;
    }
    
    let date;
    
    // Handle different input types
    if (typeof value === 'number') {
        // Excel date serial number (days since 1/1/1900)
        // Convert to JavaScript Date
        const excelEpoch = new Date(1899, 11, 30); // Excel's epoch is Dec 30, 1899
        date = new Date(excelEpoch.getTime() + value * 24 * 60 * 60 * 1000);
    } else if (value instanceof Date) {
        // Already a Date object
        date = value;
    } else if (typeof value === 'string') {
        // Handle full month names
        const monthMap = {
            'January': 'Jan', 'February': 'Feb', 'March': 'Mar', 'April': 'Apr',
            'May': 'May', 'June': 'Jun', 'July': 'Jul', 'August': 'Aug',
            'September': 'Sep', 'October': 'Oct', 'November': 'Nov', 'December': 'Dec'
        };
        const parts = value.trim().split(/\s+/);
        if (parts.length === 2) {
            const month = parts[0];
            const year = parts[1];
            const normalizedMonth = month.charAt(0).toUpperCase() + month.slice(1).toLowerCase();
            const shortMonth = monthMap[normalizedMonth] || normalizedMonth;
            if (shortMonth.length === 3 && /^\d{4}$/.test(year)) {
                const normalized = `${shortMonth} ${year}`;
                // Cache it
                if (!cache.byName[normalized]) {
                    cache.byName[normalized] = normalized;
                    savePeriodMapCache();
                }
                return normalized;
            }
        }
        
        // Try to parse as date string
        date = new Date(value);
        if (isNaN(date.getTime())) {
            // Not a valid date, return null
            return null;
        }
    } else {
        // Unknown type, return null
        return null;
    }
    
    // Convert Date to "Mon YYYY" format
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 
                       'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = monthNames[date.getMonth()];
    const year = date.getFullYear();
    const normalized = `${month} ${year}`;
    
    // Cache it
    if (!cache.byName[normalized]) {
        cache.byName[normalized] = normalized;
        savePeriodMapCache();
    }
    
    return normalized;
}

// ============================================================================
// UTILITY: Resolve numeric period ID to "Mon YYYY" format (ASYNC)
// Called separately when normalizePeriodKey returns null for numeric IDs
// ============================================================================
async function resolvePeriodIdToName(periodId) {
    if (!periodId || !/^\d+$/.test(String(periodId).trim())) return null;
    
    const periodIdStr = String(periodId).trim();
    const cache = getPeriodMapCache();
    
    // Check cache first
    if (cache.byId[periodIdStr]) {
        return cache.byId[periodIdStr];
    }
    
    try {
        const response = await fetch(`${SERVER_URL}/period/lookup?id=${encodeURIComponent(periodIdStr)}`);
        if (response.ok) {
            const data = await response.json();
            const displayName = data.displayName;  // "Jan 2025"
            
            // Cache it
            cache.byId[periodIdStr] = displayName;
            if (!cache.byName[displayName]) {
                cache.byName[displayName] = displayName;
            }
            savePeriodMapCache();
            
            return displayName;
        }
    } catch (e) {
        console.warn(`Failed to resolve periodId ${periodIdStr}:`, e);
    }
    
    return null;
}

// ============================================================================
// BACKWARD COMPATIBILITY: convertToMonthYear (deprecated, use normalizePeriodKey)
// ============================================================================
function convertToMonthYear(value, isFromPeriod = true) {
    return normalizePeriodKey(value, isFromPeriod) || '';
}

// ============================================================================
// UTILITY: Normalize account number to string
// Handles: numbers, text, cell references with various formats
// ============================================================================
function normalizeAccountNumber(account) {
    // Handle null/undefined
    if (account === null || account === undefined) return '';
    
    // If it's a number, handle potential floating point issues
    // Excel cells formatted as numbers might pass 4220.0 or 4220.9999999
    if (typeof account === 'number') {
        // Check if it's a whole number (within floating point tolerance)
        if (Number.isInteger(account) || Math.abs(account - Math.round(account)) < 0.0001) {
            return String(Math.round(account));
        }
        // It's a true decimal - convert as-is (rare for account numbers)
        return String(account);
    }
    
    // Convert to string and trim
    let str = String(account).trim();
    
    // Remove any thousand separators (commas) that might have been pasted
    // But preserve hyphens (e.g., "15000-1")
    str = str.replace(/,/g, '');
    
    // Handle scientific notation that might come from Excel (e.g., "1.5E+6")
    if (/^[\d.]+[eE][+-]?\d+$/.test(str)) {
        const num = parseFloat(str);
        if (!isNaN(num) && Number.isInteger(num)) {
            return String(Math.round(num));
        }
    }
    
    // Handle string numbers with decimal (e.g., "4220.0" → "4220")
    if (/^\d+\.0+$/.test(str)) {
        return str.replace(/\.0+$/, '');
    }
    
    return str;
}

// ============================================================================
// UTILITY: Generate cache key
// ============================================================================
function getCacheKey(type, params) {
    if (type === 'title') {
        return `title:${normalizeAccountNumber(params.account)}`;
    } else if (type === 'type') {
        // FIX: Account type cache key was missing! All accounts shared '' key!
        return `type:${normalizeAccountNumber(params.account)}`;
    } else if (type === 'balance' || type === 'budget') {
        return JSON.stringify({
            type,
            account: normalizeAccountNumber(params.account),
            fromPeriod: params.fromPeriod,
            toPeriod: params.toPeriod,
            subsidiary: params.subsidiary || '',
            department: params.department || '',
            location: params.location || '',
            class: params.classId || ''
        });
    }
    return '';
}

// ============================================================================
// NAME - Get Account Name
// ============================================================================
// NAME BATCH PROCESSING
// When multiple NAME formulas are triggered (e.g., loading a sheet with 100 accounts),
// we batch them into a single API call instead of 100 individual calls.
// ============================================================================
async function processTitleBatchQueue() {
    titleBatchTimer = null;
    
    const pending = new Map(pendingRequests.title);
    pendingRequests.title.clear();
    
    if (pending.size === 0) {
        console.log('📦 TITLE batch queue empty, nothing to process');
        return;
    }
    
    console.log(`📦 Processing TITLE batch: ${pending.size} accounts`);
    
    const accounts = [...pending.keys()];
    
    try {
        const response = await fetch(`${SERVER_URL}/account/names`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accounts })
        });
        
        if (!response.ok) {
            console.error(`TITLE batch API error: ${response.status}`);
            // Resolve all pending with #N/A
            for (const [account, { resolve }] of pending) {
                resolve('#N/A');
            }
            return;
        }
        
        const titles = await response.json();
        
        console.log(`📦 TITLE batch response: ${Object.keys(titles).length} titles returned`);
        
        // Also update localStorage cache for persistence
        let localStorageCache = {};
        try {
            const existing = localStorage.getItem('netsuite_name_cache');
            if (existing) localStorageCache = JSON.parse(existing);
        } catch (e) { /* ignore */ }
        
        // Resolve each pending request
        for (const [account, { resolve }] of pending) {
            const title = titles[account] || '#N/A';
            
            // Cache the result
            const cacheKey = getCacheKey('title', { account });
            cache.title.set(cacheKey, title);
            
            // Update localStorage cache
            if (title && title !== '#N/A' && title !== 'Not Found') {
                localStorageCache[account] = title;
            }
            
            resolve(title);
        }
        
        // Save to localStorage
        try {
            localStorage.setItem('netsuite_name_cache', JSON.stringify(localStorageCache));
        } catch (e) { /* ignore quota errors */ }
        
        console.log(`📦 TITLE batch complete: ${pending.size} resolved`);
        
    } catch (error) {
        console.error('TITLE batch fetch error:', error);
        // Resolve all pending with #N/A
        for (const [account, { resolve }] of pending) {
            resolve('#N/A');
        }
    }
}

/**
 * @customfunction NAME
 * @param {any} accountNumber The account number
 * @param {CustomFunctions.Invocation} invocation Invocation object
 * @returns {Promise<string>} Account name
 * @requiresAddress
 * @cancelable
 */
async function NAME(accountNumber, invocation) {
    // Retry logic for drag/drop scenarios where cell references may not be ready
    let account = normalizeAccountNumber(accountNumber);
    
    if (!account) {
        for (let retry = 0; retry < 3; retry++) {
            await new Promise(r => setTimeout(r, 200));
            account = normalizeAccountNumber(accountNumber);
            if (account) {
                console.log(`⏳ NAME retry ${retry + 1} succeeded for account`);
                break;
            }
        }
    }
    
    if (!account) return '#N/A';
    
    const cacheKey = getCacheKey('title', { account });
    
    // Check in-memory cache FIRST
    if (cache.title.has(cacheKey)) {
        cacheStats.hits++;
        console.log(`⚡ CACHE HIT [title]: ${account}`);
        return cache.title.get(cacheKey);
    }
    
    // Check localStorage name cache as fallback
    try {
        const nameCache = localStorage.getItem('netsuite_name_cache');
        if (nameCache) {
            const names = JSON.parse(nameCache);
            if (names[account]) {
                // Populate in-memory cache too
                cache.title.set(cacheKey, names[account]);
                cacheStats.hits++;
                console.log(`⚡ LOCALSTORAGE HIT [title]: ${account} → ${names[account]}`);
                return names[account];
            }
        }
    } catch (e) {
        console.warn('localStorage name cache read error:', e.message);
    }
    
    // Check if this account is already pending in the batch queue
    if (pendingRequests.title.has(account)) {
        console.log(`📥 TITLE already pending, waiting for batch: ${account}`);
        // Return a new promise that will be resolved when the batch completes
        return new Promise((resolve) => {
            const existing = pendingRequests.title.get(account);
            const origResolve = existing.resolve;
            existing.resolve = (value) => {
                origResolve(value);
                resolve(value);
            };
        });
    }
    
    cacheStats.misses++;
    console.log(`📥 CACHE MISS [title]: ${account} → queuing for batch`);
    
    // Add to batch queue
    return new Promise((resolve, reject) => {
        pendingRequests.title.set(account, { resolve, reject });
        
        // Start batch timer if not already running
        // CRITICAL: Clear existing timer before setting new one (prevent multiple timers)
        if (titleBatchTimer) {
            clearTimeout(titleBatchTimer);
            titleBatchTimer = null;
        }
        console.log(`⏱️ Starting TITLE batch timer (${TITLE_BATCH_DELAY}ms)`);
        titleBatchTimer = setTimeout(() => {
            processTitleBatchQueue().catch(err => {
                console.error('❌ TITLE batch processing error:', err);
            });
        }, TITLE_BATCH_DELAY);
    });
}

// ============================================================================
// TYPE - Get Account Type
// ============================================================================
// TYPE BATCH PROCESSING
// When multiple TYPE formulas are triggered (e.g., drag to fill 80 rows),
// we batch them into a single API call instead of 80 individual calls.
// ============================================================================
async function processTypeBatchQueue() {
    typeBatchTimer = null;
    
    const pending = new Map(pendingRequests.type);
    pendingRequests.type.clear();
    
    if (pending.size === 0) {
        console.log('📦 TYPE batch queue empty, nothing to process');
        return;
    }
    
    console.log(`📦 Processing TYPE batch: ${pending.size} accounts`);
    
    const accounts = [...pending.keys()];
    
    try {
        const response = await fetch(`${SERVER_URL}/batch/account_types`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accounts })
        });
        
        if (!response.ok) {
            console.error(`TYPE batch API error: ${response.status}`);
            // Reject all pending
            for (const [account, { reject }] of pending) {
                reject(new Error(`API error ${response.status}`));
            }
            return;
        }
        
        const data = await response.json();
        // Backend returns 'account_types' not 'types'
        const types = data.account_types || data.types || {};
        
        console.log(`📦 TYPE batch response: ${Object.keys(types).length} types returned`);
        
        // Resolve each pending request
        for (const [account, { resolve }] of pending) {
            const type = types[account];
            if (type) {
                // Cache the result
                const cacheKey = getCacheKey('type', { account });
                if (!cache.type) cache.type = new Map();
                cache.type.set(cacheKey, type);
                resolve(type);
            } else {
                console.log(`   ✗ ${account} → #N/A (not found)`);
                resolve('#N/A');
            }
        }
        
    } catch (error) {
        console.error('TYPE batch fetch error:', error);
        // Reject all pending
        for (const [account, { reject }] of pending) {
            reject(error);
        }
    }
}

/**
 * @customfunction TYPE
 * @param {any} accountNumber The account number
 * @param {CustomFunctions.Invocation} invocation Invocation object
 * @returns {Promise<string>} Account type (e.g., "Income", "Expense")
 * @requiresAddress
 * @cancelable
 */
async function TYPE(accountNumber, invocation) {
    // Retry logic for drag/drop scenarios where cell references may not be ready
    let account = normalizeAccountNumber(accountNumber);
    
    // If account is empty, wait briefly and retry (drag/drop timing issue)
    if (!account) {
        for (let retry = 0; retry < 3; retry++) {
            await new Promise(r => setTimeout(r, 200)); // Wait 200ms
            account = normalizeAccountNumber(accountNumber);
            if (account) {
                console.log(`⏳ TYPE retry ${retry + 1} succeeded for account`);
                break;
            }
        }
    }
    
    if (!account) return '#N/A';
    
    const cacheKey = getCacheKey('type', { account });
    
    // Check in-memory cache FIRST
    if (!cache.type) cache.type = new Map();
    if (cache.type.has(cacheKey)) {
        cacheStats.hits++;
        console.log(`⚡ CACHE HIT [type]: ${account}`);
        return cache.type.get(cacheKey);
    }
    
    // Check localStorage type cache as fallback
    try {
        const typeCache = localStorage.getItem('netsuite_type_cache');
        if (typeCache) {
            const types = JSON.parse(typeCache);
            if (types[account]) {
                // Populate in-memory cache too
                cache.type.set(cacheKey, types[account]);
                cacheStats.hits++;
                console.log(`⚡ LOCALSTORAGE HIT [type]: ${account} → ${types[account]}`);
                return types[account];
            }
        }
    } catch (e) {
        console.warn('localStorage type cache read error:', e.message);
    }
    
    // Check if this account is already pending in the batch queue
    if (pendingRequests.type.has(account)) {
        console.log(`📥 TYPE already pending, waiting for batch: ${account}`);
        // Wait for the existing request to complete
        return new Promise((resolve, reject) => {
            const existing = pendingRequests.type.get(account);
            // Chain onto existing promise
            existing.resolve = ((origResolve) => (value) => {
                origResolve(value);
                resolve(value);
            })(existing.resolve);
        });
    }
    
    cacheStats.misses++;
    console.log(`📥 CACHE MISS [type]: ${account} - adding to batch queue`);
    
    // Add to batch queue
    return new Promise((resolve, reject) => {
        pendingRequests.type.set(account, { resolve, reject });
        
        // Start batch timer if not already running
        // CRITICAL: Clear existing timer before setting new one (prevent multiple timers)
        if (typeBatchTimer) {
            clearTimeout(typeBatchTimer);
            typeBatchTimer = null;
        }
        console.log(`⏱️ Starting TYPE batch timer (${TYPE_BATCH_DELAY}ms)`);
        typeBatchTimer = setTimeout(() => {
            processTypeBatchQueue().catch(err => {
                console.error('❌ TYPE batch processing error:', err);
            });
        }, TYPE_BATCH_DELAY);
    });
}

// ============================================================================
// PARENT - Get Parent Account
// ============================================================================
/**
 * @customfunction PARENT
 * @param {any} accountNumber The account number
 * @param {CustomFunctions.Invocation} invocation Invocation object
 * @returns {Promise<string>} Parent account number
 * @requiresAddress
 * @cancelable
 */
async function PARENT(accountNumber, invocation) {
    // Retry logic for drag/drop scenarios where cell references may not be ready
    let account = normalizeAccountNumber(accountNumber);
    
    if (!account) {
        for (let retry = 0; retry < 3; retry++) {
            await new Promise(r => setTimeout(r, 200));
            account = normalizeAccountNumber(accountNumber);
            if (account) {
                console.log(`⏳ PARENT retry ${retry + 1} succeeded for account`);
                break;
            }
        }
    }
    
    if (!account) return '#N/A';
    
    // DEBUG: Log the account number being used
    console.log(`🔍 PARENT: Looking up parent for account "${account}" (normalized from "${accountNumber}")`);
    
    const cacheKey = getCacheKey('parent', { account });
    
    // Check cache FIRST
    if (!cache.parent) cache.parent = new Map();
    if (cache.parent.has(cacheKey)) {
        cacheStats.hits++;
        const cachedParent = cache.parent.get(cacheKey);
        console.log(`⚡ CACHE HIT [parent]: ${account} → "${cachedParent || '(no parent)'}"`);
        return cachedParent;
    }
    
    cacheStats.misses++;
    console.log(`📥 CACHE MISS [parent]: ${account}`);
    
    // Single request - make immediately
    try {
        const controller = new AbortController();
        const signal = controller.signal;
        
        // Listen for cancellation
        if (invocation) {
            invocation.onCanceled = () => {
                console.log(`Parent request canceled for ${account}`);
                controller.abort();
            };
        }
        
        // Use POST to avoid exposing account numbers in URLs/logs
        console.log(`📤 PARENT API: Requesting parent for account "${account}"`);
        const response = await fetch(`${SERVER_URL}/account/parent`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ account: String(account) }),
            signal
        });
        if (!response.ok) {
            console.error(`❌ Parent API error: ${response.status} for account "${account}"`);
            return '#N/A';
        }
        
        const parent = await response.text();
        // Handle empty response (account has no parent) - return empty string, not #N/A
        // Empty string is valid - it means the account is a top-level account
        const parentValue = parent.trim();
        console.log(`✅ PARENT API: Account "${account}" → Parent "${parentValue || '(no parent)'}"`);
        cache.parent.set(cacheKey, parentValue);
        console.log(`💾 Cached parent: ${account} → "${parentValue || '(no parent)'}"`);
        return parentValue;
        
    } catch (error) {
        if (error.name === 'AbortError') {
            console.log('Parent request was canceled');
            return '#N/A';
        }
        console.error('Parent fetch error:', error);
        return '#N/A';
    }
}

// ============================================================================
// BALANCE - Get GL Account Balance (NON-STREAMING WITH BATCHING)
// ============================================================================

/**
 * Helper function to retry cache lookup with bounded delays
 * Returns a Promise that resolves to a number (never throws for transient states)
 * This preserves Excel's auto-retry behavior while maintaining type contract
 * 
 * CRITICAL: If cache not found after retries, returns null to signal caller
 * to proceed to API path. Caller MUST handle null and proceed to API.
 */
async function retryCacheLookup(
    account, fromPeriod, toPeriod, subsidiary, filtersHash, cacheKey, periodKey,
    checkLocalStorageCacheFn, maxRetries = 10, retryDelay = 500
) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        // Wait before checking (first attempt is immediate, subsequent have delay)
        if (attempt > 0) {
            await new Promise(r => setTimeout(r, retryDelay));
        }
        
        // Check localStorage cache
        const localStorageValue = checkLocalStorageCacheFn(account, fromPeriod, toPeriod, subsidiary, filtersHash);
        if (localStorageValue !== null) {
            console.log(`✅ Cache found on retry attempt ${attempt + 1}: ${account} for ${periodKey} = ${localStorageValue}`);
            cache.balance.set(cacheKey, localStorageValue);
            return localStorageValue; // ✅ Returns number
        }
        
        // Check in-memory cache
        if (cache.balance.has(cacheKey)) {
            console.log(`✅ Cache found in memory on retry attempt ${attempt + 1}: ${account} for ${periodKey}`);
            return cache.balance.get(cacheKey); // ✅ Returns number
        }
    }
    
    // After max retries exhausted, return null to signal cache not ready
    // CRITICAL: Caller MUST check for null and proceed to API path
    // This ensures Promise<number> always resolves to a number eventually
    console.log(`⏳ Cache not found after ${maxRetries} retries - caller will proceed to API path for ${periodKey}`);
    return null; // Signals caller to proceed to API path
}

/**
 * @customfunction BALANCE
 * @param {any} account Account number
 * @param {any} fromPeriod Starting period (e.g., "Jan 2025" or 1/1/2025)
 * @param {any} toPeriod Ending period (e.g., "Mar 2025" or 3/1/2025)
 * @param {any} subsidiary Subsidiary filter (use "" for all)
 * @param {any} department Department filter (use "" for all)
 * @param {any} location Location filter (use "" for all)
 * @param {any} classId Class filter (use "" for all)
 * @param {any} accountingBook Accounting Book ID (use "" for Primary Book)
 * @returns {Promise<number>} Account balance
 * @requiresAddress
 */
async function BALANCE(account, fromPeriod, toPeriod, subsidiary, department, location, classId, accountingBook) {
    
    // Cross-context cache invalidation - taskpane signals via localStorage
    // FIX #1 & #5: Synchronize cache clear - clear in-memory cache FIRST, then check signal
    // This ensures cache is cleared before formulas evaluate
    try {
        // CRITICAL: Clear in-memory cache FIRST (before checking signal)
        // This ensures cache is cleared synchronously, not async
        const clearSignal = localStorage.getItem('netsuite_cache_clear_signal');
        if (clearSignal) {
            const { timestamp, reason } = JSON.parse(clearSignal);
            // Extended window to 30 seconds (was 10) to handle timing issues
            if (Date.now() - timestamp < 30000) {
                console.log(`🔄 Cache cleared (${reason}) - clearing in-memory cache synchronously`);
                // Clear in-memory cache FIRST
                cache.balance.clear();
                cache.budget.clear();
                cache.title.clear();
                cache.type.clear();
                cache.parent.clear();
                if (typeof fullYearCache === 'object' && fullYearCache) {
                    Object.keys(fullYearCache).forEach(k => delete fullYearCache[k]);
                }
                fullYearCacheTimestamp = null;
                // Also clear localStorage caches to ensure complete clear
                try {
                    localStorage.removeItem('xavi_balance_cache');
                    localStorage.removeItem('netsuite_balance_cache');
                    localStorage.removeItem('netsuite_balance_cache_timestamp');
                    console.log(`   ✅ Cleared localStorage caches from functions.js context`);
                } catch (e) {
                    console.warn('   ⚠️ Failed to clear localStorage from functions.js:', e);
                }
                // Remove signal after processing
                localStorage.removeItem('netsuite_cache_clear_signal');
                console.log(`✅ Cache clear complete - all caches cleared synchronously`);
            } else {
                // Stale signal - remove it
                localStorage.removeItem('netsuite_cache_clear_signal');
            }
        }
    } catch (e) { 
        console.warn('⚠️ Cache clear signal processing error:', e);
    }
    
    try {
        // ================================================================
        // SPECIAL COMMAND: __CLEARCACHE__ - Clear caches from taskpane
        // Usage: =XAVI.BALANCE("__CLEARCACHE__", "60032:May 2025,60032:Jun 2025", "")
        // The second parameter contains comma-separated account:period pairs to clear
        // Returns: Number of items cleared
        // ================================================================
        const rawAccount = String(account || '').trim();
        
        if (rawAccount === '__CLEARCACHE__') {
            const itemsStr = String(fromPeriod || '').trim();
            console.log('🔧 __CLEARCACHE__ command received:', itemsStr || 'ALL');
            
            let cleared = 0;
            
            // ================================================================
            // SPECIAL MODE: Clear special formula caches (NETINCOME, RE, CTA)
            // Usage: =XAVI.BALANCE("__CLEARCACHE__", "SPECIAL:NETINCOME:Dec 2024", "")
            //        =XAVI.BALANCE("__CLEARCACHE__", "SPECIAL:RETAINEDEARNINGS:Jan 2025", "")
            //        =XAVI.BALANCE("__CLEARCACHE__", "SPECIAL:CTA:Feb 2025", "")
            //        =XAVI.BALANCE("__CLEARCACHE__", "SPECIAL:ALL:Dec 2024", "") - clears all 3 for that period
            // ================================================================
            if (itemsStr.startsWith('SPECIAL:')) {
                const parts = itemsStr.split(':');
                const formulaType = parts[1]; // NETINCOME, RETAINEDEARNINGS, CTA, or ALL
                const period = parts.slice(2).join(':'); // Period might contain colons
                
                console.log(`🎯 SPECIAL CACHE CLEAR: type=${formulaType}, period=${period}`);
                
                // Clear from cache.balance by prefix matching
                const typesToClear = formulaType === 'ALL' 
                    ? ['netincome', 're', 'cta'] 
                    : [formulaType === 'RETAINEDEARNINGS' ? 're' : formulaType.toLowerCase()];
                
                for (const type of typesToClear) {
                    const prefix = `${type}:${period}`;
                    
                    // Clear from in-memory cache
                    for (const [key, _] of cache.balance) {
                        if (key.startsWith(prefix)) {
                            cache.balance.delete(key);
                            cleared++;
                            console.log(`   ✓ Cleared cache: ${key}`);
                        }
                    }
                    
                    // CRITICAL: Also clear from inFlightRequests map
                    for (const [key, _] of inFlightRequests) {
                        if (key.startsWith(prefix)) {
                            inFlightRequests.delete(key);
                            console.log(`   ✓ Cleared in-flight: ${key}`);
                            cleared++;
                        }
                    }
                }
                
                console.log(`🗑️ SPECIAL CACHE CLEAR complete: ${cleared} entries cleared for ${formulaType} ${period}`);
                return cleared;
            }
            
            if (!itemsStr || itemsStr === 'ALL') {
                // Clear EVERYTHING - all caches including localStorage
                cleared = cache.balance.size;
                cache.balance.clear();
                cache.title.clear();
                cache.budget.clear();
                cache.type.clear();
                cache.parent.clear();
                
                if (fullYearCache) {
                    for (const k in fullYearCache) {
                        delete fullYearCache[k];
                    }
                }
                
                // CRITICAL: Also clear localStorage from this context!
                try {
                    localStorage.removeItem('netsuite_balance_cache');
                    localStorage.removeItem('netsuite_balance_cache_timestamp');
                    console.log('   ✓ Cleared localStorage (functions context)');
                } catch (e) {
                    console.warn('   ⚠️ localStorage clear failed:', e.message);
                }
                
                console.log(`🗑️ Cleared ALL caches (${cleared} balance entries)`);
            } else {
                // Clear SPECIFIC items - parse format:
                // Old: "60032:May 2025,60032:Jun 2025"
                // New: "balance:60032:May 2025,budget:60032:Jun 2025"
                // With subsidiary: "balance:111*:Dec 2025:Celigo Inc. (Consolidated)"
                const items = itemsStr.split(',').map(s => {
                    const parts = s.trim().split(':');
                    if (parts.length >= 3 && (parts[0] === 'balance' || parts[0] === 'budget')) {
                        // New format with type prefix
                        // Could be: type:account:period or type:account:period:subsidiary
                        const type = parts[0];
                        const account = parts[1];
                        // Remaining parts could be "Dec 2025" or "Dec 2025:Celigo Inc. (Consolidated)"
                        // Period format is always "Mon YYYY", so extract that
                        const periodMatch = parts.slice(2).join(':').match(/^([A-Za-z]{3}\s+\d{4})/);
                        const period = periodMatch ? periodMatch[1] : parts[2];
                        // Subsidiary is everything after the period
                        const afterPeriod = parts.slice(2).join(':').substring(period.length + 1);
                        const subsidiary = afterPeriod || '';
                        return { type, account, period, subsidiary };
                    } else {
                        // Old format without type prefix - assume balance
                        return { type: 'balance', account: parts[0], period: parts.slice(1).join(':'), subsidiary: '' };
                    }
                });
                
                const balanceItems = items.filter(i => i.type === 'balance');
                const budgetItems = items.filter(i => i.type === 'budget');
                console.log(`   Clearing ${items.length} specific items (balance: ${balanceItems.length}, budget: ${budgetItems.length})...`);
                
                // Clear BALANCE items from localStorage
                if (balanceItems.length > 0) {
                    try {
                        const stored = localStorage.getItem('netsuite_balance_cache');
                        if (stored) {
                            const balanceData = JSON.parse(stored);
                            let modified = false;
                            
                            for (const item of balanceItems) {
                                if (balanceData[item.account] && balanceData[item.account][item.period] !== undefined) {
                                    delete balanceData[item.account][item.period];
                                    cleared++;
                                    modified = true;
                                    console.log(`   ✓ Cleared balance localStorage: ${item.account}/${item.period}`);
                                }
                            }
                            
                            if (modified) {
                                localStorage.setItem('netsuite_balance_cache', JSON.stringify(balanceData));
                            }
                        }
                    } catch (e) {
                        console.warn('   ⚠️ balance localStorage parse error:', e.message);
                    }
                }
                
                // Clear BUDGET items from localStorage
                if (budgetItems.length > 0) {
                    try {
                        const stored = localStorage.getItem('netsuite_budget_cache');
                        if (stored) {
                            const budgetData = JSON.parse(stored);
                            let modified = false;
                            
                            for (const item of budgetItems) {
                                if (budgetData[item.account] && budgetData[item.account][item.period] !== undefined) {
                                    delete budgetData[item.account][item.period];
                                    cleared++;
                                    modified = true;
                                    console.log(`   ✓ Cleared budget localStorage: ${item.account}/${item.period}`);
                                }
                            }
                            
                            if (modified) {
                                localStorage.setItem('netsuite_budget_cache', JSON.stringify(budgetData));
                            }
                        }
                    } catch (e) {
                        console.warn('   ⚠️ budget localStorage parse error:', e.message);
                    }
                }
                
                // Clear from in-memory caches
                // IMPORTANT: Clear ALL cache entries matching account+period, regardless of other params
                // This handles the case where subsidiary/dept/class might vary
                for (const item of items) {
                    const cacheToUse = item.type === 'budget' ? cache.budget : cache.balance;
                    const normalizedAccount = normalizeAccountNumber(item.account);
                    
                    // Clear by pattern matching - check all cache entries
                    // Cache keys are JSON strings, so we parse and check
                    for (const [key, _] of cacheToUse) {
                        try {
                            const parsed = JSON.parse(key);
                            // Match if account and period match (fromPeriod OR toPeriod)
                            if (parsed.account === normalizedAccount && 
                                (parsed.fromPeriod === item.period || parsed.toPeriod === item.period || 
                                 // Also match for BS accounts where fromPeriod is empty
                                 (parsed.fromPeriod === '' && parsed.toPeriod === item.period))) {
                                // If subsidiary was specified, also check that matches
                                if (!item.subsidiary || parsed.subsidiary === '' || 
                                    parsed.subsidiary.toLowerCase() === item.subsidiary.toLowerCase()) {
                                    cacheToUse.delete(key);
                        cleared++;
                                    console.log(`   ✓ Cleared cache.${item.type}: ${normalizedAccount}/${item.period} (sub=${parsed.subsidiary || 'any'})`);
                                }
                            }
                        } catch (e) {
                            // Key might not be JSON (e.g., title:xxx) - skip
                        }
                    }
                    
                    // Clear from fullYearCache (only for balance)
                    if (item.type === 'balance' && fullYearCache && fullYearCache[normalizedAccount]) {
                        if (fullYearCache[normalizedAccount][item.period] !== undefined) {
                            delete fullYearCache[normalizedAccount][item.period];
                            cleared++;
                            console.log(`   ✓ Cleared fullYearCache: ${normalizedAccount}/${item.period}`);
                        }
                    }
                }
                
                console.log(`🗑️ Cleared ${cleared} items from caches`);
            }
            
            return cleared;
        }
        
        // Normalize business parameters
        account = normalizeAccountNumber(account);
        
        if (!account) {
            console.error('❌ BALANCE: account parameter is required');
            throw new Error('MISSING_ACCT');
        }
        
        // ================================================================
        // CRITICAL: Normalize periods EARLY (before any cache operations)
        // This ensures Range objects are converted to strings before being used in cache keys
        // ================================================================
        // Convert date values to "Mon YYYY" format (supports both dates and period strings)
        // For year-only format ("2025"), expand to "Jan 2025" and "Dec 2025"
        // convertToMonthYear() now handles Range objects internally
        const rawFrom = fromPeriod;
        const rawTo = toPeriod;
        fromPeriod = normalizePeriodKey(fromPeriod, true) || fromPeriod;   // true = isFromPeriod
        toPeriod = normalizePeriodKey(toPeriod, false) || toPeriod;      // false = isToPeriod
        
        // ================================================================
        // VALIDATION: Detect common formula syntax errors
        // ================================================================
        // Check if toPeriod looks like a subsidiary name (common mistake)
        const rawToPeriod = String(toPeriod || '');
        if (rawToPeriod && (
            rawToPeriod.toLowerCase().includes('consolidated') ||
            rawToPeriod.toLowerCase().includes('inc') ||
            rawToPeriod.toLowerCase().includes('llc') ||
            rawToPeriod.toLowerCase().includes('corp')
        )) {
            console.error(`❌ FORMULA ERROR: "${rawToPeriod}" looks like a subsidiary name, not a period!`);
            console.error(`   XAVI.BALANCE expects: (account, fromPeriod, toPeriod, subsidiary, ...)`);
            console.error(`   Your formula likely has subsidiary in the wrong position.`);
            console.error(`   Correct: =XAVI.BALANCE("${account}", fromPeriod, toPeriod, "${rawToPeriod}")`);
            throw new Error('SYNTAX');
        }
        
        // Debug log the period conversion
        // Removed excessive logging - this fired on every formula evaluation
        
        // Validate that periods were converted successfully
        const periodPattern = /^[A-Za-z]{3}\s+\d{4}$/;
        if (fromPeriod && !periodPattern.test(fromPeriod)) {
            console.error(`❌ Invalid fromPeriod after conversion: "${fromPeriod}" (raw: ${rawFrom})`);
        }
        if (toPeriod && !periodPattern.test(toPeriod)) {
            console.error(`❌ Invalid toPeriod after conversion: "${toPeriod}" (raw: ${rawTo})`);
        }
        
        // Other parameters as strings
        subsidiary = String(subsidiary || '').trim();
        department = String(department || '').trim();
        location = String(location || '').trim();
        classId = String(classId || '').trim();
        
        // Multi-Book Accounting support - default to empty (uses Primary Book on backend)
        accountingBook = String(accountingBook || '').trim();
        
        // DEBUG: Log subsidiary to trace (Consolidated) suffix handling
        if (subsidiary && subsidiary.toLowerCase().includes('europe')) {
            console.log(`🔍 BALANCE DEBUG: account=${account}, subsidiary="${subsidiary}", hasConsolidated=${subsidiary.includes('(Consolidated)')}`);
        }
        
        const params = { account, fromPeriod, toPeriod, subsidiary, department, location, classId, accountingBook };
        const cacheKey = getCacheKey('balance', params);
        
        // ================================================================
        // CRITICAL: ACCOUNT TYPE GATE - Hard execution split
        // Income/Expense accounts MUST be routed away BEFORE any Balance Sheet logic
        // This prevents Income Statement queries from entering BS inference/batching pipeline
        // ================================================================
        // Check account type from cache first (synchronous, fast)
        const typeCacheKey = getCacheKey('type', { account });
        let accountType = cache.type.has(typeCacheKey) ? cache.type.get(typeCacheKey) : null;
        
        // Handle both string and object responses (cache may contain either)
        if (accountType && typeof accountType === 'object' && accountType.type) {
            accountType = accountType.type;
        }
        
        // If not in cache, fetch it (async - but we need to know before proceeding)
        if (!accountType) {
            accountType = await getAccountType(account);
            // Handle both string and object responses
            if (accountType && typeof accountType === 'object' && accountType.type) {
                accountType = accountType.type;
            }
        }
        
        // ================================================================
        // INCOME STATEMENT PATH (Hard Return - No BS Logic)
        // ================================================================
        if (accountType && isIncomeStatementType(accountType)) {
            // Income/Expense account - route immediately to income statement path
            // SKIP: manifest checks, preload waits, grid detection, anchor inference, BS batching
            console.log(`📊 Income Statement account (${accountType}): ${account} - routing to income statement path`);
            
            // Check in-memory cache first
            if (cache.balance.has(cacheKey)) {
                cacheStats.hits++;
                return cache.balance.get(cacheKey);
            }
            
            // Check localStorage cache (for cumulative queries only)
            const filtersHash = getFilterKey({ subsidiary, department, location, classId, accountingBook });
            const isCumulativeQuery = isCumulativeRequest(fromPeriod);
            let localStorageValue = null;
            if (isCumulativeQuery) {
                localStorageValue = checkLocalStorageCache(account, fromPeriod, toPeriod, subsidiary, filtersHash);
            }
            if (localStorageValue !== null) {
                cacheStats.hits++;
                cache.balance.set(cacheKey, localStorageValue);
                return localStorageValue;
            }
            
            // Check full year cache (if not subsidiary-filtered)
            if (!subsidiary) {
                const fullYearValue = checkFullYearCache(account, fromPeriod || toPeriod, subsidiary);
                if (fullYearValue !== null) {
                    cacheStats.hits++;
                    cache.balance.set(cacheKey, fullYearValue);
                    return fullYearValue;
                }
            }
            
            // Cache miss - queue to regularRequests (batch endpoint)
            // This is the income statement execution path - no BS logic
            cacheStats.misses++;
            if (cacheStats.misses < 10) {
                console.log(`📥 Income Statement: ${account} (${fromPeriod || '(cumulative)'} → ${toPeriod}) → queuing to batch endpoint`);
            }
            
            // Return Promise that will be resolved by batch processor (regularRequests path)
            return new Promise((resolve, reject) => {
                pendingRequests.balance.set(cacheKey, {
                    params,
                    resolve,
                    reject,
                    timestamp: Date.now(),
                    accountType: 'income_statement' // Mark as income statement for routing
                });
                
                // Start batch timer if not already running
                if (!isFullRefreshMode) {
                    if (batchTimer) {
                        clearTimeout(batchTimer);
                        batchTimer = null;
                    }
                    if (cacheStats.misses < 10) {
                        console.log(`⏱️ STARTING batch timer (${BATCH_DELAY}ms) for Income Statement`);
                    }
                    batchTimer = setTimeout(() => {
                        console.log('⏱️ Batch timer FIRED!');
                        batchTimer = null;
                        processBatchQueue().catch(err => {
                            console.error('❌ Batch processing error:', err);
                        });
                    }, BATCH_DELAY);
                }
            });
        }
        
        // ================================================================
        // BALANCE SHEET PATH (Continue with existing BS logic)
        // ================================================================
        // If we reach here, account is Balance Sheet (or type unknown - treat as BS for safety)
        if (accountType && !isBalanceSheetType(accountType)) {
            // Unknown account type - log warning but treat as BS (conservative)
            console.warn(`⚠️ Unknown account type "${accountType}" for ${account} - treating as Balance Sheet`);
        }
        
        // ================================================================
        // PRELOAD COORDINATION: Check manifest for period status FIRST
        // FIX: Check manifest even when global preload is not in progress
        // This allows formulas to detect when precache completed and use cache immediately
        // 
        // PARAMETER-DRIVEN BEHAVIOR:
        // - Point-in-time (fromPeriod null/empty): Cumulative query (uses manifest/preload)
        // - Period activity (fromPeriod provided): Period range query (skip manifest/preload)
        // 
        // Note: isCumulativeRequest checks if fromPeriod is null/empty to determine query type
        // ================================================================
        // Normalize lookupPeriod early for period-specific checks
        const lookupPeriod = normalizePeriodKey(fromPeriod || toPeriod, false);
        const isCumulativeQuery = isCumulativeRequest(fromPeriod); // Point-in-time if fromPeriod is null/empty
        
        // CRITICAL: For period activity queries (fromPeriod provided), skip manifest/preload logic
        // Period activity queries are faster and don't need preload coordination
        // NOTE: Do NOT use checkLocalStorageCache for period activity - it only looks up cumulative balances
        // Period activity queries must use in-memory cache (with proper cache key) or go to API
        if (!isCumulativeQuery && lookupPeriod) {
            // Period activity query - only check in-memory cache (which uses proper cache key with both periods)
            // Do NOT use checkLocalStorageCache - it would return wrong value (cumulative for fromPeriod)
            if (cache.balance.has(cacheKey)) {
                const cachedValue = cache.balance.get(cacheKey);
                // Reduced logging - only log first few cache hits to reduce noise
                if (cacheStats.hits < 5) {
                    console.log(`✅ Period activity cache hit: ${account} (${fromPeriod} → ${toPeriod}) = ${cachedValue}`);
                }
                cacheStats.hits++;
                return cachedValue;
            }
            // Cache miss for period activity - log first few misses for debugging, then reduce noise
            if (cacheStats.misses < 10) {
                console.log(`📭 Period activity cache miss: ${account} (${fromPeriod} → ${toPeriod}) - using API`);
            }
            cacheStats.misses++;
        }
        
        // Manifest/preload logic ONLY for point-in-time (cumulative) queries
        // CRITICAL FIX: Check manifest for period status REGARDLESS of global preload status
        // This ensures formulas can detect "completed" status even after global preload finishes
        if (isCumulativeQuery && lookupPeriod) {
            const periodKey = normalizePeriodKey(lookupPeriod);
            if (periodKey) {
                const filtersHash = getFilterKey({ subsidiary, department, location, classId, accountingBook });
                const status = getPeriodStatus(filtersHash, periodKey);
                const manifest = getManifest(filtersHash);
                const period = manifest.periods[periodKey];
                
                // CRITICAL: Check for "completed" status FIRST (even if global preload finished)
                // This allows formulas that were in BUSY state to resolve immediately when re-evaluated
                if (status === "completed") {
                    // Period already completed - check cache immediately (no wait needed)
                    let localStorageValue = checkLocalStorageCache(account, fromPeriod, toPeriod, subsidiary, filtersHash);
                    if (localStorageValue !== null) {
                        console.log(`✅ Period ${periodKey} already completed - cache hit: ${account} = ${localStorageValue}`);
                        cacheStats.hits++;
                        cache.balance.set(cacheKey, localStorageValue);
                        return localStorageValue;
                    }
                    
                    // OPTION 4: Status change detection - check if this is first time seeing "completed"
                    // Track previous status to detect transition from "running"/"requested" to "completed"
                    const previousStatus = getStatusChange(filtersHash, periodKey);
                    const justCompleted = previousStatus && (previousStatus === "running" || previousStatus === "requested");
                    
                    // Update status tracking (immediate flush for completion)
                    setStatusChange(filtersHash, periodKey, "completed", true);
                    
                    // Cache not found but status is "completed" - retry with bounded delays
                    // Use Promise-based retry that resolves to a number (preserves Excel auto-retry)
                    console.log(`⏳ Period ${periodKey} marked completed but cache not found - retrying cache lookup...`);
                    const retryResult = await retryCacheLookup(
                        account, fromPeriod, toPeriod, subsidiary, filtersHash, cacheKey, periodKey,
                        checkLocalStorageCache
                    );
                    if (retryResult !== null) {
                        return retryResult;
                    }
                    // Cache still not found after retries - proceed to API path (don't throw)
                    console.log(`⏳ Cache not found after retries - proceeding to API path for ${periodKey}`);
                }
                
                // If period is being preloaded, wait for it (not global preload)
                if (status === "running" || status === "requested") {
                    // Track status for change detection (deferred write for intermediate state)
                    setStatusChange(filtersHash, periodKey, status, false);
                    
                    console.log(`⏳ Period ${periodKey} is ${status} - waiting for this specific period (${account}/${periodKey})`);
                    const maxWait = 120000; // 120s max wait for this period
                    const waited = await waitForPeriodCompletion(filtersHash, periodKey, maxWait);
                    
                    if (waited) {
                        // Period completed - detect status change and force recalculation if needed
                        const previousStatus = getStatusChange(filtersHash, periodKey);
                        const justCompleted = previousStatus && (previousStatus === "running" || previousStatus === "requested");
                        
                        // Update status tracking (immediate flush for completion)
                        setStatusChange(filtersHash, periodKey, "completed", true);
                        
                        // Period completed - check cache immediately first
                        let localStorageValue = checkLocalStorageCache(account, fromPeriod, toPeriod, subsidiary, filtersHash);
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
                        
                        // Cache not found but status is "completed" - retry with bounded delays
                        // Use Promise-based retry that resolves to a number (preserves Excel auto-retry)
                        console.log(`⏳ Period ${periodKey} marked completed but cache not found - retrying cache lookup...`);
                        const retryResult = await retryCacheLookup(
                            account, fromPeriod, toPeriod, subsidiary, filtersHash, cacheKey, periodKey,
                            checkLocalStorageCache
                        );
                        if (retryResult !== null) {
                            return retryResult;
                        }
                        // Cache still not found after retries - proceed to API path (don't throw)
                        console.log(`⏳ Cache not found after retries - proceeding to API path for ${periodKey}`);
                    }
                    
                    // Check final status - if still running, proceed to API path
                    // (transient state, API will handle gracefully)
                    const finalStatus = getPeriodStatus(filtersHash, periodKey);
                    if (finalStatus === "running" || finalStatus === "requested") {
                        console.log(`⏳ Period ${periodKey} still ${finalStatus} - proceeding to API path`);
                        // Continue to API path below (don't throw)
                    }
                }
                // If status is "not_found" or "failed", continue to manifest check below
            }
        }
        
        // ================================================================
        // GLOBAL PRELOAD WAIT (legacy behavior for non-normalized periods)
        // CRITICAL: Skip this wait for P&L accounts - they should never wait for BS preload
        // ================================================================
        if (isPreloadInProgress() && lookupPeriod && isCumulativeQuery) {
            const periodKey = normalizePeriodKey(lookupPeriod);
            if (!periodKey) {
                // Cannot normalize period - fall back to global preload wait (legacy behavior)
                // BUT: Only for BS accounts - P&L accounts should never wait here
                console.log(`⏳ Preload in progress - waiting for cache (${account}/${fromPeriod || toPeriod}) - period not normalized, using global wait`);
                await waitForPreload();
                console.log(`✅ Preload complete - checking cache`);
                
                // After preload completes, check caches
                if (cache.balance.has(cacheKey)) {
                    console.log(`✅ Post-preload cache hit (memory): ${account}`);
                    cacheStats.hits++;
                    return cache.balance.get(cacheKey);
                }
                
                const localStorageValue = checkLocalStorageCache(account, fromPeriod, toPeriod, subsidiary);
                if (localStorageValue !== null) {
                    console.log(`✅ Post-preload cache hit (localStorage): ${account}`);
                    cacheStats.hits++;
                    cache.balance.set(cacheKey, localStorageValue);
                    return localStorageValue;
                }
                
                const fyValue = checkFullYearCache(account, fromPeriod || toPeriod, subsidiary);
                if (fyValue !== null) {
                    console.log(`✅ Post-preload cache hit (fullYearCache): ${account}`);
                    cacheStats.hits++;
                    cache.balance.set(cacheKey, fyValue);
                    return fyValue;
                }
                
                console.log(`⚠️ Post-preload cache miss - will query NetSuite: ${account}`);
            }
        }
        
        // ================================================================
        // CHECK FOR CACHE INVALIDATION SIGNAL (from Refresh Selected)
        // ================================================================
        // CRITICAL: lookupPeriod already normalized above (line ~4396)
        // Re-use the same variable to avoid duplicate declaration
        const invalidateKey = 'netsuite_cache_invalidate';
        try {
            const invalidateData = localStorage.getItem(invalidateKey);
            if (invalidateData) {
                const { items, timestamp } = JSON.parse(invalidateData);
                // Only honor signals from last 30 seconds
                if (Date.now() - timestamp < 30000) {
                    const itemKey = `${account}:${lookupPeriod}`;
                    if (items && items.includes(itemKey)) {
                        console.log(`🔄 INVALIDATED: ${itemKey} - clearing from in-memory cache`);
                        // Clear this specific item from in-memory caches
                        cache.balance.delete(cacheKey);
                        if (fullYearCache && fullYearCache[account]) {
                            delete fullYearCache[account][lookupPeriod];
                        }
                        // Remove this item from the invalidation list
                        const newItems = items.filter(i => i !== itemKey);
                        if (newItems.length > 0) {
                            localStorage.setItem(invalidateKey, JSON.stringify({ items: newItems, timestamp }));
                        } else {
                            localStorage.removeItem(invalidateKey);
                        }
                    }
                } else {
                    // Stale invalidation signal - remove it
                    localStorage.removeItem(invalidateKey);
                }
            }
        } catch (e) {
            // Ignore invalidation check errors
        }
        
        // ================================================================
        // CACHE CHECKS (same priority order as before)
        // ================================================================
        
        // Check in-memory cache FIRST
        if (cache.balance.has(cacheKey)) {
            cacheStats.hits++;
            return cache.balance.get(cacheKey);
        }
        
        // Check localStorage cache (BUT NOT for subsidiary-filtered queries OR period activity queries!)
        // localStorage is keyed by account+period only (cumulative), not for period ranges
        // Period activity queries (both fromPeriod and toPeriod) must NOT use localStorage cache
        // because checkLocalStorageCache only looks up cumulative balances (single period)
        const filtersHash = getFilterKey({ subsidiary, department, location, classId, accountingBook });
        let localStorageValue = null;
        // Only check localStorage for cumulative queries (point-in-time, not period activity)
        if (isCumulativeQuery) {
            localStorageValue = checkLocalStorageCache(account, fromPeriod, toPeriod, subsidiary, filtersHash);
        }
        if (localStorageValue !== null) {
            // Reduced logging - only log first few hits
            if (cacheStats.hits < 5) {
                console.log(`✅ Cache hit: ${account}/${lookupPeriod || toPeriod}`);
            }
            cacheStats.hits++;
            // Also save to in-memory cache for next time
            cache.balance.set(cacheKey, localStorageValue);
            return localStorageValue;
        } else {
            // Reduced logging - only log first few misses
            if (cacheStats.misses < 10) {
                console.log(`📭 Cache miss: ${account}/${lookupPeriod || toPeriod}`);
            }
            cacheStats.misses++;
            
            // ================================================================
            // FIX #2 & #4: Check manifest and trigger preload BEFORE queuing API calls
            // This ensures preload is triggered early and formulas wait if preload is in progress
            // CRITICAL: Manifest/preload logic ONLY for Balance Sheet accounts
            // P&L accounts should skip this entirely and proceed directly to API call
            // ================================================================
            // ✅ Check manifest ONLY for BS accounts (P&L accounts skip this)
            if (isCumulativeQuery && lookupPeriod) {
                const periodKey = normalizePeriodKey(lookupPeriod);
                if (!periodKey) {
                    // If numeric ID, try to resolve it
                    if (/^\d+$/.test(String(lookupPeriod).trim())) {
                        const resolved = await resolvePeriodIdToName(lookupPeriod);
                        if (resolved) {
                            // Use resolved period key
                            const resolvedCache = checkLocalStorageCache(account, fromPeriod, toPeriod, subsidiary, filtersHash);
                            if (resolvedCache !== null) {
                                return resolvedCache;
                            }
                            // Continue with manifest check using resolved key
                            const status = getPeriodStatus(filtersHash, resolved);
                            const manifest = getManifest(filtersHash);
                            const period = manifest.periods[resolved];
                            
                            if (status === "running" || status === "requested") {
                                // Period is being preloaded - wait longer (120s max, increased from 90s)
                                // BS preload can take 60-90s, so 120s gives buffer for network delays
                                const maxWait = 120000;  // 120s (reduced from 180s but increased from original 90s)
                                console.log(`⏳ Period ${resolved} is ${status} - waiting up to ${maxWait/1000}s...`);
                                const waited = await waitForPeriodCompletion(filtersHash, resolved, maxWait);
                                
                                if (waited) {
                                    const retryCache = checkLocalStorageCache(account, fromPeriod, toPeriod, subsidiary, filtersHash);
                                    if (retryCache !== null) {
                                        return retryCache;
                                    }
                                }
                                
                                // Still miss after wait - check if still running/retrying
                                const finalStatus = getPeriodStatus(filtersHash, resolved);
                                const finalPeriod = getManifest(filtersHash).periods[resolved];
                                
                                if (finalStatus === "running" || finalStatus === "requested") {
                                    // ✅ Still running - proceed to API path (transient state)
                                    console.log(`⏳ Period ${resolved} still ${finalStatus} - proceeding to API path`);
                                    // Continue to API path below (don't throw)
                                } else if (finalStatus === "failed" && finalPeriod && finalPeriod.attemptCount < 3) {
                                    // ✅ Retries remaining - proceed to API path (transient state)
                                    console.log(`⏳ Period ${resolved} failed but retries remaining - proceeding to API path`);
                                    // Continue to API path below (don't throw)
                                }
                            } else if (status === "failed") {
                                // Check if retries exhausted
                                if (period && period.attemptCount >= 3) {
                                    // ✅ Retries exhausted - proceed with API call
                                    console.log(`⚠️ Period ${resolved} precache failed (${period.attemptCount} attempts) - using API call`);
                                } else {
                                    // ✅ Retries remaining - proceed to API path (transient state)
                                    console.log(`⏳ Period ${resolved} failed but retries remaining - proceeding to API path`);
                                    // Continue to API path below (don't throw)
                                }
                            } else if (status === "not_found") {
                                // CRITICAL: Before triggering preload, double-check legacy cache
                                // Income statement and other reports save to netsuite_balance_cache but don't update manifest
                                // So if cache exists, use it instead of triggering preload
                                const legacyCacheCheck = checkLocalStorageCache(account, fromPeriod, toPeriod, subsidiary, filtersHash);
                                if (legacyCacheCheck !== null) {
                                    console.log(`✅ Legacy cache found (manifest not_found but cache exists): ${account} for ${resolved} = ${legacyCacheCheck}`);
                                    cacheStats.hits++;
                                    cache.balance.set(cacheKey, legacyCacheCheck);
                                    return legacyCacheCheck;
                                }
                                
                                // CRITICAL: Only trigger preload for point-in-time (cumulative) queries
                                // Period activity queries should not trigger preload
                                const isCumulativeQueryResolved = isCumulativeRequest(fromPeriod);
                                if (isCumulativeQueryResolved) {
                                    // FIX #2: Period not requested - trigger preload EARLY (before queuing)
                                    console.log(`🔄 Period ${resolved} not in manifest - triggering preload before queuing API calls`);
                                    addPeriodToRequestQueue(resolved, { subsidiary, department, location, classId, accountingBook });
                                    
                                    // FIX #4: Also trigger auto-preload for BS accounts (if not subsidiary-filtered)
                                    if (!subsidiary) {
                                        triggerAutoPreload(account, resolved);
                                    }
                                    
                                    // FIX #4: Wait for preload with bounded timeout (120s max - increased from 90s)
                                    // BS preload can take 60-90s, so 120s gives buffer for network delays
                                    const maxWait = 120000; // 120 seconds - bounded wait (increased from 90s)
                                    console.log(`⏳ Waiting for preload to start/complete (max ${maxWait/1000}s)...`);
                                    const waited = await waitForPeriodCompletion(filtersHash, resolved, maxWait);
                                    
                                    if (waited) {
                                        // Preload completed - re-check cache
                                        let retryCache = checkLocalStorageCache(account, fromPeriod, toPeriod, subsidiary, filtersHash);
                                        if (retryCache !== null) {
                                            console.log(`✅ Post-preload cache hit: ${account} for ${resolved} = ${retryCache}`);
                                            cacheStats.hits++;
                                            cache.balance.set(cacheKey, retryCache);
                                            return retryCache;
                                        }
                                        
                                        // Cache not found but status is "completed" - wait briefly for cache write
                                        // Use async waits with bounded timeout, yielding to event loop
                                        console.log(`⏳ Period ${resolved} marked completed but cache not found - waiting for cache write...`);
                                        const cacheWaitStart = Date.now();
                                        const cacheWaitMax = 2000; // 2 seconds max (reduced from 3s)
                                        const checkInterval = 200; // Check every 200ms (yields to event loop)
                                        
                                        while (Date.now() - cacheWaitStart < cacheWaitMax) {
                                            // Yield to event loop (non-blocking)
                                            await new Promise(r => setTimeout(r, checkInterval));
                                            
                                            // Check cache again
                                            retryCache = checkLocalStorageCache(account, fromPeriod, toPeriod, subsidiary, filtersHash);
                                            if (retryCache !== null) {
                                                // Cache found - return immediately (no delay)
                                                console.log(`✅ Post-preload cache hit (after wait): ${account} for ${resolved} = ${retryCache}`);
                                                cacheStats.hits++;
                                                cache.balance.set(cacheKey, retryCache);
                                                return retryCache;
                                            }
                                            
                                            // Also check in-memory cache
                                            if (cache.balance.has(cacheKey)) {
                                                console.log(`✅ Post-preload cache hit (memory, after wait): ${account} for ${resolved}`);
                                                cacheStats.hits++;
                                                return cache.balance.get(cacheKey);
                                            }
                                        }
                                        
                                        // Cache still not found after bounded wait - throw error
                                        // Excel will retry on next recalculation cycle
                                        // Cache not found but status is "completed" - retry with bounded delays
                                        // Use Promise-based retry that resolves to a number (preserves Excel auto-retry)
                                        console.log(`⏳ Period ${resolved} marked completed but cache not found - retrying cache lookup...`);
                                        const retryResult = await retryCacheLookup(
                                            account, fromPeriod, toPeriod, subsidiary, filtersHash, cacheKey, resolved,
                                            checkLocalStorageCache
                                        );
                                        if (retryResult !== null) {
                                            return retryResult;
                                        }
                                        // Cache still not found after retries - proceed to API path (don't throw)
                                        console.log(`⏳ Cache not found after retries - proceeding to API path for ${resolved}`);
                                    }
                                    
                                    // Still miss after wait - check if now running/retrying
                                    const finalStatus = getPeriodStatus(filtersHash, resolved);
                                    if (finalStatus === "running" || finalStatus === "requested") {
                                        // ✅ Still running - proceed to API path (transient state)
                                        console.log(`⏳ Period ${resolved} still ${finalStatus} - proceeding to API path`);
                                        // Continue to API path below (don't throw)
                                    }
                                    // If preload failed or timed out, continue to API call below
                                }
                                // P&L accounts skip preload wait - proceed directly to API call
                            }
                        } else {
                            // Cannot resolve - proceed with API call
                            console.warn(`⚠️ Cannot resolve periodId ${lookupPeriod} - using API call`);
                        }
                    } else {
                        // Cannot normalize - proceed with API call
                        console.warn(`⚠️ Cannot normalize period "${lookupPeriod}" - using API call`);
                    }
                } else {
                    // Period key normalized successfully
                    const status = getPeriodStatus(filtersHash, periodKey);
                    const manifest = getManifest(filtersHash);
                    const period = manifest.periods[periodKey];
                    
                    if (status === "running" || status === "requested") {
                        // Period is being preloaded - wait longer (120s max, increased from 90s)
                        // BS preload can take 60-90s, so 120s gives buffer for network delays
                        const maxWait = 120000;  // 120s (reduced from 180s but increased from original 90s)
                        console.log(`⏳ Period ${periodKey} is ${status} - waiting up to ${maxWait/1000}s...`);
                        const waited = await waitForPeriodCompletion(filtersHash, periodKey, maxWait);
                        
                        if (waited) {
                            let retryCache = checkLocalStorageCache(account, fromPeriod, toPeriod, subsidiary, filtersHash);
                            if (retryCache !== null) {
                                return retryCache;
                            }
                            
                            // Cache not found but status is "completed" - wait briefly for cache write
                            // Use async waits with bounded timeout, yielding to event loop
                            console.log(`⏳ Period ${periodKey} marked completed but cache not found - waiting for cache write...`);
                            const cacheWaitStart = Date.now();
                            const cacheWaitMax = 2000; // 2 seconds max (reduced from 3s)
                            const checkInterval = 200; // Check every 200ms (yields to event loop)
                            
                            // Also check in-memory cache
                            if (cache.balance.has(cacheKey)) {
                                return cache.balance.get(cacheKey);
                            }
                            
                            // Cache not found but status is "completed" - retry with bounded delays
                            // Use Promise-based retry that resolves to a number (preserves Excel auto-retry)
                            console.log(`⏳ Period ${periodKey} marked completed but cache not found - retrying cache lookup...`);
                            const retryResult = await retryCacheLookup(
                                account, fromPeriod, toPeriod, subsidiary, filtersHash, cacheKey, periodKey,
                                checkLocalStorageCache
                            );
                            if (retryResult !== null) {
                                return retryResult;
                            }
                            // Cache still not found after retries - proceed to API path (don't throw)
                            console.log(`⏳ Cache not found after retries - proceeding to API path for ${periodKey}`);
                        }
                        
                        // Still miss after wait - check if still running/retrying
                        const finalStatus = getPeriodStatus(filtersHash, periodKey);
                        const finalPeriod = getManifest(filtersHash).periods[periodKey];
                        
                        if (finalStatus === "running" || finalStatus === "requested") {
                            // ✅ Still running - proceed to API path (transient state)
                            console.log(`⏳ Period ${periodKey} still ${finalStatus} - proceeding to API path`);
                            // Continue to API path below (don't throw)
                        } else if (finalStatus === "failed" && finalPeriod && finalPeriod.attemptCount < 3) {
                            // ✅ Retries remaining - proceed to API path (transient state)
                            console.log(`⏳ Period ${periodKey} failed but retries remaining - proceeding to API path`);
                            // Continue to API path below (don't throw)
                        }
                    } else if (status === "failed") {
                        // Check if retries exhausted
                        if (period && period.attemptCount >= 3) {
                            // ✅ Retries exhausted - proceed with API call
                            console.log(`⚠️ Period ${periodKey} precache failed (${period.attemptCount} attempts) - using API call`);
                        } else {
                            // ✅ Retries remaining - proceed to API path (transient state)
                            console.log(`⏳ Period ${periodKey} failed but retries remaining - proceeding to API path`);
                            // Continue to API path below (don't throw)
                        }
                    } else if (status === "not_found") {
                        // CRITICAL: Before triggering preload, double-check legacy cache
                        // Income statement and other reports save to netsuite_balance_cache but don't update manifest
                        // So if cache exists, use it instead of triggering preload
                        const legacyCacheCheck = checkLocalStorageCache(account, fromPeriod, toPeriod, subsidiary, filtersHash);
                        if (legacyCacheCheck !== null) {
                            console.log(`✅ Legacy cache found (manifest not_found but cache exists): ${account} for ${periodKey} = ${legacyCacheCheck}`);
                            cacheStats.hits++;
                            cache.balance.set(cacheKey, legacyCacheCheck);
                            return legacyCacheCheck;
                        }
                        
                        // CRITICAL: Only trigger preload for Balance Sheet accounts (cumulative queries only)
                        // Period activity queries (both fromPeriod and toPeriod) should NOT trigger preload
                        // P&L accounts should not trigger BS preload
                        const isBSAccount = isCumulativeRequest(fromPeriod);
                        const isPeriodActivity = !isCumulativeRequest(fromPeriod) && fromPeriod && toPeriod;
                        
                        if (isBSAccount && !isPeriodActivity) {
                            // FIX #2: Period not requested - trigger preload EARLY (before queuing)
                            // BUT: Only if preload is not already in progress for this period
                            const preloadStatus = getPeriodStatus(filtersHash, periodKey);
                            const isPreloadRunning = isPreloadInProgress() || preloadStatus === "running" || preloadStatus === "requested";
                            
                            if (!isPreloadRunning) {
                                console.log(`🔄 BS account: Period ${periodKey} not in manifest - triggering preload before queuing API calls`);
                                addPeriodToRequestQueue(periodKey, { subsidiary, department, location, classId, accountingBook });
                                
                                // FIX #4: Also trigger auto-preload for BS accounts (if not subsidiary-filtered)
                                if (!subsidiary) {
                                    triggerAutoPreload(account, periodKey);
                                }
                            } else {
                                console.log(`⏸️ BS account: Period ${periodKey} preload already in progress (status: ${preloadStatus}) - skipping trigger`);
                            }
                        } else {
                            // P&L account - don't trigger BS preload, proceed to API call
                            // CRITICAL: P&L accounts should NEVER wait for BS preload
                            // Remove excessive logging - only log first few misses
                            if (cacheStats.misses < 3) {
                                console.log(`ℹ️ P&L: Period ${periodKey} not in manifest - skipping BS preload, using API`);
                            }
                            cacheStats.misses++;
                            // Skip the wait entirely for P&L accounts - proceed directly to API call
                            // (The code continues below to make the API call)
                        }
                        
                        // CRITICAL FIX: Only wait for preload if this is a BS account (cumulative, not period activity)
                        // P&L accounts should NEVER wait for BS preload (they use different cache)
                        // Period activity queries should NOT wait for preload (they use different query path)
                        if (isBSAccount && !isPeriodActivity) {
                            // FIX #4: Wait for preload with bounded timeout (120s max - increased from 90s)
                            // BS preload can take 60-90s, so 120s gives buffer for network delays
                            const maxWait = 120000; // 120 seconds - bounded wait (increased from 90s)
                            console.log(`⏳ Waiting for preload to start/complete (max ${maxWait/1000}s)...`);
                            const waited = await waitForPeriodCompletion(filtersHash, periodKey, maxWait);
                            
                            if (waited) {
                                // Preload completed - re-check cache
                                let retryCache = checkLocalStorageCache(account, fromPeriod, toPeriod, subsidiary, filtersHash);
                                if (retryCache !== null) {
                                    console.log(`✅ Post-preload cache hit: ${account} for ${periodKey} = ${retryCache}`);
                                    cacheStats.hits++;
                                    cache.balance.set(cacheKey, retryCache);
                                    return retryCache;
                                }
                                
                                // Cache not found but status is "completed" - wait briefly for cache write
                                // Use async waits with bounded timeout, yielding to event loop
                                console.log(`⏳ Period ${periodKey} marked completed but cache not found - waiting for cache write...`);
                                const cacheWaitStart = Date.now();
                                const cacheWaitMax = 2000; // 2 seconds max (reduced from 3s)
                                const checkInterval = 200; // Check every 200ms (yields to event loop)
                                
                                // Also check in-memory cache
                                if (cache.balance.has(cacheKey)) {
                                    console.log(`✅ Post-preload cache hit (memory): ${account} for ${periodKey}`);
                                    cacheStats.hits++;
                                    return cache.balance.get(cacheKey);
                                }
                                
                            // Cache not found but status is "completed" - retry with bounded delays
                            // Use Promise-based retry that resolves to a number (preserves Excel auto-retry)
                            console.log(`⏳ Period ${periodKey} marked completed but cache not found - retrying cache lookup...`);
                            const retryResult = await retryCacheLookup(
                                account, fromPeriod, toPeriod, subsidiary, filtersHash, cacheKey, periodKey,
                                checkLocalStorageCache
                            );
                            if (retryResult !== null) {
                                return retryResult;
                            }
                            // Cache still not found after retries - proceed to API path (don't throw)
                            console.log(`⏳ Cache not found after retries - proceeding to API path for ${periodKey}`);
                            }
                            
                            // Still miss after wait - check if now running/retrying
                            const finalStatus = getPeriodStatus(filtersHash, periodKey);
                            if (finalStatus === "running" || finalStatus === "requested") {
                                // ✅ Still running - proceed to API path (transient state)
                                console.log(`⏳ Period ${periodKey} still ${finalStatus} - proceeding to API path`);
                                // Continue to API path below (don't throw)
                            }
                            // If preload failed or timed out, continue to API call below
                        }
                        // P&L accounts skip the wait entirely - proceed directly to API call
                }
            }
        }
        
        // Check in-memory full year cache (backup for Shared Runtime)
        // BUT NOT for subsidiary-filtered queries - fullYearCache is not subsidiary-aware
        const fullYearValue = checkFullYearCache(account, fromPeriod, subsidiary);
        if (fullYearValue !== null) {
            cacheStats.hits++;
            cache.balance.set(cacheKey, fullYearValue);
            return fullYearValue;
        }
        
        // ================================================================
        // WILDCARD RESOLUTION FROM CACHE
        // For patterns like "100*", sum all matching accounts from cache
        // This avoids backend calls if precache already has the data
        // ================================================================
        if (account.includes('*')) {
            const wildcardResult = resolveWildcardFromCache(account, fromPeriod, toPeriod, subsidiary);
            if (wildcardResult !== null) {
                console.log(`🎯 WILDCARD CACHE HIT: ${account} = ${wildcardResult.toLocaleString()} (${wildcardResult.matchCount} accounts)`);
                cacheStats.hits++;
                cache.balance.set(cacheKey, wildcardResult.total);
                return wildcardResult.total;
            } else {
                console.log(`📭 WILDCARD CACHE MISS: ${account} - will query backend`);
            }
        }
        
        // ================================================================
        // BUILD MODE: Queue with Promise (will be resolved after batch)
        // We return a Promise, not 0 - this shows #BUSY briefly but ensures
        // correct values. The batch will resolve all promises at once.
        // 
        // VALIDATION: Skip incomplete requests (cell references not yet resolved)
        // - For P&L: both fromPeriod and toPeriod required
        // - For BS (cumulative): toPeriod required (fromPeriod can be empty)
        // ================================================================
        if (buildMode) {
            // Skip requests where toPeriod is empty (cell reference not resolved yet)
            // Excel will re-evaluate when the cell reference resolves
            // For now, proceed to API path - API will handle invalid params gracefully
            if (!toPeriod || toPeriod === '') {
                console.log(`⏳ BUILD MODE: Period not yet resolved for ${account} - proceeding to API path`);
                // Continue to API path below (don't throw - Excel will re-evaluate when period resolves)
            } else {
                console.log(`🔨 BUILD MODE: Queuing ${account}/${fromPeriod || '(cumulative)'} → ${toPeriod}`);
                return new Promise((resolve, reject) => {
                    buildModePending.push({ cacheKey, params, resolve, reject });
                });
            }
        }
        
        // ================================================================
        // NORMAL MODE: Cache miss - add to batch queue and return Promise
        // 
        // VALIDATION: Skip incomplete requests (cell references not yet resolved)
        // Excel will re-evaluate when the cell reference resolves
        // ================================================================
        
        // For cumulative (BS) requests: toPeriod required
        // For period-range (P&L) requests: both required (toPeriod at minimum)
        // If period not resolved, proceed to API path - API will handle invalid params gracefully
        // Excel will re-evaluate when period resolves
        if (!toPeriod || toPeriod === '') {
            console.log(`⏳ Period not yet resolved for ${account} - proceeding to API path`);
            // Continue to API path below (don't throw - Excel will re-evaluate when period resolves)
        }
        
        cacheStats.misses++;
        
        // BS DETECTION: Check if this is a cumulative (Balance Sheet) request
        const isBSRequest = isCumulativeRequest(fromPeriod);
        if (isBSRequest) {
            totalBSFormulasQueued++;
            trackBSPeriod(toPeriod);
            
            // First BS formula - trigger automatic preload!
            if (totalBSFormulasQueued === 1) {
                showBSEducationToast(account, toPeriod);
            }
        }
        
        // In full refresh mode, queue silently (task pane will trigger processFullRefresh)
        // REDUCED LOGGING: Only log first few cache misses to prevent console flooding
        if (!isFullRefreshMode && cacheStats.misses < 10) {
            console.log(`📥 CACHE MISS [balance]: ${account} (${fromPeriod || '(cumulative)'} to ${toPeriod}) → queuing${isBSRequest ? ' [BS]' : ''}`);
        }
        
        // Return a Promise that will be resolved by the batch processor
        return new Promise((resolve, reject) => {
            // REDUCED LOGGING: Only log first few queue operations to prevent console flooding
            if (cacheStats.misses < 10) {
                console.log(`📥 QUEUED: ${account} for ${fromPeriod || '(cumulative)'} → ${toPeriod}`);
            }
            
            pendingRequests.balance.set(cacheKey, {
                params,
                resolve,
                reject,
                timestamp: Date.now()
            });
            
            // REDUCED LOGGING: Only log queue details for first few items
            if (cacheStats.misses < 10) {
                console.log(`   Queue size now: ${pendingRequests.balance.size}`);
                console.log(`   isFullRefreshMode: ${isFullRefreshMode}`);
                console.log(`   batchTimer exists: ${!!batchTimer}`);
            }
            
            // In full refresh mode, DON'T start the batch timer
            // The task pane will explicitly call processFullRefresh() when ready
            if (!isFullRefreshMode) {
                // Start batch timer if not already running (Mode 1: small batches)
                // CRITICAL: Clear existing timer before setting new one (prevent multiple timers)
                if (batchTimer) {
                    clearTimeout(batchTimer);
                    batchTimer = null;
                }
                console.log(`⏱️ STARTING batch timer (${BATCH_DELAY}ms)`);
                batchTimer = setTimeout(() => {
                    console.log('⏱️ Batch timer FIRED!');
                    batchTimer = null;
                    processBatchQueue().catch(err => {
                        console.error('❌ Batch processing error:', err);
                    });
                }, BATCH_DELAY);
            } else {
                console.log('   Full refresh mode - NOT starting timer');
            }
        });
    }
    } catch (error) {
        console.error('BALANCE error:', error);
        // Re-throw if already an Error, otherwise wrap
        if (error instanceof Error) {
            throw error;
        }
        throw new Error('ERROR');
    }
}

// ============================================================================
// BALANCECURRENCY - Get balance with explicit currency control for consolidation
// ============================================================================
/**
 * Get GL account balance with explicit currency control for consolidation.
 * Currency parameter determines consolidation root, while subsidiary filters transactions.
 * 
 * For Balance Sheet accounts: fromPeriod can be null/comma/empty (calculates from inception).
 * For P&L accounts: fromPeriod is required.
 * 
 * @customfunction BALANCECURRENCY
 * @param {any} account Account number or wildcard pattern (e.g., "10034" or "4*")
 * @param {any} fromPeriod Starting period (required for P&L, can be empty "" for BS)
 * @param {any} toPeriod Ending period (required)
 * @param {any} subsidiary Subsidiary filter (use "" for all)
 * @param {any} currency Currency code for consolidation root (e.g., "USD", "EUR") - optional
 * @param {any} department Department filter (use "" for all)
 * @param {any} location Location filter (use "" for all)
 * @param {any} classId Class filter (use "" for all)
 * @param {any} accountingBook Accounting Book ID (use "" for Primary Book)
 * @returns {Promise<number>} The account balance (throws Error on failure)
 * @requiresAddress
 */
async function BALANCECURRENCY(account, fromPeriod, toPeriod, subsidiary, currency, department, location, classId, accountingBook) {
    try {
        // Removed excessive debug logging - only log on actual errors
        
        // ================================================================
        // VALIDATION: Check for empty cell references (CPA perspective)
        // If a cell reference is provided but points to an empty cell,
        // return an error to prevent silent 0 values that could be mistakes
        // ================================================================
        // Note: Excel passes undefined for empty cells, but we also check for empty strings
        // We allow explicit null/empty (using ,,) but not cell references to empty cells
        const rawAccount = account;
        const rawFromPeriod = fromPeriod;
        const rawToPeriod = toPeriod;
        const rawSubsidiary = subsidiary;
        const rawCurrency = currency;
        const rawDepartment = department;
        const rawLocation = location;
        const rawClassId = classId;
        const rawAccountingBook = accountingBook;
        
        // Check if account is a cell reference that's empty
        // Cell references are typically Range objects or strings like "A1", not undefined
        // If it's undefined, it means the parameter was omitted (OK), but if it's a string/object and empty, that's an error
        if (account !== undefined && account !== null && account !== '' && 
            (typeof account === 'string' || typeof account === 'object') &&
            String(account).trim() === '') {
            console.error('❌ BALANCECURRENCY: Account cell reference is empty. Please provide an account number or use "" for wildcard.');
            throw new Error('EMPTY_CELL');
        }
        
        // Check toPeriod - this is required and cannot be empty
        if (toPeriod !== undefined && toPeriod !== null && toPeriod !== '' &&
            (typeof toPeriod === 'string' || typeof toPeriod === 'object') &&
            String(toPeriod).trim() === '') {
            console.error('❌ BALANCECURRENCY: ToPeriod cell reference is empty. This parameter is required.');
            throw new Error('EMPTY_CELL');
        }
        
        // Check currency - if provided as cell reference, it should not be empty
        if (currency !== undefined && currency !== null && currency !== '' &&
            (typeof currency === 'string' || typeof currency === 'object') &&
            String(currency).trim() === '') {
            console.error('❌ BALANCECURRENCY: Currency cell reference is empty. Use "" to omit currency or provide a currency code.');
            throw new Error('EMPTY_CELL');
        }
        
        // Normalize account number
        account = normalizeAccountNumber(account);
        
        if (!account) {
            console.error('❌ BALANCECURRENCY: account parameter is required');
            throw new Error('MISSING_ACCT');
        }
        
        // Convert date values to "Mon YYYY" format (supports both dates and period strings)
        // For year-only format ("2025"), expand to "Jan 2025" and "Dec 2025"
        // NOTE: Matching BALANCE function approach - Excel typically passes date serials as numbers
        // convertToMonthYear handles both numbers and string representations of Excel date serials
        const rawFrom = fromPeriod;
        const rawTo = toPeriod;
        fromPeriod = normalizePeriodKey(fromPeriod, true) || fromPeriod;   // true = isFromPeriod
        toPeriod = normalizePeriodKey(toPeriod, false) || toPeriod;      // false = isToPeriod
        
        // Debug log the period conversion
        console.log(`📅 BALANCECURRENCY periods: ${rawFrom} → "${fromPeriod}", ${rawTo} → "${toPeriod}"`);
        
        // Validate that periods were converted successfully
        const periodPattern = /^[A-Za-z]{3}\s+\d{4}$/;
        if (fromPeriod && !periodPattern.test(fromPeriod)) {
            console.error(`❌ Invalid fromPeriod after conversion: "${fromPeriod}" (raw: ${rawFrom})`);
        }
        if (toPeriod && !periodPattern.test(toPeriod)) {
            console.error(`❌ Invalid toPeriod after conversion: "${toPeriod}" (raw: ${rawTo})`);
        }
        
        if (!toPeriod) {
            console.error('❌ BALANCECURRENCY: toPeriod is required');
            throw new Error('MISSING_PERIOD');
        }
        
        // Balance Sheet detection: If fromPeriod is empty/null, treat as cumulative (BS account)
        // This matches the logic in BALANCE function
        const isBSRequest = isCumulativeRequest(fromPeriod);
        if (isBSRequest) {
            // For BS accounts, clear fromPeriod to signal cumulative calculation
            fromPeriod = '';
            console.log(`📊 BALANCECURRENCY: BS account detected - using cumulative through ${toPeriod}`);
        }
        
        // Other parameters as strings
        // CRITICAL: For currency, we need to handle Range objects properly
        // Excel may pass Range objects for cell references, which need special handling
        subsidiary = String(subsidiary || '').trim();
        
        // Extract currency value - handle Range objects from cell references
        // Excel custom functions with @requiresAddress receive Range objects
        // Use the robust extraction helper to handle all possible Range formats
        const originalCurrency = currency;
        const wasCurrencyProvided = currency !== undefined && currency !== null;
        
        // Use the helper function to extract value from Range object or primitive
        currency = extractValueFromRange(currency, 'currency');
        const currencyExtracted = wasCurrencyProvided && (currency !== '' || originalCurrency === '' || originalCurrency === null);
        
        // CRITICAL: Normalize currency to uppercase for consistency
        // NetSuite currency codes are case-sensitive, but we want consistent cache keys
        // Normalize to uppercase to ensure "USD" and "usd" use the same cache key
        if (currency && currency.trim() !== '') {
            currency = String(currency).trim().toUpperCase();
        } else {
            currency = ''; // Ensure empty string for consistency
        }
        
        // Log the extraction result
        if (wasCurrencyProvided) {
            if (currency) {
                console.log(`✅ BALANCECURRENCY: Currency extracted successfully: "${originalCurrency}" → "${currency}" (normalized to uppercase)`);
            } else if (originalCurrency === '' || originalCurrency === null) {
                console.log(`ℹ️ BALANCECURRENCY: Currency parameter is empty (explicitly omitted)`);
            } else {
                console.warn(`⚠️ BALANCECURRENCY: Currency parameter was provided but extraction resulted in empty string. Original:`, originalCurrency);
            }
        } else {
            console.log(`ℹ️ BALANCECURRENCY: Currency parameter not provided (optional)`);
        }
        
        // CRITICAL VALIDATION: If currency parameter was provided (not omitted) but is empty after extraction,
        // return an error to prevent cache collision and misleading data
        // Note: We allow explicit empty currency (user passes "" or ,,) but not empty cell references
        if (wasCurrencyProvided && !currencyExtracted && currency === '') {
            console.error('❌ BALANCECURRENCY: Currency parameter was provided but could not be extracted from cell reference. Cell may be empty or invalid.');
            console.error('   Original currency value:', originalCurrency);
            console.error('   Currency type:', typeof originalCurrency);
            if (typeof originalCurrency === 'object' && originalCurrency !== null) {
                console.error('   Currency object structure:', JSON.stringify(originalCurrency, null, 2));
            }
            throw new Error('EMPTY_CURRENCY');
        }
        
        // Log final currency value
        if (currency) {
            console.log(`✅ BALANCECURRENCY: Final currency value: "${currency}" (normalized)`);
        } else if (wasCurrencyProvided) {
            // Currency was provided but is empty - this is OK if user explicitly passed empty string
            console.log(`ℹ️ BALANCECURRENCY: Currency parameter is empty (explicitly omitted)`);
        } else {
            // Currency was not provided at all - this is OK (optional parameter)
            console.log(`ℹ️ BALANCECURRENCY: Currency parameter not provided (optional)`);
        }
        
        department = String(department || '').trim();
        location = String(location || '').trim();
        classId = String(classId || '').trim();
        accountingBook = String(accountingBook || '').trim();
        
        // ================================================================
        // BUILD MODE DETECTION: Detect rapid formula creation (drag/paste)
        // Same logic as BALANCE function for precaching
        // ================================================================
        const now = Date.now();
        buildModeLastEvent = now;
        
        // Count formulas created in the current window
        formulaCreationCount++;
        
        // Reset counter after inactivity
        if (formulaCountResetTimer) clearTimeout(formulaCountResetTimer);
        formulaCountResetTimer = setTimeout(() => {
            formulaCreationCount = 0;
        }, BUILD_MODE_WINDOW_MS);
        
        // Enter build mode if we see rapid formula creation
        if (!buildMode && formulaCreationCount >= BUILD_MODE_THRESHOLD) {
            console.log(`🔨 BUILD MODE: Detected ${formulaCreationCount} formulas in ${BUILD_MODE_WINDOW_MS}ms (BALANCECURRENCY)`);
            enterBuildMode();
        }
        
        // Reset the settle timer on every formula (we'll process after user stops)
        if (buildModeTimer) {
            clearTimeout(buildModeTimer);
        }
        buildModeTimer = setTimeout(() => {
            buildModeTimer = null;
            formulaCreationCount = 0;
            if (buildMode) {
                exitBuildModeAndProcess();
            }
        }, BUILD_MODE_SETTLE_MS);
        
        // Build cache key (include currency)
        // CRITICAL: Ensure currency is ALWAYS explicitly included in cache key (even if empty string)
        // to prevent collisions with BALANCE. Using explicit currency: '' vs omitting it entirely
        // ensures different cache keys.
        const params = { 
            account, 
            fromPeriod, 
            toPeriod, 
            subsidiary, 
            currency: currency || '', // Explicitly set to empty string if undefined/null
            department, 
            location, 
            classId, 
            accountingBook 
        };
        const cacheKey = JSON.stringify({
            type: 'balancecurrency',
            ...params
        });
        
        // Debug logging for cache key construction
        if (currency) {
            console.log(`🔍 BALANCECURRENCY cache key includes currency: "${currency}"`);
        } else {
            console.log(`ℹ️ BALANCECURRENCY cache key explicitly includes empty currency: "" (prevents collision with BALANCE)`);
        }
        
        // ================================================================
        // CACHE CHECKS
        // ================================================================
        // Check in-memory cache FIRST
        if (cache.balance.has(cacheKey)) {
            cacheStats.hits++;
            return cache.balance.get(cacheKey);
        }
        
        // ================================================================
        // BUILD MODE: Queue with Promise (will be resolved after batch)
        // Same precaching logic as BALANCE function
        // ================================================================
        if (buildMode) {
            // Skip requests where toPeriod is empty (cell reference not resolved yet)
            // For now, proceed to API path - API will handle invalid params gracefully
            if (!toPeriod || toPeriod === '') {
                console.log(`⏳ BUILD MODE: Period not yet resolved for ${account} (BALANCECURRENCY) - proceeding to API path`);
                // Continue to API path below (don't throw - Excel will re-evaluate when period resolves)
            } else {
                console.log(`🔨 BUILD MODE: Queuing ${account}/${fromPeriod || '(cumulative)'} → ${toPeriod} (BALANCECURRENCY)`);
                return new Promise((resolve, reject) => {
                    buildModePending.push({ cacheKey, params, resolve, reject });
                });
            }
        }
        
        // ================================================================
        // NORMAL MODE: Cache miss - add to batch queue and return Promise
        // ================================================================
        // For cumulative (BS) requests: toPeriod required
        // For period-range (P&L) requests: both required (toPeriod at minimum)
        // If period not resolved, proceed to API path - API will handle invalid params gracefully
        // Excel will re-evaluate when period resolves
        if (!toPeriod || toPeriod === '') {
            console.log(`⏳ Period not yet resolved for ${account} (BALANCECURRENCY) - proceeding to API path`);
            // Continue to API path below (don't throw - Excel will re-evaluate when period resolves)
        }
        
        cacheStats.misses++;
        
        // Make API call
        const apiParams = new URLSearchParams({
            account: account,
            from_period: fromPeriod || '',
            to_period: toPeriod,
            subsidiary: subsidiary,
            currency: currency,
            department: department,
            class: classId,
            location: location,
            book: accountingBook
        });
        
        // Return a Promise that will be resolved by the batch processor
        return new Promise((resolve, reject) => {
            console.log(`📥 QUEUED [balancecurrency]: ${account} for ${fromPeriod || '(cumulative)'} → ${toPeriod} (currency: ${currency || 'default'})`);
            
            pendingRequests.balance.set(cacheKey, {
                params,
                resolve,
                reject,
                timestamp: Date.now(),
                endpoint: '/balancecurrency',
                apiParams: apiParams.toString()
            });
            
            // Start batch timer if not already running
            // CRITICAL: Clear existing timer before setting new one (prevent multiple timers)
            if (!isFullRefreshMode) {
                if (batchTimer) {
                    clearTimeout(batchTimer);
                    batchTimer = null;
                }
                console.log(`⏱️ STARTING batch timer (${BATCH_DELAY}ms) for BALANCECURRENCY`);
                batchTimer = setTimeout(() => {
                    console.log('⏱️ Batch timer FIRED!');
                    batchTimer = null;
                    processBatchQueue().catch(err => {
                        console.error('❌ Batch processing error:', err);
                    });
                }, BATCH_DELAY);
            }
        });
        
    } catch (error) {
        console.error('BALANCECURRENCY error:', error);
        // Re-throw if already an Error, otherwise wrap
        if (error instanceof Error) {
            throw error;
        }
        throw new Error('ERROR');
    }
}

// ============================================================================
// BALANCECHANGE - Get the change in a Balance Sheet account between two dates
// ============================================================================
/**
 * Get the CHANGE in a Balance Sheet account between two points in time.
 * Calculated as: balance(toDate) - balance(fromDate)
 * 
 * ONLY VALID FOR BALANCE SHEET ACCOUNTS.
 * P&L accounts will return "INVALIDACCT".
 * 
 * @customfunction BALANCECHANGE
 * @param {any} account Account number (must be a Balance Sheet account)
 * @param {any} fromPeriod Starting period (e.g., "Dec 2024" or 12/1/2024)
 * @param {any} toPeriod Ending period (e.g., "Jan 2025" or 1/1/2025)
 * @param {any} subsidiary Subsidiary filter (use "" for all)
 * @param {any} department Department filter (use "" for all)
 * @param {any} location Location filter (use "" for all)
 * @param {any} classId Class filter (use "" for all)
 * @param {any} accountingBook Accounting Book ID (use "" for Primary Book)
 * @returns {Promise<number>} The change in balance (throws Error on failure)
 * @requiresAddress
 */
async function BALANCECHANGE(account, fromPeriod, toPeriod, subsidiary, department, location, classId, accountingBook) {
    try {
        // Normalize account number
        account = normalizeAccountNumber(account);
        
        if (!account) {
            console.error('❌ BALANCECHANGE: account parameter is required');
            throw new Error('MISSING_ACCT');
        }
        
        // Convert date values to "Mon YYYY" format
        fromPeriod = convertToMonthYear(fromPeriod, true);
        toPeriod = convertToMonthYear(toPeriod, false);
        
        if (!fromPeriod || !toPeriod) {
            console.error('❌ BALANCECHANGE: both fromPeriod and toPeriod are required');
            throw new Error('MISSING_PERIOD');
        }
        
        console.log(`📊 BALANCECHANGE: ${account} from ${fromPeriod} to ${toPeriod}`);
        
        // Other parameters as strings
        subsidiary = String(subsidiary || '').trim();
        department = String(department || '').trim();
        location = String(location || '').trim();
        classId = String(classId || '').trim();
        accountingBook = String(accountingBook || '').trim();
        
        // Build cache key
        const cacheKey = JSON.stringify({
            type: 'balancechange',
            account, fromPeriod, toPeriod, 
            subsidiary, department, location, classId, accountingBook
        });
        
        // Check cache
        if (cache.balance.has(cacheKey)) {
            const cached = cache.balance.get(cacheKey);
            console.log(`✅ BALANCECHANGE cache hit: ${account} = ${cached}`);
            return cached;
        }
        
        // Make API call
        const apiParams = new URLSearchParams({
            account: account,
            from_period: fromPeriod,
            to_period: toPeriod,
            subsidiary: subsidiary,
            department: department,
            class: classId,
            location: location,
            book: accountingBook
        });
        
        const response = await fetch(`${SERVER_URL}/balance-change?${apiParams.toString()}`);
        
        if (!response.ok) {
            // Map HTTP status codes to user-friendly error codes
            // 408/504/522/523/524 = various timeout errors (including Cloudflare)
            // 429 = rate limited
            // 401/403 = auth errors
            const errorCode = [408, 504, 522, 523, 524].includes(response.status) ? 'TIMEOUT' :
                             response.status === 429 ? 'RATELIMIT' :
                             response.status === 401 || response.status === 403 ? 'AUTHERR' :
                             response.status >= 500 ? 'SERVERR' :
                             'APIERR';
            console.error(`❌ BALANCECHANGE API error: ${response.status} → ${errorCode}`);
            throw new Error(errorCode);
        }
        
        const data = await response.json();
        
        // Check for error in response
        if (data.error) {
            console.log(`⚠️ BALANCECHANGE: ${account} = ${data.error}`);
            throw new Error(data.error);
        }
        
        // Get the change value
        const change = data.change || 0;
        console.log(`✅ BALANCECHANGE: ${account} (${fromPeriod} → ${toPeriod}) = ${change.toLocaleString()}`);
        console.log(`   From: $${data.from_balance?.toLocaleString() || 0}, To: $${data.to_balance?.toLocaleString() || 0}`);
        
        // Cache the result
        cache.balance.set(cacheKey, change);
        
        return change;
        
    } catch (error) {
        console.error('BALANCECHANGE error:', error);
        // Re-throw if already an Error, otherwise wrap
        if (error instanceof Error) {
            throw error;
        }
        throw new Error('NETFAIL');
    }
}

// ============================================================================
// BUDGET - Get Budget Amount from NetSuite BudgetsMachine table
// ============================================================================
/**
 * @customfunction BUDGET
 * @param {any} account Account number
 * @param {any} fromPeriod Starting period (e.g., "Jan 2025" or 1/1/2025)
 * @param {any} toPeriod Ending period (e.g., "Mar 2025" or 3/1/2025)
 * @param {any} subsidiary Subsidiary filter (use "" for all)
 * @param {any} department Department filter (use "" for all)
 * @param {any} location Location filter (use "" for all)
 * @param {any} classId Class filter (use "" for all)
 * @param {any} accountingBook Accounting Book ID (use "" for Primary Book)
 * @param {any} budgetCategory Budget Category name or ID (e.g., "FY 2024 Budget")
 * @returns {Promise<number>} Budget amount for the specified period(s)
 * @requiresAddress
 */
async function BUDGET(account, fromPeriod, toPeriod, subsidiary, department, location, classId, accountingBook, budgetCategory) {
    try {
        // Normalize inputs
        account = normalizeAccountNumber(account);
        
        if (!account) {
            console.error('❌ BUDGET: account parameter is required');
            throw new Error('MISSING_ACCT');
        }
        
        // Convert date values to "Mon YYYY" format (supports both dates and period strings)
        // For year-only format ("2025"), expand to "Jan 2025" and "Dec 2025"
        fromPeriod = normalizePeriodKey(fromPeriod, true) || fromPeriod;   // true = isFromPeriod
        toPeriod = normalizePeriodKey(toPeriod, false) || toPeriod;      // false = isToPeriod
        
        // Other parameters as strings
        subsidiary = String(subsidiary || '').trim();
        department = String(department || '').trim();
        location = String(location || '').trim();
        classId = String(classId || '').trim();
        accountingBook = String(accountingBook || '').trim();
        budgetCategory = String(budgetCategory || '').trim();
        
        const params = { account, fromPeriod, toPeriod, subsidiary, department, location, classId, accountingBook, budgetCategory };
        const cacheKey = getCacheKey('budget', params);
        
        // Check cache FIRST
        if (cache.budget.has(cacheKey)) {
            cacheStats.hits++;
            return cache.budget.get(cacheKey);
        }
        
        // Cache miss - queue for batch processing
        cacheStats.misses++;
        
        // For single-period requests (fromPeriod === toPeriod), use batching
        // For date ranges, fall back to individual calls
        const isSinglePeriod = !toPeriod || fromPeriod === toPeriod;
        
        if (isSinglePeriod) {
            // Queue for batch processing
            return new Promise((resolve, reject) => {
                pendingRequests.budget.set(cacheKey, {
                    params,
                    resolve,
                    reject
                });
                
                // Reset/start batch timer
                if (budgetBatchTimer) {
                    clearTimeout(budgetBatchTimer);
                }
                budgetBatchTimer = setTimeout(processBudgetBatchQueue, BUDGET_BATCH_DELAY);
            });
        }
        
        // Fall back to individual request for date ranges
        try {
            const url = new URL(`${SERVER_URL}/budget`);
            url.searchParams.append('account', account);
            if (fromPeriod) url.searchParams.append('from_period', fromPeriod);
            if (toPeriod) url.searchParams.append('to_period', toPeriod);
            if (subsidiary) url.searchParams.append('subsidiary', subsidiary);
            if (department) url.searchParams.append('department', department);
            if (location) url.searchParams.append('location', location);
            if (classId) url.searchParams.append('class', classId);
            if (accountingBook) url.searchParams.append('accountingbook', accountingBook);
            if (budgetCategory) url.searchParams.append('budget_category', budgetCategory);
            
            const response = await fetch(url.toString());
            if (!response.ok) {
                const errorText = await response.text();
                console.error(`Budget API error: ${response.status}`, errorText);
                if (response.status === 524 || response.status === 522 || response.status === 504) {
                    throw new Error('TIMEOUT');
                }
                throw new Error('API_ERR');
            }
            
            const text = await response.text();
            const budget = parseFloat(text);
            const finalValue = isNaN(budget) ? 0 : budget;
            
            // Cache the result
            cache.budget.set(cacheKey, finalValue);
            
            return finalValue;
            
        } catch (error) {
            console.error('Budget fetch error:', error);
            if (error.name === 'TypeError' && error.message.includes('fetch')) {
                throw new Error('OFFLINE');
            }
            // Re-throw if already an Error, otherwise wrap
            if (error instanceof Error) {
                throw error;
            }
            throw new Error('ERROR');
        }
        
    } catch (error) {
        console.error('BUDGET error:', error);
        // Re-throw if already an Error, otherwise wrap
        if (error instanceof Error) {
            throw error;
        }
        throw new Error('ERROR');
    }
}

// ============================================================================
// BUDGET BATCH PROCESSOR - Collects budget requests and sends in one query
// ============================================================================
async function processBudgetBatchQueue() {
    budgetBatchTimer = null;  // Reset timer reference
    
    if (pendingRequests.budget.size === 0) {
        return;
    }
    
    const requestCount = pendingRequests.budget.size;
    console.log('========================================');
    console.log(`📊 BUDGET BATCH: Processing ${requestCount} requests`);
    console.log('========================================');
    
    // Extract requests and clear queue
    const requests = Array.from(pendingRequests.budget.entries());
    pendingRequests.budget.clear();
    
    // Group by filters (subsidiary, department, location, class, accountingBook, budgetCategory)
    // This allows us to batch requests with the same filters together
    const groups = new Map();
    
    for (const [cacheKey, request] of requests) {
        const { subsidiary, department, location, classId, accountingBook, budgetCategory } = request.params;
        const filterKey = `${subsidiary}|${department}|${location}|${classId}|${accountingBook}|${budgetCategory}`;
        
        if (!groups.has(filterKey)) {
            groups.set(filterKey, {
                filters: { subsidiary, department, location, classId, accountingBook, budgetCategory },
                accounts: new Set(),
                periods: new Set(),
                requests: []
            });
        }
        
        const group = groups.get(filterKey);
        group.accounts.add(request.params.account);
        
        // Handle year-only periods (e.g., "2024") by expanding to all 12 months
        const period = request.params.fromPeriod;
        if (period && /^\d{4}$/.test(period)) {
            const expanded = expandPeriodRangeFromTo(period, period);
            expanded.forEach(p => group.periods.add(p));
        } else if (period) {
            group.periods.add(period);
        }
        
        group.requests.push({ cacheKey, request });
    }
    
    console.log(`   Grouped into ${groups.size} filter combination(s)`);
    
    // Process each group with a batch API call
    for (const [filterKey, group] of groups) {
        const accounts = Array.from(group.accounts);
        const periods = Array.from(group.periods);
        const { filters, requests: groupRequests } = group;
        
        console.log(`   📤 Batch: ${accounts.length} accounts × ${periods.length} periods`);
        console.log(`      Filters: sub=${filters.subsidiary || 'all'}, cat=${filters.budgetCategory || 'all'}`);
        
        try {
            const response = await fetch(`${SERVER_URL}/batch/budget`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    accounts,
                    periods,
                    subsidiary: filters.subsidiary || '',
                    department: filters.department || '',
                    location: filters.location || '',
                    class: filters.classId || '',
                    accountingbook: filters.accountingBook || '',
                    budget_category: filters.budgetCategory || ''
                })
            });
            
            if (!response.ok) {
                const errorText = await response.text();
                console.error(`   ❌ Batch budget API error: ${response.status}`, errorText);
                
                // Resolve all with 0 on error (graceful degradation)
                for (const { cacheKey, request } of groupRequests) {
                    cache.budget.set(cacheKey, 0);
                    request.resolve(0);
                }
                continue;
            }
            
            const data = await response.json();
            const budgets = data.budgets || {};
            
            console.log(`   ✅ Received data in ${data.query_time?.toFixed(2) || '?'}s`);
            
            // Resolve promises and cache results
            for (const { cacheKey, request } of groupRequests) {
                const { account, fromPeriod } = request.params;
                let value = 0;
                
                // Handle year-only periods by summing all 12 months
                if (fromPeriod && /^\d{4}$/.test(fromPeriod)) {
                    const expanded = expandPeriodRangeFromTo(fromPeriod, fromPeriod);
                    for (const period of expanded) {
                        if (budgets[account] && budgets[account][period] !== undefined) {
                            value += budgets[account][period];
                        }
                    }
                } else if (budgets[account] && budgets[account][fromPeriod] !== undefined) {
                    value = budgets[account][fromPeriod];
                }
                
                cache.budget.set(cacheKey, value);
                request.resolve(value);
            }
            
        } catch (error) {
            console.error(`   ❌ Batch budget error:`, error);
            
            // Resolve all with 0 on error
            for (const { cacheKey, request } of groupRequests) {
                cache.budget.set(cacheKey, 0);
                request.resolve(0);
            }
        }
    }
    
    console.log('========================================');
}

// ============================================================================
// BATCH PROCESSING - Non-Streaming with Promise Resolution (Phase 3)
// ============================================================================
// ============================================================================
// FULL REFRESH PROCESSOR - ONE big query for ALL accounts
// ============================================================================
async function processFullRefresh() {
    console.log('');
    console.log('════════════════════════════════════════════════════════════════════');
    console.log('🚀 PROCESSING FULL REFRESH');
    console.log('════════════════════════════════════════════════════════════════════');
    
    const allRequests = Array.from(pendingRequests.balance.entries());
    
    if (allRequests.length === 0) {
        console.log('⚠️  No requests to process');
        window.exitFullRefreshMode();
        return;
    }
    
    // Extract year from requests (or use provided year)
    let year = fullRefreshYear;
    if (!year && allRequests.length > 0) {
        const firstPeriod = allRequests[0][1].params.fromPeriod;
        if (firstPeriod) {
            const match = firstPeriod.match(/\d{4}/);
            year = match ? parseInt(match[0]) : new Date().getFullYear();
        } else {
            year = new Date().getFullYear();
        }
    }
    
    // Get filters from first request (assume all same filters)
    const filters = {};
    if (allRequests.length > 0) {
        const firstRequest = allRequests[0][1];
        filters.subsidiary = firstRequest.params.subsidiary || '';
        filters.department = firstRequest.params.department || '';
        filters.location = firstRequest.params.location || '';
        filters.class = firstRequest.params.classId || '';
        filters.accountingbook = firstRequest.params.accountingBook || '';  // Multi-Book Accounting support
    }
    
    console.log(`📊 Full Refresh Request:`);
    console.log(`   Formulas: ${allRequests.length}`);
    console.log(`   Year: ${year}`);
    console.log(`   Filters:`, filters);
    console.log('');
    
    try {
        // Call optimized backend endpoint
        const payload = {
            year: year,
            ...filters
        };
        
        console.log('📤 Fetching ALL accounts for entire year...');
        const start = Date.now();
        
        const response = await fetch(`${SERVER_URL}/batch/full_year_refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        }
        
        const data = await response.json();
        const balances = data.balances || {};
        const queryTime = data.query_time || 0;
        const elapsed = ((Date.now() - start) / 1000).toFixed(2);
        
        console.log('');
        console.log(`✅ DATA RECEIVED`);
        console.log(`   Backend Query Time: ${queryTime.toFixed(2)}s`);
        console.log(`   Total Time: ${elapsed}s`);
        console.log(`   Accounts: ${Object.keys(balances).length}`);
        console.log('');
        
        // Populate cache with ALL results
        console.log('💾 Populating cache...');
        let cachedCount = 0;
        for (const account in balances) {
            for (const period in balances[account]) {
                // Create cache key for this account-period combination
                const cacheKey = getCacheKey('balance', {
                    account: account,
                    fromPeriod: period,
                    toPeriod: period,
                    ...filters
                });
                cache.balance.set(cacheKey, balances[account][period]);
                cachedCount++;
            }
        }
        console.log(`   Cached ${cachedCount} account-period combinations`);
        console.log('');
        
        // Resolve ALL pending requests from cache
        console.log('📝 Resolving formulas...');
        let resolvedCount = 0;
        let errorCount = 0;
        
        for (const [cacheKey, request] of allRequests) {
            try {
                const account = request.params.account;
                const fromPeriod = request.params.fromPeriod;
                const toPeriod = request.params.toPeriod;
                
                // Sum requested period range
                let total = 0;
                // Always use expandPeriodRangeFromTo - it handles:
                // - Year-only periods (e.g., "2024" → Jan-Dec 2024)
                // - Single month periods (returns same period)
                // - Date ranges (expands to all months)
                const periodRange = expandPeriodRangeFromTo(fromPeriod, toPeriod || fromPeriod);
                    for (const period of periodRange) {
                        if (balances[account] && balances[account][period] !== undefined) {
                            total += balances[account][period];
                    }
                }
                
                request.resolve(total);
                resolvedCount++;
                
            } catch (error) {
                console.error(`❌ Error resolving ${request.params.account}:`, error);
                request.reject(error);
                errorCount++;
            }
        }
        
        console.log(`   ✅ Resolved: ${resolvedCount} formulas`);
        if (errorCount > 0) {
            console.log(`   ❌ Errors: ${errorCount} formulas`);
        }
        console.log('');
        console.log('════════════════════════════════════════════════════════════════════');
        console.log(`✅ FULL REFRESH COMPLETE (${elapsed}s)`);
        console.log('════════════════════════════════════════════════════════════════════');
        console.log('');
        
        pendingRequests.balance.clear();
        
    } catch (error) {
        console.error('');
        console.error('════════════════════════════════════════════════════════════════════');
        console.error('❌ FULL REFRESH FAILED');
        console.error('════════════════════════════════════════════════════════════════════');
        console.error(error);
        console.error('');
        
        // Reject all pending requests
        for (const [cacheKey, request] of allRequests) {
            request.reject(error);
        }
        
        pendingRequests.balance.clear();
        
    } finally {
        window.exitFullRefreshMode();
    }
}

// Make it globally accessible for taskpane
window.processFullRefresh = processFullRefresh;

async function processBatchQueue() {
    const batchStartTime = Date.now();
    batchTimer = null;  // Reset timer reference
    
    console.log('========================================');
    console.log(`🔄 processBatchQueue() CALLED at ${new Date().toLocaleTimeString()}`);
    console.log('========================================');
    
    // CHECK: If build mode was entered, defer to it instead
    // This handles the race condition where timer fires just as build mode starts
    if (buildMode) {
        console.log('⏸️ Build mode is active - deferring to build mode batch');
        // Move any pending requests to build mode queue
        for (const [cacheKey, request] of pendingRequests.balance.entries()) {
            buildModePending.push({
                cacheKey,
                params: request.params,
                resolve: request.resolve,
                reject: request.reject
            });
        }
        if (pendingRequests.balance.size > 0) {
            console.log(`   📦 Moved ${pendingRequests.balance.size} requests to build mode`);
            pendingRequests.balance.clear();
        }
        return; // Let build mode handle everything
    }
    
    if (pendingRequests.balance.size === 0) {
        console.log('❌ No balance requests in queue - exiting');
        return;
    }
    
    const requestCount = pendingRequests.balance.size;
    console.log(`✅ Found ${requestCount} pending requests`);
    console.log(`📊 Cache stats: ${cacheStats.hits} hits / ${cacheStats.misses} misses`);
    
    // Extract requests and clear queue
    const requests = Array.from(pendingRequests.balance.entries());
    pendingRequests.balance.clear();
    
    console.log(`🔍 DEBUG: Extracted ${requests.length} requests from queue`);
    
    // ================================================================
    // CRITICAL: ACCOUNT TYPE GATE - Hard execution split
    // Income Statement requests (marked with accountType: 'income_statement')
    // MUST be routed to regularRequests immediately - skip all BS logic
    // ================================================================
    const incomeStatementRequests = [];
    const balanceSheetRequests = [];
    
    // DEBUG: Check first few requests to verify accountType is preserved
    let debugCount = 0;
    for (const [cacheKey, request] of requests) {
        // Check if request is marked as Income Statement (from early gate in BALANCE function)
        if (debugCount < 5) {
            console.log(`   🔍 Request ${debugCount}: accountType=${request.accountType || '(undefined)'}, account=${request.params?.account || 'N/A'}`);
            debugCount++;
        }
        
        if (request.accountType === 'income_statement') {
            // Income Statement request - route immediately to regularRequests
            // SKIP: grid detection, anchor inference, BS batching logic
            incomeStatementRequests.push([cacheKey, request]);
        } else {
            // Balance Sheet request (or unknown) - route to BS processing
            balanceSheetRequests.push([cacheKey, request]);
        }
    }
    
    // ================================================================
    // INCOME STATEMENT REQUESTS: Route directly to regularRequests
    // No BS logic, no grid detection, no anchor inference
    // ================================================================
    const regularRequests = [];
    for (const [cacheKey, request] of incomeStatementRequests) {
        regularRequests.push([cacheKey, request]);
    }
    
    console.log(`📊 Routing summary: ${incomeStatementRequests.length} Income Statement, ${balanceSheetRequests.length} Balance Sheet`);
    console.log(`   → ${regularRequests.length} Income Statement requests routed to regularRequests`);
    console.error(`🔍🔍🔍 CRITICAL DEBUG: About to process BS requests. cumulativeRequests will be built from ${balanceSheetRequests.length} BS requests`);
    
    // ================================================================
    // BALANCE SHEET REQUESTS: Route by parameter shape
    // 1. CUMULATIVE BS QUERIES: empty fromPeriod with toPeriod → direct /balance API calls
    // 2. PERIOD ACTIVITY QUERIES: both fromPeriod and toPeriod → BS grid batching (if pattern detected)
    // 3. OTHER: fallback to regularRequests
    // ================================================================
    const cumulativeRequests = [];
    const periodActivityRequests = [];  // BS period activity queries (for grid batching)
    
    for (const [cacheKey, request] of balanceSheetRequests) {
        const { fromPeriod, toPeriod } = request.params;
        const isCumulative = (!fromPeriod || fromPeriod === '') && toPeriod && toPeriod !== '';
        const isPeriodActivity = fromPeriod && toPeriod && fromPeriod !== toPeriod;
        
        if (isCumulative) {
            // Cumulative = empty fromPeriod with a toPeriod
            cumulativeRequests.push([cacheKey, request]);
        } else if (isPeriodActivity) {
            // Period activity query (both fromPeriod and toPeriod)
            // BS accounts only - can use grid batching
            periodActivityRequests.push([cacheKey, request]);
        } else {
            // Other BS requests - use regular batch endpoint
            regularRequests.push([cacheKey, request]);
        }
    }
    
    // ================================================================
    // CUMULATIVE BS QUERIES: Check for grid batching BEFORE individual processing
    // CRITICAL: This is the most common CPA workflow (BALANCE(account, , toPeriod))
    // Grid batching can dramatically improve performance for large grids
    // ================================================================
    console.error(`🔍🔍🔍 CRITICAL DEBUG: Checking cumulativeRequests.length: ${cumulativeRequests.length}`);
    if (cumulativeRequests.length > 0) {
        // Step 1: Attempt BS Grid Batching (conservative - only if pattern detected)
        // CRITICAL: Safety limits are enforced INSIDE detectBsGridPattern() before:
        // - Anchor computation (inferAnchorDate)
        // - Batch query construction
        // - Any NetSuite API calls
        const cumulativeGridInfo = detectBsGridPattern(cumulativeRequests);
        
        if (cumulativeGridInfo && cumulativeGridInfo.queryType === 'cumulative' && 
            cumulativeGridInfo.accounts.size >= 2 && cumulativeGridInfo.periods.size >= 2) {
            // Potential grid detected - verify accounts are BS accounts
            console.log(`🔍 BS Grid pattern detected (CUMULATIVE): ${cumulativeGridInfo.accounts.size} accounts × ${cumulativeGridInfo.periods.size} periods`);
            console.log(`   Accounts: ${Array.from(cumulativeGridInfo.accounts).slice(0, 5).join(', ')}${cumulativeGridInfo.accounts.size > 5 ? '...' : ''}`);
            console.log(`   Periods: ${Array.from(cumulativeGridInfo.periods).slice(0, 5).join(', ')}${cumulativeGridInfo.periods.size > 5 ? '...' : ''}`);
            
            // Verify accounts are BS accounts (sample check - if any fail, fall back)
            let allBsAccounts = true;
            
            // Sample check: verify first few accounts are BS (conservative)
            const sampleAccounts = Array.from(cumulativeGridInfo.accounts).slice(0, Math.min(10, cumulativeGridInfo.accounts.size));
            for (const account of sampleAccounts) {
                try {
                    const accountTypeData = await getAccountType(account);
                    // Handle both string and object responses (backend may return object with type property)
                    const accountType = typeof accountTypeData === 'string' ? accountTypeData : 
                                      (accountTypeData && typeof accountTypeData === 'object' ? accountTypeData.type : accountTypeData);
                    
                    if (!accountType || !isBalanceSheetType(accountType)) {
                        console.log(`   ⚠️ Account ${account} is not BS (type: ${accountType}) - falling back to individual processing`);
                        allBsAccounts = false;
                        break;
                    }
                } catch (error) {
                    console.warn(`   ⚠️ Could not verify account type for ${account} - falling back to individual processing`);
                    allBsAccounts = false;
                    break;
                }
            }
            
            if (allBsAccounts) {
                // All sampled accounts are BS - proceed with grid batching
                console.log(`✅ BS Grid confirmed (CUMULATIVE) - using batched endpoints`);
                
                try {
                    // Use the same grid batching logic as period activity queries
                    // (will be handled in the period activity section below)
                    // For now, mark these as processed and add to periodActivityRequests for unified handling
                    // Actually, we need separate handling - let's process cumulative grids here
                    await processBsGridBatching(cumulativeGridInfo, cumulativeRequests);
                    // Mark as processed
                    cumulativeRequests.length = 0;
                } catch (error) {
                    console.error(`   ❌ BS Grid batching (cumulative) error: ${error.message}`);
                    console.log(`   ⚠️ Falling back to individual processing...`);
                    // Continue to individual processing below
                }
            }
        }
        
        // Step 2: Process remaining cumulative requests individually (fallback or non-grid)
        if (cumulativeRequests.length > 0) {
            console.log(`📊 Processing ${cumulativeRequests.length} CUMULATIVE (BS) requests separately...`);
            
            let cacheHits = 0;
            let apiCalls = 0;
            let deduplicated = 0;
            let slowQueryCount = 0;
            let totalApiTime = 0;
            const bsPeriodsInBatch = new Set(); // Track unique periods for smart suggestion
            
            // ================================================================
            // DEDUPLICATION: Group identical requests by cache key
            // INVARIANT: Identical formulas must collapse into a single API call
            // ================================================================
            const uniqueRequests = new Map(); // cacheKey -> { params, requests: [] }
            for (const [cacheKey, request] of cumulativeRequests) {
                // Track periods seen for smart multi-period suggestion
                if (request.params.toPeriod) {
                    bsPeriodsInBatch.add(request.params.toPeriod);
                    trackBSPeriod(request.params.toPeriod);
                }
                
                if (!uniqueRequests.has(cacheKey)) {
                    uniqueRequests.set(cacheKey, { params: request.params, requests: [request] });
                } else {
                    uniqueRequests.get(cacheKey).requests.push(request);
                    deduplicated++;
                }
            }
            
            if (deduplicated > 0) {
                console.log(`   🔄 DEDUPLICATED: ${cumulativeRequests.length} requests → ${uniqueRequests.size} unique (saved ${deduplicated} API calls)`);
            }
            
            // ================================================================
            // BS BUILD WARNING: Warn user if multiple BS formulas detected
            // This helps them understand why things are slow and offers preload
            // ================================================================
            const uniqueBSCount = uniqueRequests.size;
            if (uniqueBSCount >= BS_MULTI_FORMULA_THRESHOLD && !bsBuildModeWarningShown) {
                const bsAccounts = new Set();
                for (const [_, data] of uniqueRequests) {
                    bsAccounts.add(data.params.account);
                }
                showBSBuildModeWarning(uniqueBSCount, Array.from(bsPeriodsInBatch));
                console.log(`   ⚠️ BS BUILD WARNING: ${uniqueBSCount} unique BS formulas, ${bsAccounts.size} accounts, ${bsPeriodsInBatch.size} periods`);
            }
            
            // Log multi-period detection
            if (bsPeriodsInBatch.size > 1) {
                console.log(`   📅 MULTI-PERIOD DETECTED: ${Array.from(bsPeriodsInBatch).join(', ')} - consider preloading both!`);
            }
            
            // Rate limiting to avoid NetSuite 429 CONCURRENCY_LIMIT_EXCEEDED errors
            const RATE_LIMIT_DELAY_BATCH = 150; // ms between API calls
            const rateLimitSleepBatch = (ms) => new Promise(resolve => setTimeout(resolve, ms));
            
            // Process each UNIQUE cumulative request once
            for (const [cacheKey, { params, requests }] of uniqueRequests) {
                const { account, fromPeriod, toPeriod, subsidiary, department, location, classId, accountingBook, currency } = params;
                
                // Get endpoint from first request (all requests in group should have same endpoint)
                const endpoint = requests[0]?.endpoint || '/balance';
                const isBalanceCurrency = endpoint === '/balancecurrency';
                
                // ================================================================
                // CHECK LOCALSTORAGE PRELOAD CACHE FIRST (Issue 2B Fix)
                // CRITICAL: Check preload cache before making API calls
                // This ensures batch mode uses preloaded data instead of making redundant API calls
                // ================================================================
                if (!subsidiary) {  // Skip for subsidiary-filtered queries (localStorage not subsidiary-aware)
                    const localStorageValue = checkLocalStorageCache(account, fromPeriod, toPeriod, subsidiary);
                    if (localStorageValue !== null) {
                        console.log(`   ✅ Preload cache hit (batch mode): ${account} for ${fromPeriod || '(cumulative)'} → ${toPeriod} = ${localStorageValue}`);
                        cache.balance.set(cacheKey, localStorageValue);
                        // Resolve ALL requests waiting for this result
                        requests.forEach(r => r.resolve(localStorageValue));
                        cacheHits++;
                        continue; // Skip API call
                    }
                }
                
                // ================================================================
                // TRY WILDCARD CACHE RESOLUTION
                // If account has *, try to sum matching accounts from cache
                // CRITICAL: Skip for BALANCECURRENCY - wildcard cache doesn't support currency
                // ================================================================
                if (account.includes('*') && !isBalanceCurrency) {
                    const wildcardResult = resolveWildcardFromCache(account, fromPeriod, toPeriod, subsidiary);
                    if (wildcardResult !== null) {
                        console.log(`   🎯 Wildcard cache hit: ${account} = ${wildcardResult.total.toLocaleString()} (${wildcardResult.matchCount} accounts)`);
                        cache.balance.set(cacheKey, wildcardResult.total);
                        // Resolve ALL requests waiting for this result
                        requests.forEach(r => r.resolve(wildcardResult.total));
                        cacheHits++;
                        continue; // Skip API call
                    }
                }
                
                // ================================================================
                // CACHE MISS - Call API (ONCE for all identical requests)
                // For wildcards, request breakdown so we can cache individual accounts
                // ================================================================
                try {
                    const isWildcard = account.includes('*');
                    const apiParams = new URLSearchParams({
                        account: account,
                        from_period: '',  // Empty = cumulative from inception
                        to_period: toPeriod,
                        subsidiary: subsidiary || '',
                        department: department || '',
                        location: location || '',
                        class: classId || '',
                        accountingbook: accountingBook || ''
                    });
                    
                    // Add currency parameter for BALANCECURRENCY
                    if (isBalanceCurrency) {
                        if (currency) {
                            apiParams.append('currency', currency);
                            console.log(`   💱 BALANCECURRENCY: Adding currency parameter to API: "${currency}"`);
                        } else {
                            console.warn(`   ⚠️ BALANCECURRENCY: Currency parameter is missing or empty! This may cause incorrect results.`);
                            console.warn(`      Params object:`, JSON.stringify(params, null, 2));
                        }
                    }
                    
                    // Request breakdown for wildcards so we can cache individual accounts
                    if (isWildcard) {
                        apiParams.append('include_breakdown', 'true');
                    }
                    
                    const waitingCount = requests.length > 1 ? ` (${requests.length} formulas waiting)` : '';
                    const currencyInfo = isBalanceCurrency && currency ? ` (currency: ${currency})` : '';
                    console.log(`   📤 Cumulative API: ${account} through ${toPeriod}${isWildcard ? ' (with breakdown)' : ''}${currencyInfo}${waitingCount}`);
                    
                    // Rate limit: wait before making request if we've already made calls
                    // Prevents NetSuite 429 CONCURRENCY_LIMIT_EXCEEDED errors
                    if (apiCalls > 0) {
                        await rateLimitSleepBatch(RATE_LIMIT_DELAY_BATCH);
                    }
                    apiCalls++;
                    
                    // Track query timing for slow query detection
                    const queryStartTime = Date.now();
                    const response = await fetch(`${SERVER_URL}${endpoint}?${apiParams.toString()}`);
                    
                    if (response.ok) {
                        const contentType = response.headers.get('content-type') || '';
                        
                        if (isWildcard && contentType.includes('application/json')) {
                            // Parse JSON response with breakdown
                            const data = await response.json();
                            const total = data.total || 0;
                            const accounts = data.accounts || {};
                            const period = data.period || toPeriod;
                            
                            console.log(`   ✅ Wildcard result: ${account} = ${total.toLocaleString()} (${Object.keys(accounts).length} accounts)`);
                            
                            // Cache the total for this wildcard pattern
                            cache.balance.set(cacheKey, total);
                            
                            // CRITICAL: Cache individual accounts for future wildcard resolution!
                            cacheIndividualAccounts(accounts, period, subsidiary);
                            
                            // Resolve ALL requests waiting for this result
                            requests.forEach(r => r.resolve(total));
                        } else {
                            // Parse JSON response for balance and error
                            let value = 0;
                            let errorCode = null;
                            
                            try {
                                const data = await response.json();
                                // DEBUG: Log raw response to catch parsing issues
                                console.log(`   📋 Raw JSON response:`, JSON.stringify(data).substring(0, 200));
                                
                                // Handle balance - could be number or null
                                if (typeof data.balance === 'number') {
                                    value = data.balance;
                                } else if (data.balance !== null && data.balance !== undefined) {
                                    value = parseFloat(data.balance) || 0;
                                }
                                errorCode = data.error || null;
                                
                                // CRITICAL: For BALANCECURRENCY, if balance is null and no explicit error code,
                                // check if currency was requested. If so, this likely means BUILTIN.CONSOLIDATE
                                // returned NULL for all transactions (invalid currency conversion path).
                                // Return INV_SUB_CUR instead of 0 to prevent misleading data.
                                if (isBalanceCurrency && data.balance === null && !errorCode && currency) {
                                    console.warn(`   ⚠️ BALANCECURRENCY: Balance is null for currency ${currency} - likely invalid conversion path`);
                                    errorCode = 'INV_SUB_CUR';
                                }
                            } catch (parseError) {
                                // JSON parsing failed
                                console.error(`   ❌ JSON parse failed: ${parseError.message}`);
                                value = 0;
                            }
                            
                            // Track query time for slow query detection
                            const queryTimeMs = Date.now() - queryStartTime;
                            totalApiTime += queryTimeMs;
                            if (queryTimeMs > BS_SLOW_THRESHOLD_MS) {
                                slowQueryCount++;
                                console.log(`   ⏱️ SLOW BS QUERY: ${account} took ${(queryTimeMs / 1000).toFixed(1)}s`);
                            }
                            
                            if (errorCode) {
                                // Reject with error code - Excel will display #ERROR!
                                // CRITICAL: Do NOT cache error codes - they should be re-evaluated
                                console.log(`   ⚠️ Cumulative result: ${account} = ${errorCode}`);
                                requests.forEach(r => r.reject(new Error(errorCode)));
                            } else {
                                console.log(`   ✅ Cumulative result: ${account} = ${value.toLocaleString()} (${(queryTimeMs / 1000).toFixed(1)}s)`);
                                // Only cache valid numeric values, not errors or null
                                cache.balance.set(cacheKey, value);
                                // Resolve ALL requests waiting for this result
                                requests.forEach(r => r.resolve(value));
                            }
                        }
                    } else {
                        // HTTP error - reject with informative error code
                        // 522/523/524 are Cloudflare timeout errors
                        const errorCode = [408, 504, 522, 523, 524].includes(response.status) ? 'TIMEOUT' :
                                         response.status === 429 ? 'RATELIMIT' :
                                         response.status === 401 || response.status === 403 ? 'AUTHERR' :
                                         response.status >= 500 ? 'SERVERR' :
                                         'APIERR';
                        console.error(`   ❌ Cumulative API error: ${response.status} → ${errorCode}`);
                        requests.forEach(r => r.reject(new Error(errorCode)));
                    }
                } catch (error) {
                    // Network error - reject with informative error code
                    const errorCode = error.name === 'AbortError' ? 'TIMEOUT' : 'NETFAIL';
                    console.error(`   ❌ Cumulative fetch error: ${error.message} → ${errorCode}`);
                    requests.forEach(r => r.reject(new Error(errorCode)));
                }
            }
            
            // ================================================================
            // AUTO-SUGGEST BS PRELOAD after slow queries
            // If we had slow BS queries and more than 1 period, suggest preload
            // ================================================================
            if (slowQueryCount > 0 && apiCalls > 0) {
                console.log(`   ⏱️ SLOW QUERY SUMMARY: ${slowQueryCount}/${apiCalls} queries were slow (>${BS_SLOW_THRESHOLD_MS/1000}s)`);
                
                // Get all BS periods seen (both in this batch and historically)
                const allSeenPeriods = getSeenBSPeriods();
                const periodsToSuggest = allSeenPeriods.length > 0 ? allSeenPeriods : Array.from(bsPeriodsInBatch);
                
                // Only suggest if we haven't suggested recently
                suggestBSPreload(periodsToSuggest, totalApiTime);
            }
            
            if (cacheHits > 0 || apiCalls > 0 || deduplicated > 0) {
                console.log(`   📊 Cumulative summary: ${cacheHits} cache hits, ${apiCalls} API calls, ${deduplicated} deduplicated`);
            }
        }
    }
    
    console.error(`🔍🔍🔍 CRITICAL DEBUG: After cumulativeRequests block. About to check periodActivityRequests.`);
    
    // ================================================================
    // PERIOD ACTIVITY QUERIES: Handle separately (both fromPeriod and toPeriod)
    // CRITICAL: Check for BS Grid Batching pattern BEFORE individual processing
    // Only applies to Balance Sheet accounts with both fromDate and toDate
    // 
    // SAFETY LIMITS: Enforced in detectBsGridPattern() BEFORE any NetSuite work:
    // - Max accounts: 200 (BS_GRID_MAX_ACCOUNTS)
    // - Max periods: 36 (BS_GRID_MAX_PERIODS)
    // If limits exceeded, detectBsGridPattern() returns null → falls back to individual processing
    // ================================================================
    console.error(`🔍🔍🔍 CRITICAL DEBUG: Checking periodActivityRequests.length: ${periodActivityRequests.length}`);
    if (periodActivityRequests.length > 0) {
        // Step 1: Attempt BS Grid Batching (conservative - only if pattern detected)
        // CRITICAL: Safety limits are enforced INSIDE detectBsGridPattern() before:
        // - Anchor computation (inferAnchorDate)
        // - Batch query construction
        // - Any NetSuite API calls
        const gridInfo = detectBsGridPattern(periodActivityRequests);
        
        if (gridInfo && gridInfo.accounts.size >= 2 && gridInfo.periods.size >= 2) {
            // Potential grid detected - verify accounts are BS accounts
            console.log(`🔍 BS Grid pattern detected: ${gridInfo.accounts.size} accounts × ${gridInfo.periods.size} periods`);
            console.log(`   Accounts: ${Array.from(gridInfo.accounts).slice(0, 5).join(', ')}${gridInfo.accounts.size > 5 ? '...' : ''}`);
            console.log(`   Periods: ${Array.from(gridInfo.periods).slice(0, 5).join(', ')}${gridInfo.periods.size > 5 ? '...' : ''}`);
            
            // Verify accounts are BS accounts (sample check - if any fail, fall back)
            let allBsAccounts = true;
            
            // Sample check: verify first few accounts are BS (conservative)
            const sampleAccounts = Array.from(gridInfo.accounts).slice(0, Math.min(10, gridInfo.accounts.size));
            for (const account of sampleAccounts) {
                try {
                    const accountTypeData = await getAccountType(account);
                    // Handle both string and object responses (backend may return object with type property)
                    const accountType = typeof accountTypeData === 'string' ? accountTypeData : 
                                      (accountTypeData && typeof accountTypeData === 'object' ? accountTypeData.type : accountTypeData);
                    
                    if (!accountType || !isBalanceSheetType(accountType)) {
                        console.log(`   ⚠️ Account ${account} is not BS (type: ${accountType}) - falling back to individual processing`);
                        allBsAccounts = false;
                        break;
                    }
                } catch (error) {
                    console.warn(`   ⚠️ Could not verify account type for ${account} - falling back to individual processing`);
                    allBsAccounts = false;
                    break;
                }
            }
            
            if (allBsAccounts) {
                // All sampled accounts are BS - proceed with grid batching
                console.log(`✅ BS Grid confirmed (PERIOD ACTIVITY) - using batched endpoints`);
                
                try {
                    // Use unified grid batching function
                    await processBsGridBatching(gridInfo, periodActivityRequests);
                    // Mark as processed
                    periodActivityRequests.length = 0;
                } catch (error) {
                    console.error(`   ❌ BS Grid batching (period activity) error: ${error.message}`);
                    console.log(`   ⚠️ Falling back to individual processing...`);
                    // Continue to individual processing below
                }
            }
        }
        
        // Step 2: Process remaining period activity requests individually (fallback or non-grid)
        if (periodActivityRequests.length > 0) {
            console.log(`📊 Processing ${periodActivityRequests.length} PERIOD ACTIVITY requests separately...`);
            
            let activityCacheHits = 0;
            let activityApiCalls = 0;
            
            // Process each period activity request individually
            for (const [cacheKey, request] of periodActivityRequests) {
                const { account, fromPeriod, toPeriod, subsidiary, department, location, classId, accountingBook } = request.params;
                
                // Check in-memory cache first
                if (cache.balance.has(cacheKey)) {
                    const cachedValue = cache.balance.get(cacheKey);
                    console.log(`   ✅ Period activity cache hit: ${account} (${fromPeriod} → ${toPeriod}) = ${cachedValue}`);
                    cache.balance.set(cacheKey, cachedValue);
                    request.resolve(cachedValue);
                    activityCacheHits++;
                    continue;
                }
                
                // Cache miss - make individual API call
                try {
                    const apiParams = new URLSearchParams({
                        account: account,
                        from_period: fromPeriod,
                        to_period: toPeriod,
                        subsidiary: subsidiary || '',
                        department: department || '',
                        location: location || '',
                        class: classId || '',
                        accountingbook: accountingBook || ''
                    });
                    
                    console.log(`   📤 Period activity API: ${account} (${fromPeriod} → ${toPeriod})`);
                    activityApiCalls++;
                    
                    const response = await fetch(`${SERVER_URL}/balance?${apiParams.toString()}`);
                    
                    if (response.ok) {
                        const data = await response.json();
                        const value = data.balance ?? 0;
                        const errorCode = data.error;
                        
                        if (errorCode) {
                            console.log(`   ⚠️ Period activity result: ${account} = ${errorCode}`);
                            request.reject(new Error(errorCode));
                        } else {
                            console.log(`   ✅ Period activity result: ${account} = ${value.toLocaleString()}`);
                            cache.balance.set(cacheKey, value);
                            request.resolve(value);
                        }
                    } else {
                        const errorCode = response.status === 408 || response.status === 504 ? 'TIMEOUT' : 'APIERR';
                        console.error(`   ❌ Period activity API error: ${response.status} → ${errorCode}`);
                        request.reject(new Error(errorCode));
                    }
                } catch (error) {
                    const errorCode = error.name === 'AbortError' ? 'TIMEOUT' : 'NETFAIL';
                    console.error(`   ❌ Period activity fetch error: ${error.message} → ${errorCode}`);
                    request.reject(new Error(errorCode));
                }
            }
            
            if (activityCacheHits > 0 || activityApiCalls > 0) {
                console.log(`   📊 Period activity summary: ${activityCacheHits} cache hits, ${activityApiCalls} API calls`);
            }
        }
    }
    
    console.error(`🔍🔍🔍 CRITICAL DEBUG: After periodActivityRequests block. About to start regularRequests processing.`);
    console.error(`🔍🔍🔍 CRITICAL DEBUG: regularRequests.length=${regularRequests.length}, cumulativeRequests.length=${cumulativeRequests.length}, periodActivityRequests.length=${periodActivityRequests.length}`);
    
    // ================================================================
    // CHECK LOCALSTORAGE PRELOAD CACHE FOR EACH REGULAR REQUEST (Issue 2B Fix)
    // CRITICAL: Check preload cache before batching - filter out cache hits
    // This ensures batch mode uses preloaded data instead of making redundant API calls
    // ================================================================
    console.error(`🔍🔍🔍 CRITICAL DEBUG: About to process regularRequests. Length: ${regularRequests.length}, cumulativeRequests: ${cumulativeRequests.length}, periodActivityRequests: ${periodActivityRequests.length}`);
    console.log(`📦 Processing regularRequests: ${regularRequests.length} requests (Income Statement + other BS)`);
    
    const regularRequestsToProcess = [];
    let regularCacheHits = 0;
    
    for (const [cacheKey, request] of regularRequests) {
        const { account, fromPeriod, toPeriod, subsidiary } = request.params;
        
        // CRITICAL: Do NOT use checkLocalStorageCache for period activity queries (regularRequests)
        // checkLocalStorageCache only looks up cumulative balances (single period), not period activity
        // Period activity queries must use in-memory cache (with proper cache key) or go to API
        // Only check in-memory cache for period activity queries
        if (cache.balance.has(cacheKey)) {
            const cachedValue = cache.balance.get(cacheKey);
            console.log(`   ✅ Period activity cache hit (regular batch): ${account} (${fromPeriod} → ${toPeriod}) = ${cachedValue}`);
            cache.balance.set(cacheKey, cachedValue);
            request.resolve(cachedValue);
            regularCacheHits++;
            continue; // Skip this request - already resolved from cache
        }
        
        // Cache miss - add to batch processing
        regularRequestsToProcess.push([cacheKey, request]);
    }
    
    if (regularCacheHits > 0) {
        console.log(`   📊 Regular requests: ${regularCacheHits} cache hits, ${regularRequestsToProcess.length} need API calls`);
    }
    
    // Continue with regular batch processing for period-based requests
    if (regularRequestsToProcess.length === 0) {
        const elapsed = ((Date.now() - batchStartTime) / 1000).toFixed(2);
        console.log(`\n✅ BATCH COMPLETE in ${elapsed}s (all requests resolved from cache)`);
        return;
    }
    
    console.log(`📦 Processing ${regularRequestsToProcess.length} regular (period-based) requests...`);
    
    // Group by filters AND currency (not periods) - this allows smart batching
    // CRITICAL: Must group by currency for BALANCECURRENCY requests to prevent mixing currencies
    // Example: 1 account × 12 months = 1 batch (not 12 batches)
    // Example: 100 accounts × 1 month = 2 batches (chunked by accounts)
    // Example: 100 accounts × 12 months = 2 batches (all periods together)
    const groups = new Map();
    for (const [cacheKey, request] of regularRequestsToProcess) {
        const {params} = request;
        // Check if this is a BALANCECURRENCY request
        const isBalanceCurrency = cacheKey.includes('"type":"balancecurrency"');
        const currency = params.currency || '';
        
        const filterKey = JSON.stringify({
            subsidiary: params.subsidiary || '',
            department: params.department || '',
            location: params.location || '',
            class: params.classId || '',
            // CRITICAL: Include currency in grouping key for BALANCECURRENCY requests
            // This ensures requests with different currencies are batched separately
            currency: isBalanceCurrency ? currency : ''
            // Note: NOT grouping by periods - this is the key optimization!
        });
        
        if (!groups.has(filterKey)) {
            groups.set(filterKey, []);
        }
        groups.get(filterKey).push({ cacheKey, request });
    }
    
    console.log(`📦 Grouped into ${groups.size} batch(es) by filters only`);
    
    // Process each group
    for (const [filterKey, groupRequests] of groups.entries()) {
        const filters = JSON.parse(filterKey);
        const accounts = [...new Set(groupRequests.map(r => r.request.params.account))];
        
        // Check if this group contains BALANCECURRENCY requests
        // CRITICAL: BALANCECURRENCY requests cannot use /batch/balance (doesn't support currency)
        // We need to process them individually using /balancecurrency endpoint
        // Check cache key first (most reliable), then endpoint, then params.currency
        const isBalanceCurrency = groupRequests.some(r => {
            // Method 1: Check cache key (most reliable - always set for BALANCECURRENCY)
            if (r.cacheKey && r.cacheKey.includes('"type":"balancecurrency"')) {
                return true;
            }
            // Method 2: Check endpoint property
            if (r.request && r.request.endpoint === '/balancecurrency') {
                return true;
            }
            // Method 3: Check params.currency (may be empty string, so check for property existence)
            if (r.request && r.request.params && 'currency' in r.request.params) {
                return true;
            }
            return false;
        });
        const currency = filters.currency || '';
        
        // Debug logging to understand detection
        if (groupRequests.length > 0) {
            const firstRequest = groupRequests[0];
            console.log(`   🔍 BALANCECURRENCY detection check:`, {
                cacheKey: firstRequest.cacheKey ? firstRequest.cacheKey.includes('"type":"balancecurrency"') : 'N/A',
                endpoint: firstRequest.request?.endpoint,
                hasCurrencyParam: firstRequest.request?.params && 'currency' in firstRequest.request.params,
                currencyValue: firstRequest.request?.params?.currency,
                isBalanceCurrency: isBalanceCurrency
            });
        }
        
        if (isBalanceCurrency) {
            console.log(`   💱 BALANCECURRENCY group detected with currency: "${currency || '(empty)'}"`);
            console.log(`   ⚠️ BALANCECURRENCY requests must use individual /balancecurrency calls (batch endpoint doesn't support currency)`);
            
            // Process BALANCECURRENCY requests individually
            // Group by currency to batch requests with same currency together
            const currencyGroups = new Map();
            for (const {cacheKey, request} of groupRequests) {
                const reqCurrency = request.params.currency || '';
                if (!currencyGroups.has(reqCurrency)) {
                    currencyGroups.set(reqCurrency, []);
                }
                currencyGroups.get(reqCurrency).push({ cacheKey, request });
            }
            
            // Process each currency group
            for (const [reqCurrency, currencyGroupRequests] of currencyGroups.entries()) {
                console.log(`   💱 Processing ${currencyGroupRequests.length} BALANCECURRENCY requests with currency: "${reqCurrency || '(empty)'}"`);
                
                // Process each request individually (can't batch with currency)
                // CRITICAL: For period ranges, expand periods and sum them (like regular batch processing)
                for (const {cacheKey, request} of currencyGroupRequests) {
                    const { account, fromPeriod, toPeriod, subsidiary, department, location, classId, accountingBook } = request.params;
                    const reqCurrency = request.params.currency || '';
                    
                    // ================================================================
                    // CHECK CACHE FIRST (Issue 2B Fix)
                    // CRITICAL: For period activity queries, do NOT use checkLocalStorageCache
                    // It only looks up cumulative balances, not period activity
                    // Only check in-memory cache for period activity queries
                    // ================================================================
                    // Check in-memory cache first (works for both cumulative and period activity)
                    if (cache.balance.has(cacheKey)) {
                        const cachedValue = cache.balance.get(cacheKey);
                        console.log(`   ✅ Cache hit (BALANCECURRENCY batch): ${account} (${fromPeriod || '(cumulative)'} → ${toPeriod}) = ${cachedValue}`);
                        cache.balance.set(cacheKey, cachedValue);
                        request.resolve(cachedValue);
                        continue; // Skip API call
                    }
                    // For cumulative queries only, also check localStorage (skip for subsidiary/currency-filtered or period activity)
                    if (!subsidiary && !reqCurrency && (!fromPeriod || fromPeriod === '')) {
                        const localStorageValue = checkLocalStorageCache(account, fromPeriod, toPeriod, subsidiary);
                        if (localStorageValue !== null) {
                            console.log(`   ✅ Preload cache hit (BALANCECURRENCY batch): ${account} for ${fromPeriod || '(cumulative)'} → ${toPeriod} = ${localStorageValue}`);
                            cache.balance.set(cacheKey, localStorageValue);
                            request.resolve(localStorageValue);
                            continue; // Skip API call
                        }
                    }
                    
                    // CRITICAL: Periods are already converted to "Mon YYYY" format in BALANCECURRENCY function
                    // But we need to ensure they're strings for comparison (not date serial numbers)
                    const fromPeriodStr = String(fromPeriod || '').trim();
                    const toPeriodStr = String(toPeriod || '').trim();
                    
                    // Check if this is a period range (fromPeriod != toPeriod and both are provided)
                    // Both must be non-empty and different
                    const isPeriodRange = fromPeriodStr && toPeriodStr && fromPeriodStr !== toPeriodStr;
                    
                    // Debug logging for period range detection
                    console.log(`   🔍 BALANCECURRENCY period check: fromPeriod="${fromPeriodStr}", toPeriod="${toPeriodStr}", isPeriodRange=${isPeriodRange}`);
                    
                    if (isPeriodRange) {
                        // For period ranges, make a SINGLE API call with the full range
                        // The backend handles period ranges correctly and returns the sum of all periods
                        // This is more accurate than summing individual period calls
                        console.log(`   📅 BALANCECURRENCY period range: ${fromPeriodStr} to ${toPeriodStr} - making single range API call`);
                        
                        try {
                            const apiParams = new URLSearchParams({
                                account: account,
                                from_period: fromPeriodStr,
                                to_period: toPeriodStr,
                                subsidiary: subsidiary || '',
                                currency: reqCurrency,
                                department: department || '',
                                location: location || '',
                                class: classId || '',
                                book: accountingBook || ''
                            });
                            
                            console.log(`   📤 BALANCECURRENCY API (range ${fromPeriodStr} to ${toPeriodStr}): ${account} (currency: ${reqCurrency || 'default'})`);
                            
                            const response = await fetch(`${SERVER_URL}/balancecurrency?${apiParams.toString()}`);
                            
                            if (response.ok) {
                                const data = await response.json();
                                const value = data.balance ?? 0;
                                const errorCode = data.error;
                                
                                if (errorCode) {
                                    console.log(`   ⚠️ BALANCECURRENCY range result: ${account} = ${errorCode}`);
                                    request.reject(new Error(errorCode));
                                } else {
                                    console.log(`   ✅ BALANCECURRENCY range result: ${account} = ${value.toLocaleString()} (period range ${fromPeriodStr} to ${toPeriodStr})`);
                                    cache.balance.set(cacheKey, value);
                                    request.resolve(value);
                                }
                            } else {
                                const errorCode = response.status === 408 || response.status === 504 ? 'TIMEOUT' : 'APIERR';
                                console.error(`   ❌ BALANCECURRENCY range API error: ${response.status} → ${errorCode}`);
                                request.reject(new Error(errorCode));
                            }
                        } catch (error) {
                            const errorCode = error.name === 'AbortError' ? 'TIMEOUT' : 'NETFAIL';
                            console.error(`   ❌ BALANCECURRENCY range fetch error: ${error.message} → ${errorCode}`);
                            request.reject(new Error(errorCode));
                        }
                    } else {
                        // Single period or cumulative - use original logic
                        try {
                            const apiParams = new URLSearchParams({
                                account: account,
                                from_period: fromPeriod || '',
                                to_period: toPeriod,
                                subsidiary: subsidiary || '',
                                currency: reqCurrency,
                                department: department || '',
                                location: location || '',
                                class: classId || '',
                                book: accountingBook || ''
                            });
                            
                            console.log(`   📤 BALANCECURRENCY API: ${account} for ${fromPeriod || '(cumulative)'} → ${toPeriod} (currency: ${reqCurrency || 'default'})`);
                            
                            const response = await fetch(`${SERVER_URL}/balancecurrency?${apiParams.toString()}`);
                            
                            if (response.ok) {
                                const data = await response.json();
                                const value = data.balance ?? 0;
                                const errorCode = data.error;
                                
                                if (errorCode) {
                                    console.log(`   ⚠️ BALANCECURRENCY result: ${account} = ${errorCode}`);
                                    request.reject(new Error(errorCode));
                                } else {
                                    console.log(`   ✅ BALANCECURRENCY result: ${account} = ${value.toLocaleString()}`);
                                    cache.balance.set(cacheKey, value);
                                    request.resolve(value);
                                }
                            } else {
                                const errorCode = response.status === 408 || response.status === 504 ? 'TIMEOUT' : 'APIERR';
                                console.error(`   ❌ BALANCECURRENCY API error: ${response.status} → ${errorCode}`);
                                request.reject(new Error(errorCode));
                            }
                        } catch (error) {
                            const errorCode = error.name === 'AbortError' ? 'TIMEOUT' : 'NETFAIL';
                            console.error(`   ❌ BALANCECURRENCY fetch error: ${error.message} → ${errorCode}`);
                            request.reject(new Error(errorCode));
                        }
                    }
                }
            }
            
            // Skip the regular batch processing for this group
            continue;
        }
        
        // Collect ALL unique periods from ALL requests in this group
        // EXPAND date ranges (e.g., "Jan 2025" to "Dec 2025" → all 12 months)
        const periods = new Set();
        let isFullYearRequest = true;
        let yearForOptimization = null;
        
        for (const r of groupRequests) {
            const { fromPeriod, toPeriod } = r.request.params;
            if (fromPeriod && toPeriod && fromPeriod !== toPeriod) {
                // Check if this is a full year request (Jan to Dec of same year)
                const fromMatch = fromPeriod.match(/^Jan\s+(\d{4})$/);
                const toMatch = toPeriod.match(/^Dec\s+(\d{4})$/);
                if (fromMatch && toMatch && fromMatch[1] === toMatch[1]) {
                    const year = fromMatch[1];
                    if (yearForOptimization === null) {
                        yearForOptimization = year;
                    } else if (yearForOptimization !== year) {
                        isFullYearRequest = false;
                    }
                } else {
                    isFullYearRequest = false;
                }
                
                // Expand the range to all months
                const expanded = expandPeriodRangeFromTo(fromPeriod, toPeriod);
                console.log(`  📅 Expanding ${fromPeriod} to ${toPeriod} → ${expanded.length} months`);
                expanded.forEach(p => periods.add(p));
            } else if (fromPeriod) {
                isFullYearRequest = false;
                // Check for year-only format and expand if needed
                if (/^\d{4}$/.test(fromPeriod)) {
                    const expanded = expandPeriodRangeFromTo(fromPeriod, fromPeriod);
                    console.log(`  📅 Year-only expansion: ${fromPeriod} → ${expanded.length} months`);
                    expanded.forEach(p => periods.add(p));
                } else {
                periods.add(fromPeriod);
                }
            } else if (toPeriod) {
                isFullYearRequest = false;
                // Check for year-only format and expand if needed
                if (/^\d{4}$/.test(toPeriod)) {
                    const expanded = expandPeriodRangeFromTo(toPeriod, toPeriod);
                    console.log(`  📅 Year-only expansion: ${toPeriod} → ${expanded.length} months`);
                    expanded.forEach(p => periods.add(p));
                } else {
                periods.add(toPeriod);
                }
            }
        }
        const periodsArray = [...periods];
        
        // OPTIMIZATION: Disabled for now - year endpoint returns P&L activity totals,
        // which is WRONG for Balance Sheet accounts that need cumulative balances.
        // The regular /balance endpoint correctly detects BS accounts and uses cumulative logic.
        // TODO: Re-enable when we can detect account types on frontend and route accordingly.
        const useYearEndpoint = false;  // Was: isFullYearRequest && yearForOptimization && periodsArray.length === 12;
        
        if (useYearEndpoint) {
            console.log(`  🗓️ YEAR OPTIMIZATION: Using /batch/balance/year for FY ${yearForOptimization}`);
        }
        
        console.log(`  Batch: ${accounts.length} accounts × ${periodsArray.length} period(s)`);
        
        // Split into chunks to avoid overwhelming NetSuite
        // Chunk by BOTH accounts AND periods to prevent backend timeouts
        const accountChunks = [];
        for (let i = 0; i < accounts.length; i += CHUNK_SIZE) {
            accountChunks.push(accounts.slice(i, i + CHUNK_SIZE));
        }
        
        const periodChunks = [];
        for (let i = 0; i < periodsArray.length; i += MAX_PERIODS_PER_BATCH) {
            periodChunks.push(periodsArray.slice(i, i + MAX_PERIODS_PER_BATCH));
        }
        
        console.log(`  Split into ${accountChunks.length} account chunk(s) × ${periodChunks.length} period chunk(s) = ${accountChunks.length * periodChunks.length} total batches`);
        
        // Track which requests have been resolved to avoid double-resolution
        const resolvedRequests = new Set();
        
        // For each request, track which period chunks need to be processed
        // and accumulate the total across chunks
        // For date RANGES, we need ALL periods in the range, not just from/to
        const requestAccumulators = new Map();
        for (const {cacheKey, request} of groupRequests) {
            const { fromPeriod, toPeriod } = request.params;
            let periodsNeeded;
            if (fromPeriod && toPeriod && fromPeriod !== toPeriod) {
                // Full range - need all months
                periodsNeeded = new Set(expandPeriodRangeFromTo(fromPeriod, toPeriod));
            } else {
                periodsNeeded = new Set([fromPeriod, toPeriod].filter(p => p));
            }
            requestAccumulators.set(cacheKey, {
                total: 0,
                periodsNeeded,
                periodsProcessed: new Set()
            });
        }
        
        // YEAR OPTIMIZATION: If requesting full year, use optimized year endpoint
        if (useYearEndpoint) {
            const yearStartTime = Date.now();
            console.log(`  📤 Year request: ${accounts.length} accounts for FY ${yearForOptimization}`);
            
            try {
                const response = await fetch(`${SERVER_URL}/batch/balance/year`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        accounts: accounts,
                        year: parseInt(yearForOptimization),
                        subsidiary: filters.subsidiary || '',
                        accountingbook: filters.accountingBook || ''
                    })
                });
                
                if (response.ok) {
                    const data = await response.json();
                    const balances = data.balances || {};
                    const yearTime = ((Date.now() - yearStartTime) / 1000).toFixed(1);
                    const periodName = data.period || `FY ${yearForOptimization}`;
                    
                    console.log(`  ✅ Year endpoint returned ${Object.keys(balances).length} accounts in ${yearTime}s`);
                    
                    // Resolve all requests with year totals
                    for (const {cacheKey, request} of groupRequests) {
                        const account = request.params.account;
                        const accountData = balances[account] || {};
                        const total = accountData[periodName] || 0;
                        
                        console.log(`    🎯 RESOLVING (year): ${account} = ${total}`);
                        
                        cache.balance.set(cacheKey, total);
                        request.resolve(total);
                        resolvedRequests.add(cacheKey);
                    }
                    
                    continue; // Skip to next filter group
                } else {
                    console.warn(`  ⚠️ Year endpoint failed (${response.status}), falling back to monthly`);
                }
            } catch (yearError) {
                console.warn(`  ⚠️ Year endpoint error, falling back to monthly:`, yearError);
            }
        }
        
        // Process chunks sequentially (both accounts AND periods)
        let chunkIndex = 0;
        const totalChunks = accountChunks.length * periodChunks.length;
        
        for (let ai = 0; ai < accountChunks.length; ai++) {
            for (let pi = 0; pi < periodChunks.length; pi++) {
                chunkIndex++;
                const accountChunk = accountChunks[ai];
                const periodChunk = periodChunks[pi];
                const chunkStartTime = Date.now();
                console.log(`  📤 Chunk ${chunkIndex}/${totalChunks}: ${accountChunk.length} accounts × ${periodChunk.length} periods (fetching...)`);
            
                try {
                    // CRITICAL DEBUG: Log before making batch API call
                    console.error(`🔍🔍🔍 CRITICAL DEBUG: About to call /batch/balance with ${accountChunk.length} accounts × ${periodChunk.length} periods`);
                    
                    // Make batch API call
                    const response = await fetch(`${SERVER_URL}/batch/balance`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        accounts: accountChunk,
                        periods: periodChunk,
                        subsidiary: filters.subsidiary || '',
                        department: filters.department || '',
                        location: filters.location || '',
                        class: filters.class || '',
                        accountingbook: filters.accountingBook || ''  // Multi-Book Accounting support
                        // Note: /batch/balance endpoint does NOT support currency parameter
                        // BALANCECURRENCY requests are handled separately above
                    })
                    });
                    
                    // CRITICAL DEBUG: Log response status
                    console.error(`🔍🔍🔍 CRITICAL DEBUG: /batch/balance response status: ${response.status}`);
                
                    if (!response.ok) {
                        console.error(`  ❌ API error: ${response.status}`);
                        // Reject all promises in this chunk
                        for (const {cacheKey, request} of groupRequests) {
                            if (accountChunk.includes(request.params.account) && !resolvedRequests.has(cacheKey)) {
                                request.reject(new Error(`API error: ${response.status}`));
                                resolvedRequests.add(cacheKey);
                            }
                        }
                        continue;
                    }
                
                const data = await response.json();
                const balances = data.balances || {};
                const chunkTime = ((Date.now() - chunkStartTime) / 1000).toFixed(1);
                
                console.log(`  ✅ Received data for ${Object.keys(balances).length} accounts in ${chunkTime}s`);
                console.log(`  📦 Raw response:`, JSON.stringify(data, null, 2).substring(0, 500));
                console.log(`  📦 Balances object:`, JSON.stringify(balances, null, 2).substring(0, 500));
                
                    // Distribute results to waiting Promises
                    for (const {cacheKey, request} of groupRequests) {
                        // Skip if already resolved
                        if (resolvedRequests.has(cacheKey)) {
                            continue;
                        }
                        
                        const account = request.params.account;
                        
                        // Only process accounts in this chunk
                        if (!accountChunk.includes(account)) {
                            continue;
                        }
                        
                        const fromPeriod = request.params.fromPeriod;
                        const toPeriod = request.params.toPeriod;
                        const accountBalances = balances[account] || {};
                        const accum = requestAccumulators.get(cacheKey);
                        
                        console.log(`    🔍 Account ${account}: accountBalances =`, JSON.stringify(accountBalances));
                        
                        // Process each period in this chunk that this request needs
                        for (const period of periodChunk) {
                            // Check if this request needs this period
                            if (accum.periodsNeeded.has(period) && !accum.periodsProcessed.has(period)) {
                                accum.total += accountBalances[period] || 0;
                                accum.periodsProcessed.add(period);
                            }
                        }
                        
                        // Cache the accumulated result
                        cache.balance.set(cacheKey, accum.total);
                        
                        // Check if all needed periods are now processed
                        const allPeriodsProcessed = [...accum.periodsNeeded].every(p => accum.periodsProcessed.has(p));
                        
                        if (allPeriodsProcessed) {
                            console.log(`    🎯 RESOLVING: ${account} = ${accum.total}`);
                            try {
                                request.resolve(accum.total);
                                console.log(`    ✅ RESOLVED: ${account}`);
                            } catch (resolveErr) {
                                console.error(`    ❌ RESOLVE ERROR for ${account}:`, resolveErr);
                            }
                            resolvedRequests.add(cacheKey);
                        }
                    }
                
                } catch (error) {
                    console.error(`  ❌ Fetch error:`, error);
                    // Reject all promises in this chunk
                    for (const {cacheKey, request} of groupRequests) {
                        if (accountChunk.includes(request.params.account) && !resolvedRequests.has(cacheKey)) {
                            request.reject(error);
                            resolvedRequests.add(cacheKey);
                        }
                    }
                }
                
                // Delay between chunks to avoid rate limiting
                if (chunkIndex < totalChunks) {
                    console.log(`  ⏱️  Waiting ${CHUNK_DELAY}ms before next chunk...`);
                    await new Promise(resolve => setTimeout(resolve, CHUNK_DELAY));
                }
            }
        }
        
        // CRITICAL: Resolve any remaining unresolved requests with their accumulated totals
        // This catches edge cases where periods didn't align perfectly with chunks
        console.log(`\n🔍 Checking for unresolved requests (resolved so far: ${resolvedRequests.size}/${groupRequests.length})`);
        
        let unresolvedCount = 0;
        for (const {cacheKey, request} of groupRequests) {
            if (!resolvedRequests.has(cacheKey)) {
                const accum = requestAccumulators.get(cacheKey);
                console.log(`  ⚠️ FORCE-RESOLVING: ${request.params.account} = ${accum.total}`);
                console.log(`     periodsNeeded: ${[...accum.periodsNeeded].join(', ')}`);
                console.log(`     periodsProcessed: ${[...accum.periodsProcessed].join(', ')}`);
                try {
                    request.resolve(accum.total);
                    console.log(`  ✅ Force-resolved successfully`);
                } catch (err) {
                    console.error(`  ❌ Force-resolve FAILED:`, err);
                }
                resolvedRequests.add(cacheKey);
                unresolvedCount++;
            }
        }
        
        console.log(`📊 Final stats: ${resolvedRequests.size} resolved, ${unresolvedCount} force-resolved`);
        }
    }
    
    const totalBatchTime = ((Date.now() - batchStartTime) / 1000).toFixed(1);
    console.log('========================================');
    console.log(`✅ BATCH PROCESSING COMPLETE in ${totalBatchTime}s`);
    console.error(`🔍🔍🔍 CRITICAL DEBUG: Final state - regularRequests.length: ${regularRequests.length}, cumulativeRequests.length: ${cumulativeRequests.length}, periodActivityRequests.length: ${periodActivityRequests.length}`);
    console.log('========================================\n');
}

// ============================================================================
// OLD STREAMING CODE - REMOVED (kept for reference)
// ============================================================================
/*
async function fetchBatchBalances(accounts, periods, filters, allRequests, retryCount = 0) {
    try {
        const payload = {
            accounts,
            periods,
            subsidiary: filters.subsidiary || '',
            department: filters.department || '',
            location: filters.location || '',
            class: filters.class || ''
        };
        
        // DEBUG: Log the exact payload being sent to API
        if (filters.subsidiary && filters.subsidiary.toLowerCase().includes('europe')) {
            console.log(`📤 BATCH API DEBUG: subsidiary="${filters.subsidiary}", hasConsolidated=${filters.subsidiary.includes('(Consolidated)')}`);
            console.log(`📤 Full payload:`, JSON.stringify(payload, null, 2));
        }
        
        const response = await fetch(`${SERVER_URL}/batch/balance`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        if (response.status === 429) {
            // NetSuite concurrency limit hit
            console.warn(`⚠️  429 ERROR: NetSuite concurrency limit (retry ${retryCount + 1}/${MAX_RETRIES})`);
            
            if (retryCount < MAX_RETRIES) {
                console.log(`  Waiting ${RETRY_DELAY}ms before retry...`);
                await delay(RETRY_DELAY);
                return await fetchBatchBalances(accounts, periods, filters, allRequests, retryCount + 1);
            } else {
                console.error(`  ❌ Max retries reached, returning blanks`);
                // Finish all invocations with 0
                for (const { key, req } of allRequests) {
                    if (accounts.includes(req.params.account)) {
                        safeFinishInvocation(req.invocation, 0);
                    }
                }
                return;
            }
        }
        
        if (!response.ok) {
            console.error(`Batch API error: ${response.status}`);
            // Finish all invocations with 0
            for (const { key, req } of allRequests) {
                if (accounts.includes(req.params.account)) {
                    safeFinishInvocation(req.invocation, 0);
                }
            }
            return;
        }
        
        const data = await response.json();
        const balances = data.balances || {};
        
        console.log(`  ✅ Received balances for ${Object.keys(balances).length} accounts`);
        
        // Track which invocations we've successfully finished
        // This prevents closing them again with 0 if there's an error later
        const finishedInvocations = new Set();
        
        // Distribute results to invocations and close them
        // Backend now returns period-by-period breakdown
        // Each cell extracts and sums ONLY the periods it requested
        for (const { key, req } of allRequests) {
            try {
                // ✅ CRITICAL FIX: Only process accounts that are in THIS batch
                // Don't finish invocations for accounts not in this batch - they're in other batches!
                if (!accounts.includes(req.params.account)) {
                    console.log(`ℹ️  Account ${req.params.account} not in this batch, skipping...`);
                    continue;  // Leave invocation open for next batch
                }
                
                const accountBalances = balances[req.params.account] || {};
                
                // Expand THIS cell's period range (use FromTo version for two-argument form)
                const cellPeriods = expandPeriodRangeFromTo(req.params.fromPeriod, req.params.toPeriod);
                
                // Sum only the periods THIS cell requested
                let total = 0;
                for (const period of cellPeriods) {
                    total += accountBalances[period] || 0;
                }
                
                // Cache the result and finish the invocation
                cache.balance.set(key, total);
                console.log(`💾 Cached ${req.params.account} (${cellPeriods.join(', ')}): ${total}`);
                console.log(`   → Finishing invocation for ${req.params.account}:`, {
                    hasInvocation: !!req.invocation,
                    hasSetResult: !!(req.invocation && req.invocation.setResult),
                    hasClose: !!(req.invocation && req.invocation.close),
                    total: total
                });
                safeFinishInvocation(req.invocation, total);
                finishedInvocations.add(key);  // Mark as finished
                
            } catch (error) {
                console.error('Error distributing result:', error, key);
                // ❌ DO NOT cache 0 on error - this causes cached failures!
                // Just finish the invocation with 0, don't pollute cache
                safeFinishInvocation(req.invocation, 0);
                finishedInvocations.add(key);  // Mark as finished (even with 0)
            }
        }
        
    } catch (error) {
        console.error('❌ Batch fetch error:', error);
        // DEFENSIVE: Only close invocations that we HAVEN'T already finished
        // This prevents overwriting correct values with 0!
        console.log(`⚠️  Closing unfinished invocations due to error...`);
        for (const { key, req } of allRequests) {
            try {
                // ✅ CRITICAL FIX: Only close if we haven't finished it yet
                if (req.invocation && !finishedInvocations.has(key)) {
                    console.log(`  → Closing unfinished invocation for ${req.params.account} with 0`);
                    safeFinishInvocation(req.invocation, 0);
                    // Mark as closed in tracker
                    if (invocationTracker.has(key)) {
                        invocationTracker.get(key).closed = true;
                    }
                }
            } catch (closeError) {
                console.error('Error closing invocation:', closeError);
            }
        }
    }
}

// expandPeriodRangeFromTo is defined at the top of this file
*/

// (Old streaming functions removed - not needed for Phase 3 non-streaming async)

// ============================================================================
// RETAINEDEARNINGS - Calculate prior years' cumulative P&L (no account number)
// NetSuite calculates this dynamically at report runtime
// ============================================================================
/**
 * Get calculated retained earnings (prior years' cumulative P&L).
 * NetSuite calculates this dynamically - there is no account number to query.
 * RE = Sum of all P&L from inception through prior fiscal year end + posted RE adjustments.
 * 
 * @customfunction RETAINEDEARNINGS
 * @param {any} period Accounting period (e.g., "Mar 2025")
 * @param {any} [subsidiary] Subsidiary ID (optional)
 * @param {any} [accountingBook] Accounting Book ID (optional, defaults to Primary Book)
 * @param {any} [classId] Class filter (optional)
 * @param {any} [department] Department filter (optional)
 * @param {any} [location] Location filter (optional)
 * @returns {Promise<number>} Retained earnings value
 */
async function RETAINEDEARNINGS(period, subsidiary, accountingBook, classId, department, location) {
    try {
        // RETAINEDEARNINGS is a point-in-time balance - use end of year for year-only values
        // This ensures "2025" calculates RE as of Dec 31, 2025
        period = normalizePeriodKey(period, false) || period;  // false = use Dec for year-only
        
        if (!period) {
            console.error('❌ RETAINEDEARNINGS: period is required');
            throw new Error('MISSING_PERIOD');
        }
        
        console.log(`📊 RETAINEDEARNINGS: Calculating as of ${period}`);
        
        // Normalize optional parameters
        subsidiary = String(subsidiary || '').trim();
        accountingBook = String(accountingBook || '').trim();
        classId = String(classId || '').trim();
        department = String(department || '').trim();
        location = String(location || '').trim();
        
        // Build cache key
        const cacheKey = `retainedearnings:${period}:${subsidiary}:${accountingBook}:${classId}:${department}:${location}`;
        
        // Check cache first
        if (cache.balance.has(cacheKey)) {
            cacheStats.hits++;
            console.log(`📥 CACHE HIT [retained earnings]: ${period}`);
            return cache.balance.get(cacheKey);
        }
        
        // Check if there's already a request in-flight for this exact key
        // This prevents duplicate API calls when Excel evaluates the formula multiple times
        if (inFlightRequests.has(cacheKey)) {
            console.log(`⏳ Waiting for in-flight request [retained earnings]: ${period}`);
            return await inFlightRequests.get(cacheKey);
        }
        
        cacheStats.misses++;
        console.log(`📥 Calculating Retained Earnings for ${period}...`);
        
        // ═══════════════════════════════════════════════════════════════
        // SEQUENTIAL EXECUTION: Acquire semaphore lock before API call
        // This prevents multiple special formulas from hitting the backend simultaneously
        // ═══════════════════════════════════════════════════════════════
        try {
            await acquireSpecialFormulaLock(cacheKey, 'RETAINEDEARNINGS');
        } catch (lockError) {
            if (lockError.message === 'QUEUE_CLEARED') {
                // Queue cleared is transient - proceed to API path (Excel will re-evaluate)
                console.log(`🚫 RETAINEDEARNINGS ${period}: Queue cleared, proceeding to API path`);
                // Continue to API path below (don't throw - transient state)
            } else {
                throw lockError;
            }
        }
        
        // CRITICAL: Wrap post-lock code in try-catch to ensure lock release on error
        let toastId;
        try {
            // Broadcast toast notification to taskpane
            toastId = broadcastToast(
                'Computing Retained Earnings…',
                `<strong>${period}</strong><br><br>This calculation aggregates all historical profit and loss activity from the company's inception through the prior fiscal year end. Because it pulls and consolidates many years of detailed accounting data, it may take up to two minutes to complete.`,
                'calculating',
                0 // Don't auto-dismiss
            );
        } catch (setupError) {
            // Error before inner promise - release lock immediately
            console.error('RETAINEDEARNINGS setup error:', setupError);
            releaseSpecialFormulaLock(cacheKey);
            throw setupError;
        }
        
        // Create the promise and store it BEFORE awaiting
        const requestPromise = (async () => {
            try {
                const response = await fetch(`${SERVER_URL}/retained-earnings`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        period,
                        subsidiary,
                        accountingBook,
                        classId,
                        department,
                        location
                    })
                });
                
                if (!response.ok) {
                    const errorText = await response.text();
                    console.error(`Retained Earnings API error: ${response.status}`, errorText);
                    if (toastId) {
                        updateBroadcastToast(toastId, 'Retained Earnings Failed', `Error: ${response.status}`, 'error');
                        setTimeout(() => removeBroadcastToast(toastId), 5000);
                    }
                    // Throw errors for non-timeout errors, #TIMEOUT# for timeouts
                    if (response.status === 524 || response.status === 522 || response.status === 504) {
                        throw new Error('TIMEOUT');
                    }
                    throw new Error('ERROR');
                }
                
                const data = await response.json();
                console.log(`📨 Retained Earnings API response:`, JSON.stringify(data));
                
                // Validate response - don't mask null/undefined as 0
                if (data.value === null || data.value === undefined) {
                    console.error(`❌ Retained Earnings (${period}): API returned null/undefined`);
                    if (toastId) {
                        updateBroadcastToast(toastId, 'Retained Earnings Error', 'API returned empty value', 'error');
                        setTimeout(() => removeBroadcastToast(toastId), 5000);
                    }
                    throw new Error('NODATA');
                }
                
                const value = parseFloat(data.value);
                if (isNaN(value)) {
                    console.error(`❌ Retained Earnings (${period}): Invalid number: ${data.value}`);
                    if (toastId) {
                        updateBroadcastToast(toastId, 'Retained Earnings Error', `Invalid value: ${data.value}`, 'error');
                        setTimeout(() => removeBroadcastToast(toastId), 5000);
                    }
                    throw new Error('ERROR');
                }
                
                // Cache the result (only valid numbers)
                cache.balance.set(cacheKey, value);
                console.log(`✅ Retained Earnings (${period}): ${value.toLocaleString()}`);
                
                // Update toast with success
                if (toastId) {
                    updateBroadcastToast(toastId, 
                        'Retained Earnings Complete', 
                        `${period}: ${value.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}`, 
                        'success'
                    );
                    setTimeout(() => removeBroadcastToast(toastId), 4000);
                }
                
                return value;
                
            } catch (error) {
                console.error('Retained Earnings fetch error:', error);
                if (toastId) {
                    removeBroadcastToast(toastId);
                }
                // Distinguish between network errors and server errors
                if (error.name === 'TypeError' && error.message.includes('fetch')) {
                    console.error('❌ SERVER OFFLINE - Cannot connect to backend');
                    throw new Error('OFFLINE');
                }
                // Re-throw if already an Error, otherwise wrap
                if (error instanceof Error) {
                    throw error;
                }
                throw new Error('ERROR');
            } finally {
                // Remove from in-flight after completion
                inFlightRequests.delete(cacheKey);
                // CRITICAL: Release the semaphore lock to allow next formula to run
                releaseSpecialFormulaLock(cacheKey);
            }
        })();
        
        // Store the promise for deduplication
        inFlightRequests.set(cacheKey, requestPromise);
        
        return await requestPromise;
        
    } catch (error) {
        console.error('RETAINEDEARNINGS error:', error);
        // Re-throw if already an Error, otherwise wrap
        if (error instanceof Error) {
            throw error;
        }
        throw new Error('ERROR');
    }
}

// ============================================================================
// NETINCOME - Calculate net income for a period range
// EXPLICIT PARAMETERS - no guessing/inference
// ============================================================================
/**
 * Get net income for a period or range of periods.
 * 
 * Usage:
 *   =XAVI.NETINCOME("Jan 2025", "Dec 2025")                    → Full year 2025
 *   =XAVI.NETINCOME("Jan 2025", "Mar 2025")                    → Q1 only
 *   =XAVI.NETINCOME("Jan 2025", "Jan 2025")                    → Just January
 *   =XAVI.NETINCOME("Jan 2025",, "Celigo Inc.")                → January with subsidiary (note comma)
 *   =XAVI.NETINCOME("2025", "2025")                            → Full year (expands to Jan-Dec)
 *   =XAVI.NETINCOME(C4, D4, E4)                                → Cell references
 * 
 * @customfunction NETINCOME
 * @param {any} fromPeriod Start period (e.g., "Jan 2025", "2025", or date)
 * @param {any} [toPeriod] End period - if empty, defaults to same as fromPeriod
 * @param {any} [subsidiary] Subsidiary name or ID (optional)
 * @param {any} [accountingBook] Accounting Book ID (optional)
 * @param {any} [classId] Class filter (optional)
 * @param {any} [department] Department filter (optional)
 * @param {any} [location] Location filter (optional)
 * @returns {Promise<number>} Net income value
 */
async function NETINCOME(fromPeriod, toPeriod, subsidiary, accountingBook, classId, department, location) {
    try {
        console.log(`📊 NETINCOME called with: fromPeriod=${fromPeriod} (type: ${typeof fromPeriod}), toPeriod=${toPeriod} (type: ${typeof toPeriod}), subsidiary=${subsidiary}`);
        
        const rawFromPeriod = fromPeriod;
        const rawToPeriod = toPeriod;
        
        // ================================================================
        // EXPLICIT PARAMETER HANDLING - No guessing!
        // ================================================================
        
        // Validate fromPeriod is provided
        if (fromPeriod === undefined || fromPeriod === null || fromPeriod === '') {
            console.error('❌ NETINCOME: fromPeriod is required');
            throw new Error('MISSING_PERIOD');
        }
        
        // Convert fromPeriod - for year-only, use Jan (start of year)
        const convertedFromPeriod = normalizePeriodKey(fromPeriod, true) || fromPeriod;  // true = use Jan
        console.log(`   📅 fromPeriod conversion: ${fromPeriod} → "${convertedFromPeriod}"`);
        
        // Convert toPeriod - if empty/skipped, default to fromPeriod; for year-only use Dec
        let convertedToPeriod;
        if (toPeriod === undefined || toPeriod === null || toPeriod === '') {
            // toPeriod not provided - default to same as fromPeriod
            // But if fromPeriod is year-only, make toPeriod = Dec of that year
            if (typeof fromPeriod === 'number' && fromPeriod >= 1900 && fromPeriod <= 2100) {
                convertedToPeriod = `Dec ${fromPeriod}`;
            } else if (typeof fromPeriod === 'string' && /^\d{4}$/.test(fromPeriod.trim())) {
                convertedToPeriod = `Dec ${fromPeriod.trim()}`;
            } else {
                convertedToPeriod = convertedFromPeriod; // Same period
            }
            console.log(`   📅 toPeriod not specified, defaulting to ${convertedToPeriod}`);
        } else {
            convertedToPeriod = normalizePeriodKey(toPeriod, false) || toPeriod;  // false = use Dec for year-only
            console.log(`   📅 toPeriod conversion: ${toPeriod} → "${convertedToPeriod}"`);
        }
        
        if (!convertedFromPeriod) {
            console.error('❌ NETINCOME: Could not parse fromPeriod:', rawFromPeriod);
            throw new Error('INVALID_PERIOD');
        }
        
        if (!convertedToPeriod) {
            console.error('❌ NETINCOME: Could not parse toPeriod:', rawToPeriod);
            throw new Error('INVALID_PERIOD');
        }
        
        // Normalize optional parameters - NO guessing, just clean strings
        const subsidiaryStr = String(subsidiary || '').trim();
        const accountingBookStr = String(accountingBook || '').trim();
        const classIdStr = String(classId || '').trim();
        const departmentStr = String(department || '').trim();
        const locationStr = String(location || '').trim();
        
        console.log(`📊 NETINCOME: ${rawFromPeriod} → ${rawToPeriod}`);
        console.log(`   Range: ${convertedFromPeriod} through ${convertedToPeriod}`);
        console.log(`   Subsidiary: "${subsidiaryStr || '(default)'}"`);
        
        // Build cache key
        const cacheKey = `netincome:${convertedFromPeriod}:${convertedToPeriod}:${subsidiaryStr}:${accountingBookStr}:${classIdStr}:${departmentStr}:${locationStr}`;
        
        // Check cache first
        if (cache.balance.has(cacheKey)) {
            cacheStats.hits++;
            console.log(`📥 CACHE HIT [net income]: ${convertedFromPeriod || 'FY'} → ${convertedToPeriod}`);
            return cache.balance.get(cacheKey);
        }
        
        // Check if there's already a request in-flight for this exact key
        if (inFlightRequests.has(cacheKey)) {
            console.log(`⏳ Waiting for in-flight request [net income]: ${convertedFromPeriod || 'FY'} → ${convertedToPeriod}`);
            return await inFlightRequests.get(cacheKey);
        }
        
        cacheStats.misses++;
        const rangeDesc = convertedFromPeriod ? `${convertedFromPeriod} → ${convertedToPeriod}` : `FY start → ${convertedToPeriod}`;
        console.log(`📥 Calculating Net Income for ${rangeDesc}...`);
        
        // ═══════════════════════════════════════════════════════════════
        // SEQUENTIAL EXECUTION: Acquire semaphore lock before API call
        // This prevents multiple special formulas from hitting the backend simultaneously
        // ═══════════════════════════════════════════════════════════════
        try {
            await acquireSpecialFormulaLock(cacheKey, 'NETINCOME');
        } catch (lockError) {
            if (lockError.message === 'QUEUE_CLEARED') {
                // Queue cleared is transient - proceed to API path (Excel will re-evaluate)
                console.log(`🚫 NETINCOME ${rangeDesc}: Queue cleared, proceeding to API path`);
                // Continue to API path below (don't throw - transient state)
            } else {
                throw lockError;
            }
        }
        
        // CRITICAL: Wrap post-lock code in try-catch to ensure lock release on error
        let toastId;
        try {
            // Broadcast toast notification to taskpane
            const toastTitle = 'Calculating Net Income…';
            const toastBody = `<strong>${convertedFromPeriod} → ${convertedToPeriod}</strong><br><br>Calculating P&L activity for the specified period range.`;
            toastId = broadcastToast(toastTitle, toastBody, 'calculating', 0);
        } catch (setupError) {
            // Error before inner promise - release lock immediately
            console.error('NETINCOME setup error:', setupError);
            releaseSpecialFormulaLock(cacheKey);
            throw setupError;
        }
        
        // Create the promise and store it BEFORE awaiting
        const requestPromise = (async () => {
            try {
                const response = await fetch(`${SERVER_URL}/net-income`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        period: convertedToPeriod,
                        fromPeriod: convertedFromPeriod,
                        subsidiary: subsidiaryStr,
                        accountingBook: accountingBookStr,
                        classId: classIdStr,
                        department: departmentStr,
                        location: locationStr
                    })
                });
                
                if (!response.ok) {
                    const errorText = await response.text();
                    console.error(`Net Income API error: ${response.status}`, errorText);
                    if (toastId) {
                        updateBroadcastToast(toastId, 'Net Income Failed', `Error: ${response.status}`, 'error');
                        setTimeout(() => removeBroadcastToast(toastId), 5000);
                    }
                    // Throw errors for non-timeout errors, #TIMEOUT# for timeouts
                    if (response.status === 524 || response.status === 522 || response.status === 504) {
                        throw new Error('TIMEOUT');
                    }
                    throw new Error('ERROR');
                }
                
                const data = await response.json();
                console.log(`📨 Net Income API response (${rangeDesc}):`, JSON.stringify(data));
                
                // Validate response - don't mask null/undefined as 0
                if (data.value === null || data.value === undefined) {
                    console.error(`❌ Net Income (${rangeDesc}): API returned null/undefined`);
                    if (toastId) {
                        updateBroadcastToast(toastId, 'Net Income Error', 'API returned empty value', 'error');
                        setTimeout(() => removeBroadcastToast(toastId), 5000);
                    }
                    throw new Error('NODATA');
                }
                
                const value = parseFloat(data.value);
                if (isNaN(value)) {
                    console.error(`❌ Net Income (${rangeDesc}): Invalid number: ${data.value}`);
                    if (toastId) {
                        updateBroadcastToast(toastId, 'Net Income Error', `Invalid value: ${data.value}`, 'error');
                        setTimeout(() => removeBroadcastToast(toastId), 5000);
                    }
                    throw new Error('ERROR');
                }
                
                // Cache the result (only valid numbers)
                cache.balance.set(cacheKey, value);
                console.log(`✅ Net Income (${rangeDesc}): ${value.toLocaleString()}`);
                
                // Update toast with success
                if (toastId) {
                    updateBroadcastToast(toastId, 
                        'Net Income Complete', 
                        `${rangeDesc}: ${value.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}`, 
                        'success'
                    );
                    setTimeout(() => removeBroadcastToast(toastId), 4000);
                }
                
                return value;
                
            } catch (error) {
                console.error('Net Income fetch error:', error);
                if (toastId) {
                    removeBroadcastToast(toastId);
                }
                // Distinguish between network errors and server errors
                if (error.name === 'TypeError' && error.message.includes('fetch')) {
                    console.error('❌ SERVER OFFLINE - Cannot connect to backend');
                    throw new Error('OFFLINE');
                }
                // Re-throw if already an Error, otherwise wrap
                if (error instanceof Error) {
                    throw error;
                }
                throw new Error('ERROR');
            } finally {
                inFlightRequests.delete(cacheKey);
                // CRITICAL: Release the semaphore lock to allow next formula to run
                releaseSpecialFormulaLock(cacheKey);
            }
        })();
        
        inFlightRequests.set(cacheKey, requestPromise);
        return await requestPromise;
        
    } catch (error) {
        console.error('NETINCOME error:', error);
        // Re-throw if already an Error, otherwise wrap
        if (error instanceof Error) {
            throw error;
        }
        throw new Error('ERROR');
    }
}

// ============================================================================
// TYPEBALANCE - Get balance for all accounts of a specific type
// Automatically handles BS (cumulative) vs P&L (period range)
// ============================================================================
/**
 * Get total balance for all accounts of a specific NetSuite account type.
 * BS types (Bank, AcctRec, etc.) use cumulative calculation from inception.
 * P&L types (Income, Expense, etc.) use the specified period range.
 * 
 * @customfunction TYPEBALANCE
 * @param {any} accountType NetSuite account type (e.g., "OthAsset", "Expense", "Income")
 * @param {any} [fromPeriod] Start period (required for P&L, ignored for BS)
 * @param {any} toPeriod End period (required)
 * @param {any} [subsidiary] Subsidiary name or ID (optional)
 * @param {any} [department] Department filter (optional)
 * @param {any} [location] Location filter (optional)
 * @param {any} [classId] Class filter (optional)
 * @param {any} [accountingBook] Accounting Book ID (optional)
 * @returns {Promise<number>} Total balance for all accounts of the specified type
 */
async function TYPEBALANCE(accountType, fromPeriod, toPeriod, subsidiary, department, location, classId, accountingBook, useSpecialAccount) {
    
    // Cross-context cache invalidation - taskpane signals via localStorage
    // This is CRITICAL for subsidiary changes - must clear in-memory cache to read fresh localStorage data
    try {
        const clearSignal = localStorage.getItem('netsuite_cache_clear_signal');
        if (clearSignal) {
            const { timestamp, reason } = JSON.parse(clearSignal);
            if (Date.now() - timestamp < 10000) {
                console.log(`🔄 TYPEBALANCE: Cache cleared (${reason})`);
                // Clear the in-memory typebalance cache so we read from localStorage
                if (cache.typebalance) {
                    cache.typebalance = {};
                }
                // Note: Don't remove the signal here - BALANCE will do that
            }
        }
    } catch (e) { /* ignore */ }
    
    try {
        // Normalize account type FIRST (needed to build cache key for early check)
        const normalizedType = String(accountType || '').trim();
        if (!normalizedType) {
            console.error('❌ TYPEBALANCE: accountType is required');
            throw new Error('MISSING_TYPE');
        }
        
        // Check if using special account type (sspecacct) - parameter is 1 or "1" or true
        const useSpecial = useSpecialAccount === 1 || useSpecialAccount === '1' || useSpecialAccount === true;
        
        // Valid NetSuite account types (accttype)
        const BS_TYPES = ['Bank', 'AcctRec', 'OthCurrAsset', 'FixedAsset', 'OthAsset', 'DeferExpense', 'AcctPay', 'CredCard', 'OthCurrLiab', 'LongTermLiab', 'DeferRevenue', 'Equity', 'RetainedEarnings', 'UnbilledRec'];
        const PL_TYPES = ['Income', 'COGS', 'Expense', 'OthIncome', 'OthExpense', 'NonPosting'];
        const ALL_TYPES = [...BS_TYPES, ...PL_TYPES];
        
        // Valid Special Account Types (sspecacct) - for cash flow statements
        const BS_SPECIAL_TYPES = [
            'AcctRec', 'UnbilledRec', 'CustDep', 'CustAuth', 'RefundPay',
            'AcctPay', 'AdvPaid', 'RecvNotBill',
            'InvtAsset', 'InvInTransit', 'InvInTransitExt', 'RtnNotCredit',
            'DeferRevenue', 'DeferExpense', 'DeferRevClearing',
            'OpeningBalEquity', 'RetEarnings', 'CumulTransAdj', 'CTA-E',
            'SalesTaxPay', 'Tax', 'TaxLiability', 'PSTPay',
            'CommPay', 'PayrollLiab', 'PayrollFloat', 'PayAdjst',
            'UndepFunds', 'Tegata', 'DirectLabor', 'IndirectLabor'
        ];
        const PL_SPECIAL_TYPES = [
            'COGS', 'FxRateVariance', 'RealizedERV', 'UnrERV', 'MatchingUnrERV', 'RndERV',
            'PSTExp', 'PayrollExp', 'PayWage', 'JobCostVariance'
        ];
        const ALL_SPECIAL_TYPES = [...BS_SPECIAL_TYPES, ...PL_SPECIAL_TYPES];
        
        // Validate type based on mode
        if (useSpecial) {
            // Using special account type - warn if not recognized but allow
            if (!ALL_SPECIAL_TYPES.includes(normalizedType)) {
                console.warn(`⚠️ TYPEBALANCE: Unknown special account type "${normalizedType}" - assuming BS. See SPECIAL_ACCOUNT_TYPES.md for valid types.`);
            }
        } else {
            // Using regular account type - strict validation
            if (!ALL_TYPES.includes(normalizedType)) {
                console.error(`❌ TYPEBALANCE: Invalid account type "${normalizedType}". Valid types: ${ALL_TYPES.join(', ')}`);
                throw new Error('INVALID_TYPE');
            }
        }
        
        // Determine if Balance Sheet based on type
        const isBalanceSheet = useSpecial 
            ? BS_SPECIAL_TYPES.includes(normalizedType) || !PL_SPECIAL_TYPES.includes(normalizedType)
            : BS_TYPES.includes(normalizedType);
        
        // Convert periods
        let convertedToPeriod = normalizePeriodKey(toPeriod, false) || toPeriod; // false = use Dec for year-only
        if (!convertedToPeriod) {
            console.error('❌ TYPEBALANCE: toPeriod is required');
            throw new Error('MISSING_PERIOD');
        }
        
        let convertedFromPeriod = '';
        if (isBalanceSheet) {
            // BS types: cumulative from inception, ignore fromPeriod
            const modeLabel = useSpecial ? 'special account' : 'account';
            console.log(`📊 TYPEBALANCE: BS ${modeLabel} type "${normalizedType}" - cumulative through ${convertedToPeriod}`);
        } else {
            // P&L types: need fromPeriod
            convertedFromPeriod = normalizePeriodKey(fromPeriod, true) || fromPeriod; // true = use Jan for year-only
            if (!convertedFromPeriod) {
                console.error('❌ TYPEBALANCE: fromPeriod is required for P&L account types');
                throw new Error('MISSING_PERIOD');
            }
            const modeLabel = useSpecial ? 'special account' : 'account';
            console.log(`📊 TYPEBALANCE: P&L ${modeLabel} type "${normalizedType}" - range ${convertedFromPeriod} → ${convertedToPeriod}`);
        }
        
        // Build cache key (include useSpecial flag)
        const subsidiaryStr = String(subsidiary || '').trim();
        const departmentStr = String(department || '').trim();
        const locationStr = String(location || '').trim();
        const classStr = String(classId || '').trim();
        const bookStr = String(accountingBook || '').trim();
        const specialFlag = useSpecial ? '1' : '0';
        const cacheKey = `typebalance:${normalizedType}:${convertedFromPeriod}:${convertedToPeriod}:${subsidiaryStr}:${departmentStr}:${locationStr}:${classStr}:${bookStr}:${specialFlag}`;
        
        // CRITICAL: Check cache FIRST before waiting for preload
        // CFO Flash and other reports save cache before setting status to 'complete'
        // So if cache exists, use it immediately instead of waiting
        
        // Check in-memory cache first
        if (cache.typebalance && cache.typebalance[cacheKey] !== undefined) {
            console.log(`📋 TYPEBALANCE cache hit (memory): ${cacheKey} = ${cache.typebalance[cacheKey]}`);
            return cache.typebalance[cacheKey];
        }
        
        // Check localStorage if in-memory cache misses
        // This is CRITICAL when functions.html loads AFTER taskpane has pre-fetched data
        let cacheKeyFound = false;
        let localStorageStatus = 'not checked';
        let localStorageKeyCount = 0;
        try {
            const stored = localStorage.getItem(TYPEBALANCE_STORAGE_KEY);
            if (stored) {
                const storageData = JSON.parse(stored);
                const storedBalances = storageData.balances || {};
                localStorageKeyCount = Object.keys(storedBalances).length;
                
                // Check if this key exists in localStorage
                if (storedBalances[cacheKey] !== undefined) {
                    console.log(`📋 TYPEBALANCE cache hit (localStorage): ${cacheKey} = ${storedBalances[cacheKey]}`);
                    
                    // Populate in-memory cache from localStorage for future lookups
                    if (!cache.typebalance) cache.typebalance = {};
                    cache.typebalance = { ...cache.typebalance, ...storedBalances };
                    console.log(`   💾 Restored ${localStorageKeyCount} entries from localStorage to memory`);
                    
                    return storedBalances[cacheKey];
                }
                cacheKeyFound = false;
                localStorageStatus = `has ${localStorageKeyCount} keys but NOT our key`;
            } else {
                localStorageStatus = 'EMPTY (no data from taskpane)';
            }
        } catch (e) {
            localStorageStatus = `ERROR: ${e.message}`;
            console.warn('⚠️ localStorage read failed:', e.message);
        }
        
        // ================================================================
        // PRELOAD COORDINATION: Only wait if cache key not found
        // If cache exists but our key is missing, proceed to API call
        // This prevents unnecessary waiting when CFO Flash has already saved cache
        // ================================================================
        let preloadWaited = false;
        
        // Log current preload status for debugging
        const preloadStatus = localStorage.getItem(PRELOAD_STATUS_KEY) || 'not_set';
        const cacheHasData = hasLocalStorageCache();
        console.log(`🔍 TYPEBALANCE: preload_status="${preloadStatus}", cache_has_data=${cacheHasData}, cache_key_found=${cacheKeyFound}`);
        
        // Only wait if preload is running AND cache doesn't have our key
        // If cache exists but key is missing, it means this specific combination wasn't cached
        // So proceed to API call instead of waiting
        if (isPreloadInProgress() && !cacheKeyFound) {
            // Preload is explicitly running and cache doesn't have our key - wait for it
            console.log(`⏳ TYPEBALANCE: Preload in progress and cache key not found - waiting for cache...`);
            await waitForPreload();
            preloadWaited = true;
            console.log(`✅ TYPEBALANCE: Preload complete - will re-check cache`);
            
            // Re-check cache after preload completes
            try {
                const stored = localStorage.getItem(TYPEBALANCE_STORAGE_KEY);
                if (stored) {
                    const storageData = JSON.parse(stored);
                    const storedBalances = storageData.balances || {};
                    if (storedBalances[cacheKey] !== undefined) {
                        console.log(`📋 TYPEBALANCE cache hit (after preload wait): ${cacheKey} = ${storedBalances[cacheKey]}`);
                        if (!cache.typebalance) cache.typebalance = {};
                        cache.typebalance = { ...cache.typebalance, ...storedBalances };
                        return storedBalances[cacheKey];
                    }
                }
            } catch (e) {
                console.warn('⚠️ localStorage re-check failed:', e.message);
            }
        } else if (!cacheHasData && preloadStatus !== 'complete' && !cacheKeyFound) {
            // No preload running AND cache is empty AND preload hasn't completed AND key not found
            // This might mean taskpane hasn't started yet - wait briefly
            console.log(`⏳ TYPEBALANCE: No cache yet - waiting briefly for taskpane to populate...`);
            const waitResult = await waitForCachePopulation(8000);
            if (waitResult === 'preload_started') {
                // Preload was detected during wait - now wait for it to complete
                console.log(`⏳ TYPEBALANCE: Preload started - waiting for completion...`);
                await waitForPreload();
                preloadWaited = true;
                console.log(`✅ TYPEBALANCE: Preload complete - will re-check cache`);
                
                // Re-check cache after preload completes
                try {
                    const stored = localStorage.getItem(TYPEBALANCE_STORAGE_KEY);
                    if (stored) {
                        const storageData = JSON.parse(stored);
                        const storedBalances = storageData.balances || {};
                        if (storedBalances[cacheKey] !== undefined) {
                            console.log(`📋 TYPEBALANCE cache hit (after wait): ${cacheKey} = ${storedBalances[cacheKey]}`);
                            if (!cache.typebalance) cache.typebalance = {};
                            cache.typebalance = { ...cache.typebalance, ...storedBalances };
                            return storedBalances[cacheKey];
                        }
                    }
                } catch (e) {
                    console.warn('⚠️ localStorage re-check failed:', e.message);
                }
            } else if (waitResult === 'cache_ready') {
                preloadWaited = true;
                console.log(`✅ TYPEBALANCE: Cache is ready - will re-check`);
                
                // Re-check cache
                try {
                    const stored = localStorage.getItem(TYPEBALANCE_STORAGE_KEY);
                    if (stored) {
                        const storageData = JSON.parse(stored);
                        const storedBalances = storageData.balances || {};
                        if (storedBalances[cacheKey] !== undefined) {
                            console.log(`📋 TYPEBALANCE cache hit (after cache ready): ${cacheKey} = ${storedBalances[cacheKey]}`);
                            if (!cache.typebalance) cache.typebalance = {};
                            cache.typebalance = { ...cache.typebalance, ...storedBalances };
                            return storedBalances[cacheKey];
                        }
                    }
                } catch (e) {
                    console.warn('⚠️ localStorage re-check failed:', e.message);
                }
            }
        } else if (cacheKeyFound) {
            // Cache exists but key not found - this is expected for some combinations
            // Proceed to API call without waiting
            console.log(`ℹ️ TYPEBALANCE: Cache exists but key "${cacheKey}" not found - will use API`);
        }
        
        // Log cache miss with details for debugging
        const cacheSize = cache.typebalance ? Object.keys(cache.typebalance).length : 0;
        console.log(`❌ TYPEBALANCE cache MISS: "${cacheKey}"`);
        console.log(`   📦 memory: ${cacheSize} entries, localStorage: ${localStorageStatus}`);
        
        // Check in-flight
        if (inFlightRequests.has(cacheKey)) {
            console.log(`⏳ TYPEBALANCE: Waiting for in-flight request: ${cacheKey}`);
            return await inFlightRequests.get(cacheKey);
        }
        
        // Make API request
        const requestPromise = (async () => {
            try {
                // Acquire lock to prevent flooding
                await acquireSpecialFormulaLock('TYPEBALANCE', cacheKey);
                
                broadcastToast('Calculating Type Balance…', 'info');
                
                const response = await fetch(`${SERVER_URL}/type-balance`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        accountType: normalizedType,
                        fromPeriod: convertedFromPeriod,
                        toPeriod: convertedToPeriod,
                        subsidiary: subsidiaryStr,
                        department: departmentStr,
                        location: locationStr,
                        classId: classStr,
                        accountingBook: bookStr,
                        useSpecialAccount: useSpecial
                    })
                });
                
                if (!response.ok) {
                    const errorText = await response.text();
                    console.error(`❌ TYPEBALANCE API error: ${response.status} - ${errorText}`);
                    releaseSpecialFormulaLock(cacheKey);
                    inFlightRequests.delete(cacheKey);  // MUST delete or future calls hang forever
                    if (response.status === 524 || response.status === 522 || response.status === 504) {
                        throw new Error('TIMEOUT');
                    }
                    throw new Error('API_ERR');
                }
                
                const data = await response.json();
                const value = parseFloat(data.value) || 0;
                
                console.log(`✅ TYPEBALANCE ${normalizedType} (${convertedFromPeriod || 'inception'} → ${convertedToPeriod}): ${value.toLocaleString()}`);
                
                // Cache the result
                if (!cache.typebalance) cache.typebalance = {};
                cache.typebalance[cacheKey] = value;
                
                broadcastToast(`Type Balance: $${value.toLocaleString()}`, 'success');
                
                releaseSpecialFormulaLock(cacheKey);
                inFlightRequests.delete(cacheKey);
                
                return value;
                
            } catch (error) {
                console.error('TYPEBALANCE fetch error:', error);
                releaseSpecialFormulaLock(cacheKey);
                inFlightRequests.delete(cacheKey);
                if (error.name === 'TypeError' && error.message.includes('fetch')) {
                    throw new Error('OFFLINE');
                }
                // Re-throw if already an Error, otherwise wrap
                if (error instanceof Error) {
                    throw error;
                }
                throw new Error('ERROR');
            }
        })();
        
        inFlightRequests.set(cacheKey, requestPromise);
        return await requestPromise;
        
    } catch (error) {
        console.error('TYPEBALANCE error:', error);
        // Re-throw if already an Error, otherwise wrap
        if (error instanceof Error) {
            throw error;
        }
        throw new Error('ERROR');
    }
}

// ============================================================================
// CTA - Calculate Cumulative Translation Adjustment (multi-currency plug)
// This is the balancing figure after currency translation in consolidation
// ============================================================================
/**
 * Get cumulative translation adjustment for consolidated multi-currency reports.
 * This is a "plug" figure that forces the Balance Sheet to balance after currency translation.
 * Note: CTA omits segment filters because translation adjustments apply at entity level.
 * 
 * @customfunction CTA
 * @param {any} period Accounting period (e.g., "Mar 2025")
 * @param {any} [subsidiary] Subsidiary ID (optional)
 * @param {any} [accountingBook] Accounting Book ID (optional, defaults to Primary Book)
 * @returns {Promise<number>} CTA value
 */
async function CTA(period, subsidiary, accountingBook) {
    try {
        // CTA is a point-in-time balance - use end of year for year-only values
        // This ensures "2025" calculates CTA as of Dec 31, 2025
        period = normalizePeriodKey(period, false) || period;  // false = use Dec for year-only
        
        if (!period) {
            console.error('❌ CTA: period is required');
            throw new Error('MISSING_PERIOD');
        }
        
        console.log(`📊 CTA: Calculating as of ${period}`);
        
        // Normalize optional parameters
        subsidiary = String(subsidiary || '').trim();
        accountingBook = String(accountingBook || '').trim();
        
        // Build cache key (no segment filters for CTA - entity level only)
        const cacheKey = `cta:${period}:${subsidiary}:${accountingBook}`;
        
        // Check cache first
        if (cache.balance.has(cacheKey)) {
            cacheStats.hits++;
            console.log(`📥 CACHE HIT [CTA]: ${period}`);
            return cache.balance.get(cacheKey);
        }
        
        // Check if there's already a request in-flight for this exact key
        if (inFlightRequests.has(cacheKey)) {
            console.log(`⏳ Waiting for in-flight request [CTA]: ${period}`);
            return await inFlightRequests.get(cacheKey);
        }
        
        cacheStats.misses++;
        console.log(`📥 Calculating CTA for ${period}...`);
        
        // ═══════════════════════════════════════════════════════════════
        // SEQUENTIAL EXECUTION: Acquire semaphore lock before API call
        // This prevents multiple special formulas from hitting the backend simultaneously
        // ═══════════════════════════════════════════════════════════════
        try {
            await acquireSpecialFormulaLock(cacheKey, 'CTA');
        } catch (lockError) {
            if (lockError.message === 'QUEUE_CLEARED') {
                // Queue cleared is transient - proceed to API path (Excel will re-evaluate)
                console.log(`🚫 CTA ${period}: Queue cleared, proceeding to API path`);
                // Continue to API path below (don't throw - transient state)
            } else {
                throw lockError;
            }
        }
        
        // CRITICAL: Wrap post-lock code in try-catch to ensure lock release on error
        let toastId;
        try {
            // Broadcast toast notification to taskpane
            toastId = broadcastToast(
                'Preparing Cumulative Translation Adjustment…',
                `<strong>${period}</strong><br><br>This step runs several consolidated queries across assets, liabilities, equity, retained earnings, and net income to capture FX differences when consolidating foreign subsidiaries. The system performs currency translation across each category, so this process can take 60 seconds or more.`,
                'calculating',
                0 // Don't auto-dismiss
            );
        } catch (setupError) {
            // Error before inner promise - release lock immediately
            console.error('CTA setup error:', setupError);
            releaseSpecialFormulaLock(cacheKey);
            throw setupError;
        }
        
        // Create the promise and store it BEFORE awaiting
        const requestPromise = (async () => {
            const maxRetries = 3;
            let lastError = null;
            
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    if (attempt > 1) {
                        const waitTime = attempt * 5; // 5s, 10s, 15s
                        console.log(`⏳ CTA retry ${attempt}/${maxRetries} after ${waitTime}s...`);
                        if (toastId) {
                            updateBroadcastToast(toastId, 
                                'CTA Retry in Progress…', 
                                `Attempt ${attempt}/${maxRetries}. Large calculations may need multiple attempts.`,
                                'calculating'
                            );
                        }
                        await new Promise(r => setTimeout(r, waitTime * 1000));
                    }
                    
                    const response = await fetch(`${SERVER_URL}/cta`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            period,
                            subsidiary,
                            accountingBook
                        })
                    });
                    
                    // Handle timeout errors (524) with retry
                    if (response.status === 524 || response.status === 522 || response.status === 504) {
                        console.warn(`CTA timeout (${response.status}), attempt ${attempt}/${maxRetries}`);
                        lastError = `Timeout (${response.status})`;
                        if (attempt < maxRetries) continue; // Retry
                        // All retries exhausted - throw TIMEOUT error
                        if (toastId) {
                            updateBroadcastToast(toastId, 'CTA Timed Out', 
                                `Tunnel timeout after ${maxRetries} attempts. Cell shows #TIMEOUT#. Refresh single cell to retry, or delete formula for SUM to work.`, 'error');
                            setTimeout(() => removeBroadcastToast(toastId), 8000);
                        }
                        throw new Error('TIMEOUT');
                    }
                    
                    if (!response.ok) {
                        const errorText = await response.text();
                        console.error(`CTA API error: ${response.status}`, errorText);
                        if (toastId) {
                            updateBroadcastToast(toastId, 'CTA Failed', `Error: ${response.status}`, 'error');
                            setTimeout(() => removeBroadcastToast(toastId), 5000);
                        }
                        throw new Error('ERROR');
                    }
                    
                    const data = await response.json();
                    console.log(`📨 CTA API response:`, JSON.stringify(data));
                    
                    // Validate response - don't mask null/undefined as 0
                    if (data.value === null || data.value === undefined) {
                        console.error(`❌ CTA (${period}): API returned null/undefined`);
                        if (toastId) {
                            updateBroadcastToast(toastId, 'CTA Error', 'API returned empty value', 'error');
                            setTimeout(() => removeBroadcastToast(toastId), 5000);
                        }
                        throw new Error('NODATA');
                    }
                    
                    const value = parseFloat(data.value);
                    if (isNaN(value)) {
                        console.error(`❌ CTA (${period}): Invalid number: ${data.value}`);
                        if (toastId) {
                            updateBroadcastToast(toastId, 'CTA Error', `Invalid value: ${data.value}`, 'error');
                            setTimeout(() => removeBroadcastToast(toastId), 5000);
                        }
                        throw new Error('ERROR');
                    }
                    
                    // Log component breakdown for debugging
                    if (data.components) {
                        console.log(`📊 CTA Components (${period}):`);
                        console.log(`   Total Assets:      ${data.components.total_assets?.toLocaleString() || 'N/A'}`);
                        console.log(`   Total Liabilities: ${data.components.total_liabilities?.toLocaleString() || 'N/A'}`);
                        console.log(`   Posted Equity:     ${data.components.posted_equity?.toLocaleString() || 'N/A'}`);
                        console.log(`   Retained Earnings: ${data.components.retained_earnings?.toLocaleString() || 'N/A'}`);
                        console.log(`   Net Income:        ${data.components.net_income?.toLocaleString() || 'N/A'}`);
                        console.log(`   CTA (plug):        ${value.toLocaleString()}`);
                    }
                    
                    // Cache the result (only valid numbers)
                    cache.balance.set(cacheKey, value);
                    console.log(`✅ CTA (${period}): ${value.toLocaleString()}`);
                
                    // Update toast with success
                    if (toastId) {
                        updateBroadcastToast(toastId, 
                            'CTA Complete', 
                            `${period}: ${value.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}`, 
                            'success'
                        );
                        setTimeout(() => removeBroadcastToast(toastId), 4000);
                    }
                    
                    return value;
                    
                } catch (error) {
                    console.error(`CTA fetch error (attempt ${attempt}):`, error);
                    lastError = error.message;
                    
                    // Check for server offline (network error)
                    if (error.name === 'TypeError' && error.message.includes('fetch')) {
                        console.error('❌ SERVER OFFLINE - Cannot connect to backend');
                        if (toastId) {
                            updateBroadcastToast(toastId, 'Server Offline', 
                                'Cannot connect to NetSuite backend. Please try again later.', 'error');
                            setTimeout(() => removeBroadcastToast(toastId), 5000);
                        }
                        throw new Error('OFFLINE');
                    }
                    
                    if (attempt >= maxRetries) {
                        if (toastId) {
                            updateBroadcastToast(toastId, 'CTA Failed', 
                                `Failed after ${maxRetries} attempts. Cell shows #TIMEOUT#.`, 'error');
                            setTimeout(() => removeBroadcastToast(toastId), 5000);
                        }
                        throw new Error('TIMEOUT');
                    }
                    // Continue to next retry
                }
            } // end for loop
            
            // If we get here, all retries failed
            console.error(`CTA failed after ${maxRetries} attempts:`, lastError);
            if (toastId) {
                updateBroadcastToast(toastId, 'CTA Timed Out', 
                    `Timeout after ${maxRetries} attempts. Cell shows #TIMEOUT#.`, 'error');
                setTimeout(() => removeBroadcastToast(toastId), 5000);
            }
            throw new Error('TIMEOUT');
        })().finally(() => {
            inFlightRequests.delete(cacheKey);
            // CRITICAL: Release the semaphore lock to allow next formula to run
            releaseSpecialFormulaLock(cacheKey);
        });
        
        inFlightRequests.set(cacheKey, requestPromise);
        return await requestPromise;
        
    } catch (error) {
        console.error('CTA error:', error);
        // Re-throw if already an Error, otherwise wrap
        if (error instanceof Error) {
            throw error;
        }
        throw new Error('ERROR');
    }
}

// ============================================================================
// CLEARCACHE - Internal function to clear caches from taskpane
// Called via Excel.evaluate("=NS.CLEARCACHE(items)") from taskpane
// ============================================================================
// Track last CLEARCACHE time to prevent repeated clearing during formula evaluation
let lastClearCacheTime = 0;
const CLEARCACHE_DEBOUNCE_MS = 5000; // 5 second debounce

/**
 * Internal function - clears specified items from in-memory cache
 * @customfunction CLEARCACHE
 * @param {string} [itemsJson] JSON string of items to clear, or empty for all
 * @returns {string} Status message
 */
function CLEARCACHE(itemsJson) {
    console.log('🔧 CLEARCACHE called with:', itemsJson);
    
    try {
        // IMPORTANT: Only clear ALL caches when explicitly requested with "ALL"
        // This prevents accidental cache clearing during calculations
        if (itemsJson === 'ALL') {
            // DEBOUNCE: Prevent repeated "ALL" clears within 5 seconds
            // This happens when Excel re-evaluates =XAVI.CLEARCACHE("ALL") during formula calculations
            const now = Date.now();
            if (now - lastClearCacheTime < CLEARCACHE_DEBOUNCE_MS) {
                console.log(`⚠️ CLEARCACHE("ALL") debounced - last clear was ${Math.round((now - lastClearCacheTime)/1000)}s ago`);
                return 'DEBOUNCED';
            }
            lastClearCacheTime = now;
            
            // Clear ALL caches - explicit request only
            cache.balance.clear();
            cache.title.clear();
            cache.budget.clear();
            cache.type.clear();
            cache.parent.clear();
            if (fullYearCache) {
                Object.keys(fullYearCache).forEach(k => delete fullYearCache[k]);
            }
            console.log('🗑️ Cleared ALL in-memory caches (explicit ALL request)');
            return 'CLEARED_ALL';
        } else if (!itemsJson || itemsJson === '' || itemsJson === null) {
            // Empty/null call - do nothing (prevents accidental clearing)
            console.log('⚠️ CLEARCACHE called with empty/null - ignoring (use "ALL" to clear everything)');
            return 'IGNORED';
        } else {
            // Clear specific items
            const items = JSON.parse(itemsJson);
            let cleared = 0;
            
            for (const item of items) {
                const account = String(item.account);
                const period = item.period;
                
                // Use getCacheKey to ensure exact same format as BALANCE
                // Key order MUST match: type, account, fromPeriod, toPeriod, subsidiary, department, location, class
                const exactKey = getCacheKey('balance', {
                    account: account,
                    fromPeriod: period,
                    toPeriod: period,
                    subsidiary: '',
                    department: '',
                    location: '',
                    classId: ''
                });
                
                console.log(`   🔍 Looking for key: ${exactKey.substring(0, 80)}...`);
                
                if (cache.balance.has(exactKey)) {
                    cache.balance.delete(exactKey);
                    cleared++;
                    console.log(`   ✓ Cleared cache.balance: ${account}/${period}`);
                } else {
                    console.log(`   ⚠️ Key not found in cache.balance`);
                }
                
                // Clear from fullYearCache
                if (fullYearCache && fullYearCache[account]) {
                    if (fullYearCache[account][period] !== undefined) {
                        delete fullYearCache[account][period];
                        cleared++;
                        console.log(`   ✓ Cleared fullYearCache: ${account}/${period}`);
                    }
                }
            }
            
            console.log(`🗑️ Cleared ${cleared} items from in-memory cache`);
            return `CLEARED_${cleared}`;
        }
    } catch (e) {
        console.error('CLEARCACHE error:', e);
        return 'ERROR';
    }
}

// ============================================================================
// REGISTER FUNCTIONS WITH EXCEL
// ============================================================================
// CRITICAL: The manifest ALREADY defines namespace 'XAVI'
// We just register individual functions - Excel adds the XAVI. prefix automatically!
// 
// MICROSOFT BEST PRACTICE: CustomFunctions.associate() MUST be called AFTER Office.onReady()
// This ensures Office.js is fully initialized before registration
// ============================================================================

(function registerCustomFunctions() {
    function doRegistration() {
        if (typeof CustomFunctions !== 'undefined' && CustomFunctions.associate) {
            try {
                CustomFunctions.associate('NAME', NAME);
                CustomFunctions.associate('TYPE', TYPE);
                CustomFunctions.associate('PARENT', PARENT);
                CustomFunctions.associate('BALANCE', BALANCE);
                CustomFunctions.associate('BALANCECURRENCY', BALANCECURRENCY);
                CustomFunctions.associate('BALANCECHANGE', BALANCECHANGE);
                CustomFunctions.associate('BUDGET', BUDGET);
                CustomFunctions.associate('RETAINEDEARNINGS', RETAINEDEARNINGS);
                CustomFunctions.associate('NETINCOME', NETINCOME);
                CustomFunctions.associate('TYPEBALANCE', TYPEBALANCE);
                CustomFunctions.associate('CTA', CTA);
                CustomFunctions.associate('CLEARCACHE', CLEARCACHE);
                console.log('✅ Custom functions registered with Excel');
                return true;
            } catch (error) {
                console.error('❌ Error registering custom functions:', error);
                return false;
            }
        } else {
            console.warn('⚠️ CustomFunctions not available yet');
            return false;
        }
    }
    
    // MICROSOFT BEST PRACTICE: Wait for Office.onReady() before registering
    // This is critical for SharedRuntime mode on Mac
    if (typeof Office !== 'undefined' && Office.onReady) {
        Office.onReady(function(info) {
            console.log('📋 Office.onReady() fired - registering custom functions');
            console.log('   Platform:', info.platform);
            console.log('   Host:', info.host);
            
            if (doRegistration()) {
                // Signal successful registration
                if (typeof window !== 'undefined') {
                    window.xaviFunctionsRegistered = true;
                }
            }
        });
    } else {
        // Fallback: Office.js not loaded yet, wait for it
        if (typeof window !== 'undefined') {
            var checkOffice = setInterval(function() {
                if (typeof Office !== 'undefined' && Office.onReady) {
                    clearInterval(checkOffice);
                    Office.onReady(function(info) {
                        console.log('📋 Office.onReady() fired (delayed) - registering custom functions');
                        doRegistration();
                    });
                }
            }, 50);
            
            // Timeout after 5 seconds
            setTimeout(function() {
                clearInterval(checkOffice);
                if (typeof CustomFunctions !== 'undefined') {
                    console.warn('⚠️ Office.onReady() timeout - attempting registration anyway');
                    doRegistration();
                }
            }, 5000);
        }
    }
})();
