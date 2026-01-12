# .NET Migration Plan for XAVI NetSuite Excel Add-in

> **Status: ✅ MIGRATION COMPLETE**  
> The migration from Python Flask to .NET backend has been completed. The .NET backend (`backend-dotnet/`) is now the active backend. The Python Flask backend (`backend/`) is kept for reference only.

## Overview

This project was converted from a **Python Flask backend** to a **.NET (C#) backend** while keeping the Excel Add-in frontend (JavaScript/HTML) unchanged. The migration is complete and the .NET backend is now in production use.

## Current Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Excel Add-in (Frontend)                  │
│  - docs/taskpane.html    → Main UI (task pane)              │
│  - docs/functions.js     → Custom Excel functions           │
│  - docs/functions.json   → Function registration            │
│  - docs/sharedruntime.html → Hosts functions without UI     │
│  - excel-addin/manifest-claude.xml → Add-in manifest        │
│                                                             │
│  ⚠️ DO NOT MODIFY - These stay as-is (JavaScript/HTML)      │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ HTTP REST API calls
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              Python Flask Backend (LEGACY - NOT IN USE)     │
│  - backend/server.py     → Flask routes & NetSuite API      │
│  - backend/constants.py  → Account type mappings            │
│                                                             │
│  ✅ MIGRATED TO .NET - See backend-dotnet/                 │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ OAuth 1.0 / REST API
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      NetSuite SuiteQL                       │
└─────────────────────────────────────────────────────────────┘
```

## Migration Steps

### Phase 1: Create .NET Project Structure ✅ COMPLETED

The .NET project has been created in `backend-dotnet/`:

```
backend-dotnet/
├── Controllers/          # API endpoints
│   ├── HealthController.cs
│   ├── BalanceController.cs
│   ├── TypeBalanceController.cs
│   ├── LookupController.cs
│   ├── AccountController.cs
│   └── BudgetController.cs
├── Services/             # Business logic
│   ├── NetSuiteService.cs
│   ├── OAuth1Helper.cs
│   ├── BalanceService.cs
│   ├── LookupService.cs
│   └── BudgetService.cs
├── Models/               # DTOs and constants
├── Configuration/        # Config classes
├── Program.cs            # Entry point
└── appsettings.json      # Configuration
```

NuGet packages included:
- `RestSharp` - HTTP client
- `Newtonsoft.Json` - JSON handling
- `Microsoft.Extensions.Caching.Memory` - Caching

### Phase 2: Convert API Endpoints

The Python `server.py` exposes these endpoints that need to be recreated in .NET:

| Python Endpoint | Method | Description |
|-----------------|--------|-------------|
| `/balance` | GET | Get account balance for single account |
| `/type-balance` | GET | Get balance by account type (Income, Expense, etc.) |
| `/batch/full_year_refresh` | GET | Batch fetch all balances for a year |
| `/batch/typebalance_refresh` | GET | Batch fetch type balances for a year |
| `/subsidiaries` | GET | List all subsidiaries |
| `/accounts` | GET | List all accounts |
| `/classes` | GET | List all classes |
| `/departments` | GET | List all departments |
| `/locations` | GET | List all locations |
| `/currencies` | GET | Get currency info for subsidiary |
| `/budget` | GET | Get budget data |
| `/budget/all` | GET | Get all budget data |
| `/gl-impact` | GET | Get GL impact details |

### Phase 3: NetSuite OAuth 1.0 Authentication

NetSuite uses OAuth 1.0 (not 2.0). The Python code in `server.py` has the OAuth implementation.

Key credentials needed (from `netsuite_config.template.json`):
- `account_id` - NetSuite account ID
- `consumer_key` - OAuth consumer key
- `consumer_secret` - OAuth consumer secret  
- `token_id` - OAuth token ID
- `token_secret` - OAuth token secret

### Phase 4: SuiteQL Query Logic

All the SuiteQL queries are in `server.py`. Key queries to port:
- Account balance queries (with BUILTIN.CONSOLIDATE)
- Type balance queries (aggregated by account type)
- Budget queries
- Lookup queries (subsidiaries, accounts, etc.)

### Phase 5: Configuration

Create `appsettings.json` for .NET:
```json
{
  "NetSuite": {
    "AccountId": "",
    "ConsumerKey": "",
    "ConsumerSecret": "",
    "TokenId": "",
    "TokenSecret": "",
    "BaseUrl": "https://{account_id}.suitetalk.api.netsuite.com"
  }
}
```

⚠️ Use User Secrets or environment variables for credentials - never commit them!

### Phase 6: CORS Configuration

The Excel Add-in runs from `https://chris-cloudextend.github.io` and needs CORS enabled:

```csharp
builder.Services.AddCors(options =>
{
    options.AddPolicy("AllowExcelAddin", policy =>
    {
        policy.WithOrigins(
            "https://chris-cloudextend.github.io",
            "https://localhost:3000"  // for local dev
        )
        .AllowAnyHeader()
        .AllowAnyMethod();
    });
});
```

## Important Notes

### DO NOT MODIFY
- `docs/` folder - This is the Excel Add-in frontend hosted on GitHub Pages
- `excel-addin/manifest-claude.xml` - The add-in manifest
- Any frontend JavaScript/HTML files

### Key Python Files to Reference
- `backend/server.py` - Main Flask app with all routes and NetSuite logic (~340KB, ~8000 lines)
- `backend/constants.py` - Account type mappings and constants

### Testing
After conversion, test with:
1. Run the .NET API locally
2. Use Cloudflare Tunnel to expose it: `cloudflared tunnel --url http://localhost:5000`
3. Update the add-in to point to the tunnel URL
4. Test all formulas and features in Excel

## Recommended .NET Project Structure

```
backend-dotnet/
├── Controllers/
│   ├── BalanceController.cs
│   ├── TypeBalanceController.cs
│   ├── BatchController.cs
│   ├── LookupController.cs
│   └── BudgetController.cs
├── Services/
│   ├── NetSuiteService.cs        # OAuth + API calls
│   ├── SuiteQLService.cs         # Query building
│   └── CacheService.cs           # In-memory caching
├── Models/
│   ├── BalanceRequest.cs
│   ├── BalanceResponse.cs
│   └── ...
├── Configuration/
│   └── NetSuiteConfig.cs
├── Program.cs
├── appsettings.json
└── appsettings.Development.json  # (gitignored)
```

## Quick Start Commands

```bash
# Create the .NET project
cd /Users/chriscorcoran/Documents/Cursor/NetSuite-Excel-AddIn-DotNet
dotnet new webapi -n XaviApi -o backend-dotnet
cd backend-dotnet

# Add packages
dotnet add package RestSharp
dotnet add package Newtonsoft.Json

# Run the API
dotnet run

# Or with hot reload
dotnet watch run
```

## Session Notes

- Original project: `/Users/chriscorcoran/Documents/Cursor/NetSuite Formulas Revised`
- New .NET project: `/Users/chriscorcoran/Documents/Cursor/NetSuite-Excel-AddIn-DotNet`
- GitHub repo: https://github.com/chris-cloudextend/netusite-excel-add-in-dotnet
- Current version: v3.0.5.233
- Mac manifest location: `~/Library/Containers/com.microsoft.Excel/Data/Documents/wef/`

---

**To continue the migration, open this project in Cursor and ask:**
> "Please help me convert the Python Flask backend to .NET following the DOTNET_MIGRATION_PLAN.md"

