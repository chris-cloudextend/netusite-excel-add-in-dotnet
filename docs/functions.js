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
const FUNCTIONS_VERSION = '4.0.6.159';  // Revert: Use full-year refresh for 3+ periods (remove 3-column batching)
console.log(`📦 XAVI functions.js loaded - version ${FUNCTIONS_VERSION}`);

// ============================================================================
// SINGLE PROMISE PER PERIOD (Architectural Fix)
// All cells for the same period await the EXACT SAME Promise that resolves
// WITH the balance data, ensuring simultaneous resolution
// ============================================================================

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
// VALIDATION: Check if subsidiary/accounting book combination is valid
// Returns null if valid, error string if invalid
// ============================================================================
async function validateSubsidiaryAccountingBook(subsidiary, accountingBook) {
    // Primary book or no subsidiary - always valid
    if (!accountingBook || accountingBook === '1' || accountingBook === '' || !subsidiary || subsidiary === '') {
        return null; // Valid
    }
    
    // CRITICAL FIX: Check for transition flag - be lenient during accounting book changes
    // This prevents #VALUE errors while Q3 is being updated
    try {
        const transitionKey = `netsuite_book_transition_${accountingBook}`;
        const transitionData = localStorage.getItem(transitionKey);
        if (transitionData) {
            const transition = JSON.parse(transitionData);
            const age = Date.now() - transition.timestamp;
            if (age < 5000) { // 5 second window
                console.log(`🔓 [VALIDATION] Transition in progress (${Math.round(age/1000)}s old) - allowing request to proceed`);
                return null; // Allow during transition
            } else {
                // Stale transition flag - remove it
                localStorage.removeItem(transitionKey);
            }
        }
    } catch (e) {
        // Ignore transition check errors
    }
    
    try {
        const response = await fetch(`${SERVER_URL}/lookups/accountingbook/${accountingBook}/subsidiaries`);
        if (!response.ok) {
            // On API error, allow the request to proceed (backend will validate)
            return null;
        }
        
        const data = await response.json();
        
        if (data.allSubsidiaries) {
            return null; // Primary book - always valid
        }
        
        const enabledSubs = data.subsidiaries || [];
        if (enabledSubs.length === 0) {
            return 'INVALID_BOOK'; // No subsidiaries enabled for this book
        }
        
        // Check if subsidiary is valid (base name or consolidated)
        const baseName = String(subsidiary).replace(/\s*\(Consolidated\)\s*$/i, '').trim();
        const isConsolidated = String(subsidiary).toLowerCase().includes('consolidated');
        
        const isValid = enabledSubs.some(s => {
            // Exact match (including consolidated)
            if (s.name === subsidiary) {
                return true;
            }
            // Base name match
            if (s.name === baseName) {
                // If looking for consolidated version, check canConsolidate flag
                if (isConsolidated) {
                    return s.canConsolidate === true;
                }
                // Base subsidiary is always valid if in list
                return true;
            }
            // Check consolidated version name
            if (`${s.name} (Consolidated)` === subsidiary && s.canConsolidate) {
                return true;
            }
            return false;
        });
        
        if (!isValid) {
            return 'INVALID_COMBINATION'; // Subsidiary not enabled for this book
        }
        
        return null; // Valid
    } catch (e) {
        // On error, allow request to proceed (backend will validate)
        console.warn('⚠️ Validation error (allowing request):', e.message);
        return null;
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

// ============================================================================
// COLUMN-BASED BALANCE SHEET BATCHING - Feature Flag
// ============================================================================

/**
 * Feature flag for column-based balance sheet batching.
 * When false, behavior must be byte-for-byte identical to current production.
 * When true, column-based batching is enabled (Phase 2+).
 * 
 * ENABLED: Column-based batching uses translated ending balances directly from NetSuite,
 * matching Balance Sheet report semantics exactly (including foreign currency accounts).
 */
const USE_COLUMN_BASED_BS_BATCHING = true;

/**
 * PHASE 4: Validation flag for column-based balance sheet batching.
 * When true, enables dual-run validation: per-cell (primary) + column-based (async validation).
 * Independent of USE_COLUMN_BASED_BS_BATCHING - can be enabled while execution flag is false.
 * 
 * DISABLED: Column-based batching is now the primary execution path. Validation overhead removed.
 */
const VALIDATE_COLUMN_BASED_BS_BATCHING = false;

/**
 * Debug flag for column-based batching detection logging.
 * Only logs when true - no behavior changes.
 */
const DEBUG_COLUMN_BASED_BS_BATCHING = false; // Disabled: verbose debug logging
const DEBUG_VERBOSE_LOGGING = false; // Set to true for detailed console logs (cache hits, budget lookups, etc.)

// ============================================================================
// BALANCE SHEET GRID BATCHING - Helper Functions
// ============================================================================

/**
 * Parse period string (e.g., "Jan 2025") to Date object (first day of month).
 * Returns null if invalid.
 */
function parsePeriodToDate(period) {
    if (!period || typeof period !== 'string') return null;
    
    const match = period.match(/^([A-Za-z]{3})\s+(\d{4})$/);
    if (!match) return null;
    
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 
                        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthStr = match[1];
    const year = parseInt(match[2], 10);
    const month = monthNames.indexOf(monthStr);
    
    if (month === -1) return null;
    
    return new Date(year, month, 1);
}

/**
 * Infer anchor date for balance sheet grid batching.
 * Anchor = day before the earliest toPeriod in the grid (last day of previous month).
 * 
 * @param {Array<string>} periods - Array of period strings (e.g., ["Jan 2025", "Feb 2025"])
 * @returns {string} - Anchor date in "YYYY-MM-DD" format, or null if invalid
 */
function inferAnchorDate(periods) {
    if (!periods || periods.length === 0) return null;
    
    // Find earliest period
    const sortedPeriods = periods
        .map(p => parsePeriodToDate(p))
        .filter(d => d !== null)
        .sort((a, b) => a.getTime() - b.getTime());
    
    if (sortedPeriods.length === 0) return null;
    
    const earliestDate = sortedPeriods[0];
    
    // Anchor = day before earliest period (last day of previous month)
    const anchorDate = new Date(earliestDate);
    anchorDate.setDate(0); // Last day of previous month
    
    // Format as YYYY-MM-DD
    const year = anchorDate.getFullYear();
    const month = String(anchorDate.getMonth() + 1).padStart(2, '0');
    const day = String(anchorDate.getDate()).padStart(2, '0');
    
    return `${year}-${month}-${day}`;
}

// ============================================================================
// COLUMN-BASED BALANCE SHEET BATCHING - Filter Normalization
// ============================================================================

/**
 * Normalize filters for column-based batching.
 * 
 * CRITICAL: This is a duplicate utility (not refactored from existing getFilterKey)
 * to ensure zero impact on CFO Flash and Income Statement code paths.
 * 
 * Normalization rules:
 * - Sort keys alphabetically
 * - Normalize null vs empty string (both become empty string)
 * - Include accounting book, subsidiary, and all filter fields
 * - Return consistent JSON string for comparison
 * 
 * @param {Object} filters - Filter object (subsidiary, department, location, classId, accountingBook)
 * @returns {string} - Normalized filter key for grouping and caching
 */
function normalizeFiltersForColumnBatching(filters) {
    if (!filters || typeof filters !== 'object') {
        filters = {};
    }
    
    // Normalize: null/undefined/empty all become empty string
    // CRITICAL FIX: Normalize empty accountingBook to "1" (Primary Book) for consistent batching
    // This ensures formulas with accountingBook="" and accountingBook="1" are batched together
    let accountingBook = String(filters.accountingBook || '').trim();
    if (accountingBook === '' || accountingBook === '1') {
        accountingBook = '1'; // Normalize to "1" for Primary Book
    }
    const normalized = {
        subsidiary: String(filters.subsidiary || '').trim(),
        department: String(filters.department || '').trim(),
        location: String(filters.location || '').trim(),
        classId: String(filters.classId || '').trim(),
        accountingBook: accountingBook
    };
    
    // Sort keys alphabetically for consistent JSON stringification
    const sorted = {};
    Object.keys(normalized).sort().forEach(key => {
        sorted[key] = normalized[key];
    });
    
    return JSON.stringify(sorted);
}

// ============================================================================
// COLUMN-BASED BALANCE SHEET BATCHING - Grid Detection (Phase 1: Detection Only)
// ============================================================================

/**
 * Detect column-based balance sheet grid pattern.
 * 
 * PHASE 1: Detection and logging only - no behavior changes.
 * This function is called but results are ignored when feature flag is false.
 * 
 * Detection modes:
 * - Primary: Multiple accounts + multiple periods (columns)
 * - Secondary: Single period + multiple accounts (Excel recalc safety)
 * 
 * CRITICAL SAFETY CONSTRAINTS:
 * - Side-effect-free (read-only, no mutations)
 * - Synchronous (no await, no promises)
 * - Conservative (requires multiple accounts AND multiple periods for primary mode)
 * - Fallback-friendly (returns {eligible: false} on any ambiguity)
 * 
 * @param {Array} evaluatingRequests - Array of requests currently being evaluated
 * @returns {Object} - { eligible: boolean, columns?: Array, allAccounts?: Set, filters?: Object }
 */
function detectColumnBasedBSGrid(evaluatingRequests) {
    // Safety limits (fail-fast before any processing)
    const MAX_ACCOUNTS_PER_BATCH = 100;
    const MAX_PERIODS_PER_BATCH = 24;
    
    if (!evaluatingRequests || !Array.isArray(evaluatingRequests) || evaluatingRequests.length === 0) {
        if (DEBUG_COLUMN_BASED_BS_BATCHING) {
            console.log(`🔍 COLUMN-BASED BS DETECT: No requests - not eligible`);
        }
        return { eligible: false };
    }
    
    // Step 1: Filter to cumulative Balance Sheet requests only
    // Must be cumulative (no fromPeriod), must have toPeriod
    const bsCumulativeRequests = evaluatingRequests.filter(r => {
        const rParams = r.params || r;
        
        // Safety check
        if (!rParams || typeof rParams !== 'object') {
            return false;
        }
        
        // Must be cumulative (no fromPeriod)
        if (rParams.fromPeriod !== undefined && rParams.fromPeriod !== null && rParams.fromPeriod !== '') {
            return false;
        }
        
        // Must have toPeriod
        if (!rParams.toPeriod || rParams.toPeriod === '') {
            return false;
        }
        
        // Must not be BALANCECURRENCY (skip currency requests)
        const endpoint = r.endpoint || '/balance';
        if (endpoint === '/balancecurrency') {
            return false;
        }
        
        return true;
    });
    
    if (bsCumulativeRequests.length === 0) {
        if (DEBUG_COLUMN_BASED_BS_BATCHING) {
            console.log(`🔍 COLUMN-BASED BS DETECT: No cumulative BS requests - not eligible`);
        }
        return { eligible: false };
    }
    
    // Step 2: Group by column (toPeriod + normalized filters)
    // CRITICAL: Filter out requests for periods that are already fully cached
    // This prevents January (already resolved) from being included in batch queries when dragging to Feb/Mar
    const byColumn = new Map(); // Map<columnKey, {period, filters, accounts: Set}>
    const allAccounts = new Set();
    
    for (const request of bsCumulativeRequests) {
        const rParams = request.params || request;
        const rFilters = rParams.filters || rParams;
        
        // Check if this specific account+period is cached
        // If cached, skip it - don't include in batch (it will resolve from cache)
        const filtersHash = getFilterKey({
            subsidiary: rFilters.subsidiary || '',
            department: rFilters.department || '',
            location: rFilters.location || '',
            classId: rFilters.classId || '',
            accountingBook: rFilters.accountingBook || ''
        });
        const lookupPeriod = normalizePeriodKey(rParams.toPeriod, false);
        if (lookupPeriod) {
            const cachedValue = checkLocalStorageCache(rParams.account, null, rParams.toPeriod, rFilters.subsidiary || '', filtersHash);
            if (cachedValue !== null) {
                // This account+period is cached - skip it (will resolve from cache, no batch needed)
                continue;
            }
        }
        
        // Normalize filters for grouping
        const normalizedFilterKey = normalizeFiltersForColumnBatching(rFilters);
        const columnKey = `${rParams.toPeriod}::${normalizedFilterKey}`;
        
        if (!byColumn.has(columnKey)) {
            byColumn.set(columnKey, {
                period: rParams.toPeriod,
                filters: rFilters,
                accounts: new Set()
            });
        }
        
        const column = byColumn.get(columnKey);
        column.accounts.add(rParams.account);
        allAccounts.add(rParams.account);
    }
    
    // Step 3: Safety limit check
    if (allAccounts.size > MAX_ACCOUNTS_PER_BATCH) {
        if (DEBUG_COLUMN_BASED_BS_BATCHING) {
            console.log(`🔍 COLUMN-BASED BS DETECT: Too many accounts (${allAccounts.size} > ${MAX_ACCOUNTS_PER_BATCH}) - not eligible`);
        }
        return { eligible: false };
    }
    
    if (byColumn.size > MAX_PERIODS_PER_BATCH) {
        if (DEBUG_COLUMN_BASED_BS_BATCHING) {
            console.log(`🔍 COLUMN-BASED BS DETECT: Too many periods (${byColumn.size} > ${MAX_PERIODS_PER_BATCH}) - not eligible`);
        }
        return { eligible: false };
    }
    
    // Step 4: Primary mode - Multiple accounts + Multiple periods
    if (allAccounts.size >= 2 && byColumn.size >= 2) {
        // Verify all columns have same filters (required for batching)
        const firstColumn = Array.from(byColumn.values())[0];
        const firstFilterKey = normalizeFiltersForColumnBatching(firstColumn.filters);
        let allFiltersMatch = true;
        
        for (const column of byColumn.values()) {
            const columnFilterKey = normalizeFiltersForColumnBatching(column.filters);
            if (columnFilterKey !== firstFilterKey) {
                allFiltersMatch = false;
                break;
            }
        }
        
        if (!allFiltersMatch) {
            if (DEBUG_COLUMN_BASED_BS_BATCHING) {
                console.log(`🔍 COLUMN-BASED BS DETECT: Filters differ across columns - not eligible`);
            }
            return { eligible: false };
        }
        
        if (DEBUG_COLUMN_BASED_BS_BATCHING) {
            console.log(`🔍 COLUMN-BASED BS DETECT: ✅ PRIMARY MODE - ${allAccounts.size} accounts, ${byColumn.size} periods`);
        }
        
        return {
            eligible: true,
            mode: 'primary',
            columns: Array.from(byColumn.values()),
            allAccounts: allAccounts,
            filters: firstColumn.filters
        };
    }
    
    // Step 5: Secondary mode - Single period + Multiple accounts
    if (byColumn.size === 1 && allAccounts.size >= 2) {
        const column = Array.from(byColumn.values())[0];
        
        if (DEBUG_COLUMN_BASED_BS_BATCHING) {
            console.log(`🔍 COLUMN-BASED BS DETECT: ✅ SECONDARY MODE - ${allAccounts.size} accounts, 1 period (${column.period})`);
        }
        
        return {
            eligible: true,
            mode: 'secondary',
            columns: [column],
            allAccounts: allAccounts,
            filters: column.filters
        };
    }
    
    // Step 6: Not eligible (single account, or single period with single account)
    if (DEBUG_COLUMN_BASED_BS_BATCHING) {
        console.log(`🔍 COLUMN-BASED BS DETECT: Not eligible - ${allAccounts.size} account(s), ${byColumn.size} period(s)`);
    }
    
    return { eligible: false };
}

/**
 * Detect column-based Income Statement (P&L) grid pattern.
 * 
 * Similar to Balance Sheet grid detection, but for Income Statement accounts.
 * Processes periods (columns) first, then accounts (rows).
 * 
 * Detection modes:
 * - Primary: Multiple accounts + multiple periods (columns)
 * - Secondary: Single period + multiple accounts
 * 
 * @param {Array} evaluatingRequests - Array of requests currently being evaluated
 * @returns {Object} - { eligible: boolean, columns?: Array, allAccounts?: Set, filters?: Object }
 */
function detectColumnBasedPLGrid(evaluatingRequests) {
    // Safety limits (fail-fast before any processing)
    const MAX_ACCOUNTS_PER_BATCH = 200; // Higher limit for P&L (faster queries)
    const MAX_PERIODS_PER_BATCH = 12; // One year max
    
    if (!evaluatingRequests || !Array.isArray(evaluatingRequests) || evaluatingRequests.length === 0) {
        return { eligible: false };
    }
    
    // Step 1: Filter to Income Statement requests only
    // Must have both fromPeriod and toPeriod (or just toPeriod for single period)
    const plRequests = evaluatingRequests.filter(r => {
        const rParams = r.params || r;
        
        // Safety check
        if (!rParams || typeof rParams !== 'object') {
            return false;
        }
        
        // Must have toPeriod
        if (!rParams.toPeriod || rParams.toPeriod === '') {
            return false;
        }
        
        // For Income Statement, fromPeriod can be empty (single period) or same as toPeriod
        // Period ranges (fromPeriod !== toPeriod) are also valid
        
        return true;
    });
    
    if (plRequests.length === 0) {
        return { eligible: false };
    }
    
    // Step 2: Group by column (toPeriod + normalized filters)
    // Filter out requests for periods that are already cached
    const byColumn = new Map(); // Map<columnKey, {period, filters, accounts: Set}>
    const allAccounts = new Set();
    
    for (const request of plRequests) {
        const rParams = request.params || request;
        const rFilters = rParams.filters || rParams;
        
        // Check if this specific account+period is cached
        const filtersHash = getFilterKey({
            subsidiary: rFilters.subsidiary || '',
            department: rFilters.department || '',
            location: rFilters.location || '',
            classId: rFilters.classId || '',
            accountingBook: rFilters.accountingBook || ''
        });
        const lookupPeriod = normalizePeriodKey(rParams.toPeriod, false);
        if (lookupPeriod) {
            const cachedValue = checkLocalStorageCache(rParams.account, rParams.fromPeriod, rParams.toPeriod, rFilters.subsidiary || '', filtersHash);
            if (cachedValue !== null) {
                // This account+period is cached - skip it (will resolve from cache, no batch needed)
                continue;
            }
        }
        
        // Normalize filters for grouping
        const normalizedFilterKey = normalizeFiltersForColumnBatching(rFilters);
        const columnKey = `${rParams.toPeriod}::${normalizedFilterKey}`;
        
        if (!byColumn.has(columnKey)) {
            byColumn.set(columnKey, {
                period: rParams.toPeriod,
                filters: rFilters,
                accounts: new Set()
            });
        }
        
        const column = byColumn.get(columnKey);
        column.accounts.add(rParams.account);
        allAccounts.add(rParams.account);
    }
    
    // Step 3: Safety limit check
    if (allAccounts.size > MAX_ACCOUNTS_PER_BATCH) {
        return { eligible: false };
    }
    
    if (byColumn.size > MAX_PERIODS_PER_BATCH) {
        return { eligible: false };
    }
    
    // Step 4: Primary mode - Multiple accounts + Multiple periods
    if (allAccounts.size >= 2 && byColumn.size >= 2) {
        // Verify all columns have same filters (required for batching)
        const firstColumn = Array.from(byColumn.values())[0];
        const firstFilterKey = normalizeFiltersForColumnBatching(firstColumn.filters);
        let allFiltersMatch = true;
        
        for (const column of byColumn.values()) {
            const columnFilterKey = normalizeFiltersForColumnBatching(column.filters);
            if (columnFilterKey !== firstFilterKey) {
                allFiltersMatch = false;
                break;
            }
        }
        
        if (!allFiltersMatch) {
            return { eligible: false };
        }
        
        console.log(`🔍 COLUMN-BASED PL DETECT: ✅ PRIMARY MODE - ${allAccounts.size} accounts, ${byColumn.size} periods`);
        
        return {
            eligible: true,
            mode: 'primary',
            columns: Array.from(byColumn.values()),
            allAccounts: allAccounts,
            filters: firstColumn.filters
        };
    }
    
    // Step 5: Secondary mode - Single period + Multiple accounts
    if (byColumn.size === 1 && allAccounts.size >= 2) {
        const column = Array.from(byColumn.values())[0];
        
        console.log(`🔍 COLUMN-BASED PL DETECT: ✅ SECONDARY MODE - ${allAccounts.size} accounts, 1 period (${column.period})`);
        
        return {
            eligible: true,
            mode: 'secondary',
            columns: [column],
            allAccounts: allAccounts,
            filters: column.filters
        };
    }
    
    // Step 6: Not eligible
    return { eligible: false };
}

/**
 * PHASE 4: Validation tracking for column-based batch validation.
 * Lightweight in-memory counters scoped to session.
 * No persistence, no telemetry.
 */
const validationStats = {
    totalAttempted: 0,
    totalMatches: 0,
    totalMismatches: 0,
    totalFailures: 0,
    consecutiveMatches: 0 // PHASE 5: Track consecutive matches for trust model
};

/**
 * PHASE 5: Session-scoped trust flag for column-based batching.
 * Set to true only after N consecutive successful validations with zero mismatches.
 * Reset to false immediately on any mismatch or failure.
 * Must reset on workbook reload (no persistence).
 */
let columnBatchingTrustedForSession = false;

/**
 * PHASE 5: Minimum consecutive validations required before enabling execution.
 * Conservative threshold to ensure reliability.
 */
const MIN_CONSECUTIVE_VALIDATIONS_FOR_TRUST = 50;

/**
 * PHASE 5: Check if column-based batch execution is allowed.
 * Pure, synchronous function - no side effects.
 * 
 * Execution is allowed only if ALL conditions are met:
 * 1. USE_COLUMN_BASED_BS_BATCHING === true
 * 2. Account type === Balance Sheet
 * 3. Grid detection returns eligible
 * 4. VALIDATE_COLUMN_BASED_BS_BATCHING === true
 * 5. No validation mismatches in current session (trust earned)
 * 6. Grid size within safety limits
 * 
 * @param {string} accountType - Account type
 * @param {Object} gridDetection - Grid detection result from detectColumnBasedBSGrid()
 * @returns {Object} - { allowed: boolean, reason?: string }
 */
function isColumnBatchExecutionAllowed(accountType, gridDetection) {
    // Condition 1: Execution flag must be enabled
    if (!USE_COLUMN_BASED_BS_BATCHING) {
        return { allowed: false, reason: 'USE_COLUMN_BASED_BS_BATCHING disabled' };
    }
    
    // Condition 2: Must be Balance Sheet account
    // CRITICAL FIX: accountType can be:
    // - A string (NetSuite type like "Bank")
    // - A JSON string (like '{"account":"10899","type":"Bank","display_name":"Bank"}') - backend returns JSON
    // - An object with .type property
    // Extract the type string properly
    let acctTypeStr = '';
    if (typeof accountType === 'string') {
        // Try to parse as JSON first (backend returns JSON string)
        try {
            const parsed = JSON.parse(accountType);
            if (parsed && typeof parsed === 'object') {
                acctTypeStr = parsed.type || parsed.account || '';
            } else {
                acctTypeStr = accountType; // Plain string type
            }
        } catch (e) {
            // Not JSON, use as-is (plain string type like "Bank")
            acctTypeStr = accountType;
        }
    } else if (accountType && typeof accountType === 'object') {
        acctTypeStr = accountType.type || accountType.account || '';
    }
    
    if (!acctTypeStr || !isBalanceSheetType(acctTypeStr)) {
        return { allowed: false, reason: `Account type is ${JSON.stringify(accountType)}, extracted type="${acctTypeStr}", not a Balance Sheet type` };
    }
    
    // Condition 3: Grid detection must be eligible
    if (!gridDetection || !gridDetection.eligible) {
        return { allowed: false, reason: 'Grid detection not eligible' };
    }
    
    // Condition 4: Validation flag check removed - column-based batching is now primary execution path
    // No validation required - we commit to this model
    
    // Condition 5: Validation mismatch check removed - no longer tracking mismatches
    
    // Condition 6: Trust check removed - no longer requiring trust to be earned
    
    // Condition 7: Grid size within safety limits
    const accountCount = gridDetection.allAccounts?.size || 0;
    const periodCount = gridDetection.columns?.length || 0;
    const MAX_ACCOUNTS_PER_BATCH = 100;
    const MAX_PERIODS_PER_BATCH = 24;
    
    if (accountCount > MAX_ACCOUNTS_PER_BATCH) {
        return { allowed: false, reason: `Too many accounts: ${accountCount} > ${MAX_ACCOUNTS_PER_BATCH}` };
    }
    
    if (periodCount > MAX_PERIODS_PER_BATCH) {
        return { allowed: false, reason: `Too many periods: ${periodCount} > ${MAX_PERIODS_PER_BATCH}` };
    }
    
    // All conditions met - execution allowed
    return { allowed: true };
}

/**
 * PHASE 4: Validate column-based batch results against per-cell results.
 * Fire-and-forget async validation - never blocks, never throws.
 * 
 * PHASE 5: Updates trust model based on validation results.
 * 
 * @param {string} account - Account number
 * @param {string} toPeriod - Period
 * @param {Object} filters - Filter object
 * @param {number} perCellValue - Value from per-cell execution
 * @param {Object} grid - Grid detection result
 */
async function validateColumnBasedBSBatch(account, toPeriod, filters, perCellValue, grid) {
    // Safety: Never throw - wrap everything in try-catch
    try {
        validationStats.totalAttempted++;
        
        if (DEBUG_COLUMN_BASED_BS_BATCHING) {
            console.log(`🔬 VALIDATION: Starting async validation for ${account}/${toPeriod}`);
        }
        
        // Execute column-based batch query (async, non-blocking)
        const batchResults = await executeColumnBasedBSBatch(grid);
        
        // Get column-based result for this account/period
        const columnBasedValue = batchResults[account]?.[toPeriod];
        
        // Validate result exists
        if (columnBasedValue === undefined || columnBasedValue === null) {
            validationStats.totalFailures++;
            // PHASE 5: Reset trust on failure
            columnBatchingTrustedForSession = false;
            validationStats.consecutiveMatches = 0;
            if (DEBUG_COLUMN_BASED_BS_BATCHING) {
                console.error(`❌ VALIDATION FAILURE: Missing result for ${account}/${toPeriod} - trust reset`);
            }
            return;
        }
        
        // Validate result is a number
        if (typeof columnBasedValue !== 'number' || isNaN(columnBasedValue)) {
            validationStats.totalFailures++;
            // PHASE 5: Reset trust on failure
            columnBatchingTrustedForSession = false;
            validationStats.consecutiveMatches = 0;
            if (DEBUG_COLUMN_BASED_BS_BATCHING) {
                console.error(`❌ VALIDATION FAILURE: Invalid result type for ${account}/${toPeriod}: ${typeof columnBasedValue} - trust reset`);
            }
            return;
        }
        
        // Compare values (exact numeric comparison, no rounding)
        const diff = Math.abs(perCellValue - columnBasedValue);
        const match = diff < 0.0001; // Allow tiny floating-point differences
        
        if (match) {
            validationStats.totalMatches++;
            // PHASE 5: Increment consecutive matches and check trust threshold
            validationStats.consecutiveMatches++;
            if (validationStats.consecutiveMatches >= MIN_CONSECUTIVE_VALIDATIONS_FOR_TRUST) {
                if (!columnBatchingTrustedForSession) {
                    columnBatchingTrustedForSession = true;
                    if (DEBUG_COLUMN_BASED_BS_BATCHING) {
                        console.log(`✅ VALIDATION TRUST EARNED: ${validationStats.consecutiveMatches} consecutive matches - column-based execution now allowed`);
                    }
                }
            }
            if (DEBUG_COLUMN_BASED_BS_BATCHING) {
                console.log(`✅ VALIDATION MATCH: ${account}/${toPeriod} = ${perCellValue} (both methods agree, ${validationStats.consecutiveMatches} consecutive)`);
            }
        } else {
            validationStats.totalMismatches++;
            // PHASE 5: Reset trust immediately on mismatch
            columnBatchingTrustedForSession = false;
            validationStats.consecutiveMatches = 0;
            
            // Log structured mismatch with full context
            const periods = grid.columns.map(col => col.period).sort((a, b) => {
                const aDate = parsePeriodToDate(a);
                const bDate = parsePeriodToDate(b);
                if (!aDate || !bDate) return 0;
                return aDate.getTime() - bDate.getTime();
            });
            const anchorPeriod = inferAnchorPeriod(periods);
            const normalizedFilters = normalizeFiltersForColumnBatching(filters);
            
            console.error(`❌ VALIDATION MISMATCH (TRUST RESET):
Account: ${account}
Period: ${toPeriod}
Filters: ${normalizedFilters}
Per-cell value: ${perCellValue}
Column-based value: ${columnBasedValue}
Absolute difference: ${diff}
Anchor period: ${anchorPeriod || 'N/A'}
Periods: ${periods.join(' → ')}
Total accounts: ${grid.allAccounts.size}
Total periods: ${grid.columns.length}`);
        }
    } catch (error) {
        // Never throw - log and continue
        validationStats.totalFailures++;
        // PHASE 5: Reset trust on error
        columnBatchingTrustedForSession = false;
        validationStats.consecutiveMatches = 0;
        if (DEBUG_COLUMN_BASED_BS_BATCHING) {
            console.error(`❌ VALIDATION ERROR: ${account}/${toPeriod} - ${error.message} - trust reset`, error);
        }
    }
}

/**
 * PHASE 4: Get validation statistics summary.
 * Exposed for debug logging on demand.
 * 
 * @returns {Object} Validation statistics
 */
function getValidationStats() {
    return {
        totalAttempted: validationStats.totalAttempted,
        totalMatches: validationStats.totalMatches,
        totalMismatches: validationStats.totalMismatches,
        totalFailures: validationStats.totalFailures,
        consecutiveMatches: validationStats.consecutiveMatches,
        trustEarned: columnBatchingTrustedForSession,
        matchRate: validationStats.totalAttempted > 0 
            ? (validationStats.totalMatches / validationStats.totalAttempted * 100).toFixed(2) + '%'
            : 'N/A'
    };
}

/**
 * Check if periods are contiguous (consecutive months).
 * Used to determine if single multi-period query is possible.
 * 
 * @param {Array<string>} periods - Array of period strings (e.g., ["Jan 2025", "Feb 2025", "Mar 2025"])
 * @returns {boolean} - True if all periods are consecutive months
 */
function arePeriodsContiguous(periods) {
    if (!periods || periods.length < 2) return false;
    
    const periodDates = periods
        .map(p => ({ period: p, date: parsePeriodToDate(p) }))
        .filter(p => p.date !== null)
        .sort((a, b) => a.date.getTime() - b.date.getTime());
    
    if (periodDates.length < 2) return false;
    
    // Check if periods are consecutive months
    for (let i = 1; i < periodDates.length; i++) {
        const prevDate = periodDates[i - 1].date;
        const currDate = periodDates[i].date;
        
        const monthsDiff = (currDate.getFullYear() - prevDate.getFullYear()) * 12 +
                          (currDate.getMonth() - prevDate.getMonth());
        
        if (monthsDiff !== 1) {
            return false; // Not consecutive
        }
    }
    
    return true; // All consecutive
}

/**
 * Infer anchor period (period immediately preceding earliest requested period).
 * Returns period name (e.g., "Dec 2024") for "Jan 2025".
 * 
 * CRITICAL: This is period-based, not date-based. Backend resolves period to date.
 * 
 * @param {Array<string>} periods - Array of period strings (e.g., ["Jan 2025", "Feb 2025"])
 * @returns {string|null} - Anchor period name or null if invalid
 */
function inferAnchorPeriod(periods) {
    if (!periods || periods.length === 0) return null;
    
    // Find earliest period
    const sortedPeriods = periods
        .map(p => ({ period: p, date: parsePeriodToDate(p) }))
        .filter(p => p.date !== null)
        .sort((a, b) => a.date.getTime() - b.date.getTime());
    
    if (sortedPeriods.length === 0) return null;
    
    const earliestDate = sortedPeriods[0].date;
    
    // Calculate previous month
    const anchorDate = new Date(earliestDate);
    anchorDate.setMonth(anchorDate.getMonth() - 1);
    
    // Format as "Mon YYYY"
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 
                        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = monthNames[anchorDate.getMonth()];
    const year = anchorDate.getFullYear();
    
    return `${month} ${year}`;
}

/**
 * Execute debounced query for a period key.
 * Called after debounce timeout expires, executes query with all collected accounts.
 * 
 * @param {string} periodKey - Period key for the query
 * @param {Map} activePeriodQueries - Map of active period queries
 * @param {Object} columnBasedDetection - Grid detection result
 * @param {string} filterKey - Filter key
 * @returns {Promise<Object>} - Map of {account: {period: balance}} or throws error
 */
async function executeDebouncedQuery(periodKey, activePeriodQueries, columnBasedDetection, filterKey) {
    const activePeriodQuery = activePeriodQueries.get(periodKey);
    if (!activePeriodQuery || activePeriodQuery.queryState !== 'collecting') {
        // CRITICAL: If query is missing or in wrong state, reject placeholder promise
        // Otherwise cells awaiting the promise will hang forever
        const state = activePeriodQuery?.queryState || 'missing';
        console.warn(`⚠️ DEBOUNCE: Unexpected state for ${periodKey} - query ${activePeriodQuery ? `state is '${state}'` : 'missing'}, rejecting placeholder`);
        
        if (activePeriodQuery && activePeriodQuery._rejectPlaceholder) {
            activePeriodQuery._rejectPlaceholder(new Error(`Debounce query failed: unexpected state '${state}'`));
        }
        
        // Clean up
        if (activePeriodQuery?.executeTimeout) {
            clearTimeout(activePeriodQuery.executeTimeout);
        }
        activePeriodQueries.delete(periodKey);
        
        return {};
    }
    
    // Transition to 'sent' state
    activePeriodQuery.queryState = 'sent';
    console.log(`📤 DEBOUNCE: Executing query for ${periodKey} with ${activePeriodQuery.accounts.size} accounts (debounce window closed)`);
    
    // Clear timeout (should already be cleared, but safety check)
    if (activePeriodQuery.executeTimeout) {
        clearTimeout(activePeriodQuery.executeTimeout);
        activePeriodQuery.executeTimeout = null;
    }
    
    // Prepare grid with all collected accounts
    const accounts = Array.from(activePeriodQuery.accounts).sort();
    const periods = Array.from(activePeriodQuery.periods);
    const updatedGrid = {
        ...columnBasedDetection,
        allAccounts: new Set(accounts),
        columns: periods.map(period => ({ period }))
    };
    
    try {
        // Execute the batch query
        const results = await executeColumnBasedBSBatch(updatedGrid, periodKey, activePeriodQueries);
        
        // 🔬 VALIDATION LOGGING: Log promise resolution
        console.log(`🎯 RESOLVING PLACEHOLDER:`, {
            periodKey: periodKey,
            accountCount: activePeriodQuery.accounts.size,
            accounts: Array.from(activePeriodQuery.accounts).slice(0, 5),
            periodCount: activePeriodQuery.periods.size,
            periods: Array.from(activePeriodQuery.periods),
            resultsAccountCount: Object.keys(results).length,
            timestamp: Date.now()
        });
        
        // Resolve placeholder promise with results
        if (activePeriodQuery._resolvePlaceholder) {
            activePeriodQuery._resolvePlaceholder(results);
        }
        
        // Clean up
        activePeriodQueries.delete(periodKey);
        
        return results;
    } catch (error) {
        // CRITICAL: Reject placeholder promise with error so awaiting cells don't hang
        if (activePeriodQuery._rejectPlaceholder) {
            activePeriodQuery._rejectPlaceholder(error);
        }
        
        // Clean up on error
        if (activePeriodQuery.executeTimeout) {
            clearTimeout(activePeriodQuery.executeTimeout);
        }
        activePeriodQueries.delete(periodKey);
        throw error;
    }
}

/**
 * Execute column-based balance sheet batch query.
 * 
 * CRITICAL: This function queries translated ending balances directly from NetSuite,
 * matching Balance Sheet report semantics exactly. No anchor math, no activity reconstruction.
 * 
 * Query strategy:
 * - One query per period (column) via /batch/bs_preload_targeted
 * - Returns ending balances per account for each period
 * - Uses NetSuite's period-end translation semantics
 * 
 * This matches NetSuite Balance Sheet reports exactly, including foreign currency accounts.
 * 
 * @param {Object} grid - Grid detection result from detectColumnBasedBSGrid()
 * @param {string} periodKey - Period key for deduplication tracking (optional)
 * @param {Map} activePeriodQueries - Map of active period queries for state tracking (optional)
 * @returns {Promise<Object>} - Map of {account: {period: balance}} or throws error
 */
async function executeColumnBasedBSBatch(grid, periodKey = null, activePeriodQueries = null) {
    const { allAccounts, columns, filters } = grid;
    const accounts = Array.from(allAccounts);
    const periods = columns.map(col => col.period).sort((a, b) => {
        const aDate = parsePeriodToDate(a);
        const bDate = parsePeriodToDate(b);
        if (!aDate || !bDate) return 0;
        return aDate.getTime() - bDate.getTime();
    });
    
    // CRITICAL: Process periods ONE AT A TIME to avoid Cloudflare timeout (524 error)
    // Cloudflare has a ~100 second timeout, but NetSuite queries take 90-150 seconds per period.
    // Processing 2 periods sequentially (180-300 seconds) exceeds Cloudflare's timeout.
    // NOTE: Once migrated to AWS, this limitation will not apply and we can increase CHUNK_SIZE.
    const CHUNK_SIZE = 1; // Process 1 period at a time (Cloudflare timeout constraint)
    const allResults = {}; // Accumulate results across all chunks
    
    // Build filtersHash for preload marker checking
    const filtersHash = getFilterKey({
        subsidiary: filters.subsidiary || '',
        department: filters.department || '',
        location: filters.location || '',
        classId: filters.classId || '',
        accountingBook: filters.accountingBook || ''
    });
    
    if (DEBUG_COLUMN_BASED_BS_BATCHING) {
        console.log(`🚀 COLUMN-BASED BS BATCH: ${accounts.length} accounts, ${periods.length} periods (processing in chunks of ${CHUNK_SIZE})`);
    }
    
    // Process periods in chunks
    for (let i = 0; i < periods.length; i += CHUNK_SIZE) {
        const chunk = periods.slice(i, i + CHUNK_SIZE);
        const chunkNumber = Math.floor(i / CHUNK_SIZE) + 1;
        const totalChunks = Math.ceil(periods.length / CHUNK_SIZE);
        
        console.log(`📦 Processing chunk ${chunkNumber}/${totalChunks}: ${chunk.length} period(s) (${chunk.join(', ')})`);
        
        // CRITICAL FIX: Check if periods need FULL preload before using targeted preload
        // NetSuite query time is essentially the same whether fetching 1, 20, or 200 accounts (~80-100 seconds)
        // So we should ALWAYS fetch all accounts for a period on first encounter
        // This makes all future lookups instant cache hits
        const periodsToPreload = [];
        
        for (const period of chunk) {
            // Check manifest status to see if period is already fully preloaded
            const periodStatus = getPeriodStatus(filtersHash, period);
            const isFullyPreloaded = periodStatus === "completed";
            const isPreloadInProgress = periodStatus === "requested" || periodStatus === "running";
            
            // 🔬 VALIDATION LOGGING: Add diagnostic info before preload decision
            const manifest = getManifest(filtersHash);
            const manifestPeriod = manifest.periods[normalizePeriodKey(period)];
            console.log(`🔬 PRELOAD DECISION DEBUG:`, {
                period: period,
                filtersHash: filtersHash,
                periodStatus: periodStatus,
                isFullyPreloaded: isFullyPreloaded,
                isPreloadInProgress: isPreloadInProgress,
                manifestExists: !!manifest,
                manifestPeriod: manifestPeriod ? {
                    status: manifestPeriod.status,
                    attemptCount: manifestPeriod.attemptCount
                } : null,
                willTriggerFullPreload: !isFullyPreloaded && !isPreloadInProgress,
                willWaitForPreload: isPreloadInProgress,
                filters: {
                    subsidiary: filters.subsidiary || '',
                    department: filters.department || '',
                    location: filters.location || '',
                    classId: filters.classId || '',
                    accountingBook: filters.accountingBook || ''
                }
            });
            
            console.log(`🔍 PRELOAD CHECK: period=${period}, status=${periodStatus}, fullyPreloaded=${isFullyPreloaded}, inProgress=${isPreloadInProgress}`);
            
            if (isFullyPreloaded) {
                console.log(`⚡ ALREADY PRELOADED: ${period} - will check cache`);
            } else if (isPreloadInProgress) {
                // Preload is already in progress (triggered by another cell) - wait for it instead of triggering duplicate
                console.log(`⏳ PRELOAD IN PROGRESS: ${period} (status: ${periodStatus}) - waiting for existing preload to complete`);
                periodsToPreload.push(period); // Add to list to wait for, but don't trigger new preload
            } else {
                // This period hasn't been preloaded yet - trigger FULL preload (same as manual entry)
                console.log(`🚀 FULL PRELOAD: Fetching ALL accounts for ${period} (same as manual entry)`);
                periodsToPreload.push(period);
            }
        }
        
        // Trigger full preload for periods that need it (only if not already in progress)
        const periodsToTrigger = [];
        const periodsToWait = [];
        for (const period of periodsToPreload) {
            const periodStatus = getPeriodStatus(filtersHash, period);
            if (periodStatus === "requested" || periodStatus === "running") {
                periodsToWait.push(period);
            } else {
                periodsToTrigger.push(period);
            }
        }
        
        // Trigger new preloads only for periods that aren't already in progress
        if (periodsToTrigger.length > 0) {
            for (const period of periodsToTrigger) {
                // Trigger full preload using the same mechanism as manual entry
                // This will fetch ALL 232 balance sheet accounts for this period
                const firstAccount = accounts.length > 0 ? accounts[0] : '10010'; // Use first account or default
                triggerAutoPreload(firstAccount, period, {
                    subsidiary: filters.subsidiary || '',
                    department: filters.department || '',
                    location: filters.location || '',
                    classId: filters.classId || '',
                    accountingBook: filters.accountingBook || ''
                });
            }
        }
        
        // Wait for all periods to complete preload (both newly triggered and already in progress)
        if (periodsToPreload.length > 0) {
            const maxWait = 120000; // 120 seconds
            let allPreloadsSucceeded = true;
            for (const period of periodsToPreload) {
                const waited = await waitForPeriodCompletion(filtersHash, period, maxWait);
                
                if (waited) {
                    console.log(`✅ PRELOAD COMPLETE: ${period} is now fully cached`);
                    
                    // CRITICAL: Wait a bit longer for cache to be populated by taskpane
                    // The taskpane processes the backend response and writes to localStorage
                    // Give it a moment to complete the write operation
                    await new Promise(resolve => setTimeout(resolve, 500)); // 500ms buffer
                    
                    // Verify cache is actually populated before proceeding
                    let cachePopulated = false;
                    let retries = 0;
                    const maxRetries = 10; // 10 retries = 5 seconds total
                    while (retries < maxRetries && !cachePopulated) {
                        // Check if at least one account from our list is cached
                        const sampleAccount = accounts.length > 0 ? accounts[0] : null;
                        if (sampleAccount) {
                            const sampleCached = checkLocalStorageCache(sampleAccount, null, period, filters.subsidiary || '', filtersHash);
                            if (sampleCached !== null) {
                                cachePopulated = true;
                                console.log(`✅ Cache verified: ${period} is populated (sample account ${sampleAccount} found)`);
                            }
                        }
                        
                        if (!cachePopulated) {
                            retries++;
                            if (retries < maxRetries) {
                                await new Promise(resolve => setTimeout(resolve, 500)); // Wait 500ms before retry
                            }
                        }
                    }
                    
                    if (!cachePopulated) {
                        console.warn(`⚠️ FULL PRELOAD: Cache not populated for ${period} after ${maxRetries * 500}ms - will use targeted preload as fallback`);
                        allPreloadsSucceeded = false;
                    }
                } else {
                    console.warn(`⚠️ FULL PRELOAD: Timeout or failure for ${period} - will use targeted preload as fallback`);
                    allPreloadsSucceeded = false;
                }
            }
            
            // If any preload failed, we'll need targeted preload as fallback
            if (!allPreloadsSucceeded) {
                // Fall through to targeted preload below
            } else {
                // All preloads succeeded - get results from cache
                let allAccountsCached = true;
                for (const period of chunk) {
                    for (const account of accounts) {
                        const cachedValue = checkLocalStorageCache(account, null, period, filters.subsidiary || '', filtersHash);
                        if (cachedValue !== null) {
                            if (!allResults[account]) {
                                allResults[account] = {};
                            }
                            allResults[account][period] = cachedValue;
                        } else {
                            // Account missing from cache - will need targeted preload
                            allAccountsCached = false;
                        }
                    }
                }
                
                if (allAccountsCached) {
                    // All accounts are in cache - skip targeted preload and continue to next chunk
                    console.log(`✅ ALL ACCOUNTS CACHED: Skipping targeted preload for ${chunk.join(', ')} - using cache`);
                    continue;
                } else {
                    // Some accounts missing - use targeted preload as fallback
                    console.log(`📊 TARGETED PRELOAD: Some accounts missing from cache for ${chunk.join(', ')} - using targeted endpoint`);
                }
            }
        } else {
            // All periods already preloaded - check cache first
            let allAccountsCached = true;
            for (const period of chunk) {
                for (const account of accounts) {
                    const cachedValue = checkLocalStorageCache(account, null, period, filters.subsidiary || '', filtersHash);
                    if (cachedValue !== null) {
                        if (!allResults[account]) {
                            allResults[account] = {};
                        }
                        allResults[account][period] = cachedValue;
                    } else {
                        // Account missing from cache - will need targeted preload
                        allAccountsCached = false;
                    }
                }
            }
            
            if (allAccountsCached) {
                // All accounts are in cache - skip targeted preload and continue to next chunk
                console.log(`✅ ALL ACCOUNTS CACHED: Skipping targeted preload for ${chunk.join(', ')} - using cache`);
                continue;
            } else {
                // Some accounts missing - use targeted preload
                console.log(`📊 TARGETED PRELOAD: Some accounts missing from cache for ${chunk.join(', ')} - using targeted endpoint`);
            }
        }
        
        // CRITICAL FIX: Before calling targeted preload, check if ANY period needs FULL preload
        // NetSuite query time is dominated by CONSOLIDATE function, not row count
        // Whether we ask for 1, 23, or 232 accounts, it takes ~80 seconds
        // So we should ALWAYS get all 232 accounts for a new period
        const periodsNeedingFullPreload = [];
        const periodsToWaitFor = [];
        for (const period of chunk) {
            const periodStatus = getPeriodStatus(filtersHash, period);
            const isFullyPreloaded = periodStatus === "completed";
            const isPreloadInProgress = periodStatus === "requested" || periodStatus === "running";
            
            // 🔬 VALIDATION LOGGING: Add diagnostic info before preload decision
            const manifest = getManifest(filtersHash);
            const manifestPeriod = manifest.periods[normalizePeriodKey(period)];
            console.log(`🔬 PRELOAD DECISION DEBUG (chunk processing):`, {
                period: period,
                filtersHash: filtersHash,
                periodStatus: periodStatus,
                isFullyPreloaded: isFullyPreloaded,
                isPreloadInProgress: isPreloadInProgress,
                manifestExists: !!manifest,
                manifestPeriod: manifestPeriod ? {
                    status: manifestPeriod.status,
                    attemptCount: manifestPeriod.attemptCount
                } : null,
                willTriggerFullPreload: !isFullyPreloaded && !isPreloadInProgress,
                willWaitForPreload: isPreloadInProgress,
                filters: {
                    subsidiary: filters.subsidiary || '',
                    department: filters.department || '',
                    location: filters.location || '',
                    classId: filters.classId || '',
                    accountingBook: filters.accountingBook || ''
                }
            });
            
            if (isFullyPreloaded) {
                // Already fully preloaded - skip
                console.log(`⚡ ALREADY PRELOADED: ${period} - skipping preload`);
            } else if (isPreloadInProgress) {
                // Preload already in progress - wait for it instead of triggering duplicate
                periodsToWaitFor.push(period);
                console.log(`⏳ PRELOAD IN PROGRESS: ${period} (status: ${periodStatus}) - will wait for existing preload`);
            } else {
                // New period - trigger full preload
                periodsNeedingFullPreload.push(period);
                console.log(`🔄 NEW PERIOD: ${period} - triggering FULL preload (not targeted)`);
            }
        }
        
        // Wait for any periods that are already in progress
        if (periodsToWaitFor.length > 0) {
            console.log(`⏳ WAITING FOR PRELOAD: ${periodsToWaitFor.length} period(s) already in progress: ${periodsToWaitFor.join(', ')}`);
            const maxWait = 120000; // 120 seconds
            for (const period of periodsToWaitFor) {
                const waited = await waitForPeriodCompletion(filtersHash, period, maxWait);
                if (waited) {
                    console.log(`✅ PRELOAD COMPLETE: ${period} finished (was already in progress)`);
                    // Wait for cache to be populated
                    await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second buffer
                    
                    // Verify cache is populated
                    let cachePopulated = false;
                    const sampleAccount = accounts.length > 0 ? accounts[0] : null;
                    if (sampleAccount) {
                        const sampleCached = checkLocalStorageCache(sampleAccount, null, period, filters.subsidiary || '', filtersHash);
                        if (sampleCached !== null) {
                            cachePopulated = true;
                            console.log(`✅ Cache verified: ${period} is populated (sample account ${sampleAccount} found)`);
                        }
                    }
                    
                    if (!cachePopulated) {
                        console.warn(`⚠️ Cache not populated for ${period} after waiting - may need targeted preload`);
                    }
                } else {
                    console.warn(`⚠️ PRELOAD TIMEOUT: ${period} did not complete within ${maxWait}ms (was already in progress)`);
                }
            }
        }
        
        // If any period needs full preload, trigger it and wait
        if (periodsNeedingFullPreload.length > 0) {
            console.log(`🚀 FULL PRELOAD: Triggering for ${periodsNeedingFullPreload.length} period(s): ${periodsNeedingFullPreload.join(', ')}`);
            
            for (const period of periodsNeedingFullPreload) {
                // Use the same triggerAutoPreload function that manual entry uses
                // This calls /batch/bs_preload (full preload, not targeted)
                const firstAccount = accounts.length > 0 ? accounts[0] : null;
                if (firstAccount) {
                    await triggerAutoPreload(firstAccount, period, filters);
                    
                    // Wait for preload to complete
                    const maxWait = 120000; // 120 seconds
                    const waited = await waitForPeriodCompletion(filtersHash, period, maxWait);
                    
                    if (waited) {
                        // Wait for cache to be populated
                        await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second buffer
                        console.log(`✅ FULL PRELOAD COMPLETE: ${period} - all 232 accounts cached`);
                    } else {
                        console.warn(`⚠️ FULL PRELOAD: Timeout for ${period} - will try targeted as fallback`);
                    }
                }
            }
            
            // After full preload, check cache again - should have all accounts now
            let allAccountsCached = true;
            for (const period of chunk) {
                for (const account of accounts) {
                    const cachedValue = checkLocalStorageCache(account, null, period, filters.subsidiary || '', filtersHash);
                    if (cachedValue === null) {
                        allAccountsCached = false;
                        break;
                    }
                }
                if (!allAccountsCached) break;
            }
            
            if (allAccountsCached) {
                // All accounts are in cache after full preload - skip targeted preload
                console.log(`✅ ALL ACCOUNTS CACHED AFTER FULL PRELOAD: Skipping targeted preload for ${chunk.join(', ')}`);
                continue; // Skip to next chunk
            } else {
                console.warn(`⚠️ Some accounts still missing after full preload - will use targeted preload as fallback`);
            }
        }
        
        // Only use targeted preload if:
        // 1. All periods are already fully preloaded but some accounts are missing (edge case)
        // 2. Full preload timed out/failed (fallback)
        // For the common drag scenario, full preload should have cached all accounts
        
        // Query translated ending balances for this chunk (targeted preload - should be rare)
    const requestBody = {
        accounts: accounts,
            periods: chunk,
        subsidiary: filters.subsidiary || null,
        department: filters.department || null,
        location: filters.location || null,
        class: filters.classId || null,
        book: filters.accountingBook || null
    };
    
    const url = `${SERVER_URL}/batch/bs_preload_targeted`;
    
        // CRITICAL: Mark query as 'sent' immediately before network request fires
        // This prevents race conditions where accounts could be merged after promise creation but before fetch()
        if (periodKey && activePeriodQueries) {
            const activeQuery = activePeriodQueries.get(periodKey);
            if (activeQuery && activeQuery.queryState === 'pending') {
                activeQuery.queryState = 'sent';
                console.log(`📤 Query state transition: ${periodKey} → 'sent' (before fetch)`);
            }
    }
    
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
    });
    
    if (!response.ok) {
        const errorText = await response.text();
            throw new Error(`Translated ending balances query failed for chunk ${chunkNumber}: ${response.status} - ${errorText}`);
    }
    
    const data = await response.json();
    
    // Validate response shape
    if (!data.balances || typeof data.balances !== 'object') {
            throw new Error(`Invalid translated ending balances response for chunk ${chunkNumber}: missing balances object`);
        }
        
        // OPTIMIZATION: Batch localStorage writes - parse once before loop, stringify once after
        // This reduces JSON.parse/stringify from O(accounts × periods) to O(1) per chunk
        // NOTE: filtersHash is already defined at the top of the function (line ~1238)
        let balanceData = null;
        let preloadData = null;
        
        // Transform and merge chunk results
    for (const account of accounts) {
        if (!(account in data.balances)) {
                throw new Error(`Missing ending balance for account ${account} in chunk ${chunkNumber}`);
        }
        
            if (!(account in allResults)) {
                allResults[account] = {};
            }
            
        const accountBalances = data.balances[account];
        
            // Validate all periods in chunk are present and merge into allResults
            for (const period of chunk) {
            if (!(period in accountBalances)) {
                    throw new Error(`Missing ending balance for account ${account}, period ${period} in chunk ${chunkNumber}`);
                }
                allResults[account][period] = accountBalances[period];
                
                // Update cache incrementally for this account/period
                const cacheKey = getCacheKey('balance', {
                    account,
                    fromPeriod: '',
                    toPeriod: period,
                    subsidiary: filters.subsidiary || '',
                    department: filters.department || '',
                    location: filters.location || '',
                    classId: filters.classId || '',
                    accountingBook: filters.accountingBook || ''
                });
                cache.balance.set(cacheKey, accountBalances[period]);
                
                // CRITICAL: Also persist to localStorage for cross-context access
                // This ensures other cells in the same column can access the cache
                // Write to BOTH formats: legacy (netsuite_balance_cache) and preload (xavi_balance_cache)
                // OPTIMIZATION: Lazy-load localStorage data once per chunk, update object, write once at end
                try {
                    // Lazy-load legacy format (first time only)
                    if (balanceData === null) {
                        const stored = localStorage.getItem(STORAGE_KEY);
                        balanceData = stored ? JSON.parse(stored) : {};
                    }
                    
                    if (!balanceData[account]) {
                        balanceData[account] = {};
                    }
                    balanceData[account][period] = accountBalances[period];
                    
                    // Lazy-load preload format (first time only)
                    if (preloadData === null) {
                        const preloadCache = localStorage.getItem('xavi_balance_cache');
                        preloadData = preloadCache ? JSON.parse(preloadCache) : {};
                    }
                    
                    // Format: balance:${account}:${filtersHash}:${period}
                    const preloadKey = `balance:${account}:${filtersHash}:${period}`;
                    preloadData[preloadKey] = { value: accountBalances[period], timestamp: Date.now() };
                } catch (e) {
                    // localStorage might be full or unavailable - log but don't fail
                    console.warn(`⚠️ Failed to persist cache to localStorage for ${account}/${period}:`, e.message);
                }
            }
        }
        
        // Write to localStorage once per chunk (after all account/period updates)
        if (balanceData !== null || preloadData !== null) {
            try {
                if (balanceData !== null) {
                    localStorage.setItem(STORAGE_KEY, JSON.stringify(balanceData));
                    localStorage.setItem(STORAGE_TIMESTAMP_KEY, Date.now().toString());
                }
                if (preloadData !== null) {
                    localStorage.setItem('xavi_balance_cache', JSON.stringify(preloadData));
                }
            } catch (e) {
                console.warn(`⚠️ Failed to write localStorage batch for chunk ${chunkNumber}:`, e.message);
            }
        }
        
        // Resolve promises for completed periods in pendingEvaluation
        // This allows cells to update incrementally as chunks complete
        for (const [evalKey, evalRequest] of pendingEvaluation.balance.entries()) {
            const { account: evalAccount, toPeriod: evalPeriod } = evalRequest;
            if (accounts.includes(evalAccount) && chunk.includes(evalPeriod)) {
                const balance = allResults[evalAccount]?.[evalPeriod];
                if (balance !== undefined && balance !== null && typeof balance === 'number') {
                    // Find the corresponding request in pendingRequests if it exists
                    // and resolve it (this handles cells that are still waiting)
                    const matchingCacheKey = getCacheKey('balance', {
                        account: evalAccount,
                        fromPeriod: '',
                        toPeriod: evalPeriod,
                        subsidiary: filters.subsidiary || '',
                        department: filters.department || '',
                        location: filters.location || '',
                        classId: filters.classId || '',
                        accountingBook: filters.accountingBook || ''
                    });
                    
                    // Check if there's a pending request for this cache key
                    if (pendingRequests.balance.has(matchingCacheKey)) {
                        const pendingRequest = pendingRequests.balance.get(matchingCacheKey);
                        pendingRequest.resolve(balance);
                        pendingRequests.balance.delete(matchingCacheKey);
                    }
                }
            }
        }
        
        console.log(`✅ Chunk ${chunkNumber}/${totalChunks} complete: ${chunk.length} periods processed, cache updated`);
    }
    
    if (DEBUG_COLUMN_BASED_BS_BATCHING) {
        console.log(`✅ All chunks complete: Using translated ending balances (NetSuite Balance Sheet semantics)`);
    }
    
    return allResults; // {account: {period: balance}}
}

