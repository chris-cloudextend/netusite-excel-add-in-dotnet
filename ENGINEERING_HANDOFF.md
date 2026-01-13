# XAVI for NetSuite - Engineering Handoff Documentation

**Purpose:** Knowledge transfer document for engineers taking over the XAVI Excel Add-in project  
**Current Version:** 4.0.6.167  
**Last Updated:** January 12, 2026

---

## Use Cases

### Primary Use Case: Financial Reporting in Excel
Finance teams build dynamic financial reports (Income Statements, Balance Sheets, Budget vs. Actual) directly in Excel using formulas that pull live data from NetSuite. Users can:
- Build reports by typing formulas like `=XAVI.BALANCE("4010", "Jan 2025", "Dec 2025")`
- Drag formulas across rows/columns to build multi-period reports
- Use "Refresh All" to update all formulas after posting new transactions
- Drill down into any balance to see underlying transactions

### Secondary Use Cases
- **Quick Start Reports:** Pre-built templates (CFO Flash Report, Full Income Statement) generate complete reports in seconds
- **Multi-Dimensional Analysis:** Filter by subsidiary, department, location, class, and accounting book
- **Budget Analysis:** Compare actuals to budgets using `XAVI.BUDGET` formulas
- **Account Discovery:** Search accounts by type, category, or name using the taskpane UI

For complete feature documentation, see [DOCUMENTATION.md](DOCUMENTATION.md).

---

## Architecture Overview

### High-Level Flow

```
Excel Add-in (Office.js)
    ↓
GitHub Pages (static files: HTML, JS, CSS)
    ↓
Cloudflare Worker (proxy)
    ↓
Cloudflare Tunnel (development only)
    ↓
.NET Backend (localhost:5002 in dev)
    ↓
NetSuite REST API (SuiteQL queries)
```

### Why This Architecture?

**Current State (Development):**
- **Public GitHub Repository:** Required for GitHub Pages (free tier limitation)
- **GitHub Pages:** Hosts static frontend files (fastest path to working prototype)
- **Cloudflare Worker:** Provides stable proxy URL that forwards to tunnel
- **Cloudflare Tunnel:** Exposes local backend to internet during development
- **Local .NET Backend:** Runs on developer machine, connects to NetSuite

**Production Target:**
- Private Git repository
- Static files hosted on AWS S3 + CloudFront (or Azure Blob + CDN)
- Backend deployed to AWS Lambda/ECS or Azure App Service
- Direct cloud hosting (no tunnel needed)
- Multi-tenant authentication via CEFI

---

## Component Breakdown

| Component | Location | Purpose | Key Files |
|-----------|----------|---------|-----------|
| **Excel Manifest** | `excel-addin/manifest.xml` | Defines add-in metadata, URLs, and runtime configuration | `manifest.xml` |
| **Frontend UI** | `docs/taskpane.html` | Main sidebar UI, drill-down logic, report builders, Quick Actions | `taskpane.html` |
| **Custom Functions** | `docs/functions.js` | Excel formula implementations (XAVI.BALANCE, etc.) | `functions.js`, `functions.json` |
| **Shared Runtime** | `docs/sharedruntime.html` | Blank page hosting shared runtime context (prevents duplicate UI on Mac) | `sharedruntime.html` |
| **Backend API** | `backend-dotnet/` | .NET Core Web API that queries NetSuite | `Controllers/`, `Services/` |
| **Legacy Backend** | `backend/` | Python Flask backend (kept for reference only) | `server.py` |
| **Cloudflare Worker** | `CLOUDFLARE-WORKER-CODE.js` | Proxy that routes requests to tunnel | `CLOUDFLARE-WORKER-CODE.js` |

---

## Shared Runtime Architecture

The add-in uses Office's **Shared Runtime** where all components share a single JavaScript context:

