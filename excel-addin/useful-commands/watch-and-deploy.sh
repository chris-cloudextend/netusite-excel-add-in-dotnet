#!/bin/bash

# Watch and Deploy Script
# Watches for file changes and automatically deploys
# Usage: ./watch-and-deploy.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "👀 Watch and Deploy Mode"
echo "======================="
echo "Watching for changes in:"
echo "  - docs/functions.js"
echo "  - docs/taskpane.html"
echo "  - backend-dotnet/"
echo ""
echo "Press Ctrl+C to stop"
echo ""

# Check if fswatch is installed (Mac)
if command -v fswatch &> /dev/null; then
    echo "✅ Using fswatch (Mac)"
    fswatch -o "$PROJECT_ROOT/docs/functions.js" "$PROJECT_ROOT/docs/taskpane.html" "$PROJECT_ROOT/backend-dotnet" | while read f; do
        echo ""
        echo "📝 Change detected at $(date '+%H:%M:%S')"
        echo "🚀 Deploying..."
        bash "$SCRIPT_DIR/quick-deploy-and-test.sh" "Auto-deploy: $(date '+%Y-%m-%d %H:%M:%S')"
        echo ""
        echo "👀 Watching for changes..."
    done
# Check if inotifywait is installed (Linux)
elif command -v inotifywait &> /dev/null; then
    echo "✅ Using inotifywait (Linux)"
    while true; do
        inotifywait -e modify,create,delete "$PROJECT_ROOT/docs/functions.js" "$PROJECT_ROOT/docs/taskpane.html" "$PROJECT_ROOT/backend-dotnet" 2>/dev/null
        echo ""
        echo "📝 Change detected at $(date '+%H:%M:%S')"
        echo "🚀 Deploying..."
        bash "$SCRIPT_DIR/quick-deploy-and-test.sh" "Auto-deploy: $(date '+%Y-%m-%d %H:%M:%S')"
        echo ""
        echo "👀 Watching for changes..."
    done
else
    echo "❌ No file watcher found. Please install:"
    echo "   Mac: brew install fswatch"
    echo "   Linux: sudo apt-get install inotify-tools"
    exit 1
fi
