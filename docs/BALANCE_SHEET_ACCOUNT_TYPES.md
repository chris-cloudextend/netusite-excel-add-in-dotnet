# Balance Sheet Account Types - Complete List

## All Account Types That Resolve to Balance Sheet

Based on `isBalanceSheetType()` function in `functions.js` (lines 3280-3310):

### Assets (Debit Balance)
1. **Bank** - Bank/Cash accounts
2. **AcctRec** - Accounts Receivable
3. **OthCurrAsset** - Other Current Asset
4. **FixedAsset** - Fixed Asset
5. **OthAsset** - Other Asset
6. **DeferExpense** - Deferred Expense (prepaid expenses)
7. **UnbilledRec** - Unbilled Receivable

### Liabilities (Credit Balance)
8. **AcctPay** - Accounts Payable
9. **CredCard** - Credit Card (NOT 'CreditCard')
10. **OthCurrLiab** - Other Current Liability
11. **LongTermLiab** - Long Term Liability
12. **DeferRevenue** - Deferred Revenue (unearned revenue)

### Equity (Credit Balance)
13. **Equity** - Equity accounts
14. **RetainedEarnings** - Retained Earnings

**Total: 14 Balance Sheet account types**

---

## Proof: XAVI.BALANCE("10010", ,"May 2025") Resolves to Balance Sheet

### Step 1: Function Entry (Line 5974)
```5974:5974:docs/functions.js
async function BALANCE(account, fromPeriod, toPeriod, subsidiary, department, location, classId, accountingBook) {
```
- `account = "10010"`
- `fromPeriod = ""` (empty)
- `toPeriod = "May 2025"`

### Step 2: Account Type Fetched (Line 6342-6348)
```6342:6348:docs/functions.js
        const typeCacheKey = getCacheKey('type', { account });
        let accountType = cache.type.has(typeCacheKey) ? cache.type.get(typeCacheKey) : null;
        
        // If not in cache, fetch it (async) - MUST wait before proceeding
        if (!accountType) {
            accountType = await getAccountType(account);
        }
```
- For account "10010": `accountType = '{"account":"10010","type":"Bank","display_name":"Bank"}'` (JSON string)

### Step 3: Income Statement Check (Line 6353-6354)
```6353:6354:docs/functions.js
        if (accountType && (accountType === 'Income' || accountType === 'COGS' || accountType === 'Expense' || 
            accountType === 'OthIncome' || accountType === 'OthExpense')) {
```
- `accountType === 'Income'` → **FALSE** (it's a JSON string, not "Income")
- All other IS checks → **FALSE**
- **Result: Does NOT match Income Statement → Continues to Balance Sheet path**

### Step 4: Extract Type String from JSON (Line 6427-6452)
```6431:6438:docs/functions.js
        } else if (typeof accountType === 'string') {
            // Check if it's a JSON string first
            const trimmed = accountType.trim();
            if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
                try {
                    const parsed = JSON.parse(trimmed);
                    // Extract type from parsed object
                    acctTypeStr = (parsed.type || parsed.accountType || '').toString().trim();
```
- `accountType` = `'{"account":"10010","type":"Bank","display_name":"Bank"}'`
- `typeof accountType === 'string'` → **TRUE**
- `trimmed.startsWith('{')` → **TRUE** (it's JSON)
- `JSON.parse(trimmed)` → `{ account: "10010", type: "Bank", display_name: "Bank" }`
- `parsed.type` → `"Bank"`
- **Result: `acctTypeStr = "Bank"`** ✅

### Step 5: Check if Balance Sheet Type (Line 3280-3310)
```3280:3310:docs/functions.js
function isBalanceSheetType(acctType) {
    if (!acctType) return false;
    
    // Normalize: convert to string and trim whitespace
    const normalizedType = String(acctType).trim();
    if (!normalizedType) return false;
    
    // All Balance Sheet account types (Assets, Liabilities, Equity)
    // These are the exact NetSuite account type values
    const bsTypes = [
        // Assets (Debit balance)
        'Bank',           // Bank/Cash accounts ← Account 10010 is this type
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
- `acctTypeStr = "Bank"`
- `normalizedType = "Bank"` (after trim)
- `bsTypes.includes("Bank")` → **TRUE** ✅ (line 3291: `'Bank'` is in the array)
- **Result: `isBalanceSheetType("Bank")` returns `true`** ✅

### Step 6: Balance Sheet Path Execution (Line 6456-6461)
```6456:6461:docs/functions.js
        const isBalanceSheet = acctTypeStr && isBalanceSheetType(acctTypeStr);
        
        if (DEBUG_COLUMN_BASED_BS_BATCHING || !isBalanceSheet) {
            console.log(`🔍 [TYPE DEBUG] accountType=`, accountType, `→ extracted="${acctTypeStr}" → isBalanceSheet=${isBalanceSheet}`);
        }
        if (USE_COLUMN_BASED_BS_BATCHING && isBalanceSheet) {
```
- `acctTypeStr = "Bank"` ✅
- `isBalanceSheetType("Bank") = true` ✅
- `isBalanceSheet = true` ✅
- **Result: Enters Balance Sheet column-based batching path** ✅

---

## Conclusion

**XAVI.BALANCE("10010", ,"May 2025")** will:
1. Fetch account type: `'{"account":"10010","type":"Bank","display_name":"Bank"}'`
2. Skip Income Statement check (doesn't match IS types)
3. Extract type string: `"Bank"` from JSON
4. Check Balance Sheet: `isBalanceSheetType("Bank")` → `true` (because `"Bank"` is in `bsTypes` array at line 3291)
5. **Route to Balance Sheet path** ✅

**Account 10010 with type "Bank" is correctly identified as a Balance Sheet account.**

