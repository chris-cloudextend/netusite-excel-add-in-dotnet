# Implementation Review: Drag-Right Preload Fix

## Requirements Checklist

### ✅ 1. Replace Global Counter Check with Period-Aware Logic
**Status:** Ready to implement
- Current: `if (window.totalIncomeFormulasQueued === 1)`
- Proposed: `if (!checkIfPeriodIsCached(normalizedToPeriod))`
- **Note:** `checkIfPeriodIsCached()` exists and is used by Balance Sheet

### ✅ 2. Keep Race Condition Fixes
**Status:** Already in code
- `preloadInProgress` check (line 7706)
- Recent timestamp check < 10 seconds (line 7709)
- Re-check logic for first 20 formulas (line 7714-7735)
- **Action:** Keep all of these

### ⚠️ 3. Verify `checkIfPeriodIsCached()` for Income Statement
**Status:** **ISSUE FOUND - NEEDS FIX**

**Problem:**
- `checkIfPeriodIsCached()` looks for keys ending with `::${normalizedPeriod}` (line 3049)
- Income Statement cache keys are:
  - **New format:** `balance:${account}:${filtersHash}:${period}` (taskpane.html line 9019)
  - **Legacy format:** `balance:${account}::${period}` (taskpane.html line 9024) - only when `filtersHash === '||||1'` or `'||||'`

**Impact:**
- If user has filters (subsidiary, department, etc.), cache keys use format: `balance:${account}:${filtersHash}:${period}`
- `checkIfPeriodIsCached()` won't find these because it only checks for `::${period}` ending
- This means preload will be triggered even when period is already cached (if filters are present)

**Required Fix:**
Update `checkIfPeriodIsCached()` to check for BOTH formats:
1. Legacy format: `::${normalizedPeriod}` (no filters)
2. New format: `:${filtersHash}:${normalizedPeriod}` (with filters)

**Proposed Code:**
```javascript
function checkIfPeriodIsCached(period, filtersHash = null) {
    try {
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
        
        // Check for legacy format: balance:${account}::${normalizedPeriod}
        const legacyPeriodKey = `::${normalizedPeriod}`;
        for (const key of cacheKeys) {
            if (key.endsWith(legacyPeriodKey)) {
                console.log(`✅ checkIfPeriodIsCached("${normalizedPeriod}"): Found cached period (legacy format) in key "${key}", returning true`);
                return true;
            }
        }
        
        // Check for new format: balance:${account}:${filtersHash}:${normalizedPeriod}
        // If filtersHash provided, check for exact match; otherwise check for any filtersHash
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
            const periodKeyPattern = new RegExp(`:[^:]+:${normalizedPeriod.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
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
```

**Alternative (Simpler):** Just check if period appears in ANY cache key, regardless of format:
```javascript
// Simpler approach: Check if period appears in any cache key
for (const key of cacheKeys) {
    if (key.includes(`:${normalizedPeriod}`) || key.endsWith(`::${normalizedPeriod}`)) {
        console.log(`✅ checkIfPeriodIsCached("${normalizedPeriod}"): Found cached period in key "${key}", returning true`);
        return true;
    }
}
```

### ⚠️ 4. Add Duplicate Trigger Prevention
**Status:** **PARTIALLY ADDRESSED - NEEDS ENHANCEMENT**

**Current State:**
- `triggerIncomePreload()` already checks `checkIfPeriodIsCached()` and returns early if cached (line 2914-2920)
- However, there's a race condition: Multiple formulas for the same NEW period could all call `triggerIncomePreload()` before the first one completes

**Problem Scenario:**
1. User drags right to Feb (Row 1) → `checkIfPeriodIsCached('Feb 2025')` returns false → Triggers preload
2. User drags down (Row 2) → `checkIfPeriodIsCached('Feb 2025')` still returns false (preload not complete) → Triggers preload AGAIN
3. Both triggers go to taskpane, which merges them (this is OK)
4. But we should prevent duplicate triggers more explicitly

**Proposed Solution:**
Track "pending" periods in localStorage before calling `triggerIncomePreload()`:

```javascript
// Before calling triggerIncomePreload(), mark period as pending
const pendingKey = `income_preload_pending:${normalizedToPeriod}`;
const isPending = localStorage.getItem(pendingKey);
if (isPending) {
    console.log(`⏳ Period ${normalizedToPeriod} preload already pending - will wait`);
    shouldWaitForPreload = true;
} else if (!isPeriodCached) {
    // Mark as pending BEFORE triggering
    localStorage.setItem(pendingKey, Date.now().toString());
    console.log(`🚀 Period ${normalizedToPeriod} not cached - triggering income preload`);
    triggerIncomePreload(account, normalizedToPeriod, { subsidiary, department, location, classId, accountingBook });
    shouldWaitForPreload = true;
}
```

**Cleanup:** Taskpane should clear pending flag when preload completes (in `markIncomePreloadComplete()` or when saving cache).

**Alternative:** The taskpane already merges multiple triggers (line 8886-8924), so duplicate triggers are handled. But explicit tracking is cleaner and prevents unnecessary trigger creation.

## Summary of Required Changes

### Change 1: Update `checkIfPeriodIsCached()` to handle Income Statement cache format
- **File:** `docs/functions.js`, line 3028-3065
- **Action:** Add support for `balance:${account}:${filtersHash}:${period}` format
- **Priority:** **CRITICAL** - Without this, preload will trigger even when cached

### Change 2: Replace global counter with period-aware check
- **File:** `docs/functions.js`, line 7691-7738
- **Action:** Replace `totalIncomeFormulasQueued === 1` with `!checkIfPeriodIsCached(normalizedToPeriod, filtersHash)`
- **Priority:** **CRITICAL** - This is the main fix

### Change 3: Add duplicate trigger prevention (optional but recommended)
- **File:** `docs/functions.js`, line 7691-7738
- **Action:** Track pending periods in localStorage before triggering
- **Priority:** **RECOMMENDED** - Prevents unnecessary duplicate triggers

### Change 4: Keep race condition fixes
- **File:** `docs/functions.js`, line 7706-7738
- **Action:** Keep all existing race condition logic
- **Priority:** **REQUIRED** - Already in code, just verify it's kept

## Testing Checklist

- [ ] **Test 1:** Drag right to new period (Feb) → Should trigger preload for Feb
- [ ] **Test 2:** Drag right to another new period (Mar) → Should trigger preload for Mar
- [ ] **Test 3:** Drag down in same period → Should wait for existing preload, use cache
- [ ] **Test 4:** Drag right with filters (subsidiary) → Should detect cached period correctly
- [ ] **Test 5:** Multiple formulas for same new period → Should not trigger duplicate preloads
- [ ] **Test 6:** Period already cached → Should skip preload, use cache immediately

## Implementation Order

1. **First:** Fix `checkIfPeriodIsCached()` to handle Income Statement cache format (Change 1)
2. **Second:** Replace global counter with period-aware check (Change 2)
3. **Third:** Add duplicate trigger prevention (Change 3)
4. **Fourth:** Verify race condition fixes are kept (Change 4)
