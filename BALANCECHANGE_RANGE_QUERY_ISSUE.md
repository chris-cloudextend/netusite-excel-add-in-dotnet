# BALANCECHANGE Range Query Issue - Currency Conversion Problem

## Executive Summary

**Issue**: `BALANCECHANGE("10010", "Jan 2025", "Apr 2025")` returns an **incorrect value** for multi-currency (OneWorld) environments due to mixing exchange rates.

**Root Cause**: Current implementation calculates `Balance(Apr) - Balance(Jan)` where:
- `Balance(Jan)` uses **Jan's exchange rate**
- `Balance(Apr)` uses **Apr's exchange rate**
- The difference mixes rates, resulting in mathematically incorrect values

**Impact**: Financial reporting accuracy violation - violates "cardinal rule of financial integrity"

**Status**: Documented for future fix. Current implementation kept as-is with this documentation.

---

## Current Implementation

### How BALANCECHANGE Works

**Location**: `backend-dotnet/Controllers/BalanceController.cs` lines 329-376

**Logic**:
```csharp
// Step 1: Get balance as of fromDate (cumulative)
Balance(Jan) = All transactions from inception through Jan end, at Jan's rate

// Step 2: Get balance as of toDate (cumulative)  
Balance(Apr) = All transactions from inception through Apr end, at Apr's rate

// Step 3: Calculate change
Change = Balance(Apr) - Balance(Jan)
```

### Test Results

**Query**: `BALANCECHANGE("10010", "Jan 2025", "Apr 2025")`

