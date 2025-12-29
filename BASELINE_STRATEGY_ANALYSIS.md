# Baseline Strategy Analysis for Incremental Balance Sheet Calculation

## Problem Statement

When using incremental calculation (baseline + period change), we need to decide:
- **Which period should be the baseline?**
- **Should baseline change as we progress through months?**
- **How do we handle refresh scenarios?**

## Current Test Results

- **January cumulative query**: ~77 seconds (scans all history)
- **February period-only query**: ~4 seconds (scans only Feb transactions)
- **Time savings**: 90% faster per period
- **Financial correctness**: ✅ Verified (Jan + Feb_change = Feb cumulative)

## Baseline Strategy Options

### Option 1: Fixed Baseline (Earliest Period)

**Approach**: Always use the earliest period in the report as baseline.

**Example**: Jan 2025 baseline for all months
```
Feb = Jan_cached + BALANCECHANGE("10010", "Feb 2025", "Feb 2025")  // 4s
Mar = Jan_cached + BALANCECHANGE("10010", "Mar 2025", "Mar 2025")  // 4s
Apr = Jan_cached + BALANCECHANGE("10010", "Apr 2025", "Apr 2025")  // 4s
...
Dec = Jan_cached + BALANCECHANGE("10010", "Dec 2025", "Dec 2025")  // 4s
```

**Pros**:
- ✅ Simple implementation
- ✅ Jan baseline cached once, reused for all months
- ✅ No dependency chain (each month independent)
- ✅ Easy to invalidate (clear Jan cache = recalc all)

**Cons**:
- ⚠️ Each month still references Jan baseline (but it's cached, so fast)
- ⚠️ If user refreshes mid-year (e.g., July), need to decide: use Jan or July as baseline?
- ⚠️ Currency conversion: All period changes use target period's rate, but baseline uses Jan's rate
  - **CRITICAL**: This is mathematically correct IF baseline is recalculated at target rate
  - But if baseline is cached at Jan's rate, we'd need to recalculate it at each target rate

**Performance**:
- First month (Jan): 77s (cumulative query)
- Subsequent months: 4s each (period-only query)
- Total for 12 months: 77s + (11 × 4s) = **121 seconds**
- vs Current: 12 × 77s = **924 seconds**
- **Savings: 87% faster**

**Currency Conversion Issue**:
- Baseline (Jan) must be calculated at **target period's rate** (not Jan's rate)
- Example: Feb calculation needs Jan balance at **Feb's exchange rate**
- This means we can't just cache Jan at Jan's rate - we'd need to recalculate it at each target rate
- **OR**: Cache Jan at multiple rates (complex)

---

### Option 2: Rolling Baseline (Previous Month)

**Approach**: Each month uses the previous month as baseline.

**Example**: Rolling baseline chain
```
Feb = Jan_cached + BALANCECHANGE("10010", "Feb 2025", "Feb 2025")  // 4s
Mar = Feb_calculated + BALANCECHANGE("10010", "Mar 2025", "Mar 2025")  // 4s
Apr = Mar_calculated + BALANCECHANGE("10010", "Apr 2025", "Apr 2025")  // 4s
...
Dec = Nov_calculated + BALANCECHANGE("10010", "Dec 2025", "Dec 2025")  // 4s
```

**Pros**:
- ✅ Each month builds on previous (natural progression)
- ✅ No need to recalculate baseline at different rates
- ✅ Currency conversion: Each period change uses its own rate, previous month already calculated
- ✅ Mathematically simpler (no rate conversion needed)

**Cons**:
- ⚠️ Dependency chain: Must calculate months in order
- ⚠️ If user refreshes July, need to recalculate Feb-Jun first (or use Jan as baseline for July)
- ⚠️ Error propagation: If one month is wrong, all subsequent months are wrong
- ⚠️ Parallel calculation: Can't calculate Dec until Nov is done

**Performance**:
- First month (Jan): 77s (cumulative query)
- Subsequent months: 4s each, but must be sequential
- Total for 12 months: 77s + (11 × 4s) = **121 seconds** (same as Option 1)
- **But**: Sequential dependency means can't parallelize

**Currency Conversion**:
- ✅ Each month uses its own rate naturally
- ✅ No need to recalculate baseline at different rates
- ✅ Mathematically correct: Previous month already at correct rate

---

### Option 3: Quarterly Baselines

**Approach**: Use quarter-start months as baselines.

