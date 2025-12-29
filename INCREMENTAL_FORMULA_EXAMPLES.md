# Incremental Calculation Formula Examples

## Scenario: Jan 2025 Baseline → April 2025 Cumulative

### Current Approach (Direct Cumulative)

```excel
=XAVI.BALANCE("10010",, "Apr 2025")
```

**What it does**:
- Queries all transactions from inception through April 2025 end
- Converts all transactions at April 2025's exchange rate
- Returns: April 2025 cumulative balance
- **Time: ~77 seconds**

---

### Incremental Approach (Baseline + Period Changes)

#### Option 1: Manual Formula (User Calculates)

```excel
=XAVI.BALANCE("10010",, "Jan 2025") 
 + XAVI.BALANCECHANGE("10010", "Feb 2025", "Feb 2025")
 + XAVI.BALANCECHANGE("10010", "Mar 2025", "Mar 2025")
 + XAVI.BALANCECHANGE("10010", "Apr 2025", "Apr 2025")
```

**What it does**:
- Jan cumulative (baseline): ~77s (first time, then cached)
- Feb period change: ~4s (period-only query)
- Mar period change: ~4s (period-only query)
- Apr period change: ~4s (period-only query)
- Sum: Jan + Feb_change + Mar_change + Apr_change
- **Total time: 77s + 4s + 4s + 4s = 89 seconds** (first time)
- **Subsequent: Instant** (if all cached)

