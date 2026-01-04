# Force GitHub Pages Deployment

## Issue
GitHub Pages last deployed 3 hours ago but is still serving old version (4.0.6.59) instead of new version (4.0.6.65).

## Solution: Force Redeploy

### Option 1: Manual Trigger via GitHub UI
1. Go to: https://github.com/chris-cloudextend/netusite-excel-add-in-dotnet/actions
2. Find "pages build and deployment" workflow
3. Click "Run workflow" button (if available)
4. Select branch: `main`
5. Click "Run workflow"
6. Wait 2-5 minutes

### Option 2: Make a Commit to Trigger Deployment
Since GitHub Pages auto-deploys on commits to the configured branch, make a small change:

```bash
# Add a comment to trigger deployment
echo "# Last updated: $(date)" >> docs/README.md" >> docs/README.md || echo "<!-- Updated $(date) -->" >> docs/index.html || echo " " >> README.md

git add -A
git commit -m "Trigger GitHub Pages redeploy - $(date +%Y-%m-%d)"
git push origin main
```

### Option 3: Check if Files Are Actually Pushed
Verify the files are in the remote repository:

```bash
# Check what's actually on GitHub
git fetch origin
git log origin/main --oneline -5
git show origin/main:docs/functions.js | grep FUNCTIONS_VERSION
```

If `origin/main` shows version 4.0.6.59, then the new code hasn't been pushed yet.

### Option 4: Unpublish and Republish
1. Go to: https://github.com/chris-cloudextend/netusite-excel-add-in-dotnet/settings/pages
2. Click "Unpublish site"
3. Wait 10 seconds
4. Change source back to "Deploy from a branch"
5. Select branch: `main`, folder: `/docs`
6. Click "Save"
7. Wait 2-5 minutes for deployment

## Verification
After deployment, check:
- https://chris-cloudextend.github.io/netusite-excel-add-in-dotnet/functions.js
- Search for `FUNCTIONS_VERSION` - should show `4.0.6.65`

## Current Status
- ✅ Local `docs/functions.js`: version 4.0.6.65
- ✅ GitHub Pages config: main branch, /docs folder
- ❌ GitHub Pages deployed: version 4.0.6.59 (3 hours ago)
- ❓ Need to verify: Are changes pushed to origin/main?

