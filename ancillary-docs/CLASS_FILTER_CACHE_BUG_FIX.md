# Class Filter Cache Bug – Engineer Fix Guide

## Problem

**Symptom:** In Quick Start → Full Income Statement, after changing **Class** (or Department or Location) to a new value (e.g. "CloudExtend"), some accounts keep showing **numbers from the first run** instead of values for the new filter. Cells that had data with no class selected continue to show those old values instead of refetching or showing filtered data.

**Example:** First run with no Class → account 59999 shows $X. User changes Class to CloudExtend → 59999 still shows $X instead of the CloudExtend-filtered balance (or #BUSY while refetching).

---

## Root Cause

**File:** `docs/functions.js`  
**Function:** `checkLocalStorageCache(account, period, toPeriod, subsidiary, filtersHash)`

Balance lookups use two localStorage caches. Both were returning unfiltered data when a segment filter was applied.

### 1. Preload cache (`xavi_balance_cache`)

- **Keys:** `balance:${account}:${filtersHash}:${period}` (single) or `balance:${account}:${filtersHash}:${fromPeriod}::${toPeriod}` (range).
- **Bug:** For backward compatibility, the code also tried a **no-filter** key when the exact key missed: `balance:${account}::${lookupPeriod}` (and the range equivalent). That fallback was used **even when the user had a segment filter**.
- **What happened:** Request with Class=CloudExtend → lookup `balance:59999:|||CloudExtend|1:Jan 2025` → miss → then try `balance:59999::Jan 2025` → **hit** (from first run with no class) → wrong value returned.

So the bug was: **no-filter fallback was used even when Class/Department/Location was in the request.**

### 2. Legacy cache (`netsuite_balance_cache`)

- **Keys:** Account + period only. Format is effectively `balances[account][period]`. **No segment dimensions** (no Class, Department, Location).
- **Bug:** After the preload cache, the code always fell through to this legacy cache. So even after fixing (1), a request with Class=CloudExtend could still hit the legacy cache and get the unfiltered balance.

So the bug was: **legacy cache was used for requests that had a segment filter**, even though that cache is not filter-aware.

---

## Fix (Two Parts)

Both changes are in `checkLocalStorageCache` in `docs/functions.js`.

### Part 1: Preload cache – only use no-filter fallback when there is no segment filter

**Where:** In the block that builds `keysToTry` for the preload cache (reading `xavi_balance_cache`).

1. **Define “no filter”** once, before building keys:

   ```js
   const isNoFilterHash = !filtersHash || filtersHash === '||||1' || filtersHash === '||||';
   ```

   (`filtersHash` format is `sub|dept|loc|class|book`; `||||1` = all segments empty, book 1.)

2. **Guard every no-filter and partial fallback** so they are only added when there is no segment filter:
   - **Single period:** Add `balance:${account}::${lookupPeriod}` to `keysToTry` **only if** `isNoFilterHash`.
   - **Range:** Add `balance:${account}::${fromPeriod}::${toPeriod}` **only if** `isNoFilterHash`.
   - **Subsidiary-only key:** Add the subsidiary-only variant **only if** `isNoFilterHash`.

3. **Leave unchanged:** The key that uses the full `filtersHash`, e.g. `balance:${account}:${filtersHash}:${lookupPeriod}` — always try that when `filtersHash` is present.

Result: When the user sets Class (or Department or Location), we no longer fall back to no-filter or subsidiary-only keys, so we don’t return stale preload data.

### Part 2: Legacy cache – skip when any segment filter is present

**Where:** Immediately before the block that reads the legacy cache (`STORAGE_TIMESTAMP_KEY` and `STORAGE_KEY` / `netsuite_balance_cache`).

Add:

```js
const hasSegmentFilter = filtersHash && filtersHash !== '||||1' && filtersHash !== '||||';
if (hasSegmentFilter) {
    return null; // Skip legacy cache when Class/Dept/Loc/Subsidiary filter is applied
}
```

Result: When the user has a segment filter, we never read the legacy cache, so we don’t return unfiltered legacy data. The caller will refetch or use another cache key.

---

## How to Apply in Your Build

1. Open the file that contains `checkLocalStorageCache` (in this repo: `docs/functions.js`).

2. **Preload cache (Part 1):**
   - Find where `xavi_balance_cache` is read and `keysToTry` is built.
   - Add `isNoFilterHash` as above before building keys.
   - Wrap the **no-filter** and **subsidiary-only** key pushes in `if (isNoFilterHash) { ... }` (for both single-period and range paths).
   - Do **not** remove or change the key that includes the full `filtersHash`.

3. **Legacy cache (Part 2):**
   - Find the comment/block for “CHECK LEGACY CACHE” / `netsuite_balance_cache` / `STORAGE_KEY`.
   - Right before that block, add the `hasSegmentFilter` check and `return null` as above.

4. **Verify:**  
   Quick Start → Full Income Statement → run once (no Class). Then set Class to e.g. CloudExtend. Previously populated accounts should update to the new filter (or show #BUSY then correct values), not stay at the first-run numbers.

---

## Reference

| Item | Location |
|------|----------|
| File | `docs/functions.js` |
| Function | `checkLocalStorageCache(account, period, toPeriod, subsidiary, filtersHash)` |
| Part 1 | Preload block: `isNoFilterHash` and conditional no-filter/subsidiary-only keys in `keysToTry` |
| Part 2 | Before legacy block: `hasSegmentFilter` check and `return null` |

**Cache key format:** `filtersHash` = `sub|dept|loc|class|book` (from `getFilterKey(params)`). Empty segments + default book → `||||1` or `||||`.

**In-memory cache:** The in-memory balance cache already keys by segment (e.g. `getCacheKey('balance', params)` with `class` etc.); the bug was only in the **localStorage** logic in `checkLocalStorageCache`.

**Impact:** Without both parts of the fix, any change to Class, Department, or Location could show stale balances for accounts that had been cached from a previous run.
