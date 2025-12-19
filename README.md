# XAVI for NetSuite

Excel Add-in providing custom formulas to query NetSuite financial data directly in Excel.

## Quick Start

### 1. Start the Backend Server

```bash
cd backend
pip3 install -r requirements.txt
cp netsuite_config.template.json netsuite_config.json
# Edit netsuite_config.json with your NetSuite credentials
python3 server.py
```

### 2. Start Cloudflare Tunnel

```bash
cloudflared tunnel --url http://localhost:5002
# Copy the tunnel URL and update CLOUDFLARE-WORKER-CODE.js
```

### 3. Install the Excel Add-in

**Mac:**
```bash
cp excel-addin/manifest-claude.xml ~/Library/Containers/com.microsoft.Excel/Data/Documents/wef/
```

**Windows:**
```
Copy manifest-claude.xml to %USERPROFILE%\AppData\Local\Microsoft\Office\16.0\Wef\
```

Then in Excel: **Insert → My Add-ins → Shared Folder** → Select the manifest

## Available Formulas

| Formula | Description |
|---------|-------------|
| `=XAVI.BALANCE("4010", "Jan 2025", "Jan 2025")` | Get GL account balance |
| `=XAVI.TYPEBALANCE("Income", "Jan 2025", "Dec 2025")` | Get total for account type |
| `=XAVI.BUDGET("4010", "Jan 2025", "Dec 2025")` | Get budget amount |
| `=XAVI.NAME("4010")` | Get account name |
| `=XAVI.TYPE("4010")` | Get account type |
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
| [SUITEQL-QUERIES-SUMMARY.md](SUITEQL-QUERIES-SUMMARY.md) | Engineers | All SuiteQL queries used |

## Project Structure

```
├── backend/              # Python Flask server
│   ├── server.py         # API endpoints + SuiteQL queries
│   └── constants.py      # Account type constants
├── docs/                 # Excel Add-in files (GitHub Pages)
│   ├── functions.js      # Custom function implementations
│   ├── functions.json    # Function metadata for Excel
│   ├── taskpane.html     # Taskpane UI + all drill-down logic
│   └── sharedruntime.html # Blank shared runtime page
├── excel-addin/          # Manifest file
│   └── manifest-claude.xml
└── DOCUMENTATION.md      # Main documentation
```

## Architecture

```
Excel Add-in → GitHub Pages (static files) → Cloudflare Worker (proxy) 
    → Cloudflare Tunnel → Flask Backend → NetSuite REST API
```

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

*Current Version: 3.0.5.193*
