#!/bin/bash
# Push changes and trigger GitHub Pages deployment

set -e  # Exit on error

echo "🔄 Checking git status..."
cd "$(dirname "$0")"

# Show current status
echo ""
echo "Current branch:"
git branch --show-current

echo ""
echo "Uncommitted changes:"
git status --short

echo ""
echo "Local functions.js version:"
grep "FUNCTIONS_VERSION" docs/functions.js | head -1

echo ""
echo "---"
echo ""

# Check if there are uncommitted changes
if [ -n "$(git status --porcelain)" ]; then
    echo "📝 Staging all changes..."
    git add -A
    
    echo "💾 Committing changes..."
    git commit -m "CRITICAL: Force GitHub Pages redeploy - version 4.0.6.167 - $(date +%Y-%m-%d\ %H:%M:%S)"
else
    echo "⚠️  No uncommitted changes found."
    echo "   Making a small change to trigger deployment..."
    echo "# Deployment trigger $(date +%Y-%m-%d\ %H:%M:%S)" >> README.md
    git add README.md
    git commit -m "Trigger GitHub Pages redeploy - $(date +%Y-%m-%d\ %H:%M:%S)"
fi

echo ""
echo "📤 Pushing to origin/main..."
git push origin main

echo ""
echo "✅ Push complete!"
echo ""
echo "⏳ GitHub Pages should start deploying in 30-60 seconds"
echo "   Check: https://github.com/chris-cloudextend/netusite-excel-add-in-dotnet/actions"
echo ""
echo "🔍 After deployment completes (2-3 minutes), verify:"
echo "   https://chris-cloudextend.github.io/netusite-excel-add-in-dotnet/functions.js"
echo "   (Search for FUNCTIONS_VERSION - should show 4.0.6.167)"