```
┌─────────────────────────────────────────────────────────────────┐
│                         SHARED RUNTIME                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────────┐      ┌─────────────────────┐          │
│  │   taskpane.html     │      │    functions.js     │          │
│  │   ───────────────   │      │    ─────────────    │          │
│  │   - Main UI         │      │   - XAVI.BALANCE    │          │
│  │   - Drill-down      │◄────►│   - XAVI.TYPEBALANCE│          │
│  │   - Report builders │      │   - Caching logic   │          │
│  │   - Quick Actions   │      │   - API calls       │          │
│  └─────────────────────┘      └─────────────────────┘          │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                 sharedruntime.html                       │   │
│  │                 ──────────────────                       │   │
│  │   - BLANK page (no visible UI)                          │   │
│  │   - Hosts drillDownFromContextMenu for ExecuteFunction  │   │
│  │   - Prevents duplicate taskpane on Mac                  │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Key Points:**
- `taskpane.html` and `functions.js` share the same JavaScript context
- They communicate via `localStorage` and direct function calls
- `sharedruntime.html` is intentionally blank to prevent duplicate UI on Mac Excel
- All custom functions are registered in `functions.js` via `CustomFunctions.associate()`

For detailed implementation, see [DEVELOPER_CHECKLIST.md](DEVELOPER_CHECKLIST.md).

---

## Request Flow

### Formula Evaluation Flow

```
1. User types =XAVI.BALANCE("4010", "Jan 2025", "Jan 2025") in Excel
2. Excel calls functions.js (via shared runtime)
3. functions.js checks in-memory cache → cache miss
4. functions.js checks localStorage cache → cache miss
5. functions.js calls Cloudflare Worker (netsuite-proxy.chris-corcoran.workers.dev)
6. Worker proxies to Cloudflare Tunnel (*.trycloudflare.com)
7. Tunnel connects to local .NET backend (localhost:5002)
8. Backend authenticates with NetSuite REST API using OAuth 1.0
9. Backend executes SuiteQL query via NetSuite REST API
10. Response flows back through the chain to Excel
11. Result is cached in-memory and localStorage
12. Excel displays the value
```

### Caching Strategy

**Three-Tier Caching:**
1. **In-Memory Cache** (functions.js): Fastest, session-only
2. **localStorage Cache**: Persists across Excel sessions, shared between taskpane and functions.js
3. **Backend Cache** (IMemoryCache): ASP.NET Core in-memory cache with configurable TTL
   - Balance results: 5-minute TTL (default) or 24-hour TTL for range queries
   - Lookup data: 24-hour TTL (subsidiaries, periods, account types)
   - Book-Subsidiary mapping: Persistent dictionary with disk backup (survives server restarts)

**Pre-Caching:**
- **Balance Sheet:** Automatically pre-caches all BS accounts when first BS formula is entered for a period
- **Income Statement:** Automatically pre-caches all P&L accounts when first P&L formula is entered for a period
- **Full Year Refresh (v4.0.6.159+):** When 3+ periods from same year detected, fetches all months in single optimized query
- **Early Grid Detection (v4.0.6.158+):** Detects grid pattern (3+ periods × 2+ accounts) before preload wait, skipping individual preloads and allowing batch processing to handle all requests together

For detailed caching documentation, see [DOCUMENTATION.md#pre-caching--drag-drop-optimization](DOCUMENTATION.md#pre-caching--drag-drop-optimization).

---

## Backend Architecture

### .NET Core Web API

**Location:** `backend-dotnet/`

**Key Controllers:**
- `BalanceController.cs` - Balance queries, batch operations, preload endpoints
- `SpecialFormulaController.cs` - RETAINEDEARNINGS, NETINCOME, CTA calculations
- `TypeBalanceController.cs` - Account type totals (TYPEBALANCE formula)
- `BudgetController.cs` - Budget queries
- `LookupController.cs` - Account metadata, subsidiaries, periods, etc.

**Key Services:**
- `NetSuiteService.cs` - SuiteQL query execution, OAuth 1.0 authentication
- `BalanceService.cs` - Balance query construction and processing, balance result caching
- `LookupService.cs` - Subsidiary resolution, period resolution, account lookups, book-subsidiary mapping cache

**Configuration:**
- Credentials stored in `appsettings.Development.json` (DO NOT COMMIT)
- OAuth 1.0 authentication with NetSuite
- Uses SuiteQL REST API endpoint

**Backend Caching:**
- **IMemoryCache** (ASP.NET Core): In-memory cache for balance results and lookup data
  - Balance results: 5-minute TTL (default) or 24-hour TTL for range queries
  - Lookup data (subsidiaries, periods, account types): 24-hour TTL
- **Book-Subsidiary Association Cache**: Persistent in-memory dictionary with disk backup
  - **Storage**: `Dictionary<string, List<string>>` mapping `accountingBookId -> List<subsidiaryId>`
  - **Initialization**: Built on server startup by querying NetSuite for distinct (accountingbook, subsidiary) pairs from `TransactionAccountingLine` and `TransactionLine`
  - **Persistence**: Saved to disk at `~/Library/Application Support/XaviApi/book-subsidiary-cache.json` (Mac) or equivalent on other OS
  - **Purpose**: Validates which subsidiaries have transactions for each accounting book, used for query optimization and validation
  - **Lifetime**: Persists across server restarts (loaded from disk on startup, rebuilt from NetSuite if disk cache is missing or stale)

### SuiteQL Queries

All financial data is retrieved via SuiteQL (NetSuite's SQL-like query language). Key patterns:

**Balance Sheet Query Pattern:**
```sql
SELECT SUM(
    TO_NUMBER(BUILTIN.CONSOLIDATE(
        tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT',
        {target_sub}, {target_period_id}, 'DEFAULT'
    ))
) AS balance
FROM TransactionAccountingLine tal
JOIN Transaction t ON t.id = tal.transaction
JOIN Account a ON a.id = tal.account
WHERE t.posting = 'T'
  AND tal.posting = 'T'
  AND ap.enddate <= {period_end_date}
  AND tal.accountingbook = {book}
