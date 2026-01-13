# BALANCECURRENCY Accounting Book & Custom Exchange Rates Research

**Date:** January 12, 2026  
**Purpose:** Research accounting book support and custom exchange rate limitations for BALANCECURRENCY

---

## Executive Summary

### Accounting Book Support: ✅ **ALREADY IMPLEMENTED**

**BALANCECURRENCY already supports accounting book parameter:**
- ✅ Parameter accepted in controller (`book` parameter, line 285)
- ✅ Passed to `BalanceBetaRequest` (line 305)
- ✅ Used in SQL WHERE clause: `AND tal.accountingbook = {accountingBook}` (lines 949, 1020)
- ✅ Works identically to BALANCE function

**No code changes needed** - accounting book is fully functional.

### Custom Exchange Rates: ⚠️ **LIMITED SUPPORT**

**Current Implementation:**
- Uses `BUILTIN.CONSOLIDATE` with `'DEFAULT'` exchange rate type (3rd parameter)
- Queries `ConsolidatedExchangeRate` table for consolidation paths
- Uses exchange rates stored in NetSuite's `ConsolidatedExchangeRate` table

**Limitations:**
- `BUILTIN.CONSOLIDATE` with `'DEFAULT'` uses NetSuite's default exchange rates from `ConsolidatedExchangeRate` table
- Custom exchange rates set on individual transactions are **NOT** used by `BUILTIN.CONSOLIDATE`
- Custom exchange rates are transaction-specific and stored in the transaction record, not in `ConsolidatedExchangeRate` table

---

## 1. Accounting Book Support Analysis

### Current Implementation

**Backend Controller (`BalanceController.cs`):**
```csharp
[HttpGet("/balancecurrency")]
public async Task<IActionResult> GetBalanceCurrency(
    ...
    [FromQuery] int? book = null)  // ✅ Accounting book parameter accepted
{
    var request = new BalanceBetaRequest
    {
        ...
        Book = book  // ✅ Passed to request
    };
}
```

**Backend Service (`BalanceService.cs` - GetBalanceBetaAsync):**
```csharp
// Line 873-874: Accounting book converted to string
var accountingBook = (request.Book ?? DefaultAccountingBook).ToString();

// Line 949: Used in WHERE clause for Balance Sheet queries
AND tal.accountingbook = {accountingBook}

// Line 1020: Used in WHERE clause for P&L queries
AND tal.accountingbook = {accountingBook}
```

**Frontend (`functions.js`):**
```javascript
// Line 12506: Accounting book extracted from Range objects
accountingBook = extractValueFromRange(accountingBook, 'accountingBook');

// Line 12508: Included in params object
const params = { account, fromPeriod, toPeriod, subsidiary, department, location, classId, accountingBook, currency };

// Line 12509: Included in cache key (via getCacheKey)
const cacheKey = getCacheKey('balancecurrency', params);
```

**Cache Key (`getCacheKey` function):**
```javascript
// Line 6578: Accounting book included in cache key JSON
book: book  // Normalized to "1" for Primary Book
```

### How It Works

1. **Transaction Filtering:**
   - SQL WHERE clause includes: `AND tal.accountingbook = {accountingBook}`
   - Only transactions posted to the specified accounting book are included
   - Works identically to BALANCE function

