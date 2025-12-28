# Data Integrity Verification: Root Cause Fixes vs ChatGPT Rules

## ChatGPT's Core Data Integrity Rules (from ENGINEERING_RULES.md)

### Rule 1: Accounting Correctness (Highest Priority)
- ✅ Never return 0 unless proven by NetSuite data to be zero
- ✅ Never substitute missing, unknown, loading, or error states with 0
- ✅ Phantom numbers are unacceptable
- ✅ Prefer BUSY state, explicit error, or blank result over numeric value

### Rule 2: Zero vs Missing Data
- ✅ Zero is a valid accounting result and must be cached
- ✅ Missing data must be explicitly distinguishable from zero
- ✅ Cache logic must never fabricate values

### Rule 3: Caching Invariants
- ✅ Cache misses must not produce numeric output
- ✅ Preload is an optimization only and must never affect correctness
- ✅ All cache keys must use normalized "Mon YYYY" periods

### Rule 4: Preload Behavior
- ✅ Preload failure must never change results
- ✅ Formulas must re-check cache after preload completes

### Rule 5: Formula Evaluation Flow (from PRECACHE_FAILURE_ANALYSIS.md)
```
Formulas check cache → API call → Error (if fails)
```
- ✅ All values come from NetSuite (cache or API)
- ✅ Never return 0 on error
- ✅ Never cache 0 on error

---

## Analysis of Recommended Fixes

### Fix #1: Synchronize Cache Clear Across Contexts

**What it does:**
- Clear in-memory cache BEFORE clearing localStorage
- Use synchronous signal that's checked immediately
- Clear cache in functions.js context directly

**Data Integrity Impact:**
- ✅ **SAFE** - Only affects cache clearing mechanism
- ✅ Does NOT change what values formulas return
- ✅ Does NOT fabricate values
- ✅ Does NOT return 0 for missing data
- ✅ Still follows: Cache → API → Error flow

**Verification:**
- Formulas still check cache first
- If cache cleared properly, formulas will get cache miss
- Cache miss → API call → NetSuite value (correct)
- No phantom numbers possible

**Conclusion:** ✅ **SAFE - No data integrity violations**

---

### Fix #2: Trigger Preload Earlier

**What it does:**
- Trigger preload when FIRST cache miss is detected (not after BUILD MODE)
- Check for preload trigger BEFORE queuing individual API calls
- Wait for preload if it's in progress

**Data Integrity Impact:**
- ✅ **SAFE** - Only affects timing of preload trigger
- ✅ Does NOT change what values formulas return
- ✅ Preload still uses same NetSuite queries
- ✅ Formulas still follow: Cache → API → Error flow

**Verification:**
- Preload triggers earlier, but still uses same backend logic
- Formulas still check cache first
- If cache miss, wait for preload (if in progress)
- After preload, re-check cache
- If still miss, make API call
- All values still come from NetSuite

**Potential Risk:**
- ⚠️ If formulas wait for preload, must ensure they don't wait indefinitely
- ⚠️ Must ensure timeout still allows API call fallback
- ⚠️ Must ensure BUSY state is returned if waiting, not 0

**Mitigation:**
- Use bounded wait (e.g., 90s max)
- After timeout, proceed with API call
- Return BUSY state while waiting (not 0)
- Re-check cache after wait completes

**Conclusion:** ✅ **SAFE - But requires careful implementation of wait logic**

---

### Fix #3: Ensure Taskpane Processes Triggers

**What it does:**
- Check if taskpane is open before creating trigger
- Or use polling mechanism in functions.js to process triggers
- Or trigger preload directly from functions.js (if possible)

**Data Integrity Impact:**
- ✅ **SAFE** - Only affects trigger processing mechanism
- ✅ Does NOT change what values formulas return
- ✅ Preload still uses same NetSuite queries
- ✅ Formulas still follow: Cache → API → Error flow

**Verification:**
- Ensures preload actually starts
- Preload still populates cache from NetSuite
- Formulas still check cache → API → Error
- No values fabricated

**Conclusion:** ✅ **SAFE - No data integrity violations**

---

### Fix #4: Make Formulas Wait for Preload

**What it does:**
- When preload is triggered, formulas should wait (not proceed immediately)
- Check preload status BEFORE queuing individual API calls
- Wait for preload completion before making API calls

**Data Integrity Impact:**
- ⚠️ **REQUIRES CAREFUL IMPLEMENTATION**
- Must ensure formulas don't return 0 while waiting
- Must ensure formulas don't wait indefinitely
- Must ensure timeout still allows API call fallback

**Critical Requirements:**
1. ✅ Formulas must return BUSY state while waiting (NOT 0)
2. ✅ Use bounded wait (e.g., 90s max)
3. ✅ After timeout, proceed with API call (not return 0)
4. ✅ Re-check cache after wait completes
5. ✅ If cache still miss after wait, make API call
6. ✅ Never return 0 for missing data

