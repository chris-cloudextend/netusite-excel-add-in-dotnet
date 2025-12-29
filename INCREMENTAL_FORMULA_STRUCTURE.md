# Incremental Formula Structure: Jan 2025 Baseline → April 2025

## Formula Structure

### Concept

If Jan 2025 is the baseline and we want April 2025 cumulative:

```
April 2025 = January 2025 (baseline) + February change + March change + April change
```

### Excel Formula Options

#### Option 1: Manual Sum (Current Functions)

```excel
=XAVI.BALANCE("10010",, "Jan 2025")
 + XAVI.BALANCECHANGE("10010", "Feb 2025", "Feb 2025")
 + XAVI.BALANCECHANGE("10010", "Mar 2025", "Mar 2025")
 + XAVI.BALANCECHANGE("10010", "Apr 2025", "Apr 2025")
```

**What this does**:
- Jan cumulative: 77s (first time, then cached at Jan rate)
- Feb period change: 4s (period-only query, at Feb rate)
- Mar period change: 4s (period-only query, at Mar rate)
- Apr period change: 4s (period-only query, at Apr rate)
- Sum: All four values

**Problem**: Currency rates don't match!
- Jan is at Jan's rate
- Feb change is at Feb's rate
- Mar change is at Mar's rate
- Apr change is at Apr's rate
- **Sum ≠ April cumulative** (incorrect due to rate mismatch)

---

#### Option 2: All at Target Rate (Corrected)

To get the correct April cumulative, everything must be at **April's exchange rate**:

```excel
=XAVI.BALANCE("10010", "Jan 2025", "Jan 2025", "", "", "", "", "", "Apr 2025")
 + XAVI.BALANCECHANGE("10010", "Feb 2025", "Feb 2025", "", "", "", "", "", "Apr 2025")
 + XAVI.BALANCECHANGE("10010", "Mar 2025", "Mar 2025", "", "", "", "", "", "Apr 2025")
 + XAVI.BALANCECHANGE("10010", "Apr 2025", "Apr 2025", "", "", "", "", "", "Apr 2025")
```

**Note**: This assumes BALANCE and BALANCECHANGE accept a "target_rate_period" parameter to convert at a specific rate.

**What this does**:
- Jan cumulative at **April's rate**: 77s (recalculate Jan at Apr rate)
- Feb change at **April's rate**: 77s (recalculate Feb period at Apr rate)
- Mar change at **April's rate**: 77s (recalculate Mar period at Apr rate)
- Apr change at **April's rate**: 4s (period-only, already at Apr rate)
- Sum: All at April's rate = Correct April cumulative
- **Total time: 77s + 77s + 77s + 4s = 235 seconds** (WORSE than direct 77s!)

---

#### Option 3: New Function - BALANCEINCREMENTAL (Proposed)

A new function that handles the incremental calculation internally:

```excel
=XAVI.BALANCEINCREMENTAL("10010", "Jan 2025", "Apr 2025")
```

**Parameters**:
1. Account number
2. Baseline period (Jan 2025)
3. Target period (Apr 2025)

**What it does internally**:
1. Check if baseline (Jan) is cached at target rate (Apr rate)
2. If not, calculate Jan at Apr rate (77s, cache result)
3. Get period changes (Feb, Mar, Apr)
4. For each period change:
   - Check if cached at target rate (Apr rate)
   - If not, recalculate at Apr rate (77s each, cache result)
5. Sum: Jan_at_Apr_rate + Feb_change_at_Apr_rate + Mar_change_at_Apr_rate + Apr_change_at_Apr_rate
6. Return: April cumulative

**Performance**:
- First calculation: 77s (Jan at Apr) + 3 × 77s (period changes at Apr) = **308 seconds** (WORSE!)
- Subsequent: Instant (if all cached at Apr rate)

---

#### Option 4: Rolling Baseline (Previous Month)

If using rolling baseline approach:

```excel
=XAVI.BALANCE("10010",, "Jan 2025")
 + XAVI.BALANCECHANGE("10010", "Feb 2025", "Feb 2025")
 + XAVI.BALANCECHANGE("10010", "Mar 2025", "Mar 2025")
 + XAVI.BALANCECHANGE("10010", "Apr 2025", "Apr 2025")
```

**But internally, it would calculate**:
- Feb = Jan + Feb_change (recalc Jan at Feb rate: 77s)
- Mar = Feb + Mar_change (recalc Feb at Mar rate: 77s)
- Apr = Mar + Apr_change (recalc Mar at Apr rate: 77s)

**Total: 77s + 77s + 77s + 4s = 235 seconds** (WORSE!)

---

## The Real Formula (If We Solve Currency Issue)

### Ideal Implementation

If we precache baseline at all target rates during initial precache:

```excel
=XAVI.BALANCE("10010", "Jan 2025", "Jan 2025", "", "", "", "", "", "Apr 2025")
 + XAVI.BALANCECHANGE("10010", "Feb 2025", "Feb 2025")
 + XAVI.BALANCECHANGE("10010", "Mar 2025", "Mar 2025")
 + XAVI.BALANCECHANGE("10010", "Apr 2025", "Apr 2025")
```

**If all cached at Apr rate**:
- Jan at Apr rate: **Instant** (cached)
- Feb change at Apr rate: **Instant** (cached)
- Mar change at Apr rate: **Instant** (cached)
- Apr change at Apr rate: **Instant** (cached)
- **Total: Instant!**

**But initial precache cost**: 12 × 77s = 924 seconds (not acceptable)

---

## Practical Formula (Current Implementation)

### What Actually Works Now

**Direct cumulative query** (current approach):
```excel
=XAVI.BALANCE("10010",, "Apr 2025")
```

**Time: 77 seconds** (batch query for all accounts)

**Period change query** (new optimization):
```excel
=XAVI.BALANCECHANGE("10010", "Apr 2025", "Apr 2025")
```

**Time: 4 seconds** (period-only query, 90% faster)

**Use case**: Variance analysis, cash flow, period activity

---

## Summary

**For April 2025 cumulative from Jan 2025 baseline**:

**Current best approach**:
```excel
=XAVI.BALANCE("10010",, "Apr 2025")
```
- Time: 77s
- Simple, correct, no currency issues

**If incremental worked** (doesn't due to currency):
```excel
=XAVI.BALANCE("10010",, "Jan 2025")
 + XAVI.BALANCECHANGE("10010", "Feb 2025", "Feb 2025")
 + XAVI.BALANCECHANGE("10010", "Mar 2025", "Mar 2025")
 + XAVI.BALANCECHANGE("10010", "Apr 2025", "Apr 2025")
```
- Time: 77s + 4s + 4s + 4s = 89s (first time)
- **But**: Currency rates don't match, result is incorrect!

**Corrected incremental** (everything at Apr rate):
- Time: 235s (worse than direct!)
- Correct, but slower

**Conclusion**: Direct cumulative query is best for cumulative balances. Use BALANCECHANGE for period activity analysis.

