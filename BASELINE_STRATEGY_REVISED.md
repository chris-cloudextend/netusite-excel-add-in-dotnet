# Revised Baseline Strategy - CPA Perspective & Batch Query Optimization

## CPA Analysis: Rolling Baseline

**From a CPA/NetSuite perspective:**

Balance Sheet accounts naturally work on a **rolling basis**:
- Each period's balance = Previous period's balance + Period activity
- This is how NetSuite calculates internally
- This is how accountants think: "What was last month's balance? What changed? What's the new balance?"

**However, the currency conversion constraint is critical:**

In OneWorld multi-currency:
- **Feb cumulative** = All transactions (Jan + Feb) converted at **Feb's exchange rate**
- **Jan cumulative** = All transactions (Jan only) converted at **Jan's exchange rate**
- **Feb period change** = Feb transactions only converted at **Feb's exchange rate**

**The Problem:**
```
Jan_cumulative_at_Jan_rate + Feb_change_at_Feb_rate ≠ Feb_cumulative_at_Feb_rate
```

**Why?** Because Jan transactions need to be converted at Feb's rate, not Jan's rate.

**The Solution:**
For rolling baseline to work correctly, we need:
```
Feb = Jan_cumulative_at_Feb_rate + Feb_change_at_Feb_rate
```

But `Jan_cumulative_at_Feb_rate` requires recalculating Jan at Feb's rate, which is a 77s query.

