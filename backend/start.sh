#!/bin/bash
# ⚠️ LEGACY SCRIPT - Python backend is no longer used
# This script is kept for reference only
# 
# The active backend is now .NET Core (backend-dotnet/)
# To start the .NET backend, use: ./start-dotnet-server.sh

cd "$(dirname "$0")"

echo "⚠️  WARNING: This script starts the LEGACY Python backend"
echo "⚠️  The Python backend (backend/server.py) is kept for reference only"
echo "⚠️  The active backend is .NET Core (backend-dotnet/)"
echo ""
echo "To start the .NET backend instead, run:"
echo "   ./start-dotnet-server.sh"
echo ""
read -p "Do you want to start the legacy Python backend anyway? (y/N): " confirm

if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
    echo "Aborted. Use ./start-dotnet-server.sh to start the active backend."
    exit 0
fi

echo ""
echo "Starting LEGACY NetSuite Excel Formulas Python backend server..."
echo "Press Ctrl+C to stop"
echo ""

python3 server.py