/**
 * Fetch opening balances for multiple accounts as of anchor period.
 * 
 * @param {Array<string>} accounts - Array of account numbers
 * @param {string} anchorPeriod - Anchor period (e.g., "Dec 2024")
 * @param {Object} filters - Filter object
 * @returns {Promise<Object>} - Map of {account: balance}
 */
async function fetchOpeningBalancesBatch(accounts, anchorPeriod, filters) {
    const params = new URLSearchParams();
    params.append('account', accounts.join(',')); // Comma-separated
    params.append('anchor_period', anchorPeriod);
    params.append('batch_mode', 'true');
    
    // Add filters (only non-empty values)
    if (filters.subsidiary) params.append('subsidiary', filters.subsidiary);
    if (filters.department) params.append('department', filters.department);
    if (filters.location) params.append('location', filters.location);
    if (filters.classId) params.append('class', filters.classId);
    if (filters.accountingBook) params.append('book', filters.accountingBook);
    
    const url = `${SERVER_URL}/balance?${params.toString()}`;
    
    if (DEBUG_COLUMN_BASED_BS_BATCHING) {
        console.log(`🔍 Opening balances URL: ${url}`);
    }
    
    const response = await fetch(url);
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Opening balances query failed: ${response.status} - ${errorText}`);
    }
    
    const data = await response.json();
    
    // Validate response shape
    if (!data.balances || typeof data.balances !== 'object') {
        throw new Error(`Invalid opening balances response: missing balances object`);
    }
    
    // Validate all accounts are present
    for (const account of accounts) {
        if (!(account in data.balances)) {
            throw new Error(`Missing opening balance for account ${account}`);
        }
    }
    
    return data.balances; // {account: balance}
}

/**
 * Fetch period activity for multiple accounts across period range.
 * 
 * @param {Array<string>} accounts - Array of account numbers
 * @param {string} fromPeriod - From period (e.g., "Jan 2025")
 * @param {string} toPeriod - To period (e.g., "Apr 2025")
 * @param {Object} filters - Filter object
 * @returns {Promise<Object>} - Map of {account: {period: activity}}
 */
async function fetchPeriodActivityBatch(accounts, fromPeriod, toPeriod, filters) {
    const params = new URLSearchParams();
    params.append('account', accounts.join(',')); // Comma-separated
    params.append('from_period', fromPeriod);
    params.append('to_period', toPeriod);
    params.append('batch_mode', 'true');
    params.append('include_period_breakdown', 'true');
    
    // Add filters (only non-empty values)
    if (filters.subsidiary) params.append('subsidiary', filters.subsidiary);
    if (filters.department) params.append('department', filters.department);
    if (filters.location) params.append('location', filters.location);
    if (filters.classId) params.append('class', filters.classId);
    if (filters.accountingBook) params.append('book', filters.accountingBook);
    
    const url = `${SERVER_URL}/balance?${params.toString()}`;
    
    if (DEBUG_COLUMN_BASED_BS_BATCHING) {
    }
    
    const response = await fetch(url);
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Period activity query failed: ${response.status} - ${errorText}`);
    }
    
    const data = await response.json();
    
    // Validate response shape
    if (!data.period_activity || typeof data.period_activity !== 'object') {
        throw new Error(`Invalid period activity response: missing period_activity object`);
    }
    
    // Validate all accounts are present
    for (const account of accounts) {
        if (!(account in data.period_activity)) {
            throw new Error(`Missing period activity for account ${account}`);
        }
        if (typeof data.period_activity[account] !== 'object') {
            throw new Error(`Invalid period activity for account ${account}: expected object`);
        }
    }
    
    return data.period_activity; // {account: {period: activity}}
}

/**
 * Synchronously check if a BS request is eligible for batching.
 * This check is non-blocking and reads from the current request queue.
 * 
 * CRITICAL: This function must be completely synchronous - no await, no promises.
 * 
 * @param {string} account - Account number
 * @param {string} fromPeriod - From period (should be empty for cumulative)
 * @param {string} toPeriod - To period
 * @param {Object} filters - Filter object (subsidiary, department, etc.)
 * @returns {Object} - { eligible: boolean, periods?: string[], requests?: Array }
 */
function checkBatchEligibilitySynchronous(account, fromPeriod, toPeriod, filters) {
    // Step 1: Must be cumulative (no fromPeriod)
    if (fromPeriod && fromPeriod !== '') {
        console.log(`🔍 BATCH CHECK: Not cumulative (fromPeriod=${fromPeriod}) - not eligible`);
        return { eligible: false };
    }
    
    // Step 2: Must have toPeriod
    if (!toPeriod || toPeriod === '') {
        console.log(`🔍 BATCH CHECK: Missing toPeriod - not eligible`);
        return { eligible: false };
    }
    
    // Step 3: Check if there are other requests (queued OR currently being evaluated) that form a grid pattern
    // SYNCHRONOUS read - no await, no promises, no blocking
    // Check BOTH: pendingRequests (already queued) AND pendingEvaluation (currently being evaluated)
    const queuedRequests = Array.from(pendingRequests.balance.values());
    const evaluatingRequests = Array.from(pendingEvaluation.balance.values());
    const allRequests = [...queuedRequests, ...evaluatingRequests];
    const bsCumulativeRequests = allRequests.filter(r => {
        // Handle both queued requests (have .params) and evaluating requests (have direct properties)
        const rParams = r.params || r;
        
        // Safety check: ensure rParams exists and is an object
        if (!rParams || typeof rParams !== 'object') {
            return false;
        }
        
        // Must be cumulative (no fromPeriod)
        if (rParams.fromPeriod !== undefined && rParams.fromPeriod !== null && rParams.fromPeriod !== '') {
            return false;
        }
        // Must have toPeriod
        if (!rParams.toPeriod || rParams.toPeriod === '') {
            return false;
        }
        // Must be same account
        if (rParams.account !== account) {
            return false;
        }
        // Must have same filters
        // For evaluating requests, filters are in rParams.filters; for queued requests, filters are in rParams directly
        const rFilters = rParams.filters || rParams;
        const rFilterKey = JSON.stringify({
            subsidiary: rFilters.subsidiary || '',
            department: rFilters.department || '',
            location: rFilters.location || '',
            classId: rFilters.classId || '',
            accountingBook: rFilters.accountingBook || ''
        });
        const filterKey = JSON.stringify({
            subsidiary: filters.subsidiary || '',
            department: filters.department || '',
            location: filters.location || '',
            classId: filters.classId || '',
            accountingBook: filters.accountingBook || ''
        });
        if (rFilterKey !== filterKey) {
            return false;
        }
        // Must not be BALANCECURRENCY (skip currency requests)
        const endpoint = r.endpoint || '/balance';
        if (endpoint === '/balancecurrency') {
            return false;
        }
        return true;
    });
    
    // Step 4: Collect all periods (queued + current)
    const allPeriods = new Set(bsCumulativeRequests.map(r => {
        const rParams = r.params || r;
        return rParams.toPeriod;
    }));
    allPeriods.add(toPeriod);
    
    // Step 5: Need at least 2 periods for batching
    if (allPeriods.size < 2) {
        console.log(`🔍 BATCH CHECK: Only ${allPeriods.size} period(s) - need at least 2 - not eligible`);
        return { eligible: false };
    }
    
    // Step 6: Safety limit - max 24 periods
    if (allPeriods.size > 24) {
        return { eligible: false };
    }
    
    // Step 7: PERIOD ADJACENCY CHECK (Safety Guardrail)
    // Verify periods are contiguous or monotonically increasing
    // Prevents accidental batching of random months (e.g., "Jan 2025" and "Jun 2025")
    const periodsArray = Array.from(allPeriods);
    const periodDates = periodsArray
        .map(p => ({ period: p, date: parsePeriodToDate(p) }))
        .filter(p => p.date !== null)
        .sort((a, b) => a.date.getTime() - b.date.getTime());
    
    if (periodDates.length < 2) {
        return { eligible: false }; // Not enough valid periods
    }
    
    // Check for contiguity: periods should be consecutive months
    // Allow small gaps (1-2 months) but reject large gaps (3+ months)
    let maxGap = 0;
    for (let i = 1; i < periodDates.length; i++) {
        const prevDate = periodDates[i - 1].date;
        const currDate = periodDates[i].date;
        
        // Calculate months between periods
        const monthsDiff = (currDate.getFullYear() - prevDate.getFullYear()) * 12 +
                          (currDate.getMonth() - prevDate.getMonth());
        
        if (monthsDiff > maxGap) {
            maxGap = monthsDiff;
        }
    }
    
    // Reject if gap is too large (more than 2 months = not contiguous)
    // This prevents batching random months like "Jan 2025" and "Jun 2025"
    if (maxGap > 2) {
        console.log(`🔍 BATCH CHECK: Periods not contiguous (max gap: ${maxGap} months) - not eligible`);
        return { eligible: false }; // Periods not contiguous enough
    }
    
    // Step 8: Eligible for batching
    console.log(`🔍 BATCH CHECK: ✅ ELIGIBLE - ${account}, ${periodDates.length} periods: ${periodDates.map(p => p.period).join(', ')}`);
    return {
        eligible: true,
        periods: periodDates.map(p => p.period),
        requests: bsCumulativeRequests
    };
}

/**
 * Detect if cumulative requests form a balance sheet grid pattern.
 * 
 * Conservative detection: Only activates when ALL conditions are met:
 * 1. Account type is Balance Sheet (verified via account type cache)
 * 2. fromPeriod is missing or empty (already filtered by cumulativeRequests)
 * 3. Multiple requests with same account pattern
 * 4. Multiple requests with varying toPeriod
 * 5. Same filters (subsidiary, department, location, class, book)
 * 6. At least 2 different periods (columns)
 * 7. All requests are XAVI.BALANCE (not BALANCECURRENCY)
 * 
 * Returns grouped requests or null if pattern not detected.
 * 
 * @param {Array} cumulativeRequests - Array of [cacheKey, request] tuples
 * @returns {Object|null} - { account, filters, periods, requests } or null
 */
