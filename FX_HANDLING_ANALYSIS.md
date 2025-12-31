# Foreign Exchange (FX) Handling Analysis - Excel vs NetSuite Mismatch

## Executive Summary

Multiple Balance Sheet accounts with foreign currencies (INR, EUR, GBP, AUD) are showing incorrect values in Excel compared to NetSuite. The discrepancies range from $16.95 to $71,491.37. This document analyzes how NetSuite handles FX conversion and how our code implements it, identifying the likely root cause.

## NetSuite March 2025 Values vs Excel Values

| Account | Currency | NetSuite (March) | Excel (March) | Difference | Status |
|---------|----------|------------------|---------------|-----------|--------|
| 10010 | USD | $1,021,295.03 | $1,021,295.03 | $0.00 | ✅ MATCH |
| 10012 | USD | $999,831.00 | $999,831.00 | $0.00 | ✅ MATCH |
| 10030 | USD | $1,147,358.00 | $1,147,358.00 | $0.00 | ✅ MATCH |
| 10031 | USD | $102,779.49 | $102,779.49 | $0.00 | ✅ MATCH |
| 10034 | USD | $14,683,853.14 | $14,683,853.14 | $0.00 | ✅ MATCH |
| **10200** | **INR** | **$3,074,570.97** | **$3,146,062.34** | **-$71,491.37** | ❌ **MISMATCH** |
| **10201** | **INR** | **$843,761.11** | **$865,262.26** | **-$21,501.15** | ❌ **MISMATCH** |
| **10202** | **INR** | **$101,635.68** | **$111,801.63** | **-$10,165.95** | ❌ **MISMATCH** |
| **10400** | **EUR** | **$11,825.69** | **$4,200.93** | **+$7,624.76** | ❌ **MISMATCH** |
| **10401** | **GBP** | **$1,992.17** | **-$2,408.22** | **+$4,400.39** | ❌ **MISMATCH** |
| **10403** | **EUR** | **$2,065.72** | **$2,006.78** | **+$58.94** | ❌ **MISMATCH** |
| 10411 | EUR | $65,143.33 | $65,143.33 | $0.00 | ✅ MATCH |
| 10413 | GBP | $9,417.42 | $9,417.42 | $0.00 | ✅ MATCH |
| **10502** | **AUD** | **$138,347.72** | **$142,022.80** | **-$3,675.08** | ❌ **MISMATCH** |
| **10898** | **INR** | **$423.47** | **$440.42** | **-$16.95** | ❌ **MISMATCH** |

**Pattern**: All mismatches are in foreign currency accounts. USD accounts match perfectly.

---

## How NetSuite Handles FX for Balance Sheet Calculations

### NetSuite's BUILTIN.CONSOLIDATE Function

NetSuite uses `BUILTIN.CONSOLIDATE` to convert foreign currency amounts to a base currency (typically USD for consolidated reporting). The function signature is:

```sql
BUILTIN.CONSOLIDATE(
    amount,           -- The transaction amount in its native currency
    'LEDGER',         -- Ledger type
    'DEFAULT',        -- Accounting method
    'DEFAULT',        -- Consolidation method
    targetSubsidiary, -- Target subsidiary ID for consolidation
    periodId,         -- Period ID for exchange rate lookup
    'DEFAULT'         -- Additional options
)
```

### Critical FX Behavior in NetSuite

1. **Point-in-Time Balances (Cumulative)**: 
   - NetSuite uses the **target period's exchange rate** for ALL historical transactions
   - This ensures the Balance Sheet balances correctly at a point in time
   - Example: March 2025 balance converts all transactions (Jan, Feb, Mar) using March's exchange rate

2. **Period Activity (Change During Period)**:
   - **This is where the ambiguity exists**
   - Option A: Use each period's own exchange rate (transaction period's rate)
   - Option B: Use target period's exchange rate (consistent with cumulative balances)
   - NetSuite's standard Balance Sheet reports typically use Option B (target period rate) for consistency

3. **Why This Matters**:
   - If period activity uses each period's own rate, then:
     - Jan activity converted at Jan's rate
     - Feb activity converted at Feb's rate  
     - Mar activity converted at Mar's rate
   - If period activity uses target period's rate, then:
     - Jan activity converted at Mar's rate
     - Feb activity converted at Mar's rate
     - Mar activity converted at Mar's rate

---

## How Our Code Currently Handles FX

### 1. Opening Balance Query (Anchor Date)

**Location**: `BalanceService.cs` - `GetBalanceAsync` (point-in-time path)

**Code**:
```csharp
BUILTIN.CONSOLIDATE(
    tal.amount,
    'LEDGER',
    'DEFAULT',
    'DEFAULT',
    {targetSub},
    {targetPeriodId},  // Uses target period (toPeriod) ID
    'DEFAULT'
)
```

