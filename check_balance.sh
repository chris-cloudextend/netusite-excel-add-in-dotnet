#!/bin/bash
# Script to check NetSuite balance vs backend

echo "🔍 Checking NetSuite balance for account 13000, May 2025, book 2, subsidiary Celigo India Pvt Ltd"
echo ""

# Check if Python script exists
if [ -f "run_balance_query.py" ]; then
    echo "Running Python query script..."
    python3 run_balance_query.py
    
    if [ -f "netsuite_balance_result.json" ]; then
        echo ""
        echo "✅ Results:"
        cat netsuite_balance_result.json | python3 -m json.tool
    fi
else
    echo "❌ Python script not found"
fi

echo ""
echo "---"
echo ""

# Check if backend server is running
if curl -s http://localhost:5002/health > /dev/null 2>&1; then
    echo "✅ Backend server is running"
    echo ""
    echo "Calling test endpoint..."
    curl -s "http://localhost:5002/test/balance-13000-may-2025?account=13000&period=May%202025&subsidiary=Celigo%20India%20Pvt%20Ltd&book=2" | python3 -m json.tool
else
    echo "⚠️  Backend server is not running on port 5002"
    echo "   Start it with: cd backend-dotnet && dotnet run"
fi

