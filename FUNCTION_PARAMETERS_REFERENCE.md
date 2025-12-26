# XAVI Function Parameters Reference

**Complete parameter order for all XAVI Excel custom functions**

---

## 📋 Quick Reference Table

| Function | Parameter Order |
|----------|----------------|
| **BALANCE** | `account, fromPeriod, toPeriod, subsidiary, department, location, classId, accountingBook` |
| **BALANCECURRENCY** | `account, fromPeriod, toPeriod, subsidiary, currency, department, location, classId, accountingBook` |
| **BALANCECHANGE** | `account, fromPeriod, toPeriod, subsidiary, department, location, classId, accountingBook` |
| **BUDGET** | `account, fromPeriod, toPeriod, subsidiary, department, location, classId, accountingBook, budgetCategory` |
| **TYPEBALANCE** | `accountType, fromPeriod, toPeriod, subsidiary, department, location, classId, accountingBook, useSpecialAccount` |
| **RETAINEDEARNINGS** | `period, subsidiary, accountingBook, classId, department, location` |
| **NAME** | `accountNumber` |
| **TYPE** | `accountNumber` |
| **PARENT** | `accountNumber` |

---

## 📊 Detailed Function Descriptions

### 1. BALANCE
**Get GL account balance with filters**

```excel
=XAVI.BALANCE(account, fromPeriod, toPeriod, subsidiary, department, location, classId, accountingBook)
```

**Parameters (in order):**
1. **`account`** (required) - Account number (e.g., `"60010"` or `60010`)
2. **`fromPeriod`** (required for P&L, optional for BS) - Starting period (e.g., `"Jan 2025"` or `1/1/2025`)
   - For Balance Sheet accounts: Can be empty `""` or omitted (calculates from inception)
   - For P&L accounts: Required
3. **`toPeriod`** (required) - Ending period (e.g., `"Mar 2025"` or `3/1/2025`)
4. **`subsidiary`** (optional) - Subsidiary filter (use `""` for all subsidiaries)
5. **`department`** (optional) - Department filter (use `""` for all departments)
6. **`location`** (optional) - Location filter (use `""` for all locations)
7. **`classId`** (optional) - Class filter (use `""` for all classes)
8. **`accountingBook`** (optional) - Accounting Book ID (use `""` for Primary Book)

**Examples:**
```excel
=XAVI.BALANCE("60010", , "Jan 2025")                    // BS account, cumulative
=XAVI.BALANCE("60010", "Jan 2025", "Mar 2025")          // P&L account, period range
=XAVI.BALANCE("60010", , "Jan 2025", "Celigo Inc.")     // With subsidiary filter
=XAVI.BALANCE($A5, C$4, C$4, $M$2)                      // Using cell references
```

---

### 2. BALANCECURRENCY
**Get GL account balance with explicit currency control for consolidation**

```excel
=XAVI.BALANCECURRENCY(account, fromPeriod, toPeriod, subsidiary, currency, department, location, classId, accountingBook)
```

**Parameters (in order):**
1. **`account`** (required) - Account number or wildcard pattern (e.g., `"60010"` or `"4*"`)
2. **`fromPeriod`** (required for P&L, optional for BS) - Starting period
   - For Balance Sheet: Can be empty `""` (calculates from inception)
   - For P&L: Required
3. **`toPeriod`** (required) - Ending period
4. **`subsidiary`** (optional) - Subsidiary filter (use `""` for all)
5. **`currency`** (optional) - Currency code for consolidation root (e.g., `"USD"`, `"EUR"`)
   - ⚠️ **CRITICAL:** This parameter is in position 5 (after subsidiary, before department)
   - If omitted or empty, uses subsidiary's base currency
6. **`department`** (optional) - Department filter (use `""` for all)
7. **`location`** (optional) - Location filter (use `""` for all)
8. **`classId`** (optional) - Class filter (use `""` for all)
9. **`accountingBook`** (optional) - Accounting Book ID (use `""` for Primary Book)

**Examples:**
```excel
=XAVI.BALANCECURRENCY("60010", , "Jan 2025", "Celigo Australia Pty Ltd", "USD")
=XAVI.BALANCECURRENCY($A5, C$4, C$4, $M$2, $O$2)       // Currency in $O$2
=XAVI.BALANCECURRENCY("60010", "Jan 2025", "Mar 2025", "", "EUR")  // All subsidiaries, EUR
```

**⚠️ Important Notes:**
- Currency parameter is **position 5** (not position 4 like in BALANCE)
- If you want to skip subsidiary but include currency, use: `=XAVI.BALANCECURRENCY(account, from, to, "", currency)`
- Empty currency cell references will return `#EMPTY_CURRENCY#` error

---

### 3. BALANCECHANGE
**Get the change in a Balance Sheet account between two dates**

```excel
=XAVI.BALANCECHANGE(account, fromPeriod, toPeriod, subsidiary, department, location, classId, accountingBook)
```

