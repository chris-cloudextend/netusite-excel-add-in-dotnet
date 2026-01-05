# Deployment Steps - Book Change and Validation Fixes

## Step 1: Restart the Backend Server
The backend has new endpoints (`/lookups/cache/status`) that need to be running.

```bash
bash excel-addin/useful-commands/start-dotnet-server.sh
```

**Wait for**: Server to show "✅ Server is healthy and responding!"

---

## Step 2: Verify Version Numbers
All version numbers should be **4.0.6.92**:

- ✅ `docs/functions.js` - `FUNCTIONS_VERSION = '4.0.6.92'`
- ✅ `docs/taskpane.html` - Script src: `?v=4.0.6.92`
- ✅ `excel-addin/manifest.xml` - `<Version>4.0.6.92</Version>` and all `?v=4.0.6.92` params

**Check**: All files already updated to 4.0.6.92

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
git commit -m "Fix book change modal: add cache timeout, validate book-subsidiary combinations, show alerts for invalid selections"

# Push to remote
git push
```

---

## Step 4: Clear Excel Cache (For Testing)
After pushing, users need to clear Excel's cache to load the new version:

**Option A: Clear via Excel**
1. Close Excel completely
2. Reopen Excel
3. Reload the add-in

**Option B: Clear via Browser Cache (if using web version)**
1. Hard refresh: `Cmd+Shift+R` (Mac) or `Ctrl+Shift+R` (Windows)
2. Or clear browser cache for the add-in domain

**Option C: Force Reload (Recommended)**
1. In Excel, go to Insert > My Add-ins
2. Remove the add-in
3. Re-add it from the manifest URL

---

## Step 5: Test the Changes

### Test 1: Cache Timeout Fix
1. Change U3 from book 1 to book 2
2. Watch console for proof messages:
   - `✅✅✅ CACHE READY - Breaking loop immediately`
   - `✅✅✅ PROOF: Overlay removed immediately after cache ready`
   - `✅✅✅ PROOF: About to show subsidiary selection modal NOW`
3. Verify overlay closes and modal appears (typically 5-30 seconds)

### Test 2: Invalid Combination Alert
1. Set U3 to book 2
2. Select valid subsidiary from modal
3. Manually change Q3 to invalid subsidiary (e.g., "Celigo Europe B.V.")
4. Verify red alert appears in task pane
5. Verify toast notification appears

---

## Summary Checklist

- [ ] Step 1: Restart backend server
- [ ] Step 2: Verify version numbers (already done - 4.0.6.92)
- [ ] Step 3: Push to Git
- [ ] Step 4: Clear Excel cache (for testing)
- [ ] Step 5: Test both fixes

---

## Quick Command Reference

```bash
# Restart server
bash excel-addin/useful-commands/start-dotnet-server.sh

# Push to git
cd /Users/chriscorcoran/Documents/Cursor/NetSuite-Excel-AddIn-DotNet
git add .
git commit -m "Fix book change modal: add cache timeout, validate book-subsidiary combinations, show alerts for invalid selections"
git push
```

