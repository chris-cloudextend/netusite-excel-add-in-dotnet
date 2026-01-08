# Retained Earnings Calculation Approach - SuiteQL Implementation

## Overview
Retained Earnings = Prior Years' Cumulative P&L + Posted RE Adjustments

This document outlines the complete approach for calculating Retained Earnings using NetSuite SuiteQL queries.

## Step 1: Get Fiscal Year Information

Before calculating Retained Earnings, we need to:
1. Find the fiscal year for the target period
2. Get the first period of that fiscal year (to filter "prior years" P&L)

### Query 1: Get Fiscal Year Info for Target Period

**Purpose:** Find the fiscal year that contains the target period (e.g., "May 2025")

**SuiteQL:**
```sql
SELECT 
    fy.id AS fiscal_year_id,
    fy.startdate AS fy_start,
    fy.enddate AS fy_end,
    tp.id AS period_id,
    tp.startdate AS period_start,
    tp.enddate AS period_end
FROM accountingperiod tp
LEFT JOIN accountingperiod q ON q.id = tp.parent AND q.isquarter = 'T'
LEFT JOIN accountingperiod fy ON (
    (q.parent IS NOT NULL AND fy.id = q.parent) OR
    (q.parent IS NULL AND tp.parent IS NOT NULL AND fy.id = tp.parent)
)
WHERE LOWER(tp.periodname) = LOWER('May 2025')
  AND tp.isquarter = 'F'
  AND tp.isyear = 'F'
  AND fy.isyear = 'T'
ORDER BY tp.id
OFFSET 0 ROWS FETCH NEXT 1 ROWS ONLY
```

**Returns:**
- `fiscal_year_id`: The fiscal year ID (e.g., 342 for FY 2025)
- `fy_start`: Fiscal year start date (e.g., "2025-01-01")
- `fy_end`: Fiscal year end date (e.g., "2025-12-31")
- `period_id`: Target period ID (e.g., 349 for May 2025)
- `period_start`: Target period start date
- `period_end`: Target period end date

### Query 2: Get First Period of Fiscal Year

**Purpose:** Find the first posting period of the fiscal year (e.g., "Jan 2025" = period 344)

**SuiteQL:**
```sql
SELECT id
FROM accountingperiod
WHERE parent = 342
  AND isquarter = 'F'
  AND isyear = 'F'
  AND isposting = 'T'
ORDER BY startdate
OFFSET 0 ROWS FETCH NEXT 1 ROWS ONLY
```

**Returns:**
- `id`: The period ID of the first month of the fiscal year (e.g., 344 for Jan 2025)

**Why this is needed:** We use this period ID to filter "all P&L before fiscal year start" using `t.postingperiod < {fyStartPeriodId}`

## Step 2: Calculate Retained Earnings

Retained Earnings consists of two components:

### Component 1: Prior Years' Cumulative P&L

**Purpose:** Sum all P&L account activity from inception through the end of the prior fiscal year

**SuiteQL:**
```sql
SELECT SUM(
    TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', 1, 349, 'DEFAULT'))
    * -1
) AS value
FROM transactionaccountingline tal
JOIN transaction t ON t.id = tal.transaction
JOIN account a ON a.id = tal.account
JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
WHERE t.posting = 'T'
  AND tal.posting = 'T'
  AND a.accttype IN ('Income', 'COGS', 'Expense', 'OthIncome', 'OthExpense')
  AND t.postingperiod < 344
  AND tal.accountingbook = 1
  AND tl.subsidiary IN (1, 3, 4, 2, 5, 6, 7, 8)
```

**Key Points:**
- **Account Types:** Only P&L accounts (Income, COGS, Expense, OthIncome, OthExpense)
- **Period Filter:** `t.postingperiod < {fyStartPeriodId}` - All periods BEFORE fiscal year start
- **Sign Flip:** `* -1` converts NetSuite's stored amounts to reporting format:
  - Income (stored as credits/negative) → positive
  - Expenses (stored as debits/positive) → negative
  - Result: Accumulated Net Income = Income - Expenses
