# Microsoft Best Practices Compliance - Fixes Applied

## Overview
Fixed critical issues causing "error installing functions" in Excel by aligning with Microsoft's documented best practices for custom functions with SharedRuntime.

## Critical Fixes Applied

### 1. CustomFunctions Registration Timing ⚠️ CRITICAL
**Issue:** Functions were registered immediately when `CustomFunctions` was available, before `Office.onReady()` completed.

**Microsoft Requirement:** `CustomFunctions.associate()` MUST be called AFTER `Office.onReady()` completes.

**Fix Applied:**
- Wrapped registration in `Office.onReady()` callback
- Added fallback polling mechanism if Office.js loads after functions.js
- Added timeout protection (5 seconds max wait)

**Code Location:** `docs/functions.js` lines 6022-6090

### 2. Parameter Order Violation ⚠️ CRITICAL
**Issue:** BALANCEBETA had optional parameter (`fromPeriod`) before required parameter (`toPeriod`) in metadata.

**Microsoft Requirement:** All required parameters MUST come before any optional parameters in `functions.json`.

**Fix Applied:**
- Reordered BALANCEBETA parameters in `functions.json`: `account, toPeriod, fromPeriod, ...`
- Updated JavaScript function signature to match: `BALANCEBETA(account, toPeriod, fromPeriod, ...)`
- Updated JSDoc comments to match new order

**Files Changed:**
- `docs/functions.json` - Parameter order fixed
- `docs/functions.js` - Function signature and JSDoc updated

**⚠️ MAC-SPECIFIC WARNING:** After fixing parameter order, Mac Excel may crash on startup due to cached metadata. Use `remove-office-keep-edge.sh` to reset Office caches. See [MAC_PARAMETER_ORDER_ISSUE.md](MAC_PARAMETER_ORDER_ISSUE.md) for details.

### 3. Unsupported Metadata Fields
**Issue:** `functions.json` contained `_copyright` and `helpUrl` fields not in Microsoft's schema.

**Microsoft Requirement:** Only fields defined in the Custom Functions metadata schema are allowed.

**Fix Applied:**
- Removed `_copyright` field from root
- Removed all `helpUrl` fields from function definitions

**File Changed:** `docs/functions.json`

### 4. Version Bump for Cache Busting
**Updated:** Version 4.0.0.4 → 4.0.0.5
- Manifest version
- All cache-busting query parameters (`?v=4.0.0.5`)
- FUNCTIONS_VERSION constant

## Architecture Review

### SharedRuntime vs Taskpane (Microsoft Recommended Pattern) ✅

**Current Implementation (CORRECT):**
```
┌─────────────────────────────────────┐
│  sharedruntime.html                 │
│  - Loads Office.js                  │
│  - Loads functions.js              │
│  - Hosts custom functions           │
│  - Hosts ExecuteFunction commands   │
│  - NO UI (blank page)               │
└─────────────────────────────────────┘
              │
              │ Shared context
              │
┌─────────────────────────────────────┐
│  taskpane.html                      │
│  - Loads Office.js                  │
│  - Full UI                          │
│  - Can access functions.js via      │
│    shared runtime context           │
└─────────────────────────────────────┘
```

**Manifest Configuration:**
- ✅ `<Runtime>` points to `sharedruntime.html`
- ✅ CustomFunctions `<Page>` points to `sharedruntime.html`
- ✅ CustomFunctions `<Script>` points to `functions.js`
- ✅ CustomFunctions `<Metadata>` points to `functions.json`
- ✅ Taskpane uses separate `taskpane.html`

This matches Microsoft's recommended pattern for SharedRuntime with custom functions.

### Request Flow (End-to-End)

```
Excel Cell Formula
    ↓
Custom Function Call (BALANCE, etc.)
    ↓
functions.js (in sharedruntime.html context)
    ↓
Batch Queue (intelligent batching)
    ↓
API Call: fetch(SERVER_URL + '/balance?...')
    ↓
Cloudflare Worker (netsuite-proxy.chris-corcoran.workers.dev)
    ↓
Cloudflare Tunnel (trycloudflare.com)
    ↓
.NET Backend (localhost:5002)
    ↓
NetSuite API (SuiteQL queries)
    ↓
Response flows back through same path
    ↓
Promise resolves in functions.js
    ↓
Excel cell updates with value
```

## Testing Checklist

- [x] functions.json is valid JSON
- [x] Parameter order: required before optional
- [x] Registration waits for Office.onReady()
- [x] No unsupported metadata fields
- [x] Version bumped for cache busting
- [x] Manifest updated in wef folder
- [x] Changes committed and pushed to Git

## Next Steps

1. **Wait 1-2 minutes** for GitHub Pages to deploy v4.0.0.5
2. **Reload add-in in Excel:**
   - Remove old add-in
   - Add fresh (will load v4.0.0.5)
3. **Test function installation:**
   - Should no longer show "error installing functions"
   - Functions should register successfully
4. **Test a function:**
   - `=XAVI.BALANCE("4220", "Jan 2025", "Jan 2025")`
   - Should work without #NOVALUE

## References

- Microsoft: Custom Functions with SharedRuntime
- Microsoft: Custom Functions metadata schema
- Microsoft: Office.onReady() best practices

