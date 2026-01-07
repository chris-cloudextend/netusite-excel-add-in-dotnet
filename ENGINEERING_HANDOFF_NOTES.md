# Engineering Handoff Notes

## Recent Changes (January 2026)

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

