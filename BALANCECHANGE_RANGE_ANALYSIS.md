# BALANCECHANGE Range Analysis: Jan 2025 to Apr 2025

## Question

What if we use `BALANCECHANGE("10010", "Jan 2025", "Apr 2025")` where:
- Jan 2025 is the baseline (from_period)
- Apr 2025 is the target (to_period)
- It calculates the sum of all transactions from Jan through Apr

**Would this number be wrong?**

---

## Current BALANCECHANGE Implementation

### How It Works Now

When `from_period != to_period`, BALANCECHANGE calculates:

```
Change = Balance(to_period) - Balance(from_period)
```

Where both balances are **cumulative** (from inception):
- `Balance(Apr 2025)` = All transactions from inception through Apr end, at **Apr's rate**
- `Balance(Jan 2025)` = All transactions from inception through Jan end, at **Jan's rate**

**Result**:
```
Change = (All transactions through Apr at Apr rate) - (All transactions through Jan at Jan rate)
```

### The Problem

**This is mathematically incorrect for multi-currency!**

**Example**:
- Jan cumulative at Jan rate (1.10 USD/EUR): $1,000
- Apr cumulative at Apr rate (1.18 USD/EUR): $1,540

**Current calculation**: $1,540 - $1,000 = **$540**

**But what we actually want**: Sum of (Feb + Mar + Apr) transactions at **Apr's rate**

**The issue**: 
- Jan cumulative includes transactions at Jan's rate
- Apr cumulative includes ALL transactions (Jan + Feb + Mar + Apr) at Apr's rate
- Subtracting them gives: (Jan+Feb+Mar+Apr at Apr rate) - (Jan at Jan rate)
- This is NOT the same as: (Feb+Mar+Apr at Apr rate)

**Correct calculation should be**:
- (Jan+Feb+Mar+Apr at Apr rate) - (Jan at Apr rate) = (Feb+Mar+Apr at Apr rate) ✅

---

## What BALANCECHANGE Should Do

### Option 1: Sum Period Changes (Correct Approach)

For `BALANCECHANGE("10010", "Jan 2025", "Apr 2025")`, it should:

1. Calculate Jan period at **Apr's rate** (baseline period, but at target rate)
2. Calculate Feb period change at **Apr's rate**
3. Calculate Mar period change at **Apr's rate**
4. Calculate Apr period change at **Apr's rate** (already at Apr rate)
5. Sum: Jan_at_Apr_rate + Feb_change_at_Apr_rate + Mar_change_at_Apr_rate + Apr_change_at_Apr_rate

**Result**: Sum of all transactions from Jan through Apr, all at **Apr's rate**

**This equals**: Apr cumulative at Apr rate (correct!)

### Option 2: Direct Cumulative Difference (Current, But Wrong)

Current implementation:
```
Change = Balance(Apr) - Balance(Jan)
```

Where:
- Balance(Apr) = All transactions through Apr at **Apr's rate**
- Balance(Jan) = All transactions through Jan at **Jan's rate**

**Result**: 
- (Jan+Feb+Mar+Apr at Apr rate) - (Jan at Jan rate)
- **This is WRONG** because rates don't match!

---

## Test: What Does Current Implementation Return?

Let's test what the current BALANCECHANGE returns:

**Query**: `BALANCECHANGE("10010", "Jan 2025", "Apr 2025")`

**Current logic**:
1. Get Jan cumulative: All transactions through Jan end, at **Jan's rate**
2. Get Apr cumulative: All transactions through Apr end, at **Apr's rate**
3. Calculate: Apr - Jan

**Expected result**: 
- If rates are the same: Correct (difference = Feb+Mar+Apr)
- If rates differ: **Incorrect** (mixing rates)

---

## Corrected Implementation

### Modified BALANCECHANGE Logic

For range queries (from_period != to_period), calculate:

```
Change = Sum of period changes from (from_period + 1) to to_period
         + from_period period at to_period's rate
```

**Example**: `BALANCECHANGE("10010", "Jan 2025", "Apr 2025")`

1. Jan period at **Apr's rate**: Recalculate Jan transactions at Apr rate
2. Feb period change at **Apr's rate**: Recalculate Feb transactions at Apr rate
3. Mar period change at **Apr's rate**: Recalculate Mar transactions at Apr rate
4. Apr period change at **Apr's rate**: Already at Apr rate (or recalculate)
5. Sum: All at Apr's rate = Correct Apr cumulative

**Performance**:
- 4 × 77s = 308 seconds (if recalculating each period at Apr rate)
- **Worse than direct cumulative query (77s)!**

---

## Alternative: Sum Cached Period Changes

If period changes are already cached (from precache):

```
Change = Jan_period_at_Apr_rate (recalc: 77s)
       + Feb_change_at_Apr_rate (recalc: 77s)
       + Mar_change_at_Apr_rate (recalc: 77s)
       + Apr_change_at_Apr_rate (cached: instant)
```

**Still requires 3 × 77s = 231 seconds** (worse than direct!)

---

## Conclusion

### Current Implementation

`BALANCECHANGE("10010", "Jan 2025", "Apr 2025")` currently calculates:
- `Balance(Apr at Apr rate) - Balance(Jan at Jan rate)`

**This is WRONG for multi-currency** because it mixes exchange rates.

### What It Should Calculate

Sum of all transactions from Jan through Apr, all at **Apr's rate**:
- Jan period at Apr rate + Feb change at Apr rate + Mar change at Apr rate + Apr change at Apr rate

**This equals**: Apr cumulative at Apr rate (correct!)

### Performance Reality

To calculate correctly:
- Need to recalculate each period at target rate (77s each)
- Total: 4 × 77s = 308 seconds
- **Worse than direct cumulative query (77s)!**

### Recommendation

**Don't use BALANCECHANGE for range queries** - use direct cumulative:
```excel
=XAVI.BALANCE("10010",, "Apr 2025")
```

**Use BALANCECHANGE only for single period** (period change):
```excel
=XAVI.BALANCECHANGE("10010", "Apr 2025", "Apr 2025")
```
This is 90% faster (4s vs 77s) and useful for period activity analysis.

