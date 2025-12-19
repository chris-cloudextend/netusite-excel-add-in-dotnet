# XAVI Developer Checklist

**Purpose:** This checklist ensures all integration points are updated when adding or modifying formulas/features.

---

## ⚠️ CRITICAL: Universal NetSuite Compatibility

**All code MUST work across ALL NetSuite accounts.** Never make assumptions about:

| ❌ DON'T Assume | ✅ DO Instead |
|-----------------|---------------|
| Account number prefixes indicate type (1xxx=BS, 4xxx=P&L) | Query NetSuite for actual `accttype` field |
| Specific account numbers exist | Use wildcards or let users specify |
| Subsidiary structure (OneWorld vs non-OneWorld) | Use `BUILTIN.CONSOLIDATE` which works universally |
| Chart of accounts numbering scheme | Query account metadata from NetSuite |
| Fiscal year starts in January | Query `get_fiscal_year_for_period()` |
| Currency is USD | Use subsidiary's currency or consolidate |
| Specific period names exist | Validate periods exist before querying |

### Examples of Universal vs Non-Universal Code:

```python
# ❌ BAD - Assumes account prefix indicates type
if account.startswith('1') or account.startswith('2'):
    is_bs_account = True

# ✅ GOOD - Queries actual account type from NetSuite
type_result = query_netsuite("SELECT accttype FROM Account WHERE acctnumber = '...'")
is_bs_account = is_balance_sheet_account(type_result['accttype'])
```

```python
# ❌ BAD - Assumes fiscal year starts January 1
fy_start = f"Jan {year}"

# ✅ GOOD - Queries actual fiscal year boundaries
fy_info = get_fiscal_year_for_period(period_name, accounting_book)
fy_start = fy_info['fy_start']
```

---

## 🏗️ Architecture Overview

### Shared Runtime Configuration

The add-in uses Office's **Shared Runtime** where all components share a single JavaScript context:

