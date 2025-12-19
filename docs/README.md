# XAVI for NetSuite - Excel Add-in Files

This folder contains the Excel Add-in files hosted via GitHub Pages.

## Files

| File | Purpose |
|------|---------|
| `taskpane.html` | Main task pane UI + all drill-down logic |
| `functions.js` | Custom function implementations + caching |
| `functions.json` | Function metadata for Excel |
| `functions.html` | Functions runtime page (legacy) |
| `sharedruntime.html` | Blank shared runtime page (no UI) |
| `index.html` | Landing page |
| `icon-*.png` | Add-in icons (16, 32, 64, 80px) |

## Custom Functions

| Function | Description |
|----------|-------------|
| `XAVI.BALANCE` | Get GL account balance |
| `XAVI.TYPEBALANCE` | Get total for account type (Income, Expense, etc.) |
| `XAVI.BUDGET` | Get budget amount |
| `XAVI.NAME` | Get account name |
| `XAVI.TYPE` | Get account type |
| `XAVI.PARENT` | Get parent account |
| `XAVI.RETAINEDEARNINGS` | Calculate Retained Earnings |
| `XAVI.NETINCOME` | Calculate Net Income |
| `XAVI.CTA` | Calculate CTA (multi-currency) |

## Drill-Down Functionality

Users can drill down into any balance to see underlying transactions:

- **XAVI.BALANCE** → Shows individual transactions
- **XAVI.TYPEBALANCE** → Shows accounts with balances, then drill into transactions

**Recommended Method:** Use the Quick Actions "Drill Down" button in the taskpane (works on both Mac and Windows).

> ⚠️ **Note:** The right-click context menu has platform limitations on Mac. Use Quick Actions instead.

## Architecture

The add-in uses Office's **Shared Runtime**:

```
┌────────────────────────────────────────┐
│           SHARED RUNTIME               │
├────────────────────────────────────────┤
│  taskpane.html    │   functions.js     │
│  (UI + Logic)     │   (Custom Funcs)   │
├────────────────────────────────────────┤
│  sharedruntime.html (blank - commands) │
└────────────────────────────────────────┘
```

- `sharedruntime.html` is intentionally blank to prevent duplicate UI on Mac

## Backend Connection

Functions connect to a Flask backend via Cloudflare tunnel. The backend handles:
- NetSuite OAuth 1.0 authentication
- SuiteQL query execution
- Multi-currency consolidation via `BUILTIN.CONSOLIDATE`

## Deployment

Files are served from GitHub Pages. After pushing changes:
1. Wait ~1 minute for GitHub Pages to deploy
2. Bump manifest version for cache-busting
3. Reload the add-in in Excel

---

*Current Version: 3.0.5.193*