**Example**: Quarterly baselines
```
Q1: Jan baseline
  Feb = Jan + Feb_change  // 4s
  Mar = Jan + Mar_change  // 4s

Q2: Apr baseline (calculated from Jan + Q1 changes, or fresh cumulative)
  May = Apr + May_change  // 4s
  Jun = Apr + Jun_change  // 4s

Q3: Jul baseline
  Aug = Jul + Aug_change  // 4s
  Sep = Jul + Sep_change  // 4s

Q4: Oct baseline
  Nov = Oct + Nov_change  // 4s
  Dec = Oct + Dec_change  // 4s
```

**Pros**:
- ✅ Reduces baseline queries (4 instead of 1 or 12)
- ✅ Shorter dependency chains (3 months max)
- ✅ Can parallelize quarters

**Cons**:
- ⚠️ More complex logic (detect quarter boundaries)
- ⚠️ Still need to handle currency conversion for baselines
- ⚠️ User might not think in quarters

**Performance**:
- Baselines: 4 × 77s = 308s (if calculated fresh)
- Period changes: 12 × 4s = 48s
- Total: **356 seconds** (if baselines calculated fresh)
- **OR**: Calculate Q1 baseline, then incremental for Q2-Q4: 77s + 48s = **125 seconds**

---

### Option 4: Smart Baseline Selection (Dynamic)

**Approach**: Always use the earliest **cached** period as baseline.

**Example**: Dynamic baseline selection
```
User has Jan, Feb, Mar cached:
  Apr = Mar + Apr_change  // Use Mar (most recent cached) as baseline

User refreshes July (clears cache):
  July = Jan + (Jan_to_July_change)  // Use Jan (earliest cached) as baseline
  Aug = July + Aug_change  // Use July (most recent) as baseline
```

**Pros**:
- ✅ Adapts to user behavior
- ✅ Maximizes cache usage
- ✅ Handles refresh scenarios gracefully

**Cons**:
- ⚠️ Complex logic (find earliest cached period)
- ⚠️ May switch baselines mid-calculation
- ⚠️ Currency conversion complexity (baseline at different rates)

**Performance**:
- Varies based on cache state
- Best case: Similar to rolling baseline
- Worst case: Similar to fixed baseline

---

### Option 5: Hybrid - Cache Both Cumulative and Period Changes

**Approach**: Cache both cumulative balances AND period changes.

**Example**: Dual caching strategy
```
Precache Jan: Cache cumulative (77s)
Precache Feb: 
  - Option A: Cache cumulative (77s) OR
  - Option B: Cache period change (4s) + calculate cumulative from Jan

When querying:
  - If cumulative cached: Use directly
  - If period change cached: Calculate from baseline
  - If neither: Make API call
```

**Pros**:
- ✅ Maximum flexibility
- ✅ Can use fastest available method
- ✅ Handles all scenarios

**Cons**:
- ⚠️ More cache storage
- ⚠️ More complex cache management
- ⚠️ Need to track what's cached (cumulative vs change)

**Performance**:
- Best of all worlds
- Can optimize based on what's available

---

## Currency Conversion Analysis

### Critical Constraint: OneWorld Multi-Currency

**Requirement**: All transactions must use the **target period's exchange rate** for Balance Sheet to balance correctly.

**Current Test Results**:
- ✅ Period change query uses target period's rate (Feb rate for Feb change)
- ✅ Mathematically correct: Jan (at Feb rate) + Feb_change (at Feb rate) = Feb cumulative (at Feb rate)

**But**: If we cache Jan at Jan's rate, we can't use it directly for Feb calculation.

### Solution Options for Currency Conversion

#### A. Recalculate Baseline at Target Rate (On-Demand)

**Approach**: When calculating Feb, recalculate Jan at Feb's rate.

```
Feb calculation:
  1. Get Jan cumulative at Feb's rate (77s query, but uses Feb rate)
  2. Get Feb period change at Feb's rate (4s query)
  3. Sum: Jan_at_Feb_rate + Feb_change = Feb cumulative
```

**Pros**:
- ✅ Mathematically correct
- ✅ No cache complexity

**Cons**:
- ❌ **Defeats the purpose**: Still doing 77s query for baseline
- ❌ No time savings for baseline

#### B. Cache Baseline at Multiple Rates

**Approach**: Cache Jan at all possible target rates.

```
Cache structure:
  Jan_at_Jan_rate: $2,064,705.84
  Jan_at_Feb_rate: $2,064,705.84 (if rate same) or different
  Jan_at_Mar_rate: ...
```

**Pros**:
- ✅ Fast lookup once cached

**Cons**:
- ❌ Complex cache management
- ❌ Large cache storage (12 rates × accounts)
- ❌ Need to pre-calculate all rates

#### C. Use Rolling Baseline (Avoids Rate Issue)

