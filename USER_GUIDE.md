# XAVI for NetSuite - User Guide

**Version 3.0.5.193** | Last Updated: December 2025

---

## Table of Contents

1. [What is XAVI?](#what-is-xavi)
2. [Getting Started](#getting-started)
3. [Formula Reference](#formula-reference)
4. [Using Wildcards for Summary Reports](#using-wildcards-for-summary-reports)
5. [Filtering by Subsidiary, Department, Class, Location](#filtering-by-subsidiary-department-class-location)
6. [Pre-Built Reports](#pre-built-reports)
7. [Performance Tips](#performance-tips)
8. [Troubleshooting](#troubleshooting)
9. [FAQ](#faq)

---

## What is XAVI?

XAVI is an Excel add-in that connects directly to your NetSuite account, allowing you to pull live financial data into Excel using simple formulas. No more exporting CSVs or copying/pasting from NetSuite reports!

### Key Benefits

| Traditional Approach | With XAVI |
|---------------------|-----------|
| Export CSV from NetSuite | Live formulas pull data on demand |
| Manual copy/paste | Auto-refresh with one click |
| Stale data within hours | Real-time accuracy |
| Breaking links when structure changes | Dynamic account references |

---

## Getting Started

### Step 1: Open the Task Pane

In Excel, go to the **Home** ribbon and click the **XAVI** button to open the task pane.

### Step 2: Enter Your First Formula

In any Excel cell, type:

```
=XAVI.BALANCE("4010", "Jan 2025", "Jan 2025")
```

This returns the balance for account 4010 for January 2025.

### Step 3: Make It Dynamic

Instead of hardcoding values, use cell references:

| | A | B |
|---|---|---|
| **1** | **Account** | **Jan 2025** |
| **2** | 4010 | `=XAVI.BALANCE($A2, B$1, B$1)` |
| **3** | 5000 | `=XAVI.BALANCE($A3, B$1, B$1)` |

Now you can:
- Drag the formula **down** to add more accounts
- Drag the formula **right** to add more months
- XAVI automatically batches requests for speed!

---

## Formula Reference

### XAVI.BALANCE

Get the GL account balance for a specific period or date range.

**Syntax:**
```
=XAVI.BALANCE(account, fromPeriod, toPeriod, [subsidiary], [department], [location], [class], [accountingBook])
```

**Parameters:**

| Parameter | Required | Description | Example |
|-----------|----------|-------------|---------|
| account | Yes | Account number or wildcard pattern | `"4010"` or `"4*"` |
| fromPeriod | Yes | Start period | `"Jan 2025"` or `"2025"` |
| toPeriod | Yes | End period | `"Dec 2025"` or `"2025"` |
| subsidiary | No | Subsidiary name or ID | `"Celigo Inc."` |
| department | No | Department name or ID | `"Sales"` |
| location | No | Location name or ID | `"US"` |
| class | No | Class name or ID | `"Enterprise"` |
| accountingBook | No | Accounting book ID | `"1"` |

**Examples:**
```
=XAVI.BALANCE("4010", "Jan 2025", "Jan 2025")
=XAVI.BALANCE("4010", "2025", "2025")                    ← Full year (faster!)
=XAVI.BALANCE("4*", "Jan 2025", "Dec 2025")             ← All revenue accounts
=XAVI.BALANCE("4010", "Q1 2025", "Q1 2025", "Celigo Inc.")
=XAVI.BALANCE(A2, B$1, B$1, $P$3, $Q$3, $R$3, $S$3)    ← With cell references
```

---

### XAVI.BUDGET

Get the budget amount for an account and period.

**Syntax:**
```
=XAVI.BUDGET(account, fromPeriod, toPeriod, [subsidiary], [department], [location], [class], [accountingBook], [budgetCategory])
```

**Examples:**
```
=XAVI.BUDGET("5000", "Jan 2025", "Dec 2025")
=XAVI.BUDGET("6*", "2025", "2025")                      ← All expense budgets
=XAVI.BUDGET("5000", "Q1 2025", "Q1 2025", "Celigo Inc.", "Sales")
```

---

### XAVI.NAME

Get the account name from an account number.

**Syntax:**
```
=XAVI.NAME(account)
```

**Example:**
```
=XAVI.NAME("4010")     → "Product Revenue"
```

---

### XAVI.TYPE

Get the account type (Income, Expense, Bank, etc.).

**Syntax:**
```
=XAVI.TYPE(account)
```

**Example:**
```
=XAVI.TYPE("4010")     → "Income"
=XAVI.TYPE("1000")     → "Bank"
```

---

### XAVI.PARENT

Get the parent account number for a sub-account.

**Syntax:**
```
=XAVI.PARENT(account)
```

**Example:**
```
=XAVI.PARENT("4010-1")  → "4010"
```

---

### Special Formulas

These formulas calculate values that NetSuite computes dynamically (not stored as account balances):

| Formula | Purpose | Example |
|---------|---------|---------|
| `XAVI.RETAINEDEARNINGS` | Cumulative P&L through prior year-end | `=XAVI.RETAINEDEARNINGS("Dec 2024")` |
| `XAVI.NETINCOME` | YTD Net Income | `=XAVI.NETINCOME("Mar 2025")` |
| `XAVI.CTA` | Cumulative Translation Adjustment | `=XAVI.CTA("Dec 2024")` |

---

## Using Wildcards for Summary Reports

### What Are Wildcards?

Use `*` in the account number to sum multiple accounts at once. This is perfect for executive summaries!

### Common Patterns

| Pattern | What It Sums | Typical Use |
|---------|--------------|-------------|
| `"4*"` | All 4xxx accounts | **Total Revenue** |
| `"5*"` | All 5xxx accounts | **Total COGS** |
| `"6*"` | All 6xxx accounts | **Operating Expenses** |
| `"7*"` | All 7xxx accounts | **Other Operating** |
| `"8*"` | All 8xxx accounts | **Other Income/Expense** |
| `"40*"` | All 40xx accounts | Product Revenue only |
| `"41*"` | All 41xx accounts | Service Revenue only |
| `"60*"` | All 60xx accounts | Payroll & Benefits |

### Example: CFO Flash Report

Build a complete P&L summary in just 4 formulas:

| | A | B |
|---|---|---|
| **1** | | **Jan 2025** |
| **2** | Revenue | `=XAVI.BALANCE("4*", B$1, B$1)` |
| **3** | COGS | `=XAVI.BALANCE("5*", B$1, B$1)` |
| **4** | Gross Profit | `=B2-B3` |
| **5** | Operating Expenses | `=XAVI.BALANCE("6*", B$1, B$1)` |
| **6** | Operating Income | `=B4-B5` |

### Example: Departmental Expense Comparison

```
=XAVI.BALANCE("6*", "Q1 2025", "Q1 2025", "", "Sales")        → Sales OpEx
=XAVI.BALANCE("6*", "Q1 2025", "Q1 2025", "", "Engineering")  → Engineering OpEx
=XAVI.BALANCE("6*", "Q1 2025", "Q1 2025", "", "Marketing")    → Marketing OpEx
```

### Example: Subsidiary Revenue Comparison

```
=XAVI.BALANCE("4*", "2025", "2025", "Celigo Inc.")            → US Revenue
=XAVI.BALANCE("4*", "2025", "2025", "Celigo Europe B.V.")     → Europe Revenue
=XAVI.BALANCE("4*", "2025", "2025", "Celigo Australia")       → Australia Revenue
```

### Combining XAVI Formulas with Excel Math

XAVI formulas return numbers, so you can use standard Excel operations to combine them. This is powerful for calculating margins, variances, and custom metrics.

**Gross Profit (Revenue minus COGS):**
```
=XAVI.BALANCE("4*", "2025", "2025", "Celigo Inc. (Consolidated)")
 - XAVI.BALANCE("5*", "2025", "2025", "Celigo Inc. (Consolidated)")
```

**Gross Margin Percentage:**
```
=(XAVI.BALANCE("4*", "2025", "2025") - XAVI.BALANCE("5*", "2025", "2025"))
 / XAVI.BALANCE("4*", "2025", "2025")
```

**Year-over-Year Variance:**
```
=XAVI.BALANCE("4*", "2025", "2025") - XAVI.BALANCE("4*", "2024", "2024")
```

**Budget vs. Actual:**
```
=XAVI.BALANCE("6*", "Jan 2025", "Jan 2025") - XAVI.BUDGET("6*", "Jan 2025", "Jan 2025")
```

**Sum Multiple Subsidiaries (alternative to Consolidated):**
```
=XAVI.BALANCE("4*", "2025", "2025", "Celigo Inc.")
 + XAVI.BALANCE("4*", "2025", "2025", "Celigo Europe B.V.")
 + XAVI.BALANCE("4*", "2025", "2025", "Celigo Australia")
```

> **Tip:** For cleaner formulas, put each XAVI.BALANCE in its own cell, then use a simple formula like `=B2-B3` or `=SUM(B2:B4)` to combine them.

---

## Filtering by Subsidiary, Department, Class, Location

### Using the Filters Panel

1. Open the XAVI task pane
2. Expand the **Filters** section
3. Select a filter type (Subsidiary, Department, etc.)
4. Click **Insert** to add the filter value to your current cell

### Dynamic Filters with Cell References

**Best Practice:** Put filter values in cells and reference them in formulas:

| | P | Q | R | S |
|---|---|---|---|---|
| **2** | **Subsidiary** | **Department** | **Location** | **Class** |
| **3** | Celigo Inc. | Sales | | |

Then use in formulas:
```
=XAVI.BALANCE("4010", "Jan 2025", "Jan 2025", $P$3, $Q$3, $R$3, $S$3)
```

This lets you change filters in ONE place and update the entire report!

### Consolidated vs. Individual Subsidiary

- **Individual:** `"Celigo Inc."` → Only that subsidiary's transactions
- **Consolidated:** `"Celigo Inc. (Consolidated)"` → Includes all child subsidiaries

---

## Pre-Built Reports

### CFO Flash Report (Quick Start)

Create an executive-level P&L summary in seconds:

1. Open the **Quick Start** section in the task pane
2. Select **CFO Flash Report**
3. Choose your year and subsidiary
4. XAVI builds a high-level P&L with totals for Revenue, COGS, Gross Profit, Operating Expenses, and Net Income

This is perfect for:
- Board presentations
- Monthly flash reports
- Quick variance checks

### Build Income Statement

For a detailed P&L with all accounts:

1. Click **Build Income Statement** in the task pane
2. Select the year and (optionally) subsidiary
3. Click **Build**
4. XAVI creates a complete P&L with all your accounts!

The report includes:
- All revenue accounts (4xxx)
- Cost of Goods Sold (5xxx)
- Operating Expenses (6xxx)
- Other Income/Expense (7xxx, 8xxx)
- Calculated rows: Gross Profit, Operating Income, Net Income

### Build Budget Report

1. Click **Build Budget Report**
2. Select the year, subsidiary, and budget category
3. Click **Build**
4. Compare actuals vs. budget side-by-side!

---

## Drill-Down Feature

### What is Drill-Down?

Drill-down lets you see the underlying transactions behind any balance. Click into a formula to see exactly what makes up that number!

### How to Drill Down

**Recommended Method: Quick Actions Button**

1. Select a cell containing a XAVI formula
2. Look at the **Quick Actions** bar at the bottom of the task pane
3. Click the **Drill Down** button
4. A new sheet is created with the transaction details

**Alternative Method: Right-Click Menu**

1. Right-click on a cell with a XAVI formula
2. Select **CloudExtend** → **View Transactions**

> ⚠️ **Note for Mac Users:** The right-click menu may not work reliably on Mac Excel due to platform limitations. We recommend using the Quick Actions "Drill Down" button instead.

### Drill-Down Types

| Formula Type | First Drill-Down | Second Drill-Down |
|--------------|------------------|-------------------|
| **XAVI.BALANCE** | Shows all transactions for that account | N/A |
| **XAVI.TYPEBALANCE** | Shows all accounts of that type with balances | Select an account row → shows transactions |

### TYPEBALANCE Two-Level Drill-Down

TYPEBALANCE formulas aggregate multiple accounts, so drill-down works in two steps:

1. **First Level:** Click a TYPEBALANCE cell → See all accounts of that type with their balances
2. **Second Level:** Select an account row on the drill-down sheet → Click "Drill Down" again → See individual transactions

The Quick Actions bar shows "Account row selected • Drill Down to transactions" when you're ready for the second level.

### Transaction Sheet Features

Each drill-down sheet includes:
- **Account Number** (for wildcard or TYPEBALANCE drills)
- **Date** - Transaction date
- **Type** - Invoice, Bill, Journal Entry, etc.
- **Number** - Transaction number (click to open in NetSuite!)
- **Entity** - Customer, Vendor, or Employee
- **Memo** - Transaction description
- **Debit/Credit** - Individual line amounts
- **Net Amount** - Net impact on the account

---

## Performance Tips

### Use Year-Only Format

Instead of:
```
=XAVI.BALANCE("4010", "Jan 2025", "Dec 2025")   ← 12 separate queries
```

Use:
```
=XAVI.BALANCE("4010", "2025", "2025")           ← 1 optimized query
```

### Drag, Don't Type

When adding multiple formulas:
1. Enter ONE formula with proper cell references
2. Drag down/right to copy
3. XAVI batches all requests automatically (60+ formulas → 1 API call)

### Refresh When Data Seems Stale

If data seems stale after posting new transactions:
1. Click **Refresh All** in the task pane (automatically clears cache)
2. Or use **Refresh Selected** to update just highlighted cells

---

## Troubleshooting

### Formula Returns 0

**Possible causes:**
1. Account number doesn't exist in NetSuite
2. No transactions for that account/period
3. Filters are too restrictive (wrong subsidiary/department)

**Solution:** Verify the account exists in NetSuite and has activity for the period.

### Formula Shows #BUSY

**Cause:** XAVI is fetching data from NetSuite.

**Solution:** Wait a few seconds. If it persists, check your internet connection.

### Formula Shows #VALUE!

**Cause:** Invalid parameter format.

**Solution:** Check that:
- Account is a number or valid wildcard (e.g., `"4010"` or `"4*"`)
- Period format is correct (e.g., `"Jan 2025"` or `"2025"`)
- Filter parameters use `""` for empty, not missing

### All Formulas Return 0 Suddenly

**Possible causes:**
1. Server connection issue
2. Tunnel URL changed

**Solution:** 
1. Click **Refresh All** in the task pane (clears cache automatically)
2. Check the connection status indicator in the task pane
3. If connection shows disconnected, contact your administrator

### Slow Performance

**Solution:**
1. Use year-only format (`"2025"`) instead of month ranges
2. Use wildcards for summary rows instead of many individual accounts
3. Drag formulas instead of typing each one (triggers batch optimization)

---

## FAQ

### Q: How often does data refresh?

Data is cached for 5 minutes. Click **Refresh All** to force a refresh with the latest data from NetSuite, or use **Refresh Selected** for specific cells.

### Q: Can I use XAVI offline?

No, XAVI requires an internet connection to communicate with NetSuite.

### Q: Why do some account signs look different than NetSuite?

XAVI shows the true GL (General Ledger) values. NetSuite sometimes displays different signs for presentation purposes. The **totals always match** - only individual line signs may differ.

### Q: Can I use wildcards with budgets?

Yes! `=XAVI.BUDGET("6*", "2025", "2025")` returns the sum of all 6xxx expense budgets.

### Q: How do I report on multiple subsidiaries?

Use `"(Consolidated)"` suffix:
```
=XAVI.BALANCE("4*", "2025", "2025", "Celigo Inc. (Consolidated)")
```

Or create separate rows for each subsidiary and sum them.

### Q: Can I mix wildcards with exact accounts?

In a single formula, use one pattern. But you can have different formulas:
- Row 1: `=XAVI.BALANCE("4*",...)` → Total Revenue
- Row 2: `=XAVI.BALANCE("4010",...)` → Product Revenue (detail)
- Row 3: `=XAVI.BALANCE("4020",...)` → Service Revenue (detail)

---

## Need Help?

- **Task Pane:** Expand "Getting Started Guide" for quick tips
- **Formula Reference:** Expand "Formula Reference" in the task pane
- **Support:** Contact your XAVI administrator

---

*Copyright © 2025 Celigo, Inc. All rights reserved.*