```

**P&L Query Pattern:**
```sql
SELECT SUM(
    TO_NUMBER(BUILTIN.CONSOLIDATE(
        tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT',
        {target_sub}, t.postingperiod, 'DEFAULT'
    )) * -1
) AS balance
FROM TransactionAccountingLine tal
JOIN Transaction t ON t.id = tal.transaction
JOIN Account a ON a.id = tal.account
WHERE t.posting = 'T'
  AND tal.posting = 'T'
  AND a.accttype IN ('Income', 'COGS', 'Expense', ...)
  AND t.postingperiod = {period_id}
```

**Critical:** Always use `BUILTIN.CONSOLIDATE` for multi-currency support. See [BUILTIN_CONSOLIDATE_AUDIT.md](BUILTIN_CONSOLIDATE_AUDIT.md) for complete usage audit.

For complete SuiteQL reference, see [SUITEQL-QUERIES-SUMMARY.md](SUITEQL-QUERIES-SUMMARY.md).

---

## BALANCECURRENCY Function - Technical Details

### Why Not All Subsidiary/Currency Combinations Work

**CRITICAL CONSTRAINT:** The backend uses NetSuite's `ConsolidatedExchangeRate` table to resolve currency to a valid consolidation root. Not every currency can be used with every subsidiary.

**Backend Resolution Logic (`LookupService.ResolveCurrencyToConsolidationRootAsync`):**
1. **Step 1:** Check if currency matches filtered subsidiary's base currency (direct match)
2. **Step 2:** Query `ConsolidatedExchangeRate` table for consolidation path:
   ```sql
   SELECT cer.tosubsidiary AS consolidationRootId
   FROM ConsolidatedExchangeRate cer
   JOIN Subsidiary s ON s.id = cer.tosubsidiary
   JOIN Currency c ON c.id = s.currency
   WHERE cer.fromsubsidiary = {filteredSubId}
     AND UPPER(c.symbol) = UPPER('{currencyCode}')
     AND s.iselimination = 'F'
   ```
3. **Step 3:** If no path found, return `null` → backend returns `INV_SUB_CUR` error

**Valid Combinations:**
- Currency must be a valid consolidation root for the filtered subsidiary
- Consolidation path must exist in `ConsolidatedExchangeRate` table
- If no path exists, returns `error: "INV_SUB_CUR"` and `balance: 0`

**Example:**
- Subsidiary: "Celigo India Pvt Ltd" (base currency: INR)
- Valid: USD (if parent consolidation root defined), INR (base currency)
- Invalid: EUR (unless consolidation path explicitly configured in NetSuite)

### Frontend Implementation

**Routing (`processBatchQueue`):**
- Checks `endpoint === '/balancecurrency'` before routing
- Routes to `balanceCurrencyRequests` array (separate from `regularRequests`)
- Processes individually using `/balancecurrency` endpoint (not batch endpoint)

**Cache Key (`getCacheKey('balancecurrency', params)`):**
- Includes currency parameter in JSON structure: `{"type":"balancecurrency","currency":"USD",...}`
- Separate cache entries for each currency (prevents collisions)
- Changing currency cell reference triggers cache miss → new API call

**Period Normalization:**
- Uses `normalizePeriodKey()` to convert Excel date serials (45658 → "Jan 2025")
- Backend also handles date strings like "1/1/2025" as fallback

### Backend Implementation

**Endpoint:** `GET /balancecurrency`
- Individual endpoint (not batch endpoint)
- Supports currency parameter for consolidation root resolution

**Service Method:** `BalanceService.GetBalanceBetaAsync()`
- Resolves currency to consolidation root via `ResolveCurrencyToConsolidationRootAsync()`
- Uses `BUILTIN.CONSOLIDATE` with consolidation root as `target_sub`
- Returns `INV_SUB_CUR` error if no valid consolidation path exists

---

## Key Features & Implementation

### Formula Batching
When multiple formulas are entered (via drag-down or copy-paste), they are automatically batched into single API calls. This dramatically improves performance for large reports.

**Implementation:**
- Formulas queue requests in `localStorage`
- Batch timer (500ms) collects requests
- Single API call processes all queued requests
- Results distributed to all waiting formulas

### Pre-Caching
Automatically pre-caches all accounts for a period when first formula is entered:
- **Balance Sheet:** Pre-caches all BS accounts when first BS formula detected
- **Income Statement:** Pre-caches all P&L accounts when first P&L formula detected

**Performance Impact:**
- First formula: ~2-3 seconds (triggers preload)
- Subsequent formulas: Instant (from cache)

**Early Grid Detection (v4.0.6.158+):**
- When dragging 3+ columns, grid pattern is detected early (before preload wait)
- Skips individual preload waits for each period
- All requests queue together and are processed via full-year refresh (3+ periods) or batch processing
- Prevents sequential preload waits that would delay batch processing

**Full-Year Refresh (v4.0.6.159+):**
- For 3+ periods from the same year, uses single `/batch/full_year_refresh` query
- Fetches all months in one optimized query (5-15 seconds)
- All data appears at once after query completes
- Provides better overall performance than incremental 3-column batching

### Refresh All
"Refresh All" button clears cache and re-fetches all formulas on the sheet:
- **Smart Detection:** Automatically detects P&L sheets (2+ periods from same year) vs BS sheets (1 period)
- **Optimized Fetching:** Only fetches appropriate account types
- **Full-Year Refresh:** P&L sheets with 2+ periods use `/batch/full_year_refresh` endpoint for optimal performance
- **Sequential Refresh:** Special formulas (RE, NI, CTA) refresh after BALANCE data loads

For complete feature documentation, see [DOCUMENTATION.md](DOCUMENTATION.md).

---

## Platform-Specific Issues

### ⚠️ CRITICAL: Mac Parameter Order Issue

**Mac Excel will crash if you change function parameter order after deployment.**

Mac Excel caches custom function parameter metadata aggressively. If you change the parameter order of a function after it has been registered and used, Excel will crash on startup.

**The only reliable fix:** Use `remove-office-keep-edge.sh` to completely remove Office and all caches, then reinstall.

**Prevention:** Finalize parameter order before deployment. Never change it after users have started using the function.

### Right-Click Context Menu on Mac

The right-click "View Transactions" context menu has Mac platform limitations:
- May open Developer Window (unreliable)
- **Recommended:** Use Quick Actions "Drill Down" button instead (works reliably on both platforms)

### Mac Manifest Sideload Location

**Correct location (Microsoft 365):**
```
~/Library/Containers/com.microsoft.Excel/Data/Documents/wef/
```

**NOT the old locations:**
- ❌ `~/Library/Group Containers/UBF8T346G9.Office/User Content.localized/Wef/`
- ❌ `~/Library/Group Containers/UBF8T346G9.Office/User Content/Wef/`

For complete Mac setup instructions, see [DEVELOPER_CHECKLIST.md](DEVELOPER_CHECKLIST.md).

---

## What's Missing / Needs to Be Done

### 1. Production Deployment

**Current State:** Development setup using GitHub Pages + Cloudflare Tunnel  
**Needs:**
- Move static files to private hosting (AWS S3 + CloudFront or Azure Blob + CDN)
- Deploy backend to cloud (AWS Lambda/ECS or Azure App Service)
- Remove Cloudflare Tunnel dependency
- Update manifest URLs to production endpoints

**Required Changes:**
1. Update `excel-addin/manifest.xml` - Replace all GitHub Pages URLs
2. Update `docs/taskpane.html` and `docs/functions.js` - Change `SERVER_URL` constant
3. Configure backend to read credentials from environment variables or secrets manager
4. Remove `CLOUDFLARE-WORKER-CODE.js` (no longer needed)

See "Code Changes Required for Cloud Deployment" section below.

### 2. Multi-Tenant Authentication (CEFI Integration)

**Current State:** Single set of NetSuite credentials shared by all users  
**Needs:**
- CEFI (Celigo's identity platform) authentication
- Per-user NetSuite credential storage
- Token validation middleware
- Credential retrieval from secure store

**Required Changes:**
1. Frontend: Add CEFI login flow, token storage, token validation
2. Backend: Add authentication middleware, credential retrieval service
3. Storage: Encrypted database or credential vault for per-user NetSuite credentials

See "Multi-Tenant Architecture (CEFI Login)" section below.

### 3. Error Handling & Monitoring

**Current State:** Basic error handling, console logging  
**Needs:**
- Structured logging (e.g., Serilog, Application Insights)
- Error tracking (e.g., Sentry, Application Insights)
- Performance monitoring
- Rate limiting

### 4. Testing

**Current State:** Manual testing, some test scripts  
**Needs:**
- Unit tests for backend services
- Integration tests for API endpoints
- End-to-end tests for formula evaluation
- Automated test suite

### 5. Documentation

**Current State:** Comprehensive documentation exists  
**Needs:**
- API documentation (Swagger/OpenAPI)
- Deployment runbooks
- Troubleshooting guides
- Performance tuning guides

---

## Code Changes Required for Cloud Deployment

### 1. Update Manifest URLs

In `excel-addin/manifest.xml`, replace all GitHub Pages URLs:

```xml
<!-- FROM -->
<SourceLocation DefaultValue="https://chris-cloudextend.github.io/netusite-excel-add-in-dotnet/taskpane.html"/>