- **BUILTIN.CONSOLIDATE:** Converts foreign currency amounts to consolidation currency
  - Parameters: `amount, 'LEDGER', 'DEFAULT', 'DEFAULT', {subsidiary}, {periodId}, 'DEFAULT'`
  - Uses target period ID (349) for exchange rate translation
- **Segment Filters:** Includes subsidiary hierarchy and optional department/class/location filters

### Component 2: Posted RE Adjustments

**Purpose:** Sum all journal entries posted directly to Retained Earnings accounts

**SuiteQL:**
```sql
SELECT SUM(
    TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', 1, 349, 'DEFAULT'))
    * -1
) AS value
FROM transactionaccountingline tal
JOIN transaction t ON t.id = tal.transaction
JOIN account a ON a.id = tal.account
JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
WHERE t.posting = 'T'
  AND tal.posting = 'T'
  AND (a.accttype = 'RetainedEarnings' OR LOWER(a.fullname) LIKE '%retained earnings%')
  AND t.postingperiod <= 349
  AND tal.accountingbook = 1
  AND tl.subsidiary IN (1, 3, 4, 2, 5, 6, 7, 8)
```

**Key Points:**
- **Account Filter:** Retained Earnings account type OR account name contains "retained earnings"
- **Period Filter:** `t.postingperiod <= {targetPeriodId}` - All RE adjustments up to and including target period
- **Sign Flip:** `* -1` because RE is equity (credit-normal), stored as negative, displayed as positive
- **BUILTIN.CONSOLIDATE:** Same currency conversion as Component 1

## Final Calculation

```
Retained Earnings = Prior P&L + Posted RE Adjustments
```

**Example:**
- Prior P&L (all P&L before FY 2025 start): $1,000,000
- Posted RE Adjustments (through May 2025): $50,000
- **Retained Earnings = $1,050,000**

## Current Issue

The `GetFiscalYearInfoAsync` method is failing with:
```
syntax error, state:0(10102) near: FETCH(9,17, token code:0)
```

**Attempted Fix:**
- Changed from `FETCH FIRST 1 ROWS ONLY` to `OFFSET 0 ROWS FETCH NEXT 1 ROWS ONLY`
- Still failing with same error

**Possible Solutions to Investigate:**
1. Remove `ORDER BY` clause and use `FETCH FIRST 1 ROWS ONLY` (worked 4 weeks ago)
2. Use `FETCH NEXT 1 ROWS ONLY` without `OFFSET 0`
3. Use a subquery with `ROWNUM` or similar NetSuite-specific syntax
4. Fetch all results and take first in C# code (less efficient but might work)
5. Check if NetSuite version/configuration changed that affects FETCH syntax

## Error Flow

1. `GetFiscalYearInfoAsync` fails on Query 1 or Query 2
2. `fyStartPeriodId` is `null`
3. Retained Earnings calculation checks: `if (fyStartPeriodId == null)`
4. Returns error: "Could not find period for fiscal year start: 2025-01-01"

## Variables Used

- `periodName`: Input period name (e.g., "May 2025")
- `accountingBook`: Accounting book ID (default: 1)
- `targetSub`: Target subsidiary ID (default: "1" for consolidated)
- `hierarchySubs`: List of subsidiary IDs in hierarchy (e.g., [1, 3, 4, 2, 5, 6, 7, 8])
- `fyInfo`: FiscalYearInfo object containing:
  - `PeriodId`: Target period ID
  - `FyStart`: Fiscal year start date
  - `FyStartPeriodId`: First period ID of fiscal year (the critical one that's failing)
- `targetPeriodId`: Period ID for exchange rate translation in BUILTIN.CONSOLIDATE
- `fyStartPeriodId`: Period ID used to filter "prior years" P&L

## Related: CTA Calculation

CTA (Cumulative Translation Adjustment) uses similar logic:
- Also requires `GetFiscalYearInfoAsync` to get `fyStartPeriodId`
- Uses same period-based filtering approach
- Fails with same error when `fyStartPeriodId` is null
