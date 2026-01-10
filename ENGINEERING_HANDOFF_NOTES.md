# Engineering Handoff Notes

## Recent Changes (January 2026)

### Refresh All Smart Detection (v4.0.6.145)
- **Status:** ✅ Production-ready
- **Location:** `docs/taskpane.html` - `refreshCurrentSheet()` function
- **Problem:** Refresh All was incorrectly fetching Balance Sheet accounts for Income Statement sheets (12 periods), causing timeouts
- **Solution:** 
  - Smart inference: 12 periods (or 10-12) → P&L sheet, 1 period → Balance Sheet
  - Improved account extraction regex to handle more formula variations
  - Only fetch BS accounts if BS accounts are identified (no fallback to BS)
- **Impact:** Income Statement sheets now refresh in ~30 seconds instead of timing out
- **Files Changed:**
  - `docs/taskpane.html` - Smart sheet type detection, improved account extraction
  - `excel-addin/manifest.xml` - Version updated to 4.0.6.145

### Income Statement Pre-Caching (v4.0.6.144)
- **Status:** ✅ Production-ready
- **Location:** `docs/functions.js` - `triggerIncomePreload()`, `docs/taskpane.html` - `processIncomePreloadTriggers()`
- **Backend:** `backend-dotnet/Controllers/BalanceController.cs` - `PreloadIncomeStatementAccounts()`
- **Features:**
  - Automatically triggers when first Income Statement formula is entered
  - Pre-caches all Income, COGS, Expense, OthIncome, OthExpense accounts for the period
  - Works seamlessly with full year refresh (12 months)
  - Cache persists in localStorage
- **Performance:** Dragging formulas across 12 months resolves instantly after first period preload

### Single Promise Per Period (v4.0.6.139)
- **Status:** ✅ Production-ready, default behavior
- **Location:** `docs/functions.js` - Single-promise infrastructure
- **Features:**
  - All cells for the same period await the EXACT SAME Promise
  - Promise resolves WITH balance data, ensuring simultaneous resolution
  - Task pane progress indicator shows preload status
  - No feature flag - now the standard approach
- **Performance:** ~70-80s per period for full preload, all cells resolve simultaneously

### Inactive Accounts Option (v4.0.6.139)
- **Location:** `docs/taskpane.html` - Bulk Add GL Accounts section
- **Features:**
  - Checkbox to include inactive accounts in bulk add
  - Inactive column added to output when option is selected
  - Backend updated to return `isinactive` field in account search results
- **Backend:** `backend-dotnet/Services/LookupService.cs` - Added `isinactive` to query and response

### Code Cleanup (v4.0.6.139)
- ✅ Removed feature flag (single-promise now default)
- ✅ Removed debug/troubleshooting logs
- ✅ Updated manifest version to 4.0.6.139

## Previous Changes (January 2026)

### Account Search Implementation
- **Location:** `backend-dotnet/Services/LookupService.cs` → `SearchAccountsByPatternAsync`
- **Features:**
  - Explicit intent detection for search patterns
  - Supports category keywords: "income", "balance", "bank"
  - Supports exact account type matching: "OthIncome", "AcctPay", "AcctRec", "FixedAsset", etc.
  - Supports name/number search for all other patterns
  - Uses NetSuite-compatible `FETCH FIRST` syntax (not `OFFSET ... FETCH NEXT`)
  - Proper error handling with error propagation (no silent failures)

### Pagination Fix
- **Issue:** NetSuite SuiteQL does not support `OFFSET ... FETCH NEXT` syntax
- **Solution:** Account search uses `FETCH FIRST 1000 ROWS ONLY` directly in query
- **Impact:** All account searches now work correctly

### Logging Standards
- Verbose logging moved to `LogDebug` level
- Production logging uses `LogInformation` for important events
- Error logging uses `LogError` with clear messages
- Removed emoji characters from log messages

## Code Quality

### Cleaned Up
- ✅ Removed temporary test files
- ✅ Removed debugging scripts
- ✅ Converted verbose logging to Debug level
- ✅ Removed emoji from log messages
- ✅ Removed temporary documentation files

### Production Ready
- ✅ Error handling properly implemented
- ✅ SQL injection protection via `EscapeSql`
- ✅ Proper exception propagation
- ✅ Structured logging for troubleshooting

## Testing

### Account Search Test Cases
- "income" → Returns all income statement accounts (Income, OthIncome, Expense, OthExpense, COGS)
- "balance" → Returns all balance sheet accounts (Bank, AcctRec, FixedAsset, AcctPay, Equity, etc.)
- "bank" → Returns only Bank accounts
- "OthIncome" → Returns all Other Income accounts
- "AcctPay" → Returns all Accounts Payable accounts
- "AcctRec" → Returns all Accounts Receivable accounts
- "*" or "" → Returns all active accounts
- "100" → Searches account numbers and names containing "100"
- "cash" → Searches account names containing "cash"

## Deployment

### Backend
1. Ensure .NET 8.0 SDK is installed
2. Configure `appsettings.json` with NetSuite credentials
3. Run `dotnet run` from `backend-dotnet/` directory
4. Backend starts on port 5002 by default

### Cloudflare Tunnel
1. Start tunnel: `cloudflared tunnel --url http://localhost:5002`
2. Update `CLOUDFLARE-WORKER-CODE.js` with new tunnel URL
3. Deploy to Cloudflare Workers dashboard

### Frontend
- Files served from GitHub Pages
- Manifest version updated for cache busting
- No deployment needed for frontend changes (auto-deploys via GitHub Pages)

## Known Issues

None at this time. All recent fixes have been tested and verified.

## Next Steps

1. Review remaining test scripts in root directory
2. Consolidate documentation files if needed
3. Set up CI/CD pipeline if not already in place
4. Configure production logging/monitoring