**Problem**: Currency conversion issue
- Jan is at Jan's rate
- Feb change is at Feb's rate
- Mar change is at Mar's rate
- Apr change is at Apr's rate
- **Sum ≠ April cumulative** (rates don't match!)

---

#### Option 2: Corrected Formula (All at April Rate)

```excel
=XAVI.BALANCE("10010", "Jan 2025", "Jan 2025", "", "", "", "", "", "Apr 2025")
 + XAVI.BALANCECHANGE("10010", "Feb 2025", "Feb 2025", "", "", "", "", "", "Apr 2025")
 + XAVI.BALANCECHANGE("10010", "Mar 2025", "Mar 2025", "", "", "", "", "", "Apr 2025")
 + XAVI.BALANCECHANGE("10010", "Apr 2025", "Apr 2025", "", "", "", "", "", "Apr 2025")
```

**What it does**:
- Jan cumulative at **April's rate**: ~77s (recalculate Jan at Apr rate)
- Feb change at **April's rate**: ~77s (recalculate Feb period at Apr rate)
- Mar change at **April's rate**: ~77s (recalculate Mar period at Apr rate)
- Apr change at **April's rate**: ~4s (period-only, already at Apr rate)
- Sum: All at April's rate = April cumulative
- **Total time: 77s + 77s + 77s + 4s = 235 seconds** (WORSE than direct!)

**Problem**: Rate conversion kills time savings!

---

#### Option 3: Smart Incremental (If Baseline at Target Rate Cached)

```excel
=XAVI.BALANCE("10010", "Jan 2025", "Jan 2025", "", "", "", "", "", "Apr 2025")
 + XAVI.BALANCECHANGE("10010", "Feb 2025", "Feb 2025")
 + XAVI.BALANCECHANGE("10010", "Mar 2025", "Mar 2025")
 + XAVI.BALANCECHANGE("10010", "Apr 2025", "Apr 2025")
```

**What it does** (if baseline cached at Apr rate):
- Jan cumulative at April's rate: **Instant** (cached)
- Feb change: **Instant** (cached, but at Feb rate - WRONG!)
- Mar change: **Instant** (cached, but at Mar rate - WRONG!)
- Apr change: **Instant** (cached, at Apr rate)
- **Problem**: Rates don't match, sum is incorrect!

---

#### Option 4: New Function - BALANCEINCREMENTAL

**Proposed new function**:

```excel
=XAVI.BALANCEINCREMENTAL("10010", "Jan 2025", "Apr 2025")
```

**What it does internally**:
1. Check if baseline (Jan) is cached at target rate (Apr rate)
2. If not, calculate Jan at Apr rate (77s, cache result)
3. Get period changes (Feb, Mar, Apr) - recalculate each at Apr rate if needed
4. Sum: Jan_at_Apr_rate + Feb_change_at_Apr_rate + Mar_change_at_Apr_rate + Apr_change_at_Apr_rate
5. Return: April cumulative

**Performance**:
- First calculation: 77s (Jan at Apr rate) + 3 × 77s (period changes at Apr rate) = **308 seconds** (WORSE!)
- Subsequent: Instant (if all cached at Apr rate)

---

#### Option 5: Rolling Baseline (Previous Month)

```excel
=XAVI.BALANCE("10010",, "Jan 2025")
 + XAVI.BALANCECHANGE("10010", "Feb 2025", "Feb 2025")
 + XAVI.BALANCECHANGE("10010", "Mar 2025", "Mar 2025")
 + XAVI.BALANCECHANGE("10010", "Apr 2025", "Apr 2025")
```

**What it does** (if using rolling baseline internally):
- Jan cumulative: 77s (baseline)
- Feb = Jan + Feb_change: 77s (recalc Jan at Feb rate) + 4s = 81s
- Mar = Feb + Mar_change: 77s (recalc Feb at Mar rate) + 4s = 81s
- Apr = Mar + Apr_change: 77s (recalc Mar at Apr rate) + 4s = 81s
- **Total: 77s + 81s + 81s + 81s = 320 seconds** (WORSE!)

---

## The Currency Conversion Problem

### Why Simple Summation Doesn't Work

**Example with numbers**:
- Jan cumulative at Jan rate (1.10 USD/EUR): $1,000
- Feb change at Feb rate (1.15 USD/EUR): $200
- Mar change at Mar rate (1.12 USD/EUR): $150
- Apr change at Apr rate (1.18 USD/EUR): $100

**Simple sum**: $1,000 + $200 + $150 + $100 = $1,450

**But April cumulative at Apr rate** should be:
- All transactions (Jan + Feb + Mar + Apr) converted at Apr rate (1.18)
- This is NOT the same as summing amounts at different rates!

**Correct calculation**:
- Jan transactions at Apr rate: $1,073 (recalculated)
- Feb transactions at Apr rate: $209 (recalculated)
- Mar transactions at Apr rate: $158 (recalculated)
- Apr transactions at Apr rate: $100 (already at Apr rate)
- **Correct sum**: $1,073 + $209 + $158 + $100 = $1,540

**Difference**: $90 (6% error due to rate mismatch!)

---

## What the Formula SHOULD Look Like

### If We Solve the Currency Issue

**Ideal formula** (if baseline at target rate is cached):

```excel
=XAVI.BALANCE("10010", "Jan 2025", "Jan 2025", "", "", "", "", "", "Apr 2025")
 + XAVI.BALANCECHANGE("10010", "Feb 2025", "Feb 2025", "", "", "", "", "", "Apr 2025")
 + XAVI.BALANCECHANGE("10010", "Mar 2025", "Mar 2025", "", "", "", "", "", "Apr 2025")
 + XAVI.BALANCECHANGE("10010", "Apr 2025", "Apr 2025")
```

**But**: This requires recalculating each period change at Apr rate, which is 77s each = **235 seconds total** (worse than direct 77s!)

---

## Conclusion

**The formula structure would be**:
```excel
Baseline + Sum of Period Changes
```

**But the currency conversion requirement means**:
- Each component must be at the target period's rate
- Recalculating at target rate = 77s per component
- **No time savings** compared to direct cumulative query

**The only viable approach**:
- Use direct cumulative query: `=XAVI.BALANCE("10010",, "Apr 2025")`
- **Time: 77 seconds** (same as incremental, but simpler)

**OR**:
- Precache baseline at all target rates during initial precache
- Then incremental becomes: Baseline (instant) + Period changes (instant) = **Instant**
- **But initial precache cost: 12 × 77s = 924 seconds** (not acceptable per user)

