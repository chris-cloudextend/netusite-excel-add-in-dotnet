# Data Flow Summary: Accounting Book Change → Revenue Display

**Last Updated:** January 10, 2026  
**Status:** Historical reference - Documents data flow for accounting book changes and TYPEBALANCE caching

## Overview
This document explains how financial data flows from NetSuite to Excel when an accounting book is changed, specifically focusing on the TYPEBALANCE batch query and cache population mechanism.

**Note:** Section 5 documents a specific debugging issue. If this issue has been resolved, that section serves as historical reference for troubleshooting similar problems.

---

## 1. User Action: Accounting Book Change

### Frontend Detection (`taskpane.html`)

When the user changes the accounting book (cell U3), the `handleSheetChange` event handler is triggered:

```javascript
// Location: taskpane.html, line ~17767
async function handleSheetChange(event) {
    // Detects U3 (accounting book) changes
    if (eventAddr === 'U3') {
        // Shows immediate progress overlay
        // Validates and updates Q3 (subsidiary) synchronously
        // Triggers handleAccountingBookChange()
    }
}
```

**Key Steps:**
1. **Immediate Q3 Update**: Updates subsidiary cell (Q3) to a valid subsidiary for the new book **in the same Excel.run() batch** to prevent race conditions
2. **Transition Flag**: Sets `localStorage` flag `netsuite_book_transition_` to make validation lenient for 5 seconds
3. **Triggers Sync**: Calls `handleAccountingBookChange()` which eventually calls `performCFOSync()`

---

## 2. Backend Query: Batch Type Balance Refresh

### API Endpoint
**POST** `/batch/typebalance_refresh`

### Request Payload
```json
{
    "year": "2025",
    "subsidiary": "Celigo India Pvt Ltd",
    "department": null,
    "location": null,
    "class": null,
    "accountingBook": "2"
}
```

### Backend Processing (`TypeBalanceController.cs`)

**Location**: `backend-dotnet/Controllers/TypeBalanceController.cs`, method `BatchTypeBalanceRefresh`

#### Step 1: Resolve Subsidiary and Hierarchy
```csharp
// Line ~95-100
var subsidiaryId = await _lookupService.ResolveSubsidiaryIdAsync(request.Subsidiary);
var targetSub = subsidiaryId ?? "1";
var hierarchySubs = await _lookupService.GetSubsidiaryHierarchyAsync(targetSub);
var subFilter = string.Join(", ", hierarchySubs); // e.g., "123" for single subsidiary
```

#### Step 2: Build Dynamic Query with Period Pivoting

The query uses **CASE WHEN** to pivot by period, creating one column per month:

```sql
SELECT 
    a.accttype AS account_type,
    SUM(CASE WHEN t.postingperiod = {periodId1} THEN 
        COALESCE(
            TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', {targetSub}, t.postingperiod, 'DEFAULT')),
            TO_NUMBER(tal.amount)
        )
        * CASE WHEN a.accttype IN ('Income', 'OthIncome') THEN -1 ELSE 1 END
    ELSE 0 END) AS jan,
    SUM(CASE WHEN t.postingperiod = {periodId2} THEN ...) AS feb,
    -- ... 12 columns total (one per month)
FROM transactionaccountingline tal
JOIN transaction t ON t.id = tal.transaction
JOIN account a ON a.id = tal.account
JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
WHERE t.posting = 'T'
  AND tal.posting = 'T'
  AND a.accttype IN ('Income', 'COGS', 'Expense', 'OthIncome', 'OthExpense')
  AND a.isinactive = 'F'
  AND t.postingperiod IN ({periodFilter})  -- All 12 period IDs
  AND tal.accountingbook = {accountingBook}  -- e.g., 2
  AND tl.subsidiary IN ({subFilter})  -- e.g., "123"
GROUP BY a.accttype
ORDER BY a.accttype
```

**Key Query Features:**
- **BUILTIN.CONSOLIDATE**: Handles multi-currency consolidation (returns NULL for single subsidiaries, hence COALESCE fallback)
- **Sign Flip**: Income accounts multiplied by -1 (NetSuite stores credits as negative)
- **Period Pivoting**: One query returns all 5 account types × 12 months = 60 data points

#### Step 3: Query Execution and Result Parsing

```csharp
// Line ~214
var result = await _netSuiteService.QueryRawWithErrorAsync(query);

// Line ~228-234
var rows = result.Items;  // One row per account type (Income, COGS, Expense, etc.)
var returnedTypes = rows.Select(r => r.TryGetProperty("account_type", out var t) ? t.GetString() : "");
```