**CPA Recommendation:**
- **Use rolling baseline** (it's the natural accounting approach)
- **Accept baseline recalculation** at target rate (required for currency correctness)
- **Optimize with batch queries** (all accounts at once, not per-account)

---

## Revised Strategy: Rolling Baseline with Batch-Optimized Rate Recalculation

### Key Insight: Batch Query Performance

**Critical Finding**: A single query for ALL accounts takes ~77 seconds, same as a single account.
- This means: Calculating baseline for ALL accounts at a target rate = 77s total
- Not: 77s × number of accounts

### Strategy Overview

1. **Baseline Selection**: Use rolling baseline (previous month)
2. **Baseline Calculation**: Recalculate previous month at target rate (batch query for all accounts)
3. **Period Change**: Use period-only query (4s per period, batch for all accounts)
4. **Caching**: Cache baseline at target rate (batch result)

### Implementation Flow

#### Initial Precache (One-Time)

```
Step 1: Precache January (baseline period)
  - Query: All BS accounts, cumulative through Jan end, at Jan's rate
  - Time: 77s (batch query for ALL accounts)
  - Cache: Jan_cumulative_at_Jan_rate for all accounts

Step 2: Precache Period Changes (Feb-Dec)
  - Query: All BS accounts, period-only for each month, at that month's rate
  - Time: 11 periods × 4s = 44s (batch queries)
  - Cache: Period changes for all accounts, all months
```

**Total Initial Precache: 77s + 44s = 121 seconds**

#### Calculation for Any Month (e.g., March)

```
Step 1: Get February cumulative (baseline)
  - Check cache: Feb_cumulative_at_Mar_rate
  - If cached: Instant lookup
  - If not cached: 
    * Recalculate Feb at Mar's rate (batch query, 77s for ALL accounts)
    * Cache: Feb_cumulative_at_Mar_rate for all accounts

Step 2: Get March period change
  - Check cache: Mar_change_at_Mar_rate
  - If cached: Instant lookup (4s batch query already done)
  - If not cached: Query Mar period change (4s batch query)

Step 3: Calculate
  - Mar_cumulative = Feb_cumulative_at_Mar_rate + Mar_change_at_Mar_rate
  - Cache: Mar_cumulative_at_Mar_rate (for use as baseline for Apr)
```

### Performance Analysis

#### Scenario 1: User Drags Across 12 Months (Jan-Dec)

**Initial Precache** (one-time):
- Jan baseline: 77s (all accounts, at Jan rate)
- Feb-Dec period changes: 11 × 4s = 44s (all accounts, batch)
- **Total: 121 seconds**

**First Calculation of Each Month** (as user drags):
- Feb: 77s (recalc Jan at Feb rate, batch) + 4s (Feb change, cached) = 81s
- Mar: 77s (recalc Feb at Mar rate, batch) + 4s (Mar change, cached) = 81s
- Apr: 77s (recalc Mar at Apr rate, batch) + 4s (Apr change, cached) = 81s
- ... (continues for each month)

**Problem**: Still doing 77s recalculation for each month!

#### Optimization: Precache Baseline at All Target Rates

**Strategy**: During initial precache, calculate baseline (Jan) at ALL target rates (Feb-Dec)

**Initial Precache**:
- Jan at Jan rate: 77s
- Jan at Feb rate: 77s
- Jan at Mar rate: 77s
- ... (11 more rates)
- Period changes: 11 × 4s = 44s
- **Total: 12 × 77s + 44s = 968 seconds** (not acceptable per user)

#### Better Optimization: Smart Baseline Caching

**Strategy**: Cache baseline at target rate only when first needed, then reuse

**Initial Precache**:
- Jan at Jan rate: 77s (baseline)
- Period changes (Feb-Dec): 11 × 4s = 44s
- **Total: 121 seconds**

**First Calculation of Feb**:
- Recalc Jan at Feb rate: 77s (batch, all accounts)
- Cache: Jan_at_Feb_rate for all accounts
- Get Feb change: 4s (cached)
- **Total: 81 seconds**

**First Calculation of Mar**:
- Recalc Feb at Mar rate: 77s (batch, all accounts)
  - But: Feb = Jan_at_Feb_rate + Feb_change (already calculated)
  - So: Recalc Feb = Recalc (Jan_at_Feb_rate + Feb_change) at Mar rate
  - This still requires recalculating Jan at Mar rate (77s)
- Get Mar change: 4s (cached)
- **Total: 81 seconds**

**Problem**: Still recalculating baseline for each month!

---

## Revised Strategy: Period Change Summation with Rate Conversion

### Key Insight

Instead of using baseline + period change, **sum all period changes up to target month**, but convert each at the target rate.

### Strategy

1. **Precache**: Cache period changes for all months (Jan-Dec) at their own rates
2. **Calculation**: For month X, sum period changes (Jan through X), but recalculate each at X's rate
3. **Optimization**: Batch the rate conversion queries

### Implementation

#### Precache (One-Time)

```
Query 1: All BS accounts, Jan cumulative at Jan rate (77s)
  → Cache: Jan_cumulative_at_Jan_rate (baseline reference)

Query 2-12: All BS accounts, period changes for Feb-Dec (11 × 4s = 44s)
  → Cache: Period_change_at_own_rate for each month
```

**Total: 121 seconds**

#### Calculation for Month X (e.g., March)

```
Option A: Direct Cumulative Query
  - Query: All BS accounts, cumulative through Mar end, at Mar rate
  - Time: 77s (batch query)
  - Result: Mar cumulative at Mar rate

Option B: Sum Period Changes (if all cached)
  - Jan_change_at_Mar_rate: Recalc Jan period at Mar rate (77s batch)
  - Feb_change_at_Mar_rate: Recalc Feb period at Mar rate (77s batch)
  - Mar_change_at_Mar_rate: Use cached (already at Mar rate)
  - Sum: Jan + Feb + Mar = Mar cumulative
  - Time: 2 × 77s = 154s (WORSE than direct!)

Option C: Hybrid - Use Baseline + Remaining Changes
  - Jan_cumulative_at_Mar_rate: Recalc Jan at Mar rate (77s batch)
  - Feb_change_at_Mar_rate: Recalc Feb period at Mar rate (77s batch)
  - Mar_change_at_Mar_rate: Use cached
  - Sum: Jan + Feb + Mar = Mar cumulative
  - Time: 2 × 77s = 154s (WORSE!)
```

**Conclusion**: Rate conversion kills the time savings!

---

## Final Recommended Strategy: Accept Baseline Recalculation, Optimize with Batching

### Strategy

1. **Use rolling baseline** (natural accounting approach)
2. **Accept baseline recalculation** at target rate (required for currency correctness)
3. **Optimize with batch queries** (all accounts at once)
4. **Cache intelligently** (baseline at target rate, period changes)

### Implementation

#### Precache Strategy

```
Step 1: Precache baseline (Jan) at Jan rate
  - Query: All BS accounts, cumulative through Jan, at Jan rate
  - Time: 77s (batch query for ALL accounts)
  - Cache: Jan_cumulative_at_Jan_rate for all accounts

Step 2: Precache period changes (Feb-Dec)
  - Query: All BS accounts, period-only for each month
  - Time: 11 × 4s = 44s (batch queries)
  - Cache: Period_change_at_own_rate for all accounts, all months
```

**Total Precache: 121 seconds**

#### Calculation Strategy (Rolling Baseline)

```
For month X (e.g., March):

Step 1: Get previous month cumulative at X's rate
  - Previous month: Feb
  - Check cache: Feb_cumulative_at_Mar_rate
  - If cached: Use it (instant)
  - If not cached:
    * Calculate Feb cumulative at Mar rate
    * Method A: Direct query (77s batch)
    * Method B: Feb = Jan_at_Mar_rate + Feb_change_at_Mar_rate
      - Jan_at_Mar_rate: Recalc Jan at Mar rate (77s batch)
      - Feb_change_at_Mar_rate: Recalc Feb period at Mar rate (77s batch)
      - Total: 154s (WORSE than direct!)

Step 2: Get current month period change
  - Check cache: Mar_change_at_Mar_rate
  - If cached: Use it (instant)
  - If not: Query (4s batch)

Step 3: Calculate
  - Mar_cumulative = Feb_cumulative_at_Mar_rate + Mar_change_at_Mar_rate
  - Cache: Mar_cumulative_at_Mar_rate (for Apr baseline)
```

### Performance Analysis

#### Best Case: All Period Changes Cached

**First calculation of each month** (as user drags):
- Feb: 77s (Jan at Feb rate) + 4s (Feb change, cached) = 81s
- Mar: 77s (Feb at Mar rate) + 4s (Mar change, cached) = 81s
- Apr: 77s (Mar at Apr rate) + 4s (Apr change, cached) = 81s
- ... (continues)

**Total for 12 months**: 77s (Jan) + (11 × 81s) = **968 seconds**

**vs Current**: 12 × 77s = **924 seconds**

**Result: 5% SLOWER** (not better!)

#### Why This Happens

- Each month requires recalculating previous month at new rate (77s)
- Period change is fast (4s), but baseline recalculation dominates
- Rolling baseline doesn't help because we still need rate conversion

---

## Alternative Strategy: Fixed Baseline with Smart Caching

### Strategy

1. **Fixed baseline**: Always use Jan (earliest period)
2. **Calculate Jan at target rate on-demand** (batch query, 77s)
3. **Cache Jan at target rate** after first calculation
4. **Use period changes** (cached, 4s)

### Implementation

```
Precache:
  - Jan at Jan rate: 77s (baseline reference)
  - Period changes (Feb-Dec): 11 × 4s = 44s
  - Total: 121 seconds

Calculation for month X:
  - Check cache: Jan_at_X_rate
  - If cached: Use it (instant)
  - If not: Calculate Jan at X rate (77s batch, cache result)
  - Get X period change: 4s (cached)
  - Calculate: Jan_at_X_rate + X_change = X_cumulative
```

### Performance

**First calculation of each month**:
- Feb: 77s (Jan at Feb rate, first time) + 4s = 81s
- Mar: 77s (Jan at Mar rate, first time) + 4s = 81s
- Apr: 77s (Jan at Apr rate, first time) + 4s = 81s
- ... (continues)

**Total for 12 months**: 77s (Jan) + (11 × 81s) = **968 seconds**

**Same problem**: Still recalculating baseline for each month!

---

## Final Recommendation: Accept Limitations, Optimize What We Can

### The Reality

**Currency conversion requirement makes incremental calculation challenging:**
- Baseline must be at target rate (requires recalculation)
- Period changes are fast (4s), but baseline dominates (77s)
- Rolling vs fixed baseline doesn't help (both need rate conversion)

### Optimized Strategy

1. **Precache period changes** (fast, 4s each, batch for all accounts)
2. **Calculate cumulative on-demand** (77s, but only when needed)
3. **Use incremental ONLY when baseline is already at target rate** (cached)

### Implementation

```
Precache:
  - Period changes (Jan-Dec): 12 × 4s = 48s (all accounts, batch)
  - Note: Jan "period change" is actually Jan cumulative

Calculation for month X:
  - Check: Is X cumulative cached?
    * If yes: Use it (instant)
    * If no: Calculate cumulative (77s batch)
  - Alternative: If all period changes cached, sum them
    * But: Need to convert each at X's rate (multiple 77s queries = worse!)
```

### Performance

**Best case** (all period changes cached, but need cumulative):
- Calculate cumulative: 77s (batch, all accounts)
- **No time savings** (same as current)

**Alternative**: Cache cumulative for each month during precache
- Precache all 12 months cumulative: 12 × 77s = 924s
- Subsequent queries: Instant
- **But**: Initial cost is high (same as current total)

---

## Conclusion: Incremental May Not Provide Time Savings

### The Fundamental Issue

**Currency conversion requirement**:
- Each period's cumulative must use that period's exchange rate
- Baseline recalculation at target rate = 77s (same as direct cumulative)
- Period changes are fast (4s), but don't help if baseline needs recalculation

### What DOES Work

1. **Period change queries are 90% faster** (4s vs 77s) ✅
2. **Batch queries for all accounts** = same time as single account ✅
3. **Caching period changes** = instant lookups ✅

### What DOESN'T Work

1. **Incremental calculation with rate conversion** = no time savings ❌
2. **Rolling baseline** = still needs rate conversion ❌
3. **Fixed baseline** = still needs rate conversion ❌

### Recommendation

**Focus optimization on**:
1. **Batch precaching** of period changes (all accounts, all months)
2. **Direct cumulative queries** when needed (batch, 77s for all accounts)
3. **Smart caching** of cumulative results (instant subsequent lookups)

**Don't pursue incremental calculation** - the currency conversion requirement eliminates time savings.

---

## Alternative: Period Change Analysis Tool

**Use case**: Users want to see period changes (not cumulative)
- BALANCECHANGE("10010", "Feb 2025", "Feb 2025") = Feb period change
- This is 90% faster (4s vs 77s) ✅
- Useful for variance analysis, cash flow, etc.

**Keep this optimization, skip incremental cumulative calculation.**

