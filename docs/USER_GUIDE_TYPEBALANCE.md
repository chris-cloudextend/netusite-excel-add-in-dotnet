# XAVI.TYPEBALANCE User Guide

## Overview

`XAVI.TYPEBALANCE` retrieves the total balance for all accounts of a specific type. It can query by:

1. **Account Type** - Financial reporting categories (Asset, Liability, Income, Expense, etc.)
2. **Special Account Type** - System-defined control accounts (AcctRec, AcctPay, InvtAsset, etc.)

---

## When to Use Each

| Use Case | Account Type | Special Account Type |
|----------|:------------:|:--------------------:|
| Financial reporting totals | ✔ | |
| Summarizing by financial category | ✔ | |
| Identifying system control accounts | | ✔ |
| Finding what NetSuite uses for specific functions | | ✔ |
| Troubleshooting posting behavior | | ✔ |

---

## Formula Syntax

```
=XAVI.TYPEBALANCE(accountType, fromPeriod, toPeriod, subsidiary, department, location, classId, accountingBook, useSpecialAccountType)
```

| Parameter | Position | Description |
|-----------|----------|-------------|
| `accountType` | 1 | Required. The account type or special account type code |
| `fromPeriod` | 2 | Start period (required for P&L types, ignored for BS types) |
| `toPeriod` | 3 | End period (required) |
| `subsidiary` | 4 | Optional. Subsidiary name or ID |
| `department` | 5 | Optional. Department filter |
| `location` | 6 | Optional. Location filter |
| `classId` | 7 | Optional. Class filter |
| `accountingBook` | 8 | Optional. Accounting Book ID |
| `useSpecialAccountType` | 9 | Optional. Set to `1` to use Special Account Type |

### Balance Sheet vs P&L Behavior

- **Balance Sheet types**: `fromPeriod` is ignored; calculates cumulative from inception through `toPeriod`
- **P&L types**: Uses the range from `fromPeriod` to `toPeriod`

---

## Account Type Values (Financial Reporting)

Standard categories for financial statements:

| Account Type | Category |
|--------------|----------|
| `Bank` | Balance Sheet |
| `AcctRec` | Balance Sheet |
| `OthCurrAsset` | Balance Sheet |
| `FixedAsset` | Balance Sheet |
| `OthAsset` | Balance Sheet |
| `AcctPay` | Balance Sheet |
| `CredCard` | Balance Sheet |
| `OthCurrLiab` | Balance Sheet |
| `LongTermLiab` | Balance Sheet |
| `Equity` | Balance Sheet |
| `Income` | P&L |
| `COGS` | P&L |
| `Expense` | P&L |
| `OthIncome` | P&L |
| `OthExpense` | P&L |

---

## Special Account Type Values (System Accounts)

System-assigned tags for accounts with special functions:

| Special Account Type | Description |
|---------------------|-------------|
| `AcctRec` | Accounts Receivable control |
| `AcctPay` | Accounts Payable control |
| `InvtAsset` | Inventory Asset |
| `UndepFunds` | Undeposited Funds |
| `DeferRevenue` | Deferred Revenue |
| `DeferExpense` | Deferred Expense / Prepaid |
| `RetEarnings` | Retained Earnings |
| `CumulTransAdj` | Cumulative Translation Adjustment |
| `SalesTaxPay` | Sales Tax Payable |
| `RealizedERV` | Realized FX Gain/Loss |
| `UnrERV` | Unrealized FX Gain/Loss |

**Note:** Most accounts have a blank Special Account Type. Only system control accounts have values.

---

## Examples

### Using Account Type (Position 9 = 0 or blank)

```excel
// Total of all Other Current Assets as of Dec 2025
=XAVI.TYPEBALANCE("OthCurrAsset",,"Dec 2025")

// All Expenses for full year 2025
=XAVI.TYPEBALANCE("Expense","Jan 2025","Dec 2025")

// All Income for Q1 2025 for specific subsidiary
=XAVI.TYPEBALANCE("Income","Jan 2025","Mar 2025","Celigo Inc.")

// All Long-Term Liabilities
=XAVI.TYPEBALANCE("LongTermLiab",,"Dec 2025")
```

### Using Special Account Type (Position 9 = 1)

```excel
// True Accounts Receivable control account balance
=XAVI.TYPEBALANCE("AcctRec",,"Dec 2025",,,,,,1)

// True Accounts Payable control account balance
=XAVI.TYPEBALANCE("AcctPay",,"Dec 2025",,,,,,1)

// Inventory Asset (system inventory account)
=XAVI.TYPEBALANCE("InvtAsset",,"Dec 2025",,,,,,1)

// Deferred Revenue
=XAVI.TYPEBALANCE("DeferRevenue",,"Dec 2025",,,,,,1)

// Retained Earnings (system account)
=XAVI.TYPEBALANCE("RetEarnings",,"Dec 2025",,,,,,1)
```

---

## Key Differences

### Account Type
- Every account has one
- Used for financial statement organization
- Groups accounts for reporting sections
- Best for: "Show me all assets" or "Total expenses for the year"

### Special Account Type
- Only some accounts have one (most are blank)
- Identifies system control accounts
- Shows what NetSuite uses the account for internally
- Best for: "Find the true A/R control account" or "What's the system inventory account?"

---

## Rule of Thumb

> **Use Account Type** when you want to summarize by financial category.
> 
> **Use Special Account Type** when you need to identify a specific system control account.

---

## See Also

- [SPECIAL_ACCOUNT_TYPES.md](SPECIAL_ACCOUNT_TYPES.md) - Detailed explanation of both classifications
