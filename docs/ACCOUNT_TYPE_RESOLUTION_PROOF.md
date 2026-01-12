# Account Type Resolution Proof: How Account 10010 Resolves as Balance Sheet

## Step 1: Account Type is Fetched (Line 6342-6348)

```6342:6348:docs/functions.js
        const typeCacheKey = getCacheKey('type', { account });
        let accountType = cache.type.has(typeCacheKey) ? cache.type.get(typeCacheKey) : null;
        
        // If not in cache, fetch it (async) - MUST wait before proceeding
        if (!accountType) {
            accountType = await getAccountType(account);
        }
```

**For account 10010:**
- `accountType` = `'{"account":"10010","type":"Bank","display_name":"Bank"}'` (JSON string from cache)

---

## Step 2: Income Statement Check (Line 6353-6399)

```6353:6399:docs/functions.js
        if (accountType && (accountType === 'Income' || accountType === 'COGS' || accountType === 'Expense' || 
            accountType === 'OthIncome' || accountType === 'OthExpense')) {
            // Route to Income Statement path...
        }
```

**For account 10010:**
- `accountType` = `'{"account":"10010","type":"Bank","display_name":"Bank"}'`
- Check: `accountType === 'Income'` → **FALSE** (it's a JSON string, not "Income")
- Check: `accountType === 'COGS'` → **FALSE**
- Check: `accountType === 'Expense'` → **FALSE**
- Check: `accountType === 'OthIncome'` → **FALSE**
- Check: `accountType === 'OthExpense'` → **FALSE**
- **Result: Does NOT match Income Statement types → Continues to Balance Sheet path**

---

## Step 3: Extract Type String from JSON (Line 6427-6452)

```6427:6452:docs/functions.js
        let acctTypeStr = '';
        
        if (!accountType) {
            acctTypeStr = '';
        } else if (typeof accountType === 'string') {
            // Check if it's a JSON string first
            const trimmed = accountType.trim();
            if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
                try {
                    const parsed = JSON.parse(trimmed);
                    // Extract type from parsed object
                    acctTypeStr = (parsed.type || parsed.accountType || '').toString().trim();
                } catch (e) {
                    // Not valid JSON, treat as plain string
                    acctTypeStr = trimmed;
                }
            } else {
                // Plain string type
                acctTypeStr = trimmed;
            }
        } else if (accountType && typeof accountType === 'object') {
            // Handle object format: { account: "10010", type: "Bank", display_name: "Bank" }
            acctTypeStr = (accountType.type || accountType.accountType || '').toString().trim();
        } else {
            acctTypeStr = String(accountType).trim();
        }
```

**For account 10010:**
- `accountType` = `'{"account":"10010","type":"Bank","display_name":"Bank"}'`
- `typeof accountType === 'string'` → **TRUE**
- `trimmed.startsWith('{')` → **TRUE** (it's JSON)
- `JSON.parse(trimmed)` → `{ account: "10010", type: "Bank", display_name: "Bank" }`
- `parsed.type` → `"Bank"`
- `acctTypeStr` = `"Bank"` ✅

---

## Step 4: Check if Balance Sheet Type (Line 3280-3307)

```3280:3307:docs/functions.js
function isBalanceSheetType(acctType) {
    if (!acctType) return false;
    
    // Normalize: convert to string and trim whitespace
    const normalizedType = String(acctType).trim();
    if (!normalizedType) return false;
    
    // All Balance Sheet account types (Assets, Liabilities, Equity)
    // These are the exact NetSuite account type values
    const bsTypes = [
        // Assets (Debit balance)
        'Bank',           // Bank/Cash accounts
        'AcctRec',        // Accounts Receivable
        'OthCurrAsset',   // Other Current Asset
        'FixedAsset',     // Fixed Asset
        'OthAsset',       // Other Asset
        'DeferExpense',   // Deferred Expense (prepaid expenses)
        'UnbilledRec',    // Unbilled Receivable
        // Liabilities (Credit balance)
        'AcctPay',        // Accounts Payable
        'CredCard',       // Credit Card (NOT 'CreditCard')
        'OthCurrLiab',    // Other Current Liability
        'LongTermLiab',   // Long Term Liability
        'DeferRevenue',   // Deferred Revenue (unearned revenue)
        // Equity (Credit balance)
        'Equity',         // Equity accounts
        'RetainedEarnings' // Retained Earnings
    ];
    
    // Exact match (case-sensitive) - NetSuite types are case-sensitive
    return bsTypes.includes(normalizedType);
}
```

**For account 10010:**
- `acctTypeStr` = `"Bank"`
- `normalizedType` = `"Bank"` (after trim)
- `bsTypes.includes("Bank")` → **TRUE** ✅ (line 3291: `'Bank'` is in the array)
- **Result: `isBalanceSheetType("Bank")` returns `true`**

---

## Step 5: Balance Sheet Path Execution (Line 6453-6454)

```6453:6454:docs/functions.js
        const isBalanceSheet = acctTypeStr && isBalanceSheetType(acctTypeStr);
```

**For account 10010:**
- `acctTypeStr` = `"Bank"` ✅
- `isBalanceSheetType("Bank")` = `true` ✅
- `isBalanceSheet` = `true` ✅

```6455:6456:docs/functions.js
        if (USE_COLUMN_BASED_BS_BATCHING && isBalanceSheet) {
```

**For account 10010:**
- `USE_COLUMN_BASED_BS_BATCHING` = `true` (assuming enabled)
- `isBalanceSheet` = `true` ✅
- **Result: Enters Balance Sheet column-based batching path** ✅

---

## Summary: Complete Flow for Account 10010

1. **Fetch account type**: `'{"account":"10010","type":"Bank","display_name":"Bank"}'`
2. **Check Income Statement**: Does NOT match (`"Income"`, `"COGS"`, `"Expense"`, `"OthIncome"`, `"OthExpense"`)
3. **Extract type string**: Parse JSON → Extract `type` property → `"Bank"`
4. **Check Balance Sheet**: `isBalanceSheetType("Bank")` → `true` (because `"Bank"` is in `bsTypes` array at line 3291)
5. **Result**: Enters Balance Sheet column-based batching path ✅

**Key Point**: The code correctly:
- Parses the JSON string to extract the `type` property
- Checks if the extracted type (`"Bank"`) is in the Balance Sheet types array
- Routes to the Balance Sheet path, NOT the Income Statement path