<!-- TO (example for AWS) -->
<SourceLocation DefaultValue="https://d1234567890.cloudfront.net/taskpane.html"/>
```

**All URLs to update:**
- `SourceLocation` (taskpane)
- `SharedRuntime.Url` (sharedruntime.html)
- `Functions.Script.Url` (functions.js)
- `Functions.Metadata.Url` (functions.json)
- Icon URLs (icon-32.png, icon-64.png, etc.)

### 2. Update SERVER_URL in Frontend

In `docs/taskpane.html` and `docs/functions.js`, update the server URL:

```javascript
// FROM
const SERVER_URL = 'https://netsuite-proxy.chris-corcoran.workers.dev';

// TO (example)
const SERVER_URL = 'https://api.xavi.cloudextend.io';
```

### 3. Backend Configuration

The backend currently reads credentials from `appsettings.Development.json`. For cloud deployment:

**Option A: Environment Variables**
```csharp
// In Program.cs or appsettings.json
var accountId = Environment.GetEnvironmentVariable("NETSUITE_ACCOUNT_ID");
var consumerKey = Environment.GetEnvironmentVariable("NETSUITE_CONSUMER_KEY");
// etc.
```

**Option B: Secrets Manager (AWS) / Key Vault (Azure)**
```csharp
// Using AWS SDK for .NET
using Amazon.SecretsManager;
var client = new AmazonSecretsManagerClient();
var response = await client.GetSecretValueAsync(new GetSecretValueRequest
{
    SecretId = "netsuite-credentials"
});
```

**Note:** Legacy Python backend (`backend/server.py`) is kept for reference only.

### 4. Remove Cloudflare Dependencies

- Delete `CLOUDFLARE-WORKER-CODE.js` (no longer needed)
- Remove any references to trycloudflare.com tunnel URLs
- Update CORS configuration to allow production Excel origins

---

## Multi-Tenant Architecture (CEFI Login)

### Current State
The backend currently uses a single set of NetSuite credentials configured in `appsettings.Development.json`. All users share these credentials.

### Target State
Each user authenticates via CEFI (Celigo's identity platform), and the backend retrieves their NetSuite credentials from a secure store.

### Required Changes

**1. Frontend Authentication Flow**
```javascript
// On add-in load, check if user is authenticated
async function checkAuth() {
    const token = localStorage.getItem('cefi_token');
    if (!token) {
        // Redirect to CEFI login
        window.location.href = 'https://auth.celigo.com/login?redirect=...';
    }
    // Validate token with backend
    const response = await fetch(`${SERVER_URL}/auth/validate`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
}
```

**2. Backend Token Validation**
```csharp
// In Program.cs or middleware
app.Use(async (context, next) =>
{
    var token = context.Request.Headers["Authorization"].ToString();
    // Validate with CEFI
    // Retrieve user's NetSuite credentials from secure store
    // Set credentials for this request
    await next();
});
```

**3. Credential Storage**
- Store per-user NetSuite credentials in encrypted database
- Or use CEFI's credential vault if available
- Credentials should include: Account ID, Consumer Key/Secret, Token Key/Secret

---

## Recommended Cloud Architecture

### AWS Architecture

```
                                    ┌─────────────────┐
                                    │   CloudFront    │
                                    │   (CDN + HTTPS) │
                                    └────────┬────────┘
                                             │
              ┌──────────────────────────────┼──────────────────────────────┐
              │                              │                              │
              ▼                              ▼                              ▼
    ┌─────────────────┐          ┌─────────────────┐          ┌─────────────────┐
    │   S3 Bucket     │          │  API Gateway    │          │   Cognito       │
    │  (Static Files) │          │  (REST API)     │          │  (CEFI Auth)    │
    │  taskpane.html  │          │                 │          │                 │
    │  functions.js   │          └────────┬────────┘          └─────────────────┘
    │  sharedruntime  │                   │
    └─────────────────┘                   ▼
                               ┌─────────────────┐
                               │  Lambda / ECS   │
                               │  (.NET Core)    │
                               └────────┬────────┘
                                        │
                                        ▼
                               ┌─────────────────┐
                               │  Secrets Manager│
                               │  (NetSuite creds)│
                               └────────┬────────┘
                                        │
                                        ▼
                               ┌─────────────────┐
                               │  NetSuite REST  │
                               │      API        │
                               └─────────────────┘
```

### Azure Architecture

Similar structure using:
- Azure Blob Storage + CDN for static files
- Azure API Management for REST API
- Azure App Service or Container Instances for backend
- Azure Key Vault for credentials

---

## Security Considerations

1. **Never commit credentials** - `appsettings.Development.json` should be in `.gitignore`
2. **HTTPS required** - Excel add-ins require HTTPS for all resources
3. **CORS configuration** - Backend must allow requests from Excel's origin
4. **Token expiration** - Implement proper token refresh for CEFI auth
5. **Rate limiting** - Consider adding rate limits to prevent abuse
6. **SQL injection protection** - All user inputs must be sanitized (use `EscapeSql` helper)
7. **Input validation** - Validate all parameters before constructing queries

---

## Key Files Reference

| File | Description | When to Modify |
|------|-------------|----------------|
| `backend-dotnet/` | Main .NET backend - all NetSuite API calls | Adding new endpoints, modifying queries |
| `docs/taskpane.html` | Main UI + JavaScript logic + drill-down | UI changes, new features, drill-down logic |
| `docs/functions.js` | Excel custom functions implementation | Adding/modifying formulas, caching logic |
| `docs/functions.json` | Excel function definitions/metadata | Adding new formulas, changing parameters |
| `docs/sharedruntime.html` | Blank shared runtime page | Rarely (only if shared runtime config changes) |
| `excel-addin/manifest.xml` | Excel add-in manifest with all URLs | Version updates, URL changes, cache-busting |
| `DEVELOPER_CHECKLIST.md` | Integration points for adding new formulas | When architecture changes |
| `DOCUMENTATION.md` | Complete feature and API documentation | When features are added/modified |

---

## Testing the Migration

1. Deploy static files to new hosting
2. Deploy backend to cloud
3. Update manifest with new URLs
4. Sideload updated manifest in Excel
5. Test all formulas: BALANCE, BUDGET, NAME, TYPEBALANCE, RETAINEDEARNINGS, NETINCOME, CTA
6. Test Quick Start reports (CFO Flash Report, Income Statement)
7. Test drill-down functionality (use Quick Actions button, not right-click on Mac)
8. Test multi-subsidiary support
9. Test Refresh All functionality
10. Test pre-caching behavior

---

## Additional Documentation

- **[DOCUMENTATION.md](DOCUMENTATION.md)** - Complete feature documentation, API reference, SuiteQL deep dive
- **[DEVELOPER_CHECKLIST.md](DEVELOPER_CHECKLIST.md)** - Step-by-step guide for adding new formulas
- **[USER_STORIES.md](USER_STORIES.md)** - User stories and acceptance criteria
- **[SUITEQL-QUERIES-SUMMARY.md](SUITEQL-QUERIES-SUMMARY.md)** - Complete SuiteQL query reference
- **[SPECIAL_FORMULAS_REFERENCE.md](SPECIAL_FORMULAS_REFERENCE.md)** - RETAINEDEARNINGS, NETINCOME, CTA implementation details
- **[BUILTIN_CONSOLIDATE_AUDIT.md](BUILTIN_CONSOLIDATE_AUDIT.md)** - Complete audit of BUILTIN.CONSOLIDATE usage
- **[ALLOW_ZERO_LIST.md](ALLOW_ZERO_LIST.md)** - When returning 0 is allowed vs. when errors must be thrown

---

## Questions for Engineering Team

1. Which cloud provider (AWS or Azure)?
2. How will CEFI credentials be passed to the add-in?
3. Will there be a credential storage service, or should we build one?
4. What's the domain for the production API? (e.g., api.xavi.cloudextend.io)
5. Do we need to support on-premise NetSuite deployments?
6. What monitoring/observability tools should we integrate?
7. What's the deployment strategy (CI/CD pipeline)?

---

## Recent Changes (v4.0.6.162-167)

### v4.0.6.167: BALANCECURRENCY - Currency in Cache Key
- **Issue:** Changing currency cell reference (USD to INR or vice versa) didn't update formula result - returned cached value
- **Root Cause:** `getCacheKey()` function didn't handle `'balancecurrency'` type, returning empty string `''`, causing all BALANCECURRENCY requests to share same cache key regardless of currency
- **Fix:** Added `'balancecurrency'` handler to `getCacheKey()` function that includes currency parameter in cache key JSON structure
- **Impact:** Separate cache entries for each currency (USD vs INR vs other currencies), changing currency cell reference triggers new API call
- **Files Modified:** `docs/functions.js` (lines 6555-6582), `excel-addin/manifest.xml`, `docs/taskpane.html`, `docs/sharedruntime.html`, `docs/functions.html`

### v4.0.6.166: BALANCECURRENCY - Individual Endpoint Routing
- **Issue:** BALANCECURRENCY was returning values in default currency (Rupees) instead of requested currency (USD)
- **Root Cause:** BALANCECURRENCY requests were routed to `regularRequests` and processed through batch endpoint (`/batch/balance`), which doesn't support currency parameter
- **Fix:** Added `balanceCurrencyRequests` array in `processBatchQueue()` to separate BALANCECURRENCY requests, check `endpoint === '/balancecurrency'` before routing, process individually using `/balancecurrency` endpoint
- **Impact:** BALANCECURRENCY now routes to individual `/balancecurrency` endpoint, currency parameter properly sent and processed
- **Files Modified:** `docs/functions.js` (lines 10610-11075), `excel-addin/manifest.xml`, `docs/taskpane.html`, `docs/sharedruntime.html`, `docs/functions.html`

### v4.0.6.164-165: BALANCECURRENCY - Excel Date Serial Normalization
- **Issue:** BALANCECURRENCY returned 0 when using Excel date serials (e.g., `45658` for `1/1/2025`) instead of normalizing to `"Jan 2025"`
- **Root Cause:** Second BALANCECURRENCY function definition (line 12316) only converted to strings without normalizing Excel date serials
- **Fix:** Updated second BALANCECURRENCY function to use `normalizePeriodKey()` for Excel date serials, added `extractValueFromRange()` for cell references, removed duplicate `rawAccountingBook` declaration
- **Impact:** Excel date serials now properly normalized to `"Mon YYYY"` format, backend also handles date strings like `"1/1/2025"` as fallback
- **Files Modified:** `docs/functions.js` (lines 12347-12506), `backend-dotnet/Services/NetSuiteService.cs` (GetPeriodAsync date parsing), `excel-addin/manifest.xml`, `docs/taskpane.html`, `docs/sharedruntime.html`, `docs/functions.html`

### v4.0.6.163: Performance - Increased CHUNK_SIZE from 50 to 100
- **Issue:** Frontend was chunking accounts into groups of 50, but backend supports 100+ accounts per request
- **Fix:** Increased `CHUNK_SIZE` constant from 50 to 100 in `docs/functions.js` (line 6241)
- **Impact:** 60% faster batch processing for large batches (tested with 114 accounts: ~5.5s vs ~13.8s)
- **Files Modified:** `docs/functions.js`, `excel-addin/manifest.xml`, `docs/taskpane.html`, `docs/sharedruntime.html`, `docs/functions.html`
- **Testing:** Backend tested and confirmed to support 114+ accounts in single request

### v4.0.6.162: Taskpane Range Preload + Cache Range Support
- **Issue:** Cache misses for quarterly ranges (e.g., `XAVI.BALANCE("4220", "1/1/25", "3/31/25")`)
- **Fix:** Updated taskpane preload logic to detect range queries, call `/batch/full_year_refresh`, sum balances, and cache with range-specific keys
- **Impact:** Quarterly range formulas now properly cached and resolve quickly after first evaluation
- **Files Modified:** `docs/taskpane.html`, `docs/functions.js`

### v4.0.6.159: Full-Year Refresh for 3+ Periods
- **Issue:** 3-column batching provided incremental updates but felt slow due to perceived lack of progress
- **Fix:** Reverted to full-year refresh for all 3+ periods from same year (removed 3-column batching logic)
- **Impact:** Single optimized query fetches all months at once (5-15 seconds), all data appears simultaneously
- **Files Modified:** `docs/functions.js` (lines 11218-11293)
- **Analysis:** See `DRAG_RIGHT_9_COLUMN_ANALYSIS.md` for detailed findings and rationale

### v4.0.6.158: Early Grid Detection
- **Issue:** When dragging 3+ columns, formulas were waiting 120s for individual preloads, preventing batch processing
- **Fix:** Added early grid detection in `BALANCE()` function that detects grid pattern (3+ periods × 2+ accounts) before preload wait
- **Impact:** Skips preload wait for grid patterns, allowing batch processing to handle all requests together
- **Files Modified:** `docs/functions.js` (lines 7709-7848)
- **Documentation:** See `DRAG_RIGHT_SINGLE_CELL_BUG_REPORT.md` and `DRAG_RIGHT_FIX_IMPLEMENTATION_PLAN.md`

---

*This document is maintained as a knowledge transfer resource. For feature-specific documentation, see [DOCUMENTATION.md](DOCUMENTATION.md).*
