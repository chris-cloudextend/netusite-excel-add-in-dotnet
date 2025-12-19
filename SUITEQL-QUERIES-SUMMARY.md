# NetSuite Excel Add-in - SuiteQL Queries Reference

This document provides a comprehensive reference of all SuiteQL queries used in the XAVI Excel Add-in.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Core Tables](#core-tables)
3. [Lookup Queries](#lookup-queries)
4. [Balance Queries](#balance-queries)
5. [Special Formula Queries](#special-formula-queries)
6. [Segment Filter Queries](#segment-filter-queries)
7. [Performance Optimization](#performance-optimization)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         EXCEL ADD-IN                                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                 │
│  │XAVI.BALANCE │  │ XAVI.NAME   │  │ XAVI.TYPE   │                 │
│  │ (balances)  │  │ (names)     │  │ (types)     │                 │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘                 │
└─────────┼────────────────┼────────────────┼────────────────────────┘
          │                │                │
          ▼                ▼                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      PYTHON BACKEND (server.py)                     │
│                                                                     │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │ /batch/balance   │  │ /account/name    │  │ /account/type    │  │
│  │ /full_year_refresh│ │                  │  │                  │  │
│  └────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘  │
│           │                     │                     │            │
│           ▼                     ▼                     ▼            │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │                    SuiteQL Queries                          │    │
│  └────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         NETSUITE API                                │
│                    (SuiteQL REST endpoint)                          │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Core Tables

| Table | Purpose | Key Fields |
|-------|---------|------------|
| `TransactionAccountingLine` | Posted amounts | `account`, `amount`, `posting`, `accountingbook`, `transactionline` |
| `TransactionLine` | Transaction line details | `class`, `department`, `location` |
| `Transaction` | Transaction header | `id`, `trandate`, `postingperiod`, `posting`, `subsidiary` |
| `Account` | Chart of Accounts | `id`, `acctnumber`, `accttype`, `fullname`, `parent` |
| `AccountingPeriod` | Fiscal periods | `id`, `periodname`, `startdate`, `enddate`, `isyear`, `isquarter` |
| `Subsidiary` | Legal entities | `id`, `name`, `parent`, `iselimination`, `isinactive` |
| `Department` | Departments | `id`, `name`, `fullname`, `isinactive` |
| `Classification` | Classes | `id`, `name`, `fullname`, `isinactive` |
| `Location` | Locations | `id`, `name`, `fullname`, `isinactive` |

### Critical Field Locations

| Field | Table | Alias |
|-------|-------|-------|
| `class` | TransactionLine | `tl.class` |
| `department` | TransactionLine | `tl.department` |
| `location` | TransactionLine | `tl.location` |
| `subsidiary` | Transaction | `t.subsidiary` |
| `account` | TransactionAccountingLine | `tal.account` |
| `amount` | TransactionAccountingLine | `tal.amount` |
| `accountingbook` | TransactionAccountingLine | `tal.accountingbook` |

---

## Lookup Queries

### Get All Departments
```sql
SELECT id, name, fullName, isinactive 
FROM Department 
ORDER BY fullName
```

### Get All Classes
```sql
SELECT id, name, fullName, isinactive 
FROM Classification 
ORDER BY fullName
```

### Get All Locations
```sql
SELECT id, name, fullName, isinactive 
FROM Location 
ORDER BY fullName
```

### Get All Subsidiaries (with hierarchy)
```sql
SELECT 
    s.id,
    s.name,
    s.fullName AS hierarchy,
    s.parent
FROM Subsidiary s
WHERE s.isinactive = 'F'
ORDER BY s.fullName
```

### Get Accounting Books
```sql
SELECT id, name, isprimary
FROM AccountingBook
WHERE isinactive = 'F'
ORDER BY isprimary DESC, name
```

### Get Account Name
```sql
SELECT accountsearchdisplaynamecopy AS account_name
FROM Account
WHERE acctnumber = '{account_number}'
```

### Get Account Type
```sql
SELECT accttype AS account_type
FROM Account
WHERE acctnumber = '{account_number}'
```

### Get Period Dates
```sql
SELECT startdate, enddate, id
FROM AccountingPeriod
WHERE periodname = '{period_name}'
  AND isyear = 'F' 
  AND isquarter = 'F'
```

---

## Balance Queries

### P&L Query (Income Statement)

P&L accounts show **activity within the specific period only**.

```sql
SELECT 
    a.acctnumber,
    ap.periodname,
    SUM(cons_amt) AS balance
FROM (
    SELECT
        tal.account,
        t.postingperiod,
        CASE
            WHEN subs_count > 1 THEN
                TO_NUMBER(
                    BUILTIN.CONSOLIDATE(
                        tal.amount,
                        'LEDGER',
                        'DEFAULT',
                        'DEFAULT',
                        {target_sub},
                        t.postingperiod,
                        'DEFAULT'
                    )
                )
            ELSE tal.amount
        END
        * CASE WHEN a.accttype IN ('Income', 'OthIncome') THEN -1 ELSE 1 END AS cons_amt
    FROM TransactionAccountingLine tal
        JOIN Transaction t ON t.id = tal.transaction
        JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
        JOIN Account a ON a.id = tal.account
        JOIN AccountingPeriod apf ON apf.id = t.postingperiod
        CROSS JOIN (
            SELECT COUNT(*) AS subs_count
            FROM Subsidiary
            WHERE isinactive = 'F'
        ) subs_cte
    WHERE t.posting = 'T'
        AND tal.posting = 'T'
        AND tal.accountingbook = {accountingbook}
        AND a.acctnumber IN ({account_list})
        AND apf.periodname IN ({period_list})
        AND a.accttype IN ('Income', 'OthIncome', 'COGS', 'Cost of Goods Sold', 'Expense', 'OthExpense')
        AND tl.class = {class_id}  -- Optional segment filter
) x
JOIN Account a ON a.id = x.account
JOIN AccountingPeriod ap ON ap.id = x.postingperiod
GROUP BY a.acctnumber, ap.periodname
ORDER BY a.acctnumber, ap.periodname
```

### Balance Sheet Query (Single Period)

Balance Sheet accounts show **cumulative balance from inception through period end**.

```sql
SELECT 
    a.acctnumber AS account_number,
    SUM(
        TO_NUMBER(
            BUILTIN.CONSOLIDATE(
                tal.amount,
                'LEDGER',
                'DEFAULT',
                'DEFAULT',
                {target_sub},
                target_period.id,
                'DEFAULT'
            )
        )
    ) AS balance
FROM TransactionAccountingLine tal
    INNER JOIN Transaction t ON t.id = tal.transaction
    INNER JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
    INNER JOIN Account a ON a.id = tal.account
    INNER JOIN AccountingPeriod ap ON ap.id = t.postingperiod
    CROSS JOIN (
        SELECT id, enddate 
        FROM AccountingPeriod 
        WHERE periodname = '{target_period_name}'
            AND isquarter = 'F' 
            AND isyear = 'F'
        FETCH FIRST 1 ROWS ONLY
    ) target_period
WHERE 
    t.posting = 'T'
    AND tal.posting = 'T'
    AND tal.accountingbook = {accountingbook}
    AND a.accttype NOT IN ('Income', 'OthIncome', 'COGS', 'Cost of Goods Sold', 'Expense', 'OthExpense')
    AND ap.startdate <= target_period.enddate
    AND ap.isyear = 'F'
    AND ap.isquarter = 'F'
GROUP BY a.acctnumber
HAVING SUM(...) <> 0
ORDER BY a.acctnumber
```

### Full Year P&L (Pivoted - Optimized)

Returns **one row per account with 12 month columns**.

```sql
SELECT
    a.acctnumber AS account_number,
    a.accttype AS account_type,
    SUM(CASE WHEN TO_CHAR(ap.startdate,'YYYY-MM')='{year}-01' THEN cons_amt ELSE 0 END) AS jan,
    SUM(CASE WHEN TO_CHAR(ap.startdate,'YYYY-MM')='{year}-02' THEN cons_amt ELSE 0 END) AS feb,
    SUM(CASE WHEN TO_CHAR(ap.startdate,'YYYY-MM')='{year}-03' THEN cons_amt ELSE 0 END) AS mar,
    SUM(CASE WHEN TO_CHAR(ap.startdate,'YYYY-MM')='{year}-04' THEN cons_amt ELSE 0 END) AS apr,
    SUM(CASE WHEN TO_CHAR(ap.startdate,'YYYY-MM')='{year}-05' THEN cons_amt ELSE 0 END) AS may,
    SUM(CASE WHEN TO_CHAR(ap.startdate,'YYYY-MM')='{year}-06' THEN cons_amt ELSE 0 END) AS jun,
    SUM(CASE WHEN TO_CHAR(ap.startdate,'YYYY-MM')='{year}-07' THEN cons_amt ELSE 0 END) AS jul,
    SUM(CASE WHEN TO_CHAR(ap.startdate,'YYYY-MM')='{year}-08' THEN cons_amt ELSE 0 END) AS aug,
    SUM(CASE WHEN TO_CHAR(ap.startdate,'YYYY-MM')='{year}-09' THEN cons_amt ELSE 0 END) AS sep,
    SUM(CASE WHEN TO_CHAR(ap.startdate,'YYYY-MM')='{year}-10' THEN cons_amt ELSE 0 END) AS oct,
    SUM(CASE WHEN TO_CHAR(ap.startdate,'YYYY-MM')='{year}-11' THEN cons_amt ELSE 0 END) AS nov,
    SUM(CASE WHEN TO_CHAR(ap.startdate,'YYYY-MM')='{year}-12' THEN cons_amt ELSE 0 END) AS dec_month
FROM (
    SELECT
        tal.account,
        t.postingperiod,
        CASE
            WHEN subs_count > 1 THEN
                TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT',
                    {target_sub}, t.postingperiod, 'DEFAULT'))
            ELSE tal.amount
        END
        * CASE WHEN a.accttype IN ('Income', 'OthIncome') THEN -1 ELSE 1 END AS cons_amt
    FROM TransactionAccountingLine tal
        JOIN Transaction t ON t.id = tal.transaction
        JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
        JOIN Account a ON a.id = tal.account
        JOIN AccountingPeriod apf ON apf.id = t.postingperiod
        CROSS JOIN (SELECT COUNT(*) AS subs_count FROM Subsidiary WHERE isinactive = 'F') subs_cte
    WHERE t.posting = 'T'
        AND tal.posting = 'T'
        AND tal.accountingbook = {accountingbook}
        AND apf.isyear = 'F' 
        AND apf.isquarter = 'F'
        AND TO_CHAR(apf.startdate,'YYYY') = '{year}'
        AND a.accttype IN ('Income', 'OthIncome', 'COGS', 'Cost of Goods Sold', 'Expense', 'OthExpense')
) x
JOIN AccountingPeriod ap ON ap.id = x.postingperiod
JOIN Account a ON a.id = x.account
GROUP BY a.acctnumber, a.accttype
ORDER BY a.acctnumber
```

---

## Special Formula Queries

### RETAINEDEARNINGS

```
RE = Prior Years' P&L + Posted RE Adjustments
```

**Query 1: Prior Years' P&L**
```sql
SELECT SUM(
    TO_NUMBER(BUILTIN.CONSOLIDATE(
        tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', 
        {target_sub}, {target_period_id}, 'DEFAULT'
    )) * -1
) AS value
FROM TransactionAccountingLine tal
JOIN Transaction t ON t.id = tal.transaction
JOIN Account a ON a.id = tal.account
JOIN AccountingPeriod ap ON ap.id = t.postingperiod
WHERE t.posting = 'T'
  AND tal.posting = 'T'
  AND a.accttype IN ('COGS', 'Cost of Goods Sold', 'Expense', 'Income', 'OthExpense', 'OthIncome')
  AND ap.enddate < TO_DATE('{fy_start_date}', 'YYYY-MM-DD')
  AND ap.isyear = 'F' AND ap.isquarter = 'F'
  AND tal.accountingbook = {accountingbook}
```

**Query 2: Posted RE Adjustments**
```sql
SELECT SUM(
    TO_NUMBER(BUILTIN.CONSOLIDATE(
        tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', 
        {target_sub}, {target_period_id}, 'DEFAULT'
    )) * -1
) AS value
FROM TransactionAccountingLine tal
JOIN Transaction t ON t.id = tal.transaction
JOIN Account a ON a.id = tal.account
JOIN AccountingPeriod ap ON ap.id = t.postingperiod
WHERE t.posting = 'T'
  AND tal.posting = 'T'
  AND (a.accttype = 'RetainedEarnings' OR LOWER(a.fullname) LIKE '%retained earnings%')
  AND ap.enddate <= TO_DATE('{period_end_date}', 'YYYY-MM-DD')
  AND ap.isyear = 'F' AND ap.isquarter = 'F'
  AND tal.accountingbook = {accountingbook}
```

### NETINCOME

```
NI = Sum of all P&L from fiscal year start through target period end
```

```sql
SELECT SUM(
    TO_NUMBER(BUILTIN.CONSOLIDATE(
        tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', 
        {target_sub}, {target_period_id}, 'DEFAULT'
    )) * -1
) AS net_income
FROM TransactionAccountingLine tal
JOIN Transaction t ON t.id = tal.transaction
JOIN Account a ON a.id = tal.account
JOIN AccountingPeriod ap ON ap.id = t.postingperiod
WHERE t.posting = 'T'
  AND tal.posting = 'T'
  AND a.accttype IN ('COGS', 'Cost of Goods Sold', 'Expense', 'Income', 'OthExpense', 'OthIncome')
  AND ap.startdate >= TO_DATE('{fy_start_date}', 'YYYY-MM-DD')
  AND ap.enddate <= TO_DATE('{period_end_date}', 'YYYY-MM-DD')
  AND ap.isyear = 'F' AND ap.isquarter = 'F'
  AND tal.accountingbook = {accountingbook}
```

### CTA (Cumulative Translation Adjustment)

CTA uses the **PLUG METHOD** for 100% accuracy:

```
CTA = (Total Assets - Total Liabilities) - Posted Equity - Retained Earnings - Net Income
```

**6 parallel queries run to get each component:**

1. **Total Assets** - Sum of all asset accounts
2. **Total Liabilities** - Sum of all liability accounts (× -1)
3. **Posted Equity** - Sum of equity accounts excluding RE (× -1)
4. **Prior Years' P&L** - Same as RE Query 1
5. **Posted RE Adjustments** - Same as RE Query 2
6. **Net Income** - Same as NI query

---

## Segment Filter Queries

### With Class/Department/Location Filters

**CRITICAL:** When filtering by class, department, or location, you MUST join to `TransactionLine`:

```sql
FROM TransactionAccountingLine tal
    JOIN Transaction t ON t.id = tal.transaction
    JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
    JOIN Account a ON a.id = tal.account
WHERE ...
    AND tl.class = {class_id}
    AND tl.department = {department_id}
    AND tl.location = {location_id}
```

**Without the TransactionLine join, you'll get:**
```
Error: Field 'class' for record 'TransactionAccountingLine' was not found
```

---

## Performance Optimization

### Query Execution Times (Typical)

| Query Type | Typical Time | Notes |
|------------|--------------|-------|
| Account name lookup | <1 sec | Single row |
| Account type lookup | <1 sec | Single row |
| Full Year P&L (pivoted) | 5-15 sec | All accounts × 12 months |
| Full Year BS | 30-90 sec | Complex CONSOLIDATE calls |
| Batch balance (10 accts × 3 periods) | 3-8 sec | |
| RE/NI calculation | 5-15 sec | 2 parallel queries |
| CTA calculation | 15-30 sec | 6 parallel queries |

### Pagination

NetSuite limits SuiteQL results to 1000 rows. Use API-level pagination:
```
POST /query/v1/suiteql?limit=1000&offset=0
POST /query/v1/suiteql?limit=1000&offset=1000
...
```

### BUILTIN.CONSOLIDATE

**Critical for multi-currency:** Always use the **target period ID** for exchange rate:

```sql
-- CORRECT: Use report period for all translations
BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', 
                    {target_sub}, {target_period_id}, 'DEFAULT')

-- WRONG: Uses each transaction's posting period
BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', 
                    {target_sub}, t.postingperiod, 'DEFAULT')
```

### Sign Conventions

| Account Type | Stored As | Display Multiply |
|--------------|-----------|------------------|
| Assets | Positive | × 1 |
| Liabilities | Negative | × -1 |
| Equity | Negative | × -1 |
| Income | Negative | × -1 |
| Expenses | Positive | × 1 |

### Special Account (sspecacct) Sign Handling

NetSuite uses "Matching" special accounts as contra/offset entries for currency revaluation. These require an **additional sign inversion**:

```sql
-- Standard P&L sign logic PLUS Matching account inversion
SUM(amount) 
    * CASE WHEN a.accttype IN ('Income', 'OthIncome') THEN -1 ELSE 1 END
    * CASE WHEN a.sspecacct LIKE 'Matching%' THEN -1 ELSE 1 END
```

| Account | sspecacct | Effect |
|---------|-----------|--------|
| 89100 - Unrealized Gain/Loss | `UnrERV` | Normal sign |
| 89201 - Unrealized Matching Gain/Loss | `MatchingUnrERV` | **Inverted sign** |

Find all Matching accounts:
```sql
SELECT id, acctnumber, fullname, accttype, sspecacct 
FROM account 
WHERE sspecacct LIKE 'Matching%'
```

### Account Type Constants

**CRITICAL - Exact spelling required:**
```python
DEFERRED_EXPENSE = 'DeferExpense'    # NOT 'DeferExpens'
DEFERRED_REVENUE = 'DeferRevenue'    # NOT 'DeferRevenu'
CRED_CARD = 'CredCard'               # NOT 'CreditCard'
```

---

## Backend Endpoints Reference

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/batch/full_year_refresh` | POST | Fetch all P&L accounts for fiscal year |
| `/batch/bs_periods` | POST | Fetch all BS accounts for specific periods |
| `/batch/balance` | POST | Fetch specific accounts for specific periods |
| `/batch/account_types` | POST | Get account types for a list of accounts |
| `/retained-earnings` | POST | Calculate Retained Earnings |
| `/net-income` | POST | Calculate Net Income |
| `/cta` | POST | Calculate CTA |
| `/account/name` | POST | Get account name |
| `/account/type` | POST | Get account type |
| `/lookups/all` | GET | Get filter lookups |

---

*Document Version: 2.0*
*Last Updated: December 2025*
*Add-in Version: 3.0.5.161*

