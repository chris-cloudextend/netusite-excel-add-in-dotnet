# Manual Push Instructions

## Current Situation
- ✅ Local `docs/functions.js` has version **4.0.6.65**
- ❌ GitHub Pages is still serving version **4.0.6.59**
- ❌ No new workflow run has appeared (still showing #529 from 3 hours ago)

## Problem
The changes haven't been pushed to GitHub yet, so GitHub Pages can't deploy the new version.

## Solution: Run This Script

I've created a script that will push the changes. Run it:

```bash
cd /Users/chriscorcoran/Documents/Cursor/NetSuite-Excel-AddIn-DotNet
./PUSH_AND_DEPLOY.sh
```

## Alternative: Manual Steps

If the script doesn't work, do this manually:

```bash
cd /Users/chriscorcoran/Documents/Cursor/NetSuite-Excel-AddIn-DotNet

# 1. Check what needs to be committed
git status

# 2. Verify the version in functions.js
grep "FUNCTIONS_VERSION" docs/functions.js

# 3. Stage all changes
git add -A

# 4. Commit
git commit -m "Force GitHub Pages redeploy - version 4.0.6.65"

# 5. Push to main
git push origin main
```

## After Pushing

1. **Wait 30-60 seconds**, then check: https://github.com/chris-cloudextend/netusite-excel-add-in-dotnet/actions
   - You should see a new workflow run (#530 or higher)
   - Wait for it to complete (green checkmark, ~30-40 seconds)

2. **Wait 2-3 minutes total** for GitHub Pages to update

3. **Verify the new version**:
   - Go to: https://chris-cloudextend.github.io/netusite-excel-add-in-dotnet/functions.js
   - Search for `FUNCTIONS_VERSION`
   - Should show: `const FUNCTIONS_VERSION = '4.0.6.65';`

## If Push Fails

If you get authentication errors:
1. Check if you're logged into GitHub: `gh auth status`
2. Or use HTTPS with a personal access token
3. Or push via GitHub Desktop if you have it installed

## Verification

After deployment, you can verify with:
```bash
curl -s "https://chris-cloudextend.github.io/netusite-excel-add-in-dotnet/functions.js" | grep "FUNCTIONS_VERSION"
```

Should output: `const FUNCTIONS_VERSION = '4.0.6.65';`