**Approach**: Each month uses previous month, which is already at correct rate.

```
Feb = Jan_at_Jan_rate + Feb_change_at_Feb_rate
  But: This is WRONG! Jan needs to be at Feb rate.

Better:
  Feb = Jan_cumulative_at_Feb_rate + Feb_change_at_Feb_rate
  But: How do we get Jan_at_Feb_rate without recalculating?
```

**Actually**: If we use rolling baseline, we calculate:
- Feb = Jan + Feb_change
- But Jan was calculated at Jan's rate, Feb_change at Feb's rate
- **This is mathematically incorrect for multi-currency!**

**Solution**: For rolling baseline to work, we need:
- Feb = (Jan_at_Feb_rate) + Feb_change_at_Feb_rate
- But Jan_at_Feb_rate requires recalculating Jan at Feb's rate

---

## Recommended Approach: Fixed Baseline with Rate-Aware Caching

### Strategy

1. **Baseline Selection**: Always use earliest period in report (e.g., Jan 2025)

2. **Baseline Calculation**: When calculating any month, recalculate baseline at **target period's rate**
   ```
   Feb calculation:
     - Baseline: Jan cumulative at Feb's rate (77s, but only once per target period)
     - Change: Feb period change at Feb's rate (4s)
     - Result: Baseline + Change
   ```

3. **Caching Strategy**:
   - Cache baseline at **target period's rate** (not baseline period's rate)
   - Cache key: `baseline:Jan_2025:at_rate:Feb_2025`
   - This allows reuse: If calculating Mar, can use Jan_at_Mar_rate (if cached)

4. **Optimization**: 
   - First calculation of month: 77s (baseline) + 4s (change) = 81s
   - Subsequent calculations: 4s (change only, baseline already cached at that rate)

### Performance Analysis

**Scenario: 12 months, Jan baseline**

**First calculation (no cache)**:
- Jan: 77s (cumulative)
- Feb: 77s (Jan at Feb rate) + 4s (Feb change) = 81s
- Mar: 77s (Jan at Mar rate) + 4s (Mar change) = 81s
- Total: 77 + (11 × 81) = **968 seconds** (worse than current!)

**With smart caching**:
- Jan: 77s (cache Jan_at_Jan_rate)
- Feb: 77s (Jan at Feb rate) + 4s = 81s (cache Jan_at_Feb_rate)
- Mar: 4s (use cached Jan_at_Mar_rate if available, else 77s)
- **Problem**: Still need to calculate Jan at each rate

**Better approach**: Cache period changes, calculate cumulative on-demand
- Jan: 77s (cache cumulative)
- Feb: 4s (cache period change), calculate: Jan_cumulative + Feb_change
- Mar: 4s (cache period change), calculate: Jan_cumulative + Mar_change
- **But**: Jan_cumulative is at Jan's rate, Mar_change is at Mar's rate - **WRONG!**

---

## The Currency Conversion Dilemma