**Results**:
- Jan cumulative: **$2,064,705.84** (at Jan's exchange rate)
- Apr cumulative: **$547,837.30** (at Apr's exchange rate)
- Change returned: **-$1,516,868.54**

**Verification**:
```
547,837.30 - 2,064,705.84 = -1,516,868.54 ✓ (math is correct)
```

---

## The Currency Conversion Problem

### Why It's Wrong

**For OneWorld multi-currency**, all transactions in a Balance Sheet must use the **same exchange rate** (target period's rate) to balance correctly.

**Current calculation**:
```
Change = (All transactions at Apr rate) - (All transactions at Jan rate)
```

**What we actually want**:
```
Change = Sum of (Jan + Feb + Mar + Apr) transactions, all at Apr's rate
```

**These are NOT the same!**

### Example with Different Exchange Rates

**Scenario**:
- Jan 2025 exchange rate: 1.10 USD/EUR
- Apr 2025 exchange rate: 1.18 USD/EUR
- Jan transactions: 100 EUR
- Feb transactions: 50 EUR
- Mar transactions: 30 EUR
- Apr transactions: 20 EUR

**Current calculation**:
- Balance(Jan) = 100 EUR × 1.10 = **$110** (at Jan rate)
- Balance(Apr) = (100 + 50 + 30 + 20) EUR × 1.18 = 200 EUR × 1.18 = **$236** (at Apr rate)
- Change = $236 - $110 = **$126**

**Correct calculation** (all at Apr rate):
- Jan at Apr rate: 100 EUR × 1.18 = **$118**
- Feb at Apr rate: 50 EUR × 1.18 = **$59**
- Mar at Apr rate: 30 EUR × 1.18 = **$35.40**
- Apr at Apr rate: 20 EUR × 1.18 = **$23.60**
- Sum = $118 + $59 + $35.40 + $23.60 = **$236**

**Difference**: $126 vs $236 = **47% error!**

**The correct change should be**: $236 (sum of all transactions at Apr rate)
**Current returns**: $126 (incorrect due to rate mixing)

---

## What BALANCECHANGE Should Calculate

### Correct Approach

For `BALANCECHANGE("10010", "Jan 2025", "Apr 2025")`, it should calculate:

**Sum of all transactions from Jan through Apr, all at Apr's exchange rate**

**Implementation**:
1. Jan period at **Apr's rate**: Recalculate Jan transactions at Apr rate
2. Feb period change at **Apr's rate**: Recalculate Feb transactions at Apr rate
3. Mar period change at **Apr's rate**: Recalculate Mar transactions at Apr rate
4. Apr period change at **Apr's rate**: Already at Apr rate (or recalculate for consistency)
5. Sum: All at Apr's rate

**This equals**: Apr cumulative at Apr rate (correct!)

### Modified Logic

```csharp
// Instead of: Balance(Apr) - Balance(Jan)
// Calculate: Sum of period changes from Jan through Apr, all at Apr's rate

var totalChange = 0m;
var targetPeriod = to_period; // Apr 2025

for (var period = from_period; period <= to_period; period = NextPeriod(period))
{
    // Get period change at TARGET rate (Apr's rate)
    var periodChange = GetPeriodChangeAtTargetRate(account, period, targetPeriod, ...);
    totalChange += periodChange;
}

return totalChange;
```

---

## Performance Implications

### Current Implementation

**Time**: 2 × 77s = **154 seconds**
- Jan cumulative: 77s
- Apr cumulative: 77s
- Difference: Instant

### Corrected Implementation

**Time**: 4 × 77s = **308 seconds**
- Jan period at Apr rate: 77s (recalculate)
- Feb period at Apr rate: 77s (recalculate)
- Mar period at Apr rate: 77s (recalculate)
- Apr period at Apr rate: 77s (recalculate for consistency)
- Sum: Instant

**Result**: **2x slower** than current (incorrect) implementation, **4x slower** than direct cumulative query (77s)

### With Caching

If period changes are precached at their own rates:
- Jan period at Apr rate: 77s (recalculate at Apr rate)
- Feb period at Apr rate: 77s (recalculate at Apr rate)
- Mar period at Apr rate: 77s (recalculate at Apr rate)
- Apr period at Apr rate: Instant (already at Apr rate, or 77s if recalculating)

**Still requires 3-4 × 77s = 231-308 seconds** (worse than direct!)

---

## Financial Integrity Impact

### CPA Perspective

**From a financial reporting standpoint**:
- Balance Sheet accounts must balance correctly
- All amounts must use the same exchange rate (target period's rate)
- Mixing rates creates **material misstatements**
- This violates GAAP and financial reporting standards

**Example Impact**:
- If exchange rates differ by 5-10% between periods
- Error magnitude: 5-10% of the change amount
- For large accounts: Could be millions of dollars in error

**Risk Level**: **HIGH** - Financial reporting accuracy violation

---

## Test Results Summary

### Test Case: Account 10010, Jan 2025 to Apr 2025

**Current Implementation**:
- Jan cumulative: $2,064,705.84 (at Jan rate)
- Apr cumulative: $547,837.30 (at Apr rate)
- Change returned: **-$1,516,868.54**

**Expected (if correct)**:
- Sum of (Jan + Feb + Mar + Apr) transactions, all at Apr rate
- Should equal: Apr cumulative at Apr rate = **$547,837.30**

**Discrepancy**: Current returns -$1,516,868.54, but correct value should be different (depends on rate differences)

**Note**: Without knowing the exact exchange rates, we can't calculate the exact error, but the methodology is incorrect.

---

## Recommendations

### Short Term (Current)

1. **Keep current implementation** (as-is)
2. **Document the limitation** in user documentation
3. **Add warning** in function description about multi-currency accuracy
4. **Recommend direct BALANCE** for cumulative queries:
   ```excel
   =XAVI.BALANCE("10010",, "Apr 2025")  // Use this instead
   ```

### Long Term (Future Fix)

**Option 1: Fix BALANCECHANGE for Range Queries**
- Modify to sum period changes at target rate
- Accept performance penalty (308s vs 77s direct)
- Ensure financial correctness

**Option 2: New Function - BALANCERANGE**
- Create dedicated function for range sums
- `BALANCERANGE("10010", "Jan 2025", "Apr 2025")`
- Calculates sum of period changes, all at target rate
- Keep BALANCECHANGE for single period only

**Option 3: Accept Approximation**
- Keep current implementation
- Add documentation: "Approximate for multi-currency, use BALANCE for exact"
- Only acceptable if rates are stable or user understands limitation

---

## Code Locations

### Current Implementation

**File**: `backend-dotnet/Controllers/BalanceController.cs`
- **Lines**: 329-376
- **Method**: `GetBalanceChange()`
- **Logic**: `Balance(to_period) - Balance(from_period)`

**File**: `backend-dotnet/Services/BalanceService.cs`
- **Lines**: 265-319 (BS cumulative query)
- **Lines**: 289-332 (BS period-only query, when from==to)
- **Exchange rate**: Uses `targetPeriodId` for consolidation

### Where Fix Would Be Applied

**File**: `backend-dotnet/Controllers/BalanceController.cs`
- **Method**: `GetBalanceChange()`
- **Change**: When `from_period != to_period`, sum period changes instead of subtracting

**File**: `backend-dotnet/Services/BalanceService.cs`
- **Method**: `GetBalanceAsync()`
- **Change**: Add logic to get period change at target rate (not period's own rate)

---

## Related Findings

### Period-Only Query Performance

**Discovery**: Period-only queries (when `from_period == to_period`) are **90% faster**:
- Cumulative query: ~77 seconds
- Period-only query: ~4 seconds
- **Time savings: 73 seconds (95% faster)**

**Implementation**: Already implemented in `BalanceService.cs` lines 289-332

**Use case**: `BALANCECHANGE("10010", "Apr 2025", "Apr 2025")` returns Apr period change only
- **Correct**: Uses Apr's rate (target rate = period's own rate)
- **Fast**: 4 seconds vs 77 seconds
- **Useful**: For variance analysis, period activity

### Incremental Calculation Analysis

**Finding**: Incremental calculation (baseline + period changes) doesn't provide time savings for cumulative queries due to currency conversion requirement.

**Reason**: Baseline must be recalculated at target rate (77s), eliminating time savings.

**Recommendation**: Use direct cumulative queries for cumulative balances. Use BALANCECHANGE for period activity analysis only.

---

## Conclusion

**Current Status**: 
- BALANCECHANGE range queries are **incorrect for multi-currency**
- Returns values that mix exchange rates
- Violates financial reporting accuracy requirements

**Fix Required**:
- Sum period changes at target rate (not subtract cumulative balances)
- Performance penalty: 4x slower than direct cumulative query
- Financial correctness: Required for accurate reporting

**Recommendation**:
- Keep current implementation for now (documented limitation)
- Users should use `BALANCE()` for cumulative queries
- Use `BALANCECHANGE()` only for single-period activity analysis
- Plan future fix with performance vs accuracy trade-off analysis

---

**Document Version**: 1.0  
**Date**: December 28, 2025  
**Status**: Issue documented, implementation unchanged per user request