2. **BUILTIN.CONSOLIDATE Behavior:**
   - `BUILTIN.CONSOLIDATE` does **NOT** have an accounting book parameter
   - `BUILTIN.CONSOLIDATE` operates on the filtered transactions (already filtered by accounting book)
   - Currency conversion uses exchange rates from `ConsolidatedExchangeRate` table
   - Exchange rates are **NOT** accounting book-specific (they're subsidiary/currency/period-specific)

3. **Cache Key:**
   - Accounting book is included in cache key
   - Separate cache entries for each accounting book
   - Changing accounting book triggers cache miss → new API call

### Conclusion: Accounting Book Support

✅ **Accounting book works properly with BALANCECURRENCY**

**How it works:**
- Filters transactions to specified accounting book
- `BUILTIN.CONSOLIDATE` operates on filtered transactions
- Exchange rates come from `ConsolidatedExchangeRate` table (not book-specific)

**No limitations identified** - accounting book support is complete and functional.

---

## 2. Custom Exchange Rates Analysis

### How NetSuite Exchange Rates Work

**Two Types of Exchange Rates in NetSuite:**

1. **Consolidated Exchange Rates** (used by `BUILTIN.CONSOLIDATE`):
   - Stored in `ConsolidatedExchangeRate` table
   - Used for multi-currency consolidation
   - Period-specific (one rate per period)
   - Subsidiary-specific (from subsidiary → to subsidiary)
   - **NOT** accounting book-specific
   - **NOT** transaction-specific

2. **Transaction Exchange Rates** (custom rates on individual transactions):
   - Stored in transaction record (`Transaction.exchangerate` field)
   - Used when transaction is created/posted
   - Transaction-specific (can override default rate)
   - **NOT** used by `BUILTIN.CONSOLIDATE`

### BUILTIN.CONSOLIDATE Exchange Rate Behavior

**Current Implementation:**
```sql
BUILTIN.CONSOLIDATE(
    tal.amount,
    'LEDGER',           -- Amount type
    'DEFAULT',          -- Exchange rate type ← KEY PARAMETER
    'DEFAULT',          -- Consolidation type
    {consolidationRootId},
    {targetPeriodId},   -- Period for exchange rate lookup
    'DEFAULT'           -- Elimination handling
)
```

**Exchange Rate Type Parameter (3rd parameter):**
- `'DEFAULT'`: Uses exchange rates from `ConsolidatedExchangeRate` table
- `'CUSTOM'`: **NOT SUPPORTED** - NetSuite SuiteQL documentation does not mention custom exchange rate type
- Other values: Not documented in NetSuite SuiteQL reference

**How Exchange Rates Are Resolved:**
1. `BUILTIN.CONSOLIDATE` queries `ConsolidatedExchangeRate` table
2. Looks up rate for: `fromsubsidiary` → `tosubsidiary` for `targetPeriodId`
3. Uses the rate stored in `ConsolidatedExchangeRate` table
4. **Does NOT** use transaction-specific exchange rates

### Custom Exchange Rates on Transactions

**What They Are:**
- Exchange rates manually set on individual transactions
- Stored in `Transaction.exchangerate` field
- Used when transaction is posted (converts transaction amount to base currency)
- Can override default exchange rate for that transaction

**Why They're NOT Used by BUILTIN.CONSOLIDATE:**
- `BUILTIN.CONSOLIDATE` is a consolidation function, not a transaction conversion function
- It operates at the **consolidation level**, not the **transaction level**
- Consolidation requires **consistent rates** across all transactions (period-end rate)
- Transaction-specific rates would create inconsistencies in consolidated reports

**Example Scenario:**
```
Transaction 1: Invoice in EUR, custom rate 1.12 USD/EUR (negotiated rate)
Transaction 2: Invoice in EUR, default rate 1.15 USD/EUR (market rate)

BUILTIN.CONSOLIDATE behavior:
- Uses period-end rate from ConsolidatedExchangeRate table (e.g., 1.15)
- Does NOT use transaction-specific rates (1.12 vs 1.15)
- All transactions convert at same rate for consolidation consistency
```

### ConsolidatedExchangeRate Table Structure

**What It Contains:**
- `fromsubsidiary`: Source subsidiary ID
- `tosubsidiary`: Target subsidiary ID (consolidation root)
- `period`: Accounting period ID
- `exchangerate`: Exchange rate for consolidation
- **NO** `accountingbook` field - rates are NOT book-specific

**How Rates Are Populated:**
- NetSuite's Currency Exchange Rate Integration (automatic daily updates)
- Manual entry via Setup → Accounting → Manage Exchange Rates
- CSV import via SuiteScript or third-party integrations

**Custom Exchange Rates in ConsolidatedExchangeRate:**
- Users CAN manually set rates in `ConsolidatedExchangeRate` table
- These become the "default" rates for consolidation
- `BUILTIN.CONSOLIDATE` with `'DEFAULT'` will use these rates
- **This is how custom rates are supported** - they must be in `ConsolidatedExchangeRate` table

### Limitations

**1. Transaction-Specific Custom Rates:**
- ❌ **NOT SUPPORTED** - `BUILTIN.CONSOLIDATE` does not use transaction-specific exchange rates
- Transaction-level custom rates are used for transaction posting, not consolidation

**2. Accounting Book-Specific Rates:**
- ❌ **NOT SUPPORTED** - `ConsolidatedExchangeRate` table has no `accountingbook` field
- Exchange rates are subsidiary/currency/period-specific, not book-specific
- All accounting books use the same exchange rates for consolidation

**3. Custom Exchange Rate Type Parameter:**
- ⚠️ **UNCLEAR** - NetSuite SuiteQL documentation does not document alternatives to `'DEFAULT'`
- `'CUSTOM'` may exist but is not documented
- Research needed: Does NetSuite support custom exchange rate types in `BUILTIN.CONSOLIDATE`?

### How to Use Custom Exchange Rates (If Needed)

**Option 1: Manual Entry in ConsolidatedExchangeRate Table**
- Navigate to Setup → Accounting → Manage Exchange Rates
- Manually set exchange rates for specific periods/subsidiaries
- `BUILTIN.CONSOLIDATE` will use these rates (they become the "default" for that period)

**Option 2: CSV Import via SuiteScript**
- Import custom rates into `ConsolidatedExchangeRate` table
- Rates become available for `BUILTIN.CONSOLIDATE` with `'DEFAULT'` parameter

**Option 3: Third-Party Integration**
- Use integrations (e.g., OANDA, Coefficient) to populate `ConsolidatedExchangeRate` table
- Rates automatically used by `BUILTIN.CONSOLIDATE`

**What Does NOT Work:**
- Setting custom rates on individual transactions (not used by consolidation)
- Accounting book-specific rates (not supported by NetSuite)
- Different rates per accounting book (all books use same rates)

---

## 3. Research Findings

### Accounting Book: ✅ Fully Supported

**Evidence:**
1. Parameter accepted in controller
2. Used in SQL WHERE clause to filter transactions
3. Included in cache key
4. Works identically to BALANCE function

**No limitations identified.**

### Custom Exchange Rates: ⚠️ Limited Support

**What IS Supported:**
- Custom rates in `ConsolidatedExchangeRate` table (manual entry or import)
- These rates are used by `BUILTIN.CONSOLIDATE` with `'DEFAULT'` parameter
- Period-specific and subsidiary-specific rates

**What Is NOT Supported:**
- Transaction-specific custom rates (not used by `BUILTIN.CONSOLIDATE`)
- Accounting book-specific rates (not supported by NetSuite)
- Different rates per accounting book (all books use same consolidation rates)

**Unknown:**
- Does `BUILTIN.CONSOLIDATE` support exchange rate type parameter other than `'DEFAULT'`?
- NetSuite SuiteQL documentation does not document alternatives
- Research needed: Test if `'CUSTOM'` or other values work

---

## 4. Recommendations

### For Accounting Book Support

✅ **No action needed** - accounting book is already fully supported and working.

### For Custom Exchange Rates

**If users need custom exchange rates:**

1. **Document the limitation:**
   - Transaction-specific custom rates are not used by consolidation
   - All consolidation uses rates from `ConsolidatedExchangeRate` table
   - Accounting book-specific rates are not supported

2. **Provide guidance:**
   - How to manually set rates in `ConsolidatedExchangeRate` table
   - How to import rates via CSV or SuiteScript
   - How to use third-party integrations

3. **Future research:**
   - Test if `BUILTIN.CONSOLIDATE` supports exchange rate type parameter other than `'DEFAULT'`
   - Research NetSuite SuiteQL documentation for exchange rate type options
   - Test with NetSuite support if custom exchange rate types are supported

---

## 5. Technical Details

### BUILTIN.CONSOLIDATE Parameters

```sql
BUILTIN.CONSOLIDATE(
    amount,              -- 1: tal.amount (transaction amount)
    'LEDGER',           -- 2: Amount type (always 'LEDGER')
    'DEFAULT',          -- 3: Exchange rate type ← KEY FOR CUSTOM RATES
    'DEFAULT',          -- 4: Consolidation type
    targetSub,          -- 5: Target subsidiary ID (consolidation root)
    targetPeriodId,     -- 6: Period ID for exchange rate lookup
    'DEFAULT'           -- 7: Elimination handling
)
```

**Exchange Rate Type (3rd parameter):**
- Current: `'DEFAULT'` (uses `ConsolidatedExchangeRate` table)
- Unknown: Are other values supported? (`'CUSTOM'`, `'AVERAGE'`, etc.)
- Research needed: NetSuite SuiteQL documentation does not specify alternatives

### ConsolidatedExchangeRate Table Query

**Current Implementation:**
```sql
SELECT 
    cer.tosubsidiary AS consolidationRootId,
    s.name AS consolidationRootName,
    c.symbol AS currency,
    c.id AS currencyId
FROM ConsolidatedExchangeRate cer
JOIN Subsidiary s ON s.id = cer.tosubsidiary
JOIN Currency c ON c.id = s.currency
WHERE cer.fromsubsidiary = {filteredSubId}
  AND UPPER(c.symbol) = UPPER('{currencyCode}')
  AND s.iselimination = 'F'
```

**What This Finds:**
- Valid consolidation paths from filtered subsidiary to consolidation root
- Exchange rates are stored in `ConsolidatedExchangeRate` table
- Rates are period-specific (looked up by period ID in `BUILTIN.CONSOLIDATE`)

**What's Missing:**
- No `accountingbook` field in `ConsolidatedExchangeRate` table
- Rates are NOT book-specific
- All accounting books use same consolidation rates

---

## 6. Conclusion

### Accounting Book: ✅ **FULLY SUPPORTED**

**Status:** Already implemented and working  
**Limitations:** None identified  
**Action Required:** None

### Custom Exchange Rates: ⚠️ **LIMITED SUPPORT**

**Important Principle:** BALANCECURRENCY applies NetSuite's consolidation logic at the presentation layer. It does not override transaction posting logic or introduce alternate FX assumptions. All exchange rates come from NetSuite's `ConsolidatedExchangeRate` table, ensuring consistency with NetSuite's native consolidation behavior.

**What Works:**
- Custom rates in `ConsolidatedExchangeRate` table (manual or imported)
- Period-specific and subsidiary-specific rates
- Used by `BUILTIN.CONSOLIDATE` with `'DEFAULT'` parameter

**What Doesn't Work:**
- Transaction-specific custom rates (not used by consolidation)
- Accounting book-specific rates (not supported by NetSuite)
- Different rates per accounting book

**Research Needed:**
- Does `BUILTIN.CONSOLIDATE` support exchange rate type parameter other than `'DEFAULT'`?
- NetSuite SuiteQL documentation does not document alternatives
- May require testing with NetSuite support

---

**Version:** 4.0.6.167  
**Last Updated:** January 12, 2026
