# XAVI Formulas - Complete Reference

**Complete list of all XAVI Excel formulas with parameters and descriptions**

---

## 📊 Balance & Account Formulas

### 1. BALANCE
**Get GL account balance with filters**

```excel
=XAVI.BALANCE(account, fromPeriod, toPeriod, subsidiary, department, location, classId, accountingBook)
```

**Parameters:**
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

**Description:** Returns the balance for a specific GL account for a period or date range. Supports wildcard patterns (e.g., `"4*"` for all accounts starting with 4).

**Examples:**
```excel
=XAVI.BALANCE("60010", , "Jan 2025")                    // BS account, cumulative
=XAVI.BALANCE("60010", "Jan 2025", "Mar 2025")          // P&L account, period range
=XAVI.BALANCE("60010", , "Jan 2025", "Celigo Inc.")     // With subsidiary filter
```

---

### 2. BALANCECURRENCY
**Get GL account balance with explicit currency control for consolidation**

```excel
=XAVI.BALANCECURRENCY(account, fromPeriod, toPeriod, subsidiary, currency, department, location, classId, accountingBook)
```

**Parameters:**
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

**Description:** Similar to BALANCE but with explicit currency control. The currency parameter determines the consolidation root currency, while subsidiary filters transactions to exact match.

**Examples:**
```excel
=XAVI.BALANCECURRENCY("60010", , "Jan 2025", "Celigo Australia Pty Ltd", "USD")
=XAVI.BALANCECURRENCY("60010", "Jan 2025", "Mar 2025", "", "EUR")  // All subsidiaries, EUR
```

---

---

### 4. TYPEBALANCE
**Get total balance for all accounts of a specific type**

```excel
=XAVI.TYPEBALANCE(accountType, fromPeriod, toPeriod, subsidiary, department, location, classId, accountingBook, useSpecialAccount)
```

**Parameters:**
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
9. **`useSpecialAccount`** (optional) - Boolean: `true` or `1` to include special accounts, `false` or omit for regular accounts only

**Description:** Returns the sum of all accounts of a specific type. Useful for high-level P&L summaries (e.g., total Income, total Expenses).

**Account Types:**
- **Balance Sheet:** `Bank`, `AcctRec`, `OthCurrAsset`, `FixedAsset`, `OthAsset`, `DeferExpense`, `UnbilledRec`, `AcctPay`, `CredCard`, `OthCurrLiab`, `LongTermLiab`, `DeferRevenue`, `Equity`, `RetainedEarnings`
- **P&L:** `Income`, `OthIncome`, `COGS`, `Expense`, `OthExpense`

**Examples:**
```excel
=XAVI.TYPEBALANCE("Expense", "Jan 2025", "Mar 2025")
=XAVI.TYPEBALANCE("OthAsset", , "Jan 2025")              // BS type, cumulative
=XAVI.TYPEBALANCE("Income", "Jan 2025", "Mar 2025", "Celigo Inc.")
```

---

## 💰 Budget Formula

### 5. BUDGET
**Get Budget Amount from NetSuite BudgetsMachine table**

```excel
=XAVI.BUDGET(account, fromPeriod, toPeriod, subsidiary, department, location, classId, accountingBook, budgetCategory)
```

**Parameters:**
1. **`account`** (required) - Account number
2. **`fromPeriod`** (required) - Starting period (e.g., `"Jan 2025"` or `1/1/2025`)
3. **`toPeriod`** (required) - Ending period (e.g., `"Mar 2025"` or `3/1/2025`)
4. **`subsidiary`** (optional) - Subsidiary filter (use `""` for all)
5. **`department`** (optional) - Department filter (use `""` for all)
6. **`location`** (optional) - Location filter (use `""` for all)
7. **`classId`** (optional) - Class filter (use `""` for all)
8. **`accountingBook`** (optional) - Accounting Book ID (use `""` for Primary Book)
9. **`budgetCategory`** (required) - Budget Category name or ID (e.g., `"FY 2024 Budget"`)

**Description:** Returns the budget amount for an account from NetSuite's budget system. Requires a budget category to be specified.

**Examples:**
```excel
=XAVI.BUDGET("60010", "Jan 2025", "Mar 2025", "", "", "", "", "", "FY 2025 Budget")
```

---

## 🔢 Special Calculation Formulas

