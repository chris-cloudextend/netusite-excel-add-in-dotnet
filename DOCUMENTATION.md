# XAVI for NetSuite - Complete Documentation

## Table of Contents

1. [Overview](#overview)
2. [For Finance Users (CPA Perspective)](#for-finance-users-cpa-perspective)
3. [For Engineers (Technical Reference)](#for-engineers-technical-reference)
4. [Why SuiteQL Over ODBC](#why-suiteql-over-odbc)
5. [Pre-Caching & Drag-Drop Optimization](#pre-caching--drag-drop-optimization)
6. [SuiteQL Deep Dive](#suiteql-deep-dive)
7. [BUILTIN.CONSOLIDATE Explained](#builtinconsolidate-explained)
8. [Account Types & Sign Conventions](#account-types--sign-conventions)
   - [NetSuite Display Signs vs. GL Signs](#netsuite-display-signs-vs-gl-signs)
   - [Income Statement Formula Sign Conventions](#income-statement-formula-sign-conventions-auto-generated-reports)
9. [AWS Migration Roadmap](#aws-migration-roadmap)
10. [CEFI Integration (CloudExtend Federated Integration)](#cefi-integration-cloudextend-federated-integration)
11. [Troubleshooting](#troubleshooting)

---

# Overview

**XAVI for NetSuite** is an Excel Add-in that provides custom formulas to retrieve financial data directly from NetSuite. Finance teams can build dynamic reports in Excel that pull live data from their ERP.

### Why XAVI?

| Traditional Approach | With XAVI |
|---------------------|-----------|
| Export CSV from NetSuite | Live formulas pull data on demand |
| Manual copy/paste | Auto-refresh with one click |
| Stale data within hours | Real-time accuracy |
| Breaking links when structure changes | Dynamic account references |

### Available Functions

| Function | Purpose | Example |
|----------|---------|---------|
| `XAVI.BALANCE` | Get GL account balance | `=XAVI.BALANCE("4010", "Jan 2025", "Jan 2025")` |
| `XAVI.BUDGET` | Get budget amount | `=XAVI.BUDGET("4010", "Jan 2025", "Dec 2025")` |
| `XAVI.NAME` | Get account name | `=XAVI.NAME("4010")` → "Product Revenue" |
| `XAVI.TYPE` | Get account type | `=XAVI.TYPE("4010")` → "Income" |
| `XAVI.PARENT` | Get parent account | `=XAVI.PARENT("4010-1")` → "4010" |
| `XAVI.RETAINEDEARNINGS` | Calculate Retained Earnings | `=XAVI.RETAINEDEARNINGS("Dec 2024")` |
| `XAVI.NETINCOME` | Calculate Net Income YTD | `=XAVI.NETINCOME("Mar 2025")` |
| `XAVI.CTA` | Calculate Cumulative Translation Adjustment | `=XAVI.CTA("Dec 2024")` |

---

# For Finance Users (CPA Perspective)

## Understanding the Formulas

### XAVI.BALANCE - The Foundation

This is your primary formula for building financial statements. It retrieves the balance for any GL account for any period.

**Syntax:**
```
=XAVI.BALANCE(account, fromPeriod, toPeriod, [subsidiary], [department], [location], [class], [accountingBook])
```

**Wildcard Support:**
The `account` parameter supports wildcards using `*` to match multiple accounts at once:

| Pattern | Matches | Use Case |
|---------|---------|----------|
| `"4*"` | All accounts starting with 4 | Total Revenue (all 4xxx accounts) |
| `"40*"` | All accounts starting with 40 | Product Revenue only |
| `"5*"` | All accounts starting with 5 | Total COGS |
| `"6*"` | All accounts starting with 6 | Total Operating Expenses |
| `"4010"` | Account 4010 only | Exact match (no 40100, 40101, etc.) |

**Example:**
```
=XAVI.BALANCE("4*", "Jan 2025", "Dec 2025")  → Sum of ALL revenue accounts
=XAVI.BALANCE("60*", "Q1 2025", "Q1 2025")  → Sum of 60xx expense accounts
```

This is particularly useful for creating summary rows without listing every account individually.

**For Balance Sheet accounts** (Assets, Liabilities, Equity):
- The formula returns the **cumulative balance** as of period end
- This matches how NetSuite displays Balance Sheet balances
- Example: Cash as of Jan 2025 = all cash transactions from inception through Jan 31, 2025

**For Income Statement accounts** (Revenue, Expenses):
- The formula returns **activity for the period**
- This matches NetSuite's P&L presentation
- Example: Revenue for Jan 2025 = only January revenue transactions

### Why Are RE, NI, and CTA Separate?

NetSuite doesn't store Retained Earnings, Net Income, or CTA as actual account balances. Instead, it **calculates them dynamically** when you run reports. XAVI replicates these calculations:

#### Retained Earnings
```
RE = All P&L from company inception through prior fiscal year end
   + Any journal entries posted directly to Retained Earnings accounts
```

**When to use:** Balance Sheet reports showing the equity section.

#### Net Income
```
NI = All P&L from fiscal year start through the report period
```

**When to use:** Balance Sheet reports (completes equity section) or to verify P&L totals.

#### CTA (Cumulative Translation Adjustment)

**What is CTA?**
In multi-currency companies, when you translate foreign subsidiary balances to your reporting currency:
- Balance Sheet accounts translate at **period-end exchange rate**
- Income Statement accounts translate at **average or transaction rate**
- The difference creates an imbalance → CTA is the "plug" that balances the Balance Sheet

**Why the "plug method"?**
NetSuite calculates additional translation adjustments at runtime that are never posted to any account. The only way to get 100% accuracy is:
```
CTA = (Total Assets - Total Liabilities) - Posted Equity - Retained Earnings - Net Income
```

This guarantees Assets = Liabilities + Equity, matching NetSuite exactly.

### Multi-Book Accounting

If your organization maintains multiple sets of books (GAAP, IFRS, Tax, etc.), use the `accountingBook` parameter:

```
=XAVI.BALANCE("4010", "Jan 2025", "Jan 2025", "", "", "", "", 1)  ← Primary Book
=XAVI.BALANCE("4010", "Jan 2025", "Jan 2025", "", "", "", "", 2)  ← Secondary Book (IFRS)
```

The accounting book ID can be found in NetSuite under Setup → Accounting → Accounting Books.

### Consolidation

When running consolidated reports across subsidiaries:
1. Use the parent subsidiary name or ID in the subsidiary parameter
2. XAVI will automatically consolidate all child subsidiaries
3. Foreign currency amounts are translated at the appropriate exchange rates

```
=XAVI.BALANCE("4010", "Dec 2024", "Dec 2024", "Parent Company")
```

### Best Practices

1. **Use Refresh Accounts** before presenting reports - ensures all data is fresh
2. **Recalculate Retained Earnings** separately - these calculations take 30-60 seconds each
3. **Reference periods from cells** - makes it easy to change the report date
4. **Use the subsidiary hierarchy** - parent subsidiaries automatically include children

---

# For Engineers (Technical Reference)

## Architecture (Current)

```
┌─────────────────────┐     ┌─────────────────────┐     ┌─────────────────┐
│   Excel Add-in      │────▶│   Cloudflare        │────▶│   Flask Backend │
│   (functions.js)    │     │   Worker + Tunnel   │     │   (server.py)   │
│                     │◀────│                     │◀────│   localhost:5002│
│   - Custom funcs    │     │   - CORS proxy      │     │   - SuiteQL     │
│   - Caching         │     │   - TLS termination │     │   - OAuth1      │
│   - Build mode      │     │                     │     │   - Caching     │
└─────────────────────┘     └─────────────────────┘     └─────────────────┘
         │                                                       │
         ▼                                                       ▼
┌─────────────────────┐                              ┌─────────────────┐
│   Taskpane UI       │                              │    NetSuite     │
│   (taskpane.html)   │                              │    SuiteQL API  │
└─────────────────────┘                              └─────────────────┘
```

## File Structure

```
├── backend/
│   ├── server.py              # Flask API server (SuiteQL queries)
│   ├── constants.py           # Account type constants
│   ├── requirements.txt       # Python dependencies
│   └── netsuite_config.json   # Credentials (gitignored)
├── docs/
│   ├── functions.js           # Custom Excel functions + caching
│   ├── functions.json         # Function metadata for Excel
│   ├── functions.html         # Functions runtime page
│   ├── taskpane.html          # Taskpane UI + refresh logic
│   ├── commands.html          # Ribbon commands
│   └── commands.js            # Command implementations
├── excel-addin/
│   └── manifest-claude.xml    # Excel add-in manifest
├── CLOUDFLARE-WORKER-CODE.js  # Proxy worker code
└── DOCUMENTATION.md           # This file
```

## Backend Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/batch/full_year_refresh` | POST | Fetch all P&L accounts for fiscal year |
| `/batch/bs_periods` | POST | Fetch all BS accounts for specific periods |
| `/batch/balance` | POST | Fetch specific accounts for specific periods |
| `/batch/account_types` | POST | Get account types for classification |
| `/retained-earnings` | POST | Calculate Retained Earnings |
| `/net-income` | POST | Calculate Net Income |
| `/cta` | POST | Calculate CTA |
| `/account/name` | POST | Get account name |
| `/account/type` | POST | Get account type |
| `/lookups/all` | GET | Get filter lookups |

## Wildcard Account Support

All account-related endpoints support wildcard patterns using `*`:

**Implementation (`server.py`):**
```python
def build_account_filter(accounts, column='a.acctnumber'):
    """
    Build SQL filter clause for account numbers, supporting wildcards.
    - '4*' becomes LIKE '4%' (all accounts starting with 4)
    - '4010' (no asterisk) uses exact match with IN clause
    
    Returns SQL like "(a.acctnumber IN ('4010','4020') OR a.acctnumber LIKE '5%')"
    """
```

**Key behavior:**
- Wildcards are converted to SQL LIKE patterns (`*` → `%`)
- Mixed queries work: `['4010', '5*']` → `IN ('4010') OR LIKE '5%'`
- Account type detection expands wildcards first, then classifies into P&L vs BS
- Results are **summed** across all matched accounts

**Use cases:**
- `"4*"` - Sum all revenue accounts (4xxx)
- `"60*"` - Sum operating expense accounts (60xx)
- `"1*"` - Sum all asset accounts (Balance Sheet)

### Performance Optimization

Wildcards are fully optimized for batch operations:

| Operation | Without Batching | With Batching |
|-----------|------------------|---------------|
| 5 wildcards × 12 months | 60 API calls | **1 API call** |
| Latency | ~30+ seconds | **~2-3 seconds** |

The frontend automatically:
1. Detects rapid formula creation (drag/paste)
2. Collects all formulas into a batch
3. Sends ONE request with all wildcards + periods
4. Distributes results to all waiting formulas

---

# Wildcard Accounts - Executive Reporting

## For Finance Users (CPA Perspective)

### Build High-Level Reports in Minutes

Wildcards let you create executive dashboards without manually listing every account. This is ideal for:

- **Board presentations** - Show only top-level numbers
- **Monthly flash reports** - Quick P&L summaries
- **Variance analysis** - Compare totals without detail clutter
- **Multi-subsidiary consolidations** - High-level views across entities

### Common Wildcard Patterns

| Pattern | What It Captures | Typical Use |
|---------|------------------|-------------|
| `"4*"` | All 4xxx accounts | **Total Revenue** |
| `"5*"` | All 5xxx accounts | **Total COGS** |
| `"6*"` | All 6xxx accounts | **Operating Expenses** |
| `"7*"` | All 7xxx accounts | **Other Operating Expenses** |
| `"8*"` | All 8xxx accounts | **Other Income/Expense** |
| `"1*"` | All 1xxx accounts | **Total Assets** |
| `"2*"` | All 2xxx accounts | **Total Liabilities** |
| `"3*"` | All 3xxx accounts | **Total Equity** |

### Real-World Examples

**Example 1: CFO Flash Report (4 rows)**
```
A               B                                           C
Revenue         =XAVI.BALANCE("4*", "Jan 2025", "Jan 2025") $8,289,880
COGS            =XAVI.BALANCE("5*", "Jan 2025", "Jan 2025") $1,234,567
Gross Profit    =B1-B2                                      $7,055,313
Operating Exp   =XAVI.BALANCE("6*", "Jan 2025", "Jan 2025") $4,500,000
```

**Example 2: Departmental Expense Summary**
```
=XAVI.BALANCE("6*", "Q1 2025", "Q1 2025", "", "Sales")       → Sales Dept OpEx
=XAVI.BALANCE("6*", "Q1 2025", "Q1 2025", "", "Engineering") → Engineering OpEx
=XAVI.BALANCE("6*", "Q1 2025", "Q1 2025", "", "Marketing")   → Marketing OpEx
```

**Example 3: Subsidiary Comparison**
```
=XAVI.BALANCE("4*", "2025", "2025", "Celigo Inc.")           → US Revenue
=XAVI.BALANCE("4*", "2025", "2025", "Celigo Europe B.V.")    → Europe Revenue
=XAVI.BALANCE("4*", "2025", "2025", "Celigo Australia")      → Australia Revenue
```

### Granular Control with Sub-Patterns

Need more granularity? Use longer patterns:

| Pattern | Matches | Use Case |
|---------|---------|----------|
| `"40*"` | 4000-4099 | Product Revenue only |
| `"41*"` | 4100-4199 | Service Revenue only |
| `"60*"` | 6000-6099 | Payroll & Benefits |
| `"61*"` | 6100-6199 | Professional Services |
| `"62*"` | 6200-6299 | Facilities & Equipment |

### Important: Wildcards Return SUMS

When you use `"4*"`, you get the **sum of all matching accounts** — not a list. This is intentional for summary reporting.

If you need individual account detail:
- Use exact account numbers: `"4010"`, `"4020"`, etc.
- Use the **Build Income Statement** feature for full detail
- Combine: Detail rows with specific accounts + Summary row with wildcard

---

# Why SuiteQL (REST API) Over ODBC

## Executive Summary

We chose SuiteQL via REST API over NetSuite's ODBC driver (SuiteAnalytics Connect) for three primary reasons:

| Factor | ODBC (SuiteAnalytics Connect) | SuiteQL (REST API) |
|--------|-------------------------------|-------------------|
| **Annual Cost** | $5,000 - $20,000+ | $0 (included) |
| **Client Setup** | Driver installation required | No installation |
| **Firewall** | Database port required | HTTPS only (443) |

> **Important Clarification:** Both ODBC and REST API can execute SuiteQL queries. ODBC via NetSuite2.com data source supports SuiteQL syntax including `BUILTIN.CONSOLIDATE`. The key differences are licensing cost and deployment simplicity, not query capabilities.

## Cost Analysis

### ODBC Driver Costs
NetSuite's ODBC driver (SuiteAnalytics Connect) requires additional licensing purchased separately from your core NetSuite platform:

| Cost Component | Annual Cost |
|----------------|-------------|
| SuiteAnalytics Connect License | **$5,000 - $20,000/year** |
| Additional user seats (if required) | Variable |
| **Total** | **$5,000 - $20,000+/year** |

> *Pricing varies significantly by negotiation. Community reports range from $5K to $20K annually. Some customers have negotiated inclusion in their base contract.*

### SuiteQL REST API Costs
- **License Cost:** $0 - Included with all NetSuite subscriptions
- **API Calls:** Included in standard governance limits
- **Infrastructure:** Only backend server costs (~$50/month for AWS hosting)

### ROI Calculation

For an organization:
```
ODBC Approach:
  SuiteAnalytics Connect License: $5,000-20,000/year
  Driver deployment/maintenance: Time cost

XAVI with SuiteQL REST:
  License: $0
  AWS hosting: ~$50/month = $600/year
  Total: $600/year

Annual Savings: $4,400 - $19,400 (88-97% reduction)
```

## Technical Comparison

### What's the SAME (Both Use SuiteQL)

Both ODBC and REST API can run SuiteQL queries with:
- ✅ `BUILTIN.CONSOLIDATE` for multi-currency consolidation
- ✅ Complex JOINs, GROUP BY, aggregations
- ✅ SQL-92 syntax support
- ✅ Oracle syntax support (REST API has fewer limitations)

**Key limitation for ODBC:** Cannot use WITH clauses (CTEs) via ODBC. REST API supports full SuiteQL syntax.

### What's DIFFERENT

| Aspect | ODBC | REST API |
|--------|------|----------|
| **Licensing** | Additional purchase required | Included |
| **Client Setup** | ODBC driver installation | None |
| **Firewall** | Database port access | HTTPS (443) only |
| **Authentication** | User/Pass, OAuth 2.0, or TBA | OAuth 1.0 (TBA) |
| **Power BI** | Import only (no DirectQuery) | N/A for Excel |
| **WITH Clauses** | Not supported | Supported |

### Why We Chose REST API

1. **Zero Licensing Cost:** No SuiteAnalytics Connect purchase required
2. **No Driver Installation:** Users don't need ODBC drivers on their machines
3. **Simpler Firewall:** Only HTTPS (port 443) needed, no database ports
4. **Full SuiteQL Support:** Including WITH clauses and modern Oracle features
5. **Web-Native:** Works with Excel Add-ins hosted via GitHub Pages

### ODBC Advantages We Traded Away

- **Direct BI Tool Integration:** Power BI, Tableau can connect directly via ODBC
- **Familiar SQL Tools:** Works with any ODBC-compatible application
- **Bulk Data Export:** May be faster for very large one-time exports

For our use case (real-time Excel formulas), REST API's zero-cost and no-installation benefits outweigh ODBC's BI tool compatibility.

## Authentication Clarification

**Both approaches support modern authentication:**

| Method | ODBC | REST API |
|--------|------|----------|
| Username/Password | ✅ | ❌ |
| OAuth 2.0 | ✅ | ❌ |
| Token-Based Auth (TBA) | ✅ | ✅ |
| OAuth 1.0 | ❌ | ✅ |

We use OAuth 1.0 with Token-Based Authentication (TBA) for the REST API.

## References

- NetSuite SuiteQL Documentation: [docs.oracle.com/netsuite](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/chapter_157108952762.html)
- SuiteAnalytics Connect: [NetSuite Help Center](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_3aborqgzaqc.html)
- Community Pricing Discussion: [NetSuite Professionals](https://archive.netsuiteprofessionals.com/)

---

# Pre-Caching & Drag-Drop Optimization

## The Challenge

Without optimization, a typical financial report with 100 accounts × 12 months = **1,200 individual API calls**, resulting in hours of waiting.

NetSuite has strict limits:
- **Concurrency:** Max 5 simultaneous API requests
- **Row Limit:** 1,000 rows per query response
- **Rate Limiting:** Too many requests = 429 errors

## Our Solution: Intelligent Pre-Caching

### Build Mode Detection

When users drag formulas across cells, Excel creates formulas nearly simultaneously. We detect this pattern:

```
User drags formula across 12 months:
  → Formula 1: triggers Build Mode (3+ formulas in 500ms)
  → Formula 2-12: queued, show #BUSY placeholder
  → User stops dragging
  → 800ms passes (settle time)
  → Single optimized batch request for ALL data
  → All cells update simultaneously
```

**Detection Criteria:**
```javascript
const BUILD_MODE_THRESHOLD = 3;       // Formulas to trigger
const BUILD_MODE_WINDOW_MS = 500;     // Detection window
const BUILD_MODE_SETTLE_MS = 800;     // Wait after last formula
```

### Pivoted Query Optimization (Periods as Columns)

The **key innovation** is returning multiple periods as columns in a single row, rather than separate rows:

**Traditional Approach (Slow):**
```
12 queries, one per month:
  Query 1: Get Jan 2025 balance for Account 4010
  Query 2: Get Feb 2025 balance for Account 4010
  ... (10 more queries)
```

**Our Approach (Fast):**
```sql
-- Single query returns ALL months as columns
SELECT
  a.acctnumber,
  SUM(CASE WHEN TO_CHAR(ap.startdate,'YYYY-MM')='2025-01' THEN amount ELSE 0 END) AS jan_2025,
  SUM(CASE WHEN TO_CHAR(ap.startdate,'YYYY-MM')='2025-02' THEN amount ELSE 0 END) AS feb_2025,
  SUM(CASE WHEN TO_CHAR(ap.startdate,'YYYY-MM')='2025-03' THEN amount ELSE 0 END) AS mar_2025,
  -- ... all 12 months
FROM TransactionAccountingLine tal
  JOIN Transaction t ON t.id = tal.transaction
  JOIN Account a ON a.id = tal.account
  JOIN AccountingPeriod ap ON ap.id = t.postingperiod
WHERE t.posting = 'T'
  AND a.accttype IN ('Income', 'Expense', ...)
  AND EXTRACT(YEAR FROM ap.startdate) = 2025
GROUP BY a.acctnumber
```

**Result:** One query returns 200 accounts × 12 months = 2,400 data points.

### Full Year Refresh Endpoint

When Build Mode detects 6+ months for the same fiscal year, it triggers `/batch/full_year_refresh`:

```javascript
// Endpoint automatically:
// 1. Fetches ALL P&L accounts for the entire year
// 2. Returns pivoted data (periods as columns)
// 3. Caches everything for instant subsequent lookups

POST /batch/full_year_refresh
{
  "year": 2025,
  "subsidiary": "1",
  "accountingBook": "1"
}

// Response: ~200 accounts × 12 months in one response
```

### Smart Period Expansion

When dragging formulas, we automatically pre-cache adjacent months:

```
User requests: Jan 2025, Feb 2025, Mar 2025
System fetches: Dec 2024, Jan 2025, Feb 2025, Mar 2025, Apr 2025

Why?
- User likely to scroll left/right
- Minimal extra cost (same query complexity)
- Instant response when they do
```

### Three-Tier Caching Architecture

```
┌─────────────────────────────────────────────────────────┐
│  TIER 1: In-Memory Cache (functions.js)                 │
│  - Speed: Microseconds                                  │
│  - Scope: Current session                               │
│  - Size: Unlimited (Map structure)                      │
├─────────────────────────────────────────────────────────┤
│  TIER 2: localStorage Cache                             │
│  - Speed: Milliseconds                                  │
│  - Scope: Persists across taskpane refreshes            │
│  - TTL: 5 minutes                                       │
│  - Shared: Between taskpane and custom functions        │
├─────────────────────────────────────────────────────────┤
│  TIER 3: Backend Cache (server.py)                      │
│  - Speed: Avoids NetSuite roundtrip                     │
│  - TTL: 5 minutes                                       │
│  - Benefit: Shared across all users                     │
└─────────────────────────────────────────────────────────┘
```

### Explicit Zero Caching

**Problem:** Accounts with $0 balance return no rows from NetSuite (no transactions = no data).

**Solution:** After fetching, explicitly cache `$0` for any requested account/period NOT in the response:

```javascript
// NetSuite returns:
{ "4220": { "Jan 2025": 50000, "Feb 2025": 45000 } }
// Note: Mar 2025 missing = $0 balance

// We explicitly cache:
cache.set("4220:Mar 2025", 0);  // Now cached as $0, not a miss
```

This prevents repeated queries for zero-balance accounts.

### Performance Results

| Scenario | Without Optimization | With Optimization |
|----------|---------------------|-------------------|
| Single formula | 2-5 sec | 2-5 sec |
| 20 formulas (batch) | 40-100 sec | 5-10 sec |
| Drag 12 months | 60-180 sec + timeouts | 15-20 sec first, instant after |
| Full sheet refresh | Hours + errors | 30-60 sec |
| Second request (cached) | Same as first | **Instant** |

---

# SuiteQL Deep Dive

## Core Tables

| Table | Purpose | Key Fields |
|-------|---------|------------|
| `TransactionAccountingLine` | Actual posted amounts | `account`, `amount`, `posting`, `accountingbook` |
| `Transaction` | Transaction header | `id`, `trandate`, `postingperiod`, `posting` |
| `Account` | Chart of Accounts | `acctnumber`, `accttype`, `fullname` |
| `AccountingPeriod` | Fiscal periods | `id`, `periodname`, `startdate`, `enddate` |
| `Subsidiary` | Legal entities | `id`, `name`, `parent`, `iselimination` |

## Standard Balance Query Structure

```sql
SELECT 
    a.acctnumber,
    SUM(cons_amount) AS balance
FROM TransactionAccountingLine tal
    JOIN Transaction t ON t.id = tal.transaction
    JOIN Account a ON a.id = tal.account
    JOIN AccountingPeriod ap ON ap.id = t.postingperiod
WHERE t.posting = 'T'                    -- Only posted transactions
  AND tal.posting = 'T'                  -- Only posting lines
  AND tal.accountingbook = {book_id}     -- Specific accounting book
  AND a.acctnumber IN ({accounts})       -- Filter accounts
  AND ap.periodname IN ({periods})       -- Filter periods
GROUP BY a.acctnumber
```

## P&L vs Balance Sheet Queries

**The fundamental difference:**

| Type | Date Filter | What it Returns |
|------|-------------|-----------------|
| P&L (Income Statement) | `ap.periodname IN ('Jan 2025')` | Activity for the period |
| Balance Sheet | `ap.enddate <= '2025-01-31'` | Cumulative balance through period end |

**P&L Query:**
```sql
WHERE ...
  AND ap.periodname IN ('Jan 2025', 'Feb 2025')  -- Specific periods only
  AND a.accttype IN ('Income', 'Expense', 'COGS', ...)
```

**Balance Sheet Query:**
```sql
WHERE ...
  AND ap.enddate <= TO_DATE('2025-01-31', 'YYYY-MM-DD')  -- All time through period
  AND a.accttype IN ('Bank', 'AcctRec', 'AcctPay', ...)
```

## Segment Filters (Class, Department, Location)

**CRITICAL:** Class, Department, and Location fields are on `TransactionLine`, NOT `TransactionAccountingLine`!

```sql
-- WRONG (will fail with "Field 'class' not found"):
WHERE tal.class = 85

-- CORRECT (join to TransactionLine):
FROM TransactionAccountingLine tal
  JOIN Transaction t ON t.id = tal.transaction
  JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
WHERE tl.class = 85
```

| Field | Correct Table | Alias |
|-------|---------------|-------|
| `class` | TransactionLine | `tl.class` |
| `department` | TransactionLine | `tl.department` |
| `location` | TransactionLine | `tl.location` |
| `subsidiary` | Transaction | `t.subsidiary` |
| `account` | TransactionAccountingLine | `tal.account` |
| `amount` | TransactionAccountingLine | `tal.amount` |

When filtering by class/department/location, always add the TransactionLine join.

---

# BUILTIN.CONSOLIDATE Explained

## Why It's Critical

In multi-currency, multi-subsidiary environments, `BUILTIN.CONSOLIDATE` is the **only way** to get correct consolidated amounts. It handles:

1. **Currency Translation:** Converts foreign currency to reporting currency
2. **Intercompany Elimination:** Removes intercompany transactions
3. **Subsidiary Rollup:** Aggregates child subsidiaries to parent

## Syntax

```sql
BUILTIN.CONSOLIDATE(
    tal.amount,           -- Source amount (transaction currency)
    'LEDGER',             -- Amount type
    'DEFAULT',            -- Exchange rate type
    'DEFAULT',            -- Consolidation type
    {target_sub},         -- Target subsidiary ID
    {target_period_id},   -- Period ID for exchange rates
    'DEFAULT'             -- Elimination handling
)
```

## The Critical Period Parameter

**This is the #1 source of bugs!**

```sql
-- WRONG: Uses each transaction's posting period for exchange rate
BUILTIN.CONSOLIDATE(tal.amount, ..., t.postingperiod, ...)

-- CORRECT: Uses report period for all translations
BUILTIN.CONSOLIDATE(tal.amount, ..., {target_period_id}, ...)
```

**Why it matters:**

A January transaction in EUR at 1.10 USD/EUR:
- **Wrong way:** Translates at January rate (1.10) = $110
- **Correct way:** Translates at December rate (1.15) = $115

The Balance Sheet must show ALL amounts at the **same period-end rate** to balance correctly.

## When NOT to Use BUILTIN.CONSOLIDATE

- Single-currency environments (no translation needed)
- Single subsidiary (no consolidation needed)
- Non-OneWorld NetSuite accounts

The backend detects these cases:
```python
if target_sub:
    cons_amount = f"BUILTIN.CONSOLIDATE(tal.amount, ...)"
else:
    cons_amount = "tal.amount"  # Use raw amount
```

---

# Account Types & Sign Conventions

## NetSuite's Internal Storage

| Account Type | Natural Balance | Stored As | Display Multiply |
|--------------|----------------|-----------|------------------|
| **Assets** (Bank, AcctRec, etc.) | Debit | Positive | × 1 |
| **Liabilities** (AcctPay, etc.) | Credit | Negative | × -1 |
| **Equity** | Credit | Negative | × -1 |
| **Income** | Credit | Negative | × -1 |
| **Expenses** (COGS, Expense) | Debit | Positive | × 1 |

## Account Type Constants

**CRITICAL: Exact spelling required!**

```python
# CORRECT (from constants.py)
DEFERRED_EXPENSE = 'DeferExpense'    # NOT 'DeferExpens'
DEFERRED_REVENUE = 'DeferRevenue'    # NOT 'DeferRevenu'
CRED_CARD = 'CredCard'               # NOT 'CreditCard'
```

These typos caused a $60M+ CTA discrepancy. The queries silently exclude accounts with misspelled types.

## Complete Type Reference

### Balance Sheet - Assets
```
Bank              Bank/Cash accounts
AcctRec           Accounts Receivable
OthCurrAsset      Other Current Asset
FixedAsset        Fixed Asset
OthAsset          Other Asset
DeferExpense      Deferred Expense (prepaid)
UnbilledRec       Unbilled Receivable
```

### Balance Sheet - Liabilities
```
AcctPay           Accounts Payable
CredCard          Credit Card
OthCurrLiab       Other Current Liability
LongTermLiab      Long Term Liability
DeferRevenue      Deferred Revenue (unearned)
```

### Balance Sheet - Equity
```
Equity            Common stock, APIC, etc.
RetainedEarnings  Retained Earnings
```

### Income Statement
```
Income            Revenue
OthIncome         Other Income
COGS              Cost of Goods Sold (modern)
Cost of Goods Sold  COGS (legacy - include BOTH!)
Expense           Operating Expense
OthExpense        Other Expense
```

## NetSuite Display Signs vs. GL Signs

### Why Do Signs Look Different in Excel vs NetSuite?

**NetSuite's financial report does not display the true GL sign for Other Expense accounts.**

Instead, it applies presentation formatting rules depending on:
- Account type
- Whether the number represents a gain or a loss
- Whether the subsidiary uses foreign currency
- Whether the report is consolidated or local

**These rules are for readability only and do not reflect the actual debit/credit polarity.**

### Example: NetSuite Display Formatting

| Account Type | GL Value | NetSuite UI Prints | Why |
|--------------|----------|-------------------|-----|
| Currency Gain (credit) | +475.28 | -$475.28 | Displayed as a *reduction* of expense |
| Income Tax (expense) | -1,874.71 | -1,874.71 | Displayed with GL sign |
| Unrealized Gain (credit) | +743.19 | $743.19 | Displayed as a positive gain |

**XAVI shows the true GL numbers, not the UI format.**

This is why:
- ✅ **Net Income ALWAYS matches**
- ✅ **Total Other Expense math is correct**
- ⚠️ **Individual line signs may look different**

### Why Subtotal Signs May Not Match

NetSuite computes: `Total Other Expense = SUM(GL values)`

Then formats the line to match display expectations:
- Expenses shown as positive
- Gains shown as negative
- Result flipped depending on context

But XAVI's subtotal uses true GL signs, so:
- The **numbers are correct**
- The **signs reflect the true financial polarity**
- The **printed NetSuite signs do not reflect the GL**

---

### For Finance Users (CPA Explanation)

> NetSuite formats certain Other Expense lines differently from how they exist in the general ledger. This affects display only — not the underlying values. XAVI shows the actual GL signs, which ensures all calculations including Net Income exactly match NetSuite's financial results.

**How to validate:**
1. Compare **Net Income** — it will match exactly
2. Compare **section subtotals** — they will match
3. Individual line signs may differ due to NetSuite's display formatting

---

### For Engineers (Technical Explanation)

NetSuite's UI applies contextual sign reversals to Other Income/Expense accounts. These reversals are **not applied at the GL or search API level**.

Since XAVI uses GL-accurate values from SuiteQL and `BUILTIN.CONSOLIDATE`:
- Signs may differ from UI formatting
- **Calculations remain mathematically correct**
- All formulas sum properly to Net Income

**No special sign manipulation:** XAVI uses raw GL values for all accounts. This ensures mathematical accuracy - Net Income always matches NetSuite exactly when using the correct formula (see Net Income formula below).

---

### For QA (Validation Guidance)

**Ignore sign differences in the Other Expense section.**

Validate correctness using:

```
Net Income = Operating Income + Total Other Income + Total Other Expense
```

**Do NOT validate by** comparing printed signs line-by-line to NetSuite.

Line signs in NetSuite UI are not reliable indicators of true GL polarity.

**What to check:**
- ✅ Net Income matches NetSuite
- ✅ Section subtotals match NetSuite  
- ✅ Excel formulas sum correctly to subtotals
- ⚠️ Individual account signs may differ (this is expected)

---

## Income Statement Formula Sign Conventions (Auto-Generated Reports)

### The Challenge: Double-Entry Accounting in Excel

When XAVI auto-generates Income Statements, it must handle the fundamental challenge that **NetSuite stores amounts using double-entry accounting conventions**, not the intuitive "positive = income, negative = expense" model that finance users expect.

#### Double-Entry Storage vs. Financial Report Display

| What You See on Reports | What's Stored in NetSuite | Why? |
|-------------------------|---------------------------|------|
| Revenue: **$100,000** (positive) | Credit: **-$100,000** (negative) | Revenue is a credit to income accounts |
| COGS: **$60,000** (positive expense) | Debit: **$60,000** (positive) | Cost reduces inventory (credit) and increases expense (debit) |
| Revenue Refund: **-$5,000** (reduces revenue) | Debit: **$5,000** (positive) | Refund is a debit to income account |
| Expense Credit/Refund: **-$2,000** (reduces expense) | Credit: **-$2,000** (negative) | Credit to expense reduces the expense |

### The Problem with Simple Formulas

The original formulas assumed consistent signs:

```excel
// BROKEN: Assumed COGS is always positive (debit = expense)
Gross Profit = Revenue - ABS(COGS)

// What happens with a COGS credit (refund/reversal)?
// COGS value = -5000 (a credit reducing cost)
// ABS(-5000) = 5000
// Result: Revenue - 5000 = WRONG (should ADD the credit back)
```

This caused incorrect calculations in periods with:
- Year-end adjustments
- Accrual reversals  
- Credit-heavy months (like December)
- Vendor refunds or rebates

### The Solution: Sign-Aware Formulas

**Key Insight:** The sign of the value tells you its accounting nature:

| Sign | Meaning | Correct Action |
|------|---------|----------------|
| **Positive** COGS/OpEx | Normal debit (expense) | **Subtract** from profit |
| **Negative** COGS/OpEx | Credit (reversal/refund) | **Add** back to profit |
| **Positive** Other Income | Normal credit (income) | **Add** to income |
| **Negative** Other Income | Debit (reduction to income) | **Subtract** from income |
| **Positive** Other Expense | Normal debit (expense) | **Subtract** from income |
| **Negative** Other Expense | Credit (reduction to expense) | **Add** back to income |

### Corrected Excel Formulas

#### 1. Gross Profit

```excel
=LET(
  rev, IFERROR(@_Total_Revenue, 0),
  cogs, IFERROR(@_Total_COGS, 0),
  IF(cogs < 0,
    ABS(rev) + ABS(cogs),   // Negative COGS = credit = add back
    ABS(rev) - ABS(cogs)    // Positive COGS = debit = subtract
  )
)
```

**CPA Explanation:** 
- Positive COGS = normal cost of goods sold → subtract from revenue
- Negative COGS = purchase return, vendor credit, or reversal → reduces cost, increases margin

#### 2. Operating Income

```excel
=LET(
  gp, IFERROR(@_Gross_Profit, 0),
  opex, IFERROR(@_Total_Operating_Expenses, 0),
  IF(opex < 0,
    ABS(gp) + ABS(opex),    // Negative OpEx = credit = add back
    ABS(gp) - ABS(opex)     // Positive OpEx = debit = subtract
  )
)
```

**CPA Explanation:**
- Positive OpEx = normal operating expenses → subtract from gross profit
- Negative OpEx = expense accrual reversal, rebate, or credit → reduces expenses, increases operating income

#### 3. Net Income

```excel
=LET(
  opInc, IFERROR(@_Operating_Income, IFERROR(@_Gross_Profit, IFERROR(@_Total_Revenue, 0))),
  otherInc, IFERROR(@_Total_Other_Income, 0),
  otherExp, IFERROR(@_Total_Other_Expense, 0),
  opInc + otherInc - otherExp
)
```

**CPA Explanation:**

Simple formula: **Net Income = Operating Income + Other Income - Other Expense**

This works because raw data already has correct accounting signs:
- **Positive Other Expense** = normal costs (interest expense, losses) → **subtract** from income
- **Negative Other Expense** = credits/reversals → subtracting a negative **adds** to income
- **Other Income** follows natural sign (positive = income, negative = reduction)

### Sign Logic Truth Table (Complete Reference)

| Line Item | Stored Sign | Accounting Nature | Financial Statement Action |
|-----------|-------------|-------------------|---------------------------|
| Revenue | Negative (credit) | Normal income | Display as positive (× -1) |
| Revenue | Positive (debit) | Refund/reduction | Display as negative (× -1) |
| COGS | Positive (debit) | Normal cost | Subtract from Revenue |
| COGS | Negative (credit) | Purchase return/credit | Add to Revenue |
| OpEx | Positive (debit) | Normal expense | Subtract from Gross Profit |
| OpEx | Negative (credit) | Accrual reversal/credit | Add to Gross Profit |
| Other Income | Positive | Normal income | Add to Operating Income |
| Other Income | Negative | Income reduction | Subtract from Operating Income |
| Other Expense | Positive | Normal expense | Subtract from Operating Income |
| Other Expense | Negative | Expense credit | Add to Operating Income |

### Real-World Test Cases

These formulas were validated against NetSuite's native Income Statement:

| Month | Scenario | Expected Net Income | Result |
|-------|----------|---------------------|--------|
| January 2025 | Normal signs (mostly debits/credits as expected) | $670,296.01 | ✓ Match |
| December 2025 | Reversed signs (year-end adjustments, accrual reversals) | $2,052,678.11 | ✓ Match |

### Engineering Implementation Notes

1. **Named Ranges:** Each calculated row uses Excel named ranges (`_Total_Revenue`, `_Total_COGS`, etc.) for robustness
2. **IFERROR Handling:** Gracefully handles missing sections (e.g., no COGS for service companies)
3. **LET Function:** Improves readability and performance by avoiding repeated calculations
4. **Fallback Chain:** Net Income falls back through Operating Income → Gross Profit → Revenue → 0

### Where These Formulas Are Applied

The sign-aware formulas are inserted by these 4 functions in `taskpane.html`:

| Function | When Called |
|----------|-------------|
| `generateFullIncomeStatement()` | Quick Start: "Create Income Statement" |
| `runGuideMe()` | Quick Start: "Guide Me" wizard |
| `performStructureSync()` | Auto-triggered when changing subsidiary or year |
| `refreshSelected()` | When Structure Sync = TRUE during refresh |

All 4 functions use identical formula logic to ensure consistency.

---

# AWS Migration Roadmap

## Current State (Local + Cloudflare Tunnel)

```
┌─────────────┐     ┌─────────────┐     ┌─────────────────────┐
│ Excel Add-in │────▶│ Cloudflare  │────▶│ Cloudflare Tunnel   │
│             │     │ Worker      │     │ (Quick Tunnel)      │
└─────────────┘     │ (CORS Proxy)│     │                     │
                    └─────────────┘     └──────────┬──────────┘
                                                   │
                                                   ▼
                                        ┌─────────────────────┐
                                        │ Local Flask Server  │
                                        │ localhost:5002      │
                                        │ (Developer Machine) │
                                        └─────────────────────┘
```

**Limitations:**
- Requires developer machine running 24/7
- Tunnel URL changes on restart (must update Worker)
- No redundancy or scalability
- Single point of failure

## Target State (AWS)

```
┌─────────────┐     ┌─────────────┐     ┌─────────────────────┐
│ Excel Add-in │────▶│ AWS API     │────▶│ AWS Lambda          │
│             │     │ Gateway     │     │ (or ECS/Fargate)    │
└─────────────┘     │ (HTTPS)     │     │                     │
                    └─────────────┘     └──────────┬──────────┘
                                                   │
                                                   ▼
                                        ┌─────────────────────┐
                                        │ AWS Secrets Manager │
                                        │ (NetSuite Creds)    │
                                        └─────────────────────┘
```

## Migration Steps

### Phase 1: Backend Containerization
1. **Dockerize Flask app**
   ```dockerfile
   FROM python:3.11-slim
   WORKDIR /app
   COPY requirements.txt .
   RUN pip install -r requirements.txt
   COPY . .
   CMD ["gunicorn", "-b", "0.0.0.0:5002", "server:app"]
   ```

2. **Move credentials to environment variables**
   ```python
   # Current: File-based
   config = json.load(open('netsuite_config.json'))
   
   # AWS: Environment variables / Secrets Manager
   config = {
       'account_id': os.environ['NETSUITE_ACCOUNT_ID'],
       'consumer_key': os.environ['NETSUITE_CONSUMER_KEY'],
       # ...
   }
   ```

### Phase 2: AWS Deployment
| Option | Pros | Cons | Cost |
|--------|------|------|------|
| **Lambda + API Gateway** | Serverless, auto-scale | Cold starts, 15min timeout | ~$5-20/month |
| **ECS Fargate** | No cold starts, long-running | Always-on cost | ~$30-50/month |
| **EC2** | Full control | Must manage server | ~$20-40/month |

**Recommendation:** Start with **ECS Fargate** for production reliability.

### Phase 3: Infrastructure Changes

**What Changes:**
| Component | Current | AWS |
|-----------|---------|-----|
| Backend URL | Cloudflare Worker → Tunnel | API Gateway HTTPS endpoint |
| Credentials | Local JSON file | AWS Secrets Manager |
| CORS | Cloudflare Worker | API Gateway CORS config |
| SSL/TLS | Cloudflare | AWS Certificate Manager |
| Logging | Console | CloudWatch Logs |

**What Stays the Same:**
- Excel Add-in code (just update `SERVER_URL`)
- SuiteQL queries
- Caching logic
- All custom functions

### Phase 4: Remove Cloudflare Dependency

```javascript
// functions.js - Update SERVER_URL
// Current:
const SERVER_URL = 'https://netsuite-proxy.chris-corcoran.workers.dev';

// AWS:
const SERVER_URL = 'https://api.xavi.cloudextend.io';
```

The Cloudflare Worker becomes unnecessary - API Gateway handles CORS natively.

### Cost Comparison

| Item | Current (Cloudflare) | AWS (Fargate) |
|------|---------------------|---------------|
| Compute | $0 (local machine) | ~$30/month |
| Tunnel | $0 (free tier) | N/A |
| API Gateway | N/A | ~$5/month |
| Secrets Manager | N/A | ~$1/month |
| **Total** | **$0** (but unreliable) | **~$36/month** |

---

# CEFI Integration (CloudExtend Federated Integration)

## Overview

CEFI (CloudExtend Federated Integration) is our authentication and tenant management system. It will replace the current static credential model.

## Current Authentication Model

```
┌─────────────┐     ┌─────────────┐     ┌─────────────────────┐
│ Excel Add-in │────▶│ Backend     │────▶│ Single NetSuite     │
│             │     │ (static creds)    │ Account             │
└─────────────┘     └─────────────┘     └─────────────────────┘
```

**Limitations:**
- One NetSuite account per deployment
- Credentials hardcoded in backend
- No user-level permissions
- No multi-tenant support

## Target Model with CEFI

```
┌─────────────┐     ┌─────────────┐     ┌─────────────────────┐
│ Excel Add-in │────▶│ CEFI Auth   │────▶│ Token Service       │
│ (User Login) │     │ Portal      │     │                     │
└─────────────┘     └─────────────┘     └──────────┬──────────┘
                                                   │
                                                   ▼
                                        ┌─────────────────────┐
                                        │ Multi-Tenant        │
                                        │ Credential Store    │
                                        │                     │
                                        │ Customer A → NS Acct│
                                        │ Customer B → NS Acct│
                                        │ Customer C → NS Acct│
                                        └─────────────────────┘
```

## CEFI Components

### 1. Authentication Flow
```
1. User opens Excel Add-in
2. Add-in checks for valid CEFI token
3. If no token: Redirect to CEFI login portal
4. User logs in with SSO (Google, Microsoft, SAML)
5. CEFI returns JWT token
6. Add-in stores token, sends with all API requests
7. Backend validates token, retrieves tenant-specific NetSuite credentials
```

### 2. Token Structure
```json
{
  "sub": "user@company.com",
  "tenant_id": "customer-abc-123",
  "netsuite_account": "589861",
  "roles": ["viewer", "editor"],
  "exp": 1735689600,
  "iss": "cefi.cloudextend.io"
}
```

### 3. Backend Changes

```python
# Current: Static credentials
def get_netsuite_client():
    config = json.load(open('netsuite_config.json'))
    return NetSuiteClient(config)

# CEFI: Tenant-specific credentials
def get_netsuite_client(cefi_token):
    # Validate token
    payload = jwt.decode(cefi_token, CEFI_PUBLIC_KEY)
    tenant_id = payload['tenant_id']
    
    # Fetch tenant credentials from secure store
    credentials = secrets_manager.get_secret(f'netsuite/{tenant_id}')
    
    return NetSuiteClient(credentials)
```

### 4. Frontend Changes

```javascript
// functions.js - Add CEFI token to requests
async function fetchWithAuth(url, options = {}) {
    const cefiToken = await getCEFIToken();
    
    if (!cefiToken) {
        // Redirect to login
        window.location.href = 'https://cefi.cloudextend.io/login?redirect=' + 
            encodeURIComponent(window.location.href);
        return;
    }
    
    return fetch(url, {
        ...options,
        headers: {
            ...options.headers,
            'Authorization': `Bearer ${cefiToken}`
        }
    });
}
```

## Benefits of CEFI

| Feature | Current | With CEFI |
|---------|---------|-----------|
| Multi-tenant | ❌ Single account | ✅ Unlimited customers |
| User management | ❌ None | ✅ Full RBAC |
| SSO | ❌ None | ✅ Google, Microsoft, SAML |
| Audit logging | ❌ Basic | ✅ Per-user activity |
| Credential rotation | ❌ Manual | ✅ Automated |
| Billing integration | ❌ None | ✅ Usage tracking |

## Implementation Timeline

| Phase | Tasks | Duration |
|-------|-------|----------|
| **Phase 1** | CEFI portal setup, JWT infrastructure | 2-3 weeks |
| **Phase 2** | Backend token validation, secrets integration | 1-2 weeks |
| **Phase 3** | Frontend login flow, token management | 1-2 weeks |
| **Phase 4** | Multi-tenant credential store | 1 week |
| **Phase 5** | Testing, migration | 1-2 weeks |

---

# Troubleshooting

## Common Issues

### #N/A in Cells

**Cause:** Network error, timeout, or invalid parameters

**Solution:**
1. Check connection status in taskpane
2. Verify account number exists
3. Verify period format ("Jan 2025")
4. Try "Refresh Selected" on the cell

### #TIMEOUT# in Special Formulas

**Cause:** Backend query took >5 minutes

**Solution:**
1. Ensure tunnel is running
2. Check server logs for errors
3. Try during off-peak hours
4. Contact NetSuite if persistent

### Values Don't Match NetSuite

**Check:**
1. **Subsidiary:** Are you using the correct consolidation level?
2. **Period:** Is it the exact same period end date?
3. **Accounting Book:** Are you querying the same book?
4. **Account Types:** Are any accounts excluded due to type mismatches?

### Slow Performance

**Optimize by:**
1. Use "Refresh Accounts" instead of individual cell refreshes
2. Reduce the number of unique filter combinations
3. Consider using fewer periods per sheet
4. Check tunnel latency (should be <500ms)

## Logs and Debugging

### Browser Console (F12)
Shows client-side logs from functions.js:
```
⚡ CACHE HIT [balance]: 4010:Jan 2025
📥 CACHE MISS [balance]: 4020:Jan 2025
```

### Server Logs
Backend prints detailed query information:
```
📊 Calculating CTA (PLUG METHOD) for Dec 2024
   📜 total_assets SQL: SELECT SUM(...)
   ✓ total_assets: 53,322,353.28
   ✓ total_liabilities: 59,987,254.08
   = CTA (plug): -239,639.06
```

---

# Version History

| Version | Date | Changes |
|---------|------|---------|
| 3.0.5.49 | Dec 2025 | **Wildcard documentation** - Added comprehensive CPA guide for executive reporting with wildcards, in-app examples, and performance optimization details. |
| 3.0.5.48 | Dec 2025 | **Wildcard account support** - Use `"4*"` to sum all revenue accounts, `"6*"` for expenses, etc. Works in XAVI.BALANCE and XAVI.BUDGET. Fully batched for performance. |
| 3.0.5.44 | Dec 2025 | **Simplified Net Income formula** - `Operating Income + Other Income - Other Expense`. Removed complex sign-aware logic; raw GL data handles signs correctly. |
| 3.0.5.43 | Dec 2025 | Removed MatchingUnrERV sign flip - sign-aware Excel formulas handle all cases |
| 3.0.5.42 | Dec 2025 | Tested MatchingUnrERV exception (ultimately removed in 3.0.5.44) |
| 3.0.5.40 | Dec 2025 | Sign-aware formulas for Income Statement (Gross Profit, Operating Income, Net Income) |
| 3.0.5.39 | Dec 2025 | Renamed `_Total_Other_Expenses` to `_Total_Other_Expense` |
| 3.0.5.38 | Dec 2025 | Cleaned up console.log debugging (257 → 153 statements) |
| 3.0.5.37 | Dec 2025 | Auto-comments when inserting filter values from task pane |
| 1.5.37.0 | Dec 2025 | Fix tooltips (lighter style), remove unnecessary error messages |
| 1.5.36.0 | Dec 2025 | Remove duplicate tooltips |
| 1.5.35.0 | Dec 2025 | TYPE formula batching for drag operations |
| 1.5.34.0 | Dec 2025 | Fix class/dept/location filters (use TransactionLine not TransactionAccountingLine) |
| 1.5.33.0 | Dec 2025 | Separate Refresh Accounts from RE/NI/CTA |
| 1.5.32.0 | Dec 2025 | Fix account type spellings (DeferExpense, DeferRevenue) |
| 1.5.31.0 | Dec 2025 | Fix Department/Class/Location lookups (direct table queries) |
| 3.0.5.161 | Dec 2025 | Interactive tutorial, CloudExtend branding, code cleanup for engineering handoff |

---

*Document Version: 2.6*
*Last Updated: December 17, 2025*
