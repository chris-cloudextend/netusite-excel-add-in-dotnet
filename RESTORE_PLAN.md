# Git Restore Plan - Excel Crash Fixes

## Restore Options

### Option 1: Restore to 88aca91 (RECOMMENDED)
**Commit:** `88aca91` - "Bump to 3.0.5.300: XAVI2 namespace with cache busting"  
**Date:** Dec 23, 2025 06:46:29  
**Status:** Before all crash debugging started

**What this restores:**
- Full functions.js (all formulas, not just PING)
- Version 3.0.5.300
- XAVI2 namespace
- Original manifest structure (with `<Script>` element)
- Original sharedruntime.html (loads functions.js)

**What you'll lose:**
- All crash debugging attempts (PING-only mode, idempotent guards, etc.)
- Version 3.0.5.301-3.0.5.305 changes
- Recent documentation files (AGENT_START_GUIDE.md, CHATGPT_SETUP_EXPLANATION.md)

**Files that will be restored:**
- `docs/functions.js` (full version, ~6000 lines)
- `docs/functions.json` (all function definitions)
- `excel-addin/manifest-claude.xml` (version 3.0.5.300)
- `docs/sharedruntime.html` (version 3.0.5.300)
- `docs/taskpane.html` (version 3.0.5.300)

---

### Option 2: Restore to 12c1492
**Commit:** `12c1492` - "docs: Add crash analysis documentation"  
**Date:** Dec 23, 2025 09:08:00  
**Status:** Just before diagnostic PING-only mode

**What this restores:**
- Crash analysis documentation
- Still has diagnostic mode changes

**Not recommended** - still has diagnostic/PING-only changes

---

### Option 3: Restore to c6f3b2e
**Commit:** `c6f3b2e` - "Allow subsidiary itself as consolidation root if currency matches"  
**Date:** Dec 22, 2025 18:25:04  
**Status:** Before BALANCEBETA parameter order change

**What this restores:**
- BALANCEBETA with OLD parameter order: `(account, toPeriod, fromPeriod, ...)`
- Full functions.js with all formulas
- Older version (before XAVI2 namespace change)

**Not recommended** - older than Option 1, has different namespace

---

## Recommended Restore Plan (Option 1: 88aca91)

### Step 1: Check current status
```bash
cd /Users/chriscorcoran/Documents/Cursor/NetSuite-Excel-AddIn-DotNet
git status
```

### Step 2: Restore specific files from commit 88aca91
```bash
# Restore core files
git checkout 88aca91 -- docs/functions.js
git checkout 88aca91 -- docs/functions.json
git checkout 88aca91 -- excel-addin/manifest-claude.xml
git checkout 88aca91 -- docs/sharedruntime.html
git checkout 88aca91 -- docs/taskpane.html
```

### Step 3: Verify restored files
```bash
# Check version
grep "FUNCTIONS_VERSION\|Version>" docs/functions.js excel-addin/manifest-claude.xml | head -5

# Check manifest structure
grep -A 10 "CustomFunctions" excel-addin/manifest-claude.xml
```

### Step 4: Copy manifest to Excel folder
```bash
cp excel-addin/manifest-claude.xml ~/Library/Containers/com.microsoft.Excel/Data/Documents/wef/manifest-claude.xml
```

### Step 5: Commit the restore
```bash
git add docs/functions.js docs/functions.json excel-addin/manifest-claude.xml docs/sharedruntime.html docs/taskpane.html
git commit -m "RESTORE: Revert to 3.0.5.300 (88aca91) - before crash debugging

Restored full functions.js and original manifest structure.
This version was working before diagnostic mode changes."
```

---

## Alternative: Full Branch Restore

If you want to restore ALL files (not just the core ones):

```bash
# Create a backup branch first
git branch backup-before-restore

# Restore entire working directory to 88aca91
git checkout 88aca91 -- .

# Review changes
git status

# Commit if satisfied
git commit -m "RESTORE: Full restore to 3.0.5.300 (88aca91)"
```

---

## What Will Be Restored

### files.js
- **Current:** 69 lines (PING-only diagnostic mode)
- **Restored:** ~6000 lines (full implementation with all formulas)

### manifest-claude.xml
- **Current:** Version 3.0.5.305, has `<Script>` element
- **Restored:** Version 3.0.5.300, has `<Script>` element (same structure, different version)

### sharedruntime.html
- **Current:** Does NOT load functions.js (removed to prevent double-loading)
- **Restored:** Loads functions.js via script tag (original approach)

### functions.json
- **Current:** Only PING function
- **Restored:** All functions (BALANCE, TYPEBALANCE, BUDGET, etc.)

---

## Important Notes

1. **This will restore the FULL functions.js** - not just PING
2. **The manifest structure is the same** - both have `<Script>` element
3. **sharedruntime.html will load functions.js again** - this was the original approach
4. **You'll need to test** if this version works or still crashes
5. **New documentation files will remain** - they won't be affected unless you do a full restore

---

## After Restore

1. **Test in Excel:**
   - Reload Excel
   - Try `=XAVI2.PING()` (if it exists in restored version)
   - Try `=XAVI2.BALANCE(...)` (full function)

2. **If it still crashes:**
   - The issue existed before our debugging
   - May need a different approach

3. **If it works:**
   - The crash was introduced by our debugging changes
   - We can incrementally add back features

---

**Ready to restore?** Confirm which option you want, and I'll execute the restore commands.