function detectBalanceSheetGridPattern(cumulativeRequests) {
    if (cumulativeRequests.length < 2) {
        return null; // Need at least 2 requests for a grid
    }
    
    // Group requests by account and filters
    // Pattern: Same account + same filters + varying toPeriod = potential grid
    const accountGroups = new Map(); // account+filters -> { account, filters, periods: Set, requests: [] }
    
    for (const [cacheKey, request] of cumulativeRequests) {
        const { account, fromPeriod, toPeriod, subsidiary, department, location, classId, accountingBook } = request.params;
        
        // Skip BALANCECURRENCY requests (they need individual handling)
        const endpoint = request.endpoint || '/balance';
        if (endpoint === '/balancecurrency') {
            continue; // Skip currency requests
        }
        
        // Verify fromPeriod is empty (cumulative)
        if (fromPeriod && fromPeriod !== '') {
            continue; // Not cumulative - skip
        }
        
        // Verify toPeriod exists
        if (!toPeriod || toPeriod === '') {
            continue; // Missing toPeriod - skip
        }
        
        // CRITICAL: Verify account type is Balance Sheet (check cache)
        // If account type is Income/Expense, skip immediately (shouldn't be here, but safety check)
        const typeCacheKey = getCacheKey('type', { account });
        const accountType = cache.type.has(typeCacheKey) ? cache.type.get(typeCacheKey) : null;
        
        // If account type is known and is Income/Expense, skip (shouldn't happen, but safety check)
        if (accountType && (accountType === 'Income' || accountType === 'COGS' || accountType === 'Expense' || 
            accountType === 'OthIncome' || accountType === 'OthExpense')) {
            continue; // Income statement - skip grid batching
        }
        
        // Create filter key (all filters must match for batching)
        const filterKey = JSON.stringify({ subsidiary, department, location, classId, accountingBook });
        const groupKey = `${account}::${filterKey}`;
        
        if (!accountGroups.has(groupKey)) {
            accountGroups.set(groupKey, {
                account,
                filters: { subsidiary, department, location, classId, accountingBook },
                periods: new Set(),
                requests: []
            });
        }
        
        const group = accountGroups.get(groupKey);
        group.periods.add(toPeriod);
        group.requests.push([cacheKey, request]);
    }
    
    // Find groups that match grid pattern: same account, multiple periods
    for (const [groupKey, group] of accountGroups) {
        // Must have at least 2 different periods (columns)
        if (group.periods.size < 2) {
            continue; // Not a grid - single period
        }
        
        // Must have at least 2 requests (one per period)
        if (group.requests.length < 2) {
            continue; // Not enough requests
        }
        
        // Safety limits
        const MAX_PERIODS = 24; // 2 years max
        
        if (group.periods.size > MAX_PERIODS) {
            continue; // Too many periods - skip batching
        }
        
        // This group matches the pattern!
        return {
            account: group.account,
            filters: group.filters,
            periods: Array.from(group.periods),
            requests: group.requests
        };
    }
    
    return null; // No grid pattern detected
}

/**
 * Execute batched balance sheet query for a detected grid pattern.
 * 
 * Strategy:
 * 1. Disable per-period auto-preload entirely (skip manifest/preload logic)
 * 2. Execute exactly two NetSuite queries using existing /balance endpoint:
 *    - Opening balance as of anchor (all accounts) - via /balance with anchor_date parameter
 *    - Period activity for: earliest toPeriod → latest toPeriod - via /balance with batch parameters
 * 3. Compute ending balances locally
 * 
 * @param {Object} gridPattern - Pattern from detectBalanceSheetGridPattern()
 * @returns {Promise<Object>} - Map of {period: balance} for the account, or null if failed
 */
// Account-specific batch query lock: Map<account, Promise<results>>
// Allows different accounts to batch in parallel, while same-account requests share the same query
const bsBatchQueryInFlight = new Map(); // Map<string, Promise<Object>>

// Limit concurrent batch queries to prevent Cloudflare tunnel overload (524 timeouts)
// GLOBAL semaphore (not scoped per account/worksheet/evaluation wave)
const MAX_CONCURRENT_BS_BATCH_QUERIES = 2; // Start conservative, tune later if safe
let activeBSBatchQueries = 0; // Track active queries globally
const bsBatchQueryQueue = []; // Queue for waiting queries

// Helper function to wait for slot availability (GLOBAL semaphore)
async function waitForBatchQuerySlot() {
    if (activeBSBatchQueries < MAX_CONCURRENT_BS_BATCH_QUERIES) {
        activeBSBatchQueries++;
        console.log(`🎫 Acquired batch query slot (${activeBSBatchQueries}/${MAX_CONCURRENT_BS_BATCH_QUERIES} active)`);
        return; // Slot available
    }
    
    // No slot available - wait in queue
    console.log(`⏸️ Batch query slot unavailable (${activeBSBatchQueries}/${MAX_CONCURRENT_BS_BATCH_QUERIES} active) - queuing...`);
    return new Promise((resolve) => {
        bsBatchQueryQueue.push(resolve);
    });
}

// Helper function to release slot (GLOBAL semaphore)
function releaseBatchQuerySlot() {
    activeBSBatchQueries--;
    if (bsBatchQueryQueue.length > 0) {
        const next = bsBatchQueryQueue.shift();
        activeBSBatchQueries++;
        console.log(`🎫 Waking up queued batch query (${activeBSBatchQueries}/${MAX_CONCURRENT_BS_BATCH_QUERIES} active)`);
        next(); // Wake up next waiting query
    }
}

async function executeBalanceSheetBatchQuery(gridPattern) {
    // This function is used by queue-based pattern detection (processBatchQueue)
    // It should use the same account-specific lock as executeBalanceSheetBatchQueryImmediate
    const { account, filters, periods } = gridPattern;
    
    // Check if this account already has a batch query in flight (from immediate path)
    if (bsBatchQueryInFlight.has(account)) {
        console.log(`⏳ BS batch query for ${account} already in flight (from immediate path) - waiting for results...`);
        // Wait for the existing query to complete
        const results = await bsBatchQueryInFlight.get(account);
        return results; // Return the shared results
    }
    
    // Start new batch query for this account (queue-based path)
    const queryPromise = (async () => {
        try {
            // Safety limits (fail fast before NetSuite calls)
            const MAX_PERIODS = 24; // 2 years max
            
            if (periods.length > MAX_PERIODS) {
                throw new Error(`Too many periods: ${periods.length} (max: ${MAX_PERIODS})`);
            }
            
            // Verify account type is Balance Sheet (if not in cache, fetch it)
            const typeCacheKey = getCacheKey('type', { account });
            let accountType = cache.type.has(typeCacheKey) ? cache.type.get(typeCacheKey) : null;
            
            if (!accountType) {
                accountType = await getAccountType(account);
            }
            
            // CRITICAL: If account is Income/Expense, abort batching immediately
            if (accountType && (accountType === 'Income' || accountType === 'COGS' || accountType === 'Expense' || 
                accountType === 'OthIncome' || accountType === 'OthExpense')) {
                throw new Error('Account is Income/Expense - should not enter batch path');
            }
            
            // Infer anchor date
            const anchorDate = inferAnchorDate(periods);
            if (!anchorDate) {
                throw new Error('Could not infer anchor date');
            }
            
            console.log(`🚀 BS BATCH QUERY: ${account}, ${periods.length} periods, anchor: ${anchorDate}`);
            
            // Sort periods chronologically
            const sortedPeriods = periods
                .map(p => ({ period: p, date: parsePeriodToDate(p) }))
                .filter(p => p.date !== null)
                .sort((a, b) => a.date.getTime() - b.date.getTime());
            
            if (sortedPeriods.length === 0) {
                throw new Error('No valid periods after sorting');
            }
            
            const earliestPeriod = sortedPeriods[0].period;
            const latestPeriod = sortedPeriods[sortedPeriods.length - 1].period;
            
            // Query 1: Opening balance as of anchor (using existing /balance endpoint)
            console.log(`📊 Query 1: Opening balance as of ${anchorDate}`);
            const openingBalance = await fetchOpeningBalance(account, anchorDate, filters);
            
            // Query 2: Period activity for earliest → latest period (using existing /balance endpoint with batch parameters)
            console.log(`📊 Query 2: Period activity from ${earliestPeriod} to ${latestPeriod}`);
            const periodActivity = await fetchPeriodActivityBatch(account, earliestPeriod, latestPeriod, filters);
            
            // Compute ending balances locally
            const results = computeRunningBalances(
                sortedPeriods.map(p => p.period),
                openingBalance,
                periodActivity
            );
            
            
            return results; // {period: balance}
            
        } catch (error) {
            console.error(`❌ BS batch query failed for ${account}:`, error);
            // Re-throw the error so waiting requests also see the failure
            throw error;
        } finally {
            // Remove from lock after completion (success or failure)
            bsBatchQueryInFlight.delete(account);
        }
    })();
    
    // Store the promise in the lock BEFORE awaiting (so other requests can join)
    bsBatchQueryInFlight.set(account, queryPromise);
    
    // Await and return the results
    return await queryPromise;
}

/**
 * Execute batched balance sheet query immediately (not queued).
 * This is called directly from BALANCE() when batch eligibility is detected.
 * 
 * CRITICAL: This executes in the same call stack as BALANCE() - no deferral.
 * 
 * @param {string} account - Account number
 * @param {Array<string>} periods - Array of period strings
 * @param {Object} filters - Filter object
 * @returns {Promise<Object>} - Map of {period: balance} or null if failed
 */
async function executeBalanceSheetBatchQueryImmediate(account, periods, filters) {
    // Account-specific lock: Check if this account already has a batch query in flight
    if (bsBatchQueryInFlight.has(account)) {
        console.log(`⏳ BS batch query for ${account} already in flight - waiting for results...`);
        // Wait for the existing query to complete (NO TIMEOUT - wait for actual completion)
        // If the promise rejects, it will throw here (which is correct - we catch it in BALANCE)
        const results = await bsBatchQueryInFlight.get(account);
        return results; // Return the shared results
    }
    
    // NEW: Wait for available slot before starting new query (GLOBAL semaphore)
    await waitForBatchQuerySlot();
    
    // Start new batch query for this account
    const queryPromise = (async () => {
        try {
            // Safety limits (fail fast before NetSuite calls)
            const MAX_PERIODS = 24; // 2 years max
            if (periods.length > MAX_PERIODS) {
                throw new Error(`Too many periods: ${periods.length} (max: ${MAX_PERIODS})`);
            }
            
            // Infer anchor date
            const anchorDate = inferAnchorDate(periods);
            if (!anchorDate) {
                throw new Error('Could not infer anchor date');
            }
            
            console.log(`🚀 BS BATCH QUERY (IMMEDIATE): ${account}, ${periods.length} periods, anchor: ${anchorDate}`);
            
            // Sort periods chronologically
            const sortedPeriods = periods
                .map(p => ({ period: p, date: parsePeriodToDate(p) }))
                .filter(p => p.date !== null)
                .sort((a, b) => a.date.getTime() - b.date.getTime());
            
            if (sortedPeriods.length === 0) {
                throw new Error('No valid periods after sorting');
            }
            
            const earliestPeriod = sortedPeriods[0].period;
            const latestPeriod = sortedPeriods[sortedPeriods.length - 1].period;
            
            // Query 1: Opening balance as of anchor
            console.log(`📊 Query 1: Opening balance as of ${anchorDate}`);
            const openingBalance = await fetchOpeningBalance(account, anchorDate, filters);
            
            // Query 2: Period activity for earliest → latest period
            console.log(`📊 Query 2: Period activity from ${earliestPeriod} to ${latestPeriod}`);
            const periodActivity = await fetchPeriodActivityBatch(account, earliestPeriod, latestPeriod, filters);
            
            // Compute ending balances locally
            const results = computeRunningBalances(
                sortedPeriods.map(p => p.period),
                openingBalance,
                periodActivity
            );
            
            
            return results; // {period: balance}
            
        } catch (error) {
            console.error(`❌ BS batch query failed for ${account}:`, error);
            // Re-throw the error so waiting requests also see the failure
            throw error;
        } finally {
            // NEW: Release slot when done (success or failure) - GLOBAL semaphore
            releaseBatchQuerySlot();
            // Remove from account-specific lock after completion
            bsBatchQueryInFlight.delete(account);
        }
    })();
    
    // Store the promise in the lock BEFORE awaiting (so other requests can join)
    // CRITICAL: This must happen synchronously after promise creation to prevent race conditions
    bsBatchQueryInFlight.set(account, queryPromise);
    
    // Await and return the results
    return await queryPromise;
}

/**
 * Fetch opening balance for account as of anchor date.
 * Uses existing /balance endpoint with anchor_date parameter.
 */
async function fetchOpeningBalance(account, anchorDate, filters, retryCount = 0) {
    const MAX_RETRIES = 2;
    const RETRY_DELAY = 5000; // 5 seconds
    
    // Build params - only include non-empty values to avoid issues with empty string handling
    const params = new URLSearchParams();
    params.append('account', account);
    params.append('anchor_date', anchorDate);  // Required parameter
    // from_period and to_period are intentionally omitted (not empty strings)
    // Backend validation: if anchor_date is provided, periods can be omitted
    
    if (filters.subsidiary) params.append('subsidiary', filters.subsidiary);
    if (filters.department) params.append('department', filters.department);
    if (filters.location) params.append('location', filters.location);
    if (filters.classId) params.append('class', filters.classId);
    // CRITICAL FIX: Backend expects "book" not "accountingbook", and it should be a number or omitted
    if (filters.accountingBook && filters.accountingBook !== '') {
        const bookNum = parseInt(String(filters.accountingBook));
        if (!isNaN(bookNum) && bookNum > 1) {
            // Only send if it's not Primary Book (1) - backend defaults to 1
            params.append('book', bookNum.toString());
        }
        // For Book 1, we omit it (backend defaults to 1)
    }
    
    const url = `${SERVER_URL}/balance?${params.toString()}`;
    
    try {
        const response = await fetch(url);
        if (!response.ok) {
            const errorText = await response.text();
            
            // Retry on 524 timeout (slot is NOT held during retry - retry is just the fetch, not the batch query)
            if (response.status === 524 && retryCount < MAX_RETRIES) {
                console.log(`⏳ 524 timeout for ${account} - retrying in ${RETRY_DELAY/1000}s (${retryCount + 1}/${MAX_RETRIES})...`);
                // NOTE: Slot is NOT released here - it's released in executeBalanceSheetBatchQueryImmediate finally block
                // This retry is just the fetch, not the entire batch query
                await new Promise(r => setTimeout(r, RETRY_DELAY));
                return fetchOpeningBalance(account, anchorDate, filters, retryCount + 1);
            }
            
            console.error(`❌ Opening balance failed (${response.status}): ${errorText}`);
            throw new Error(`Opening balance query failed: ${response.status} - ${errorText}`);
        }
        
        // Backend returns JSON with balance field
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
            const data = await response.json();
            
            // CRITICAL: Check for error code before using balance
            if (data.error) {
                console.error(`❌ Opening balance error: ${data.error}`);
                throw new Error(data.error);
            }
            
            const value = data.balance ?? 0;
            console.log(`📊 Opening balance result: ${value}`);
            return typeof value === 'number' ? value : parseFloat(value) || 0;
        } else {
            // Fallback: try to parse as text (legacy format)
            const value = parseFloat(await response.text());
            console.log(`📊 Opening balance result (text): ${value}`);
            return isNaN(value) ? 0 : value;
        }
    } catch (error) {
        // Retry on network errors (which might be 524)
        if (retryCount < MAX_RETRIES && (error.message.includes('524') || error.message.includes('timeout'))) {
            console.log(`⏳ Network error for ${account} - retrying in ${RETRY_DELAY/1000}s (${retryCount + 1}/${MAX_RETRIES})...`);
            // NOTE: Slot is NOT released here - it's released in executeBalanceSheetBatchQueryImmediate finally block
            await new Promise(r => setTimeout(r, RETRY_DELAY));
            return fetchOpeningBalance(account, anchorDate, filters, retryCount + 1);
        }
        throw error;
    }
}

/**
 * Fetch period activity for account across period range.
 * Uses existing /balance endpoint with batch parameters.
 */
async function fetchPeriodActivityBatch(account, fromPeriod, toPeriod, filters, retryCount = 0) {
    const MAX_RETRIES = 2;
    const RETRY_DELAY = 5000; // 5 seconds
    
    const params = new URLSearchParams();
    params.append('account', account);
    params.append('from_period', fromPeriod);
    params.append('to_period', toPeriod);
    params.append('batch_mode', 'true');  // Enable batch mode
    params.append('include_period_breakdown', 'true');  // Return per-period activity
    
    if (filters.subsidiary) params.append('subsidiary', filters.subsidiary);
    if (filters.department) params.append('department', filters.department);
    if (filters.location) params.append('location', filters.location);
    if (filters.classId) params.append('class', filters.classId);
    // CRITICAL FIX: Backend expects "book" not "accountingbook", and it should be a number or omitted
    if (filters.accountingBook && filters.accountingBook !== '') {
        const bookNum = parseInt(String(filters.accountingBook));
        if (!isNaN(bookNum) && bookNum > 1) {
            // Only send if it's not Primary Book (1) - backend defaults to 1
            params.append('book', bookNum.toString());
        }
        // For Book 1, we omit it (backend defaults to 1)
    }
    
    const url = `${SERVER_URL}/balance?${params.toString()}`;
    
    try {
        const response = await fetch(url);
        if (!response.ok) {
            const errorText = await response.text();
            
            // Retry on 524 timeout (slot is NOT held during retry - retry is just the fetch, not the batch query)
            if (response.status === 524 && retryCount < MAX_RETRIES) {
                console.log(`⏳ 524 timeout for ${account} - retrying in ${RETRY_DELAY/1000}s (${retryCount + 1}/${MAX_RETRIES})...`);
                // NOTE: Slot is NOT released here - it's released in executeBalanceSheetBatchQueryImmediate finally block
                // This retry is just the fetch, not the entire batch query
                await new Promise(r => setTimeout(r, RETRY_DELAY));
                return fetchPeriodActivityBatch(account, fromPeriod, toPeriod, filters, retryCount + 1);
            }
            
            console.error(`❌ Period activity failed (${response.status}): ${errorText}`);
            throw new Error(`Period activity query failed: ${response.status} - ${errorText}`);
        }
        
        // Backend should return JSON with period breakdown when batch_mode=true
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
            const data = await response.json();
            
            // CRITICAL: Check for error code before using period_activity
            if (data.error) {
                console.error(`❌ Period activity error: ${data.error}`);
                throw new Error(data.error);
            }
            
            // Backend returns BalanceResponse with period_activity property for single-account queries
            // period_activity is {period: activity} dictionary
            if (data.period_activity && typeof data.period_activity === 'object') {
                // Single-account response: {period_activity: {period: activity}}
                return data.period_activity;
            }
            
            // Fallback: empty object if period_activity is missing
            console.warn(`⚠️ Missing period_activity in response for ${account}:`, data);
            return {}; // {period: activity}
        } else {
            // Fallback: single value (shouldn't happen with batch_mode)
            throw new Error('Expected JSON response with period breakdown');
        }
    } catch (error) {
        // Retry on network errors (which might be 524)
        if (retryCount < MAX_RETRIES && (error.message.includes('524') || error.message.includes('timeout'))) {
            console.log(`⏳ Network error for ${account} - retrying in ${RETRY_DELAY/1000}s (${retryCount + 1}/${MAX_RETRIES})...`);
            // NOTE: Slot is NOT released here - it's released in executeBalanceSheetBatchQueryImmediate finally block
            await new Promise(r => setTimeout(r, RETRY_DELAY));
            return fetchPeriodActivityBatch(account, fromPeriod, toPeriod, filters, retryCount + 1);
        }
        throw error;
    }
}

/**
 * Compute running balances from opening balance and period activity.
 * 
 * CRITICAL: Processes ALL periods in periodActivity, not just the requested periods.
 * This ensures intermediate periods (e.g., Feb when only Jan and Mar were requested)
 * are included in the cumulative calculation.
 */
function computeRunningBalances(periods, openingBalance, periodActivity) {
    const results = {};
    let runningBalance = openingBalance || 0;
    
    if (DEBUG_COLUMN_BASED_BS_BATCHING) {
        console.log(`🧮 computeRunningBalances: opening=${openingBalance}, requested periods=${periods.join(',')}, activity=`, periodActivity);
    }
    
    // CRITICAL FIX: Process ALL periods in periodActivity, not just requested periods
    // This ensures intermediate periods (e.g., Feb between Jan and Mar) are included
    const allPeriodsInActivity = Object.keys(periodActivity);
    if (allPeriodsInActivity.length > 0) {
        // Sort periods chronologically
        const sortedPeriods = allPeriodsInActivity
            .map(p => ({ period: p, date: parsePeriodToDate(p) }))
            .filter(p => p.date !== null)
            .sort((a, b) => a.date.getTime() - b.date.getTime())
            .map(p => p.period);
        
        if (DEBUG_COLUMN_BASED_BS_BATCHING && sortedPeriods.length !== periods.length) {
            console.log(`🧮   Processing ${sortedPeriods.length} periods from activity (requested ${periods.length}): ${sortedPeriods.join(', ')}`);
        }
        
        // Process all periods in chronological order
        for (const period of sortedPeriods) {
            const activity = periodActivity[period] || 0;
            runningBalance += activity;
            results[period] = runningBalance;
            
            if (DEBUG_COLUMN_BASED_BS_BATCHING) {
                console.log(`🧮   ${period}: ${runningBalance - activity} + ${activity} = ${runningBalance}`);
            }
        }
    } else {
        // Fallback: if periodActivity is empty, process requested periods only
        for (const period of periods) {
            const activity = periodActivity[period] || 0;
            runningBalance += activity;
            results[period] = runningBalance;
            
            if (DEBUG_COLUMN_BASED_BS_BATCHING) {
                console.log(`🧮   ${period}: ${runningBalance - activity} + ${activity} = ${runningBalance}`);
            }
        }
    }
    
    // CRITICAL: Log final results for debugging mismatches
    if (DEBUG_COLUMN_BASED_BS_BATCHING) {
        console.log(`🧮 computeRunningBalances FINAL RESULTS:`, JSON.stringify(results, null, 2));
    }
    
    return results; // {period: balance}
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
let incomePreloadTriggered = false;
let incomePreloadInProgress = false;

function triggerAutoPreload(firstAccount, firstPeriod, filters = null) {
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
    
    // CRITICAL FIX: Update manifest status to "requested" so waitForPeriodCompletion can detect it
    // This prevents formulas from timing out while waiting for preload
    if (filters) {
        const filtersHash = getFilterKey(filters);
        updatePeriodStatus(filtersHash, normalizedPeriod, { status: "requested" });
        console.log(`📋 Manifest updated: ${normalizedPeriod} status = requested (filtersHash: ${filtersHash})`);
    }
    
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
        const triggerData = {
            firstAccount: firstAccount,
            firstPeriod: normalizedPeriod,  // Use normalized period, not raw input
            timestamp: Date.now(),
            reason: autoPreloadTriggered ? `New period detected: ${normalizedPeriod}` : 'First Balance Sheet formula detected',
            filters: filters || null
        };
        localStorage.setItem(triggerId, JSON.stringify(triggerData));
        console.log(`📤 Auto-preload trigger queued: ${triggerId} (period: ${normalizedPeriod})`);
        console.log(`🔬 TRIGGER DEBUG:`, {
            triggerId,
            triggerData,
            localStorageLength: localStorage.length,
            verifyRead: localStorage.getItem(triggerId) ? '✅ Set successfully' : '❌ Not found after set'
        });
        
        // 🔬 VALIDATION: Also trigger a custom event for same-window detection (if storage events don't fire)
        // This is a fallback for when storage events don't work (same-origin issue)
        try {
            window.dispatchEvent(new CustomEvent('netsuite-preload-trigger', { 
                detail: { triggerId, triggerData } 
            }));
            console.log(`🔬 TRIGGER DEBUG: Dispatched custom event for same-window detection`);
        } catch (e) {
            // Custom events might not work in all contexts
            console.warn('⚠️ Could not dispatch custom event:', e);
        }
    } catch (e) {
        console.warn('Could not trigger auto-preload:', e);
    }
}

/**
 * Trigger automatic Income Statement preload when first P&L formula is detected.
 * Similar to triggerAutoPreload but for Income Statement accounts.
 */