```
┌─────────────────────────────────────────────────────────┐
│                   SHARED RUNTIME                        │
│                                                         │
│  ┌─────────────────┐  ┌─────────────────┐              │
│  │ taskpane.html   │  │ functions.js    │              │
│  │ (UI + Logic)    │  │ (Custom Funcs)  │              │
│  └─────────────────┘  └─────────────────┘              │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │ sharedruntime.html (blank - hosts commands)     │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

**Key Files:**
- `docs/taskpane.html` - Main UI and all drill-down logic
- `docs/functions.js` - Custom function implementations
- `docs/sharedruntime.html` - Blank page for shared runtime (no UI)

### Known Platform Issues

#### Right-Click Context Menu on Mac

⚠️ **The right-click "View Transactions" context menu has Mac platform limitations:**

- On Mac, `ExecuteFunction` commands can cause a "Developer Window" to open
- This is a known Office for Mac WebView handling issue, not a code bug
- The code is kept for Windows compatibility where it may work better

**Recommended Workaround:** Use the Quick Actions "Drill Down" button in the taskpane instead of right-click. This works reliably on both Mac and Windows.

**Current Implementation:**
1. `sharedruntime.html` hosts the `drillDownFromContextMenu` function
2. When triggered, it stores the cell context in `localStorage`
3. It then calls `Office.addin.showAsTaskpane()` to show the taskpane
4. `taskpane.html` polls `localStorage` for pending drill-down requests
5. When found, it executes the drill-down with full UI feedback

---

## 🔧 Adding or Modifying a Formula

### 1. Frontend - Function Implementation
| File | Location | What to Update |
|------|----------|----------------|
| `docs/functions.js` | Function definition | Core logic, parameters, return values |
| `docs/functions.js` | `convertToMonthYear()` | If new date handling needed |
| `docs/functions.js` | Cache logic | Cache key format, localStorage keys |
| `docs/functions.js` | `__CLEARCACHE__` handler | If formula has special cache needs |
| `docs/functions.js` | Build mode | If formula should batch with others |

### 2. Frontend - Excel Registration ⚠️ CRITICAL
| File | Location | What to Update |
|------|----------|----------------|
| `docs/functions.json` | Function entry | `id`, `name`, `description` |
| `docs/functions.json` | Parameters array | Names, descriptions, types, optional flags |
| `docs/functions.json` | Options | `stream`, `cancelable`, `volatile` settings |
| `docs/functions.js` | **`CustomFunctions.associate()`** | **MUST add function binding (~line 5280)** |

> ⚠️ **CRITICAL #1**: Missing `CustomFunctions.associate('FUNCTIONNAME', FUNCTIONNAME)` will cause  
> the entire add-in to fail with "We can't start this add-in because it isn't set up properly."

> ⚠️ **CRITICAL #2**: **Optional parameters MUST come AFTER required parameters!**  
> Excel will silently fail to load the add-in if an `optional: true` parameter appears before a required one.  
> If you need a "skippable" parameter in the middle, mark ALL subsequent parameters as `optional: true`  
> and validate required values in JavaScript instead.

### 3. Frontend - Taskpane Integration
| File | Location | What to Update |
|------|----------|----------------|
| `docs/taskpane.html` | `refreshSelected()` | Add formula type detection |
| `docs/taskpane.html` | `refreshCurrentSheet()` | If formula needs special handling |
| `docs/taskpane.html` | `recalculateSpecialFormulas()` | For RE/NI/CTA type formulas |
| `docs/taskpane.html` | `clearCache()` | If new localStorage keys used |
| `docs/taskpane.html` | UI buttons | If new action buttons needed |
| `docs/taskpane.html` | Tooltips/help text | User-facing descriptions |
| `docs/taskpane.html` | Error messages | Toast notifications, status messages |

### 4. Backend - Server Implementation
| File | Location | What to Update |
|------|----------|----------------|
| `backend/server.py` | New `@app.route` | API endpoint for the formula |
| `backend/server.py` | Query logic | SuiteQL query construction |
| `backend/server.py` | Default handling | `default_subsidiary_id` usage |
| `backend/server.py` | Consolidation | `get_subsidiaries_in_hierarchy()` if needed |
| `backend/server.py` | Name-to-ID conversion | `convert_name_to_id()` for filters |
| `backend/server.py` | Response format | JSON structure returned |

### 5. Manifest & Versioning ⚠️ CRITICAL
| File | Location | What to Update |
|------|----------|----------------|
| `excel-addin/manifest-claude.xml` | `<Version>` tag | Main version (line ~32) |
| `excel-addin/manifest-claude.xml` | ALL `?v=X.X.X.X` URLs | Cache-busting parameters |
| `docs/taskpane.html` | Footer version | Hardcoded display (~line 3960) |
| `docs/sharedruntime.html` | functions.js URL | Cache-busting parameter |
| `docs/functions.js` | `FUNCTIONS_VERSION` constant | Version marker for debugging |

### Mac Manifest Sideload Location ⚠️ IMPORTANT

**The correct manifest sideload location on Mac (Microsoft 365) is:**

```
~/Library/Containers/com.microsoft.Excel/Data/Documents/wef/
```

**NOT the old locations:**
- ❌ `~/Library/Group Containers/UBF8T346G9.Office/User Content.localized/Wef/`
- ❌ `~/Library/Group Containers/UBF8T346G9.Office/User Content/Wef/`

**To clear cache and reinstall manifest:**
```bash
# Clear manifest folder
rm -rf ~/Library/Containers/com.microsoft.Excel/Data/Documents/wef/*

# Copy manifest
cp excel-addin/manifest-claude.xml ~/Library/Containers/com.microsoft.Excel/Data/Documents/wef/

# If add-in behaves strangely (old App ID cached), also clear:
rm -rf ~/Library/Containers/com.microsoft.Excel/Data/Library/Application\ Support/Microsoft/Office/16.0/Wef/CustomFunctions
rm -rf ~/Library/Containers/com.microsoft.Excel/Data/Library/Application\ Support/Microsoft/Office/16.0/Wef/AppCommands
```

> ⚠️ **CRITICAL SHARED RUNTIME CONFIGURATION:**  
> - `<Runtime resid>` points to `SharedRuntime.Url` (`sharedruntime.html`)
> - CustomFunctions `<Page>` also uses `SharedRuntime.Url`
> - `<FunctionFile>` uses `SharedRuntime.Url` for ExecuteFunction commands
> - `taskpane.html` MUST include `<script src="functions.js">` tag
> - `sharedruntime.html` is BLANK (no visible UI) to prevent duplicate taskpanes on Mac

### 6. Documentation
| File | What to Update |
|------|----------------|
| `README.md` | Version number, feature list, known issues |
| `docs/README.md` | Version number |
| `docs/USER_GUIDE_TYPEBALANCE.md` | TYPEBALANCE usage, account types |
| `docs/SPECIAL_ACCOUNT_TYPES.md` | Special account type reference |
| `QA_TEST_PLAN.md` | Test cases for new feature |
| `DOCUMENTATION.md` | Version history |

---

## 🏷️ Account Type vs Special Account Type (TYPEBALANCE)

When building formulas that filter by account classification, understand the difference:

### Account Type (`accttype` field)
Standard financial categories for financial statements:
- `Bank`, `AcctRec`, `OthCurrAsset`, `FixedAsset`, `OthAsset`
- `AcctPay`, `CredCard`, `OthCurrLiab`, `LongTermLiab`
- `Equity`, `RetainedEarnings`
- `Income`, `COGS`, `Expense`, `OthIncome`, `OthExpense`

**Use for:** Financial reporting, summarizing by category, Balance Sheet/P&L totals

### Special Account Type (`sspecacct` field)
System-assigned tags for accounts with special internal roles:
- `AcctRec`, `AcctPay` - AR/AP control accounts
- `InvtAsset` - Inventory asset account
- `UndepFunds` - Undeposited funds clearing
- `DeferRevenue`, `DeferExpense` - Deferred items
- `RetEarnings`, `CumulTransAdj` - Equity system accounts
- `RealizedERV`, `UnrERV` - FX gain/loss accounts

**Use for:** Identifying system control accounts, troubleshooting posting behavior

---

## 🔍 Drill-Down Implementation

### Two-Level Drill-Down for TYPEBALANCE

1. **Level 1: TYPEBALANCE → Account List**
   - Shows all accounts of that type with balances
   - Creates `DrillDown_<AccountType>` sheet
   - Stores context in hidden cell A3: `DRILLDOWN_CONTEXT:<period>:<subsidiary>`

2. **Level 2: Account Row → Transactions**
   - User selects account row on DrillDown_ sheet
   - Quick Actions bar shows "Account row selected • Drill Down to transactions"
   - Drill button fetches transactions for that account

### Quick Actions Bar Logic

The Quick Actions "Drill Down" button is enabled when:
1. Cell contains `XAVI.BALANCE` formula
2. Cell contains `XAVI.TYPEBALANCE` formula
3. **Cell is on a `DrillDown_` sheet in a data row** (row 6+, not TOTAL)

This allows secondary drill-down even without a formula in the cell.

---

## 🎯 Special Formula Checklist (NETINCOME, RETAINEDEARNINGS, CTA)

These formulas have additional integration points:

- [ ] `functions.js` - Uses `acquireSpecialFormulaLock()` / `releaseSpecialFormulaLock()`
- [ ] `functions.js` - Uses `broadcastToast()` for progress notifications
- [ ] `taskpane.html` - Listed in `recalculateSpecialFormulas()` 
- [ ] `taskpane.html` - Detected in `refreshSelected()` special formulas array
- [ ] `server.py` - Uses `get_fiscal_year_for_period()` for date boundaries
- [ ] `server.py` - Uses `BUILTIN.CONSOLIDATE()` for multi-currency

---

## 📋 Pre-Commit Checklist

Before committing changes:

- [ ] All version numbers synchronized (manifest, taskpane footer, sharedruntime.html)
- [ ] Console logging added for debugging
- [ ] Error handling returns appropriate codes (#ERROR#, #TIMEOUT#, #SYNTAX#)
- [ ] Cache keys are unique and descriptive
- [ ] Backwards compatibility maintained (or breaking changes documented)
- [ ] Git commit message includes version number

---

## 🔄 When to Update This Checklist

Update this file when:
1. New integration points are discovered
2. Architecture changes (new files, restructured code)
3. New formula types are added
4. New caching mechanisms are introduced
5. Platform-specific issues are identified

---

## 📝 Version History

| Date | Version | Changes |
|------|---------|---------|
| 2025-12-15 | 3.0.5.81 | Initial checklist created |
| 2025-12-15 | 3.0.5.90 | Added "Universal NetSuite Compatibility" section |
| 2025-12-15 | 3.0.5.96 | Added CustomFunctions.associate() warning |
| 2025-12-15 | 3.0.5.98 | Added CRITICAL shared runtime configuration notes |
| 2025-12-15 | 3.0.5.107 | Added Account Type vs Special Account Type section |
| 2025-12-17 | 3.0.5.161 | Code cleanup for engineering handoff |
| 2025-12-17 | 3.0.5.193 | Updated architecture docs, added Mac platform issue note |
| 2025-12-19 | 3.0.5.233 | Added correct Mac manifest sideload location, cache clearing commands |

---

*Last updated: December 19, 2025*
