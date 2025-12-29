# Final Baseline Strategy - Batch Query Optimization

## CPA Analysis: Rolling Baseline

**From a CPA/NetSuite perspective:**

Balance Sheet accounts naturally work on a **rolling basis**:
- Each period's balance = Previous period's balance + Period activity
- This is how NetSuite calculates internally
- This is how accountants think: "What was last month's balance? What changed? What's the new balance?"

**Currency Conversion Reality:**
- In OneWorld, each period's cumulative must use that period's exchange rate
- Rolling baseline requires: `Current = Previous_at_current_rate + Current_change_at_current_rate`
- Previous period must be recalculated at current rate (required for currency correctness)

**CPA Recommendation:**
- ✅ **Use rolling baseline** (natural accounting approach)
- ✅ **Accept baseline recalculation** at target rate (required for currency correctness)
- ✅ **Optimize with batch queries** (all accounts at once, 77s total)

---

## Key Insight: Batch Query Performance

**Critical Finding**: A single batch query for ALL Balance Sheet accounts takes ~77 seconds, same as a single account.

**Implications**:
- Precache baseline (Jan) for ALL accounts: 77s total (not 77s × number of accounts)
- Precache period changes (Feb-Dec) for ALL accounts: 11 × 4s = 44s total
- Recalculate baseline at target rate for ALL accounts: 77s total (not per-account)

---

## Recommended Strategy: Rolling Baseline with Batch-Optimized Recalculation

### Strategy Overview