### 6. RETAINEDEARNINGS
**Calculate Retained Earnings (prior years' cumulative P&L + posted RE adjustments)**

```excel
=XAVI.RETAINEDEARNINGS(period, subsidiary, accountingBook, classId, department, location)
```

**Parameters:**
1. **`period`** (required) - Accounting period (e.g., `"Mar 2025"`)
2. **`subsidiary`** (optional) - Subsidiary ID (use `""` for all)
3. **`accountingBook`** (optional) - Accounting Book ID (defaults to Primary Book)
4. **`classId`** (optional) - Class filter (use `""` for all)
5. **`department`** (optional) - Department filter (use `""` for all)
6. **`location`** (optional) - Location filter (use `""` for all)

**Description:** Calculates retained earnings as the sum of all P&L transactions from inception through the prior fiscal year end, plus any manual journal entries posted directly to RetainedEarnings accounts. NetSuite calculates this dynamically - no account number needed.

**Note:** Parameter order is different from other functions! Order is: `period, subsidiary, accountingBook, classId, department, location`

**Examples:**
```excel
=XAVI.RETAINEDEARNINGS("Mar 2025")
=XAVI.RETAINEDEARNINGS("Mar 2025", "Celigo Inc.")
=XAVI.RETAINEDEARNINGS("Dec 2025")                      // Year-end balance
```

---

### 7. NETINCOME
**Calculate Net Income YTD (current fiscal year P&L through target period)**

```excel
=XAVI.NETINCOME(fromPeriod, toPeriod, subsidiary, accountingBook, classId, department, location)
```

**Parameters:**
1. **`fromPeriod`** (required) - Start period (e.g., `"Jan 2025"` or cell reference)
2. **`toPeriod`** (optional) - End period (defaults to fromPeriod if empty)
3. **`subsidiary`** (optional) - Subsidiary name or ID (use `""` for all)
4. **`accountingBook`** (optional) - Accounting Book ID (defaults to Primary Book)
5. **`classId`** (optional) - Class filter (use `""` for all)
6. **`department`** (optional) - Department filter (use `""` for all)
7. **`location`** (optional) - Location filter (use `""` for all)

**Description:** Calculates net income as the sum of all P&L transactions from fiscal year start through target period end. This is the current year's P&L portion.

**Examples:**
```excel
=XAVI.NETINCOME("Jan 2025", "Mar 2025")
=XAVI.NETINCOME("Jan 2025", "Dec 2025")                  // Full year
```

---

### 8. CTA
**Calculate Cumulative Translation Adjustment (multi-currency plug)**

```excel
=XAVI.CTA(period, subsidiary, accountingBook)
```

**Parameters:**
1. **`period`** (required) - Accounting period (e.g., `"Mar 2025"`)
2. **`subsidiary`** (optional) - Subsidiary ID (use `""` for all)
3. **`accountingBook`** (optional) - Accounting Book ID (defaults to Primary Book)

**Description:** Calculates the Cumulative Translation Adjustment using the "plug method" for 100% accuracy. Formula: `CTA = (Total Assets - Total Liabilities) - Posted Equity - Retained Earnings - Net Income`. This is a plug figure that balances the Balance Sheet after currency translation. NetSuite calculates additional translation adjustments at runtime that are never posted to accounts.

**Note:** CTA omits segment filters (classId, department, location) because translation adjustments apply at entity level only.

**Examples:**
```excel
=XAVI.CTA("Mar 2025")
=XAVI.CTA("Mar 2025", "Celigo Inc.")
```

---

## 📝 Account Lookup Formulas

### 9. NAME
**Get account name from account number**

```excel
=XAVI.NAME(accountNumber)
```

**Parameters:**
1. **`accountNumber`** (required) - Account number (e.g., `"60010"` or `60010`)

**Description:** Returns the account name for a given account number.

**Examples:**
```excel
=XAVI.NAME("60010")
=XAVI.NAME($A5)
```

---

### 10. TYPE
**Get account type from account number**

```excel
=XAVI.TYPE(accountNumber)
```

**Parameters:**
1. **`accountNumber`** (required) - Account number (e.g., `"60010"` or `60010`)

**Description:** Returns the account type string (e.g., `"Income"`, `"Expense"`, `"Bank"`, `"AcctRec"`).

**Examples:**
```excel
=XAVI.TYPE("60010")
=XAVI.TYPE($A5)
```

**Returns:** Account type string (e.g., `"Income"`, `"Expense"`, `"Bank"`, `"AcctRec"`)

---

### 11. PARENT
**Get parent account number from account number**

```excel
=XAVI.PARENT(accountNumber)
```

**Parameters:**
1. **`accountNumber`** (required) - Account number (e.g., `"60010"` or `60010`)

**Description:** Returns the parent account number, or empty string if no parent exists.

**Examples:**
```excel
=XAVI.PARENT("60010")
=XAVI.PARENT($A5)
```

**Returns:** Parent account number, or empty string if no parent

---

## 📋 Quick Reference Table

| Function | Parameters | Required | Description |
|----------|------------|----------|-------------|
| **BALANCE** | 8 | 3 | Get GL account balance |
| **BALANCECURRENCY** | 9 | 3 | Get balance with currency control |
| **BUDGET** | 9 | 4 | Get budget amount |
| **TYPEBALANCE** | 9 | 3 | Get total for account type |
| **RETAINEDEARNINGS** | 6 | 1 | Calculate retained earnings |
| **NETINCOME** | 7 | 1 | Calculate net income YTD |
| **CTA** | 3 | 1 | Calculate translation adjustment |
| **NAME** | 1 | 1 | Get account name |
| **TYPE** | 1 | 1 | Get account type |
| **PARENT** | 1 | 1 | Get parent account |

---

## ⚠️ Important Notes

### Parameter Order
- **DO NOT CHANGE PARAMETER ORDER** after deployment - Mac Excel will crash
- Optional parameters must come AFTER required parameters
- Use empty strings `""` or commas `,` to skip optional parameters

### Period Parameters
- **Balance Sheet accounts:** `fromPeriod` can be empty (cumulative from inception)
- **P&L accounts:** `fromPeriod` is required

### BALANCECURRENCY Parameter Order
**CRITICAL:** The `currency` parameter is in **position 5** (after `subsidiary`, before `department`), not position 4 like in BALANCE.

**Correct:**
```excel
=XAVI.BALANCECURRENCY(account, from, to, subsidiary, currency, department, ...)
```

### Empty Cell References
If a cell reference points to an empty cell, the function will return an error:
- `#EMPTY_CELL: Account cell is empty.`
- `#EMPTY_CELL: Currency cell is empty.`
- `#EMPTY_CELL: ToPeriod cell is empty.`

---

**Last Updated:** January 10, 2026  
**Version:** 4.0.6.159