**Query Result Structure:**
```json
[
    {
        "account_type": "Income",
        "jan": 0.00,
        "feb": 0.00,
        "mar": 53203965.07,
        "apr": 143480988.56,
        // ... 12 month columns
    },
    {
        "account_type": "COGS",
        "jan": 0.00,
        // ...
    },
    // ... other account types
]
```

#### Step 4: Transform to Period-Based Dictionary

```csharp
// Line ~282-320
var monthMapping = new Dictionary<string, string>();  // "jan" -> "Jan 2025"
var balances = new Dictionary<string, Dictionary<string, decimal>>();

foreach (var row in rows) {
    var acctType = row.TryGetProperty("account_type", out var typeProp) ? typeProp.GetString() : "";
    balances[acctType] = new Dictionary<string, decimal>();
    
    foreach (var (colName, periodName) in monthMapping) {
        decimal amount = 0;
        if (row.TryGetProperty(colName, out var amountProp)) {
            // Parse amount from JSON
        }
        balances[acctType][periodName] = amount;
    }
}
```

**Final Response Structure:**
```json
{
    "balances": {
        "Income": {
            "Jan 2025": 0.00,
            "Feb 2025": 0.00,
            "Mar 2025": 53203965.07,
            "Apr 2025": 143480988.56,
            // ... 12 periods
        },
        "COGS": { ... },
        "Expense": { ... },
        // ... other types
    }
}
```

---

## 3. Frontend Cache Population (`taskpane.html`)

### API Call
```javascript
// Location: taskpane.html, line ~19790
const typeBalanceResponse = await fetch(`${getServerUrl()}/batch/typebalance_refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(typeBalancePayload)
});

const typeBalanceData = await typeBalanceResponse.json();
const balances = typeBalanceData.balances || {};
```

### Cache Key Construction

**Location**: `taskpane.html`, line ~19863-19894

```javascript
for (const [acctType, monthData] of Object.entries(balances)) {
    for (const [period, value] of Object.entries(monthData)) {
        // Normalize period: "JAN 2025" -> "Jan 2025"
        let normalizedPeriod = period.trim();
        if (/^[A-Za-z]{3}\s+\d{4}$/.test(normalizedPeriod)) {
            const parts = normalizedPeriod.split(/\s+/);
            const normalizedMonth = parts[0].charAt(0).toUpperCase() + parts[0].slice(1).toLowerCase();
            normalizedPeriod = `${normalizedMonth} ${parts[1]}`;
        }
        
        // Build cache key matching TYPEBALANCE function format
        const cacheKey = `typebalance:${acctType}:${normalizedPeriod}:${normalizedPeriod}:${subsidiaryStr}:${deptStr}:${locStr}:${classStr}:${bookStr}:0`;
        cacheEntries[cacheKey] = value || 0;
    }
}
```

**Cache Key Format:**
```
typebalance:{accountType}:{fromPeriod}:{toPeriod}:{subsidiary}:{department}:{location}:{class}:{book}:{specialFlag}
```

**Example:**
```
typebalance:Income:Mar 2025:Mar 2025:Celigo India Pvt Ltd::::2:0
```

### localStorage Storage

```javascript
// Location: taskpane.html, line ~19972-19979
const storageData = {
    balances: cacheEntries,
    timestamp: Date.now(),
    year: targetYear,
    subsidiary: currentSubsidiary
};
localStorage.setItem('netsuite_typebalance_cache', JSON.stringify(storageData));
localStorage.setItem('netsuite_typebalance_cache_timestamp', Date.now().toString());
```

---

## 4. Formula Evaluation (`functions.js`)

### TYPEBALANCE Function Call

When Excel recalculates `XAVI.TYPEBALANCE("Income", "Mar 2025", "Mar 2025", ...)` formulas:

**Location**: `functions.js`, line ~10350-10400

```javascript
function TYPEBALANCE(accountType, fromPeriod, toPeriod, subsidiary, department, location, classId, accountingBook, useSpecial) {
    // Normalize inputs (trim, convert to string)
    const normalizedType = (accountType || '').trim();
    const convertedFromPeriod = normalizePeriodKey((fromPeriod || '').trim());
    const convertedToPeriod = normalizePeriodKey((toPeriod || '').trim());
    const subsidiaryStr = (subsidiary || '').trim();
    const bookStr = String(accountingBook || '').trim();
    
    // Build cache key (must match taskpane.html format exactly!)
    const cacheKey = `typebalance:${normalizedType}:${convertedFromPeriod}:${convertedToPeriod}:${subsidiaryStr}:${deptStr}:${locStr}:${classStr}:${bookStr}:${specialFlag}`;
    
    // Check in-memory cache first
    if (cache.typebalance && cache.typebalance[cacheKey] !== undefined) {
        return cache.typebalance[cacheKey];
    }
    
    // Check localStorage (populated by taskpane.html)
    const stored = localStorage.getItem('netsuite_typebalance_cache');
    if (stored) {
        const storageData = JSON.parse(stored);
        const storedBalances = storageData.balances || {};
        
        if (storedBalances[cacheKey] !== undefined) {
            // Populate in-memory cache for future lookups
            if (!cache.typebalance) cache.typebalance = {};
            cache.typebalance = { ...cache.typebalance, ...storedBalances };
            return storedBalances[cacheKey];
        }
    }
    
    // Cache miss - make individual API call
    // ... (fallback to /type-balance endpoint)
}
```

---

## 5. Current Issue: Income Returns $0.00

### Problem
The batch query returns **$0.00 for all Income periods** even though:
- ✅ COGS and Expenses return correct values
- ✅ Individual TYPEBALANCE queries return correct Income values
- ✅ Backend logs show Income row exists but all month values are 0.00

### Investigation Needed

**Check Server Logs For:**
1. **Query Execution**: Does the query actually find Income transactions?
   - Look for: `🔍 [REVENUE DEBUG] Full SQL Query:` in server logs
   - Verify: `tl.subsidiary IN ({subFilter})` includes the correct subsidiary ID
   - Verify: `tal.accountingbook = {accountingBook}` is correct (e.g., `= 2`)

2. **Query Results**: What does NetSuite actually return?
   - Look for: `🔍 [REVENUE DEBUG] Income row found - checking values...`
   - Check: `Income {Month}: {Value:N2}` logs - are they all 0.00?

3. **BUILTIN.CONSOLIDATE Behavior**: 
   - Does `BUILTIN.CONSOLIDATE` return NULL for Income but not for COGS/Expense?
   - Does `COALESCE` fallback to `tal.amount` work correctly?

### Potential Causes

1. **Income Account Filtering**: Income accounts might be filtered out by `a.isinactive = 'F'` or other WHERE conditions
2. **Sign Flip Issue**: Income amounts might be stored differently (already positive vs. negative)
3. **Period Mapping**: Month column names might not match between query and result parsing
4. **BUILTIN.CONSOLIDATE NULL Handling**: COALESCE might not be working as expected for Income

---

## 6. Data Flow Diagram

```
User Changes U3 (Accounting Book)
    ↓
