# Account Search Proof - Income, Balance, and AcctRec

This document proves what account types will be returned for each search pattern.

## Test 1: "Income" Keyword

### Logic Flow:
1. Pattern: `"Income"`
2. `pattern_without_wildcards = "Income"`
3. `pattern_upper = "INCOME"`
4. Check: `"INCOME" in type_mappings` → **TRUE**

### Code Reference:
```1297:1297:backend/server.py
'INCOME': ['Income', 'OthIncome', 'COGS', 'Cost of Goods Sold', 'Expense', 'OthExpense'],
```

### SQL Generated:
```sql
accttype IN ('Income','OthIncome','COGS','Cost of Goods Sold','Expense','OthExpense')
AND isinactive = 'F'
```

### Result:
✅ **Will return ONLY these 6 account types:**
- Income
- OthIncome (Other Income)
- COGS
- Cost of Goods Sold
- Expense
- OthExpense (Other Expense)

❌ **Will NOT return:**
- Any Balance Sheet accounts (Bank, AcctRec, FixedAsset, etc.)
- Any Equity accounts
- Any Liability accounts

---

## Test 2: "Balance" Keyword

### Logic Flow:
1. Pattern: `"Balance"`
2. `pattern_without_wildcards = "Balance"`
3. `pattern_upper = "BALANCE"`
4. Check: `"BALANCE" in type_mappings` → **TRUE**

### Code Reference:
```1302:1304:backend/server.py
'BALANCE': ['Bank', 'AcctRec', 'OthCurrAsset', 'FixedAsset', 'OthAsset', 'DeferExpense', 'UnbilledRec', 
           'AcctPay', 'CredCard', 'OthCurrLiab', 'LongTermLiab', 'DeferRevenue', 
           'Equity', 'RetainedEarnings'],
```

### SQL Generated:
```sql
accttype IN ('Bank','AcctRec','OthCurrAsset','FixedAsset','OthAsset','DeferExpense','UnbilledRec',
             'AcctPay','CredCard','OthCurrLiab','LongTermLiab','DeferRevenue',
             'Equity','RetainedEarnings')
AND isinactive = 'F'
```

### Result:
✅ **Will return ONLY these 14 Balance Sheet account types:**
- **Assets:** Bank, AcctRec, OthCurrAsset, FixedAsset, OthAsset, DeferExpense, UnbilledRec
- **Liabilities:** AcctPay, CredCard, OthCurrLiab, LongTermLiab, DeferRevenue
- **Equity:** Equity, RetainedEarnings

❌ **Will NOT return:**
- Any Income Statement accounts (Income, Expense, COGS, etc.)

---

## Test 3: "AcctRec" (Exact Account Type)

### Logic Flow:
1. Pattern: `"AcctRec"`
2. `pattern_without_wildcards = "AcctRec"`
3. `pattern_upper = "ACCTREC"`
4. Check for exact type match in `all_valid_types`:
   - Iterates through all valid types
   - Finds: `"AcctRec".upper() == "ACCTREC"` → **MATCH FOUND**

### Code Reference:
```1326:1338:backend/server.py
# Check if pattern (case-insensitive) matches an exact account type
pattern_normalized = pattern_without_wildcards.strip()
exact_type_match = None
for valid_type in all_valid_types:
    if valid_type.upper() == pattern_upper:
        exact_type_match = valid_type
        break

if exact_type_match:
    # Pattern is an exact account type match (e.g., "Equity", "Bank", "FixedAsset")
    # Use exact match - this ensures we ONLY get accounts of this specific type
    escaped_type = escape_sql(exact_type_match)
    where_conditions.append(f"accttype = '{escaped_type}'")
    matched_types = [exact_type_match]
```

### SQL Generated:
```sql
accttype = 'AcctRec'
AND isinactive = 'F'
```

### Result:
✅ **Will return ONLY:**
- Accounts Receivable (AcctRec) accounts

❌ **Will NOT return:**
- Any other account types (Bank, Income, Expense, etc.)

---

## Code Execution Path Summary

### For "Income":
```
Pattern: "Income"
  → pattern_upper = "INCOME"
  → "INCOME" in type_mappings? YES
  → matched_types = type_mappings['INCOME']
  → SQL: accttype IN ('Income','OthIncome','COGS','Cost of Goods Sold','Expense','OthExpense')
  → Returns: 6 Income Statement account types ONLY
```

### For "Balance":
```
Pattern: "Balance"
  → pattern_upper = "BALANCE"
  → "BALANCE" in type_mappings? YES
  → matched_types = type_mappings['BALANCE']
  → SQL: accttype IN (14 Balance Sheet types)
  → Returns: 14 Balance Sheet account types ONLY
```

### For "AcctRec":
```
Pattern: "AcctRec"
  → pattern_upper = "ACCTREC"
  → Check exact type match in all_valid_types
  → Found: "AcctRec" matches exactly
  → SQL: accttype = 'AcctRec'
  → Returns: AcctRec accounts ONLY
```

---

## Verification Against NetSuite

When these SQL queries are executed against NetSuite's Account table:

1. **Income search** will query:
   ```sql
   SELECT ... FROM Account 
   WHERE accttype IN ('Income','OthIncome','COGS','Cost of Goods Sold','Expense','OthExpense')
   ```
   - NetSuite will return ONLY accounts where `accttype` is one of these 6 values
   - No other account types can be returned because the WHERE clause explicitly filters by these types

2. **Balance search** will query:
   ```sql
   SELECT ... FROM Account 
   WHERE accttype IN ('Bank','AcctRec',...,'RetainedEarnings')
   ```
   - NetSuite will return ONLY accounts where `accttype` is one of these 14 Balance Sheet types
   - No Income Statement accounts can be returned because they're not in the IN clause

3. **AcctRec search** will query:
   ```sql
   SELECT ... FROM Account 
   WHERE accttype = 'AcctRec'
   ```
   - NetSuite will return ONLY accounts where `accttype` equals 'AcctRec'
   - No other account types can be returned because the WHERE clause uses exact equality

---

## Conclusion

✅ **All three searches are proven to return ONLY the expected account types:**
- "Income" → 6 Income Statement types ONLY
- "Balance" → 14 Balance Sheet types ONLY  
- "AcctRec" → AcctRec accounts ONLY

The SQL WHERE clauses use explicit filtering (IN clause or exact match), ensuring no other account types can be returned.

