#!/bin/bash

# Quick Deploy and Test Script
# Automates: git push, server restart, tunnel update, cache clear
# Usage: ./quick-deploy-and-test.sh [commit-message]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

COMMIT_MSG="${1:-Quick test deployment}"

echo "🚀 Quick Deploy and Test"
echo "========================"
echo ""

# Step 1: Git operations
echo "📦 Step 1: Git operations..."
cd "$PROJECT_ROOT"
git add -A
git commit -m "$COMMIT_MSG" || echo "⚠️  No changes to commit"
git push origin main || git push origin master || echo "⚠️  Push failed or no remote"

# Step 2: Restart backend server
echo ""
echo "🔄 Step 2: Restarting backend server..."
if [ -f "$PROJECT_ROOT/restart-dotnet-backend.sh" ]; then
    bash "$PROJECT_ROOT/restart-dotnet-backend.sh"
else
    echo "⚠️  restart-dotnet-backend.sh not found, skipping server restart"
fi

# Step 3: Wait for server to be ready
echo ""
echo "⏳ Step 3: Waiting for server to be ready..."
sleep 3
for i in {1..10}; do
    if curl -s http://localhost:5002/health > /dev/null 2>&1 || curl -s http://localhost:5002/swagger > /dev/null 2>&1; then
        echo "✅ Server is ready!"
        break
    fi
    echo "   Attempt $i/10: Server not ready yet, waiting..."
    sleep 2
done

# Step 4: Clear Excel cache (instructions)
echo ""
echo "🧹 Step 4: Excel cache clear instructions"
echo "   To clear Excel cache, run in Excel DevTools console:"
echo "   localStorage.clear(); location.reload();"
echo ""
echo "   Or use the Excel cache clear command:"
echo "   =XAVI.BALANCE(\"__CLEARCACHE__\", \"\", \"\")"

# Step 5: Open tunnel (if using)
echo ""
echo "🌐 Step 5: Tunnel update"
echo "   If using ngrok or similar, update your tunnel URL in manifest.xml"
echo "   Current server URL: http://localhost:5002"

echo ""
echo "✅ Deployment complete!"
echo ""
echo "📋 Next steps:"
echo "   1. Open Excel"
echo "   2. Open DevTools (Cmd+Option+I on Mac)"
echo "   3. Clear cache: localStorage.clear(); location.reload();"
echo "   4. Test your changes"
echo ""
