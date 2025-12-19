# Special Formulas Reference (RETAINEDEARNINGS, NETINCOME, CTA)

This document explains how the three special formulas work, their relationship to BALANCE formulas, the refresh sequencing logic, and the complete SuiteQL queries.

---

## Overview

These three formulas calculate values that **NetSuite computes dynamically at runtime** - there are no account numbers to query directly:

| Formula | What it Calculates | Backend Endpoint |
|---------|-------------------|------------------|
| `XAVI.RETAINEDEARNINGS` | Cumulative P&L from inception through prior fiscal year end | `/retained-earnings` |
| `XAVI.NETINCOME` | Current fiscal year P&L through target period | `/net-income` |
| `XAVI.CTA` | Cumulative Translation Adjustment (multi-currency plug) | `/cta` |

---

## Why These Are "Special"

Unlike `XAVI.BALANCE` which queries a specific account number, these formulas:
1. **Have no account number** - NetSuite calculates them on-the-fly
2. **Require complex queries** - Each makes its own backend API call
3. **Depend on BALANCE data** - Conceptually, they complete the Balance Sheet after BALANCE accounts are loaded

---

## Formula Signatures

### RETAINEDEARNINGS
```javascript
XAVI.RETAINEDEARNINGS(period, [subsidiary], [accountingBook], [classId], [department], [location])
```
- **period**: Required. e.g., "Mar 2025"
- **subsidiary**: Optional. Subsidiary ID or name
- **accountingBook**: Optional. Defaults to Primary Book
- **classId, department, location**: Optional segment filters

**Backend Logic (server.py):**
```
RE = Sum of all P&L from inception through prior fiscal year end
   + Any manual journal entries posted directly to RetainedEarnings accounts
```

### NETINCOME
```javascript
XAVI.NETINCOME(period, [subsidiary], [accountingBook], [classId], [department], [location])
```
Same signature as RETAINEDEARNINGS.

**Backend Logic:**
```
NI = Sum of all P&L transactions from FY start through target period end
```

### CTA (Cumulative Translation Adjustment)
```javascript
XAVI.CTA(period, [subsidiary], [accountingBook])
```
- **Note**: CTA omits segment filters because translation adjustments apply at entity level only.

**Backend Logic (PLUG METHOD for 100% accuracy):**
```
CTA = (Total Assets - Total Liabilities) - Posted Equity - RE - NI
```

---

## Caching Architecture

All three formulas use the same caching infrastructure as BALANCE:

### Cache Storage
```javascript
// In functions.js
const cache = {
    balance: new Map(),  // Also stores special formula results!
    title: new Map(),
    budget: new Map(),
    type: new Map(),
    parent: new Map()
};
```

### Cache Keys
Each formula type uses a distinct prefix:
```javascript
// RETAINEDEARNINGS
cacheKey = `retainedearnings:${period}:${subsidiary}:${accountingBook}:${classId}:${department}:${location}`;

// NETINCOME  
cacheKey = `netincome:${period}:${subsidiary}:${accountingBook}:${classId}:${department}:${location}`;

// CTA (no segment filters)
cacheKey = `cta:${period}:${subsidiary}:${accountingBook}`;
```

### In-Flight Request Deduplication
Because these formulas make expensive API calls, we prevent duplicate concurrent requests:

```javascript
// In functions.js
const inFlightRequests = new Map();

// Example from RETAINEDEARNINGS:
if (inFlightRequests.has(cacheKey)) {
    console.log(`⏳ Waiting for in-flight request [retained earnings]: ${period}`);
    return await inFlightRequests.get(cacheKey);
}

// Store promise BEFORE awaiting
const requestPromise = (async () => {
    try {
        const response = await fetch(`${SERVER_URL}/retained-earnings`, {...});
        // ... process response ...
    } finally {
        inFlightRequests.delete(cacheKey);  // Remove when done
    }
})();

inFlightRequests.set(cacheKey, requestPromise);
return await requestPromise;
```

---

## Refresh Sequencing

### The Problem (Before Fix)
When "Refresh All" ran, ALL formulas (BALANCE + special) would fire simultaneously. This meant special formulas weren't guaranteed to have fresh BALANCE data.

