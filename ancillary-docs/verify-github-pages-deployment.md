# Verify GitHub Pages Deployment

## Current Issue
GitHub Pages is serving `functions.js` with version `4.0.6.59` but the code has been updated to `4.0.6.65`.

## Steps to Fix GitHub Pages Configuration

### 1. Check GitHub Pages Settings
Go to: https://github.com/chris-cloudextend/netusite-excel-add-in-dotnet/settings/pages

**Verify:**
- **Source**: Should be set to "Deploy from a branch"
- **Branch**: Should be `main` (or `master` if that's your default)
- **Folder**: Should be `/docs` (NOT `/root`)

### 2. If Settings Are Wrong
1. Change source to "Deploy from a branch"
2. Select branch: `main`
3. Select folder: `/docs`
4. Click "Save"
5. Wait 2-5 minutes for deployment

### 3. Force Redeploy (if needed)
If settings are correct but still showing old version:
1. Go to: https://github.com/chris-cloudextend/netusite-excel-add-in-dotnet/actions
2. Look for "pages build and deployment" workflow
3. If it failed, check the error logs
4. If it succeeded but old version, trigger a redeploy by:
   - Making a small commit (add a space to README.md)
   - Or manually trigger the workflow

### 4. Verify Deployment
After 2-5 minutes, check:
- https://chris-cloudextend.github.io/netusite-excel-add-in-dotnet/functions.js
- Search for `FUNCTIONS_VERSION` - should show `4.0.6.65`

## Alternative: Check if files are in wrong location

If GitHub Pages is configured for `/root` instead of `/docs`:
1. The files need to be in the root directory, not `/docs`
2. OR change GitHub Pages to use `/docs` folder

## Current File Locations
- ✅ `docs/functions.js` - has version 4.0.6.65
- ✅ `docs/taskpane.html` - should have correct version
- ✅ `excel-addin/manifest.xml` - has all URLs at v4.0.6.65

## Next Steps
1. Verify GitHub Pages is set to `/docs` folder
2. Wait 2-5 minutes for deployment
3. Clear browser cache and check again
4. If still old version, check GitHub Actions for deployment errors