1. **Baseline Selection**: Rolling baseline (previous month) - natural accounting approach
2. **Baseline Calculation**: Recalculate previous month at target rate (batch query for ALL accounts)
3. **Period Change**: Use cached period changes (precached for ALL accounts)
4. **Caching**: Cache cumulative at target rate (for use as next month's baseline)

### Implementation Flow

#### Phase 1: Initial Precache (One-Time, All Accounts)

```
Step 1: Precache January (baseline period)
  - Query: ALL BS accounts, cumulative through Jan end, at Jan's rate
  - Time: 77s (batch query for ALL accounts)
  - Cache: Jan_cumulative_at_Jan_rate for ALL accounts
  - Result: Baseline for all accounts ready

Step 2: Precache Period Changes (Feb-Dec)
  - Query: ALL BS accounts, period-only for each month, at that month's rate
  - Time: 11 periods × 4s = 44s (batch queries for ALL accounts)
  - Cache: Period_change_at_own_rate for ALL accounts, all months
  - Result: Period changes for all accounts, all months ready
```

**Total Initial Precache: 77s + 44s = 121 seconds** (for ALL accounts)

#### Phase 2: Calculation (As User Drags Across Months)

**For February (first calculation)**:
```
Step 1: Recalculate January at February's rate
  - Query: ALL BS accounts, Jan cumulative at Feb rate
  - Time: 77s (batch query for ALL accounts)
  - Cache: Jan_cumulative_at_Feb_rate for ALL accounts
  - Result: Baseline for all accounts at Feb rate

Step 2: Get February period change
  - Check cache: Feb_change_at_Feb_rate (precached)
  - Time: Instant (already cached)

Step 3: Calculate February cumulative
  - For each account: Feb = Jan_at_Feb_rate + Feb_change
  - Time: Instant (simple addition)
  - Cache: Feb_cumulative_at_Feb_rate for ALL accounts (for Mar baseline)
```

**Total for February: 77s** (baseline recalculation) + instant (period change) = **77 seconds**

**For March (first calculation)**:
```
Step 1: Recalculate February at March's rate
  - Query: ALL BS accounts, Feb cumulative at Mar rate
  - Time: 77s (batch query for ALL accounts)
  - Cache: Feb_cumulative_at_Mar_rate for ALL accounts
  - Result: Baseline for all accounts at Mar rate

Step 2: Get March period change
  - Check cache: Mar_change_at_Mar_rate (precached)
  - Time: Instant

Step 3: Calculate March cumulative
  - For each account: Mar = Feb_at_Mar_rate + Mar_change
  - Time: Instant
  - Cache: Mar_cumulative_at_Mar_rate for ALL accounts (for Apr baseline)
```

**Total for March: 77s** (baseline recalculation) + instant = **77 seconds**

**Pattern continues for each month...**

### Performance Analysis

#### Scenario: User Drags Across 12 Months (Jan-Dec)

**Initial Precache** (one-time):
- Jan baseline: 77s (all accounts)
- Period changes (Feb-Dec): 44s (all accounts)
- **Total: 121 seconds**

**First Calculation of Each Month** (as user drags):
- Feb: 77s (Jan at Feb rate, all accounts)
- Mar: 77s (Feb at Mar rate, all accounts)
- Apr: 77s (Mar at Apr rate, all accounts)
- ... (continues for each month)
- Dec: 77s (Nov at Dec rate, all accounts)

**Total for 12 months**: 77s (Jan) + (11 × 77s) = **924 seconds**

**vs Current Approach**: 12 × 77s = **924 seconds**

**Result: Same time, but with better structure for caching**

---

## Optimization: Smart Baseline Caching

### Strategy

Cache baseline at target rate when first calculated, then reuse for subsequent accounts.

**Key Insight**: When calculating Feb for ALL accounts:
- First account: 77s (recalculate Jan at Feb rate for ALL accounts)
- Subsequent accounts: Instant (use cached Jan_at_Feb_rate)

**But**: Since we're doing batch queries, we calculate ALL accounts at once, so this doesn't help.

**However**: If user queries individual accounts later (not during initial drag):
- Feb for account 10010: Check cache for Jan_at_Feb_rate → if cached, use it (instant)
- Feb for account 10020: Check cache for Jan_at_Feb_rate → if cached, use it (instant)

### Revised Performance

**Initial Precache**: 121 seconds (same)

**First Calculation of Each Month** (batch, all accounts):
- Feb: 77s (recalculate Jan at Feb rate, all accounts)
- Mar: 77s (recalculate Feb at Mar rate, all accounts)
- ... (continues)

**Subsequent Individual Queries** (after initial drag):
- Any account, any month: Instant (if baseline at that rate is cached)

**Total for 12 months (batch)**: 924 seconds (same as current)
**Subsequent queries**: Instant (90% faster)

---

## Alternative: Fixed Baseline with Batch Recalculation

### Strategy

1. **Fixed baseline**: Always use Jan (earliest period)
2. **Calculate Jan at target rate on-demand** (batch query, 77s for ALL accounts)
3. **Cache Jan at target rate** after first calculation
4. **Use period changes** (cached, instant)

### Implementation

```
Precache:
  - Jan at Jan rate: 77s (all accounts)
  - Period changes (Feb-Dec): 44s (all accounts)
  - Total: 121 seconds

Calculation for month X (batch, all accounts):
  - Check cache: Jan_at_X_rate
  - If cached: Use it (instant)
  - If not: Calculate Jan at X rate (77s batch, cache result)
  - Get X period change: Instant (cached)
  - Calculate: Jan_at_X_rate + X_change = X_cumulative
```

### Performance

**First calculation of each month**:
- Feb: 77s (Jan at Feb rate, first time, all accounts)
- Mar: 77s (Jan at Mar rate, first time, all accounts)
- Apr: 77s (Jan at Apr rate, first time, all accounts)
- ... (continues)

**Total for 12 months**: 77s (Jan) + (11 × 77s) = **924 seconds**

**Same as rolling baseline!**

---

## Key Finding: No Time Savings for Initial Calculation

### The Reality

**Both rolling and fixed baseline require**:
- Baseline recalculation at target rate: 77s (batch, all accounts)
- Period change: Instant (cached)
- **Total: 77s per month** (same as direct cumulative query)

**Time savings only come from**:
- ✅ Period change queries are 90% faster (4s vs 77s) - but only if used standalone
- ✅ Subsequent individual queries are instant (if baseline cached)
- ❌ Initial batch calculation: No time savings (77s either way)

---

## Final Recommendation: Hybrid Approach

### Strategy

1. **Precache period changes** (fast, useful for variance analysis)
2. **Calculate cumulative on-demand** (77s batch, same as current)
3. **Use incremental ONLY for subsequent individual queries** (after initial batch)

### Implementation

```
Precache:
  - Period changes (Jan-Dec): 12 × 4s = 48s (all accounts, batch)
  - Note: Jan "period change" is actually Jan cumulative

Calculation Strategy:
  - If calculating for ALL accounts (batch): Use direct cumulative (77s)
  - If calculating for individual account (after batch): Use incremental
    * Check: Is baseline at target rate cached?
    * If yes: Baseline (instant) + Period change (instant) = Cumulative
    * If no: Use direct cumulative query (77s for single account)
```

### Performance

**Initial Batch Calculation** (all accounts, all months):
- Direct cumulative: 12 × 77s = **924 seconds**
- **No time savings** (same as current)

**Subsequent Individual Queries** (single account, after batch):
- If baseline cached: Instant (baseline) + Instant (period change) = **Instant**
- If baseline not cached: 77s (direct cumulative)
- **Time savings: 99% faster** (instant vs 77s)

---

## Conclusion

### What Works

1. ✅ **Period change queries are 90% faster** (4s vs 77s) - useful for BALANCECHANGE
2. ✅ **Batch queries optimize precache** (77s for all accounts, not per-account)
3. ✅ **Incremental helps subsequent queries** (instant if baseline cached)

### What Doesn't Work

1. ❌ **Incremental doesn't save time for initial batch calculation** (still 77s per month)
2. ❌ **Rolling vs fixed baseline doesn't matter** (both need rate recalculation)
3. ❌ **Currency conversion requirement eliminates time savings** for initial calculation

### Final Recommendation

**Focus on**:
1. **Batch precaching** of period changes (all accounts, all months) - 48s total
2. **Direct cumulative queries** for initial batch calculation (77s per month, same as current)
3. **Smart caching** for subsequent individual queries (instant if baseline cached)

**Don't pursue incremental for initial batch** - the currency conversion requirement means no time savings.

**Keep BALANCECHANGE optimization** - period change queries are 90% faster and useful for variance analysis.