**Behavior**: ✅ **CORRECT** - Uses target period's exchange rate for all historical transactions

### 2. Single-Account Period Activity Query

**Location**: `BalanceService.cs` - `GetPeriodActivityBreakdownAsync` (lines 2044-2063)

**Code**:
```csharp
// CRITICAL FIX: For single-period queries, use the period ID directly instead of ap.id
// For multi-period queries, use the LAST period ID (target period) for all transactions
var targetPeriodIdForConsolidate = periodIds.Count > 0 ? periodIds[periodIds.Count - 1] : "NULL";

BUILTIN.CONSOLIDATE(
    tal.amount,
    'LEDGER',
    'DEFAULT',
    'DEFAULT',
    {targetSub},
    {targetPeriodIdForConsolidate},  // Uses LAST period ID (March) for ALL periods
    'DEFAULT'
)
```

**Behavior**: ⚠️ **POTENTIALLY INCORRECT** - Uses target period's (March) exchange rate for ALL periods (Jan, Feb, Mar)

**Comment in code** (line 2048):
> "Use the last period ID (target period) for currency conversion - this ensures consistent exchange rates"

### 3. Batch Period Activity Query (Multi-Account)

**Location**: `BalanceService.cs` - `GetPeriodActivityBatchAsync` (lines 2605-2633)

**Code**:
```csharp
BUILTIN.CONSOLIDATE(
    tal.amount,
    'LEDGER',
    'DEFAULT',
    'DEFAULT',
    {targetSub},
    ap.id,  // ⚠️ Uses EACH period's own ID (Jan uses Jan's rate, Feb uses Feb's rate, etc.)
    'DEFAULT'
)
```

**Behavior**: ⚠️ **INCONSISTENT** - Uses each period's own exchange rate (Jan transactions use Jan's rate, Feb transactions use Feb's rate, etc.)

**Critical Issue**: This is **DIFFERENT** from the single-account query which uses the target period's rate!

---

## The Root Cause

### Inconsistency Between Single-Account and Batch Queries

1. **Single-Account Period Activity** (`GetPeriodActivityBreakdownAsync`):
   - Uses `targetPeriodIdForConsolidate` = **last period ID (March)**
   - All periods (Jan, Feb, Mar) converted using **March's exchange rate**

2. **Batch Period Activity** (`GetPeriodActivityBatchAsync`):
   - Uses `ap.id` = **each period's own ID**
   - Jan transactions use **Jan's exchange rate**
   - Feb transactions use **Feb's exchange rate**
   - Mar transactions use **Mar's exchange rate**

### Why This Causes Mismatches

When Excel calculates cumulative balances using batch queries:

1. **Opening Balance** (Dec 31, 2024): Uses anchor date's rate ✅
2. **Jan Activity**: Uses **Jan's exchange rate** (from batch query) ❌
3. **Feb Activity**: Uses **Feb's exchange rate** (from batch query) ❌
4. **Mar Activity**: Uses **Mar's exchange rate** (from batch query) ❌

**Result**: 
- Opening balance + Jan activity (Jan rate) + Feb activity (Feb rate) + Mar activity (Mar rate)
- This creates a "mixed rate" cumulative balance

**NetSuite's Approach**:
- Opening balance + Jan activity (Mar rate) + Feb activity (Mar rate) + Mar activity (Mar rate)
- All transactions use the **target period's (March) exchange rate**

### Why Some Accounts Match and Others Don't

- **USD Accounts (10010, 10012, etc.)**: Match because USD/USD conversion = 1.0 regardless of period
- **Foreign Currency Accounts**: Mismatch because exchange rates differ between periods
- **Some FC Accounts Match (10411, 10413)**: Possibly no activity in Jan/Feb, or exchange rates were stable

---

## Code References

### Single-Account Period Activity (Inconsistent)

**File**: `backend-dotnet/Services/BalanceService.cs`  
**Method**: `GetPeriodActivityBreakdownAsync`  
**Lines**: 2044-2063

```csharp
// Use the last period ID (target period) for currency conversion
var targetPeriodIdForConsolidate = periodIds.Count > 0 
    ? periodIds[periodIds.Count - 1]  // Last period (March)
    : "NULL";

BUILTIN.CONSOLIDATE(
    tal.amount,
    'LEDGER',
    'DEFAULT',
    'DEFAULT',
    {targetSub},
    {targetPeriodIdForConsolidate},  // March's rate for ALL periods
    'DEFAULT'
)
```

### Batch Period Activity (Inconsistent)

**File**: `backend-dotnet/Services/BalanceService.cs`  
**Method**: `GetPeriodActivityBatchAsync`  
**Lines**: 2605-2633

```csharp
BUILTIN.CONSOLIDATE(
    tal.amount,
    'LEDGER',
    'DEFAULT',
    'DEFAULT',
    {targetSub},
    ap.id,  // Each period's own rate (Jan uses Jan, Feb uses Feb, etc.)
    'DEFAULT'
)
```