function triggerIncomePreload(firstAccount, firstPeriod, filters = null) {
    console.log(`🔍 triggerIncomePreload called: account=${firstAccount}, period=${firstPeriod}, filters=`, filters);
    
    // CRITICAL: Normalize period before using it (handles Range objects)
    const normalizedPeriod = normalizePeriodKey(firstPeriod, false);
    if (!normalizedPeriod) {
        console.warn(`⚠️ triggerIncomePreload: Could not normalize period "${firstPeriod}", skipping preload`);
        return;
    }
    console.log(`✅ Period normalized: "${firstPeriod}" → "${normalizedPeriod}"`);
    
    // Check if this period is already cached (using normalized period)
    const isPeriodCached = checkIfPeriodIsCached(normalizedPeriod);
    console.log(`🔍 Period cache check for "${normalizedPeriod}": ${isPeriodCached ? 'CACHED' : 'NOT CACHED'}`);
    
    if (isPeriodCached) {
        console.log(`✅ Period ${normalizedPeriod} already cached, skipping income preload`);
        return;
    }
    
    // CRITICAL: Allow preload to trigger for NEW periods even if a previous preload is in progress
    if (incomePreloadInProgress) {
        console.log(`🔄 Income preload in progress, but ${normalizedPeriod} is new period - triggering additional preload`);
    }
    
    // If this is the first time, mark as triggered
    if (!incomePreloadTriggered) {
        incomePreloadTriggered = true;
        console.log(`🚀 INCOME PRELOAD: Triggered by first P&L formula (${firstAccount}, ${normalizedPeriod})`);
    } else {
        console.log(`🚀 INCOME PRELOAD: Triggered for new period (${firstAccount}, ${normalizedPeriod})`);
    }
    
    incomePreloadInProgress = true;
    
    // Set localStorage flag so waitForPreload() can detect it
    try {
        localStorage.setItem('netsuite_income_preload_status', 'running');
        localStorage.setItem('netsuite_income_preload_timestamp', Date.now().toString());
    } catch (e) {
        console.warn('Could not set income preload status:', e);
    }
    
    // Send signal to taskpane to trigger income preload
    // Format: netsuite_income_preload_trigger_<timestamp>_<random>
    try {
        const triggerId = `netsuite_income_preload_trigger_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const triggerData = {
            firstAccount: firstAccount,
            firstPeriod: normalizedPeriod,
            timestamp: Date.now(),
            reason: incomePreloadTriggered ? `New period detected: ${normalizedPeriod}` : 'First Income Statement formula detected',
            filters: filters || null,
            accountType: 'income' // Distinguish from BS preload
        };
        localStorage.setItem(triggerId, JSON.stringify(triggerData));
        console.log(`📤 Income preload trigger queued: ${triggerId} (period: ${normalizedPeriod})`);
        
        // Trigger custom event for same-window detection
        try {
            window.dispatchEvent(new CustomEvent('netsuite-income-preload-trigger', { 
                detail: { triggerId, triggerData } 
            }));
        } catch (e) {
            console.warn('⚠️ Could not dispatch custom event:', e);
        }
    } catch (e) {
        console.warn('Could not trigger income preload:', e);
    }
}

/**
 * Mark income preload as complete (called from taskpane)
 */
function markIncomePreloadComplete() {
    incomePreloadInProgress = false;
    
    try {
        localStorage.setItem('netsuite_income_preload_status', 'complete');
        localStorage.setItem('netsuite_income_preload_timestamp', Date.now().toString());
    } catch (e) {
        console.warn('Could not update income preload status:', e);
    }
    
    console.log('✅ INCOME PRELOAD: Complete');
}

// Expose for taskpane
window.markIncomePreloadComplete = markIncomePreloadComplete;

/**
 * Wait for income preload to complete (similar to waitForPeriodCompletion for BS)
 * Returns true if preload completed, false if timeout
 */
async function waitForIncomePreloadComplete(maxWaitMs = 120000) {
    const startTime = Date.now();
    const pollInterval = 1000;  // Check every 1s
    
    while (Date.now() - startTime < maxWaitMs) {
        try {
            const status = localStorage.getItem('netsuite_income_preload_status');
            if (status === 'complete') {
                console.log('✅ Income preload completed - cache should now be populated');
                // Give taskpane a moment to finish writing to cache
                await new Promise(r => setTimeout(r, 500));
                return true;
            } else if (status === 'failed' || status === 'error') {
                console.warn('⚠️ Income preload failed - proceeding without waiting');
                return false;
            }
            // Status is 'running' or null - continue waiting
        } catch (e) {
            console.warn('Error checking income preload status:', e);
        }
        
        await new Promise(r => setTimeout(r, pollInterval));
    }
    
    console.warn(`⏱️ Income preload wait timeout after ${maxWaitMs}ms - proceeding anyway`);
    return false;  // Timeout
}

/**
 * Check if a period is already cached in the preload cache
 * CRITICAL: Normalizes period to ensure cache key matching works correctly
 */
function checkIfPeriodIsCached(period, filtersHash = null) {
    try {
        // Normalize period to ensure it matches cache key format
        // This handles Range objects and various period formats
        // ✅ Use normalizePeriodKey (synchronous, no await needed)
        const normalizedPeriod = normalizePeriodKey(period, false);
        if (!normalizedPeriod) {
            console.log(`🔍 checkIfPeriodIsCached("${period}"): Normalization failed, returning false`);
            return false;
        }
        
        const preloadCache = localStorage.getItem('xavi_balance_cache');
        if (!preloadCache) {
            console.log(`🔍 checkIfPeriodIsCached("${normalizedPeriod}"): No cache found, returning false`);
            return false;
        }
        
        const preloadData = JSON.parse(preloadCache);
        const cacheKeys = Object.keys(preloadData);
        console.log(`🔍 checkIfPeriodIsCached("${normalizedPeriod}"): Checking ${cacheKeys.length} cache keys`);
        
        // Check for legacy format: balance:${account}::${normalizedPeriod} (no filters)
        const legacyPeriodKey = `::${normalizedPeriod}`;
        for (const key of cacheKeys) {
            if (key.endsWith(legacyPeriodKey)) {
                console.log(`✅ checkIfPeriodIsCached("${normalizedPeriod}"): Found cached period (legacy format) in key "${key}", returning true`);
                return true;
            }
        }
        
        // Check for new format: balance:${account}:${filtersHash}:${normalizedPeriod} (with filters)
        // If filtersHash provided, check for exact match; otherwise check for any filtersHash pattern
        if (filtersHash) {
            const newPeriodKey = `:${filtersHash}:${normalizedPeriod}`;
            for (const key of cacheKeys) {
                if (key.endsWith(newPeriodKey)) {
                    console.log(`✅ checkIfPeriodIsCached("${normalizedPeriod}"): Found cached period (with filters) in key "${key}", returning true`);
                    return true;
                }
            }
        } else {
            // No filtersHash provided - check for any filtersHash pattern
            // Pattern: balance:${account}:${anything}:${normalizedPeriod}
            // Escape special regex characters in normalizedPeriod
            const escapedPeriod = normalizedPeriod.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const periodKeyPattern = new RegExp(`:[^:]+:${escapedPeriod}$`);
            for (const key of cacheKeys) {
                if (periodKeyPattern.test(key)) {
                    console.log(`✅ checkIfPeriodIsCached("${normalizedPeriod}"): Found cached period (any filters) in key "${key}", returning true`);
                    return true;
                }
            }
        }
        
        console.log(`🔍 checkIfPeriodIsCached("${normalizedPeriod}"): No matching cache keys found, returning false`);
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
    
    // Reset income preload counter so preload can trigger again
    if (typeof window !== 'undefined') {
        window.totalIncomeFormulasQueued = 0;
        console.log('  Reset income preload counter');
    }
    
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
            classId: item.classId || '',
            accountingBook: item.accountingBook || ''
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
            pendingRequests.balance.clear();
        }
    }
}

// Expose globally for Refresh All to use
window.enterBuildMode = enterBuildMode;

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
    
    // Normalize: convert to string and trim whitespace
    const normalizedType = String(acctType).trim();
    if (!normalizedType) return false;
    
    // All Balance Sheet account types (Assets, Liabilities, Equity)
    // These are the exact NetSuite account type values
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
    
    // Exact match (case-sensitive) - NetSuite types are case-sensitive
    return bsTypes.includes(normalizedType);
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
// CRITICAL FIX: Normalize empty accountingBook to "1" (Primary Book) for consistent filtersHash
// This ensures formulas with accountingBook="" and accountingBook="1" use the same manifest/cache
function getFilterKey(params) {
    const sub = String(params.subsidiary || '').trim();
    const dept = String(params.department || '').trim();
    const loc = String(params.location || '').trim();
    const cls = String(params.classId || '').trim();
    // CRITICAL: Normalize empty accountingBook to "1" (Primary Book) for consistent filtersHash
    // Backend defaults to Book 1 if book is null/omitted, so empty string and "1" should be treated the same
    let book = String(params.accountingBook || '').trim();
    if (book === '' || book === '1') {
        book = '1'; // Normalize to "1" for Primary Book
    }
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
                const localStorageValue = checkLocalStorageCache(account, fromPeriod, toPeriod, subsidiary, filtersHash);
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
    // All cumulative items have been processed and resolved (they're awaited in the loop above)
    if (regularItems.length === 0) {
        const elapsed = ((Date.now() - batchStartTime) / 1000).toFixed(1);
        const totalProcessed = cumulativeItems.length + balanceCurrencyItems.length;
        if (totalProcessed > 0) {
            // Broadcast status AFTER all cumulative items are processed and resolved
            broadcastStatus(`✅ Updated ${totalProcessed} cell${totalProcessed > 1 ? 's' : ''} (${elapsed}s)`, 100, 'success');
            setTimeout(clearStatus, 10000);
        }
        return;
    }
    
    
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
        
        // Track periods by year to detect full-year requests
        const periodsByYear = new Map(); // year -> Set of month names
        for (const p of periodsArray) {
            if (!p) continue;
            const periodMatch = p.match(/^(\w+)\s+(\d{4})$/);
            if (periodMatch) {
                const year = periodMatch[2];
                if (!periodsByYear.has(year)) {
                    periodsByYear.set(year, new Set());
                }
                periodsByYear.get(year).add(periodMatch[1]);
            }
        }
        
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
        
        // IMPROVED: Check if we have 10+ months of a single year for P&L accounts
        // This detects the quick start income statement pattern (12 single-period requests for same year)
        let usePLFullYear = false;
        if (yearsArray.length > 0 && plAccounts.length >= 5) {
            // Check each year to see if we have 10+ months
            for (const year of yearsArray) {
                if (periodsByYear.has(year)) {
                    const monthsInYear = periodsByYear.get(year);
                    if (monthsInYear.size >= 10) {
                        usePLFullYear = true;
                        console.log(`   ✅ BUILD MODE: Detected ${monthsInYear.size} months of ${year} for ${plAccounts.length} P&L accounts - using full_year_refresh`);
                        break;
                    }
                }
            }
            // Fallback: If we have all 12 months of a single year, use full year refresh
            if (!usePLFullYear && yearsArray.length === 1) {
                const year = yearsArray[0];
                if (periodsByYear.has(year)) {
                    const monthsInYear = periodsByYear.get(year);
                    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                    const hasAllMonths = monthNames.every(m => monthsInYear.has(m));
                    if (hasAllMonths) {
                        usePLFullYear = true;
                        console.log(`   ✅ BUILD MODE: Detected all 12 months of ${year} for ${plAccounts.length} P&L accounts - using full_year_refresh`);
                    }
                }
            }
        }
        
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
                        classId: filters.classId,
                        accountingBook: filters.accountingBook
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
                                    classId: filters.classId,
                                    accountingBook: filters.accountingBook
                                });
                                cache.balance.set(ck, bsBalances[acct][period]);
                                bsCached++;
                            }
                        }
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
                        classId: filters.classId,
                        accountingBook: filters.accountingBook
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
                        
                        // CRITICAL FIX: Backend expects "book" not "accountingbook", and it should be a number or omitted
                        const payload = {
                            year: parseInt(year),
                            subsidiary: filters.subsidiary,
                            department: filters.department,
                            location: filters.location,
                            class: filters.classId,
                            skip_bs: true
                        };
                        // Only include book if it's not empty (convert string to number)
                        if (filters.accountingBook && filters.accountingBook !== '' && filters.accountingBook !== '1') {
                            const bookNum = parseInt(filters.accountingBook);
                            if (!isNaN(bookNum)) {
                                payload.book = bookNum;
                            }
                        }
                        
                        const response = await fetch(`${SERVER_URL}/batch/full_year_refresh`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(payload)
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
                                        classId: filters.classId,
                                        accountingBook: filters.accountingBook
                                    });
                                    cache.balance.set(ck, yearBalances[acct][period]);
                                    plCached++;
                                }
                            }
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
                                    classId: filters.classId,
                                    accountingBook: filters.accountingBook
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
                                        classId: filters.classId,
                                        accountingBook: filters.accountingBook
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
                        classId: filters.classId,
                        accountingBook: filters.accountingBook
                    });
                    cache.balance.set(ck, 0);
                    zeroCached++;
                }
            }
        }
        if (zeroCached > 0) {
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
            // Build filtersHash for cache lookup
            const filtersHash = getFilterKey({ subsidiary, department: '', location: '', classId: '', accountingBook: '' });
            value = checkLocalStorageCache(account, fromPeriod, toPeriod, subsidiary, filtersHash);
            
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
const STORAGE_TTL = 3600000; // 1 hour in milliseconds (increased from 5 minutes for normal spreadsheet work sessions)

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
        // CRITICAL FIX: Preload cache now includes filters in the key format
        // Format: balance:${account}:${filtersHash}:${period}
        // If filtersHash is not provided, build it from subsidiary and other filters
        // ================================================================
        try {
            const preloadCache = localStorage.getItem('xavi_balance_cache');
            if (preloadCache) {
                const preloadData = JSON.parse(preloadCache);
                
                // CRITICAL FIX: Try multiple cache key formats to handle different scenarios
                // 1. With full filtersHash (if provided)
                // 2. With partial filtersHash (if only subsidiary provided)
                // 3. Without filters (backward compatibility)
                
                const keysToTry = [];
                
                // Key format 1: With full filtersHash (most specific)
                if (filtersHash) {
                    keysToTry.push(`balance:${account}:${filtersHash}:${lookupPeriod}`);
                }
                
                // Key format 2: With partial filters (subsidiary only, if provided)
                if (subsidiary && subsidiary !== '') {
                    // Try with subsidiary only (assumes empty dept/loc/class, book=1)
                    const partialHash = `${subsidiary}||||1`;
                    keysToTry.push(`balance:${account}:${partialHash}:${lookupPeriod}`);
                }
                
                // Key format 3: Without filters (backward compatibility - old format)
                keysToTry.push(`balance:${account}::${lookupPeriod}`);
                
                // Try each key format in order of specificity
                for (const preloadKey of keysToTry) {
                if (preloadData[preloadKey] && preloadData[preloadKey].value !== undefined) {
                        const cachedEntry = preloadData[preloadKey];
                        const cachedValue = cachedEntry.value;
                        
                        // Check cache staleness (TTL check)
                        if (cachedEntry.timestamp) {
                            const cacheAge = Date.now() - cachedEntry.timestamp;
                            if (cacheAge > STORAGE_TTL) {
                                // Cache expired - skip this entry
                                continue;
                            }
                        }
                        
                    // CRITICAL: Zero balances (0) are valid cached values and must be returned
                    // This prevents redundant API calls for accounts with no transactions
                    // Always log cache hits (removed < 3 restriction for debugging)
                    console.log(`✅ Preload cache hit: ${account}/${lookupPeriod} (key: ${preloadKey}) = ${cachedValue}`);
                    return cachedValue;
                }
                }
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
    // CRITICAL FIX: Normalize empty accountingBook to "1" (Primary Book) for consistent cache keys
    // This ensures cache populated with accountingBook="" matches formulas with accountingBook="1"
    let accountingBook = String(filters.accountingBook || '').trim();
    if (accountingBook === '' || accountingBook === '1') {
        accountingBook = '1'; // Normalize to "1" for Primary Book
    }
    
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
                classId: classId,
                accountingBook: accountingBook
            });
            cache.balance.set(cacheKey, amount);
            cacheCount++;
        }
    }
    
    // Also save to localStorage for cross-context access
    window.saveBalancesToLocalStorage(balances);
    
    
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

// Track requests currently being evaluated (for synchronous batch detection)
// This allows us to detect grid patterns even before requests are queued
// Track active column-based batch execution to prevent duplicate executions
// Track active column-based batch executions to prevent duplicate API calls
// Map<gridKey, Promise<batchResults>>
const activeColumnBatchExecutions = new Map();

// PERIOD-BASED DEDUPLICATION: Track active queries per period to merge account lists
// Map<periodKey, { promise, accounts: Set, periods: Set, filters, gridKey, queryState: 'pending'|'sent' }>
// periodKey = `${periods.join(',')}:${filterKey}` (e.g., "Jan 2025,Feb 2025:1::::1")
// queryState: 'pending' = query not yet sent (can merge accounts), 'sent' = query already in flight
const activePeriodQueries = new Map();

const pendingEvaluation = {
    balance: new Map()  // Map<cacheKey, {account, fromPeriod, toPeriod, filters}>
};

let batchTimer = null;  // Timer reference for BALANCE batching
let typeBatchTimer = null;  // Timer reference for TYPE batching
let budgetBatchTimer = null;  // Timer reference for BUDGET batching
let titleBatchTimer = null;  // Timer reference for NAME/title batching
const BATCH_DELAY = 500;           // Wait 500ms to collect multiple requests (matches build mode settle)
const BUDGET_BATCH_DELAY = 300;    // Faster batch delay for BUDGET (simpler queries)

// Track request timing for smart timer management (prevent reset during rapid drag operations)
let lastRequestTimestamp = null;  // Timestamp of last request that queued
const RAPID_REQUEST_THRESHOLD_MS = 100;  // Requests < 100ms apart are considered rapid
const QUEUE_SIZE_THRESHOLD = 10;  // Don't reset timer if queue size exceeds this
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
    
    // CRITICAL: Handle numeric strings - check for Excel date serials BEFORE period IDs
    // Excel date serials are typically 5+ digits and >= 40000 (dates after ~2009)
    // Period IDs are typically 1-6 digits and < 40000
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
        const numValue = parseFloat(value.trim());
        
        // First check: Is this an Excel date serial? (>= 40000)
        if (numValue >= 40000 && numValue <= 1000000 && Number.isFinite(numValue)) {
            // This is an Excel date serial - convert to number and process below
            value = numValue;
        }
        // Second check: Is this a cached period ID? (< 40000)
        else if (numValue < 40000 && numValue >= 1 && Number.isInteger(numValue)) {
        const periodId = value.trim();
        if (cache.byId[periodId]) {
            return cache.byId[periodId];  // Return cached "Mon YYYY"
        }
        // Not in cache - return null (will need to be resolved via resolvePeriodIdToName)
        return null;
        }
        // If it's a numeric string but doesn't match either pattern, continue processing
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
    // 
    // NOTE: This feature is supported in code but NOT documented to users.
    // Users should use explicit period ranges (e.g., "Jan 2025" to "Dec 2025") for clarity.
    // Year-only format adds complexity and is less intuitive than explicit month ranges.
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
        
        // PERIOD ID FORMAT: Numeric strings like "344" are NetSuite period IDs
        // These should be passed through to the backend as-is (backend resolves them)
        // Period IDs are typically 1-6 digits and are NOT years (not 1900-2100)
        // and NOT Excel date serials (not >= 40000)
        // NOTE: Excel date serials are already handled above, so this only processes period IDs
        if (/^\d{1,6}$/.test(trimmed)) {
            const numValue = parseInt(trimmed, 10);
            // If it's NOT a year (1900-2100) and NOT an Excel date serial (>= 40000),
            // treat it as a period ID and pass through as-is
            if ((numValue < 1900 || numValue > 2100) && numValue < 40000) {
                // This is a period ID - return as-is (backend will resolve it)
                return trimmed;
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
        // CRITICAL FIX: Normalize empty accountingBook to "1" (Primary Book) for consistent cache keys
        // This ensures formulas with accountingBook="" and accountingBook="1" use the same cache
        // Backend defaults to Book 1 if book is null/omitted, so empty string and "1" should be treated the same
        let book = String(params.accountingBook || '').trim();
        if (book === '' || book === '1') {
            book = '1'; // Normalize to "1" for Primary Book
        }
        return JSON.stringify({
            type,
            account: normalizeAccountNumber(params.account),
            fromPeriod: params.fromPeriod,
            toPeriod: params.toPeriod,
            subsidiary: params.subsidiary || '',
            department: params.department || '',
            location: params.location || '',
            class: params.classId || '',
            book: book
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
                if (DEBUG_VERBOSE_LOGGING) {
                    console.log(`⚡ LOCALSTORAGE HIT [title]: ${account} → ${names[account]}`);
                }
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
                if (DEBUG_VERBOSE_LOGGING) {
                    console.log(`⚡ LOCALSTORAGE HIT [type]: ${account} → ${types[account]}`);
                }
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
// SINGLE-PROMISE PERIOD QUERIES (Claude's Architectural Fix - Phase 1)
// ============================================================================
// Map<periodKey, Promise<{account: balance}>>
// periodKey = `${period}:${filtersHash}` (e.g., "Feb 2025:1::::1")
// All cells for the same period await the EXACT SAME Promise that resolves WITH data
const singlePromiseQueries = new Map();

/**
 * Helper functions to parse filtersHash back to filter object
 * filtersHash format: "subsidiary|department|location|class|book"
 */
function extractSubsidiary(filtersHash) {
    const parts = filtersHash.split('|');
    return parts[0] || '';
}

function extractDepartment(filtersHash) {
    const parts = filtersHash.split('|');
    return parts[1] || '';
}

function extractLocation(filtersHash) {
    const parts = filtersHash.split('|');
    return parts[2] || '';
}

function extractClass(filtersHash) {
    const parts = filtersHash.split('|');
    return parts[3] || '';
}

function extractBook(filtersHash) {
    const parts = filtersHash.split('|');
    return parts[4] || '1';
}

/**
 * Write preload results to localStorage cache
 * Cache key format: balance:${account}:${filtersHash}:${period}
 */
function writeToLocalStorageCache(balancesByAccount, period, filtersHash) {
    try {
        const existing = JSON.parse(localStorage.getItem('xavi_balance_cache') || '{}');
        const cacheEntries = {};
        
        for (const [account, balance] of Object.entries(balancesByAccount)) {
            const cacheKey = `balance:${account}:${filtersHash}:${period}`;
            cacheEntries[cacheKey] = { value: balance, timestamp: Date.now() };
        }
        
        const merged = { ...existing, ...cacheEntries };
        localStorage.setItem('xavi_balance_cache', JSON.stringify(merged));
        console.log(`✅ Cached ${Object.keys(balancesByAccount).length} accounts for ${period} in localStorage`);
    } catch (e) {
        console.warn('⚠️ Failed to write to localStorage cache:', e);
    }
}

/**
 * Execute FULL preload for a single period
 * Calls /batch/bs_preload and transforms response to {account: balance} format
 * Resolves the promise with the transformed data so ALL awaiting cells get results simultaneously
 */
async function executeFullPreload(periodKey) {
    const periodQuery = singlePromiseQueries.get(periodKey);
    if (!periodQuery) {
        console.warn(`⚠️ executeFullPreload: No query found for ${periodKey}`);
        return;
    }
    
    // Parse periodKey: "Feb 2025:1::::1" -> period="Feb 2025", filtersHash="1::::1"
    const [period, filtersHash] = periodKey.split(':');
    
    console.log(`🚀 EXECUTING FULL PRELOAD: ${periodKey}, period=${period}, filtersHash=${filtersHash}`);
    
    // Notify task pane that preload is starting
    try {
        localStorage.setItem('xavi_preload_progress', JSON.stringify({
            status: 'started',
            period: period,
            message: `⚡ Preloading`,
            progress: 10,
            stats: 'Doing the heavy lifting for balance sheet accounts. Getting initial balances for a period can take some time as we work with your NetSuite data to sum values from the beginning of time. Good news - once this formula is resolved all balance sheet accounts for the same period will resolve instantly',
            timestamp: Date.now()
        }));
    } catch (e) {
        // Ignore localStorage errors
    }
    
    try {
        // Extract filters from filtersHash
        const subsidiary = extractSubsidiary(filtersHash);
        const department = extractDepartment(filtersHash);
        const location = extractLocation(filtersHash);
        const classId = extractClass(filtersHash);
        const accountingBook = extractBook(filtersHash);
        
        // Update progress: query starting
        try {
            localStorage.setItem('xavi_preload_progress', JSON.stringify({
                status: 'querying',
                period: period,
                message: `⚡ Preloading`,
                progress: 30,
                stats: 'Doing the heavy lifting for balance sheet accounts. Getting initial balances for a period can take some time as we work with your NetSuite data to sum values from the beginning of time. Good news - once this formula is resolved all balance sheet accounts for the same period will resolve instantly',
                timestamp: Date.now()
            }));
        } catch (e) {
            // Ignore localStorage errors
        }
        
        // Call FULL preload endpoint
        const response = await fetch(`${SERVER_URL}/batch/bs_preload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                periods: [period], // Single period
                subsidiary: subsidiary || undefined,
                department: department || undefined,
                location: location || undefined,
                class: classId || undefined,
                accountingBook: accountingBook !== '1' ? accountingBook : undefined
            })
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const result = await response.json();
        
        // TRANSFORM: Extract balances for the specific period
        // Backend returns: { "10010": { "Feb 2025": 12345.67 }, ... }
        // We need: { "10010": 12345.67, ... }
        const balancesByAccount = {};
        if (result.balances) {
            for (const [account, periodBalances] of Object.entries(result.balances)) {
                // periodBalances is { "Feb 2025": 12345.67 }
                if (periodBalances && typeof periodBalances === 'object') {
                    const balance = periodBalances[period];
                    if (balance !== undefined) {
                        balancesByAccount[account] = balance;
                    }
                }
            }
        }
        
        console.log(`✅ PRELOAD COMPLETE: ${period}, accounts=${Object.keys(balancesByAccount).length}`);
        
        // Update progress: processing complete
        try {
            localStorage.setItem('xavi_preload_progress', JSON.stringify({
                status: 'processing',
                period: period,
                message: `⚡ Preloading`,
                progress: 80,
                stats: `Processing ${Object.keys(balancesByAccount).length} accounts...`,
                timestamp: Date.now()
            }));
        } catch (e) {
            // Ignore localStorage errors
        }
        
        // Write to localStorage cache (for future lookups)
        writeToLocalStorageCache(balancesByAccount, period, filtersHash);
        
        // Set preload marker
        localStorage.setItem(`preload_complete:${period}:${filtersHash}`, Date.now().toString());
        
        // Update progress: complete
        try {
            localStorage.setItem('xavi_preload_progress', JSON.stringify({
                status: 'completed',
                period: period,
                message: `✅ Preload complete`,
                progress: 100,
                stats: `${Object.keys(balancesByAccount).length} accounts cached`,
                timestamp: Date.now()
            }));
            // Clear after a short delay so task pane can show completion
            setTimeout(() => {
                try {
                    localStorage.removeItem('xavi_preload_progress');
                } catch (e) {
                    // Ignore
                }
            }, 2000);
        } catch (e) {
            // Ignore localStorage errors
        }
        
        // RESOLVE THE PROMISE WITH THE TRANSFORMED DATA
        // This makes ALL awaiting cells get results SIMULTANEOUSLY
        periodQuery.resolve(balancesByAccount);
        
        // Clean up
        singlePromiseQueries.delete(periodKey);
        
    } catch (error) {
        console.error(`❌ PRELOAD FAILED: ${periodKey}`, error);
        
        // Update progress: error
        try {
            localStorage.setItem('xavi_preload_progress', JSON.stringify({
                status: 'error',
                period: period,
                message: `❌ Preload failed`,
                progress: 0,
                stats: error.message || 'An error occurred',
                timestamp: Date.now()
            }));
            // Clear after delay
            setTimeout(() => {
                try {
                    localStorage.removeItem('xavi_preload_progress');
                } catch (e) {
                    // Ignore
                }
            }, 3000);
        } catch (e) {
            // Ignore localStorage errors
        }
        
        periodQuery.reject(error);
        singlePromiseQueries.delete(periodKey);
    }
}

/**
 * Single-promise flow for balance sheet accounts
 * All cells for the same period await the EXACT SAME Promise
 */