**Verification:**
```javascript
// CORRECT implementation:
if (preloadInProgress && !isPeriodCached) {
    // Return BUSY state (not 0, not fabricated value)
    throw new Error('BUSY');
    
    // OR wait with timeout:
    const waited = await waitForPreload(maxWaitMs);
    if (waited) {
        // Re-check cache
        const cached = checkLocalStorageCache(...);
        if (cached !== null) {
            return cached; // From NetSuite
        }
    }
    // If still miss, proceed with API call
    // Never return 0 here
}
```

**Potential Violations:**
- ❌ If formulas return 0 while waiting → **VIOLATES Rule 1**
- ❌ If formulas wait indefinitely → **VIOLATES Rule 4** (preload failure blocks formulas)
- ❌ If formulas don't re-check cache after wait → **VIOLATES Rule 4**

**Conclusion:** ⚠️ **SAFE IF IMPLEMENTED CORRECTLY - Requires strict adherence to wait logic**

---

### Fix #5: Improve Cache Clear

**What it does:**
- Clear in-memory cache synchronously
- Clear localStorage from both contexts
- Verify cache is actually cleared before proceeding

**Data Integrity Impact:**
- ✅ **SAFE** - Only affects cache clearing mechanism
- ✅ Does NOT change what values formulas return
- ✅ Does NOT fabricate values
- ✅ Still follows: Cache → API → Error flow

**Verification:**
- Ensures cache is actually cleared
- Formulas will get cache miss after clear
- Cache miss → API call → NetSuite value (correct)
- No phantom numbers possible

**Conclusion:** ✅ **SAFE - No data integrity violations**

---

## Summary: Data Integrity Compliance

| Fix | Data Integrity Impact | Status |
|-----|----------------------|--------|
| #1: Synchronize Cache Clear | No impact - only affects clearing mechanism | ✅ SAFE |
| #2: Trigger Preload Earlier | No impact - only affects timing | ✅ SAFE |
| #3: Ensure Taskpane Processes | No impact - only affects trigger processing | ✅ SAFE |
| #4: Make Formulas Wait | ⚠️ Requires careful implementation | ⚠️ SAFE IF DONE RIGHT |
| #5: Improve Cache Clear | No impact - only affects clearing mechanism | ✅ SAFE |

---

## Critical Implementation Requirements for Fix #4

To ensure Fix #4 doesn't violate data integrity rules:

### ✅ Required Implementation Pattern

```javascript
// CORRECT: Wait for preload with proper error handling
if (preloadInProgress && !isPeriodCached) {
    // Option 1: Return BUSY state immediately
    throw new Error('BUSY');
    
    // Option 2: Wait with bounded timeout
    const maxWait = 90000; // 90 seconds
    const waited = await waitForPreload(maxWait);
    
    if (waited) {
        // Preload completed - re-check cache
        const cached = checkLocalStorageCache(account, fromPeriod, toPeriod, subsidiary);
        if (cached !== null) {
            // Cache hit - return value from NetSuite
            return cached;
        }
    }
    
    // If still cache miss after wait, proceed with API call
    // NEVER return 0 here - proceed to API call or return BUSY
}
```

### ❌ Forbidden Patterns

```javascript
// WRONG: Return 0 while waiting
if (preloadInProgress) {
    return 0; // ❌ VIOLATES Rule 1 - Never return 0 for missing data
}

// WRONG: Wait indefinitely
if (preloadInProgress) {
    await waitForPreload(Infinity); // ❌ VIOLATES Rule 4 - Preload failure blocks formulas
}

// WRONG: Don't re-check cache after wait
if (preloadInProgress) {
    await waitForPreload();
    // Missing: Re-check cache
    return 0; // ❌ VIOLATES Rule 1 - Returns 0 without checking cache
}
```

---

## Final Verdict

**All fixes are SAFE from a data integrity perspective IF:**

1. ✅ Fix #4 implements bounded waits with timeout
2. ✅ Fix #4 returns BUSY state while waiting (not 0)
3. ✅ Fix #4 re-checks cache after wait completes
4. ✅ Fix #4 proceeds with API call if cache still miss after wait
5. ✅ All fixes maintain: Cache → API → Error flow
6. ✅ No values are ever fabricated
7. ✅ Zero vs missing is preserved

**The fixes do NOT violate any ChatGPT rules because:**
- They only affect timing and cache management
- They don't change what values formulas return
- They don't fabricate values
- They maintain the same NetSuite query logic
- They preserve zero vs missing distinction
- They maintain cache → API → Error flow

**Conclusion:** ✅ **All fixes are SAFE - No data integrity violations**

