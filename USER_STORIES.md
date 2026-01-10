# XAVI for NetSuite - User Stories

**Product:** XAVI for NetSuite Excel Add-in  
**Target Users:** Accountants, Senior Finance Professionals, Financial Analysts, CFOs  
**Version:** 4.0.6.145  
**Date:** January 2026

---

## Table of Contents

1. [Onboarding & Quick Start](#onboarding--quick-start)
2. [Core Formula Functions](#core-formula-functions)
3. [Pre-Built Reports](#pre-built-reports)
4. [Bulk Operations](#bulk-operations)
5. [Drill-Down & Transaction Analysis](#drill-down--transaction-analysis)
6. [Filtering & Multi-Dimensional Analysis](#filtering--multi-dimensional-analysis)
7. [Performance & Optimization](#performance--optimization)
8. [Account Management](#account-management)
9. [Budget & Planning](#budget--planning)
10. [Multi-Currency & Multi-Book Support](#multi-currency--multi-book-support)

---

## Onboarding & Quick Start

### US-001: Interactive Guide for New Users

**As a** new accountant or finance professional  
**I want** an interactive guide that walks me through the product features  
**So that** I can get up to speed quickly without reading extensive documentation

**Acceptance Criteria:**
- [ ] Interactive guide appears on first launch or can be accessed from the task pane
- [ ] Guide provides step-by-step walkthrough of key features:
  - How to enter a basic formula
  - How to use pre-built reports
  - How to drill down into transactions
  - How to filter by subsidiary, department, etc.
- [ ] Guide includes visual examples and tooltips
- [ ] Users can dismiss the guide and access it again later
- [ ] Guide adapts based on user's current context (e.g., shows relevant tips when selecting a formula cell)

**Business Value:** Reduces onboarding time from hours to minutes, enabling faster user adoption

---

### US-002: Quick Start Pre-Built Reports

**As a** finance professional  
**I want** to access pre-built reports (CFO Flash Report and Income Statement) from a Quick Start section  
**So that** I can generate standard financial reports immediately without building formulas from scratch

**Acceptance Criteria:**
- [ ] Quick Start section is prominently displayed in the task pane
- [ ] CFO Flash Report option generates a high-level P&L summary in seconds
- [ ] Income Statement option generates a detailed P&L with all accounts
- [ ] Both reports allow selection of year and subsidiary before generation
- [ ] Reports are formatted with proper currency formatting and calculated subtotals
- [ ] Reports do not prompt for subsidiary selection on first load (uses default)

**Business Value:** Enables users to produce executive-ready reports in under 2 minutes, eliminating hours of manual report building

---

## Core Formula Functions

### US-003: Get GL Account Balance

**As a** financial analyst  
**I want** to use `XAVI.BALANCE` to retrieve account balances for specific periods  
**So that** I can build dynamic financial reports that pull live data from NetSuite

**Acceptance Criteria:**
- [ ] Formula syntax: `=XAVI.BALANCE(account, fromPeriod, toPeriod, [subsidiary], [department], [location], [class], [accountingBook])`
- [ ] Supports single period: `=XAVI.BALANCE("4010", "Jan 2025", "Jan 2025")`
- [ ] Supports period ranges: `=XAVI.BALANCE("4010", "Jan 2025", "Dec 2025")`
- [ ] Supports wildcards: `=XAVI.BALANCE("4*", "Jan 2025", "Jan 2025")` returns sum of all 4xxx accounts
- [ ] All optional parameters work correctly (subsidiary, department, location, class, accounting book)
- [ ] Returns numeric values that can be used in Excel calculations
- [ ] Handles errors gracefully (e.g., invalid account, period not found)

**Business Value:** Eliminates manual CSV exports and copy-paste operations, ensuring real-time accuracy

---

### US-004: Get Account Type Totals

**As a** CFO or senior finance professional  
**I want** to use `XAVI.TYPEBALANCE` to get totals for account types (Income, Expense, COGS, etc.)  
**So that** I can quickly build high-level summary reports without listing individual accounts

**Acceptance Criteria:**
- [ ] Formula syntax: `=XAVI.TYPEBALANCE(accountType, fromPeriod, toPeriod, [subsidiary], [department], [location], [class], [accountingBook])`
- [ ] Supports account types: Income, OthIncome, Expense, OthExpense, COGS
- [ ] Supports Balance Sheet types: Bank, AcctRec, OthCurrAsset, FixedAsset, AcctPay, OthCurrLiab, LongTermLiab, Equity
- [ ] Returns sum of all accounts matching the specified type
- [ ] Works with period ranges for YTD calculations
- [ ] Supports all optional filter parameters

**Business Value:** Enables rapid creation of executive dashboards and flash reports without detailed account mapping

---

---

### US-006: Get Account Metadata

**As a** financial analyst building reports  
**I want** to use helper functions (`XAVI.NAME`, `XAVI.TYPE`, `XAVI.PARENT`) to retrieve account information  
**So that** I can dynamically label and organize my reports

**Acceptance Criteria:**
- [ ] `XAVI.NAME(account)` returns the account name
- [ ] `XAVI.TYPE(account)` returns the account type
- [ ] `XAVI.PARENT(account)` returns the parent account number
- [ ] Functions work with account numbers or wildcards (returns first match for wildcards)
- [ ] Results can be used in Excel formulas and cell references

**Business Value:** Enables dynamic report generation that adapts to account structure changes

---

### US-007: Calculate Special Financial Metrics

**As a** senior accountant  
**I want** to use specialized formulas (`XAVI.RETAINEDEARNINGS`, `XAVI.NETINCOME`, `XAVI.CTA`) to calculate complex financial metrics  
**So that** I can build complete financial statements without manual calculations

**Acceptance Criteria:**
- [ ] `XAVI.RETAINEDEARNINGS(period)` calculates cumulative P&L through prior year-end
- [ ] `XAVI.NETINCOME(period)` calculates YTD Net Income
- [ ] `XAVI.CTA(period)` calculates Cumulative Translation Adjustment for multi-currency
- [ ] All formulas respect fiscal year boundaries and accounting periods
- [ ] Formulas work with optional subsidiary and accounting book parameters

**Business Value:** Automates complex calculations that are error-prone when done manually

---

## Pre-Built Reports

### US-008: Generate CFO Flash Report

**As a** CFO or finance executive  
**I want** to generate a CFO Flash Report with one click  
**So that** I can quickly review high-level P&L metrics for board meetings or monthly reviews

**Acceptance Criteria:**
- [ ] Report includes: Revenue, COGS, Gross Profit, Operating Expenses, Net Income
- [ ] Uses TYPEBALANCE formulas for aggregation
- [ ] Supports year selection and subsidiary filtering
- [ ] Report is formatted with currency symbols and proper number formatting
- [ ] Includes calculated subtotals (Gross Profit, Operating Income, Net Income)
- [ ] Report generates in under 2 minutes
- [ ] No modal prompts on first load (uses sensible defaults)

**Business Value:** Reduces time to produce executive reports from hours to minutes

---

### US-009: Generate Full Income Statement

**As a** financial analyst or accountant  
**I want** to generate a complete Income Statement with all accounts  
**So that** I can review detailed P&L without manually building formulas for each account

**Acceptance Criteria:**
- [ ] Report includes all P&L accounts organized by category:
  - All revenue accounts (4xxx)
  - Cost of Goods Sold (5xxx)
  - Operating Expenses (6xxx)
  - Other Income/Expense (7xxx, 8xxx)
- [ ] Includes calculated rows: Gross Profit, Operating Income, Net Income
- [ ] Supports year selection and optional subsidiary filtering
- [ ] Report is properly formatted with account names, numbers, and balances
- [ ] Report generates in under 5 minutes
- [ ] No modal prompts on first load (uses sensible defaults)

**Business Value:** Eliminates hours of manual report building and formula entry

---

### US-010: Generate Budget Comparison Report

**As a** finance manager  
**I want** to generate a Budget vs. Actual report  
**So that** I can analyze variances and track performance against plan

**Acceptance Criteria:**
- [ ] Report shows Actual and Budget side-by-side
- [ ] Calculates variance (Actual - Budget) and variance percentage
- [ ] Supports year, subsidiary, and budget category selection
- [ ] Report includes all relevant accounts with proper formatting
- [ ] Variance calculations are clearly highlighted (positive/negative)

**Business Value:** Enables rapid variance analysis and budget performance tracking

---

## Bulk Operations

### US-011: Bulk Add GL Accounts

**As a** financial analyst  
**I want** to search and add multiple GL accounts at once using the "Bulk Add GL Accounts" feature  
**So that** I can quickly populate reports with relevant accounts without typing each account number

**Acceptance Criteria:**
- [ ] Search box supports multiple search modes:
  - Category keywords: "Income", "Balance", "Bank" return filtered account lists
  - Account type names: "AcctRec", "FixedAsset", "OthIncome" return specific types
  - Account number/name search: partial matches on account numbers or names
  - Wildcard "*" returns all active accounts
- [ ] Search is case-insensitive and returns results instantly
- [ ] Users can select multiple accounts from search results
- [ ] Selected accounts are added to the sheet with appropriate formulas
- [ ] Search respects active/inactive account status

**Business Value:** Reduces time to build reports by eliminating manual account lookup and entry

---

### US-012: Bulk Add Periods

**As a** financial analyst  
**I want** to add multiple accounting periods at once  
**So that** I can quickly build multi-period reports (monthly, quarterly, YTD)

**Acceptance Criteria:**
- [ ] Users can select multiple periods from a list or date range picker
- [ ] Selected periods are added as column headers
- [ ] Formulas automatically reference the correct period columns
- [ ] Supports fiscal year periods (not just calendar months)

**Business Value:** Speeds up multi-period report creation significantly

---

## Drill-Down & Transaction Analysis

### US-013: Drill Down into Account Balances

**As a** senior accountant or auditor  
**I want** to drill down into any balance to see the underlying transactions  
**So that** I can verify numbers, investigate variances, and understand what makes up a balance

**Acceptance Criteria:**
- [ ] Users can drill down from `XAVI.BALANCE` formulas to see individual transactions
- [ ] Users can drill down from `XAVI.TYPEBALANCE` formulas (two-level: first shows accounts, then transactions)
- [ ] Drill-down accessible via:
  - Quick Actions button in task pane (primary method)
  - Right-click context menu (Windows only, Mac has limitations)
- [ ] Transaction sheet includes: Account Number, Date, Type, Number, Entity, Memo, Debit/Credit, Net Amount
- [ ] Transaction numbers are clickable links that open in NetSuite
- [ ] Drill-down works for all formula types and filter combinations

**Business Value:** Enables self-service audit trails and variance investigation without leaving Excel

---

### US-014: Multi-Level Drill-Down for TYPEBALANCE

**As a** financial analyst  
**I want** a two-level drill-down for TYPEBALANCE formulas  
**So that** I can first see which accounts contribute to a type total, then drill into specific account transactions

**Acceptance Criteria:**
- [ ] First drill-down shows all accounts of the specified type with their individual balances
- [ ] Second drill-down (from account row) shows individual transactions for that account
- [ ] Quick Actions bar clearly indicates when account row is selected vs. formula cell
- [ ] Navigation is intuitive and clearly labeled

**Business Value:** Provides granular transaction-level visibility for aggregated balances

---

## Filtering & Multi-Dimensional Analysis

### US-015: Filter by Subsidiary

**As a** finance manager in a multi-subsidiary organization  
**I want** to filter formulas by subsidiary  
**So that** I can analyze performance by entity and build consolidated reports

**Acceptance Criteria:**
- [ ] Subsidiary parameter works in all formula types
- [ ] Supports individual subsidiaries: `"Celigo Inc."`
- [ ] Supports consolidated subsidiaries: `"Celigo Inc. (Consolidated)"`
- [ ] Subsidiary dropdown in task pane allows easy selection
- [ ] Filter persists across formulas in the same sheet
- [ ] Consolidated view automatically includes child subsidiaries

**Business Value:** Enables entity-level and consolidated reporting without separate NetSuite queries

---

### US-016: Filter by Department, Location, and Class

**As a** financial analyst  
**I want** to filter formulas by department, location, and class  
**So that** I can build departmental P&Ls, location-based reports, and class-based analysis

**Acceptance Criteria:**
- [ ] Department parameter filters transactions by department
- [ ] Location parameter filters transactions by location
- [ ] Class parameter filters transactions by class
- [ ] All three parameters can be used together
- [ ] Parameters work with all formula types
- [ ] Dropdowns in task pane allow easy selection

**Business Value:** Enables multi-dimensional analysis without complex NetSuite report configurations

---

### US-017: Filter by Accounting Book

**As a** finance professional using multi-book accounting  
**I want** to filter formulas by accounting book  
**So that** I can analyze performance across different accounting methods (e.g., GAAP vs. Tax)

**Acceptance Criteria:**
- [ ] Accounting book parameter works in all formula types
- [ ] Defaults to Primary Book (ID 1) if not specified
- [ ] Supports all configured accounting books in NetSuite
- [ ] Book selection in task pane updates all formulas on the sheet
- [ ] Changing accounting book prompts user to confirm subsidiary selection (if needed)

**Business Value:** Enables multi-book reporting and analysis without manual data manipulation

---

## Performance & Optimization

### US-018: Automatic Formula Batching

**As a** financial analyst building large reports  
**I want** formulas to automatically batch together  
**So that** my reports load quickly even with hundreds of formulas

**Acceptance Criteria:**
- [ ] When multiple formulas are entered (via drag-down or copy-paste), they are automatically batched
- [ ] Batch requests combine multiple accounts and periods into single API calls
- [ ] Batching works for both BALANCE and TYPEBALANCE formulas
- [ ] Users see progress indicators for large batches
- [ ] Batch processing is transparent to users (no manual configuration needed)

**Business Value:** Enables large-scale reporting without performance degradation

---

### US-019: Balance Sheet Pre-Caching

**As a** financial analyst working with Balance Sheet accounts  
**I want** Balance Sheet accounts to be pre-cached when I enter the first formula  
**So that** subsequent formulas in the same column resolve instantly

**Acceptance Criteria:**
- [ ] When first Balance Sheet formula is entered for a period, all Balance Sheet accounts for that period are pre-cached
- [ ] Pre-caching happens automatically in the background
- [ ] Users see a progress indicator during pre-caching
- [ ] Subsequent formulas (single entry or drag-down) resolve immediately from cache
- [ ] Pre-caching respects filters (subsidiary, department, location, class, accounting book)
- [ ] Cache persists across Excel sessions (localStorage)

**Business Value:** Dramatically improves performance for Balance Sheet reports (from minutes to seconds)

---

### US-019A: Income Statement Pre-Caching

**As a** financial analyst building Income Statement reports  
**I want** Income Statement accounts to be pre-cached when I enter the first formula  
**So that** subsequent formulas resolve instantly without individual API calls

**Acceptance Criteria:**
- [x] When first Income Statement formula is entered for a period, all Income Statement accounts for that period are pre-cached
- [x] Pre-caching happens automatically in the background via `/batch/pl_preload` endpoint
- [x] Pre-caching triggers on first P&L account formula (Income, COGS, Expense, OthIncome, OthExpense)
- [x] Subsequent formulas resolve immediately from cache
- [x] Pre-caching respects filters (subsidiary, department, location, class, accounting book)
- [x] Cache persists across Excel sessions (localStorage)
- [x] Works seamlessly with full year refresh optimization (12 months)

**Business Value:** Dramatically improves performance for Income Statement reports. When dragging formulas across 12 months, all accounts are pre-cached, reducing resolution time from minutes to seconds.

---

### US-020: Intelligent Column-Based Batching

**As a** financial analyst dragging formulas down a column  
**I want** column-based batching to optimize Balance Sheet account requests  
**So that** entire columns of Balance Sheet accounts load efficiently

**Acceptance Criteria:**
- [ ] System detects when formulas are arranged in a column with Balance Sheet accounts
- [ ] Column-based batching combines all accounts in the column into optimized batch requests
- [ ] Works for both single-period and multi-period columns
- [ ] Batching is automatic and transparent to users

**Business Value:** Optimizes the most common report-building pattern (dragging formulas down)

---

### US-021: Refresh All Functionality

**As a** financial analyst  
**I want** a "Refresh All" button to update all formulas in my sheet  
**So that** I can get the latest data after posting new transactions in NetSuite

**Acceptance Criteria:**
- [x] Refresh All button is prominently displayed in the task pane
- [x] Clicking Refresh All clears cache and re-fetches all formulas
- [x] Progress indicator shows refresh status
- [x] Formulas update in batches for performance
- [x] Refresh works for all formula types
- [x] **Smart Sheet Detection:** Automatically detects P&L sheets (12 periods) vs Balance Sheet sheets (1 period) and fetches appropriate data
- [x] **Optimized Performance:** P&L sheets refresh in ~30 seconds, Balance Sheet sheets in 2-3 minutes
- [x] **Account Extraction:** Automatically extracts account numbers from formulas for classification

**Business Value:** Ensures data accuracy and eliminates manual formula recalculation. Smart detection prevents unnecessary Balance Sheet queries on Income Statement sheets, reducing refresh time from timeouts to ~30 seconds.

---

## Account Management

### US-022: Account Search with Category Keywords

**As a** financial analyst  
**I want** to search for accounts using category keywords like "Income" or "Balance"  
**So that** I can quickly find relevant accounts without knowing specific account numbers

**Acceptance Criteria:**
- [ ] Searching "Income" returns all Income Statement accounts (Income, OthIncome, Expense, OthExpense, COGS)
- [ ] Searching "Balance" returns all Balance Sheet accounts (Bank, AcctRec, FixedAsset, AcctPay, Equity, etc.)
- [ ] Searching "Bank" returns only Bank accounts
- [ ] Search is case-insensitive
- [ ] Results are filtered to active accounts only (unless specified otherwise)

**Business Value:** Speeds up account discovery and report building

---

### US-023: Account Type Filtering

**As a** financial analyst  
**I want** to search for accounts by specific account type (e.g., "AcctRec", "FixedAsset", "OthIncome")  
**So that** I can find all accounts of a specific type for specialized reports

**Acceptance Criteria:**
- [ ] Searching for exact account type names returns only accounts of that type
- [ ] Supported types include: Bank, AcctRec, OthCurrAsset, FixedAsset, OthAsset, AcctPay, CredCard, OthCurrLiab, LongTermLiab, Equity, Income, OthIncome, Expense, OthExpense, COGS
- [ ] Search is case-insensitive
- [ ] Results show account number, name, and type

**Business Value:** Enables specialized reporting by account type

---

## Budget & Planning

### US-024: Get Budget Amounts

**As a** finance manager  
**I want** to use `XAVI.BUDGET` to retrieve budget amounts  
**So that** I can build Budget vs. Actual reports and track performance against plan

**Acceptance Criteria:**
- [ ] Formula syntax: `=XAVI.BUDGET(account, fromPeriod, toPeriod, [subsidiary], [department], [location], [class], [accountingBook], [budgetCategory])`
- [ ] Supports budget categories (e.g., "Annual Budget", "Q1 Forecast")
- [ ] Works with period ranges for YTD budget calculations
- [ ] Supports all optional filter parameters
- [ ] Returns budget amounts that can be compared to actuals

**Business Value:** Enables automated budget variance analysis and planning

---

## Multi-Currency & Multi-Book Support

### US-025: Multi-Currency Balance Retrieval

**As a** finance professional in a multi-currency organization  
**I want** to use `XAVI.BALANCECURRENCY` to control currency conversion  
**So that** I can build reports in specific currencies for consolidation or local reporting

**Acceptance Criteria:**
- [ ] Formula syntax: `=XAVI.BALANCECURRENCY(account, fromPeriod, toPeriod, subsidiary, currency, [department], [location], [class], [accountingBook])`
- [ ] Supports all NetSuite currencies
- [ ] Currency conversion uses NetSuite's exchange rates
- [ ] Works with consolidated subsidiaries for multi-currency consolidation
- [ ] Returns balances in the specified currency

**Business Value:** Enables accurate multi-currency reporting and consolidation

---

### US-026: Multi-Book Accounting Support

**As a** finance professional using multiple accounting books  
**I want** all formulas to support accounting book parameters  
**So that** I can analyze performance across different accounting methods

**Acceptance Criteria:**
- [ ] All formula types support optional accounting book parameter
- [ ] Defaults to Primary Book (ID 1) if not specified
- [ ] Accounting book selection in task pane updates all formulas
- [ ] Changing accounting book prompts for subsidiary confirmation (if needed)
- [ ] Works with all filter combinations

**Business Value:** Enables multi-book analysis without manual data manipulation

---

## Technical Notes for Engineering Team

### Frontend Migration to Angular

**Note:** The current frontend is implemented in vanilla JavaScript/HTML. The engineering team should plan for migration to Angular while maintaining all existing functionality.

**Key Considerations:**
- Maintain Office.js Shared Runtime architecture
- Preserve all custom Excel function implementations
- Ensure compatibility with Excel's custom function registration
- Maintain task pane UI/UX during migration
- Preserve localStorage caching mechanisms
- Ensure drill-down functionality continues to work

### Backend Architecture

**Current State:**
- Backend is .NET Core (ASP.NET Core Web API)
- Located in `backend-dotnet/` directory
- Python Flask backend (`backend/`) is legacy and kept for reference only
- Uses Cloudflare Worker as proxy
- Uses Cloudflare Tunnel for local development

**Key Endpoints:**
- `/balance` - Single account balance
- `/batch/balance` - Batch account balances
- `/typebalance` - Account type totals
- `/accounts/search` - Account search
- `/transactions` - Transaction drill-down
- `/budget` - Budget amounts

### Performance Optimizations

**Implemented Features:**
- Automatic formula batching
- Balance Sheet pre-caching (US-019)
- Income Statement pre-caching (US-019A) - v4.0.6.144+
- Column-based batching for Balance Sheet accounts
- Full year refresh optimization for P&L sheets (12 months in single query)
- Smart Refresh All detection (P&L vs BS sheets) - v4.0.6.145+
- localStorage caching for account metadata
- File-based persistence for book-subsidiary cache

**Future Considerations:**
- Consider server-side caching for frequently accessed data
- Optimize SuiteQL queries for large datasets
- Implement pagination for transaction drill-downs

---

## Success Metrics

### User Adoption
- Time to first report: < 5 minutes
- User activation rate: > 80% (users who generate at least one report)
- Feature discovery: > 60% of users use pre-built reports

### Performance
- Formula resolution time: < 2 seconds for cached data
- Report generation time: < 5 minutes for full Income Statement
- Batch processing: 100+ formulas in < 30 seconds

### User Satisfaction
- Reduction in manual data entry: > 90%
- Time saved per report: > 80%
- User-reported accuracy improvement: > 95%

---

## Future Enhancements (Out of Scope for Current Release)

- Real-time data refresh notifications
- Scheduled report generation
- Report templates library
- Advanced charting and visualization
- Export to PDF functionality
- Collaborative report sharing
- Version control for reports
- Custom formula builder UI

---

**Document Owner:** Product Management  
**Last Updated:** January 2025  
**Next Review:** Q2 2025