**Parameters (in order):**
1. **`account`** (required) - Account number (must be a Balance Sheet account)
2. **`fromPeriod`** (required) - Starting period (e.g., `"Dec 2024"` or `12/1/2024`)
3. **`toPeriod`** (required) - Ending period (e.g., `"Jan 2025"` or `1/1/2025`)
4. **`subsidiary`** (optional) - Subsidiary filter (use `""` for all)
5. **`department`** (optional) - Department filter (use `""` for all)
6. **`location`** (optional) - Location filter (use `""` for all)
7. **`classId`** (optional) - Class filter (use `""` for all)
8. **`accountingBook`** (optional) - Accounting Book ID (use `""` for Primary Book)

**Examples:**
```excel
=XAVI.BALANCECHANGE("10000", "Dec 2024", "Jan 2025")
=XAVI.BALANCECHANGE("10000", "Dec 2024", "Jan 2025", "Celigo Inc.")
```

**Note:** Only valid for Balance Sheet accounts. P&L accounts will return `INVALIDACCT`.

---

### 4. BUDGET
**Get Budget Amount from NetSuite BudgetsMachine table**

```excel
=XAVI.BUDGET(account, fromPeriod, toPeriod, subsidiary, department, location, classId, accountingBook, budgetCategory)
```

**Parameters (in order):**
1. **`account`** (required) - Account number
2. **`fromPeriod`** (required) - Starting period (e.g., `"Jan 2025"` or `1/1/2025`)
3. **`toPeriod`** (required) - Ending period (e.g., `"Mar 2025"` or `3/1/2025`)
4. **`subsidiary`** (optional) - Subsidiary filter (use `""` for all)
5. **`department`** (optional) - Department filter (use `""` for all)
6. **`location`** (optional) - Location filter (use `""` for all)
7. **`classId`** (optional) - Class filter (use `""` for all)
8. **`accountingBook`** (optional) - Accounting Book ID (use `""` for Primary Book)
9. **`budgetCategory`** (required) - Budget Category name or ID (e.g., `"FY 2024 Budget"`)

**Examples:**
```excel
=XAVI.BUDGET("60010", "Jan 2025", "Mar 2025", "", "", "", "", "", "FY 2025 Budget")
=XAVI.BUDGET("60010", "Jan 2025", "Mar 2025", , , , , , "FY 2025 Budget")  // Using commas to skip
```

---

### 5. TYPEBALANCE
**Get total balance for all accounts of a specific type**

```excel
=XAVI.TYPEBALANCE(accountType, fromPeriod, toPeriod, subsidiary, department, location, classId, accountingBook, useSpecialAccount)
```

**Parameters (in order):**
1. **`accountType`** (required) - NetSuite account type (e.g., `"OthAsset"`, `"Expense"`, `"Income"`)
2. **`fromPeriod`** (required for P&L, ignored for BS) - Starting period
   - For Balance Sheet types: Ignored (always cumulative from inception)
   - For P&L types: Required
3. **`toPeriod`** (required) - Ending period
4. **`subsidiary`** (optional) - Subsidiary name or ID (use `""` for all)
5. **`department`** (optional) - Department filter (use `""` for all)
6. **`location`** (optional) - Location filter (use `""` for all)
7. **`classId`** (optional) - Class filter (use `""` for all)
8. **`accountingBook`** (optional) - Accounting Book ID (use `""` for Primary Book)
9. **`useSpecialAccount`** (optional) - Boolean: `true` to include special accounts, `false` or omit for regular accounts only

**Examples:**
```excel
=XAVI.TYPEBALANCE("Expense", "Jan 2025", "Mar 2025")
=XAVI.TYPEBALANCE("OthAsset", , "Jan 2025")              // BS type, cumulative
=XAVI.TYPEBALANCE("Income", "Jan 2025", "Mar 2025", "Celigo Inc.")
```

**Account Types:**
- **Balance Sheet:** `Bank`, `AcctRec`, `OthCurrAsset`, `FixedAsset`, `OthAsset`, `DeferExpense`, `UnbilledRec`, `AcctPay`, `CredCard`, `OthCurrLiab`, `LongTermLiab`, `DeferRevenue`, `Equity`, `RetainedEarnings`
- **P&L:** `Income`, `OthIncome`, `COGS`, `Expense`, `OthExpense`

---

