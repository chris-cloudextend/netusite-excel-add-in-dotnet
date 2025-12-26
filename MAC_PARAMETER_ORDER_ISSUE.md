# Mac Excel Parameter Order Issue - Critical Development Warning

## ⚠️ CRITICAL: Do Not Change Function Parameter Order After Deployment

**Issue:** On Mac Excel, changing the parameter order of a custom function after it has been registered and used will cause Excel to crash on startup. This is a **Mac-specific bug** in Excel's custom function metadata caching system.

## The Problem

When you define a custom function in Excel, Mac Excel caches the function's parameter metadata aggressively. This cache includes:
- Parameter names
- Parameter order
- Parameter types
- Optional/required flags

**If you change the parameter order after a function has been used**, Mac Excel will:
1. Load the old cached metadata
2. Try to map parameters to the new function signature
3. **Crash on startup** when the mapping fails

### Example Scenario

**Initial Function Definition:**
```javascript
// functions.json
{
  "parameters": [
    { "name": "account", "type": "any" },
    { "name": "fromPeriod", "type": "any" },
    { "name": "toPeriod", "type": "any" }
  ]
}
```

**After Changing Parameter Order:**
```javascript
// functions.json - WRONG! This will crash Mac Excel
{
  "parameters": [
    { "name": "account", "type": "any" },
    { "name": "toPeriod", "type": "any" },      // ← Moved before fromPeriod
    { "name": "fromPeriod", "type": "any" }
  ]
}
```

**Result:** Mac Excel crashes on startup. Windows Excel may work fine (it handles this better).

## Why This Happens

Mac Excel stores custom function metadata in:
- `~/Library/Containers/com.microsoft.Excel/Data/Documents/wef/`
- `~/Library/Group Containers/UBF8T346G9.Office/wef/`

These caches persist even after:
- Updating the manifest version
- Clearing browser caches
- Reloading the add-in
- Restarting Excel

The cache is tied to the function's **name** and **namespace**, not the version. So even with cache-busting query parameters, the parameter metadata cache persists.

## The Solution: Nuclear Option

**The only reliable fix is to completely remove Office and all its caches, then reinstall.**

### Use the Provided Script

We provide `remove-office-keep-edge.sh` for this exact scenario:

```bash
./remove-office-keep-edge.sh
```

This script:
1. ✅ Removes all Office applications (Excel, Word, PowerPoint, etc.)
2. ✅ Removes ALL Office caches, preferences, and metadata
3. ✅ Removes custom function metadata caches
4. ✅ **Preserves Microsoft Edge** (so you don't lose your browser)
5. ✅ Preserves your Excel files (they're in Documents, not removed)

### After Running the Script

1. **Restart your Mac** (recommended to clear any in-memory caches)
2. **Reinstall Microsoft Office** from office.com or App Store
3. **Sign in** with your Microsoft account
4. **Reinstall the XAVI add-in** with the corrected parameter order

## Prevention: Best Practices

### 1. Plan Parameter Order Carefully

**Before deploying a function, finalize the parameter order.** Consider:
- Which parameters are required vs optional?
- What's the most intuitive order for users?
- Will you need to add parameters later? (Add them at the end!)

### 2. Use Version Bumps for New Functions, Not Parameter Changes

If you need to change parameter order:
- **Option A (Recommended):** Create a new function with a new name (e.g., `BALANCE2`)
- **Option B:** Only change parameter order in a major version that requires reinstallation

### 3. Test Parameter Order Changes on Windows First

Windows Excel handles parameter order changes better. Test there first, but **don't assume Mac will work the same way**.

### 4. Document Parameter Order Decisions

Add comments in `functions.json` explaining why parameters are in a specific order:

```json
{
  "id": "BALANCECURRENCY",
  "name": "BALANCECURRENCY",
  "description": "Get balance with explicit currency control",
  "parameters": [
    {
      "name": "account",
      "description": "Account number (required first - most important parameter)"
    },
    {
      "name": "fromPeriod",
      "description": "Starting period (required second - time range start)"
    },
    {
      "name": "toPeriod",
      "description": "Ending period (required third - time range end)"
    },
    {
      "name": "subsidiary",
      "description": "Subsidiary filter (optional fourth - entity filter)"
    },
    {
      "name": "currency",
      "description": "Currency code (optional fifth - CRITICAL: position 5, not 4!)"
    }
    // NOTE: Currency is in position 5 (after subsidiary) to match BALANCE parameter pattern
    // DO NOT CHANGE THIS ORDER - Mac Excel will crash if parameter order changes after deployment
  ]
}
```

## Known Workarounds That DON'T Work

These approaches **will NOT fix** the Mac crash:

❌ **Updating manifest version** - Parameter metadata cache is independent of version  
❌ **Clearing browser cache** - Excel uses its own cache, not browser cache  
❌ **Reloading the add-in** - Cache persists across reloads  
❌ **Restarting Excel** - Cache is on disk, not in memory  
❌ **Deleting just the wef folder** - Other Office caches also store metadata  
❌ **Using a different manifest name** - Cache is tied to function name, not manifest  

## When to Use the Nuclear Option

Use `remove-office-keep-edge.sh` when:
- ✅ Excel crashes on startup after changing function parameter order
- ✅ Excel shows "We can't start this add-in" errors after parameter changes
- ✅ Custom functions appear with wrong parameter order in Excel's function wizard
- ✅ You've tried all other fixes and nothing works

**Do NOT use this script for:**
- ❌ Regular add-in updates (use version bumps instead)
- ❌ Adding new functions (safe, doesn't affect existing functions)
- ❌ Changing function logic (safe, doesn't affect parameter metadata)
- ❌ Windows Excel issues (Windows handles parameter changes better)

## Technical Details

### Cache Locations

Mac Excel stores custom function metadata in:

```
~/Library/Containers/com.microsoft.Excel/Data/Documents/wef/
  └── manifest-claude.xml (or your manifest name)
  └── [cached function metadata]

~/Library/Group Containers/UBF8T346G9.Office/wef/
  └── [shared Office add-in cache]
```

### Why Edge is Preserved

Microsoft Edge is a separate application with its own container:
- `~/Library/Containers/com.microsoft.edgemac/`

The script intentionally preserves Edge so you don't lose:
- Browser bookmarks
- Browser settings
- Browser extensions
- Browser history

Edge is not part of the Office suite and doesn't share Excel's custom function cache.

## Related Issues

This Mac-specific issue is related to:
- [Microsoft Best Practices Fixes](MICROSOFT_BEST_PRACTICES_FIXES.md) - Parameter order requirements
- [Developer Checklist](DEVELOPER_CHECKLIST.md) - Function registration guidelines
- [Function Parameters Reference](FUNCTION_PARAMETERS_REFERENCE.md) - Current parameter orders (DO NOT CHANGE)

## Summary

**Golden Rule:** Once a function's parameter order is deployed and used, **never change it**. If you must change it, use the nuclear option (`remove-office-keep-edge.sh`) to completely reset Office's cache.

---

**Last Updated:** 2025-12-25  
**Affected Platforms:** Mac Excel only  
**Workaround:** `remove-office-keep-edge.sh` script