**The fundamental issue**: 
- Cumulative balance at period X must use period X's exchange rate
- If we cache Jan at Jan's rate, we can't use it for Feb (needs Feb's rate)
- If we recalculate Jan at Feb's rate, we lose the time savings

**Possible Solutions**:

### Solution 1: Accept Rate Recalculation (Hybrid Approach)

**Strategy**: 
- For first few months, use incremental (accept baseline recalculation)
- After threshold (e.g., 3 months), switch to direct cumulative queries
- Rationale: After 3 months, cumulative query time might be similar to baseline recalculation

**Performance**:
- Months 1-3: Incremental (81s each)
- Months 4-12: Direct cumulative (77s each)
- Total: (3 × 81) + (9 × 77) = **900 seconds**
- vs Current: 12 × 77 = **924 seconds**
- **Savings: 3%** (minimal)

### Solution 2: Use Period Changes Only (No Baseline)

**Strategy**: 
- Don't use baseline at all
- Just cache period changes
- Calculate cumulative on-demand by summing all period changes up to target

**Performance**:
- Period changes: 12 × 4s = 48s (all cached)
- Cumulative calculation: Sum cached changes (instant)
- **Total: 48 seconds** (best case)

**But**: 
- Need to ensure all period changes are cached
- What if user queries Dec before Jan-Feb-Nov are cached?
- Need fallback to cumulative query

### Solution 3: Smart Hybrid (Recommended)

**Strategy**:
1. **Precache**: Cache all period changes (12 × 4s = 48s total)
2. **Calculation**: 
   - If all period changes cached: Sum them (instant)
   - If some missing: Use cumulative query for missing periods
   - If baseline period cached: Use incremental for subsequent periods

**Performance**:
- Precache all periods: 48s (period changes) + 77s (baseline) = **125 seconds**
- Subsequent queries: Instant (from cache)
- **Savings: 85% faster** (125s vs 924s)

**Implementation**:
- Modify precache to cache period changes (not just cumulative)
- BALANCE function checks: Are all period changes cached? If yes, sum them
- If no, fall back to cumulative query

---

## Recommendation: Period Change Summation Strategy

### Approach

1. **Precache Strategy**: Cache period changes for all months
   ```
   Precache Jan-Dec 2025:
     - Jan: Cumulative query (77s) → Cache as baseline
     - Feb-Dec: Period change queries (11 × 4s = 44s) → Cache as changes
     - Total: 77s + 44s = 121 seconds
   ```

2. **Calculation Strategy**: 
   ```
   For any month (e.g., Mar 2025):
     - If all period changes cached (Jan, Feb, Mar): Sum them (instant)
     - If some missing: Use cumulative query (77s fallback)
   ```

3. **Baseline Management**:
   - Baseline (Jan) cached once as cumulative
   - Subsequent months cached as period changes
   - Calculation: Sum of all period changes up to target month

### Performance

**Precache (one-time)**:
- Jan cumulative: 77s
- Feb-Dec period changes: 11 × 4s = 44s
- **Total: 121 seconds**

**Subsequent Queries**:
- Any month: Instant (sum cached period changes)
- **Savings: 99% faster** (instant vs 77s)

**Refresh Scenario**:
- User refreshes July: Clear cache, recalculate Jan-Jul
- Jan: 77s (cumulative)
- Feb-Jul: 6 × 4s = 24s (period changes)
- **Total: 101 seconds**

### Currency Conversion

**Solution**: Each period change uses its own period's rate (already implemented)
- Jan change: At Jan's rate
- Feb change: At Feb's rate
- Mar change: At Mar's rate

**But**: Summing them gives cumulative at... which rate?

**Answer**: We need to recalculate each period change at the **target period's rate** when summing.

**Example**: Calculate Mar cumulative
- Sum: Jan_change_at_Mar_rate + Feb_change_at_Mar_rate + Mar_change_at_Mar_rate
- But: We cached Jan_change_at_Jan_rate, Feb_change_at_Feb_rate, Mar_change_at_Mar_rate

**Solution**: Cache period changes at **target period's rate** during precache
- When precaching for "Mar 2025", cache:
  - Jan_change_at_Mar_rate
  - Feb_change_at_Mar_rate  
  - Mar_change_at_Mar_rate
- Then Mar cumulative = sum of these (all at Mar's rate)

**But**: This means we need to precache for each target period separately, which defeats the purpose.

---

## Final Recommendation: Fixed Baseline with On-Demand Rate Conversion

### Strategy

1. **Baseline**: Always use earliest period (Jan 2025)

2. **Calculation**: 
   ```
   For month X:
     - Get baseline (Jan) at X's rate (cached or calculated)
     - Get period change for X (4s, cached)
     - Sum: Baseline_at_X_rate + Change_at_X_rate
   ```

3. **Caching**:
   - Cache baseline at multiple rates (on-demand)
   - Cache period changes at their own rates
   - When calculating month X, check if baseline_at_X_rate is cached
   - If not, calculate it (77s) and cache it
   - If yes, use cached (instant)

4. **Optimization**:
   - Precache baseline at all target rates during initial precache
   - This is a one-time cost: 12 × 77s = 924s (same as current)
   - But then all subsequent calculations are instant (4s period change)

### Performance

**Initial Precache**:
- Baseline at all rates: 12 × 77s = 924s (one-time)
- Period changes: 11 × 4s = 44s
- **Total: 968 seconds** (same as current, but one-time)

**Subsequent Queries**:
- Any month: 4s (period change only, baseline already cached at that rate)
- **Savings: 95% faster** (4s vs 77s)

**Refresh Scenario**:
- User refreshes July: Recalculate baseline at Jul-Dec rates (6 × 77s = 462s)
- Recalculate period changes for Jul-Dec (6 × 4s = 24s)
- **Total: 486 seconds**

---

## Questions for User

1. **Baseline Strategy**: Fixed (earliest) vs Rolling (previous month) vs Quarterly?
2. **Currency Handling**: Accept baseline recalculation at target rates, or use different strategy?
3. **Precache Scope**: Precache baseline at all target rates (one-time cost), or calculate on-demand?
4. **Refresh Behavior**: When user refreshes mid-year, recalculate from baseline or use rolling?

