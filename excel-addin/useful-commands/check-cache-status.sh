#!/bin/bash
# Script to check book-subsidiary cache status
# Usage: bash ./check-cache-status.sh

echo "🔍 Checking Book-Subsidiary Cache Status"
echo "=========================================="
echo ""

# Check if server is running
echo "1️⃣ Checking if server is running..."
if curl -s http://localhost:5002/health > /dev/null 2>&1; then
    echo "   ✅ Server is running"
else
    echo "   ❌ Server is NOT running"
    echo "   Please start it with: bash excel-addin/useful-commands/start-dotnet-server.sh"
    exit 1
fi

echo ""
echo "2️⃣ Checking cache status endpoint..."
CACHE_STATUS=$(curl -s http://localhost:5002/lookups/cache/status 2>/dev/null)
if [ $? -eq 0 ]; then
    echo "$CACHE_STATUS" | python3 -m json.tool 2>/dev/null || echo "$CACHE_STATUS"
else
    echo "   ❌ Failed to get cache status"
fi

echo ""
echo "3️⃣ Checking cache file location..."
CACHE_FILE="$HOME/Library/Application Support/XaviApi/book-subsidiary-cache.json"
if [ -f "$CACHE_FILE" ]; then
    echo "   ✅ Cache file exists: $CACHE_FILE"
    FILE_SIZE=$(stat -f%z "$CACHE_FILE" 2>/dev/null || stat -c%s "$CACHE_FILE" 2>/dev/null || echo "unknown")
    echo "   📊 File size: $FILE_SIZE bytes"
    echo "   📅 Last modified: $(stat -f%Sm "$CACHE_FILE" 2>/dev/null || stat -c%y "$CACHE_FILE" 2>/dev/null || echo "unknown")"
    
    # Show first few lines of cache file
    echo ""
    echo "   📄 Cache file preview (first 20 lines):"
    head -20 "$CACHE_FILE" | sed 's/^/      /'
else
    echo "   ❌ Cache file does NOT exist: $CACHE_FILE"
    echo "   📁 Directory exists: $([ -d "$(dirname "$CACHE_FILE")" ] && echo "Yes" || echo "No")"
fi

echo ""
echo "4️⃣ Checking backend logs for cache initialization..."
LOG_FILE="/tmp/dotnet-server.log"
if [ -f "$LOG_FILE" ]; then
    echo "   📋 Recent cache-related log entries:"
    grep -i "cache\|book.*subsidiary\|InitializeBookSubsidiaryCache" "$LOG_FILE" | tail -20 | sed 's/^/      /'
else
    echo "   ⚠️  Log file not found: $LOG_FILE"
fi

echo ""
echo "✅ Cache status check complete"

