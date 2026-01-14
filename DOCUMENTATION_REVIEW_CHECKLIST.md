# Documentation Review Checklist

**Purpose:** Systematic checklist to ensure all documentation accurately reflects the current codebase.

## Critical Constants & Values

### Build Mode Detection
- [ ] BUILD_MODE_THRESHOLD = 2 (not 3)
- [ ] BUILD_MODE_WINDOW_MS = 800 (not 500)
- [ ] BUILD_MODE_SETTLE_MS = 500 (not 800)
- [ ] BATCH_DELAY = 500ms
- [ ] CHUNK_SIZE = 100 (not 50)

### Full Year Refresh Triggers
- [ ] Build mode: 10+ months OR all 12 months of single year
- [ ] Regular batch: 3+ periods from same year
- [ ] Requires 5+ P&L accounts in build mode

### Period Format Validation
- [ ] Valid formats: "Mon YYYY" (e.g., "Jan 2025"), "YYYY", or numeric period ID
- [ ] Invalid formats: "Q1 2025", "Q2 2025", etc. (quarterly uses date ranges)
- [ ] Quarterly examples must use: "Jan 2025" to "Mar 2025" (not "Q1 2025")

## Function Implementations

### CFO Flash Report
- [ ] Uses XAVI.TYPEBALANCE (not XAVI.BALANCE with wildcards)
- [ ] Account types: "Income", "COGS", "Expense", "OthIncome", "OthExpense"
- [ ] Does NOT use wildcards like "4*", "5*", "6*"

### Full Income Statement
- [ ] Uses XAVI.BALANCE (not TYPEBALANCE)
- [ ] Uses individual account numbers or wildcards

### Available Functions
- [ ] All 11 functions listed: NAME, TYPE, PARENT, BALANCE, BALANCECURRENCY, BUDGET, RETAINEDEARNINGS, NETINCOME, TYPEBALANCE, CTA, CLEARCACHE
- [ ] CLEARCACHE is internal but should be documented

## Backend Implementation

### BUILTIN.CONSOLIDATE
- [ ] Used in ALL balance queries (no exceptions)
- [ ] Works for OneWorld and non-OneWorld
- [ ] Works for single-currency and multi-currency
- [ ] Works for single-subsidiary and multi-subsidiary
- [ ] NO conditional logic that skips it
- [ ] Remove any "When NOT to Use" sections

### Backend Technology
- [ ] Active: .NET 8.0 (ASP.NET Core) - backend-dotnet/
- [ ] Legacy: Python Flask - backend/ (kept for reference only)
- [ ] All code examples should be C# (not Python)

### Backend Caching
- [ ] IMemoryCache exists (ASP.NET Core)
- [ ] Balance results: 5-minute TTL (default) or 24-hour for range queries
- [ ] Lookup data: 24-hour TTL
- [ ] Book-Subsidiary cache: Persistent dictionary with disk backup

## Account Types

### Exact Spellings
- [ ] DeferExpense (not DeferExpens)
- [ ] DeferRevenue (not DeferRevenu)
- [ ] CredCard (not CreditCard)
- [ ] Code examples in C# (not Python)

### COGS Handling
- [ ] Both "COGS" (modern) and "Cost of Goods Sold" (legacy) are included
- [ ] Backend includes both in queries

## SQL Query Examples

### Pivoted Query Structure
- [ ] Uses `t.postingperiod = {periodId}` (not `TO_CHAR(ap.startdate)`)
- [ ] Includes `BUILTIN.CONSOLIDATE` in CASE statements
- [ ] Includes sign flip for Income accounts: `CASE WHEN a.accttype IN ('Income', 'OthIncome') THEN -1 ELSE 1 END`
- [ ] Includes TransactionLine join: `JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id`
- [ ] Includes segment filters (subsidiary, department, location, class)
- [ ] Includes accounting book filter
- [ ] GROUP BY includes account name and type

## File References

### Manifest
- [ ] Filename: `manifest.xml` (not `manifest-claude.xml`)

### Frontend Files
- [ ] taskpane.html exists
- [ ] functions.js exists
- [ ] functions.json exists
- [ ] sharedruntime.html exists
- [ ] functions.html exists (legacy)
- [ ] NO commands.html or commands.js (these don't exist)

## Version Numbers

- [ ] Current version: 4.0.6.167
- [ ] All version references updated
- [ ] Dates updated to January 12, 2026 (or current date)

## Architecture Details

### Shared Runtime
- [ ] taskpane.html and functions.js share JavaScript context
- [ ] sharedruntime.html is blank (no UI)
- [ ] Communication via localStorage and direct function calls

### Request Flow
- [ ] Excel → GitHub Pages → Cloudflare Worker → Cloudflare Tunnel → .NET Backend → NetSuite
- [ ] SERVER_URL = 'https://netsuite-proxy.chris-corcoran.workers.dev'

## Performance Details

### Caching TTLs
- [ ] In-memory cache: Session-only (no TTL)
- [ ] localStorage: 1 hour (STORAGE_TTL = 3600000ms) - NOT 5 minutes
- [ ] Backend IMemoryCache: 5 minutes (balance), 24 hours (lookups)

### Chunking
- [ ] CHUNK_SIZE = 100 accounts per batch
- [ ] MAX_PERIODS_PER_BATCH = 3 periods
- [ ] Backend supports 100+ accounts (tested with 114)

## Quick Start Reports

- [ ] CFO Flash Report: Uses TYPEBALANCE
- [ ] Full Income Statement: Uses BALANCE
- [ ] Budget Comparison: Uses BUDGET

## Period Range Queries

- [ ] Quarterly ranges: fromPeriod ≠ toPeriod (e.g., "Jan 2025" to "Mar 2025")
- [ ] Uses /batch/full_year_refresh for range queries
- [ ] Range-specific cache keys: `balance:{account}:{fromPeriod}::{toPeriod}:{filtersHash}`
