#!/bin/bash
# Script to restart the server with clean build

echo "=========================================="
echo "Restarting Server with Clean Build"
echo "=========================================="

# Step 1: Stop existing server
echo ""
echo "1. Stopping existing server..."
pkill -9 -f "dotnet.*run" 2>/dev/null
pkill -9 -f "dotnet.*XaviApi" 2>/dev/null
sleep 3
echo "   ✅ Server stopped"

# Step 2: Clean build
echo ""
echo "2. Cleaning and rebuilding..."
cd /Users/chriscorcoran/Documents/Cursor/NetSuite-Excel-AddIn-DotNet/backend-dotnet
dotnet clean > /dev/null 2>&1
dotnet build > /tmp/build.log 2>&1

if grep -q "Build succeeded" /tmp/build.log; then
    echo "   ✅ Build succeeded"
else
    echo "   ❌ Build failed - check /tmp/build.log"
    exit 1
fi

# Step 3: Start server
echo ""
echo "3. Starting server..."
rm -f /tmp/dotnet-server.log
nohup dotnet run > /tmp/dotnet-server.log 2>&1 &
sleep 5
echo "   ✅ Server started"

# Step 4: Wait for initialization
echo ""
echo "4. Waiting 10 seconds for server to initialize..."
sleep 10

# Step 5: Check for cache initialization messages
echo ""
echo "5. Checking for cache initialization..."
if grep -q "Starting book-subsidiary cache initialization" /tmp/dotnet-server.log; then
    echo "   ✅ Cache initialization started"
else
    echo "   ⚠️  Cache initialization not found in logs yet"
    echo "   (This is normal - it runs in background after 2 seconds)"
fi

echo ""
echo "=========================================="
echo "Server restarted!"
echo ""
echo "Next steps:"
echo "1. Wait 60 seconds for cache to build"
echo "2. Check logs: tail -100 /tmp/dotnet-server.log | grep -i cache"
echo "3. Or manually trigger: curl -X POST http://localhost:5002/lookups/cache/initialize"
echo "=========================================="

