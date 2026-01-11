# Deployment Steps - Book-Subsidiary Cache & Modal Fixes

## ✅ Changes Made

1. **Fixed first-load modal issue** - Modal no longer appears on first CFO Flash Report load
2. **Updated modal text** - More generic message about positioning cursor
3. **Added cache status to settings** - Expandable section showing cache status
4. **Added rebuild cache option** - Button to rebuild book-subsidiary cache
5. **NetSuite non-OneWorld research** - Documented behavior for non-OneWorld accounts

---

## Step 1: Update Version Numbers

**Current version**: 4.0.6.94

**New version**: 4.0.6.95

Update these files:
- `docs/functions.js` - `FUNCTIONS_VERSION = '4.0.6.95'`
- `docs/taskpane.html` - Script src: `?v=4.0.6.95`
- `excel-addin/manifest.xml` - `<Version>4.0.6.95</Version>` and all `?v=4.0.6.95` params
- `docs/sharedruntime.html` - Script src: `?v=4.0.6.95`
- `docs/functions.html` - Script src: `?v=4.0.6.95`

---

## Step 2: Restart Backend Server

**Required**: Backend code was modified (new rebuild endpoint, ClearBookSubsidiaryCacheAsync method)

```bash
cd /Users/chriscorcoran/Documents/Cursor/NetSuite-Excel-AddIn-DotNet
bash excel-addin/useful-commands/start-dotnet-server.sh
```

**Wait for**: Server to show "✅ Server is healthy and responding!"

**Verify**: Check that the new endpoint exists:
```bash
curl -s http://localhost:5002/lookups/cache/status | jq .
```

Should return:
```json
{
  "ready": true,
  "message": "Cache is ready",
  "timestamp": "..."
}
```

---

## Step 3: Commit and Push to Git

```bash
cd /Users/chriscorcoran/Documents/Cursor/NetSuite-Excel-AddIn-DotNet

# Check what files changed
git status

# Add all changes
git add .

# Commit with descriptive message
git commit -m "Fix first-load modal, update modal text, add cache status/rebuild to settings, research non-OneWorld accounts

- Fix: Modal no longer appears on first CFO Flash Report load
- Update: Modal text now more generic about cursor positioning
- Add: Cache status display in settings with expandable chevron
- Add: Rebuild cache button in settings
- Add: Backend endpoint /lookups/accountingbook/rebuild-cache
- Add: ClearBookSubsidiaryCacheAsync method in LookupService
- Research: Documented NetSuite non-OneWorld account behavior"

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

### Test 1: First Load (No Modal)
1. Load CFO Flash Report for first time with default book (Book 1)
2. **Expected**: No subsidiary selection modal appears
3. **Expected**: Only dropdown is filtered

### Test 2: Book Change (Modal Appears)
1. Change U3 from book 1 to book 2
2. **Expected**: Progress overlay appears briefly
3. **Expected**: Subsidiary selection modal appears
4. **Expected**: Modal text says "position your cursor in the cell containing your subsidiary"
5. Select subsidiary
6. **Expected**: Formulas update correctly

### Test 3: Cache Status in Settings
1. Open Settings (⚙️ icon)
2. Scroll to "Cache Status" section
3. **Expected**: See "Book-Subsidiary Relationships Cache" section with chevron (▶)
4. Click to expand
5. **Expected**: See cache status (Ready/Building/Error)
6. **Expected**: See cache file status and book count
7. **Expected**: See "Rebuild Cache" button

### Test 4: Rebuild Cache
1. In Settings, expand "Book-Subsidiary Relationships Cache"
2. Click "Rebuild Cache" button
3. **Expected**: Confirmation dialog appears
4. Click OK
5. **Expected**: Status shows "Rebuilding..."
6. **Expected**: After 30-60 seconds, status shows "Ready ✓"
7. **Expected**: Cache file status and book count update

---

## Summary Checklist

- [ ] Step 1: Update version numbers to 4.0.6.95
- [ ] Step 2: Restart backend server
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
git commit -m "Fix first-load modal, update modal text, add cache status/rebuild to settings"
git push
```

---

## Files Modified

**Frontend:**
- `docs/taskpane.html` - Fixed modal logic, updated text, added cache status UI

**Backend:**
- `backend-dotnet/Controllers/LookupController.cs` - Added rebuild endpoint
- `backend-dotnet/Services/LookupService.cs` - Added ClearBookSubsidiaryCacheAsync method

**Documentation:**
- `NETSUITE_NON_ONEWORLD_RESEARCH.md` - Research document (new file)

---

## Notes

- **Server restart is required** because backend code was modified
- **Version bump is recommended** to force Excel to load new frontend code
- **Cache rebuild** may take 30-60 seconds depending on NetSuite data size
- **First load fix** uses localStorage flag to prevent modal on initialization
