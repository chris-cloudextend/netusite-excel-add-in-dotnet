# BALANCECHANGE Range Correctness Analysis

## Current Implementation

### Query: `BALANCECHANGE("10010", "Jan 2025", "Apr 2025")`

**Current logic**:
```
Change = Balance(Apr 2025) - Balance(Jan 2025)
```

Where:
- `Balance(Jan 2025)` = All transactions from inception through Jan end, at **Jan's exchange rate**
- `Balance(Apr 2025)` = All transactions from inception through Apr end, at **Apr's exchange rate**

**Test Results**:
- Jan cumulative: $2,064,705.84 (at Jan's rate)
- Apr cumulative: $547,837.30 (at Apr's rate)
- Change: -$1,516,868.54

---

## Is This Number Wrong?

### For Multi-Currency (OneWorld): **YES, IT'S WRONG**

**Why**:
- Jan cumulative includes transactions converted at **Jan's exchange rate**
- Apr cumulative includes ALL transactions (Jan + Feb + Mar + Apr) converted at **Apr's exchange rate**
- Subtracting them gives: `(All at Apr rate) - (All at Jan rate)`

**This is NOT the same as**: Sum of (Jan + Feb + Mar + Apr) transactions all at **Apr's rate**

**Example with different rates**:
- Jan rate: 1.10 USD/EUR
- Apr rate: 1.18 USD/EUR

If we have:
- Jan transactions: 100 EUR → $110 (at Jan rate) or $118 (at Apr rate)
- Feb transactions: 50 EUR → $59 (at Apr rate)
- Mar transactions: 30 EUR → $35.40 (at Apr rate)
- Apr transactions: 20 EUR → $23.60 (at Apr rate)

**Current calculation**:
- Balance(Jan) = $110 (Jan transactions at Jan rate)
- Balance(Apr) = $110 + $59 + $35.40 + $23.60 = $228 (all at Apr rate)
- Change = $228 - $110 = **$118**

**Correct calculation** (all at Apr rate):
- Jan at Apr rate: $118
- Feb at Apr rate: $59
- Mar at Apr rate: $35.40
- Apr at Apr rate: $23.60
- Sum = $118 + $59 + $35.40 + $23.60 = **$236**

**Difference**: $118 vs $236 = **50% error!**

---

## What BALANCECHANGE Should Calculate

### Correct Approach: Sum Period Changes at Target Rate

For `BALANCECHANGE("10010", "Jan 2025", "Apr 2025")`, it should calculate:

```
Sum of all transactions from Jan through Apr, all at Apr's exchange rate
```

**Implementation**:
1. Jan period at **Apr's rate**: Recalculate Jan transactions at Apr rate
2. Feb period change at **Apr's rate**: Recalculate Feb transactions at Apr rate
3. Mar period change at **Apr's rate**: Recalculate Mar transactions at Apr rate
4. Apr period change at **Apr's rate**: Already at Apr rate (or recalculate)
5. Sum: All at Apr's rate

**This equals**: Apr cumulative at Apr rate (correct!)

---

## Modified BALANCECHANGE Implementation

### Proposed Logic

When `from_period != to_period`:

```csharp
// Sum period changes from from_period to to_period, all at to_period's rate
var totalChange = 0m;

for (var period = from_period; period <= to_period; period = NextPeriod(period))
{
    // Get period change at TARGET rate (to_period's rate)
    var periodChange = GetPeriodChangeAtTargetRate(account, period, to_period, ...);
    totalChange += periodChange;
}

return totalChange;
```

**Performance**:
- For Jan to Apr: 4 periods × 77s = **308 seconds** (worse than direct 77s!)

---

## Alternative: Accept Current Behavior with Warning

### Current Implementation is "Close Enough" If:

1. **Exchange rates are stable** (Jan rate ≈ Apr rate)
2. **User understands it's an approximation**
3. **Used for trend analysis, not exact reporting**

**But**: For financial reporting, this is **financially incorrect** and violates the "cardinal rule of financial integrity."

---

## Recommendation

### Option 1: Fix BALANCECHANGE for Range Queries

Modify to sum period changes at target rate:
- **Correct**: Mathematically accurate
- **Slow**: 4 × 77s = 308s (worse than direct 77s)

### Option 2: Keep Current, Add Warning

Keep current implementation but:
- Add documentation warning about currency conversion
- Recommend using direct BALANCE for cumulative
- Use BALANCECHANGE only for single period (period change)

### Option 3: New Function - BALANCERANGE

Create new function specifically for range sums:
```excel
=XAVI.BALANCERANGE("10010", "Jan 2025", "Apr 2025")
```

Calculates sum of period changes from Jan through Apr, all at Apr's rate.

---

## Answer to Your Question

**Q: Would `BALANCECHANGE("10010", "Jan 2025", "Apr 2025")` be wrong?**

**A: YES, for multi-currency it's wrong** because:
- It mixes exchange rates (Jan at Jan rate, Apr at Apr rate)
- The difference is not the sum of transactions at a single rate
- For financial reporting, this violates accuracy requirements

**To make it correct**, we'd need to:
- Recalculate each period at Apr's rate (77s each)
- Total: 4 × 77s = 308 seconds (worse than direct cumulative 77s)

**Recommendation**: Use direct cumulative query instead:
```excel
=XAVI.BALANCE("10010",, "Apr 2025")
```

