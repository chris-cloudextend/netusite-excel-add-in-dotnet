# Account Type vs. Special Account Type

**A One-Page Guide for Financial Users and NetSuite Administrators**

NetSuite assigns two different classifications to accounts: **Account Type** and **Special Account Type**.
They work together, but they serve different purposes.
Understanding both helps ensure accurate reporting, clean configurations, and reliable system behavior.

---

## Together:
- **Account Type** shows where an account belongs in financial reporting
- **Special Account Type** shows how the account functions inside NetSuite

Both perspectives are important for a clear, accurate understanding of your financial data and system behavior.

---

## 1. Account Type — Financial Reporting Classification

### What it is:
The standard accounting category assigned to every account.

### Common types include:
- Asset
- Liability
- Equity
- Income
- Expense
- Subcategories such as Other Current Asset, Other Current Liability, etc.

### What it controls:
- Where the account appears on the Balance Sheet or Income Statement
- How accounts roll up into financial reporting sections
- How totals and subtotals are calculated in standard NetSuite reports

### When it's used:
✔ Building or reviewing financial statements  
✔ Summarizing accounts by financial category  
✔ Organizing the chart of accounts  
✔ Producing high-level financial analysis  

> **Think of Account Type as:**
> 
> *"How does this account appear in financial reporting?"*

---

## 2. Special Account Type — System Behavior Classification

### What it is:
A system-assigned tag used only for certain accounts that play a special functional role inside NetSuite.

### Examples include accounts NetSuite uses for:
- Customer transactions (Accounts Receivable)
- Vendor transactions (Accounts Payable)
- Inventory valuation
- Tax handling
- Revenue recognition
- Multicurrency adjustments

**Only a small number of accounts carry a Special Account Type; most will be blank.**

### What it controls:
- Which account NetSuite uses as an official control account
- How certain transactions are posted
- How subledgers (AR, AP, Inventory, Tax, FX) interact with the general ledger
- System logic tied to required accounts

### When it's used:
✔ Identifying the true system control accounts  
✔ Troubleshooting unexpected posting behavior  
✔ Understanding how transactions flow  
✔ Ensuring system-required accounts are not repurposed  
✔ Designing automations or queries that rely on system roles  

> **Think of Special Account Type as:**
> 
> *"What does NetSuite use this account for behind the scenes?"*

---

## 3. Why Both Classifications Matter

These two fields solve different problems:

| Purpose | Account Type | Special Account Type |
|---------|:------------:|:--------------------:|
| Financial reporting and layout | ✔ | |
| Organizing financial categories | ✔ | |
| Identifying all accounts in a reporting section | ✔ | |
| Understanding system-required accounts | | ✔ |
| Knowing which account NetSuite posts to for a function | | ✔ |
| Troubleshooting system behavior | | ✔ |

---

## Common Special Account Type Values

| Code | Description |
|------|-------------|
| `AcctRec` | Accounts Receivable control account |
| `AcctPay` | Accounts Payable control account |
| `InvtAsset` | Inventory Asset account |
| `UndepFunds` | Undeposited Funds account |
| `DeferRevenue` | Deferred Revenue account |
| `DeferExpense` | Deferred Expense / Prepaid account |
| `RetEarnings` | Retained Earnings account |
| `SalesTaxPay` | Sales Tax Payable account |
| `CumulTransAdj` | Cumulative Translation Adjustment (CTA) |
| `RealizedERV` | Realized FX Gain/Loss account |
| `UnrERV` | Unrealized FX Gain/Loss account |

---

## Using in XAVI Formulas

The `XAVI.TYPEBALANCE` formula can query by either classification:

```excel
// Query by Account Type (financial reporting)
=XAVI.TYPEBALANCE("OthCurrAsset",,"Dec 2025")

// Query by Special Account Type (system accounts)
=XAVI.TYPEBALANCE("AcctRec",,"Dec 2025",,,,,,1)
```

The last parameter (`1`) tells the formula to use Special Account Type instead of Account Type.

---

## See Also

- [USER_GUIDE_TYPEBALANCE.md](USER_GUIDE_TYPEBALANCE.md) - Formula syntax and examples