handleSheetChange() detects change
    ↓
Update Q3 (Subsidiary) synchronously
    ↓
handleAccountingBookChange()
    ↓
performCFOSync()
    ↓
POST /batch/typebalance_refresh
    ↓
TypeBalanceController.BatchTypeBalanceRefresh()
    ↓
NetSuite SuiteQL Query (BUILTIN.CONSOLIDATE + COALESCE)
    ↓
Query Results: { "Income": { "Mar 2025": 0.00, ... }, ... }
    ↓
Transform to period-based dictionary
    ↓
JSON Response to Frontend
    ↓
taskpane.html: Build cache keys and store in localStorage
    ↓
localStorage: netsuite_typebalance_cache = { balances: { ... } }
    ↓
Excel Recalculates TYPEBALANCE formulas
    ↓
functions.js: TYPEBALANCE() reads from localStorage
    ↓
Excel Cells Display Values
```

---

## 7. Key Files and Line Numbers

| Component | File | Key Lines |
|-----------|------|-----------|
| **Frontend: Book Change Detection** | `docs/taskpane.html` | ~17767-18100 |
| **Frontend: API Call** | `docs/taskpane.html` | ~19790-19800 |
| **Frontend: Cache Population** | `docs/taskpane.html` | ~19863-19979 |
| **Frontend: Formula Evaluation** | `docs/functions.js` | ~10350-10400 |
| **Backend: Query Building** | `backend-dotnet/Controllers/TypeBalanceController.cs` | ~140-204 |
| **Backend: Result Parsing** | `backend-dotnet/Controllers/TypeBalanceController.cs` | ~282-320 |

---

## 8. Next Steps for Debugging

1. **Check Server Logs**: Review `🔍 [REVENUE DEBUG]` logs to see actual query and results
2. **Compare Queries**: Compare the batch query structure with individual TYPEBALANCE queries that work
3. **Test Query Directly**: Run the batch query manually in NetSuite to see raw results
4. **Verify Income Accounts**: Confirm Income accounts are active and have transactions for book 2

