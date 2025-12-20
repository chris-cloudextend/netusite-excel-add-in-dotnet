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
const FUNCTIONS_VERSION = '3.0.5.237';  // Version marker for debugging - added BALANCECHANGE formula
console.log(`📦 XAVI functions.js loaded - version ${FUNCTIONS_VERSION}`);

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

/**
 * Suggest BS preload after detecting slow queries.
 * This uses a special localStorage key that taskpane always listens to.
 */
function suggestBSPreload(periods, queryTimeMs) {
    const now = Date.now();
    
    // Don't spam suggestions
    if (now - lastBsPreloadSuggestion < BS_SUGGESTION_COOLDOWN_MS) {
        console.log(`🔇 BS preload suggestion suppressed (cooldown)`);
        return;
    }
    
    lastBsPreloadSuggestion = now;
    
    // Send suggestion to taskpane via special localStorage key
    // Taskpane will show a persistent toast with action button
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
// LRU CACHE - Bounded cache with Least Recently Used eviction
// Prevents memory growth over long Excel sessions
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
        return cache.type.get(cacheKey);
    }
    
    try {
        // Use POST to avoid exposing account numbers in URLs/logs
        const response = await fetch(`${SERVER_URL}/account/type`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ account: String(account) })
        });
        if (response.ok) {
            const type = await response.text();
            cache.type.set(cacheKey, type);
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
                const types = data.types || {};  // Backend returns 'types'
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
function getFilterKey(params) {
    const sub = String(params.subsidiary || '').trim();
    const dept = String(params.department || '').trim();
    const loc = String(params.location || '').trim();
    const cls = String(params.classId || '').trim();
    return `${sub}|${dept}|${loc}|${cls}`;
}

// Helper function to parse filter key back to filter object
function parseFilterKey(filterKey) {
    const parts = filterKey.split('|');
    return {
        subsidiary: parts[0] || '',
        department: parts[1] || '',
        location: parts[2] || '',
        classId: parts[3] || ''
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
    // CUMULATIVE BS QUERIES: Handle empty fromPeriod separately
    // These need direct /balance API calls (cumulative from inception)
    // ================================================================
    const cumulativeItems = [];
    const regularItems = [];
    
    for (const item of pending) {
        const { fromPeriod, toPeriod } = item.params;
        if ((!fromPeriod || fromPeriod === '') && toPeriod && toPeriod !== '') {
            cumulativeItems.push(item);
        } else {
            regularItems.push(item);
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
            const { account, fromPeriod, toPeriod, subsidiary, department, location, classId, accountingBook } = params;
            
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
                        } catch (parseError) {
                            // JSON parsing failed - try to get raw text for debugging
                            console.error(`   ❌ JSON parse failed: ${parseError.message}`);
                            // Note: response body already consumed, can't read again
                            value = 0;
                        }
                        
                        if (errorCode) {
                            // Return error code to Excel cell instead of 0
                            console.log(`   ⚠️ Cumulative result: ${account} = ${errorCode}`);
                            items.forEach(item => item.resolve(errorCode));
                        } else {
                            console.log(`   ✅ Cumulative result: ${account} = ${value.toLocaleString()}`);
                            cache.balance.set(cacheKey, value);
                            // Resolve ALL items waiting for this result
                            items.forEach(item => item.resolve(value));
                        }
                    }
                } else {
                    // HTTP error - return informative error code
                    // 522/523/524 are Cloudflare timeout errors
                    const errorCode = [408, 504, 522, 523, 524].includes(response.status) ? 'TIMEOUT' :
                                     response.status === 429 ? 'RATELIMIT' :
                                     response.status === 401 || response.status === 403 ? 'AUTHERR' :
                                     response.status >= 500 ? 'SERVERR' :
                                     'APIERR';
                    console.error(`   ❌ Cumulative API error: ${response.status} → ${errorCode}`);
                    items.forEach(item => item.resolve(errorCode));
                }
            } catch (error) {
                // Network error - return informative error code
                const errorCode = error.name === 'AbortError' ? 'TIMEOUT' : 'NETFAIL';
                console.error(`   ❌ Cumulative fetch error: ${error.message} → ${errorCode}`);
                items.forEach(item => item.resolve(errorCode));
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
    
    for (const [filterKey, groupItems] of filterGroups) {
        groupIndex++;
        const filters = parseFilterKey(filterKey);
        
        // Collect unique accounts and periods for THIS filter group
        const accounts = new Set();
        const periods = new Set();
        
        for (const item of groupItems) {
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
        
        // STEP 6: Resolve all pending promises for THIS filter group
        for (const item of groupItems) {
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
        const { account, fromPeriod, toPeriod, subsidiary } = params;
        
        // For cumulative queries (empty fromPeriod), use toPeriod for lookup
        const lookupPeriod = (fromPeriod && fromPeriod !== '') ? fromPeriod : toPeriod;
        
        // Try to get value from localStorage cache (skip if subsidiary filter)
        let value = checkLocalStorageCache(account, fromPeriod, toPeriod, subsidiary);
        
        // Fallback to fullYearCache (skip if subsidiary filter)
        if (value === null) {
            value = checkFullYearCache(account, lookupPeriod, subsidiary);
        }
        
        if (value !== null) {
            resolve(value);
            cache.balance.set(cacheKey, value);
            resolved++;
        } else {
            // No value found - resolve with 0 (account has no transactions)
            resolve(0);
            failed++;
        }
        
        pendingRequests.balance.delete(cacheKey);
    }
    
    console.log(`   Resolved: ${resolved}, Not in cache (set to 0): ${failed}`);
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
function checkLocalStorageCache(account, period, toPeriod = null, subsidiary = '') {
    try {
        // Skip localStorage when subsidiary filter is specified (not subsidiary-aware)
        if (subsidiary && subsidiary !== '') return null;
        
        const timestamp = localStorage.getItem(STORAGE_TIMESTAMP_KEY);
        if (!timestamp) return null;
        
        const cacheAge = Date.now() - parseInt(timestamp);
        if (cacheAge > STORAGE_TTL) return null;
        
        const cached = localStorage.getItem(STORAGE_KEY);
        if (!cached) return null;
        
        const balances = JSON.parse(cached);
        const lookupPeriod = (period && period !== '') ? period : toPeriod;
        
        if (lookupPeriod && balances[account] && balances[account][lookupPeriod] !== undefined) {
            return balances[account][lookupPeriod];
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
// UTILITY: Convert date or date serial to "Mon YYYY" format
// ============================================================================
function convertToMonthYear(value, isFromPeriod = true) {
    // If empty, return empty string
    if (!value || value === '') return '';
    
    // If already in "Mon YYYY" format, return as-is
    if (typeof value === 'string' && /^[A-Za-z]{3}\s+\d{4}$/.test(value.trim())) {
        return value.trim();
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
                console.log(`   📅 Year-only string "${value}" → ${isFromPeriod ? 'Jan' : 'Dec'} ${year}`);
                return isFromPeriod ? `Jan ${year}` : `Dec ${year}`;
            }
        }
    }
    
    // IMPORTANT: Handle numeric year (Excel passes cell value 2024 as number, not string)
    // Check if the number looks like a year (1900-2100) rather than an Excel date serial
    // Excel date serial for year 2024 would be around 45,000+
    if (typeof value === 'number' && value >= 1900 && value <= 2100 && Number.isInteger(value)) {
        console.log(`   📅 Year-only number ${value} → ${isFromPeriod ? 'Jan' : 'Dec'} ${value}`);
        return isFromPeriod ? `Jan ${value}` : `Dec ${value}`;
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
        // Try to parse as date string
        date = new Date(value);
        if (isNaN(date.getTime())) {
            // Not a valid date, return original
            return String(value);
        }
    } else {
        // Unknown type, return original
        return String(value);
    }
    
    // Convert Date to "Mon YYYY" format
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 
                       'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = monthNames[date.getMonth()];
    const year = date.getFullYear();
    
    return `${month} ${year}`;
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
        if (!titleBatchTimer) {
            console.log(`⏱️ Starting TITLE batch timer (${TITLE_BATCH_DELAY}ms)`);
            titleBatchTimer = setTimeout(() => {
                processTitleBatchQueue().catch(err => {
                    console.error('❌ TITLE batch processing error:', err);
                });
            }, TITLE_BATCH_DELAY);
        }
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
        const types = data.types || {};
        
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
        if (!typeBatchTimer) {
            console.log(`⏱️ Starting TYPE batch timer (${TYPE_BATCH_DELAY}ms)`);
            typeBatchTimer = setTimeout(() => {
                processTypeBatchQueue().catch(err => {
                    console.error('❌ TYPE batch processing error:', err);
                });
            }, TYPE_BATCH_DELAY);
        }
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
    
    const cacheKey = getCacheKey('parent', { account });
    
    // Check cache FIRST
    if (!cache.parent) cache.parent = new Map();
    if (cache.parent.has(cacheKey)) {
        cacheStats.hits++;
        console.log(`⚡ CACHE HIT [parent]: ${account}`);
        return cache.parent.get(cacheKey);
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
        const response = await fetch(`${SERVER_URL}/account/parent`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ account: String(account) }),
            signal
        });
        if (!response.ok) {
            console.error(`Parent API error: ${response.status}`);
            return '#N/A';
        }
        
        const parent = await response.text();
        cache.parent.set(cacheKey, parent);
        console.log(`💾 Cached parent: ${account} → "${parent}"`);
        return parent;
        
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
    try {
        const clearSignal = localStorage.getItem('netsuite_cache_clear_signal');
        if (clearSignal) {
            const { timestamp, reason } = JSON.parse(clearSignal);
            if (Date.now() - timestamp < 10000) {
                console.log(`🔄 Cache cleared (${reason})`);
                cache.balance.clear();
                cache.budget.clear();
                if (typeof fullYearCache === 'object' && fullYearCache) {
                    Object.keys(fullYearCache).forEach(k => delete fullYearCache[k]);
                }
                fullYearCacheTimestamp = null;
                localStorage.removeItem('netsuite_cache_clear_signal');
            } else {
                localStorage.removeItem('netsuite_cache_clear_signal');
            }
        }
    } catch (e) { /* ignore */ }
    
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
            return '#MISSING_ACCT#';
        }
        
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
            return "#SYNTAX!";
        }
        
        // Convert date values to "Mon YYYY" format (supports both dates and period strings)
        // For year-only format ("2025"), expand to "Jan 2025" and "Dec 2025"
        const rawFrom = fromPeriod;
        const rawTo = toPeriod;
        fromPeriod = convertToMonthYear(fromPeriod, true);   // true = isFromPeriod
        toPeriod = convertToMonthYear(toPeriod, false);      // false = isToPeriod
        
        // Debug log the period conversion
        console.log(`📅 BALANCE periods: ${rawFrom} → "${fromPeriod}", ${rawTo} → "${toPeriod}"`);
        
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
        // PRELOAD COORDINATION: If Prep Data is running, wait for it
        // Uses localStorage for cross-context communication
        // ================================================================
        if (isPreloadInProgress()) {
            console.log(`⏳ Preload in progress - waiting for cache (${account}/${fromPeriod || toPeriod})`);
            await waitForPreload();
            console.log(`✅ Preload complete - checking cache`);
            
            // After preload completes, check caches - should be populated now!
            // Check in-memory cache
            if (cache.balance.has(cacheKey)) {
                console.log(`✅ Post-preload cache hit (memory): ${account}`);
                cacheStats.hits++;
                return cache.balance.get(cacheKey);
            }
            
            // Check localStorage cache (skip if subsidiary filter - localStorage not subsidiary-aware)
            const localStorageValue = checkLocalStorageCache(account, fromPeriod, toPeriod, subsidiary);
            if (localStorageValue !== null) {
                console.log(`✅ Post-preload cache hit (localStorage): ${account}`);
                cacheStats.hits++;
                cache.balance.set(cacheKey, localStorageValue);
                return localStorageValue;
            }
            
            // Check fullYearCache (skip if subsidiary filter - fullYearCache not subsidiary-aware)
            const fyValue = checkFullYearCache(account, fromPeriod || toPeriod, subsidiary);
            if (fyValue !== null) {
                console.log(`✅ Post-preload cache hit (fullYearCache): ${account}`);
                cacheStats.hits++;
                cache.balance.set(cacheKey, fyValue);
                return fyValue;
            }
            
            console.log(`⚠️ Post-preload cache miss - will query NetSuite: ${account}`);
        }
        
        // ================================================================
        // BUILD MODE DETECTION: Detect rapid formula creation (drag/paste)
        // More aggressive detection - lower threshold, wider time window
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
            console.log(`🔨 BUILD MODE: Detected ${formulaCreationCount} formulas in ${BUILD_MODE_WINDOW_MS}ms`);
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
        
        // ================================================================
        // CHECK FOR CACHE INVALIDATION SIGNAL (from Refresh Selected)
        // ================================================================
        const lookupPeriod = fromPeriod || toPeriod;
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
        
        // Check localStorage cache (BUT NOT for subsidiary-filtered queries!)
        // localStorage is keyed by account+period only, not subsidiary
        // So we skip it when subsidiary is specified to avoid returning wrong values
        const localStorageValue = checkLocalStorageCache(account, fromPeriod, toPeriod, subsidiary);
        if (localStorageValue !== null) {
            cacheStats.hits++;
            // Also save to in-memory cache for next time
            cache.balance.set(cacheKey, localStorageValue);
            return localStorageValue;
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
            if (!toPeriod || toPeriod === '') {
                console.log(`⏳ BUILD MODE: Skipping ${account} - period not yet resolved`);
                return new Promise((resolve) => {
                    // Return a pending value that Excel will retry
                    setTimeout(() => resolve('#BUSY'), 100);
                });
            }
            
            console.log(`🔨 BUILD MODE: Queuing ${account}/${fromPeriod || '(cumulative)'} → ${toPeriod}`);
            return new Promise((resolve, reject) => {
                buildModePending.push({ cacheKey, params, resolve, reject });
            });
        }
        
        // ================================================================
        // NORMAL MODE: Cache miss - add to batch queue and return Promise
        // 
        // VALIDATION: Skip incomplete requests (cell references not yet resolved)
        // Excel will re-evaluate when the cell reference resolves
        // ================================================================
        
        // For cumulative (BS) requests: toPeriod required
        // For period-range (P&L) requests: both required (toPeriod at minimum)
        if (!toPeriod || toPeriod === '') {
            console.log(`⏳ Skipping ${account} - period not yet resolved, will retry`);
            return new Promise((resolve) => {
                setTimeout(() => resolve('#BUSY'), 100);
            });
        }
        
        cacheStats.misses++;
        
        // In full refresh mode, queue silently (task pane will trigger processFullRefresh)
        if (!isFullRefreshMode) {
            console.log(`📥 CACHE MISS [balance]: ${account} (${fromPeriod || '(cumulative)'} to ${toPeriod}) → queuing`);
        }
        
        // Return a Promise that will be resolved by the batch processor
        return new Promise((resolve, reject) => {
            console.log(`📥 QUEUED: ${account} for ${fromPeriod || '(cumulative)'} → ${toPeriod}`);
            
            pendingRequests.balance.set(cacheKey, {
                params,
                resolve,
                reject,
                timestamp: Date.now()
            });
            
            console.log(`   Queue size now: ${pendingRequests.balance.size}`);
            console.log(`   isFullRefreshMode: ${isFullRefreshMode}`);
            console.log(`   batchTimer exists: ${!!batchTimer}`);
            
            // In full refresh mode, DON'T start the batch timer
            // The task pane will explicitly call processFullRefresh() when ready
            if (!isFullRefreshMode) {
                // Start batch timer if not already running (Mode 1: small batches)
                if (!batchTimer) {
                    console.log(`⏱️ STARTING batch timer (${BATCH_DELAY}ms)`);
                    batchTimer = setTimeout(() => {
                        console.log('⏱️ Batch timer FIRED!');
                        batchTimer = null;
                        processBatchQueue().catch(err => {
                            console.error('❌ Batch processing error:', err);
                        });
                    }, BATCH_DELAY);
                } else {
                    console.log('   Timer already running, request will be batched');
                }
            } else {
                console.log('   Full refresh mode - NOT starting timer');
            }
        });
        
    } catch (error) {
        console.error('BALANCE error:', error);
        return '#ERROR#';
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
 * @returns {Promise<number|string>} The change in balance, or error code
 * @requiresAddress
 */
async function BALANCECHANGE(account, fromPeriod, toPeriod, subsidiary, department, location, classId, accountingBook) {
    try {
        // Normalize account number
        account = normalizeAccountNumber(account);
        
        if (!account) {
            console.error('❌ BALANCECHANGE: account parameter is required');
            return '#MISSING_ACCT#';
        }
        
        // Convert date values to "Mon YYYY" format
        fromPeriod = convertToMonthYear(fromPeriod, true);
        toPeriod = convertToMonthYear(toPeriod, false);
        
        if (!fromPeriod || !toPeriod) {
            console.error('❌ BALANCECHANGE: both fromPeriod and toPeriod are required');
            return '#MISSING_PERIOD#';
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
            return errorCode;
        }
        
        const data = await response.json();
        
        // Check for error in response
        if (data.error) {
            console.log(`⚠️ BALANCECHANGE: ${account} = ${data.error}`);
            // Cache the error too (for consistency)
            cache.balance.set(cacheKey, data.error);
            return data.error;
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
        return 'NETFAIL';
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
            return '#MISSING_ACCT#';
        }
        
        // Convert date values to "Mon YYYY" format (supports both dates and period strings)
        // For year-only format ("2025"), expand to "Jan 2025" and "Dec 2025"
        fromPeriod = convertToMonthYear(fromPeriod, true);   // true = isFromPeriod
        toPeriod = convertToMonthYear(toPeriod, false);      // false = isToPeriod
        
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
                    return '#TIMEOUT#';
                }
                return '#API_ERR#';
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
                return '#OFFLINE#';
            }
            return '#ERROR#';
        }
        
    } catch (error) {
        console.error('BUDGET error:', error);
        return '#ERROR#';
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
    
    // ================================================================
    // CUMULATIVE BS QUERIES: Handle empty fromPeriod separately
    // These need direct /balance API calls (cumulative from inception)
    // The batch endpoint only returns period activity, not cumulative totals
    // ================================================================
    const cumulativeRequests = [];
    const regularRequests = [];
    
    for (const [cacheKey, request] of requests) {
        const { fromPeriod, toPeriod } = request.params;
        // Cumulative = empty fromPeriod with a toPeriod
        if ((!fromPeriod || fromPeriod === '') && toPeriod && toPeriod !== '') {
            cumulativeRequests.push([cacheKey, request]);
        } else {
            regularRequests.push([cacheKey, request]);
        }
    }
    
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
        
        // Log multi-period detection
        if (bsPeriodsInBatch.size > 1) {
            console.log(`   📅 MULTI-PERIOD DETECTED: ${Array.from(bsPeriodsInBatch).join(', ')} - consider preloading both!`);
        }
        
        // Rate limiting to avoid NetSuite 429 CONCURRENCY_LIMIT_EXCEEDED errors
        const RATE_LIMIT_DELAY_BATCH = 150; // ms between API calls
        const rateLimitSleepBatch = (ms) => new Promise(resolve => setTimeout(resolve, ms));
        
        // Process each UNIQUE cumulative request once
        for (const [cacheKey, { params, requests }] of uniqueRequests) {
            const { account, fromPeriod, toPeriod, subsidiary, department, location, classId, accountingBook } = params;
            
            // ================================================================
            // TRY WILDCARD CACHE RESOLUTION FIRST
            // If account has *, try to sum matching accounts from cache
            // ================================================================
            if (account.includes('*')) {
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
                
                // Request breakdown for wildcards so we can cache individual accounts
                if (isWildcard) {
                    apiParams.append('include_breakdown', 'true');
                }
                
                const waitingCount = requests.length > 1 ? ` (${requests.length} formulas waiting)` : '';
                console.log(`   📤 Cumulative API: ${account} through ${toPeriod}${isWildcard ? ' (with breakdown)' : ''}${waitingCount}`);
                
                // Rate limit: wait before making request if we've already made calls
                // Prevents NetSuite 429 CONCURRENCY_LIMIT_EXCEEDED errors
                if (apiCalls > 0) {
                    await rateLimitSleepBatch(RATE_LIMIT_DELAY_BATCH);
                }
                apiCalls++;
                
                // Track query timing for slow query detection
                const queryStartTime = Date.now();
                const response = await fetch(`${SERVER_URL}/balance?${apiParams.toString()}`);
                
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
                            // Return error code to Excel cell instead of 0
                            console.log(`   ⚠️ Cumulative result: ${account} = ${errorCode}`);
                            requests.forEach(r => r.resolve(errorCode));
                        } else {
                            console.log(`   ✅ Cumulative result: ${account} = ${value.toLocaleString()} (${(queryTimeMs / 1000).toFixed(1)}s)`);
                            cache.balance.set(cacheKey, value);
                            // Resolve ALL requests waiting for this result
                            requests.forEach(r => r.resolve(value));
                        }
                    }
                } else {
                    // HTTP error - return informative error code
                    // 522/523/524 are Cloudflare timeout errors
                    const errorCode = [408, 504, 522, 523, 524].includes(response.status) ? 'TIMEOUT' :
                                     response.status === 429 ? 'RATELIMIT' :
                                     response.status === 401 || response.status === 403 ? 'AUTHERR' :
                                     response.status >= 500 ? 'SERVERR' :
                                     'APIERR';
                    console.error(`   ❌ Cumulative API error: ${response.status} → ${errorCode}`);
                    requests.forEach(r => r.resolve(errorCode));
                }
            } catch (error) {
                // Network error - return informative error code
                const errorCode = error.name === 'AbortError' ? 'TIMEOUT' : 'NETFAIL';
                console.error(`   ❌ Cumulative fetch error: ${error.message} → ${errorCode}`);
                requests.forEach(r => r.resolve(errorCode));
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
    
    // If no regular requests, we're done
    if (regularRequests.length === 0) {
        const elapsed = ((Date.now() - batchStartTime) / 1000).toFixed(2);
        console.log(`\n✅ BATCH COMPLETE in ${elapsed}s (${cumulativeRequests.length} cumulative only)`);
        return;
    }
    
    // Continue with regular batch processing for period-based requests
    console.log(`📦 Processing ${regularRequests.length} regular (period-based) requests...`);
    
    // Group by filters ONLY (not periods) - this allows smart batching
    // Example: 1 account × 12 months = 1 batch (not 12 batches)
    // Example: 100 accounts × 1 month = 2 batches (chunked by accounts)
    // Example: 100 accounts × 12 months = 2 batches (all periods together)
    const groups = new Map();
    for (const [cacheKey, request] of regularRequests) {
        const {params} = request;
        const filterKey = JSON.stringify({
            subsidiary: params.subsidiary || '',
            department: params.department || '',
            location: params.location || '',
            class: params.classId || ''
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
                        })
                    });
                
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
    
    const totalBatchTime = ((Date.now() - batchStartTime) / 1000).toFixed(1);
    console.log('========================================');
    console.log(`✅ BATCH PROCESSING COMPLETE in ${totalBatchTime}s`);
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
        period = convertToMonthYear(period, false);  // false = use Dec for year-only
        
        if (!period) {
            console.error('❌ RETAINEDEARNINGS: period is required');
            return '#MISSING_PERIOD#';
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
                console.log(`🚫 RETAINEDEARNINGS ${period}: Queue cleared, formula will re-evaluate`);
                return '#BUSY!';
            }
            throw lockError;
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
                    // Return #ERROR# for non-timeout errors, #TIMEOUT# for timeouts
                    if (response.status === 524 || response.status === 522 || response.status === 504) {
                        return '#TIMEOUT#';
                    }
                    return '#ERROR#';
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
                    return '#NODATA#';
                }
                
                const value = parseFloat(data.value);
                if (isNaN(value)) {
                    console.error(`❌ Retained Earnings (${period}): Invalid number: ${data.value}`);
                    if (toastId) {
                        updateBroadcastToast(toastId, 'Retained Earnings Error', `Invalid value: ${data.value}`, 'error');
                        setTimeout(() => removeBroadcastToast(toastId), 5000);
                    }
                    return '#ERROR#';
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
                    return '#OFFLINE#';
                }
                return '#ERROR#';
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
        return '#ERROR#';
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
            return '#MISSING_PERIOD#';
        }
        
        // Convert fromPeriod - for year-only, use Jan (start of year)
        const convertedFromPeriod = convertToMonthYear(fromPeriod, true);  // true = use Jan
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
            convertedToPeriod = convertToMonthYear(toPeriod, false);  // false = use Dec for year-only
            console.log(`   📅 toPeriod conversion: ${toPeriod} → "${convertedToPeriod}"`);
        }
        
        if (!convertedFromPeriod) {
            console.error('❌ NETINCOME: Could not parse fromPeriod:', rawFromPeriod);
            return '#INVALID_PERIOD#';
        }
        
        if (!convertedToPeriod) {
            console.error('❌ NETINCOME: Could not parse toPeriod:', rawToPeriod);
            return '#INVALID_PERIOD#';
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
                console.log(`🚫 NETINCOME ${rangeDesc}: Queue cleared, formula will re-evaluate`);
                return '#BUSY!';
            }
            throw lockError;
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
                    // Return #ERROR# for non-timeout errors, #TIMEOUT# for timeouts
                    if (response.status === 524 || response.status === 522 || response.status === 504) {
                        return '#TIMEOUT#';
                    }
                    return '#ERROR#';
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
                    return '#NODATA#';
                }
                
                const value = parseFloat(data.value);
                if (isNaN(value)) {
                    console.error(`❌ Net Income (${rangeDesc}): Invalid number: ${data.value}`);
                    if (toastId) {
                        updateBroadcastToast(toastId, 'Net Income Error', `Invalid value: ${data.value}`, 'error');
                        setTimeout(() => removeBroadcastToast(toastId), 5000);
                    }
                    return '#ERROR#';
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
                    return '#OFFLINE#';
                }
                return '#ERROR#';
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
        return '#ERROR#';
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
        // Normalize account type
        const normalizedType = String(accountType || '').trim();
        if (!normalizedType) {
            console.error('❌ TYPEBALANCE: accountType is required');
            return '#MISSING_TYPE#';
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
                return '#INVALID_TYPE#';
            }
        }
        
        // Determine if Balance Sheet based on type
        const isBalanceSheet = useSpecial 
            ? BS_SPECIAL_TYPES.includes(normalizedType) || !PL_SPECIAL_TYPES.includes(normalizedType)
            : BS_TYPES.includes(normalizedType);
        
        // Convert periods
        let convertedToPeriod = convertToMonthYear(toPeriod, false); // false = use Dec for year-only
        if (!convertedToPeriod) {
            console.error('❌ TYPEBALANCE: toPeriod is required');
            return '#MISSING_PERIOD#';
        }
        
        let convertedFromPeriod = '';
        if (isBalanceSheet) {
            // BS types: cumulative from inception, ignore fromPeriod
            const modeLabel = useSpecial ? 'special account' : 'account';
            console.log(`📊 TYPEBALANCE: BS ${modeLabel} type "${normalizedType}" - cumulative through ${convertedToPeriod}`);
        } else {
            // P&L types: need fromPeriod
            convertedFromPeriod = convertToMonthYear(fromPeriod, true); // true = use Jan for year-only
            if (!convertedFromPeriod) {
                console.error('❌ TYPEBALANCE: fromPeriod is required for P&L account types');
                return '#MISSING_PERIOD#';
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
        
        // Check in-memory cache first
        if (cache.typebalance && cache.typebalance[cacheKey] !== undefined) {
            console.log(`📋 TYPEBALANCE cache hit (memory): ${cacheKey} = ${cache.typebalance[cacheKey]}`);
            return cache.typebalance[cacheKey];
        }
        
        // Check localStorage if in-memory cache misses
        // This is CRITICAL when functions.html loads AFTER taskpane has pre-fetched data
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
                localStorageStatus = `has ${localStorageKeyCount} keys but NOT our key`;
            } else {
                localStorageStatus = 'EMPTY (no data from taskpane)';
            }
        } catch (e) {
            localStorageStatus = `ERROR: ${e.message}`;
            console.warn('⚠️ localStorage read failed:', e.message);
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
                        return '#TIMEOUT#';
                    }
                    return '#API_ERR#';
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
                    return '#OFFLINE#';
                }
                return '#ERROR#';
            }
        })();
        
        inFlightRequests.set(cacheKey, requestPromise);
        return await requestPromise;
        
    } catch (error) {
        console.error('TYPEBALANCE error:', error);
        return '#ERROR#';
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
        period = convertToMonthYear(period, false);  // false = use Dec for year-only
        
        if (!period) {
            console.error('❌ CTA: period is required');
            return '#MISSING_PERIOD#';
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
                console.log(`🚫 CTA ${period}: Queue cleared, formula will re-evaluate`);
                return '#BUSY!';
            }
            throw lockError;
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
                        // All retries exhausted - return #TIMEOUT#
                        if (toastId) {
                            updateBroadcastToast(toastId, 'CTA Timed Out', 
                                `Tunnel timeout after ${maxRetries} attempts. Cell shows #TIMEOUT#. Refresh single cell to retry, or delete formula for SUM to work.`, 'error');
                            setTimeout(() => removeBroadcastToast(toastId), 8000);
                        }
                        return '#TIMEOUT#';
                    }
                    
                    if (!response.ok) {
                        const errorText = await response.text();
                        console.error(`CTA API error: ${response.status}`, errorText);
                        if (toastId) {
                            updateBroadcastToast(toastId, 'CTA Failed', `Error: ${response.status}`, 'error');
                            setTimeout(() => removeBroadcastToast(toastId), 5000);
                        }
                        return '#ERROR#';
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
                        return '#NODATA#';
                    }
                    
                    const value = parseFloat(data.value);
                    if (isNaN(value)) {
                        console.error(`❌ CTA (${period}): Invalid number: ${data.value}`);
                        if (toastId) {
                            updateBroadcastToast(toastId, 'CTA Error', `Invalid value: ${data.value}`, 'error');
                            setTimeout(() => removeBroadcastToast(toastId), 5000);
                        }
                        return '#ERROR#';
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
                        return '#OFFLINE#';
                    }
                    
                    if (attempt >= maxRetries) {
                        if (toastId) {
                            updateBroadcastToast(toastId, 'CTA Failed', 
                                `Failed after ${maxRetries} attempts. Cell shows #TIMEOUT#.`, 'error');
                            setTimeout(() => removeBroadcastToast(toastId), 5000);
                        }
                        return '#TIMEOUT#';
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
            return '#TIMEOUT#';
        })().finally(() => {
            inFlightRequests.delete(cacheKey);
            // CRITICAL: Release the semaphore lock to allow next formula to run
            releaseSpecialFormulaLock(cacheKey);
        });
        
        inFlightRequests.set(cacheKey, requestPromise);
        return await requestPromise;
        
    } catch (error) {
        console.error('CTA error:', error);
        return '#ERROR#';
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
// CRITICAL: The manifest ALREADY defines namespace 'NS'
// We just register individual functions - Excel adds the XAVI. prefix automatically!
if (typeof CustomFunctions !== 'undefined') {
    CustomFunctions.associate('NAME', NAME);
    CustomFunctions.associate('TYPE', TYPE);
    CustomFunctions.associate('PARENT', PARENT);
    CustomFunctions.associate('BALANCE', BALANCE);
    CustomFunctions.associate('BALANCECHANGE', BALANCECHANGE);
    CustomFunctions.associate('BUDGET', BUDGET);
    CustomFunctions.associate('RETAINEDEARNINGS', RETAINEDEARNINGS);
    CustomFunctions.associate('NETINCOME', NETINCOME);
    CustomFunctions.associate('TYPEBALANCE', TYPEBALANCE);
    CustomFunctions.associate('CTA', CTA);
    CustomFunctions.associate('CLEARCACHE', CLEARCACHE);
    console.log('✅ Custom functions registered with Excel');
} else {
    console.error('❌ CustomFunctions not available!');
}