### Opening Balance (Correct)

**File**: `backend-dotnet/Services/BalanceService.cs`  
**Method**: `GetBalanceAsync` (point-in-time path)  
**Lines**: 304-318

```csharp
BUILTIN.CONSOLIDATE(
    tal.amount,
    'LEDGER',
    'DEFAULT',
    'DEFAULT',
    {targetSub},
    {targetPeriodId},  // Target period's rate (consistent)
    'DEFAULT'
)
```

---

## The Fix

### Option 1: Make Batch Query Match Single-Account Query (Recommended)

Change `GetPeriodActivityBatchAsync` to use the target period's rate for all periods:

```csharp
// Get the last period ID (target period) for currency conversion
var targetPeriodIdForConsolidate = periodIds.Count > 0 
    ? periodIds[periodIds.Count - 1]  // Last period (March)
    : "NULL";

var query = $@"
    SELECT 
        ap.periodname AS period_name,
        SUM(
            TO_NUMBER(
                BUILTIN.CONSOLIDATE(
                    tal.amount,
                    'LEDGER',
                    'DEFAULT',
                    'DEFAULT',
                    {targetSub},
                    {targetPeriodIdForConsolidate},  // Changed from ap.id
                    'DEFAULT'
                )
            ) * {signFlip}
        ) AS period_activity
    ...
```

**Rationale**: 
- Matches NetSuite's Balance Sheet report behavior (all periods use target period's rate)
- Ensures cumulative balances are consistent
- Matches the single-account query behavior

### Option 2: Make Single-Account Query Match Batch Query

Change `GetPeriodActivityBreakdownAsync` to use each period's own rate:

```csharp
BUILTIN.CONSOLIDATE(
    tal.amount,
    'LEDGER',
    'DEFAULT',
    'DEFAULT',
    {targetSub},
    ap.id,  // Changed from targetPeriodIdForConsolidate
    'DEFAULT'
)
```

**Rationale**: 
- Each period's activity uses that period's exchange rate
- More "accurate" for period activity (reflects actual FX impact during the period)
- But may not match NetSuite's Balance Sheet reports

**⚠️ WARNING**: Option 2 may not match NetSuite's standard Balance Sheet reports, which typically use the target period's rate for consistency.

---

## Recommendation

**Use Option 1**: Make the batch query use the target period's rate (matching the single-account query and NetSuite's Balance Sheet reports).

This ensures:
1. Consistency between single-account and batch queries
2. Consistency with NetSuite's Balance Sheet reports
3. Correct cumulative balance calculations
4. All periods use the same exchange rate (target period's rate)

---

## Testing Plan

After implementing the fix:

1. **Verify USD accounts still match** (should be unaffected)
2. **Verify foreign currency accounts now match NetSuite**
3. **Check specific accounts**:
   - 10200 (INR): Should match $3,074,570.97
   - 10201 (INR): Should match $843,761.11
   - 10202 (INR): Should match $101,635.68
   - 10400 (EUR): Should match $11,825.69
   - 10401 (GBP): Should match $1,992.17
   - 10403 (EUR): Should match $2,065.72
   - 10502 (AUD): Should match $138,347.72
   - 10898 (INR): Should match $423.47

4. **Verify opening balances are still correct** (should be unaffected)
5. **Verify period activity values** (should now use target period's rate)

---

## Additional Notes

### Why NetSuite Uses Target Period's Rate for Balance Sheet

NetSuite's Balance Sheet reports use the target period's exchange rate for ALL historical transactions to ensure:
1. **Balance Sheet balances**: Assets = Liabilities + Equity (in base currency)
2. **Consistency**: All amounts are converted at the same rate
3. **Point-in-time accuracy**: The balance sheet represents the financial position as of a specific date using that date's exchange rates

### Exchange Rate Fluctuations

If exchange rates change between periods:
- **Jan rate**: 1 USD = 83 INR
- **Feb rate**: 1 USD = 83.5 INR  
- **Mar rate**: 1 USD = 83.2 INR

Using each period's own rate:
- Jan activity: 100,000 INR = $1,204.82 (Jan rate)
- Feb activity: 50,000 INR = $598.80 (Feb rate)
- Mar activity: 75,000 INR = $901.44 (Mar rate)
- **Total**: $2,705.06

Using target period's rate (March):
- Jan activity: 100,000 INR = $1,201.92 (Mar rate)
- Feb activity: 50,000 INR = $600.96 (Mar rate)
- Mar activity: 75,000 INR = $901.44 (Mar rate)
- **Total**: $2,704.32

**Difference**: $0.74 (due to rate fluctuations)

This explains why the mismatches are larger for accounts with more activity across multiple periods.

