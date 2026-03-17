# Class Filter Cache Bug – Root Cause and Fix

## Summary

When using **Quick Start → Full Income Statement**, changing the **Class** (or Department/Location) filter to a new value (e.g. "CloudExtend") left some accounts showing **cached values from the first run** instead of refetching with the new filter. Accounts that had values with no class (e.g. 59999) continued to show those values after selecting Class = CloudExtend instead of the correct filtered values.

---

## Root Cause

**File:** `docs/functions.js`  
**Function:** `checkLocalStorageCache(account, period, toPeriod, subsidiary, filtersHash)`

The preload/localStorage cache is keyed by:

- `balance:${account}:${filtersHash}:${period}` (single period)
- `balance:${account}:${filtersHash}:${fromPeriod}::${toPeriod}` (range)

For “backward compatibility,” the code also tried a **no-filter** key when the requested key was missing:

- Single period: `balance:${account}::${lookupPeriod}`
- Range: `balance:${account}::${fromPeriod}::${toPeriod}`

That fallback was added **unconditionally**. So when the user added a segment filter (e.g. Class = CloudExtend):

1. `filtersHash` became something like `|||CloudExtend|1` (sub\|dept\|loc\|**class**\|book).
2. The code looked up `balance:59999:|||CloudExtend|1:Jan 2025` → **miss** (no preload with that filter yet).
3. It then tried the no-filter key `balance:59999::Jan 2025` → **hit** (from the first run with no class).
4. It returned that cached value, so the cell showed the **unfiltered** balance instead of the Class=CloudExtend balance.

So the bug was: **using the no-filter cache key even when the user had requested data with a segment filter (Class, Department, or Location)**. That made a filter change appear to have no effect for accounts that were already in the cache from a no-filter run.

---

## Fix (Applied in This Repo)

**Location:** `docs/functions.js`, inside `checkLocalStorageCache`, in the block that builds `keysToTry` for the preload cache (`xavi_balance_cache`).

1. **Define “no filter”:**  
   Treat the request as having no segment filters only when `filtersHash` is null or the empty hash:

   ```js
   const isNoFilterHash = !filtersHash || filtersHash === '||||1' || filtersHash === '||||';
   ```

   (Empty hash format is `sub|dept|loc|class|book`, e.g. `||||1` when all segments are empty and book is 1.)

2. **Use no-filter fallback only when there are no segment filters:**
   - **Single period:** Add `balance:${account}::${lookupPeriod}` to `keysToTry` only when `isNoFilterHash` is true.
   - **Range:** Add `balance:${account}::${fromPeriod}::${toPeriod}` only when `isNoFilterHash` is true.
   - **Partial (subsidiary-only):** Add the subsidiary-only key only when `isNoFilterHash` is true (so we don’t reuse “subsidiary-only” cache when the user has set Class/Dept/Loc).

With this change, when the user sets Class (or Department or Location), we no longer fall back to the no-filter or subsidiary-only key, so we don’t return stale data and the sheet refetches (or shows correct cached data when keyed by the full `filtersHash`).

---

## How to Apply the Same Fix in Your Build

1. **Open** `docs/functions.js` (or your project’s equivalent of the shared runtime/custom functions script that contains `checkLocalStorageCache`).

2. **Find** the function `checkLocalStorageCache`. Inside it, locate the block that:
   - Reads `xavi_balance_cache` from localStorage,
   - Builds an array of keys to try (e.g. `keysToTry`),
   - Pushes the **no-filter** key `balance:${account}::${lookupPeriod}` (single period),
   - And for range queries, the no-filter key `balance:${accountStr}::${normalizedPeriod}::${normalizedToPeriod}`.

3. **Before** building those keys:
   - Add:
     ```js
     const isNoFilterHash = !filtersHash || filtersHash === '||||1' || filtersHash === '||||';
     ```

4. **Guard the no-filter and partial keys:**
   - Only add the **single-period no-filter** key when `isNoFilterHash` is true.
   - Only add the **range no-filter** key when `isNoFilterHash` is true.
   - Only add the **subsidiary-only** key when `isNoFilterHash` is true (so segment filters like Class are not ignored).

5. **Keep** the key that uses the full `filtersHash` (e.g. `balance:${account}:${filtersHash}:${lookupPeriod}`) as-is; that one is correct and should be tried whenever `filtersHash` is present.

6. **Verify:**  
   Run Quick Start → Full Income Statement, then change Class to e.g. CloudExtend. Accounts that had values in the first run should now show values for the new filter (or refetch) instead of staying at the previous no-filter numbers.

---

## Related Details

- **Cache key format:** `filtersHash` is built by `getFilterKey(params)` as `sub|dept|loc|class|book` (e.g. `||||1` when all segments are empty and book is 1).
- **In-memory cache:** The in-memory balance cache uses `getCacheKey('balance', params)`, which already includes `class: params.classId || ''`, so it was not the source of this bug; the bug was only in the **localStorage** lookup logic in `checkLocalStorageCache`.
- **Impact:** Any change of Class, Department, or Location could have shown stale balances until this fix was applied.

---

## File and Line Reference (This Repo)

- **File:** `docs/functions.js`
- **Function:** `checkLocalStorageCache`
- **Change:** Introduction of `isNoFilterHash` and conditional use of no-filter and subsidiary-only keys (around the existing “Key format 1 / 2 / 3” and range key comments).
