# Final Deployment Steps - Cache Persistence & Book Change Fixes

## ✅ All Issues Fixed

1. **Cache Persistence**: Cache file is now saved to disk and loads instantly on server restart
2. **First Load Modal**: Modal no longer appears on first load (only on actual book changes)
3. **Book 2 → Book 1 Change**: Modal now appears when changing back to Primary Book
4. **transitionKey Scope Error**: Fixed scope issue in error handlers
5. **Overlay Timeout**: Overlay now closes immediately when cache is ready

---

## Step 1: Restart Backend Server

The backend has been updated with cache persistence and deadlock fixes.

```bash
cd /Users/chriscorcoran/Documents/Cursor/NetSuite-Excel-AddIn-DotNet
bash excel-addin/useful-commands/start-dotnet-server.sh
```

**Wait for**: Server to show "✅ Server is healthy and responding!"

**Verify cache**: 
```bash
bash excel-addin/useful-commands/check-cache-status.sh
```

Should show:
- `"ready": true`
- Cache file exists
- Cache loaded from disk (if file exists from previous run)

---

## Step 2: Verify Version Numbers

All version numbers should be **4.0.6.94**:

- ✅ `docs/functions.js` - `FUNCTIONS_VERSION = '4.0.6.94'`
- ✅ `docs/taskpane.html` - Script src: `?v=4.0.6.94`
- ✅ `excel-addin/manifest.xml` - `<Version>4.0.6.94</Version>` and all `?v=4.0.6.94` params
- ✅ `docs/sharedruntime.html` - Script src: `?v=4.0.6.94`
- ✅ `docs/functions.html` - Script src: `?v=4.0.6.94`

---

## Step 3: Push Changes to Git

Commit and push all changes:

```bash
cd /Users/chriscorcoran/Documents/Cursor/NetSuite-Excel-AddIn-DotNet

# Check what files changed
git status

# Add all changes
git add .

# Commit with descriptive message
git commit -m "Fix cache persistence, first-load modal, book 2->1 change, and transitionKey scope errors"

# Push to remote
git push
```

---

## Step 4: Clear Excel Cache (For Testing)

After pushing, users need to clear Excel's cache to load the new version:

**Option A: Force Reload (Recommended)**
1. In Excel: Insert > My Add-ins
2. Remove the add-in
3. Re-add it from the manifest URL

**Option B: Hard Refresh**
1. Close Excel completely
2. Reopen Excel
3. Reload the add-in

---

## Step 5: Test the Changes

### Test 1: Cache Persistence
1. Restart server
2. Check cache status - should show `"ready": true` immediately (cache loads from disk)
3. Change book in Excel - should be instant (no 120-second wait)

### Test 2: First Load (No Modal)
1. Load CFO Flash Report for first time with default book (Book 1)
2. **Expected**: No subsidiary selection modal appears
3. **Expected**: Only dropdown is filtered

### Test 3: Book Change (Modal Appears)
1. Change U3 from book 1 to book 2
2. **Expected**: Progress overlay appears briefly
3. **Expected**: Subsidiary selection modal appears (typically 5-30 seconds, not 120 seconds)
4. Select subsidiary
5. **Expected**: Formulas update correctly

### Test 4: Book 2 → Book 1 Change
1. Change U3 from book 2 back to book 1
2. **Expected**: Subsidiary selection modal appears with ALL subsidiaries
3. Select subsidiary
4. **Expected**: Formulas update correctly

---

## Summary Checklist

- [ ] Step 1: Restart backend server
- [ ] Step 2: Verify version numbers (already done - 4.0.6.94)
- [ ] Step 3: Push to Git
- [ ] Step 4: Clear Excel cache (for testing)
- [ ] Step 5: Test all scenarios

---

## Quick Command Reference

```bash
# Restart server
bash excel-addin/useful-commands/start-dotnet-server.sh

# Check cache status
bash excel-addin/useful-commands/check-cache-status.sh

# Push to git
cd /Users/chriscorcoran/Documents/Cursor/NetSuite-Excel-AddIn-DotNet
git add .
git commit -m "Fix cache persistence, first-load modal, book 2->1 change, and transitionKey scope errors"
git push
```

---

## Cache File Location

The cache file is saved at:
- **Mac**: `~/Library/Application Support/XaviApi/book-subsidiary-cache.json`
- **Windows**: `%AppData%\XaviApi\book-subsidiary-cache.json`

This file persists across server restarts, so the first-time delay (30-60 seconds) only happens once. After that, the cache loads instantly from disk.

---

## What Was Fixed

1. **Cache Persistence**: 
   - Cache is now saved to disk after building
   - Cache loads from disk on server startup
   - Fixed deadlock issue (lock was held when trying to save)

2. **First Load Modal**: 
   - Modal no longer appears on first load
   - Only appears when book actually changes (not on initialization)

3. **Book 2 → Book 1 Change**: 
   - Modal now appears when changing back to Primary Book
   - Shows all subsidiaries (Primary Book allows all)

4. **transitionKey Scope Error**: 
   - Fixed scope issue in error handlers
   - Added null checks before using transitionKey

5. **Overlay Timeout**: 
   - Overlay closes immediately when cache is ready
   - No more 120-second wait if cache is already loaded