### The Solution (Current Implementation)

**"Refresh All" in taskpane.html now follows this sequence:**

```
STEP 1: Scan sheet for ALL XAVI formulas
        ├── XAVI.BALANCE formulas → stored in cellsToUpdate[]
        └── XAVI.RETAINEDEARNINGS/NETINCOME/CTA → stored in specialFormulas[]

STEP 2: Classify accounts (P&L vs Balance Sheet)

STEP 3: Clear all caches (including inFlightRequests)

STEP 4: Fetch P&L accounts (fast, ~30s/year)

STEP 5: Fetch Balance Sheet accounts (slower, 2-3 min)

STEP 6: Re-evaluate BALANCE formulas (in batches of 100)
        └── Forces Excel to recalculate with fresh cache

*** 500ms PAUSE to ensure cache is fully populated ***

STEP 7: Re-evaluate SPECIAL formulas (in batches of 50)
        └── These run AFTER all BALANCE data is loaded
        └── Forces fresh API calls to /retained-earnings, /net-income, /cta
```

### Key Code: Scanning for Special Formulas

```javascript
// In taskpane.html refreshCurrentSheet()
let cellsToUpdate = [];   // BALANCE formulas
let specialFormulas = []; // RETAINEDEARNINGS, NETINCOME, CTA formulas

for (let row = 0; row < rowCount; row++) {
    for (let col = 0; col < colCount; col++) {
        const formula = formulas[row][col];
        if (formula && typeof formula === 'string') {
            const upperFormula = formula.toUpperCase();
            
            // BALANCE formulas - refresh first
            if (upperFormula.includes('XAVI.BALANCE')) {
                cellsToUpdate.push({ row, col, formula });
                // ... extract account for classification ...
            }
            
            // Special formulas - refresh AFTER BALANCE data is loaded
            if (upperFormula.includes('XAVI.RETAINEDEARNINGS') ||
                upperFormula.includes('XAVI.NETINCOME') ||
                upperFormula.includes('XAVI.CTA')) {
                const formulaType = upperFormula.includes('RETAINEDEARNINGS') ? 'RETAINEDEARNINGS' :
                                   upperFormula.includes('NETINCOME') ? 'NETINCOME' : 'CTA';
                specialFormulas.push({ row, col, formula, type: formulaType });
            }
        }
    }
}
```

### Key Code: Sequential Refresh

```javascript
// After BALANCE formulas are refreshed (Step 6)...

// ============================================
// STEP 7: Refresh special formulas AFTER BALANCE data is loaded
// These depend on BALANCE data, so they must run second
// ============================================
let specialFormulasRefreshed = 0;

if (specialFormulas.length > 0) {
    console.log(`📊 Refreshing ${specialFormulas.length} special formulas...`);
    
    // Small delay to ensure BALANCE cache is fully populated
    await new Promise(resolve => setTimeout(resolve, 500));
    
    await Excel.run(async (context) => {
        const sheet = context.workbook.worksheets.getActiveWorksheet();
        const usedRange = sheet.getUsedRange();
        
        const BATCH_SIZE = 50; // Smaller batch for special formulas
        
        for (let batchNum = 0; batchNum < totalBatches; batchNum++) {
            const batch = specialFormulas.slice(batchStart, batchEnd);
            
            for (const { row, col, formula, type } of batch) {
                const cell = usedRange.getCell(row, col);
                cell.formulas = [[formula]];
                specialFormulasRefreshed++;
            }
            
            await context.sync();
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        usedRange.calculate();
        await context.sync();
    });
}
```

### Key Code: Cache Clearing

```javascript
// In functions.js window.clearAllCaches()
window.clearAllCaches = function() {
    console.log('🗑️  CLEARING ALL CACHES...');
    
    cache.balance.clear();
    cache.title.clear();
    cache.budget.clear();
    cache.type.clear();
    cache.parent.clear();
    
    // Clear in-flight requests for special formulas (RETAINEDEARNINGS, NETINCOME, CTA)
    // This ensures fresh API calls will be made when formulas re-evaluate
    if (inFlightRequests && inFlightRequests.size > 0) {
        console.log(`  Clearing ${inFlightRequests.size} in-flight requests...`);
        inFlightRequests.clear();
    }
    
    // Reset stats
    cacheStats.hits = 0;
    cacheStats.misses = 0;
    
    console.log('✅ ALL CACHES CLEARED');
    return true;
};
```

