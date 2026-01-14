# XAVI for NetSuite

Excel Add-in providing custom formulas to query NetSuite financial data directly in Excel.

## Quick Start

### 1. Start the Backend Server (.NET)

```bash
cd backend-dotnet
cp appsettings.Development.json.template appsettings.Development.json
# Edit appsettings.Development.json with your NetSuite credentials
dotnet run
```

The server will start on `http://localhost:5002` by default.

### 2. Start Cloudflare Tunnel

```bash
cloudflared tunnel --url http://localhost:5002
# Copy the tunnel URL and update CLOUDFLARE-WORKER-CODE.js
```

### 3. Install the Excel Add-in

**Mac:**
```bash
cp excel-addin/manifest.xml ~/Library/Containers/com.microsoft.Excel/Data/Documents/wef/
```

**Windows:**
```
Copy manifest.xml to %USERPROFILE%\AppData\Local\Microsoft\Office\16.0\Wef\
```

Then in Excel: **Insert → My Add-ins → Shared Folder** → Select the manifest

## Available Formulas

| Formula | Description |
|---------|-------------|
| `=XAVI.BALANCE("4010", "Jan 2025", "Jan 2025")` | Get GL account balance |
| `=XAVI.BALANCECURRENCY("4010", "Jan 2025", "Jan 2025", "Subsidiary", "USD")` | Get balance with explicit currency control |
| `=XAVI.TYPEBALANCE("Income", "Jan 2025", "Dec 2025")` | Get total for account type |
| `=XAVI.BUDGET("4010", "Jan 2025", "Dec 2025", "", "", "", "", "", "Budget Category")` | Get budget amount |
| `=XAVI.NAME("4010")` | Get account name |
| `=XAVI.TYPE("4010")` | Get account type |
| `=XAVI.PARENT("4010")` | Get parent account number |
| `=XAVI.RETAINEDEARNINGS("Dec 2024")` | Calculate Retained Earnings |
| `=XAVI.NETINCOME("Mar 2025")` | Calculate Net Income YTD |
| `=XAVI.CTA("Dec 2024")` | Calculate CTA (multi-currency) |

## Features

### Quick Start Reports
- **CFO Flash Report** - High-level P&L summary using TYPEBALANCE formulas
- **Full Income Statement** - Detailed P&L with all accounts using BALANCE formulas
- **Budget Comparison** - Actual vs. Budget report

### Drill-Down Functionality
Users can drill down into any balance to see underlying transactions:
- **XAVI.BALANCE** → Shows individual transactions
- **XAVI.TYPEBALANCE** → Shows accounts with balances, then drill into transactions

**Drill-Down Methods:**
1. **Quick Actions Bar (Recommended)** - Select a formula cell, click "Drill Down" button
2. **Right-Click Menu** - Right-click → CloudExtend → View Transactions

> ⚠️ **Known Issue:** The right-click context menu has platform limitations on Mac Excel. The Quick Actions "Drill Down" button in the taskpane is the recommended method and works reliably on both Mac and Windows.

## Documentation

| Document | Audience | Content |
|----------|----------|---------|
| [DOCUMENTATION.md](DOCUMENTATION.md) | All | Complete guide (CPA + Engineering) |
| [USER_GUIDE.md](USER_GUIDE.md) | End Users | How to use XAVI formulas |
| [DEVELOPER_CHECKLIST.md](DEVELOPER_CHECKLIST.md) | Engineers | Integration points checklist |
| [ENGINEERING_HANDOFF.md](ENGINEERING_HANDOFF.md) | Engineers | Cloud migration and CEFI integration |
| [MAC_PARAMETER_ORDER_ISSUE.md](MAC_PARAMETER_ORDER_ISSUE.md) | Engineers | **CRITICAL:** Mac Excel parameter order issue |
| [SUITEQL-QUERIES-SUMMARY.md](SUITEQL-QUERIES-SUMMARY.md) | Engineers | All SuiteQL queries used |

## Project Structure

```
├── backend-dotnet/       # .NET backend server (active)
│   ├── Controllers/     # API endpoints
│   ├── Services/         # Business logic & NetSuite integration
│   ├── Models/           # Data models
│   └── Program.cs       # Entry point
├── backend/              # Python Flask server (legacy, kept for reference)
│   ├── server.py         # API endpoints + SuiteQL queries
│   └── constants.py      # Account type constants
├── docs/                 # Excel Add-in files (GitHub Pages)
│   ├── functions.js      # Custom function implementations
│   ├── functions.json    # Function metadata for Excel
│   ├── taskpane.html     # Taskpane UI + all drill-down logic
│   └── sharedruntime.html # Blank shared runtime page
├── excel-addin/          # Manifest file
│   └── manifest.xml
└── DOCUMENTATION.md      # Main documentation
```

## Architecture

**Backend:** The system uses a **.NET Core (ASP.NET Core)** backend server. The Python Flask backend (`backend/server.py`) is legacy and kept for reference only.

```
Excel Add-in → GitHub Pages (static files) → Cloudflare Worker (proxy) 
    → Cloudflare Tunnel → .NET Backend (ASP.NET Core) → NetSuite REST API
```

**Backend Technology Stack:**
- **Active Backend:** .NET 8.0 (ASP.NET Core Web API)
- **Location:** `backend-dotnet/` directory
- **Port:** 5002 (default)
- **Legacy Backend:** Python Flask (`backend/` directory) - **NOT IN USE**

### Shared Runtime Configuration
The add-in uses Office's Shared Runtime for communication between:
- Task pane UI (`taskpane.html`)
- Custom functions (`functions.js`)
- Commands (`sharedruntime.html`)

## Support

For issues with:
- **Formulas showing #N/A:** Check the connection status in the taskpane
- **Values not matching NetSuite:** Verify subsidiary, period, and accounting book
- **Performance:** Use "Refresh All" to batch refresh formulas
- **Drill-down not working:** Use Quick Actions "Drill Down" button instead of right-click

See [DOCUMENTATION.md](DOCUMENTATION.md) for detailed troubleshooting.

---

*Current Version: 4.0.6.167*
 