async function singlePromiseFlow(account, toPeriod, filtersHash, cacheKey) {
    // Create period key: "Feb 2025:1::::1"
    const periodKey = `${toPeriod}:${filtersHash}`;
    
    // Check if query already exists for this period
    let periodQuery = singlePromiseQueries.get(periodKey);
    
    if (!periodQuery) {
        // Create new query with promise
        let resolve, reject;
        const promise = new Promise((res, rej) => {
            resolve = res;
            reject = rej;
        });
        
        periodQuery = {
            promise,
            resolve,
            reject,
            period: toPeriod,
            filtersHash,
            startTime: Date.now()
        };
        
        singlePromiseQueries.set(periodKey, periodQuery);
        
        // Start preload immediately (no debounce for single-promise approach)
        console.log(`🔄 NEW SINGLE-PROMISE QUERY: ${periodKey}`);
        executeFullPreload(periodKey).catch(err => {
            console.error(`❌ executeFullPreload error:`, err);
        });
    } else {
        console.log(`🔄 EXISTING SINGLE-PROMISE QUERY: ${periodKey} (${Date.now() - periodQuery.startTime}ms elapsed)`);
    }
    
    // ALL cells await the EXACT SAME Promise
    try {
        const balancesByAccount = await periodQuery.promise;
        
        // Extract balance for this specific account
        const balance = balancesByAccount[account];
        
        if (balance !== undefined && balance !== null && typeof balance === 'number') {
            // Cache it
            cache.balance.set(cacheKey, balance);
            console.log(`✅ SINGLE-PROMISE RESULT: ${account} for ${toPeriod} = ${balance}`);
            return balance;
        } else {
            // Account not in results (shouldn't happen with full preload, but handle gracefully)
            console.warn(`⚠️ Account ${account} not found in preload results for ${toPeriod}`);
            throw new Error(`Account ${account} not found in preload results`);
        }
    } catch (error) {
        console.error(`❌ SINGLE-PROMISE ERROR for ${account}/${toPeriod}:`, error);
        throw error;
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
    // DIAGNOSTIC: Log start of BALANCE evaluation
    console.log(`🔍 BALANCE START: account=${account}, period=${toPeriod}, timestamp=${Date.now()}`);
    
    // Cross-context cache invalidation - taskpane signals via localStorage
    // FIX #1 & #5: Synchronize cache clear - taskpane signals via localStorage
    // This ensures cache is cleared before formulas evaluate
    try {
        // Check for build mode signal (for Refresh All to ensure batching)
        const buildModeSignal = localStorage.getItem('netsuite_enter_build_mode');
        if (buildModeSignal) {
            const { timestamp, reason } = JSON.parse(buildModeSignal);
            // Extended window to 30 seconds to handle timing issues
            if (Date.now() - timestamp < 30000) {
                console.log(`🔨 Entering build mode from Refresh All (${reason})`);
                enterBuildMode();
                // Remove signal after processing
                localStorage.removeItem('netsuite_enter_build_mode');
            } else {
                // Signal is stale, remove it
                localStorage.removeItem('netsuite_enter_build_mode');
            }
        }
        
        // CRITICAL: Clear in-memory cache FIRST (before checking signal)
        // This ensures cache is cleared synchronously, not async
        const clearSignal = localStorage.getItem('netsuite_cache_clear_signal');
        if (clearSignal) {
            const { timestamp, reason } = JSON.parse(clearSignal);
            // Extended window to 30 seconds (was 10) to handle timing issues
            if (Date.now() - timestamp < 30000) {
                if (DEBUG_VERBOSE_LOGGING) {
                    console.log(`🔄 Cache cleared (${reason}) - clearing in-memory cache synchronously`);
                }
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
                    if (DEBUG_VERBOSE_LOGGING) {
                        console.log(`   ✅ Cleared localStorage caches from functions.js context`);
                    }
                } catch (e) {
                    console.warn('   ⚠️ Failed to clear localStorage from functions.js:', e);
                }
                // Remove signal after processing
                localStorage.removeItem('netsuite_cache_clear_signal');
                if (DEBUG_VERBOSE_LOGGING) {
                    console.log(`✅ Cache clear complete - all caches cleared synchronously`);
                }
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
            if (DEBUG_VERBOSE_LOGGING) {
                console.log('🔧 __CLEARCACHE__ command received:', itemsStr || 'ALL');
            }
            
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
                    if (DEBUG_VERBOSE_LOGGING) {
                        console.log('   ✓ Cleared localStorage (functions context)');
                    }
                } catch (e) {
                    console.warn('   ⚠️ localStorage clear failed:', e.message);
                }
                
                if (DEBUG_VERBOSE_LOGGING) {
                    console.log(`🗑️ Cleared ALL caches (${cleared} balance entries)`);
                }
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
        const normalizedFromResult = normalizePeriodKey(fromPeriod, true);   // true = isFromPeriod
        const normalizedToResult = normalizePeriodKey(toPeriod, false);      // false = isToPeriod
        
        // CRITICAL: If normalization fails, log warning but still use fallback
        // This helps debug why Excel date serials aren't being converted
        if (normalizedToResult === null && toPeriod && typeof toPeriod === 'number' && toPeriod >= 40000) {
            console.warn(`⚠️ Period normalization failed for Excel date serial: ${toPeriod} (type: ${typeof toPeriod})`);
        }
        
        fromPeriod = normalizedFromResult || fromPeriod;
        toPeriod = normalizedToResult || toPeriod;
        
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
        // Allow:
        // - "Mon YYYY" format (e.g., "Jan 2025")
        // - Year-only "YYYY" format (e.g., "2025") - backend handles expansion
        // - Period ID format (e.g., "344") - numeric ID that backend resolves to period
        // CRITICAL: Reject Excel date serials (>= 40000) - these should have been converted
        const periodPattern = /^([A-Za-z]{3}\s+\d{4}|\d{4}|\d{1,6})$/;
        if (fromPeriod) {
            const fromPeriodNum = typeof fromPeriod === 'number' ? fromPeriod : parseFloat(fromPeriod);
            if (!isNaN(fromPeriodNum) && fromPeriodNum >= 40000 && fromPeriodNum <= 1000000) {
                console.error(`❌ Excel date serial not converted for fromPeriod: "${fromPeriod}" (raw: ${rawFrom})`);
                throw new Error('INVALID_PERIOD');
            }
            if (!periodPattern.test(fromPeriod)) {
            console.error(`❌ Invalid fromPeriod after conversion: "${fromPeriod}" (raw: ${rawFrom})`);
        }
        }
        if (toPeriod) {
            const toPeriodNum = typeof toPeriod === 'number' ? toPeriod : parseFloat(toPeriod);
            if (!isNaN(toPeriodNum) && toPeriodNum >= 40000 && toPeriodNum <= 1000000) {
                console.error(`❌ Excel date serial not converted for toPeriod: "${toPeriod}" (raw: ${rawTo})`);
                throw new Error('INVALID_PERIOD');
            }
            if (!periodPattern.test(toPeriod)) {
            console.error(`❌ Invalid toPeriod after conversion: "${toPeriod}" (raw: ${rawTo})`);
            }
        }
        
        // Other parameters as strings
        // CRITICAL FIX: Use extractValueFromRange for ALL parameters that might be cell references
        // This ensures that when cell values change, the parameters are properly extracted and cache keys update
        subsidiary = extractValueFromRange(subsidiary, 'subsidiary');
        department = extractValueFromRange(department, 'department');
        location = extractValueFromRange(location, 'location');
        classId = extractValueFromRange(classId, 'classId');
        
        // Multi-Book Accounting support - default to empty (uses Primary Book on backend)
        // CRITICAL FIX: Normalize empty accountingBook to "1" (Primary Book) for consistent cache keys and filtersHash
        // This ensures formulas with accountingBook="" and accountingBook="1" use the same cache/manifest
        // Note: API calls will still omit book parameter for "1" (handled in API call logic)
        // CRITICAL: Use extractValueFromRange to properly handle Excel Range objects (e.g., $H$1)
        const rawAccountingBook = accountingBook;
        accountingBook = extractValueFromRange(accountingBook, 'accountingBook');
        if (accountingBook === '' || accountingBook === '1') {
            accountingBook = '1'; // Normalize to "1" for Primary Book
        }
        
        // CRITICAL DEBUG: Log accounting book to verify it's being read correctly
        console.log(`🔍 BALANCE DEBUG: account=${account}, accountingBook="${accountingBook}" (raw: ${rawAccountingBook}, type: ${typeof rawAccountingBook})`);
        
        // DEBUG: Log subsidiary to trace (Consolidated) suffix handling
        if (subsidiary && subsidiary.toLowerCase().includes('europe')) {
            console.log(`🔍 BALANCE DEBUG: account=${account}, subsidiary="${subsidiary}", hasConsolidated=${subsidiary.includes('(Consolidated)')}`);
        }
        
        // VALIDATION: Check subsidiary/accounting book combination
        const validationError = await validateSubsidiaryAccountingBook(subsidiary, accountingBook);
        if (validationError === 'INVALID_COMBINATION') {
            console.error(`❌ BALANCE: Invalid combination - subsidiary "${subsidiary}" not enabled for accounting book ${accountingBook}`);
            throw new Error('INVALID_COMBINATION');
        } else if (validationError === 'INVALID_BOOK') {
            console.error(`❌ BALANCE: Accounting book ${accountingBook} has no enabled subsidiaries`);
            throw new Error('INVALID_BOOK');
        }
        
        const params = { account, fromPeriod, toPeriod, subsidiary, department, location, classId, accountingBook };
        const cacheKey = getCacheKey('balance', params);
        
        // ================================================================
        // HARD EXECUTION SPLIT: Account Type Gate (CRITICAL - Before Queuing)
        // Income/Expense accounts MUST route to existing IS logic immediately
        // They must NEVER enter the queue, pattern detection, or batching logic
        // ================================================================
        // Check account type from cache first (synchronous, fast)
        const typeCacheKey = getCacheKey('type', { account });
        let accountType = cache.type.has(typeCacheKey) ? cache.type.get(typeCacheKey) : null;
        
        // If not in cache, fetch it (async) - MUST wait before proceeding
        if (!accountType) {
            accountType = await getAccountType(account);
        }
        
        // Extract type string from accountType (handles JSON string or object)
        // Declare once at function scope - will be reused in both income and balance sheet paths
        let acctTypeStr = '';
        if (!accountType) {
            acctTypeStr = '';
        } else if (typeof accountType === 'string') {
            // Check if it's a JSON string first
            const trimmed = accountType.trim();
            if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
                try {
                    const parsed = JSON.parse(trimmed);
                    acctTypeStr = (parsed.type || parsed.accountType || '').toString().trim();
                } catch (e) {
                    // Not valid JSON, treat as plain string
                    acctTypeStr = trimmed;
                }
            } else {
                // Plain string type
                acctTypeStr = trimmed;
            }
        } else if (accountType && typeof accountType === 'object') {
            // Handle object format: { account: "10010", type: "Bank", display_name: "Bank" }
            acctTypeStr = (accountType.type || accountType.accountType || '').toString().trim();
        } else {
            acctTypeStr = String(accountType).trim();
        }
        
        // INCOME STATEMENT PATH: Route to queue for batching (with preload support)
        // Income/Expense accounts should be batched together for efficient year queries
        // Now includes preload support similar to Balance Sheet accounts
        if (acctTypeStr && (acctTypeStr === 'Income' || acctTypeStr === 'COGS' || acctTypeStr === 'Expense' || 
            acctTypeStr === 'OthIncome' || acctTypeStr === 'OthExpense')) {
            // Check cache first (before queuing)
            if (cache.balance.has(cacheKey)) {
                const cachedValue = cache.balance.get(cacheKey);
                cacheStats.hits++;
                console.log(`✅ In-memory cache hit: ${account}/${toPeriod} = ${cachedValue}`);
                return cachedValue;
            }
            
            // Check if period is resolved (required for queuing and preload)
            // CRITICAL: Normalize period again to ensure it's in "Mon YYYY" format (not Excel date serial)
            const normalizedToPeriod = normalizePeriodKey(toPeriod, false);
            if (!normalizedToPeriod || normalizedToPeriod === '') {
                console.log(`⏳ Income Statement: Period not yet resolved for ${account} (raw: ${toPeriod}) - proceeding to API path`);
                // Continue to API path below (don't throw - Excel will re-evaluate when period resolves)
            } else {
                // Check localStorage cache (from preload) using normalized period
                // Get filtersHash for cache lookup
                const filtersHash = getFilterKey({ subsidiary, department, location, classId, accountingBook });
                const localStorageValue = checkLocalStorageCache(account, fromPeriod, normalizedToPeriod, subsidiary, filtersHash);
                if (localStorageValue !== null) {
                    cacheStats.hits++;
                    cache.balance.set(cacheKey, localStorageValue);
                    console.log(`✅ localStorage cache hit: ${account}/${normalizedToPeriod} = ${localStorageValue}`);
                    // Clean up pendingEvaluation on early return (evalKey defined below)
                    const filtersForCleanup = { subsidiary, department, location, classId, accountingBook };
                    const evalKeyForCleanup = `IS::${account}::${fromPeriod || ''}::${normalizedToPeriod}::${filtersHash}`;
                    pendingEvaluation.balance.delete(evalKeyForCleanup);
                    return localStorageValue;
                } else {
                    console.log(`❌ Cache miss: ${account}/${normalizedToPeriod} - will queue for API call`);
                }
                
                // ================================================================
                // GRID DETECTION: Add to pendingEvaluation EARLY (like Balance Sheet at line 7918)
                // This allows grid detection to see all concurrent requests
                // ================================================================
                const filters = { subsidiary, department, location, classId, accountingBook };
                const evalKey = `IS::${account}::${fromPeriod || ''}::${normalizedToPeriod}::${filtersHash}`;
                pendingEvaluation.balance.set(evalKey, { 
                    account, 
                    fromPeriod, 
                    toPeriod: normalizedToPeriod, 
                    filters
                });
                console.log(`📊 Income Statement: Added to pendingEvaluation (${pendingEvaluation.balance.size} total)`);
                
                // Check if income preload is already in progress
                let preloadInProgress = false;
                let preloadTimestamp = null;
                try {
                    const preloadStatus = localStorage.getItem('netsuite_income_preload_status');
                    preloadInProgress = (preloadStatus === 'running' || preloadStatus === 'requested');
                    const timestampStr = localStorage.getItem('netsuite_income_preload_timestamp');
                    if (timestampStr) {
                        preloadTimestamp = parseInt(timestampStr);
                    }
                } catch (e) {
                    // Ignore localStorage errors
                }
                
                // Income Statement preload: Period-aware triggering (similar to Balance Sheet)
                // Check if this period is already cached
                const isPeriodCached = checkIfPeriodIsCached(normalizedToPeriod, filtersHash);
                console.log(`🔍 Income preload check: period = ${normalizedToPeriod}, isPeriodCached = ${isPeriodCached}, preloadInProgress = ${preloadInProgress}`);
                
                // Check if this period is already pending preload (duplicate trigger prevention)
                const pendingKey = `income_preload_pending:${normalizedToPeriod}:${filtersHash || ''}`;
                let isPending = false;
                try {
                    const pendingTimestamp = localStorage.getItem(pendingKey);
                    if (pendingTimestamp) {
                        const pendingAge = Date.now() - parseInt(pendingTimestamp);
                        // Consider pending if less than 2 minutes old (preload should complete within 120s)
                        if (pendingAge < 120000) {
                            isPending = true;
                        } else {
                            // Stale pending flag - clear it
                            localStorage.removeItem(pendingKey);
                        }
                    }
                } catch (e) {
                    // Ignore localStorage errors
                }
                
                let shouldWaitForPreload = false;

                // ================================================================
                // GRID DETECTION: Check for multi-period pattern BEFORE preload wait
                // If grid detected (3+ periods, 2+ accounts), skip preload wait
                // and let processBatchQueue() handle all requests together with full-year refresh
                // ================================================================
                const evaluatingRequests = Array.from(pendingEvaluation.balance.values());
                const uniquePeriods = new Set();
                const uniqueAccounts = new Set();
                for (const req of evaluatingRequests) {
                    if (req.toPeriod) {
                        const normalized = normalizePeriodKey(req.toPeriod, false);
                        if (normalized) uniquePeriods.add(normalized);
                    }
                    if (req.account) uniqueAccounts.add(req.account);
                }

                // Grid pattern threshold: 3+ periods AND 2+ accounts
                // This matches detectColumnBasedPLGrid() requirements (line 925)
                const isGridPattern = uniquePeriods.size >= 3 && uniqueAccounts.size >= 2;

                if (isGridPattern) {
                    // ================================================================
                    // GRID MODE: Skip preload wait - batch queue will handle efficiently
                    // ================================================================
                    console.log(`📊 GRID MODE DETECTED: ${uniquePeriods.size} periods × ${uniqueAccounts.size} accounts`);
                    console.log(`   ⏭️ Skipping preload wait - batch queue will use full-year refresh`);
                    shouldWaitForPreload = false;
                    
                    // Still trigger preload in background (for cache population) but DON'T wait
                    if (!isPeriodCached && !isPending) {
                        try {
                            localStorage.setItem(pendingKey, Date.now().toString());
                        } catch (e) {
                            console.warn('Could not set pending flag:', e);
                        }
                        console.log(`🚀 Triggering background preload for ${normalizedToPeriod} (no wait)`);
                        triggerIncomePreload(account, normalizedToPeriod, { subsidiary, department, location, classId, accountingBook });
                    }
                } else {
                    // ================================================================
                    // NORMAL MODE: Few periods - use preload wait for optimal single-period performance
                    // ================================================================
                    console.log(`📊 NORMAL MODE: ${uniquePeriods.size} periods × ${uniqueAccounts.size} accounts - using preload wait`);
                    
                    if (!isPeriodCached && !isPending) {
                        // Mark as pending BEFORE triggering to prevent duplicate triggers
                        try {
                            localStorage.setItem(pendingKey, Date.now().toString());
                        } catch (e) {
                            console.warn('Could not set pending flag:', e);
                        }
                        console.log(`🚀 Period ${normalizedToPeriod} not cached - triggering income preload`);
                        triggerIncomePreload(account, normalizedToPeriod, { subsidiary, department, location, classId, accountingBook });
                        console.log(`✅ Income preload trigger call completed`);
                        shouldWaitForPreload = true;
                    } else if (isPending) {
                        console.log(`⏳ Period ${normalizedToPeriod} preload already pending - will wait for it to complete`);
                        shouldWaitForPreload = true;
                    } else if (preloadInProgress) {
                        console.log(`⏳ Income preload already in progress - will wait for it to complete`);
                        shouldWaitForPreload = true;
                    } else if (preloadTimestamp && (Date.now() - preloadTimestamp < 10000)) {
                        console.log(`⏳ Income preload was recently triggered (${Math.round((Date.now() - preloadTimestamp) / 1000)}s ago) - will wait for it to complete`);
                        shouldWaitForPreload = true;
                    } else if (isPeriodCached) {
                        console.log(`✅ Period ${normalizedToPeriod} is already cached - no preload needed`);
                    } else {
                        // Fallback: Re-check preload status after brief delay (handles race conditions)
                        console.log(`⏳ Re-checking preload status for ${normalizedToPeriod}...`);
                        await new Promise(r => setTimeout(r, 50));
                        try {
                            const recheckStatus = localStorage.getItem('netsuite_income_preload_status');
                            const recheckTimestamp = localStorage.getItem('netsuite_income_preload_timestamp');
                            if (recheckStatus === 'running' || recheckStatus === 'requested') {
                                console.log(`⏳ Income preload detected on recheck - will wait for it to complete`);
                                shouldWaitForPreload = true;
                            } else if (recheckTimestamp && (Date.now() - parseInt(recheckTimestamp) < 10000)) {
                                console.log(`⏳ Income preload timestamp found (recent) - will wait for it to complete`);
                                shouldWaitForPreload = true;
                            } else {
                                console.log(`⏭️ No preload detected for ${normalizedToPeriod} - proceeding to queue`);
                            }
                        } catch (e) {
                            console.log(`⏭️ Error rechecking preload status - proceeding to queue`);
                        }
                    }
                }
                
                // CRITICAL FIX: Wait for preload to complete before proceeding to queue
                // This ensures cache is populated before formulas evaluate, making drag-down instant
                if (shouldWaitForPreload) {
                    console.log(`⏳ Waiting for income preload to complete (max 120s)...`);
                    const preloadCompleted = await waitForIncomePreloadComplete(120000);
                    if (preloadCompleted) {
                        // Preload completed - check cache again before queuing
                        const cachedAfterPreload = checkLocalStorageCache(account, fromPeriod, normalizedToPeriod, subsidiary, filtersHash);
                        if (cachedAfterPreload !== null) {
                            console.log(`✅ Cache hit after preload: ${account}/${normalizedToPeriod} = ${cachedAfterPreload}`);
                            cacheStats.hits++;
                            cache.balance.set(cacheKey, cachedAfterPreload);
                            // Clear pending flag since preload completed and cache is populated
                            try {
                                localStorage.removeItem(pendingKey);
                            } catch (e) {
                                // Ignore localStorage errors
                            }
                            // Clean up pendingEvaluation on early return
                            pendingEvaluation.balance.delete(evalKey);
                            return cachedAfterPreload;
                        }
                        console.log(`⚠️ Preload completed but cache miss for ${account}/${normalizedToPeriod} - proceeding to queue`);
                    } else {
                        console.log(`⚠️ Preload wait timeout or failed - proceeding to queue anyway`);
                    }
                }
                // CRITICAL: Check for build mode signal BEFORE queuing (for Refresh All)
                // This ensures formulas are batched instead of evaluated individually
                const buildModeSignal = localStorage.getItem('netsuite_enter_build_mode');
                if (buildModeSignal && !buildMode) {
                    const { timestamp, reason } = JSON.parse(buildModeSignal);
                    if (Date.now() - timestamp < 30000) {
                        console.log(`🔨 Entering build mode from Refresh All (${reason}) - Income Statement account`);
                        enterBuildMode();
                        // Remove signal after processing
                        localStorage.removeItem('netsuite_enter_build_mode');
                    }
                }
                
                // Route to queue for batching (skip all manifest/preload logic)
                // CRITICAL: Use normalized period for logging and queue
                cacheStats.misses++;
                console.log(`📥 QUEUED [Income Statement]: ${account} for ${fromPeriod || '(cumulative)'} → ${normalizedToPeriod || toPeriod}`);
                console.log(`   ✅ PROOF: Income Statement account routed to queue (NOT per-cell path)`);
                console.log(`   ✅ PROOF: Will be batched with other Income Statement accounts`);
                console.log(`   ✅ PROOF: Queue size: ${pendingRequests.balance.size + 1} (including this request)`);
                console.log(`   ✅ PROOF: Build mode active: ${buildMode}`);
                
                return new Promise((resolve, reject) => {
                    // If build mode is active, add to build mode queue instead
                    if (buildMode) {
                        console.log(`   🔨 Adding to build mode queue (${buildModePending.length + 1} items)`);
                        buildModePending.push({
                            cacheKey,
                            params,
                            resolve,
                            reject
                        });
                        // Reset build mode timer to collect more formulas
                        if (buildModeTimer) {
                            clearTimeout(buildModeTimer);
                        }
                        buildModeTimer = setTimeout(() => {
                            buildModeTimer = null;
                            exitBuildModeAndProcess();
                        }, BUILD_MODE_SETTLE_MS);
                    } else {
                        // Regular queue with batch timer
                        pendingRequests.balance.set(cacheKey, {
                            params,
                            resolve,
                            reject,
                            timestamp: Date.now()
                        });
                        
                        // Start batch timer if not already running
                        // CRITICAL FIX: Smart timer management - don't reset during rapid drag operations
                        if (!isFullRefreshMode) {
                            const now = Date.now();
                            const queueSize = pendingRequests.balance.size;
                            const timeSinceLastRequest = lastRequestTimestamp ? (now - lastRequestTimestamp) : Infinity;
                            const isRapidRequest = timeSinceLastRequest < RAPID_REQUEST_THRESHOLD_MS;
                            const shouldPreventReset = batchTimer !== null && isRapidRequest && queueSize >= QUEUE_SIZE_THRESHOLD;
                            
                            if (shouldPreventReset) {
                                // Don't reset timer - let it fire to process the batch
                                console.log(`⏱️ SKIPPING timer reset (rapid requests: ${timeSinceLastRequest}ms apart, queue: ${queueSize})`);
                            } else {
                                // Normal behavior: reset timer
                                if (batchTimer) {
                                    clearTimeout(batchTimer);
                                    batchTimer = null;
                                }
                                console.log(`⏱️ STARTING batch timer (${BATCH_DELAY}ms) for Income Statement`);
                                batchTimer = setTimeout(() => {
                                    console.log('⏱️ Batch timer FIRED!');
                                    batchTimer = null;
                                    lastRequestTimestamp = null; // Reset tracking
                                    processBatchQueue().catch(err => {
                                        console.error('❌ Batch processing error:', err);
                                    });
                                }, BATCH_DELAY);
                            }
                            
                            // Update last request timestamp
                            lastRequestTimestamp = now;
                        }
                    }
                });
            }
            // If period not resolved, fall through to API path below
        }
        // BALANCE SHEET PATH (Continue with existing BS logic + potential batching)
        // Only reaches here if account is Balance Sheet (or unknown - treated as BS)
        // Balance Sheet accounts may enter queue and be eligible for pattern detection
        
        // ================================================================
        // SYNCHRONOUS BATCH ELIGIBILITY CHECK (Before Any Preload/Manifest Logic)
        // CRITICAL: This runs BEFORE manifest lookup, preload trigger, and preload wait
        // ================================================================
        const filters = { subsidiary, department, location, classId, accountingBook };
        
        // Add this request to pendingEvaluation BEFORE checking eligibility
        // This allows the eligibility check to see other requests currently being evaluated in the same wave
        const evalKey = `${account}::${fromPeriod || ''}::${toPeriod}::${JSON.stringify(filters)}`;
        pendingEvaluation.balance.set(evalKey, { account, fromPeriod, toPeriod, filters });
        
        // ================================================================
        // CRITICAL: Check localStorage BEFORE column-based batching
        // When dragging down, previous batches may have already cached results
        // This prevents redundant batch creation when cache is available
        // ================================================================
        // Normalize periods and filters early (used in multiple places below)
        const filtersHash = getFilterKey({ subsidiary, department, location, classId, accountingBook });
        const lookupPeriod = normalizePeriodKey(fromPeriod || toPeriod, false);
        const isCumulativeQuery = isCumulativeRequest(fromPeriod);
        
        // Check localStorage cache BEFORE column-based batching
        // This ensures dragged cells use cached results instead of creating new batches
        if (isCumulativeQuery && lookupPeriod) {
            const localStorageValue = checkLocalStorageCache(account, fromPeriod, toPeriod, subsidiary, filtersHash);
            // DIAGNOSTIC: Log cache check result
            console.log(`🔍 CACHE CHECK: account=${account}, period=${lookupPeriod}, hit=${localStorageValue !== null}`);
            if (localStorageValue !== null) {
                console.log(`🔍 CACHE HIT - returning early, no batch needed`);
                console.log(`✅ localStorage cache hit BEFORE batch check: ${account}/${lookupPeriod} = ${localStorageValue}`);
                cacheStats.hits++;
                cache.balance.set(cacheKey, localStorageValue);
                pendingEvaluation.balance.delete(evalKey); // Remove from pending since we resolved it
                return localStorageValue;
            }
            console.log(`🔍 CACHE MISS - continuing to batch logic`);
        }
        
        // ================================================================
        // COLUMN-BASED BATCHING: Primary execution path for Balance Sheet grids
        // One query per period (column), returns translated ending balances
        // No anchor math, no activity reconstruction
        // ================================================================
        // CRITICAL FIX: Use isBalanceSheetType() instead of checking for 'Balance Sheet' string
        // getAccountType() returns NetSuite account types like "Bank", "AcctRec", etc., not "Balance Sheet"
        // The cache may store:
        // 1. Plain string: "Bank"
        // 2. JSON string: '{"account":"10010","type":"Bank","display_name":"Bank"}'
        // 3. Object: { account: "10010", type: "Bank", display_name: "Bank" }
        // We need to extract the actual type string to check against isBalanceSheetType()
        // NOTE: acctTypeStr is already declared above (line 7409) - reuse it here
        // If it wasn't set (income path didn't run), extract it now
        if (!acctTypeStr && accountType) {
            if (typeof accountType === 'string') {
                const trimmed = accountType.trim();
                if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
                    try {
                        const parsed = JSON.parse(trimmed);
                        acctTypeStr = (parsed.type || parsed.accountType || '').toString().trim();
                    } catch (e) {
                        acctTypeStr = trimmed;
                    }
                } else {
                    acctTypeStr = trimmed;
                }
            } else if (typeof accountType === 'object') {
                acctTypeStr = (accountType.type || accountType.accountType || '').toString().trim();
            } else {
                acctTypeStr = String(accountType).trim();
            }
        }
        
        // Now check if the extracted type string is a Balance Sheet type
        // isBalanceSheetType() checks if the string (e.g., "Bank") is in the BS types array
        const isBalanceSheet = acctTypeStr && isBalanceSheetType(acctTypeStr);
        
        // ================================================================
        // SINGLE-PROMISE APPROACH: All cells for same period await same promise
        // ================================================================
        if (isCumulativeQuery && lookupPeriod && isBalanceSheet) {
            try {
                const balance = await singlePromiseFlow(account, lookupPeriod, filtersHash, cacheKey);
                pendingEvaluation.balance.delete(evalKey);
                return balance;
            } catch (error) {
                console.warn(`⚠️ Single-promise flow failed, falling back to existing logic:`, error);
                // Fall through to existing column-based batching logic
            }
        }
        
        if (DEBUG_COLUMN_BASED_BS_BATCHING || !isBalanceSheet) {
            console.log(`🔍 [TYPE DEBUG] accountType=`, accountType, `→ extracted="${acctTypeStr}" → isBalanceSheet=${isBalanceSheet}`);
        }
        // DIAGNOSTIC: Log before column-based detection check
        console.log(`🔍 PRE-DETECTION: About to check column-based grid, USE_COLUMN_BASED_BS_BATCHING=${USE_COLUMN_BASED_BS_BATCHING}, isBalanceSheet=${isBalanceSheet}`);
        
        if (USE_COLUMN_BASED_BS_BATCHING && isBalanceSheet) {
            const evaluatingRequests = Array.from(pendingEvaluation.balance.values());
            console.log(`🔍 [BATCH DEBUG] Checking column-based batching: accountType=${acctTypeStr}, isBalanceSheet=${isBalanceSheet}, evaluatingRequests=${evaluatingRequests.length}, account=${account}, toPeriod=${toPeriod}`);
            const columnBasedDetection = detectColumnBasedBSGrid(evaluatingRequests);
            
            // DIAGNOSTIC: Log column detection result
            console.log(`🔍 COLUMN DETECTION: eligible=${columnBasedDetection?.eligible}, accounts=${columnBasedDetection?.allAccounts?.size || 0}, periods=${columnBasedDetection?.columns?.length || 0}`);
            console.log(`🔍 POST-DETECTION: isGrid=${columnBasedDetection?.eligible}, path=${columnBasedDetection?.eligible ? 'batch' : 'individual'}`);
            
            if (columnBasedDetection.eligible) {
                console.log(`✅ [BATCH DEBUG] Grid eligible for column-based batching: ${columnBasedDetection.allAccounts?.size || 0} accounts, ${columnBasedDetection.columns?.length || 0} periods`);
                // Check execution eligibility (no validation/trust requirements)
                // Pass accountType object for compatibility, but execution check should also use isBalanceSheetType
                const executionCheck = isColumnBatchExecutionAllowed(accountType, columnBasedDetection);
                
                // DIAGNOSTIC: Log execution check result
                console.log(`🔍 EXECUTION CHECK: allowed=${executionCheck.allowed}, reason=${executionCheck.reason || 'none'}`);
                console.log(`🔍 [BATCH DEBUG] Execution check result: allowed=${executionCheck.allowed}, reason=${executionCheck.reason || 'none'}`);
                
                if (executionCheck.allowed) {
                    // DIAGNOSTIC: Log batch path entry
                    console.log(`🔍 BATCH PATH: account=${account}, entering debounce logic`);
                    
                    // PERIOD-BASED DEDUPLICATION: Check for existing queries for same periods FIRST
                    // This prevents multiple queries for the same period with different account lists
                    // CRITICAL: Sort periods chronologically (not lexicographically) for consistent periodKey
                    const periods = columnBasedDetection.columns.map(col => col.period).sort((a, b) => {
                        const aDate = parsePeriodToDate(a);
                        const bDate = parsePeriodToDate(b);
                        if (!aDate || !bDate) return 0;
                        return aDate.getTime() - bDate.getTime();
                    });
                    const filterKey = getFilterKey({
                        subsidiary: columnBasedDetection.filters.subsidiary || '',
                        department: columnBasedDetection.filters.department || '',
                        location: columnBasedDetection.filters.location || '',
                        classId: columnBasedDetection.filters.classId || '',
                        accountingBook: columnBasedDetection.filters.accountingBook || ''
                    });
                    // CRITICAL: Store filtersHash for use in executeDebouncedQuery/executeColumnBasedBSBatch
                    // This prevents "Cannot access 'filtersHash' before initialization" error
                    const filtersHash = filterKey; // filterKey is the same as filtersHash
                    
                    // Create period key for deduplication (periods + filters, NOT accounts)
                    const periodKey = `${periods.join(',')}:${filterKey}`;
                    
                    // DEBUG: Log periodKey generation for troubleshooting
                    console.log(`🔍 PERIOD KEY DEBUG: "${periodKey}" from periods: [${periods.join(', ')}], filterKey: "${filterKey}"`);
                    
                    // PERIOD-BASED DEDUPLICATION: Check for active period query BEFORE creating batch
                    // This allows us to merge account lists before the query is sent
                    let accounts = Array.from(columnBasedDetection.allAccounts);
                    let activePeriodQuery = activePeriodQueries.get(periodKey);
                    
                    // DIAGNOSTIC: Log period query check
                    console.log(`🔍 PERIOD QUERY CHECK: periodKey="${periodKey}", exists=${activePeriodQueries.has(periodKey)}`);
                    if (activePeriodQueries.has(periodKey)) {
                        const existing = activePeriodQueries.get(periodKey);
                        console.log(`🔍 EXISTING QUERY: state=${existing.queryState}, accounts=${existing.accounts.size}`);
                    }
                    
                    if (activePeriodQuery) {
                        // Period query already active - check if our account is already in the query
                        console.log(`🔄 PERIOD DEDUP: Periods ${periods.join(', ')} already being queried (state: ${activePeriodQuery.queryState})`);
                        console.log(`   Existing accounts: ${activePeriodQuery.accounts.size}, Our accounts: ${accounts.length}`);
                        
                        // CRITICAL FIX: Check if THIS CELL's account is in the query, not if any of the detected accounts are
                        // The 'accounts' variable contains ALL accounts from grid detection (21-23 accounts),
                        // but we need to check if THIS cell's specific account is in the activePeriodQuery
                        const ourAccountInQuery = activePeriodQuery.accounts.has(account);
                        
                        if (ourAccountInQuery) {
                            // Our account is already being queried - wait for results
                            console.log(`   ✅ Account ${account} already in query, awaiting results...`);
                            try {
                                const batchResults = await activePeriodQuery.promise;
                                const balance = batchResults[account]?.[toPeriod];
                                
                                if (balance !== undefined && balance !== null && typeof balance === 'number') {
                                    cache.balance.set(cacheKey, balance);
                                    console.log(`✅ PERIOD DEDUP RESULT: ${account} for ${toPeriod} = ${balance}`);
                                    pendingEvaluation.balance.delete(evalKey);
                                    return balance;
                                }
                            } catch (error) {
                                console.warn(`⚠️ PERIOD DEDUP: Error in existing query: ${error.message}`);
                            }
                        } else {
                            // Our account is NOT in the active query
                            if (activePeriodQuery.queryState === 'collecting') {
                                // DEBOUNCE WINDOW OPEN: Merge accounts into existing query
                                console.log(`   📊 Account ${account} not in existing query, merging during debounce window (collecting state)`);
                                // DIAGNOSTIC: Log account merge
                                const beforeSize = activePeriodQuery.accounts.size;
                                accounts.forEach(acc => activePeriodQuery.accounts.add(acc));
                                accounts = Array.from(activePeriodQuery.accounts).sort();
                                console.log(`🔍 MERGE: Adding account ${account} to existing query, now ${activePeriodQuery.accounts.size} accounts (was ${beforeSize})`);
                                
                                // Update gridKey with merged accounts
                                const mergedGridKey = `grid:${accounts.join(',')}:${periods.join(',')}:${filterKey}`;
                                activePeriodQuery.gridKey = mergedGridKey;
                                
                                // ROLLING DEBOUNCE: Reset timer when new account arrives
                                if (activePeriodQuery.resetDebounceTimer) {
                                    activePeriodQuery.resetDebounceTimer(activePeriodQuery);
                                }
                                
                                // Return placeholder promise - will resolve when debounced query executes
                                const elapsed = Date.now() - (activePeriodQuery.startTime || Date.now());
                                console.log(`   ⏳ Awaiting debounced query execution (${activePeriodQuery.accounts.size} accounts collected, ${elapsed}ms elapsed)...`);
                                try {
                                    const batchResults = await activePeriodQuery.promise;
                                    const balance = batchResults[account]?.[toPeriod];
                                    
                                    if (balance !== undefined && balance !== null && typeof balance === 'number') {
                                        cache.balance.set(cacheKey, balance);
                                        console.log(`✅ PERIOD DEDUP RESULT (debounced): ${account} for ${toPeriod} = ${balance}`);
                                        pendingEvaluation.balance.delete(evalKey);
                                        return balance;
                                    }
                                } catch (error) {
                                    console.warn(`⚠️ PERIOD DEDUP: Error in debounced query: ${error.message}`);
                                    // Fall through to create supplemental batch
                                }
                            } else if (activePeriodQuery.queryState === 'pending') {
                                // Legacy state (shouldn't happen with debounce, but handle for safety)
                                console.log(`   📊 Account ${account} not in existing query, merging before query is sent`);
                                accounts.forEach(acc => activePeriodQuery.accounts.add(acc));
                                accounts = Array.from(activePeriodQuery.accounts).sort();
                                // Continue to create new batch with merged accounts
                            } else {
                                // Query already sent - await existing promise, then check if account is in results
                                // If not, we'll need a supplemental query (but this should be rare)
                                console.log(`   ⏳ Account ${account} not in query (already sent) - awaiting results, then checking...`);
                                try {
                                    const batchResults = await activePeriodQuery.promise;
                                    const balance = batchResults[account]?.[toPeriod];
                                    
                                    if (balance !== undefined && balance !== null && typeof balance === 'number') {
                                        cache.balance.set(cacheKey, balance);
                                        console.log(`✅ PERIOD DEDUP RESULT (post-query): ${account} for ${toPeriod} = ${balance}`);
                                        pendingEvaluation.balance.delete(evalKey);
                                        return balance;
                                    } else {
                                        // Account not in results - create explicit supplemental query
                                        // This should be rare (only if account truly missing from preload results)
                                        console.warn(`⚠️ Account ${account} not found in completed query results - creating supplemental query`);
                                        // Fall through to create supplemental batch below (lines 6757+)
                                        // The supplemental query will be a new batch with just this account
                                    }
                                } catch (error) {
                                    console.warn(`⚠️ PERIOD DEDUP: Error awaiting existing query: ${error.message}`);
                                    // Fall through to create new batch
                                }
                            }
                        }
                    }
                    
                    // No active query for these periods, or we need to create one with merged accounts
                    // Create grid key with merged accounts
                    const gridKey = `grid:${accounts.join(',')}:${periods.join(',')}:${filterKey}`;
                    
                    // CRITICAL FIX: If activePeriodQuery exists and is in 'collecting' state (debounce window open),
                    // we should ALWAYS use the existing promise and NOT create a new batch.
                    // This prevents multiple queries from being created during the debounce window.
                    if (activePeriodQuery && activePeriodQuery.queryState === 'collecting') {
                        // Debounce window is open - use existing promise, don't create new batch
                        const elapsed = Date.now() - (activePeriodQuery.startTime || Date.now());
                        console.log(`⏳ DEBOUNCE: Using existing collecting query for ${periodKey}, awaiting debounce timer (${activePeriodQuery.accounts.size} accounts, ${elapsed}ms elapsed)`);
                        const existingPromise = activePeriodQuery.promise;
                        // Set in activeColumnBatchExecutions so other cells see it
                        activeColumnBatchExecutions.set(gridKey, existingPromise);
                        // Use existing promise - skip batch creation
                        batchPromise = existingPromise;
                    } else if (activePeriodQuery && activePeriodQuery.queryState === 'sent') {
                        // Query already sent - check cache first before falling back
                        console.log(`🔍 NO ACTIVE QUERY (sent): ${periodKey} - query already executing, checking cache before fallback`);
                        const sentQueryCacheCheck = checkLocalStorageCache(account, fromPeriod, toPeriod, subsidiary, filtersHash);
                        if (sentQueryCacheCheck !== null) {
                            console.log(`✅ SENT QUERY CACHE HIT: ${account}/${toPeriod} = ${sentQueryCacheCheck} (query in progress, using cached result)`);
                            cacheStats.hits++;
                            cache.balance.set(cacheKey, sentQueryCacheCheck);
                            pendingEvaluation.balance.delete(evalKey);
                            return sentQueryCacheCheck;
                        }
                        // Cache miss - await the existing query
                        batchPromise = activePeriodQuery.promise;
                    } else {
                        // Check if this exact grid is already being executed
                        batchPromise = activeColumnBatchExecutions.get(gridKey);
                        if (!batchPromise) {
                            console.log(`🔍 NO ACTIVE QUERY: ${periodKey} - no active query found, will create new batch or fallback`);
                        }
                    }
                    
                    // ATOMIC CHECK-AND-SET: Prevent race conditions when multiple cells evaluate simultaneously
                    // Strategy: Check if batch exists, if not create promise immediately (synchronously) and set it
                    if (!batchPromise) {
                            // No batch exists - create one immediately (synchronously) to prevent race conditions
                            const accountCount = accounts.length;
                            const periodCount = periods.length;
                            console.log(`🚀 COLUMN-BASED BS BATCH EXECUTING: ${accountCount} accounts × ${periodCount} periods (gridKey: ${gridKey.substring(0, 50)}...)`);
                            console.log(`📊 Querying translated ending balances (chunked processing: 2 periods per chunk)`);
                            
                            // Update grid with merged accounts
                            const updatedGrid = {
                                ...columnBasedDetection,
                                allAccounts: new Set(accounts)
                            };
                            
                            // CRITICAL FIX: Register in activePeriodQueries BEFORE creating promise
                            // This ensures other cells checking for active queries will find it immediately
                            // If we register after promise creation, there's a gap where other cells won't see the active query
                            if (!activePeriodQuery) {
                            // DEBOUNCE MECHANISM: Create placeholder promise and register immediately
                            // This ensures activePeriodQueries entry exists synchronously
                            // Query will execute after 100ms debounce window to collect all accounts
                            let resolvePlaceholder, rejectPlaceholder;
                            const placeholderPromise = new Promise((resolve, reject) => {
                                resolvePlaceholder = resolve;
                                rejectPlaceholder = reject;
                            });
                            
                            // ROLLING DEBOUNCE: Reset timer each time a new account arrives
                            // This ensures we collect all accounts that arrive within the window
                            // Base delay: 200ms after last account arrives
                            // Maximum total wait: 1000ms to prevent infinite waiting
                            const DEBOUNCE_MS = 200;        // Base delay after last account
                            const MAX_DEBOUNCE_MS = 1000;   // Maximum total wait time
                            const startTime = Date.now();
                            
                            // Helper function to reset debounce timer
                            const resetDebounceTimer = (query) => {
                                // Clear existing timer
                                if (query.executeTimeout) {
                                    clearTimeout(query.executeTimeout);
                                }
                                
                                // Calculate elapsed time
                                const elapsed = Date.now() - query.startTime;
                                
                                // If we haven't exceeded max wait, reset timer
                                if (elapsed < MAX_DEBOUNCE_MS) {
                                    const remainingWindow = Math.min(DEBOUNCE_MS, MAX_DEBOUNCE_MS - elapsed);
                                    console.log(`⏱️ DEBOUNCE: Resetting timer for ${periodKey} - ${query.accounts.size} accounts, ${elapsed}ms elapsed, ${remainingWindow}ms remaining`);
                                    
                                    query.executeTimeout = setTimeout(() => {
                                        // DIAGNOSTIC: Log when timer fires
                                        const finalQuery = activePeriodQueries.get(periodKey);
                                        if (finalQuery) {
                                            const finalElapsed = Date.now() - finalQuery.startTime;
                                            const accountCount = finalQuery.accounts.size;
                                            console.log(`⏱️ DEBOUNCE FIRED: ${periodKey} with ${accountCount} accounts after ${finalElapsed}ms`);
                                            executeDebouncedQuery(periodKey, activePeriodQueries, columnBasedDetection, filterKey)
                                                .then(results => {
                                                    // Results already resolved placeholder in executeDebouncedQuery
                                                    // Update batchPromise for cells that check after execution starts
                                                    const query = activePeriodQueries.get(periodKey);
                                                    if (query) {
                                                        query.promise = Promise.resolve(results);
                                                    }
                                                })
                                                .catch(error => {
                                                    // Error already rejected placeholder in executeDebouncedQuery
                                                    const query = activePeriodQueries.get(periodKey);
                                                    if (query) {
                                                        query.promise = Promise.reject(error);
                                                    }
                                                });
                                        }
                                    }, remainingWindow);
                                } else {
                                    // Max wait exceeded - execute immediately
                                    console.log(`⏱️ DEBOUNCE: Max wait (${MAX_DEBOUNCE_MS}ms) exceeded for ${periodKey}, executing immediately with ${query.accounts.size} accounts`);
                                    executeDebouncedQuery(periodKey, activePeriodQueries, columnBasedDetection, filterKey)
                                        .then(results => {
                                            const query = activePeriodQueries.get(periodKey);
                                            if (query) {
                                                query.promise = Promise.resolve(results);
                                            }
                                        })
                                        .catch(error => {
                                            const query = activePeriodQueries.get(periodKey);
                                            if (query) {
                                                query.promise = Promise.reject(error);
                                            }
                                        });
                                }
                            };
                            
                            // Register immediately with 'collecting' state
                            activePeriodQueries.set(periodKey, {
                                promise: placeholderPromise,
                                accounts: new Set(accounts),
                                periods: new Set(periods),
                                filters: columnBasedDetection.filters,
                                filtersHash: filtersHash,  // CRITICAL: Store filtersHash for use in executeDebouncedQuery
                                gridKey: gridKey,
                                queryState: 'collecting',  // Debounce window open - accounts can merge
                                _resolvePlaceholder: resolvePlaceholder,
                                _rejectPlaceholder: rejectPlaceholder,
                                executeTimeout: null,  // Will be set below
                                startTime: startTime,  // Track when collection started
                                resetDebounceTimer: resetDebounceTimer  // Store reset function for reuse
                            });
                            
                            // Start initial debounce timer
                            const activeQuery = activePeriodQueries.get(periodKey);
                            // DIAGNOSTIC: Log debounce timer creation
                            console.log(`🔍 DEBOUNCE: Creating new query for ${periodKey}, starting ${DEBOUNCE_MS}ms rolling timer (${accounts.length} accounts initially)`);
                            resetDebounceTimer(activeQuery);
                            
                            // Set batchPromise to placeholder - will resolve when debounced query completes
                            batchPromise = placeholderPromise
                                .then(results => {
                                    // 🔬 VALIDATION LOGGING: Log batch results handler start
                                    console.log(`🎯 BATCH RESULTS HANDLER:`, {
                                        periodKey: periodKey,
                                        accountCount: activeQuery.accounts.size,
                                        periodCount: activeQuery.periods.size,
                                        resultsAccountCount: Object.keys(results).length,
                                        pendingEvaluationCount: pendingEvaluation.balance.size,
                                        timestamp: Date.now()
                                    });
                                    
                                    // Resolve ALL pending evaluations for this grid
                                    const finalAccounts = Array.from(activeQuery.accounts);
                                    const finalPeriods = Array.from(activeQuery.periods);
                                    
                                    // PERFORMANCE: Batch localStorage writes (parse once, write once)
                                    // Collect all balance updates first, then write to localStorage in a single operation
                                    let balanceData = null;
                                    let preloadData = null;
                                    
                                    for (const [evalKey, evalRequest] of pendingEvaluation.balance.entries()) {
                                        const { account: evalAccount, toPeriod: evalPeriod } = evalRequest;
                                        if (finalAccounts.includes(evalAccount) && finalPeriods.includes(evalPeriod)) {
                                            const balance = results[evalAccount]?.[evalPeriod];
                                            if (balance !== undefined && balance !== null && typeof balance === 'number') {
                                                const evalCacheKey = getCacheKey('balance', {
                                                    account: evalAccount,
                                                    fromPeriod: '',
                                                    toPeriod: evalPeriod,
                                                    subsidiary: columnBasedDetection.filters.subsidiary || '',
                                                    department: columnBasedDetection.filters.department || '',
                                                    location: columnBasedDetection.filters.location || '',
                                                    classId: columnBasedDetection.filters.classId || '',
                                                    accountingBook: columnBasedDetection.filters.accountingBook || ''
                                                });
                                                cache.balance.set(evalCacheKey, balance);
                                                
                                                // Collect balance updates for batched localStorage write
                                                if (balanceData === null) {
                                                    const stored = localStorage.getItem(STORAGE_KEY);
                                                    balanceData = stored ? JSON.parse(stored) : {};
                                                }
                                                if (!balanceData[evalAccount]) {
                                                    balanceData[evalAccount] = {};
                                                }
                                                balanceData[evalAccount][evalPeriod] = balance;
                                                
                                                // Also collect preload format updates
                                                if (preloadData === null) {
                                                    const preloadCache = localStorage.getItem('xavi_balance_cache');
                                                    preloadData = preloadCache ? JSON.parse(preloadCache) : {};
                                                }
                                                const filtersHash = getFilterKey({
                                                    subsidiary: columnBasedDetection.filters.subsidiary || '',
                                                    department: columnBasedDetection.filters.department || '',
                                                    location: columnBasedDetection.filters.location || '',
                                                    classId: columnBasedDetection.filters.classId || '',
                                                    accountingBook: columnBasedDetection.filters.accountingBook || ''
                                                });
                                                const preloadKey = `balance:${evalAccount}:${filtersHash}:${evalPeriod}`;
                                                preloadData[preloadKey] = { value: balance, timestamp: Date.now() };
                                                
                                                // Resolve pending request if it exists
                                                if (pendingRequests.balance.has(evalCacheKey)) {
                                                    const pendingRequest = pendingRequests.balance.get(evalCacheKey);
                                                    pendingRequest.resolve(balance);
                                                    pendingRequests.balance.delete(evalCacheKey);
                                                }
                                                
                                                pendingEvaluation.balance.delete(evalKey);
                                            }
                                        }
                                    }
                                    
                                    // PERFORMANCE: Write to localStorage once after collecting all updates
                                    if (balanceData !== null || preloadData !== null) {
                                        try {
                                            if (balanceData !== null) {
                                                localStorage.setItem(STORAGE_KEY, JSON.stringify(balanceData));
                                                localStorage.setItem(STORAGE_TIMESTAMP_KEY, Date.now().toString());
                                            }
                                            if (preloadData !== null) {
                                                localStorage.setItem('xavi_balance_cache', JSON.stringify(preloadData));
                                            }
                                        } catch (e) {
                                            console.warn(`⚠️ Failed to persist batch cache to localStorage:`, e.message);
                                        }
                                    }
                                    
                                    // Clean up
                                    activeColumnBatchExecutions.delete(gridKey);
                                    return results;
                                })
                                .catch(error => {
                                    // CRITICAL: Clean up on error, including timeout and placeholder promise
                                    activeColumnBatchExecutions.delete(gridKey);
                                    if (activePeriodQueries.has(periodKey)) {
                                        const query = activePeriodQueries.get(periodKey);
                                        // Clear timeout if still pending
                                        if (query.executeTimeout) {
                                            clearTimeout(query.executeTimeout);
                                        }
                                        // Reject placeholder promise if not already rejected
                                        // (This is defensive - executeDebouncedQuery should have already rejected it)
                                        if (query._rejectPlaceholder) {
                                            query._rejectPlaceholder(error);
                                        }
                                        activePeriodQueries.delete(periodKey);
                                    }
                                    throw error;
                                });
                            
                            // Update the promise reference in activePeriodQueries to the actual promise
                            // This ensures cells that check after this point will await the real promise
                            // Cells that checked before will await the placeholder, which will resolve when batchPromise resolves
                            const registeredQuery = activePeriodQueries.get(periodKey);
                            if (registeredQuery) {
                                registeredQuery.promise = batchPromise;
                            }
                        } else {
                            // Batch already exists in activeColumnBatchExecutions - use it
                            console.log(`⏳ COLUMN-BASED BS: Batch already executing for grid (gridKey: ${gridKey.substring(0, 60)}...), using existing promise`);
                            // batchPromise is already set from activeColumnBatchExecutions.get(gridKey) above
                        }
                        
                        // CRITICAL FIX: Only create new batch if activePeriodQuery doesn't exist or is not in 'collecting' state
                        // If activePeriodQuery exists and is 'collecting', we should NOT create a new batch - use the existing promise
                        if (!batchPromise && (!activePeriodQuery || activePeriodQuery.queryState !== 'collecting')) {
                            // No batch exists and no active period query in debounce window - create new batch
                            // This should only happen for supplemental queries (account not in preload results)
                            console.log(`⚠️ Creating supplemental batch for ${periodKey} (no active query or query already sent)`);
                            batchPromise = executeColumnBasedBSBatch(updatedGrid, periodKey, activePeriodQueries)
                                .then(results => {
                                    // Remove from active period queries when complete
                                    activePeriodQueries.delete(periodKey);
                                    
                                    // Resolve ALL pending evaluations for this grid
                                    for (const [evalKey, evalRequest] of pendingEvaluation.balance.entries()) {
                                        const { account: evalAccount, toPeriod: evalPeriod } = evalRequest;
                                        if (accounts.includes(evalAccount) && periods.includes(evalPeriod)) {
                                            const balance = results[evalAccount]?.[evalPeriod];
                                            if (balance !== undefined && balance !== null && typeof balance === 'number') {
                                                const evalCacheKey = getCacheKey('balance', {
                                                    account: evalAccount,
                                                    fromPeriod: '',
                                                    toPeriod: evalPeriod,
                                                    subsidiary: columnBasedDetection.filters.subsidiary || '',
                                                    department: columnBasedDetection.filters.department || '',
                                                    location: columnBasedDetection.filters.location || '',
                                                    classId: columnBasedDetection.filters.classId || '',
                                                    accountingBook: columnBasedDetection.filters.accountingBook || ''
                                                });
                                                cache.balance.set(evalCacheKey, balance);
                                                
                                                // CRITICAL: Also persist to localStorage for cross-context access
                                                try {
                                                    const stored = localStorage.getItem(STORAGE_KEY);
                                                    const balanceData = stored ? JSON.parse(stored) : {};
                                                    
                                                    if (!balanceData[evalAccount]) {
                                                        balanceData[evalAccount] = {};
                                                    }
                                                    balanceData[evalAccount][evalPeriod] = balance;
                                                    
                                                    localStorage.setItem(STORAGE_KEY, JSON.stringify(balanceData));
                                                    localStorage.setItem(STORAGE_TIMESTAMP_KEY, Date.now().toString());
                                                } catch (e) {
                                                    console.warn(`⚠️ Failed to persist cache to localStorage for ${evalAccount}/${evalPeriod}:`, e.message);
                                                }
                                                
                                                // Resolve pending request if it exists
                                                if (pendingRequests.balance.has(evalCacheKey)) {
                                                    const pendingRequest = pendingRequests.balance.get(evalCacheKey);
                                                    pendingRequest.resolve(balance);
                                                    pendingRequests.balance.delete(evalCacheKey);
                                                }
                                                
                                                pendingEvaluation.balance.delete(evalKey);
                                            }
                                        }
                                    }
                                    
                                    // Clean up
                                    activeColumnBatchExecutions.delete(gridKey);
                                    return results;
                                })
                                .catch(error => {
                                    // Clean up on error
                                    activeColumnBatchExecutions.delete(gridKey);
                                    activePeriodQueries.delete(periodKey);
                                    throw error;
                                });
                        }
                        
                        // activePeriodQueries is now set BEFORE promise creation (see above at line ~6819)
                        // This ensures other cells checking for period overlap will find it immediately
                        // Update existing period query if it exists (for merged accounts case)
                        if (activePeriodQuery) {
                            // Update existing period query with merged accounts
                            // CRITICAL: Chain promises instead of replacing to ensure all awaiters see results
                            // If there's an existing promise, chain the new one after it
                            if (activePeriodQuery.queryState === 'pending') {
                                // Query hasn't been sent yet - replace promise with merged accounts version
                                // queryState will be set to 'sent' inside executeColumnBasedBSBatch() before fetch()
                                activePeriodQuery.promise = batchPromise;
                                activePeriodQuery.accounts = new Set(accounts);
                                activePeriodQuery.gridKey = gridKey;
                                // Keep as 'pending' - will transition to 'sent' in executeColumnBasedBSBatch()
                            } else {
                                // Query already sent - chain new promise after existing one
                                // This ensures cells awaiting the old promise will see the new results
                                // The chained promise merges results from both queries
                                // CRITICAL: Add error handling to prevent chain breakage
                                const oldPromise = activePeriodQuery.promise;
                                activePeriodQuery.promise = oldPromise
                                    .catch(() => {
                                        // If old promise rejects, return empty results to allow new query to proceed
                                        console.warn(`⚠️ Previous query for ${periodKey} failed, proceeding with new query`);
                                        return {};
                                    })
                                    .then(oldResults => {
                                        // Wait for new batch to complete
                                        return batchPromise.then(newResults => {
                                            // Merge results: new results override old ones (newer is more complete)
                                            const mergedResults = { ...oldResults };
                                            for (const acc in newResults) {
                                                mergedResults[acc] = { ...mergedResults[acc], ...newResults[acc] };
                                            }
                                            return mergedResults;
                                        });
                                    });
                                activePeriodQuery.accounts = new Set(accounts);
                                activePeriodQuery.gridKey = gridKey;
                            }
                        }
                        
                        // Set the promise immediately (synchronously) to prevent race conditions
                        // This ensures that any other cell checking after this point will see the promise
                        activeColumnBatchExecutions.set(gridKey, batchPromise);
                    } else {
                        console.log(`⏳ COLUMN-BASED BS: Batch already executing for grid (gridKey: ${gridKey.substring(0, 60)}...), waiting for results...`);
                    }
                    
                    // All cells (whether they created the batch or are waiting) await the same promise
                    try {
                        const batchResults = await batchPromise;
                        
                        // Get result for this specific account and period
                        const balance = batchResults[account]?.[toPeriod];
                        
                        if (balance !== undefined && balance !== null && typeof balance === 'number') {
                            // Cache result (already cached above, but ensure it's set)
                            cache.balance.set(cacheKey, balance);
                            
                                console.log(`✅ COLUMN-BASED BS RESULT: ${account} for ${toPeriod} = ${balance}`);
                            
                            // Remove from pendingEvaluation (batch executed successfully)
                            pendingEvaluation.balance.delete(evalKey);
                            return balance;
                        } else {
                            // Missing result - fall back to per-cell logic
                                console.log(`⚠️ COLUMN-BASED BS: Missing result for ${account}/${toPeriod} - falling back to per-cell`);
                            // Fall through to per-cell logic below
                        }
                    } catch (error) {
                        // Error in batch execution - fall back to per-cell logic
                            console.error(`❌ COLUMN-BASED BS BATCH ERROR: ${error.message} - falling back to per-cell`);
                        console.error(`   Error stack:`, error.stack);
                        // Fall through to per-cell logic below
                    }
                } else {
                    // Execution not allowed - log reason and fall back to per-cell
                    console.log(`⏸️ COLUMN-BASED BS EXECUTION BLOCKED: ${executionCheck.reason || 'unknown reason'}`);
                    // Fall through to per-cell logic below
                }
            } else {
                // Grid not eligible for column-based batching - fall back to per-cell
                console.log(`⏸️ [BATCH DEBUG] Grid not eligible for column-based batching: accountType=${accountType}, evaluatingRequests=${evaluatingRequests.length}, account=${account}`);
                if (DEBUG_COLUMN_BASED_BS_BATCHING) {
                    console.log(`⏸️ COLUMN-BASED BS: Grid not eligible - falling back to per-cell`);
                }
                // Fall through to per-cell logic below
            }
        } else {
            // Not Balance Sheet or batching disabled
            // Extract type string consistently with the check above
            let acctTypeStr = '';
            
            if (!accountType) {
                acctTypeStr = '';
            } else if (typeof accountType === 'string') {
                // Check if it's a JSON string first
                const trimmed = accountType.trim();
                if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
                    try {
                        const parsed = JSON.parse(trimmed);
                        acctTypeStr = (parsed.type || parsed.accountType || '').toString().trim();
                    } catch (e) {
                        acctTypeStr = trimmed;
                    }
                } else {
                    acctTypeStr = trimmed;
                }
            } else if (accountType && typeof accountType === 'object') {
                acctTypeStr = (accountType.type || accountType.accountType || '').toString().trim();
            } else {
                acctTypeStr = String(accountType).trim();
            }
            
            if (!isBalanceSheetType(acctTypeStr)) {
                console.log(`⏸️ [BATCH DEBUG] Account type is "${acctTypeStr}" (from:`, accountType, '), not a Balance Sheet type - skipping column-based batching');
            }
        }
        
        // ================================================================
        // PER-CELL LOGIC: Fallback when column-based batching is not used
        // This is the original per-cell execution path (manifest/preload/API)
        // ================================================================
        // DIAGNOSTIC: Log when falling through to individual path
        console.log(`🔍 INDIVIDUAL PATH: account=${account}, period=${toPeriod} - NOT using batch (falling through to per-cell logic)`);
        
        // CRITICAL FIX: Check cache BEFORE queuing individual API call
        // Cells that arrive AFTER debounced batch completes should use cached results
        // This prevents redundant individual GetBalance calls when batch already cached the data
        if (isCumulativeQuery && lookupPeriod) {
            const postBatchCacheCheck = checkLocalStorageCache(account, fromPeriod, toPeriod, subsidiary, filtersHash);
            if (postBatchCacheCheck !== null) {
                console.log(`✅ POST-BATCH CACHE HIT: ${account}/${lookupPeriod} = ${postBatchCacheCheck} (batch query completed, using cached result)`);
                cacheStats.hits++;
                cache.balance.set(cacheKey, postBatchCacheCheck);
                pendingEvaluation.balance.delete(evalKey);
                return postBatchCacheCheck;
            } else {
                console.log(`🔍 INDIVIDUAL PATH: account=${account}, period=${lookupPeriod} - cache miss, checking manifest/preload before queuing`);
            }
        }
        // NOTE: Old row-based batching (executeBalanceSheetBatchQueryImmediate) is REMOVED
        // Column-based batching is the ONLY batching path for Balance Sheet grids
        
        // PATH A: Not eligible for column-based batching OR batch failed - use per-cell path
        // ⚠️ CONFIRMATION #2: This code (manifest/preload) only runs if:
        // - Eligibility check returned false, OR
        // - Batch query failed/returned null
        // This ensures preload logic NEVER runs for eligible batch requests
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
        // NOTE: lookupPeriod, isCumulativeQuery, and filtersHash are already defined above
        // (before column-based batching check) - no need to redefine them here
        
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
                    
                    // Check final status - if still running/requested, extend wait
                    const finalStatus = getPeriodStatus(filtersHash, periodKey);
                    if (finalStatus === "requested") {
                        // CRITICAL FIX: If status is still "requested", taskpane hasn't started yet
                        // Continue waiting with extended timeout (taskpane may be slow to start)
                        console.log(`⏳ Period ${periodKey} still requested - taskpane hasn't started yet, waiting longer...`);
                        const extendedWait = 180000; // 3 minutes - give taskpane more time to start
                        const extendedWaited = await waitForPeriodCompletion(filtersHash, periodKey, extendedWait);
                        if (extendedWaited) {
                            // Preload completed - re-check cache
                            let extendedRetryCache = checkLocalStorageCache(account, fromPeriod, toPeriod, subsidiary, filtersHash);
                            if (extendedRetryCache !== null) {
                                console.log(`✅ Post-preload cache hit (after extended wait): ${account} for ${periodKey} = ${extendedRetryCache}`);
                                cacheStats.hits++;
                                cache.balance.set(cacheKey, extendedRetryCache);
                                return extendedRetryCache;
                            }
                        }
                        // If still not completed after extended wait, proceed to API
                        console.log(`⏳ Period ${periodKey} still not completed after extended wait - proceeding to API path`);
                    } else if (finalStatus === "running") {
                        // ✅ Still running - proceed to API path (transient state)
                        console.log(`⏳ Period ${periodKey} still running - proceeding to API path`);
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
                    const cachedValue = cache.balance.get(cacheKey);
                    console.log(`✅ Post-preload cache hit (memory): ${account}`);
                    cacheStats.hits++;
                    
                    return cachedValue;
                }
                
                // Build filtersHash for cache lookup (should match preload cache key format)
                const filtersHash = getFilterKey({ subsidiary, department, location, classId, accountingBook });
                const localStorageValue = checkLocalStorageCache(account, fromPeriod, toPeriod, subsidiary, filtersHash);
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
        // NOTE: filtersHash is already defined above (before column-based batching check)
        let localStorageValue = null;
        // CRITICAL FIX: Always check localStorage for cumulative queries, even with filters
        // The cache now includes filters in the key, so it will work correctly
        // NOTE: This check may be redundant if we already checked above (before column-based batching),
        // but it's safe to check again here as a fallback
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
                                
                                // CRITICAL FIX: Trigger auto-preload for ALL BS accounts, including those with subsidiary filters
                                // Backend preload endpoints support subsidiary filters, so this check was incorrectly blocking preload
                                // This was causing formulas with subsidiaries to wait 120s timeout instead of triggering preload
                                // CRITICAL: Pass filters so manifest status can be updated correctly
                                triggerAutoPreload(account, periodKey, { subsidiary, department, location, classId, accountingBook });
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
                            // GRID DETECTION: If multiple BS requests are already queued, skip preload wait
                            // This allows batch detection to run quickly and handle grid scenarios
                            const pendingBSRequests = Array.from(pendingRequests.balance.values())
                                .filter(r => isCumulativeRequest(r.params.fromPeriod));
                            
                            if (pendingBSRequests.length >= 2) {
                                // Multiple BS requests queued - likely a grid scenario
                                // Skip preload wait, let batch detection handle it
                                console.log(`🎯 Grid scenario detected (${pendingBSRequests.length} BS requests queued) - skipping preload wait, using batch path`);
                                // Proceed directly to queue (don't wait for preload)
                            } else {
                                // Single request or no other requests - use normal preload path
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
                                if (finalStatus === "requested") {
                                    // CRITICAL FIX: If status is still "requested", taskpane hasn't started yet
                                    // Continue waiting with extended timeout (taskpane may be slow to start)
                                    console.log(`⏳ Period ${periodKey} still requested - taskpane hasn't started yet, waiting longer...`);
                                    const extendedWait = 180000; // 3 minutes - give taskpane more time to start
                                    const extendedWaited = await waitForPeriodCompletion(filtersHash, periodKey, extendedWait);
                                    if (extendedWaited) {
                                        // Preload completed - re-check cache
                                        let extendedRetryCache = checkLocalStorageCache(account, fromPeriod, toPeriod, subsidiary, filtersHash);
                                        if (extendedRetryCache !== null) {
                                            console.log(`✅ Post-preload cache hit (after extended wait): ${account} for ${periodKey} = ${extendedRetryCache}`);
                                            cacheStats.hits++;
                                            cache.balance.set(cacheKey, extendedRetryCache);
                                            return extendedRetryCache;
                                        }
                                    }
                                    // If still not completed after extended wait, proceed to API
                                    console.log(`⏳ Period ${periodKey} still not completed after extended wait - proceeding to API path`);
                                } else if (finalStatus === "running") {
                                    // ✅ Still running - proceed to API path (transient state)
                                    console.log(`⏳ Period ${periodKey} still running - proceeding to API path`);
                                    // Continue to API path below (don't throw)
                                }
                                // If preload failed or timed out, continue to API call below
                            }
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
        
        // DEBUG: Track when formula is called (before queuing)
        const formulaCallTime = new Date().toISOString();
        if (isBSRequest) {
        }
        
        // In full refresh mode, queue silently (task pane will trigger processFullRefresh)
        // REDUCED LOGGING: Only log first few cache misses to prevent console flooding
        if (!isFullRefreshMode && cacheStats.misses < 10) {
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
                // CRITICAL FIX: Smart timer management - don't reset during rapid drag operations
                const now = Date.now();
                const queueSize = pendingRequests.balance.size;
                const timeSinceLastRequest = lastRequestTimestamp ? (now - lastRequestTimestamp) : Infinity;
                const isRapidRequest = timeSinceLastRequest < RAPID_REQUEST_THRESHOLD_MS;
                const shouldPreventReset = batchTimer !== null && isRapidRequest && queueSize >= QUEUE_SIZE_THRESHOLD;
                
                if (shouldPreventReset) {
                    // Don't reset timer - let it fire to process the batch
                    console.log(`⏱️ SKIPPING timer reset (rapid requests: ${timeSinceLastRequest}ms apart, queue: ${queueSize})`);
                } else {
                    // Normal behavior: reset timer
                    if (batchTimer) {
                        clearTimeout(batchTimer);
                        batchTimer = null;
                    }
                    console.log(`⏱️ STARTING batch timer (${BATCH_DELAY}ms)`);
                    batchTimer = setTimeout(() => {
                        console.log('⏱️ Batch timer FIRED!');
                        batchTimer = null;
                        lastRequestTimestamp = null; // Reset tracking
                        processBatchQueue().catch(err => {
                            console.error('❌ Batch processing error:', err);
                        });
                    }, BATCH_DELAY);
                }
                
                // Update last request timestamp
                lastRequestTimestamp = now;
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
        // Allow:
        // - "Mon YYYY" format (e.g., "Jan 2025")
        // - Year-only "YYYY" format (e.g., "2025") - backend handles expansion
        // - Period ID format (e.g., "344") - numeric ID that backend resolves to period
        const periodPattern = /^([A-Za-z]{3}\s+\d{4}|\d{4}|\d{1,6})$/;
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
        // CRITICAL FIX: Use extractValueFromRange for ALL parameters that might be cell references
        // This ensures that when cell values change, the parameters are properly extracted and cache keys update
        // Excel may pass Range objects for cell references, which need special handling
        subsidiary = extractValueFromRange(subsidiary, 'subsidiary');
        
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
        
        // CRITICAL FIX: Use extractValueFromRange for ALL parameters that might be cell references
        // This ensures that when cell values change, the parameters are properly extracted and cache keys update
        department = extractValueFromRange(department, 'department');
        location = extractValueFromRange(location, 'location');
        classId = extractValueFromRange(classId, 'classId');
        accountingBook = extractValueFromRange(accountingBook, 'accountingBook');
        
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
        
        // VALIDATION: Check subsidiary/accounting book combination
        const validationError = await validateSubsidiaryAccountingBook(subsidiary, accountingBook);
        if (validationError === 'INVALID_COMBINATION') {
            console.error(`❌ BUDGET: Invalid combination - subsidiary "${subsidiary}" not enabled for accounting book ${accountingBook}`);
            throw new Error('INVALID_COMBINATION');
        } else if (validationError === 'INVALID_BOOK') {
            console.error(`❌ BUDGET: Accounting book ${accountingBook} has no enabled subsidiaries`);
            throw new Error('INVALID_BOOK');
        }
        
        // CRITICAL: Convert "All Categories" to empty string (backend expects empty string for all categories)
        if (budgetCategory.toLowerCase() === 'all categories') {
            budgetCategory = '';
        }
        
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
    if (DEBUG_VERBOSE_LOGGING) {
        console.log('========================================');
        console.log(`📊 BUDGET BATCH: Processing ${requestCount} requests`);
        console.log('========================================');
    }
    
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
    
    if (DEBUG_VERBOSE_LOGGING) {
        console.log(`   Grouped into ${groups.size} filter combination(s)`);
    }
    
    // Process each group with a batch API call
    for (const [filterKey, group] of groups) {
        const accounts = Array.from(group.accounts);
        const periods = Array.from(group.periods);
        const { filters, requests: groupRequests } = group;
        
        if (DEBUG_VERBOSE_LOGGING) {
            console.log(`   📤 Batch: ${accounts.length} accounts × ${periods.length} periods`);
            console.log(`      Filters: sub=${filters.subsidiary || 'all'}, cat=${filters.budgetCategory || 'all'}`);
        }
        
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
            
            if (DEBUG_VERBOSE_LOGGING) {
                console.log(`   ✅ Received data in ${data.query_time?.toFixed(2) || '?'}s`);
            }
            
            // Resolve promises and cache results
            for (const { cacheKey, request } of groupRequests) {
                const { account, fromPeriod } = request.params;
                let value = 0;
                
                // CRITICAL: fromPeriod is already normalized to "Mon YYYY" format by normalizePeriodKey
                // Backend returns budgets keyed by period name (e.g., "Jan 2011")
                // So we can directly look up using fromPeriod
                
                // Handle year-only periods by summing all 12 months
                if (fromPeriod && /^\d{4}$/.test(fromPeriod)) {
                    const expanded = expandPeriodRangeFromTo(fromPeriod, fromPeriod);
                    for (const period of expanded) {
                        if (budgets[account] && budgets[account][period] !== undefined) {
                            value += budgets[account][period];
                        }
                    }
                } else if (budgets[account]) {
                    // Look up by normalized period name
                    // Backend returns periods as "Jan 2011", "Feb 2011", etc.
                    if (budgets[account][fromPeriod] !== undefined) {
                        value = budgets[account][fromPeriod];
                    } else {
                        // Missing budget data is expected - only log in debug mode
                        if (DEBUG_VERBOSE_LOGGING) {
                            console.warn(`   ⚠️ Budget lookup failed for ${account}/${fromPeriod}. Available periods:`, Object.keys(budgets[account] || {}));
                        }
                    }
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
        filters.accountingBook = firstRequest.params.accountingBook || '';  // Multi-Book Accounting support
    }
    
    console.log(`📊 Full Refresh Request:`);
    console.log(`   Formulas: ${allRequests.length}`);
    console.log(`   Year: ${year}`);
    console.log(`   Filters:`, filters);
    // CRITICAL DEBUG: Log accounting book to verify it's being passed
    console.log(`   🔍 DEBUG: accountingBook="${filters.accountingBook || ''}" (from first request)`);
    console.log('');
    
    try {
        // Call optimized backend endpoint
        // CRITICAL FIX: Backend expects "book" not "accountingBook", and it should be a number or omitted
        const payload = {
            year: year,
            subsidiary: filters.subsidiary || '',
            department: filters.department || '',
            location: filters.location || '',
            class: filters.class || ''
        };
        // Only include book if it's not empty (convert string to number)
        // Backend defaults to Book 1 if book is null/omitted, so we only need to send non-primary books
        if (filters.accountingBook && filters.accountingBook !== '') {
            const bookNum = parseInt(filters.accountingBook);
            if (!isNaN(bookNum) && bookNum > 1) {
                // Only send if it's not Primary Book (1) - backend defaults to 1
                payload.book = bookNum;
                console.log(`   🔍 DEBUG: Including book=${bookNum} in payload (converted from "${filters.accountingBook}")`);
            } else if (bookNum === 1) {
                console.log(`   🔍 DEBUG: Skipping book=1 (Primary Book - backend default)`);
            } else {
                console.log(`   🔍 DEBUG: Invalid book value "${filters.accountingBook}" - not including in payload`);
            }
        } else {
            console.log(`   🔍 DEBUG: No accountingBook filter - backend will default to Book 1`);
        }
        
        // CRITICAL DEBUG: Log payload to verify accounting book is included
        console.log('📤 Fetching ALL accounts for entire year...');
        console.log(`   🔍 DEBUG: Payload includes book=${payload.book !== undefined ? payload.book : 'undefined'} (was accountingBook="${filters.accountingBook || ''}")`);
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
                    subsidiary: filters.subsidiary || '',
                    department: filters.department || '',
                    location: filters.location || '',
                    classId: filters.class || '',
                    accountingBook: filters.accountingBook || ''
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
    lastRequestTimestamp = null;  // Reset request timing tracking
    
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
    // ROUTE REQUESTS BY TYPE:
    // 1. CUMULATIVE BS QUERIES: empty fromPeriod with toPeriod → direct /balance API calls
    // 2. PERIOD ACTIVITY QUERIES: both fromPeriod and toPeriod (BS accounts only) → direct /balance API calls
    // 3. REGULAR REQUESTS: P&L period ranges (with both fromPeriod and toPeriod) → batch endpoint
    // ================================================================
    let cumulativeRequests = [];  // Changed to 'let' to allow reassignment after batch filtering
    const periodActivityRequests = [];  // BS period activity queries (both fromPeriod and toPeriod, BS accounts only)
    const regularRequests = [];  // P&L accounts with both fromPeriod and toPeriod - should be batched
    
    // ================================================================
    // ROUTING: Parameter-based (like restore point balance-sheet-before-anchor-batching)
    // This ensures Income Statement accounts route correctly without account type dependency
    // Account types are only used for optimizations (year endpoint, grid detection)
    // ================================================================
    for (const [cacheKey, request] of requests) {
        const { account, fromPeriod, toPeriod } = request.params;
        const isCumulative = (!fromPeriod || fromPeriod === '') && toPeriod && toPeriod !== '';
        
        // Period activity: both fromPeriod and toPeriod present AND different periods
        // CRITICAL FIX: Changed from "fromPeriod !== ''" to "fromPeriod !== toPeriod"
        // This ensures same-period queries (e.g., "Jan 2025" to "Jan 2025") go to regularRequests
        const hasPeriodRange = fromPeriod && toPeriod && fromPeriod !== toPeriod;
        
        // CRITICAL FIX: Period activity is ONLY for Balance Sheet accounts
        // Income Statement accounts with period ranges need to SUM periods, not show activity
        // Check account type to determine if this is period activity (BS) or period range (P&L)
        let isPeriodActivity = false;
        if (hasPeriodRange) {
            // Check if account is Balance Sheet type
            const typeCacheKey = getCacheKey('type', { account });
            const accountType = cache.type.has(typeCacheKey) ? cache.type.get(typeCacheKey) : null;
            
            if (accountType && isBalanceSheetType(accountType)) {
                // BS account with period range = period activity (shows activity between periods)
                isPeriodActivity = true;
                console.log(`   🔍 [ROUTING] Account ${account} is BS type "${accountType}" - routing to period activity (${fromPeriod} → ${toPeriod})`);
            } else if (accountType) {
                // P&L account with period range = needs to SUM periods (goes to regularRequests)
                isPeriodActivity = false;
                console.log(`   🔍 [ROUTING] Account ${account} is P&L type "${accountType}" - routing to regularRequests to SUM periods (${fromPeriod} → ${toPeriod})`);
            } else {
                // Account type unknown - default to regularRequests (sum periods)
                // This is safer: if it's P&L, it's correct; if it's BS, backend will handle it
                isPeriodActivity = false;
                console.log(`   ⚠️ [ROUTING] Account ${account} type unknown - defaulting to regularRequests (sum periods) for ${fromPeriod} → ${toPeriod}`);
            }
        }
        
        if (isCumulative) {
            // Cumulative = empty fromPeriod with a toPeriod (always BS)
            cumulativeRequests.push([cacheKey, request]);
        } else if (isPeriodActivity) {
            // Period activity query (BS account with both fromPeriod and toPeriod, different periods)
            // Route to individual /balance calls with period_activity breakdown
            // This shows activity between periods, not cumulative balance
            periodActivityRequests.push([cacheKey, request]);
        } else {
            // Regular P&L period range requests - can use batch endpoint that SUMS periods
            // This includes:
            // - Income Statement single-period queries (fromPeriod === toPeriod, e.g., "Jan 2025" to "Jan 2025")
            // - Income Statement period range queries (fromPeriod !== toPeriod, e.g., "Jan 2012" to "Jan 2025")
            //   These need to SUM all periods in the range
            // - Any other requests that don't match cumulative or period activity patterns
            regularRequests.push([cacheKey, request]);
        }
    }
    
    if (cumulativeRequests.length > 0) {
        console.log(`📊 Processing ${cumulativeRequests.length} CUMULATIVE (BS) requests separately...`);
        
        // ================================================================
        // BALANCE SHEET GRID BATCHING: Detect grid pattern and batch if applicable
        // ================================================================
        const gridPattern = detectBalanceSheetGridPattern(cumulativeRequests);
        
        if (gridPattern) {
            console.log(`🎯 BS GRID PATTERN DETECTED: ${gridPattern.account}, ${gridPattern.periods.length} periods`);
            
            try {
                // Execute batched query
                const batchResults = await executeBalanceSheetBatchQuery(gridPattern);
                
                if (batchResults) {
                    // Batch query succeeded - resolve all matching requests
                    let resolvedCount = 0;
                    const batchedCacheKeys = new Set();
                    
                    for (const [cacheKey, request] of gridPattern.requests) {
                        const { toPeriod } = request.params;
                        const balance = batchResults[toPeriod];
                        
                        if (balance !== undefined) {
                            // Cache the result
                            cache.balance.set(cacheKey, balance);
                            // Resolve the promise
                            request.resolve(balance);
                            resolvedCount++;
                            batchedCacheKeys.add(cacheKey);
                        } else {
                            // Period not in results - fall back to individual request
                            console.warn(`⚠️ Period ${toPeriod} not in batch results - falling back to individual request`);
                        }
                    }
                    
                    console.log(`✅ BS BATCH RESOLVED: ${resolvedCount}/${gridPattern.requests.length} requests`);
                    
                    // Remove batched requests from cumulativeRequests (clean fallback)
                    cumulativeRequests = cumulativeRequests.filter(([key]) => !batchedCacheKeys.has(key));
                    
                    // If all requests were batched, skip individual processing
                    if (cumulativeRequests.length === 0) {
                        console.log(`✅ All cumulative requests handled by batch - skipping individual processing`);
                        // Continue to next section (periodActivityRequests, etc.)
                    }
                } else {
                    // Batch query failed - fall back to individual requests (clean fallback)
                    console.log(`⚠️ BS batch query failed - falling back to individual requests`);
                    // Continue with individual processing below (no partial state retained)
                }
            } catch (error) {
                // Batch query error - fall back to individual requests (clean fallback)
                console.error(`❌ BS batch query error:`, error);
                // Continue with individual processing below (no partial state retained)
            }
        }
        
        // Continue with existing individual cumulative request processing...
        // (This handles remaining cumulativeRequests after batching, or all if batching skipped/failed)
        
        // DIAGNOSTIC: Log when processing individual cumulative requests
        if (cumulativeRequests.length > 0) {
            console.log(`🔍 INDIVIDUAL CALL: Processing ${cumulativeRequests.length} cumulative requests individually (NOT using batch endpoint)`);
        }
        
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
                const localStorageValue = checkLocalStorageCache(account, fromPeriod, toPeriod, subsidiary, filtersHash);
                if (localStorageValue !== null) {
                    // DEBUG: Track when data is ready vs when it's written (Balance Sheet only)
                    const isBS = isCumulativeRequest(fromPeriod);
                    const dataReadyTime = new Date().toISOString();
                    
                    console.log(`   ✅ Preload cache hit (batch mode): ${account} for ${fromPeriod || '(cumulative)'} → ${toPeriod} = ${localStorageValue}`);
                    
                    cache.balance.set(cacheKey, localStorageValue);
                    
                    // Resolve ALL requests waiting for this result
                    const writeStartTime = Date.now();
                    requests.forEach(r => {
                        r.resolve(localStorageValue);
                    });
                    
                    
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
                    // DEBUG: Track when data is ready vs when it's written (Balance Sheet only)
                    const isBS = isCumulativeRequest(fromPeriod);
                    const dataReadyTime = new Date().toISOString();
                    
                    console.log(`   🎯 Wildcard cache hit: ${account} = ${wildcardResult.total.toLocaleString()} (${wildcardResult.matchCount} accounts)`);
                    
                    cache.balance.set(cacheKey, wildcardResult.total);
                    
                    // Resolve ALL requests waiting for this result
                    const writeStartTime = Date.now();
                    requests.forEach(r => {
                        r.resolve(wildcardResult.total);
                    });
                    
                    
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
                // CRITICAL FIX: Backend expects "book" not "accountingbook", and it should be a number or omitted
                const apiParams = new URLSearchParams({
                    account: account,
                    from_period: '',  // Empty = cumulative from inception
                    to_period: toPeriod,
                    subsidiary: subsidiary || '',
                    department: department || '',
                    location: location || '',
                    class: classId || ''
                });
                // Only include book if it's not empty and not "1" (convert string to number)
                // Backend defaults to Book 1 if book is null/omitted, so we only need to send non-primary books
                // CRITICAL: accountingBook is now normalized to "1" for empty values, so check for "1" explicitly
                if (accountingBook && accountingBook !== '' && accountingBook !== '1') {
                    const bookNum = parseInt(String(accountingBook));
                    if (!isNaN(bookNum) && bookNum > 1) {
                        // Only send if it's not Primary Book (1) - backend defaults to 1
                        apiParams.append('book', bookNum.toString());
                        console.log(`   🔍 DEBUG: Including book=${bookNum} in API params (converted from "${accountingBook}")`);
                    } else {
                        console.log(`   🔍 DEBUG: Invalid book value "${accountingBook}" - not including in API params`);
                    }
                } else {
                    console.log(`   🔍 DEBUG: No accountingBook or Primary Book (1) - backend will default to Book 1`);
                }
                
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
                // CRITICAL DEBUG: Log accounting book parameter to verify it's being sent
                const bookParam = apiParams.get('book');
                const bookInfo = bookParam ? ` [BOOK: ${bookParam}]` : ' [BOOK: empty/primary]';
                console.log(`   📤 Cumulative API: ${account} through ${toPeriod}${isWildcard ? ' (with breakdown)' : ''}${currencyInfo}${bookInfo}${waitingCount}`);
                console.log(`   🔍 DEBUG: API params - book=${bookParam || 'undefined'} (was accountingBook="${accountingBook || ''}", type: ${typeof accountingBook})`);
                
                // Rate limit: wait before making request if we've already made calls
                // Prevents NetSuite 429 CONCURRENCY_LIMIT_EXCEEDED errors
                if (apiCalls > 0) {
                    await rateLimitSleepBatch(RATE_LIMIT_DELAY_BATCH);
                }
                apiCalls++;
                
                // Track query timing for slow query detection
                const queryStartTime = Date.now();
                const apiUrl = `${SERVER_URL}${endpoint}?${apiParams.toString()}`;
                console.log(`   🔍 DEBUG: Full API URL: ${apiUrl}`);
                console.log(`   🔍 DEBUG: All API params:`, Object.fromEntries(apiParams));
                const response = await fetch(apiUrl);
                
                if (response.ok) {
                    const contentType = response.headers.get('content-type') || '';
                    
                    if (isWildcard && contentType.includes('application/json')) {
                        // Parse JSON response with breakdown
                        const data = await response.json();
                        const total = data.total || 0;
                        const accounts = data.accounts || {};
                        const period = data.period || toPeriod;
                        
                        // DEBUG: Track when data is ready vs when it's written (Balance Sheet only)
                        const isBS = isCumulativeRequest(fromPeriod);
                        const dataReadyTime = new Date().toISOString();
                        const queryTimeMs = Date.now() - queryStartTime;
                        
                        console.log(`   ✅ Wildcard result: ${account} = ${total.toLocaleString()} (${Object.keys(accounts).length} accounts)`);
                        
                        // Cache the total for this wildcard pattern
                        cache.balance.set(cacheKey, total);
                        
                        // CRITICAL: Cache individual accounts for future wildcard resolution!
                        cacheIndividualAccounts(accounts, period, subsidiary);
                        
                        // Resolve ALL requests waiting for this result
                        const writeStartTime = Date.now();
                        requests.forEach(r => {
                            r.resolve(total);
                        });
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
                            // DEBUG: Track when data is ready vs when it's written (Balance Sheet only)
                            const isBS = isCumulativeRequest(fromPeriod);
                            const dataReadyTime = new Date().toISOString();
                            
                            console.log(`   ✅ Cumulative result: ${account} = ${value.toLocaleString()} (${(queryTimeMs / 1000).toFixed(1)}s)`);
                            
                            // Only cache valid numeric values, not errors or null
                            cache.balance.set(cacheKey, value);
                            
                            // Resolve ALL requests waiting for this result
                            const writeStartTime = Date.now();
                            requests.forEach(r => {
                                r.resolve(value);
                            });
                            
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
    
    // ================================================================
    // REGULAR REQUESTS (P&L accounts with both fromPeriod and toPeriod): Batch processing
    // These should use the batch endpoint for efficient year queries
    // ================================================================
    if (regularRequests.length > 0) {
        console.log(`📊 Processing ${regularRequests.length} REGULAR (P&L) requests with batching...`);
        console.log(`   ✅ PROOF: ${regularRequests.length} Income Statement requests will be batched together`);
        console.log(`   ✅ PROOF: NOT processing cell-by-cell or period-by-period`);
        
        // Group by filters (not periods) - this allows smart batching
        const groups = new Map();
        for (const [cacheKey, request] of regularRequests) {
            const {params} = request;
            const filterKey = JSON.stringify({
                subsidiary: params.subsidiary || '',
                department: params.department || '',
                location: params.location || '',
                class: params.classId || '',
                accountingBook: params.accountingBook || ''
            });
            
            if (!groups.has(filterKey)) {
                groups.set(filterKey, []);
            }
            groups.get(filterKey).push({ cacheKey, request });
        }
        
        console.log(`   ✅ PROOF: Requests grouped for single batch query (not individual queries)`);
        
        // Process each group
        for (const [filterKey, groupRequests] of groups.entries()) {
            const filters = JSON.parse(filterKey);
            
            // ========================================================================
            // CRITICAL: Check Income Statement preload cache BEFORE chunking
            // This ensures drag-down formulas use cached data instead of making API calls
            // ========================================================================
            const filtersHash = getFilterKey({
                subsidiary: filters.subsidiary || '',
                department: filters.department || '',
                location: filters.location || '',
                classId: filters.class || '', // filterKey uses 'class', but getFilterKey expects 'classId'
                accountingBook: filters.accountingBook || ''
            });
            const uncachedRequests = [];
            let cacheHitsInBatch = 0;
            
            for (const { cacheKey, request } of groupRequests) {
                const { account, fromPeriod, toPeriod, subsidiary } = request.params;
                
                // Check localStorage cache (Income Statement preload cache)
                // Skip for subsidiary-filtered queries (localStorage not subsidiary-aware)
                if (!subsidiary) {
                    const cachedValue = checkLocalStorageCache(account, fromPeriod, toPeriod, subsidiary || '', filtersHash);
                    if (cachedValue !== null) {
                        console.log(`   ✅ Preload cache hit (batch mode): ${account} for ${fromPeriod || '(cumulative)'} → ${toPeriod} = ${cachedValue}`);
                        cache.balance.set(cacheKey, cachedValue);
                        request.resolve(cachedValue);
                        cacheHitsInBatch++;
                        continue; // Skip this request - it's cached
                    }
                }
                
                // Not cached - add to uncached requests for processing
                uncachedRequests.push({ cacheKey, request });
            }
            
            if (cacheHitsInBatch > 0) {
                console.log(`   📊 Cache check: ${cacheHitsInBatch} cached, ${uncachedRequests.length} need API calls`);
            }
            
            // If all requests were cached, skip to next group
            if (uncachedRequests.length === 0) {
                console.log(`   ✅ All ${groupRequests.length} requests resolved from cache - skipping API calls`);
                continue;
            }
            
            // Use uncached requests for the rest of processing
            const accounts = [...new Set(uncachedRequests.map(r => r.request.params.account))];
            
            // ========================================================================
            // PERIOD RANGE OPTIMIZATION: Detect if all requests have same period range
            // Instead of expanding to individual periods, send range to backend
            // ========================================================================
            let allRequestsHaveSameRange = true;
            let commonFromPeriod = null;
            let commonToPeriod = null;
            
            // Check if all requests have the same fromPeriod and toPeriod
            for (const r of uncachedRequests) {
                const { fromPeriod, toPeriod } = r.request.params;
                if (fromPeriod && toPeriod && fromPeriod !== toPeriod) {
                    // This is a period range request
                    if (commonFromPeriod === null) {
                        commonFromPeriod = fromPeriod;
                        commonToPeriod = toPeriod;
                    } else if (commonFromPeriod !== fromPeriod || commonToPeriod !== toPeriod) {
                        allRequestsHaveSameRange = false;
                        break;
                    }
                } else {
                    // Not a period range (single period or cumulative)
                    allRequestsHaveSameRange = false;
                    break;
                }
            }
            
            // Helper: Extract account type string from various formats
            const extractAccountTypeString = (accountType) => {
                if (!accountType) return null;
                
                if (typeof accountType === 'string') {
                    // Try to parse as JSON first (in case it's a stringified object)
                    try {
                        const parsed = JSON.parse(accountType);
                        return parsed.type || accountType;
                    } catch (e) {
                        // Not JSON, use as-is
                        return accountType;
                    }
                } else if (typeof accountType === 'object') {
                    // It's an object, extract the type property
                    return accountType.type || accountType.toString();
                } else {
                    return String(accountType);
                }
            };
            
            // Helper: Check if account type is P&L (Income Statement)
            const isPandLType = (accountType) => {
                const typeStr = extractAccountTypeString(accountType);
                if (!typeStr) return false;
                return typeStr === 'Income' || typeStr === 'COGS' || 
                       typeStr === 'Expense' || typeStr === 'OthIncome' || 
                       typeStr === 'OthExpense';
            };
            
            // Check if all accounts are Income Statement (P&L) accounts
            // Period range optimization only works for P&L accounts
            // NOTE: Account types might not be in cache yet, so we need to check what we have
            const accountTypeChecks = accounts.map(account => {
                const typeCacheKey = getCacheKey('type', { account });
                const accountType = cache.type.has(typeCacheKey) ? cache.type.get(typeCacheKey) : null;
                const typeStr = extractAccountTypeString(accountType);
                const isPandL = isPandLType(accountType);
                
                return { account, accountType, typeStr, isPandL, inCache: cache.type.has(typeCacheKey) };
            });
            
            const allAccountsAreIncomeStatement = accountTypeChecks.every(check => check.isPandL);
            
            // Debug logging
            console.log(`  🔍 PERIOD RANGE OPTIMIZATION CHECK:`);
            console.log(`     allRequestsHaveSameRange: ${allRequestsHaveSameRange}`);
            console.log(`     commonFromPeriod: ${commonFromPeriod}, commonToPeriod: ${commonToPeriod}`);
            console.log(`     Account type checks:`, accountTypeChecks);
            console.log(`     allAccountsAreIncomeStatement: ${allAccountsAreIncomeStatement}`);
            
            // Use period range optimization if:
            // 1. All requests have the same period range
            // 2. All accounts are Income Statement (P&L) accounts
            // 3. Range is not a single period (fromPeriod !== toPeriod, already checked above)
            // CRITICAL FIX: Explicitly convert to boolean - JavaScript && returns last truthy value, not boolean
            const usePeriodRangeOptimization = !!(allRequestsHaveSameRange && 
                                                   allAccountsAreIncomeStatement && 
                                                   commonFromPeriod && 
                                                   commonToPeriod);
            
            console.log(`     usePeriodRangeOptimization: ${usePeriodRangeOptimization} (type: ${typeof usePeriodRangeOptimization})`);
            
            if (usePeriodRangeOptimization) {
                console.log(`  📅 PERIOD RANGE OPTIMIZATION: Using single query for ${commonFromPeriod} to ${commonToPeriod}`);
                console.log(`     Accounts: ${accounts.length}, All P&L accounts: ${allAccountsAreIncomeStatement}`);
                console.log(`     ✅ PROOF: Will send period range to backend (single query instead of chunking)`);
                
                // Calculate period count for logging (but don't expand)
                const expandedForLogging = expandPeriodRangeFromTo(commonFromPeriod, commonToPeriod);
                console.log(`     📊 Range spans ${expandedForLogging.length} periods - will be queried in single query`);
                
                // Skip period expansion and chunking - send range directly to backend
                // This will be handled in the API call below
            } else {
                console.log(`  ⚠️ PERIOD RANGE OPTIMIZATION NOT USED - will use chunking instead`);
            }
            
            // Collect ALL unique periods from ALL requests in this group
            // EXPAND date ranges (e.g., "Jan 2025" to "Dec 2025" → all 12 months)
            // BUT: Skip expansion if using period range optimization
            const periods = new Set();
            let isFullYearRequest = true;
            let yearForOptimization = null;
            
            if (!usePeriodRangeOptimization) {
                // Only expand periods if NOT using range optimization
                // Track periods by year to detect full year requests
                const periodsByYear = new Map(); // year -> Set of month names
                
                for (const r of uncachedRequests) {
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
                        expanded.forEach(p => {
                            periods.add(p);
                            // Track by year for full year detection
                            const periodMatch = p.match(/^(\w+)\s+(\d{4})$/);
                            if (periodMatch) {
                                const year = periodMatch[2];
                                if (!periodsByYear.has(year)) {
                                    periodsByYear.set(year, new Set());
                                }
                                periodsByYear.get(year).add(periodMatch[1]);
                            }
                        });
                    } else if (fromPeriod && toPeriod && fromPeriod === toPeriod) {
                        // Single period request (e.g., "Feb 2025" to "Feb 2025" or "2025" to "2025")
                        // Check if it's year-only format that needs expansion
                        const isYearOnly = (str) => str && /^\d{4}$/.test(String(str).trim());
                        if (isYearOnly(fromPeriod)) {
                            // Expand year-only to all 12 months
                            const expanded = expandPeriodRangeFromTo(fromPeriod, fromPeriod);
                            console.log(`  📅 Year-only period expansion: ${fromPeriod} → ${expanded.length} months`);
                            expanded.forEach(p => {
                                periods.add(p);
                                // Track by year for full year detection
                                const periodMatch = p.match(/^(\w+)\s+(\d{4})$/);
                                if (periodMatch) {
                                    const year = periodMatch[2];
                                    if (!periodsByYear.has(year)) {
                                        periodsByYear.set(year, new Set());
                                    }
                                    periodsByYear.get(year).add(periodMatch[1]);
                                }
                            });
                            // Set year for optimization
                            const year = parseInt(fromPeriod);
                            if (yearForOptimization === null) {
                                yearForOptimization = String(year);
                            }
                        } else {
                            // Regular single period (e.g., "Feb 2025")
                            periods.add(fromPeriod);
                            
                            // Extract year and month for full year detection
                            const periodMatch = fromPeriod.match(/^(\w+)\s+(\d{4})$/);
                            if (periodMatch) {
                                const month = periodMatch[1];
                                const year = periodMatch[2];
                                if (!periodsByYear.has(year)) {
                                    periodsByYear.set(year, new Set());
                                }
                                periodsByYear.get(year).add(month);
                                
                                // Set year for optimization if not set yet
                                if (yearForOptimization === null) {
                                    yearForOptimization = year;
                                } else if (yearForOptimization !== year) {
                                    // Multiple years detected - can't use year endpoint
                                    isFullYearRequest = false;
                                }
                            }
                        }
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
                
                // Check if we have all 12 months for a single year (full year detection)
                if (yearForOptimization && periodsByYear.has(yearForOptimization)) {
                    const monthsInYear = periodsByYear.get(yearForOptimization);
                    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                    const hasAllMonths = monthNames.every(m => monthsInYear.has(m));
                    
                    if (hasAllMonths && periodsByYear.size === 1) {
                        // All 12 months of a single year - treat as full year request
                        isFullYearRequest = true;
                        console.log(`  ✅ Detected full year request: All 12 months of ${yearForOptimization} present`);
                    } else if (monthsInYear.size >= 10 && periodsByYear.size === 1) {
                        // At least 10 months of a single year - still use year endpoint for efficiency
                        isFullYearRequest = true;
                        console.log(`  ✅ Detected near-full year request: ${monthsInYear.size} months of ${yearForOptimization} present`);
                    }
                }
            }
            const periodsArray = [...periods];
            
            // FALLBACK: If yearForOptimization wasn't set but we have periods, try to detect it
            if (!yearForOptimization && periodsArray.length > 0) {
                const years = new Set();
                for (const p of periodsArray) {
                    const match = p.match(/^\w+\s+(\d{4})$/);
                    if (match) {
                        years.add(match[1]);
                    }
                }
                if (years.size === 1) {
                    yearForOptimization = Array.from(years)[0];
                    console.log(`  🔍 Detected year from periods: ${yearForOptimization} (${periodsArray.length} periods)`);
                }
            }
            
            // OPTIMIZATION: Year endpoint returns P&L activity totals, which is correct for Income Statement accounts.
            // NOTE: allAccountsAreIncomeStatement is already calculated above in the period range optimization check
            // Reuse that value instead of recalculating
            
            // CRITICAL: Don't use year endpoint when we need individual month values!
            // The /batch/balance/year endpoint returns a single FY total (e.g., {"FY 2025": 123456})
            // NOT individual month breakdowns. For monthly values, we must use /batch/full_year_refresh
            // which returns all 12 months separately (e.g., {"Jan 2025": 10000, "Feb 2025": 20000, ...})
            // 
            // Year endpoint is ONLY for YTD totals, not monthly breakdowns.
            // For quick start income statement with 12 single-period requests, we need monthly values,
            // so we should use full_year_refresh pattern, NOT year endpoint.
            const useYearEndpoint = false; // DISABLED: Year endpoint doesn't support monthly breakdowns
            
            // OPTIMIZATION: For individual month requests (12+ months of same year), use full_year_refresh pattern
            // This gets all 12 months in one query, then we extract the specific months needed
            // Much more efficient than chunking into separate queries
            // CRITICAL: This is the correct endpoint for monthly breakdowns (not year endpoint)
            // Changed to >= 3 to use full-year refresh for 3+ periods (single query, all data at once)
            // This provides better overall performance than 3-column batching
            const useFullYearRefreshPattern = !usePeriodRangeOptimization && !useYearEndpoint && 
                allAccountsAreIncomeStatement && yearForOptimization && 
                periodsArray.length >= 3 && periodsArray.every(p => {
                    const match = p.match(/^\w+\s+(\d{4})$/);
                    return match && match[1] === yearForOptimization;
                });
            
            // Also use full_year_refresh if we have 3+ months of same year
            // This ensures monthly breakdowns are returned, not just FY totals
            let shouldUseFullYearRefresh = useFullYearRefreshPattern;
            if (!shouldUseFullYearRefresh && !usePeriodRangeOptimization && !useYearEndpoint &&
                allAccountsAreIncomeStatement && yearForOptimization && periodsArray.length >= 3) {
                const allSameYear = periodsArray.every(p => {
                    const match = p.match(/^\w+\s+(\d{4})$/);
                    return match && match[1] === yearForOptimization;
                });
                if (allSameYear) {
                    // Override: Use full_year_refresh for 3+ months to get monthly breakdowns
                    shouldUseFullYearRefresh = true;
                    console.log(`  ✅ Overriding: Using full_year_refresh for ${periodsArray.length} months (3+ periods, same year)`);
                }
            }
            // CRITICAL FIX: Make useFullYearRefreshPatternFinal mutable so column-based grid can override it
            let useFullYearRefreshPatternFinal = shouldUseFullYearRefresh;
            
            // FALLBACK: Check for column-based grid detection BEFORE finalizing full-year decision
            // This provides column-first processing as fallback for mixed years or <3 periods
            // CRITICAL FIX: Also check if column-based grid has 3+ periods from same year
            // This enables full-year optimization even when periodsArray.length is 1 (drag-right scenario)
            let useColumnBasedPLGrid = false;
            let columnBasedPLGrid = null;
            
            if (!useFullYearRefreshPatternFinal && !usePeriodRangeOptimization && 
                allAccountsAreIncomeStatement && uncachedRequests.length > 0) {
                // Try column-based grid detection as fallback
                const evaluatingRequests = uncachedRequests.map(r => ({ params: r.request.params }));
                columnBasedPLGrid = detectColumnBasedPLGrid(evaluatingRequests);
                
                if (columnBasedPLGrid && columnBasedPLGrid.eligible) {
                    // NEW LOGIC: Check period count and year distribution
                    // 3+ periods: Use full-year refresh (single query, all data at once)
                    // Multiple years: Process each year separately
                    const gridPeriods = columnBasedPLGrid.columns.map(col => col.period);
                    const periodsByYear = new Map();
                    
                    for (const period of gridPeriods) {
                        const match = period.match(/^(\w+)\s+(\d{4})$/);
                        if (match) {
                            const year = match[2];
                            if (!periodsByYear.has(year)) {
                                periodsByYear.set(year, []);
                            }
                            periodsByYear.get(year).push(period);
                        }
                    }
                    
                    // Check year distribution
                    const yearCount = periodsByYear.size;
                    const periodsInLargestYear = Math.max(...Array.from(periodsByYear.values()).map(p => p.length));
                    
                    if (yearCount === 1 && periodsInLargestYear >= 3) {
                        // Single year, 3+ periods: Use full-year refresh (single query, all data at once)
                        const gridYearForOptimization = Array.from(periodsByYear.keys())[0];
                        console.log(`  ✅ COLUMN-BASED PL GRID: Detected ${gridPeriods.length} periods from ${gridYearForOptimization}`);
                        console.log(`     Using full_year_refresh pattern (3+ periods, single year)`);
                        
                        yearForOptimization = gridYearForOptimization;
                        shouldUseFullYearRefresh = true;
                        useFullYearRefreshPatternFinal = true;
                        console.log(`  ✅ OVERRIDE: Using full_year_refresh for ${gridPeriods.length} periods from ${gridYearForOptimization}`);
                        periodsArray.length = 0;
                        periodsArray.push(...gridPeriods);
                    } else if (yearCount > 1) {
                        // Multiple years: Process column-by-column (handles year boundaries)
                        useColumnBasedPLGrid = true;
                        const yearsList = Array.from(periodsByYear.keys()).join(', ');
                        console.log(`  ✅ COLUMN-BASED PL GRID DETECTED: ${columnBasedPLGrid.allAccounts.size} accounts × ${gridPeriods.length} periods`);
                        console.log(`     Multiple years detected (${yearsList}) - processing column-by-column`);
                    } else {
                        // Fallback: Use column-based grid processing
                        useColumnBasedPLGrid = true;
                        console.log(`  ✅ COLUMN-BASED PL GRID DETECTED: ${columnBasedPLGrid.allAccounts.size} accounts × ${columnBasedPLGrid.columns.length} periods`);
                        console.log(`     Will process periods column-by-column (faster than row-by-row)`);
                    }
                }
            }
            
            // Enhanced logging for full-year pattern detection
            if (useFullYearRefreshPatternFinal) {
                console.log(`  ✅ FULL YEAR REFRESH PATTERN DETECTED:`);
                console.log(`     Accounts: ${accounts.length} (all Income Statement: ${allAccountsAreIncomeStatement})`);
                console.log(`     Periods: ${periodsArray.length} months of ${yearForOptimization}`);
                console.log(`     ✅ Will send all ${periodsArray.length} periods in ONE batch (no chunking)`);
                console.log(`     ✅ Will use /batch/full_year_refresh to get monthly breakdowns (not FY total)`);
            } else if (allAccountsAreIncomeStatement && !usePeriodRangeOptimization && periodsArray.length >= 3) {
                // Log why full-year pattern wasn't used
                console.log(`  ⚠️ FULL YEAR PATTERN NOT USED (but should be?):`);
                console.log(`     allAccountsAreIncomeStatement: ${allAccountsAreIncomeStatement}`);
                console.log(`     yearForOptimization: ${yearForOptimization}`);
                console.log(`     periodsArray.length: ${periodsArray.length} (need >= 3)`);
                console.log(`     usePeriodRangeOptimization: ${usePeriodRangeOptimization}`);
                console.log(`     useYearEndpoint: ${useYearEndpoint}`);
                if (yearForOptimization && periodsArray.length >= 3) {
                    const allSameYear = periodsArray.every(p => {
                        const match = p.match(/^\w+\s+(\d{4})$/);
                        return match && match[1] === yearForOptimization;
                    });
                    console.log(`     allSameYear: ${allSameYear}`);
                    if (!allSameYear) {
                        const years = new Set(periodsArray.map(p => {
                            const match = p.match(/^\w+\s+(\d{4})$/);
                            return match ? match[1] : 'unknown';
                        }));
                        console.log(`     Years found: ${Array.from(years).join(', ')}`);
                    }
                }
            }
            
            if (useYearEndpoint) {
                console.log(`  🗓️ YEAR OPTIMIZATION: Using /batch/balance/year for FY ${yearForOptimization} (Income Statement accounts)`);
                console.log(`     Accounts: ${accounts.length}, Periods: ${periodsArray.length}, Full Year: ${isFullYearRequest}`);
                console.log(`     ✅ PROOF: Year endpoint will be used (single query for entire year)`);
            } else if (allAccountsAreIncomeStatement && !usePeriodRangeOptimization && periodsArray.length < 3) {
                console.log(`  ⚠️ Income Statement accounts detected but year optimization not used:`);
                console.log(`     isFullYearRequest: ${isFullYearRequest}, yearForOptimization: ${yearForOptimization}, periodsArray.length: ${periodsArray.length} (< 3, need >= 3)`);
            }
            
            console.log(`  Batch: ${accounts.length} accounts × ${periodsArray.length} period(s)`);
            
            // Split into chunks to avoid overwhelming NetSuite
            const accountChunks = [];
            for (let i = 0; i < accounts.length; i += CHUNK_SIZE) {
                accountChunks.push(accounts.slice(i, i + CHUNK_SIZE));
            }
            
            const periodChunks = [];
            if (usePeriodRangeOptimization) {
                // For period range, we don't chunk periods - single query handles entire range
                periodChunks.push([]); // Empty array indicates range mode
            } else if (useFullYearRefreshPatternFinal) {
                // OPTIMIZATION: For 3+ months of same year, send all in one batch (no chunking)
                // This is much faster than chunking into 3-4 separate queries
                periodChunks.push(periodsArray); // Send all periods in one batch
                console.log(`  ✅ FULL YEAR PATTERN: Sending all ${periodsArray.length} periods in ONE batch (no chunking)`);
            } else {
                // Normal chunking for smaller requests
                for (let i = 0; i < periodsArray.length; i += MAX_PERIODS_PER_BATCH) {
                    periodChunks.push(periodsArray.slice(i, i + MAX_PERIODS_PER_BATCH));
                }
            }
            
            if (usePeriodRangeOptimization) {
                console.log(`  Split into ${accountChunks.length} account chunk(s) × 1 period range = ${accountChunks.length} total batches`);
            } else {
                console.log(`  Split into ${accountChunks.length} account chunk(s) × ${periodChunks.length} period chunk(s) = ${accountChunks.length * periodChunks.length} total batches`);
            }
            
            // Track which requests have been resolved
            const resolvedRequests = new Set();
            
            // SPECIAL CASE: If using full_year_refresh, call it ONCE for all accounts
            // (not per chunk, since it returns all accounts anyway)
            // This must happen BEFORE chunking to avoid duplicate calls
            if (useFullYearRefreshPatternFinal && yearForOptimization) {
                console.log(`  📤 FULL YEAR REFRESH (SINGLE CALL): All ${accounts.length} accounts for year ${yearForOptimization} (fetching all 12 months...)`);
                
                // Show progress indicator to reduce perceived slowness
                try {
                    if (typeof Office !== 'undefined' && Office.context && Office.context.mailbox) {
                        // Outlook context - no status API
                    } else if (typeof Office !== 'undefined' && Office.addin) {
                        // Excel context - use status API if available
                        Office.addin.showAsTaskpane();
                    }
                } catch (e) {
                    // Ignore errors - progress indicator is optional
                }
                
                const fullYearStartTime = Date.now();
                
                try {
                    // CRITICAL FIX: Backend expects "book" not "accountingbook", and it should be a number or omitted
                    const payload = {
                        year: parseInt(yearForOptimization),
                        subsidiary: filters.subsidiary || '',
                        department: filters.department || '',
                        location: filters.location || '',
                        class: filters.class || '',
                        skip_bs: true
                    };
                    // Only include book if it's not empty (convert string to number)
                    if (filters.accountingBook && filters.accountingBook !== '' && filters.accountingBook !== '1') {
                        const bookNum = parseInt(filters.accountingBook);
                        if (!isNaN(bookNum)) {
                            payload.book = bookNum;
                        }
                    }
                    
                    const response = await fetch(`${SERVER_URL}/batch/full_year_refresh`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    });
                    
                    if (!response.ok) {
                        console.error(`  ❌ Full year refresh error: ${response.status}`);
                        // Fall back to regular chunked processing
                        console.log(`  ⚠️ Falling back to regular /batch/balance endpoint`);
                    } else {
                        const data = await response.json();
                        const balances = data.balances || {};
                        const fullYearTime = ((Date.now() - fullYearStartTime) / 1000).toFixed(1);
                        
                        console.log(`  ✅ Full year refresh returned ${Object.keys(balances).length} accounts in ${fullYearTime}s`);
                        console.log(`     ✅ All 12 months retrieved in SINGLE query (not per chunk)`);
                        console.log(`     ✅ Progress: Fetching ${yearForOptimization} data complete - updating all cells`);
                        
                        // Distribute results - each request gets its specific month value
                        for (const {cacheKey, request} of uncachedRequests) {
                            if (resolvedRequests.has(cacheKey)) continue;
                            
                            const account = request.params.account;
                            
                            // For single-period requests (fromPeriod === toPeriod), extract the specific month
                            const fromPeriod = request.params.fromPeriod;
                            const toPeriod = request.params.toPeriod;
                            
                            // Get account data with all 12 months
                            const accountBalances = balances[account] || {};
                            
                            // Determine which period value to use
                            let periodValue = 0;
                            
                            // Helper to check if period is year-only
                            const isYearOnly = (str) => str && /^\d{4}$/.test(String(str).trim());
                            
                            if (fromPeriod && toPeriod && fromPeriod === toPeriod) {
                                // Single period request
                                if (isYearOnly(fromPeriod)) {
                                    // Year-only format - sum all 12 months for that year
                                    const expanded = expandPeriodRangeFromTo(fromPeriod, fromPeriod);
                                    periodValue = expanded.reduce((sum, p) => sum + (accountBalances[p] || 0), 0);
                                    console.log(`    📊 Summing ${expanded.length} months for year ${fromPeriod}: ${periodValue}`);
                                } else {
                                    // Specific month - get that month's value
                                    periodValue = accountBalances[fromPeriod] || 0;
                                }
                            } else if (fromPeriod && toPeriod && fromPeriod !== toPeriod) {
                                // Range request - sum the months in range
                                const expanded = expandPeriodRangeFromTo(fromPeriod, toPeriod);
                                periodValue = expanded.reduce((sum, p) => sum + (accountBalances[p] || 0), 0);
                            } else if (toPeriod) {
                                // Single period (toPeriod only)
                                if (isYearOnly(toPeriod)) {
                                    // Year-only format - sum all 12 months for that year
                                    const expanded = expandPeriodRangeFromTo(toPeriod, toPeriod);
                                    periodValue = expanded.reduce((sum, p) => sum + (accountBalances[p] || 0), 0);
                                    console.log(`    📊 Summing ${expanded.length} months for year ${toPeriod}: ${periodValue}`);
                                } else {
                                    // Specific month - get that month's value
                                    periodValue = accountBalances[toPeriod] || 0;
                                }
                            }
                            
                            // Cache and resolve
                            cache.balance.set(cacheKey, periodValue);
                            request.resolve(periodValue);
                            resolvedRequests.add(cacheKey);
                            
                            console.log(`    🎯 RESOLVING (full_year_refresh): ${account} for ${toPeriod} = ${periodValue}`);
                        }
                        
                        console.log(`  ✅ All ${uncachedRequests.length} requests resolved from single full_year_refresh call`);
                        continue; // Skip chunked processing entirely - go to next filter group
                    }
                } catch (error) {
                    console.error(`  ❌ Full year refresh error:`, error);
                    console.log(`  ⚠️ Falling back to column-based grid or regular /batch/balance endpoint`);
                    // Fall through to column-based grid or regular chunked processing
                }
            }
            
            // FALLBACK: Column-based PL grid processing (period-first, then accounts)
            // This processes periods sequentially, fetching all accounts for each period
            if (useColumnBasedPLGrid && columnBasedPLGrid && !useFullYearRefreshPatternFinal) {
                console.log(`  📊 COLUMN-BASED PL GRID: Processing ${columnBasedPLGrid.allAccounts.size} accounts × ${columnBasedPLGrid.columns.length} periods`);
                console.log(`     Strategy: Process periods column-by-column (faster than row-by-row)`);
                
                try {
                    const gridAccounts = Array.from(columnBasedPLGrid.allAccounts);
                    const gridPeriods = columnBasedPLGrid.columns.map(col => col.period).sort((a, b) => {
                        const aDate = parsePeriodToDate(a);
                        const bDate = parsePeriodToDate(b);
                        if (!aDate || !bDate) return 0;
                        return aDate.getTime() - bDate.getTime();
                    });
                    
                    // Process periods in batches of 3 for incremental updates (better UX)
                    const BATCH_SIZE = 3;
                    for (let batchStart = 0; batchStart < gridPeriods.length; batchStart += BATCH_SIZE) {
                        const batchEnd = Math.min(batchStart + BATCH_SIZE, gridPeriods.length);
                        const periodBatch = gridPeriods.slice(batchStart, batchEnd);
                        const batchNumber = Math.floor(batchStart / BATCH_SIZE) + 1;
                        const totalBatches = Math.ceil(gridPeriods.length / BATCH_SIZE);
                        
                        console.log(`  📦 Processing batch ${batchNumber}/${totalBatches}: ${periodBatch.join(', ')} (${gridAccounts.length} accounts)`);
                        
                        // Fetch all accounts for this batch of periods in one query
                        const batchStartTime = Date.now();
                        const response = await fetch(`${SERVER_URL}/batch/balance`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                accounts: gridAccounts,
                                periods: periodBatch,
                                subsidiary: filters.subsidiary || '',
                                department: filters.department || '',
                                location: filters.location || '',
                                class: filters.class || '',
                                book: filters.accountingBook || ''
                            })
                        });
                        
                        if (!response.ok) {
                            const errorText = await response.text();
                            console.error(`  ❌ Column-based PL batch error for ${periodBatch.join(', ')}: ${response.status} - ${errorText}`);
                            // Reject requests for these periods
                            for (const {cacheKey, request} of uncachedRequests) {
                                if (periodBatch.includes(request.params.toPeriod) && !resolvedRequests.has(cacheKey)) {
                                    request.reject(new Error(`API error: ${response.status}`));
                                    resolvedRequests.add(cacheKey);
                                }
                            }
                            continue; // Skip to next batch
                        }
                        
                        const data = await response.json();
                        const balances = data.balances || {};
                        const batchTime = ((Date.now() - batchStartTime) / 1000).toFixed(1);
                        console.log(`  ✅ Batch ${batchNumber} complete: ${Object.keys(balances).length} accounts in ${batchTime}s`);
                        
                        // Resolve all requests for periods in this batch
                        for (const {cacheKey, request} of uncachedRequests) {
                            if (resolvedRequests.has(cacheKey)) continue;
                            
                            const account = request.params.account;
                            const toPeriod = request.params.toPeriod;
                            
                            if (periodBatch.includes(toPeriod) && gridAccounts.includes(account)) {
                                const accountData = balances[account] || {};
                                const periodValue = accountData[toPeriod] || 0;
                                
                                // Cache and resolve
                                cache.balance.set(cacheKey, periodValue);
                                request.resolve(periodValue);
                                resolvedRequests.add(cacheKey);
                                
                                console.log(`    🎯 RESOLVING (column-based PL): ${account} for ${toPeriod} = ${periodValue}`);
                            }
                        }
                        
                        // Update cells incrementally as each batch completes
                        console.log(`  ✅ Batch ${batchNumber}/${totalBatches} complete: All cells for ${periodBatch.join(', ')} updated`);
                    }
                    
                    console.log(`  ✅ All columns complete: ${resolvedRequests.size} requests resolved`);
                    continue; // Skip to next filter group
                } catch (error) {
                    console.error(`  ❌ Column-based PL grid error:`, error);
                    console.log(`  ⚠️ Falling back to regular chunked processing`);
                    // Fall through to regular chunked processing
                }
            }
            
            // For each request, track which period chunks need to be processed
            // Only needed for period list mode (not period range mode)
            const requestAccumulators = new Map();
            if (!usePeriodRangeOptimization) {
                for (const {cacheKey, request} of uncachedRequests) {
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
            }
            
            // YEAR OPTIMIZATION: If requesting full year for Income Statement accounts, use optimized year endpoint
            if (useYearEndpoint) {
                const yearStartTime = Date.now();
                console.log(`  📤 Year request: ${accounts.length} accounts for FY ${yearForOptimization}`);
                console.log(`     ✅ PROOF: SINGLE query for ${accounts.length} accounts × 12 months`);
                console.log(`     ✅ PROOF: NOT ${accounts.length * 12} individual queries`);
                console.log(`     ✅ PROOF: NOT ${accounts.length} queries (one per account)`);
                console.log(`     ✅ PROOF: NOT 12 queries (one per period)`);
                
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
                        console.log(`     ✅ PROOF: Single query completed in ${yearTime}s (target: <30s)`);
                        console.log(`     ✅ PROOF: Writing back ${uncachedRequests.length} results simultaneously`);
                        
                        // Resolve all requests with year totals
                        const resolveStartTime = Date.now();
                        let resolveCount = 0;
                        for (const {cacheKey, request} of uncachedRequests) {
                            const account = request.params.account;
                            const accountData = balances[account] || {};
                            const total = accountData[periodName] || 0;
                            
                            console.log(`    🎯 RESOLVING (year): ${account} = ${total}`);
                            
                            cache.balance.set(cacheKey, total);
                            request.resolve(total);
                            resolvedRequests.add(cacheKey);
                            resolveCount++;
                        }
                        const resolveTime = ((Date.now() - resolveStartTime) / 1000).toFixed(3);
                        const totalTime = ((Date.now() - yearStartTime) / 1000).toFixed(1);
                        
                        console.log(`     ✅ PROOF: Resolved ${resolveCount} promises in ${resolveTime}s`);
                        console.log(`     ✅ PROOF: Total time: ${totalTime}s (query: ${yearTime}s + resolve: ${resolveTime}s)`);
                        console.log(`     ✅ PROOF: All ${resolveCount} cells updated simultaneously (NOT one-by-one)`);
                        
                        continue; // Skip to next filter group
                    } else {
                        console.warn(`  ⚠️ Year endpoint failed (${response.status}), falling back to monthly`);
                    }
                } catch (yearError) {
                    console.warn(`  ⚠️ Year endpoint error, falling back to monthly:`, yearError);
                }
            }
            
            // Process chunks sequentially (both accounts AND periods)
            // Skip if year endpoint was used OR full_year_refresh was used (already resolved all requests)
            if ((!useYearEndpoint || usePeriodRangeOptimization) && resolvedRequests.size === 0) {
                let chunkIndex = 0;
                const totalChunks = usePeriodRangeOptimization ? accountChunks.length : accountChunks.length * periodChunks.length;
                
                for (let ai = 0; ai < accountChunks.length; ai++) {
                    if (usePeriodRangeOptimization) {
                        // PERIOD RANGE MODE: Single query for entire range
                        chunkIndex++;
                        const accountChunk = accountChunks[ai];
                        const chunkStartTime = Date.now();
                        console.log(`  📤 Chunk ${chunkIndex}/${totalChunks}: ${accountChunk.length} accounts × PERIOD RANGE (${commonFromPeriod} to ${commonToPeriod}) (fetching...)`);
                        
                        try {
                            // Make batch API call with period range
                            // Ensure commonFromPeriod and commonToPeriod are defined
                            if (!commonFromPeriod || !commonToPeriod) {
                                console.error(`  ❌ PERIOD RANGE ERROR: commonFromPeriod or commonToPeriod is undefined`);
                                throw new Error('Period range optimization variables not set');
                            }
                            
                            // Build request body - only include non-empty optional fields
                            const requestBody = {
                                accounts: accountChunk,
                                from_period: commonFromPeriod,
                                to_period: commonToPeriod,
                                periods: [] // Empty periods array indicates range mode
                            };
                            
                            // Only add optional fields if they have values (don't send empty strings)
                            if (filters.subsidiary) requestBody.subsidiary = filters.subsidiary;
                            if (filters.department) requestBody.department = filters.department;
                            if (filters.location) requestBody.location = filters.location;
                            if (filters.class) requestBody.class = filters.class;
                            if (filters.accountingBook) requestBody.book = filters.accountingBook; // Backend expects 'book'
                            
                            console.log(`  📤 Sending period range request:`, JSON.stringify(requestBody, null, 2));
                            
                            const response = await fetch(`${SERVER_URL}/batch/balance`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify(requestBody)
                            });
                        
                            if (!response.ok) {
                                // Try to get error details from response
                                let errorDetails = '';
                                try {
                                    const errorData = await response.json();
                                    errorDetails = JSON.stringify(errorData, null, 2);
                                    console.error(`  ❌ API error ${response.status} details:`, errorData);
                                } catch (e) {
                                    const errorText = await response.text();
                                    errorDetails = errorText || 'No error details available';
                                    console.error(`  ❌ API error ${response.status} text:`, errorText);
                                }
                                console.error(`  ❌ API error: ${response.status} - ${errorDetails}`);
                                // Reject all promises in this chunk
                                for (const {cacheKey, request} of uncachedRequests) {
                                    if (accountChunk.includes(request.params.account) && !resolvedRequests.has(cacheKey)) {
                                        request.reject(new Error(`API error: ${response.status}`));
                                        resolvedRequests.add(cacheKey);
                                    }
                                }
                                continue;
                            }
                            
                            const data = await response.json();
                            
                            // Check for backend errors (TIMEOUT, RATELIMIT, etc.)
                            if (data.error) {
                                console.error(`  ❌ Backend error: ${data.error}`);
                                // Reject all promises in this chunk with the error
                                for (const {cacheKey, request} of uncachedRequests) {
                                    if (accountChunk.includes(request.params.account) && !resolvedRequests.has(cacheKey)) {
                                        request.reject(new Error(data.error));
                                        resolvedRequests.add(cacheKey);
                                    }
                                }
                                continue;
                            }
                            
                            const balances = data.balances || {};
                            const chunkTime = ((Date.now() - chunkStartTime) / 1000).toFixed(1);
                            console.log(`  ✅ Received data for ${accountChunk.length} accounts in ${chunkTime}s`);
                            console.log(`     ✅ PROOF: Single query completed for entire period range`);
                            console.log(`     ✅ PROOF: This was recognized as a SINGLE QUERY (not chunked)`);
                            
                            // Process results - range query returns single total per account
                            for (const {cacheKey, request} of uncachedRequests) {
                                if (resolvedRequests.has(cacheKey)) continue;
                                
                                const account = request.params.account;
                                if (!accountChunk.includes(account)) continue;
                                
                                // Range query returns balance under range key
                                const rangeKey = `${commonFromPeriod} to ${commonToPeriod}`;
                                const accountData = balances[account] || {};
                                const total = accountData[rangeKey] || 0;
                                
                                // Cache the result
                                cache.balance.set(cacheKey, total);
                                
                                // Resolve the promise
                                request.resolve(total);
                                resolvedRequests.add(cacheKey);
                                
                                console.log(`    🎯 RESOLVING (range): ${account} = ${total}`);
                            }
                        } catch (error) {
                            console.error(`  ❌ Chunk error:`, error);
                                // Reject all promises in this chunk
                                for (const {cacheKey, request} of uncachedRequests) {
                                    if (accountChunk.includes(request.params.account) && !resolvedRequests.has(cacheKey)) {
                                        request.reject(error);
                                        resolvedRequests.add(cacheKey);
                                    }
                                }
                        }
                    } else {
                        // PERIOD LIST MODE: Process each period chunk
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
                                        accountingbook: filters.accountingBook || ''
                                    })
                                });
                            
                                if (!response.ok) {
                                    console.error(`  ❌ API error: ${response.status}`);
                                    // Reject all promises in this chunk
                                    for (const {cacheKey, request} of uncachedRequests) {
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
                                
                                // Distribute results to waiting Promises
                                for (const {cacheKey, request} of uncachedRequests) {
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
                                for (const {cacheKey, request} of uncachedRequests) {
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
                }
                
                // Resolve any remaining unresolved requests
                // Only needed for period list mode (period range mode resolves immediately)
                if (!usePeriodRangeOptimization) {
                    for (const {cacheKey, request} of uncachedRequests) {
                        if (!resolvedRequests.has(cacheKey)) {
                            const accum = requestAccumulators.get(cacheKey);
                            if (accum) {
                                console.log(`  ⚠️ FORCE-RESOLVING: ${request.params.account} = ${accum.total}`);
                                try {
                                    request.resolve(accum.total);
                                } catch (err) {
                                    console.error(`  ❌ Force-resolve FAILED:`, err);
                                }
                                resolvedRequests.add(cacheKey);
                            }
                        }
                    }
                }
            } // Close the "if (!useYearEndpoint || usePeriodRangeOptimization)" block
        } // Close the "for (const [filterKey, groupRequests] of groups.entries())" loop
    }
    
    // ================================================================
    // PERIOD ACTIVITY QUERIES: Handle separately (both fromPeriod and toPeriod, BS accounts only)
    // These need direct /balance API calls, not batch endpoint
    // The batch endpoint expands period ranges, which is wrong for period activity queries
    // ================================================================
    if (periodActivityRequests.length > 0) {
        console.log(`📊 Processing ${periodActivityRequests.length} PERIOD ACTIVITY (BS) requests separately...`);
        
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
                    batch_mode: 'true',  // Enable batch mode for period activity breakdown
                    include_period_breakdown: 'true',  // Request per-period activity, not cumulative
                    subsidiary: subsidiary || '',
                    department: department || '',
                    location: location || '',
                    class: classId || '',
                    accountingbook: accountingBook || ''
                });
                
                console.log(`   📤 Period activity API: ${account} (${fromPeriod} → ${toPeriod}) [batch_mode=true]`);
                activityApiCalls++;
                
                const response = await fetch(`${SERVER_URL}/balance?${apiParams.toString()}`);
                
                if (response.ok) {
                    const data = await response.json();
                    
                    // Handle period activity breakdown response
                    if (data.period_activity && typeof data.period_activity === 'object') {
                        // Backend returns period_activity dictionary: {period: activity}
                        // For single period queries, extract the activity for that period
                        const periodActivity = data.period_activity;
                        const targetPeriod = fromPeriod === toPeriod ? fromPeriod : toPeriod;
                        const activity = periodActivity[targetPeriod] ?? 0;
                        
                        console.log(`   ✅ Period activity result: ${account} (${fromPeriod} → ${toPeriod}) = ${activity.toLocaleString()}`);
                        cache.balance.set(cacheKey, activity);
                        request.resolve(activity);
                    } else {
                        // Fallback to balance field if period_activity not present
                        const value = data.balance ?? 0;
                        const errorCode = data.error;
                        
                        if (errorCode) {
                            console.log(`   ⚠️ Period activity result: ${account} = ${errorCode}`);
                            request.reject(new Error(errorCode));
                        } else {
                            console.log(`   ✅ Period activity result (fallback): ${account} = ${value.toLocaleString()}`);
                            cache.balance.set(cacheKey, value);
                            request.resolve(value);
                        }
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
    
    const totalBatchTime = ((Date.now() - batchStartTime) / 1000).toFixed(1);
    const batchCompleteTime = new Date().toISOString();
    console.log('========================================');
    console.log(`✅ BATCH PROCESSING COMPLETE in ${totalBatchTime}s`);
    console.log('========================================\n');
    
    // NOTE: We do NOT broadcast status here because:
    // 1. Promises resolve immediately (cache hits resolve in 0.1s), but Excel takes 30+ seconds to process them
    // 2. We cannot detect when Excel has actually processed resolved promises and updated cells
    // 3. Excel's custom function API doesn't provide a callback when a resolved promise is processed
    // 4. Showing status before Excel updates would be misleading
    // 
    // Status should only come from:
    // - Build mode (runBuildModeBatch) - handles status for multiple formulas (drag-fill scenarios)
    // - Taskpane - handles status for preload operations
    // - NOT from processBatchQueue() - which handles single/batch formula entries
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
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
                return fetchBatchBalances(accounts, periods, filters, allRequests, retryCount + 1);
            }
        }
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        }
        
        const data = await response.json();
        const balances = data.balances || {};
        
        // Resolve all requests
        for (const [cacheKey, request] of allRequests) {
            const account = request.params.account;
            const accountBalances = balances[account] || {};
            
            // For period ranges, sum all periods
            let total = 0;
            for (const period of periods) {
                total += accountBalances[period] || 0;
            }
            
            cache.balance.set(cacheKey, total);
            request.resolve(total);
        }
    } catch (error) {
        // Reject all requests on error
        for (const [cacheKey, request] of allRequests) {
            request.reject(error);
        }
    }
}
*/

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
        
        // Normalize parameters
        account = String(account || '').trim();
        fromPeriod = fromPeriod !== undefined && fromPeriod !== null ? String(fromPeriod).trim() : '';
        toPeriod = String(toPeriod || '').trim();
        subsidiary = String(subsidiary || '').trim();
        currency = String(currency || '').trim();
        department = String(department || '').trim();
        location = String(location || '').trim();
        classId = String(classId || '').trim();
        accountingBook = String(accountingBook || '').trim();
        
        if (!account) {
            console.error('❌ BALANCECURRENCY: Account is required');
            throw new Error('MISSING_ACCOUNT');
        }
        
        if (!toPeriod) {
            console.error('❌ BALANCECURRENCY: toPeriod is required');
            throw new Error('MISSING_PERIOD');
        }
        
        const params = { account, fromPeriod, toPeriod, subsidiary, department, location, classId, accountingBook, currency };
        const cacheKey = getCacheKey('balancecurrency', params);
        
        // Check cache first
        if (cache.balance.has(cacheKey)) {
            cacheStats.hits++;
            return cache.balance.get(cacheKey);
        }
        
        // Check if there's already a request in-flight for this exact key
        if (inFlightRequests.has(cacheKey)) {
            console.log(`⏳ Waiting for in-flight request [balancecurrency]: ${account} (${fromPeriod || '(cumulative)'} → ${toPeriod})`);
            return await inFlightRequests.get(cacheKey);
        }
        
        cacheStats.misses++;
        
        // Check if build mode is active
        if (buildMode) {
            // Skip requests where toPeriod is empty (cell reference not resolved yet)
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
        
        // VALIDATION: Check subsidiary/accounting book combination
        const validationError = await validateSubsidiaryAccountingBook(subsidiary, accountingBook);
        if (validationError === 'INVALID_COMBINATION') {
            console.error(`❌ RETAINEDEARNINGS: Invalid combination - subsidiary "${subsidiary}" not enabled for accounting book ${accountingBook}`);
            throw new Error('INVALID_COMBINATION');
        } else if (validationError === 'INVALID_BOOK') {
            console.error(`❌ RETAINEDEARNINGS: Accounting book ${accountingBook} has no enabled subsidiaries`);
            throw new Error('INVALID_BOOK');
        }
        
        // Build cache key
        const cacheKey = `retainedearnings:${period}:${subsidiary}:${accountingBook}:${classId}:${department}:${location}`;
        
        // Check cache first
        if (cache.balance.has(cacheKey)) {
            cacheStats.hits++;
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
                
                // Check for backend error response - fail loudly instead of returning 0
                if (data.error || data.errorCode) {
                    const errorMsg = data.error || data.errorDetails || `Error: ${data.errorCode}`;
                    console.error(`❌ Retained Earnings API error: ${errorMsg}`);
                    if (toastId) {
                        updateBroadcastToast(toastId, 'Retained Earnings Failed', errorMsg, 'error');
                        setTimeout(() => removeBroadcastToast(toastId), 5000);
                    }
                    // Map backend error codes to Excel errors
                    if (data.errorCode === 'TIMEOUT' || data.errorCode === 'RATE_LIMIT') {
                        throw new Error('TIMEOUT');
                    }
                    if (data.errorCode === 'AUTH_ERROR') {
                        throw new Error('AUTHERR');
                    }
                    throw new Error('ERROR');
                }
                
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
        
        // VALIDATION: Check subsidiary/accounting book combination
        const validationError = await validateSubsidiaryAccountingBook(subsidiaryStr, accountingBookStr);
        if (validationError === 'INVALID_COMBINATION') {
            console.error(`❌ NETINCOME: Invalid combination - subsidiary "${subsidiaryStr}" not enabled for accounting book ${accountingBookStr}`);
            throw new Error('INVALID_COMBINATION');
        } else if (validationError === 'INVALID_BOOK') {
            console.error(`❌ NETINCOME: Accounting book ${accountingBookStr} has no enabled subsidiaries`);
            throw new Error('INVALID_BOOK');
        }
        
        console.log(`📊 NETINCOME: ${rawFromPeriod} → ${rawToPeriod}`);
        console.log(`   Range: ${convertedFromPeriod} through ${convertedToPeriod}`);
        console.log(`   Subsidiary: "${subsidiaryStr || '(default)'}"`);
        
        // Build cache key
        const cacheKey = `netincome:${convertedFromPeriod}:${convertedToPeriod}:${subsidiaryStr}:${accountingBookStr}:${classIdStr}:${departmentStr}:${locationStr}`;
        
        // Check cache first
        if (cache.balance.has(cacheKey)) {
            cacheStats.hits++;
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
                
                // Check for backend error response - fail loudly instead of returning 0
                if (data.error || data.errorCode) {
                    const errorMsg = data.error || data.errorDetails || `Error: ${data.errorCode}`;
                    console.error(`❌ Net Income API error: ${errorMsg}`);
                    if (toastId) {
                        updateBroadcastToast(toastId, 'Net Income Failed', errorMsg, 'error');
                        setTimeout(() => removeBroadcastToast(toastId), 5000);
                    }
                    // Map backend error codes to Excel errors
                    if (data.errorCode === 'TIMEOUT' || data.errorCode === 'RATE_LIMIT') {
                        throw new Error('TIMEOUT');
                    }
                    if (data.errorCode === 'AUTH_ERROR') {
                        throw new Error('AUTHERR');
                    }
                    throw new Error('ERROR');
                }
                
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
    
    // ============================================================================
    // CRITICAL: GUARD CLAUSE MUST BE FIRST - Check transition state IMMEDIATELY
    // This prevents ANY execution during invalid parameter states (book changed, Q3 not updated)
    // Must check BEFORE any async operations, cache lookups, or validations
    // ============================================================================
    const bookStr = String(accountingBook || '').trim();
    const subsidiaryStr = String(subsidiary || '').trim();
    
    // Check transition flag for ALL books (including Primary Book)
    // This ensures formulas show #N/A while user is selecting a subsidiary
    if (bookStr) {
        const transitionKey = `netsuite_book_transition_${bookStr}`;
        try {
            const transitionData = localStorage.getItem(transitionKey);
            if (transitionData) {
                const transition = JSON.parse(transitionData);
                const age = Date.now() - transition.timestamp;
                
                // CRITICAL: If newSubsidiary is null, we're still waiting for user to select
                // Block ALL executions until user selects a subsidiary
                // This applies to both Primary Book and other books
                if (!transition.newSubsidiary) {
                    // Still in transition - user hasn't selected subsidiary yet
                    console.log(`⏸️ TYPEBALANCE: [GUARD] Blocked - book ${bookStr} changed, waiting for subsidiary selection (${Math.round(age/1000)}s ago)`);
                    
                    // Use CustomFunctions.Error for proper #N/A display (Mac-safe)
                    if (typeof CustomFunctions !== 'undefined' && CustomFunctions.Error && CustomFunctions.ErrorCode) {
                        throw new CustomFunctions.Error(CustomFunctions.ErrorCode.notAvailable);
                    } else {
                        // Fallback: Return undefined instead of throwing Error (safer on Mac)
                        console.warn('⚠️ CustomFunctions.Error not available, returning undefined');
                        return undefined;
                    }
                }
                
                // State-based check: Is current subsidiary the OLD (invalid) one?
                // If yes, we're in transition. If it matches NEW subsidiary, transition is complete.
                const isOldSubsidiary = subsidiaryStr === transition.oldSubsidiary;
                const isNewSubsidiary = transition.newSubsidiary && subsidiaryStr === transition.newSubsidiary;
                
                if (isOldSubsidiary && !isNewSubsidiary) {
                    // We're in transition state - current subsidiary is invalid for new book
                    console.log(`⏸️ TYPEBALANCE: [GUARD] Blocked - book ${bookStr} changed, subsidiary "${subsidiaryStr}" not yet updated (${Math.round(age/1000)}s ago)`);
                    
                    // Use CustomFunctions.Error for proper #N/A display (Mac-safe)
                    if (typeof CustomFunctions !== 'undefined' && CustomFunctions.Error && CustomFunctions.ErrorCode) {
                        throw new CustomFunctions.Error(CustomFunctions.ErrorCode.notAvailable);
                    } else {
                        // Fallback: Return undefined instead of throwing Error (safer on Mac)
                        console.warn('⚠️ CustomFunctions.Error not available, returning undefined');
                        return undefined;
                    }
                } else if (isNewSubsidiary) {
                    // Transition complete - clear the flag
                    localStorage.removeItem(transitionKey);
                    console.log(`✅ TYPEBALANCE: [GUARD] Transition complete - subsidiary updated to "${subsidiaryStr}"`);
                } else if (age > 10000) {
                    // Stale transition flag (>10s) - remove it (failsafe)
                    localStorage.removeItem(transitionKey);
                    console.log(`🧹 TYPEBALANCE: [GUARD] Removed stale transition flag (${Math.round(age/1000)}s old)`);
                }
            }
        } catch (e) {
            // If guard clause fails, still proceed (but log it)
            console.warn('⚠️ [GUARD] Transition check error:', e.message);
        }
    }
    
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
        const departmentStr = String(department || '').trim();
        const locationStr = String(location || '').trim();
        const classStr = String(classId || '').trim();
        
        // VALIDATION: Check subsidiary/accounting book combination
        const validationError = await validateSubsidiaryAccountingBook(subsidiaryStr, bookStr);
        if (validationError === 'INVALID_COMBINATION') {
            console.error(`❌ TYPEBALANCE: Invalid combination - subsidiary "${subsidiaryStr}" not enabled for accounting book ${bookStr}`);
            // Use CustomFunctions.Error for proper #N/A display (Mac-safe)
            // Static message (omitted) to avoid recalculation instability
            if (typeof CustomFunctions !== 'undefined' && CustomFunctions.Error && CustomFunctions.ErrorCode) {
                throw new CustomFunctions.Error(CustomFunctions.ErrorCode.notAvailable);
            } else {
                // Fallback: Return undefined instead of throwing Error (safer on Mac)
                console.warn('⚠️ CustomFunctions.Error not available, returning undefined');
                return undefined;
            }
        } else if (validationError === 'INVALID_BOOK') {
            console.error(`❌ TYPEBALANCE: Accounting book ${bookStr} has no enabled subsidiaries`);
            // Use CustomFunctions.Error for proper #N/A display (Mac-safe)
            if (typeof CustomFunctions !== 'undefined' && CustomFunctions.Error && CustomFunctions.ErrorCode) {
                throw new CustomFunctions.Error(CustomFunctions.ErrorCode.notAvailable);
            } else {
                // Fallback: Return undefined instead of throwing Error (safer on Mac)
                console.warn('⚠️ CustomFunctions.Error not available, returning undefined');
                return undefined;
            }
        }
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
                
                // CRITICAL DEBUG: Log sample keys to help diagnose cache key mismatches
                console.log('╔══════════════════════════════════════════════════════════════╗');
                console.log('║  [CACHE DEBUG] TYPEBALANCE cache MISS                        ║');
                console.log('╚══════════════════════════════════════════════════════════════╝');
                console.log(`   Timestamp: ${new Date().toISOString()}`);
                console.log(`   Looking for key: "${cacheKey}"`);
                console.log(`   Account type: "${normalizedType}"`);
                console.log(`   From period: "${convertedFromPeriod}"`);
                console.log(`   To period: "${convertedToPeriod}"`);
                console.log(`   Subsidiary: "${subsidiaryStr}"`);
                console.log(`   Department: "${departmentStr}"`);
                console.log(`   Location: "${locationStr}"`);
                console.log(`   Class: "${classStr}"`);
                console.log(`   Book: "${bookStr}"`);
                console.log(`   Special flag: "${specialFlag}"`);
                console.log(`   Total keys in cache: ${localStorageKeyCount}`);
                
                // Show ALL Income keys in cache for comparison
                const allIncomeKeys = Object.keys(storedBalances).filter(k => k.includes(':Income:'));
                console.log(`   Income keys in cache: ${allIncomeKeys.length}`);
                if (allIncomeKeys.length > 0) {
                    console.log(`   All Income keys:`);
                    allIncomeKeys.slice(0, 12).forEach((key, idx) => {
                        const parts = key.split(':');
                        const keySub = parts[4] || '';
                        const keyBook = parts[8] || '';
                        const keyPeriod = parts[2] || '';
                        console.log(`      [${idx+1}] "${key}"`);
                        console.log(`          Period: "${keyPeriod}", Sub: "${keySub}", Book: "${keyBook}"`);
                    });
                    
                    // Find closest match
                    const ourParts = cacheKey.split(':');
                    const ourSub = ourParts[4] || '';
                    const ourBook = ourParts[8] || '';
                    const ourPeriod = ourParts[2] || '';
                    
                    console.log(`\n   🔍 [CACHE DEBUG] Key component comparison:`);
                    console.log(`      Our period: "${ourPeriod}"`);
                    console.log(`      Our subsidiary: "${ourSub}"`);
                    console.log(`      Our book: "${ourBook}"`);
                    
                    const periodMatches = allIncomeKeys.filter(k => k.includes(ourPeriod));
                    const subMatches = allIncomeKeys.filter(k => k.includes(ourSub));
                    const bookMatches = allIncomeKeys.filter(k => k.includes(`:${ourBook}:`));
                    
                    console.log(`      Keys with matching period: ${periodMatches.length}`);
                    console.log(`      Keys with matching subsidiary: ${subMatches.length}`);
                    console.log(`      Keys with matching book: ${bookMatches.length}`);
                    
                    if (periodMatches.length > 0 && periodMatches.length < allIncomeKeys.length) {
                        console.log(`      Sample period match: "${periodMatches[0]}"`);
                    }
                    if (subMatches.length > 0 && subMatches.length < allIncomeKeys.length) {
                        console.log(`      Sample sub match: "${subMatches[0]}"`);
                    }
                    if (bookMatches.length > 0 && bookMatches.length < allIncomeKeys.length) {
                        console.log(`      Sample book match: "${bookMatches[0]}"`);
                    }
                    
                    // Show character-by-character comparison for first key
                    const sampleKey = allIncomeKeys[0];
                    console.log(`\n   🔍 [CACHE DEBUG] Character-by-character comparison:`);
                    console.log(`      Cache key: "${sampleKey}"`);
                    console.log(`      Our key:    "${cacheKey}"`);
                    console.log(`      Match: ${sampleKey === cacheKey ? 'YES ✅' : 'NO ❌'}`);
                    
                    if (sampleKey !== cacheKey) {
                        const sample = sampleKey;
                        const ours = cacheKey;
                        const minLen = Math.min(sample.length, ours.length);
                        for (let i = 0; i < minLen; i++) {
                            if (sample[i] !== ours[i]) {
                                console.log(`      First diff at position ${i}: cache="${sample[i]}" (${sample.charCodeAt(i)}), ours="${ours[i]}" (${ours.charCodeAt(i)})`);
                                console.log(`      Cache context: "${sample.substring(Math.max(0, i-20), i+20)}"`);
                                console.log(`      Our context:    "${ours.substring(Math.max(0, i-20), i+20)}"`);
                                break;
                            }
                        }
                        if (sample.length !== ours.length) {
                            console.log(`      Length mismatch: cache=${sample.length}, ours=${ours.length}`);
                        }
                    }
                } else {
                    console.log(`   ⚠️ No Income keys found in cache!`);
                    console.log(`   Available account types in cache:`, [...new Set(Object.keys(storedBalances).map(k => k.split(':')[1]))].join(', '));
                }
                
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
                
                // Check for backend error response - fail loudly instead of returning 0
                if (data.error || data.errorCode) {
                    const errorMsg = data.error || data.errorDetails || `Error: ${data.errorCode}`;
                    console.error(`❌ TYPEBALANCE API error: ${errorMsg}`);
                    releaseSpecialFormulaLock(cacheKey);
                    inFlightRequests.delete(cacheKey);
                    // Map backend error codes to Excel errors
                    if (data.errorCode === 'TIMEOUT' || data.errorCode === 'RATE_LIMIT') {
                        throw new Error('TIMEOUT');
                    }
                    if (data.errorCode === 'AUTH_ERROR') {
                        throw new Error('AUTHERR');
                    }
                    throw new Error('ERROR');
                }
                
                // Validate response - don't mask null/undefined as 0
                if (data.value === null || data.value === undefined) {
                    console.error(`❌ TYPEBALANCE (${normalizedType}): API returned null/undefined`);
                    releaseSpecialFormulaLock(cacheKey);
                    inFlightRequests.delete(cacheKey);
                    throw new Error('NODATA');
                }
                
                const value = parseFloat(data.value);
                if (isNaN(value)) {
                    console.error(`❌ TYPEBALANCE (${normalizedType}): Invalid number: ${data.value}`);
                    releaseSpecialFormulaLock(cacheKey);
                    inFlightRequests.delete(cacheKey);
                    throw new Error('ERROR');
                }
                
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
                    
                    // Check for backend error response - fail loudly instead of returning 0
                    if (data.error || data.errorCode) {
                        const errorMsg = data.error || data.errorDetails || `Error: ${data.errorCode}`;
                        console.error(`❌ CTA API error: ${errorMsg}`);
                        if (toastId) {
                            updateBroadcastToast(toastId, 'CTA Failed', errorMsg, 'error');
                            setTimeout(() => removeBroadcastToast(toastId), 5000);
                        }
                        // Map backend error codes to Excel errors
                        if (data.errorCode === 'TIMEOUT' || data.errorCode === 'RATE_LIMIT') {
                            throw new Error('TIMEOUT');
                        }
                        if (data.errorCode === 'AUTH_ERROR') {
                            throw new Error('AUTHERR');
                        }
                        throw new Error('ERROR');
                    }
                    
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
        // Initialize income preload counter on page load
        if (typeof window !== 'undefined' && typeof window.totalIncomeFormulasQueued === 'undefined') {
            window.totalIncomeFormulasQueued = 0;
        }
        
        if (typeof CustomFunctions !== 'undefined' && CustomFunctions.associate) {
            try {
                CustomFunctions.associate('NAME', NAME);
                CustomFunctions.associate('TYPE', TYPE);
                CustomFunctions.associate('PARENT', PARENT);
                CustomFunctions.associate('BALANCE', BALANCE);
                CustomFunctions.associate('BALANCECURRENCY', BALANCECURRENCY);
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