### 6. RETAINEDEARNINGS
**Calculate Retained Earnings (prior years' cumulative P&L + posted RE adjustments)**

```excel
=XAVI.RETAINEDEARNINGS(period, subsidiary, accountingBook, classId, department, location)
```

**Parameters (in order):**
1. **`period`** (required) - Accounting period (e.g., `"Mar 2025"`)
2. **`subsidiary`** (optional) - Subsidiary ID (use `""` for all)
3. **`accountingBook`** (optional) - Accounting Book ID (defaults to Primary Book)
4. **`classId`** (optional) - Class filter (use `""` for all)
5. **`department`** (optional) - Department filter (use `""` for all)
6. **`location`** (optional) - Location filter (use `""` for all)

**Examples:**
```excel
=XAVI.RETAINEDEARNINGS("Mar 2025")
=XAVI.RETAINEDEARNINGS("Mar 2025", "Celigo Inc.")
=XAVI.RETAINEDEARNINGS("2025")                          // Uses Dec 31, 2025
```

**Note:** Parameter order is different from other functions! Order is: `period, subsidiary, accountingBook, classId, department, location`

---

### 7. NAME
**Get account name from account number**

```excel
=XAVI.NAME(accountNumber)
```

**Parameters:**
1. **`accountNumber`** (required) - Account number (e.g., `"60010"` or `60010`)

**Examples:**
```excel
=XAVI.NAME("60010")
=XAVI.NAME($A5)
```

---

### 8. TYPE
**Get account type from account number**

```excel
=XAVI.TYPE(accountNumber)
```

**Parameters:**
1. **`accountNumber`** (required) - Account number (e.g., `"60010"` or `60010`)

**Examples:**
```excel
=XAVI.TYPE("60010")
=XAVI.TYPE($A5)
```

**Returns:** Account type string (e.g., `"Income"`, `"Expense"`, `"Bank"`, `"AcctRec"`)

---

### 9. PARENT
**Get parent account number from account number**

```excel
=XAVI.PARENT(accountNumber)
```

**Parameters:**
1. **`accountNumber`** (required) - Account number (e.g., `"60010"` or `60010`)

**Examples:**
```excel
=XAVI.PARENT("60010")
=XAVI.PARENT($A5)
```

**Returns:** Parent account number, or empty string if no parent

---

## 🔑 Key Parameter Patterns

### Common Parameter Order (Most Functions)
Most functions follow this pattern:
1. **Account/Identifier** (required)
2. **Period(s)** (fromPeriod, toPeriod)
3. **Subsidiary** (optional)
4. **Dimensions** (department, location, classId)
5. **Accounting Book** (optional)
6. **Function-Specific** (currency, budgetCategory, etc.)

### Skipping Optional Parameters
You can skip optional parameters using:
- **Empty string:** `""`
- **Comma with nothing:** `,` (leaves parameter undefined)
- **Comma with space:** `, ` (same as comma)

**Examples:**
```excel
=XAVI.BALANCE("60010", , "Jan 2025", , , , , )          // Skip subsidiary, all dimensions
=XAVI.BALANCE("60010", , "Jan 2025", "", "", "", "", "") // Same as above, explicit empty strings
```

### Using Cell References
All parameters can use cell references:
```excel
=XAVI.BALANCE($A5, C$4, C$4, $M$2, $N$2, $O$2, $P$2, $Q$2)
```

---

## ⚠️ Important Notes

### ⚠️ CRITICAL: Do Not Change Parameter Order After Deployment

**Mac Excel Warning:** Changing the parameter order of a function after it has been deployed and used will cause Excel to crash on startup on Mac. This is a Mac-specific bug in Excel's custom function metadata caching.

**If you must change parameter order:**
1. Use `remove-office-keep-edge.sh` to completely reset Office caches
2. Reinstall Office
3. Reinstall the add-in

See [MAC_PARAMETER_ORDER_ISSUE.md](../MAC_PARAMETER_ORDER_ISSUE.md) for complete details.

### BALANCECURRENCY Parameter Order
**CRITICAL:** The `currency` parameter is in **position 5** (after `subsidiary`, before `department`), not position 4 like in BALANCE. **DO NOT CHANGE THIS ORDER** - Mac Excel will crash if you do.

**Correct:**
```excel
=XAVI.BALANCECURRENCY(account, from, to, subsidiary, currency, department, ...)
```

**Wrong:**
```excel
=XAVI.BALANCECURRENCY(account, from, to, currency, subsidiary, ...)  // ❌ Wrong order!
```

### Period Parameters
- **Balance Sheet accounts:** `fromPeriod` can be empty (cumulative from inception)
- **P&L accounts:** `fromPeriod` is required
- **Year-only format:** `"2025"` is automatically expanded to `"Jan 2025"` (from) and `"Dec 2025"` (to)

### Empty Cell References
If a cell reference points to an empty cell, the function will return an error:
- `#EMPTY_CELL: Account cell is empty.`
- `#EMPTY_CELL: Currency cell is empty.`
- `#EMPTY_CELL: ToPeriod cell is empty.`

This prevents silent `0` values that could be mistakes.

---

## 📝 Parameter Summary by Function

| Function | Total Params | Required | Optional | Special Notes |
|----------|--------------|----------|----------|---------------|
| **BALANCE** | 8 | 3 | 5 | fromPeriod optional for BS |
| **BALANCECURRENCY** | 9 | 3 | 6 | currency in position 5 |
| **BALANCECHANGE** | 8 | 3 | 5 | BS accounts only |
| **BUDGET** | 9 | 4 | 5 | budgetCategory required |
| **TYPEBALANCE** | 9 | 3 | 6 | fromPeriod ignored for BS types |
| **RETAINEDEARNINGS** | 6 | 1 | 5 | Different parameter order! |
| **NAME** | 1 | 1 | 0 | Simple lookup |
| **TYPE** | 1 | 1 | 0 | Simple lookup |
| **PARENT** | 1 | 1 | 0 | Simple lookup |

---

**Last Updated:** December 25, 2025  
**Version:** 4.0.0.12