---

## Registration

All three functions are registered with Excel's CustomFunctions API:

```javascript
// In functions.js
if (typeof CustomFunctions !== 'undefined') {
    CustomFunctions.associate('RETAINEDEARNINGS', RETAINEDEARNINGS);
    CustomFunctions.associate('NETINCOME', NETINCOME);
    CustomFunctions.associate('CTA', CTA);
    // ... other functions ...
}
```

---

## Drag/Copy Behavior

When users **drag or copy** formulas (without using Refresh All):

1. Excel triggers each formula independently
2. BALANCE formulas check cache first (usually a hit after initial load)
3. Special formulas also check cache first
4. If cache miss, each makes its own API call
5. In-flight deduplication prevents duplicate concurrent calls

**Important:** There is no guaranteed ordering when dragging. However:
- If BALANCE data was previously loaded (cached), special formulas will get fresh data
- If not cached, all formulas fire in parallel (Excel's native behavior)

**Recommendation:** For consistent results, use "Refresh All" to ensure BALANCE data loads before special formulas evaluate.

---

## Summary Status Display

After refresh, the status shows all formula types:
```javascript
if (specialFormulasRefreshed > 0) {
    summaryParts.push(`Special: ${specialFormulasRefreshed}`);
}

// Example: "P&L: 2 year(s) • Balance Sheet: 45 accounts • Special: 3"
```

---

# SuiteQL Queries — Complete Reference

## Account Type Constants

From `backend/constants.py`:

```python
class AccountType:
    # BALANCE SHEET - ASSETS (Debit balance, stored positive, NO sign flip)
    BANK = 'Bank'
    ACCT_REC = 'AcctRec'
    OTHER_CURR_ASSET = 'OthCurrAsset'
    FIXED_ASSET = 'FixedAsset'
    OTHER_ASSET = 'OthAsset'
    DEFERRED_EXPENSE = 'DeferExpense'
    UNBILLED_REC = 'UnbilledRec'
    
    # BALANCE SHEET - LIABILITIES (Credit balance, stored negative, FLIP × -1)
    ACCT_PAY = 'AcctPay'
    CRED_CARD = 'CredCard'          # NOT 'CreditCard'!
    OTHER_CURR_LIAB = 'OthCurrLiab'
    LONG_TERM_LIAB = 'LongTermLiab'
    DEFERRED_REVENUE = 'DeferRevenue'
    
    # BALANCE SHEET - EQUITY (Credit balance, stored negative, FLIP × -1)
    EQUITY = 'Equity'
    RETAINED_EARNINGS = 'RetainedEarnings'
    
    # P&L - INCOME (Credit balance, stored negative, FLIP × -1)
    INCOME = 'Income'
    OTHER_INCOME = 'OthIncome'
    
    # P&L - EXPENSES (Debit balance, stored positive, NO sign flip)
    COGS = 'COGS'                           # Modern
    COST_OF_GOODS_SOLD = 'Cost of Goods Sold'  # Legacy - INCLUDE BOTH!
    EXPENSE = 'Expense'
    OTHER_EXPENSE = 'OthExpense'

# SQL-ready string for P&L types
PL_TYPES_SQL = "'COGS', 'Cost of Goods Sold', 'Expense', 'Income', 'OthExpense', 'OthIncome'"
```

**IMPORTANT:** NetSuite uses BOTH `'COGS'` AND `'Cost of Goods Sold'` in different contexts. Always include both!

---

## Sign Convention Reference

| Account Type | Stored in NetSuite | Reporting Display | Query Multiply |
|--------------|-------------------|-------------------|----------------|
| Assets (Bank, AcctRec, etc.) | Positive (debit) | Positive | × 1 |
| Liabilities (AcctPay, etc.) | Negative (credit) | Positive | × -1 |
| Equity | Negative (credit) | Positive | × -1 |
| Income | Negative (credit) | Positive | × -1 |
| Expenses (COGS, Expense) | Positive (debit) | Positive | × 1 |

**For P&L totals:** ALL P&L × -1 = Revenue positive, Expenses become negative → Net = Profit or Loss

---

## BUILTIN.CONSOLIDATE() Explained

NetSuite's function for multi-currency consolidation:

```sql
BUILTIN.CONSOLIDATE(
    tal.amount,           -- Source amount in transaction currency
    'LEDGER',             -- Amount type (use ledger/book amounts)
    'DEFAULT',            -- Exchange rate type
    'DEFAULT',            -- Consolidation type
    {target_sub},         -- Target subsidiary ID for consolidation
    {target_period_id},   -- Period ID for exchange rate (CRITICAL!)
    'DEFAULT'             -- Elimination handling
)
```

**CRITICAL:** The `target_period_id` parameter determines which exchange rate is used:
- **Correct:** Use the report period ID → all amounts translated at same period-end rate
- **Wrong:** Using `t.postingperiod` → each transaction uses its own posting period rate (inconsistent)

---

## 1. RETAINEDEARNINGS — `/retained-earnings`

**Formula:**
```
RE = Prior Years' P&L + Posted RE Adjustments
```

### Backend Endpoint (server.py)

```python
@app.route('/retained-earnings', methods=['POST'])
def calculate_retained_earnings():
    """
    Calculate Retained Earnings (prior years' cumulative P&L)
    
    RE = Sum of all P&L transactions from inception through prior fiscal year end
       + Any manual journal entries posted directly to RetainedEarnings accounts
    
    Request body: {
        period: "Mar 2025",
        subsidiary: "1" or "Celigo Inc." (optional),
        accountingBook: "1" (optional),
        classId: "1" (optional),
        department: "1" (optional),
        location: "1" (optional)
    }
    """
```

### Query 1: Prior Years' P&L

Sums ALL P&L transactions from inception through the day **before** the current fiscal year started:

```sql
SELECT SUM(
    TO_NUMBER(BUILTIN.CONSOLIDATE(
        tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', 
        {target_sub}, {target_period_id}, 'DEFAULT'
    )) * -1
) AS value
FROM transactionaccountingline tal
JOIN transaction t ON t.id = tal.transaction
JOIN account a ON a.id = tal.account
JOIN accountingperiod ap ON ap.id = t.postingperiod
WHERE t.posting = 'T'
  AND tal.posting = 'T'
  AND a.accttype IN ('COGS', 'Cost of Goods Sold', 'Expense', 'Income', 'OthExpense', 'OthIncome')
  AND ap.enddate < TO_DATE('{fy_start_date}', 'YYYY-MM-DD')
  AND tal.accountingbook = {accountingbook}
  {segment_where}  -- Optional: AND t.subsidiary = X AND tl.department = Y etc.
```

**Key points:**
- `ap.enddate < fy_start_date` — Only transactions in PRIOR fiscal years
- `* -1` — Flip P&L signs (credits become positive revenue)

### Query 2: Posted RE Adjustments

Sums any manual journal entries posted directly to RetainedEarnings accounts:

```sql
SELECT SUM(
    TO_NUMBER(BUILTIN.CONSOLIDATE(
        tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', 
        {target_sub}, {target_period_id}, 'DEFAULT'
    )) * -1
) AS value
FROM transactionaccountingline tal
JOIN transaction t ON t.id = tal.transaction
JOIN account a ON a.id = tal.account
JOIN accountingperiod ap ON ap.id = t.postingperiod
WHERE t.posting = 'T'
  AND tal.posting = 'T'
  AND (a.accttype = 'RetainedEarnings' OR LOWER(a.fullname) LIKE '%retained earnings%')
  AND ap.enddate <= TO_DATE('{period_end_date}', 'YYYY-MM-DD')
  AND tal.accountingbook = {accountingbook}
  {segment_where}
```

**Key points:**
- Catches both `accttype = 'RetainedEarnings'` AND accounts with "retained earnings" in the name
- Uses `<= period_end_date` (includes all adjustments through target period)

### Parallel Execution

Both queries run concurrently using `ThreadPoolExecutor(max_workers=2)`:

```python
with ThreadPoolExecutor(max_workers=2) as executor:
    futures = {
        executor.submit(query_with_retry, 'prior_pl', prior_pl_query): 'prior_pl',
        executor.submit(query_with_retry, 'posted_re', posted_re_query): 'posted_re'
    }
    for future in as_completed(futures):
        name = futures[future]
        result = future.result()
        # ... process results ...

# Final calculation
retained_earnings = prior_pl + posted_re
```

---

## 2. NETINCOME — `/net-income`

**Formula:**
```
NI = Sum of all P&L from fiscal year start through target period end
```

### Backend Endpoint (server.py)

```python
@app.route('/net-income', methods=['POST'])
def calculate_net_income():
    """
    Calculate Net Income (current fiscal year P&L through target period)
    
    NI = Sum of all P&L transactions from FY start through target period end
    
    Request body: {
        period: "Mar 2025",
        subsidiary: "1" or "Celigo Inc." (optional),
        accountingBook: "1" (optional),
        classId: "1" (optional),
        department: "1" (optional),
        location: "1" (optional)
    }
    """
```

### Single Query

```sql
SELECT SUM(
    TO_NUMBER(BUILTIN.CONSOLIDATE(
        tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', 
        {target_sub}, {target_period_id}, 'DEFAULT'
    )) * -1
) AS net_income
FROM transactionaccountingline tal
JOIN transaction t ON t.id = tal.transaction
JOIN account a ON a.id = tal.account
JOIN accountingperiod ap ON ap.id = t.postingperiod
WHERE t.posting = 'T'
  AND tal.posting = 'T'
  AND a.accttype IN ('COGS', 'Cost of Goods Sold', 'Expense', 'Income', 'OthExpense', 'OthIncome')
  AND ap.startdate >= TO_DATE('{fy_start_date}', 'YYYY-MM-DD')
  AND ap.enddate <= TO_DATE('{period_end_date}', 'YYYY-MM-DD')
  AND tal.accountingbook = {accountingbook}
  {segment_where}
```

**Key difference from RE:**
- Uses `ap.startdate >= fy_start_date` — Only CURRENT fiscal year
- Uses `ap.enddate <= period_end_date` — Through target period

---

## 3. CTA (Cumulative Translation Adjustment) — `/cta`

**Formula (PLUG METHOD):**
```
CTA = (Total Assets - Total Liabilities) - Posted Equity - Retained Earnings - Net Income
```

This is the **only way** to get 100% accuracy because NetSuite calculates additional translation adjustments at runtime that are never posted to accounts.

### Backend Endpoint (server.py)

```python
@app.route('/cta', methods=['POST'])
def calculate_cta():
    """
    Calculate Cumulative Translation Adjustment (CTA) using the PLUG METHOD
    
    CTA = (Total Assets - Total Liabilities) - Posted Equity - RE - NI
    
    This is the only way to get 100% accuracy because NetSuite calculates
    additional translation adjustments at runtime that are never posted to accounts.
    The plug method guarantees the Balance Sheet balances.
    
    Request body: {
        period: "Mar 2025",
        subsidiary: "1" or "Celigo Inc." (optional),
        accountingBook: "1" (optional)
    }
    """
```

**Note:** CTA omits segment filters (classId, department, location) because translation adjustments apply at entity level only.

### 6 Parallel Queries

CTA runs **6 queries in parallel** using `ThreadPoolExecutor(max_workers=3)`:

#### Query 1: Total Assets
```sql
SELECT SUM(
    TO_NUMBER(BUILTIN.CONSOLIDATE(
        tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', 
        {target_sub}, {target_period_id}, 'DEFAULT'
    ))
) AS value
FROM transactionaccountingline tal
JOIN transaction t ON t.id = tal.transaction
JOIN account a ON a.id = tal.account
JOIN accountingperiod ap ON ap.id = t.postingperiod
WHERE t.posting = 'T'
  AND tal.posting = 'T'
  AND a.accttype IN ({BS_ASSET_TYPES_SQL})
  -- Expands to: 'AcctRec', 'Bank', 'DeferExpense', 'FixedAsset', 'OthAsset', 'OthCurrAsset', 'UnbilledRec'
  AND ap.enddate <= TO_DATE('{period_end_date}', 'YYYY-MM-DD')
  AND tal.accountingbook = {accountingbook}
```
**Note:** NO sign flip for assets (debit balance = positive). Uses `BS_ASSET_TYPES_SQL` constant from `constants.py`.

#### Query 2: Total Liabilities
```sql
SELECT SUM(
    TO_NUMBER(BUILTIN.CONSOLIDATE(
        tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', 
        {target_sub}, {target_period_id}, 'DEFAULT'
    )) * -1  -- FLIP sign
) AS value
FROM transactionaccountingline tal
JOIN transaction t ON t.id = tal.transaction
JOIN account a ON a.id = tal.account
JOIN accountingperiod ap ON ap.id = t.postingperiod
WHERE t.posting = 'T'
  AND tal.posting = 'T'
  AND a.accttype IN ({BS_LIABILITY_TYPES_SQL})
  -- Expands to: 'AcctPay', 'CredCard', 'DeferRevenue', 'LongTermLiab', 'OthCurrLiab'
  AND ap.enddate <= TO_DATE('{period_end_date}', 'YYYY-MM-DD')
  AND tal.accountingbook = {accountingbook}
```
**Note:** × -1 because liabilities are stored as negative credits. Uses `BS_LIABILITY_TYPES_SQL` constant.

#### Query 3: Posted Equity
```sql
SELECT SUM(
    TO_NUMBER(BUILTIN.CONSOLIDATE(...)) * -1  -- FLIP sign
) AS value
FROM transactionaccountingline tal
JOIN transaction t ON t.id = tal.transaction
JOIN account a ON a.id = tal.account
JOIN accountingperiod ap ON ap.id = t.postingperiod
WHERE t.posting = 'T'
  AND tal.posting = 'T'
  AND a.accttype = 'Equity'
  AND LOWER(a.fullname) NOT LIKE '%retained earnings%'  -- Exclude RE accounts!
  AND ap.enddate <= TO_DATE('{period_end_date}', 'YYYY-MM-DD')
  AND tal.accountingbook = {accountingbook}
```

#### Query 4: Prior Years' P&L (= prior portion of RE)
```sql
SELECT SUM(
    TO_NUMBER(BUILTIN.CONSOLIDATE(...)) * -1
) AS value
...
WHERE ...
  AND a.accttype IN ('COGS', 'Cost of Goods Sold', 'Expense', 'Income', 'OthExpense', 'OthIncome')
  AND ap.enddate < TO_DATE('{fy_start_date}', 'YYYY-MM-DD')
```

#### Query 5: Posted RE Adjustments
```sql
SELECT SUM(
    TO_NUMBER(BUILTIN.CONSOLIDATE(...)) * -1
) AS value
...
WHERE ...
  AND (a.accttype = 'RetainedEarnings' OR LOWER(a.fullname) LIKE '%retained earnings%')
  AND ap.enddate <= TO_DATE('{period_end_date}', 'YYYY-MM-DD')
```

#### Query 6: Net Income (current FY P&L)
```sql
SELECT SUM(
    TO_NUMBER(BUILTIN.CONSOLIDATE(...)) * -1
) AS value
...
WHERE ...
  AND a.accttype IN ('COGS', 'Cost of Goods Sold', 'Expense', 'Income', 'OthExpense', 'OthIncome')
  AND ap.startdate >= TO_DATE('{fy_start_date}', 'YYYY-MM-DD')
  AND ap.enddate <= TO_DATE('{period_end_date}', 'YYYY-MM-DD')
```

### Final CTA Calculation

```python
# Extract results from parallel queries
total_assets = results.get('total_assets', 0.0)
total_liabilities = results.get('total_liabilities', 0.0)
posted_equity = results.get('posted_equity', 0.0)
prior_pl = results.get('prior_pl', 0.0)
posted_re = results.get('posted_re', 0.0)
net_income = results.get('net_income', 0.0)

# Derived values
total_equity = total_assets - total_liabilities
retained_earnings = prior_pl + posted_re

# FINAL: CTA as PLUG
cta = total_equity - posted_equity - retained_earnings - net_income
```

**Visual representation:**
```
╔═══════════════════════════════════════════════════════════╗
║  CTA PLUG CALCULATION                                     ║
╠═══════════════════════════════════════════════════════════╣
║  Total Equity (A-L):           XXX,XXX.XX                 ║
║  - Posted Equity:              XXX,XXX.XX                 ║
║  - Retained Earnings:          XXX,XXX.XX                 ║
║  - Net Income:                 XXX,XXX.XX                 ║
║  ─────────────────────────────────────────────────────    ║
║  = CTA (plug):                 XXX,XXX.XX                 ║
╚═══════════════════════════════════════════════════════════╝
```

---

## Rate Limiting & Retry Logic

All queries include retry logic for NetSuite's concurrency limits:

```python
def query_with_retry(name, sql, max_retries=3):
    """Execute query with retry logic for rate limiting"""
    for attempt in range(max_retries):
        result = query_netsuite(sql, 120)
        if isinstance(result, dict) and 'error' in result:
            error_str = str(result.get('details', ''))
            if 'CONCURRENCY_LIMIT_EXCEEDED' in error_str or '429' in error_str:
                wait_time = (attempt + 1) * 2  # 2s, 4s, 6s backoff
                print(f"⏳ {name}: Rate limited, retrying in {wait_time}s...")
                time.sleep(wait_time)
                continue
        return result
    return result  # Return last result even if failed
```

---

## Frontend Formula Code (functions.js)

### RETAINEDEARNINGS Function

```javascript
async function RETAINEDEARNINGS(period, subsidiary, accountingBook, classId, department, location) {
    try {
        // Convert date values to "Mon YYYY" format
        period = convertToMonthYear(period);
        
        if (!period) {
            console.error('RETAINEDEARNINGS: period is required');
            return 0;
        }
        
        // Normalize optional parameters
        subsidiary = String(subsidiary || '').trim();
        accountingBook = String(accountingBook || '').trim();
        classId = String(classId || '').trim();
        department = String(department || '').trim();
        location = String(location || '').trim();
        
        // Build cache key
        const cacheKey = `retainedearnings:${period}:${subsidiary}:${accountingBook}:${classId}:${department}:${location}`;
        
        // Check cache first
        if (cache.balance.has(cacheKey)) {
            cacheStats.hits++;
            console.log(`📥 CACHE HIT [retained earnings]: ${period}`);
            return cache.balance.get(cacheKey);
        }
        
        // Check if there's already a request in-flight for this exact key
        if (inFlightRequests.has(cacheKey)) {
            console.log(`⏳ Waiting for in-flight request [retained earnings]: ${period}`);
            return await inFlightRequests.get(cacheKey);
        }
        
        cacheStats.misses++;
        console.log(`📥 Calculating Retained Earnings for ${period}...`);
        
        // Create the promise and store it BEFORE awaiting
        const requestPromise = (async () => {
            try {
                const response = await fetch(`${SERVER_URL}/retained-earnings`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        period,
                        subsidiary,
                        accountingBook,
                        classId,
                        department,
                        location
                    })
                });
                
                if (!response.ok) {
                    const errorText = await response.text();
                    console.error(`Retained Earnings API error: ${response.status}`, errorText);
                    return 0;
                }
                
                const data = await response.json();
                const value = parseFloat(data.value) || 0;
                
                // Cache the result
                cache.balance.set(cacheKey, value);
                console.log(`✅ Retained Earnings (${period}): ${value.toLocaleString()}`);
                
                return value;
                
            } catch (error) {
                console.error('Retained Earnings fetch error:', error);
                return 0;
            } finally {
                // Remove from in-flight after completion
                inFlightRequests.delete(cacheKey);
            }
        })();
        
        // Store the promise for deduplication
        inFlightRequests.set(cacheKey, requestPromise);
        
        return await requestPromise;
        
    } catch (error) {
        console.error('RETAINEDEARNINGS error:', error);
        return 0;
    }
}
```

### NETINCOME Function

```javascript
async function NETINCOME(period, subsidiary, accountingBook, classId, department, location) {
    try {
        period = convertToMonthYear(period);
        
        if (!period) {
            console.error('NETINCOME: period is required');
            return 0;
        }
        
        // Normalize optional parameters
        subsidiary = String(subsidiary || '').trim();
        accountingBook = String(accountingBook || '').trim();
        classId = String(classId || '').trim();
        department = String(department || '').trim();
        location = String(location || '').trim();
        
        const cacheKey = `netincome:${period}:${subsidiary}:${accountingBook}:${classId}:${department}:${location}`;
        
        if (cache.balance.has(cacheKey)) {
            cacheStats.hits++;
            console.log(`📥 CACHE HIT [net income]: ${period}`);
            return cache.balance.get(cacheKey);
        }
        
        if (inFlightRequests.has(cacheKey)) {
            console.log(`⏳ Waiting for in-flight request [net income]: ${period}`);
            return await inFlightRequests.get(cacheKey);
        }
        
        cacheStats.misses++;
        console.log(`📥 Calculating Net Income for ${period}...`);
        
        const requestPromise = (async () => {
            try {
                const response = await fetch(`${SERVER_URL}/net-income`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        period,
                        subsidiary,
                        accountingBook,
                        classId,
                        department,
                        location
                    })
                });
                
                if (!response.ok) {
                    const errorText = await response.text();
                    console.error(`Net Income API error: ${response.status}`, errorText);
                    return 0;
                }
                
                const data = await response.json();
                const value = parseFloat(data.value) || 0;
                
                cache.balance.set(cacheKey, value);
                console.log(`✅ Net Income (${period}): ${value.toLocaleString()}`);
                
                return value;
                
            } catch (error) {
                console.error('Net Income fetch error:', error);
                return 0;
            } finally {
                inFlightRequests.delete(cacheKey);
            }
        })();
        
        inFlightRequests.set(cacheKey, requestPromise);
        return await requestPromise;
        
    } catch (error) {
        console.error('NETINCOME error:', error);
        return 0;
    }
}
```

### CTA Function

```javascript
async function CTA(period, subsidiary, accountingBook) {
    try {
        period = convertToMonthYear(period);
        
        if (!period) {
            console.error('CTA: period is required');
            return 0;
        }
        
        // Normalize optional parameters
        subsidiary = String(subsidiary || '').trim();
        accountingBook = String(accountingBook || '').trim();
        
        // Build cache key (no segment filters for CTA - entity level only)
        const cacheKey = `cta:${period}:${subsidiary}:${accountingBook}`;
        
        if (cache.balance.has(cacheKey)) {
            cacheStats.hits++;
            console.log(`📥 CACHE HIT [CTA]: ${period}`);
            return cache.balance.get(cacheKey);
        }
        
        if (inFlightRequests.has(cacheKey)) {
            console.log(`⏳ Waiting for in-flight request [CTA]: ${period}`);
            return await inFlightRequests.get(cacheKey);
        }
        
        cacheStats.misses++;
        console.log(`📥 Calculating CTA for ${period}...`);
        
        const requestPromise = (async () => {
            try {
                const response = await fetch(`${SERVER_URL}/cta`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        period,
                        subsidiary,
                        accountingBook
                    })
                });
                
                if (!response.ok) {
                    const errorText = await response.text();
                    console.error(`CTA API error: ${response.status}`, errorText);
                    return 0;
                }
                
                const data = await response.json();
                const value = parseFloat(data.value) || 0;
                
                cache.balance.set(cacheKey, value);
                console.log(`✅ CTA (${period}): ${value.toLocaleString()}`);
                
                return value;
                
            } catch (error) {
                console.error('CTA fetch error:', error);
                return 0;
            } finally {
                inFlightRequests.delete(cacheKey);
            }
        })();
        
        inFlightRequests.set(cacheKey, requestPromise);
        return await requestPromise;
        
    } catch (error) {
        console.error('CTA error:', error);
        return 0;
    }
}
```

---

## Files Modified

| File | What it Contains |
|------|------------------|
| `docs/functions.js` | Frontend formula functions, caching, in-flight deduplication |
| `docs/taskpane.html` | Refresh All logic with special formula sequencing |
| `backend/server.py` | `/retained-earnings`, `/net-income`, `/cta` endpoints with SuiteQL |
| `backend/constants.py` | Account type constants and SQL-ready strings |

---

## Version

*Current Version: 3.0.5.161*
