#!/bin/bash
# Force GitHub Pages to redeploy by making a commit

echo "🔄 Forcing GitHub Pages redeploy..."
echo ""

# Make a small change to trigger deployment
echo "<!-- GitHub Pages deployment trigger: $(date) -->" >> docs/.gitkeep 2>/dev/null || echo "# Deployment trigger: $(date)" >> README.md

# Stage and commit
git add -A
git commit -m "Trigger GitHub Pages redeploy - $(date +%Y-%m-%d\ %H:%M:%S)" || echo "⚠️  No changes to commit (files already up to date)"

# Push to main
echo ""
echo "📤 Pushing to origin/main..."
git push origin main

echo ""
echo "✅ Push complete!"
echo ""
echo "⏳ GitHub Pages should redeploy in 2-5 minutes"
echo "   Check: https://github.com/chris-cloudextend/netusite-excel-add-in-dotnet/actions"
echo ""
echo "🔍 Verify deployment:"
echo "   https://chris-cloudextend.github.io/netusite-excel-add-in-dotnet/functions.js"
echo "   (Search for FUNCTIONS_VERSION - should show 4.0.6.65)"

