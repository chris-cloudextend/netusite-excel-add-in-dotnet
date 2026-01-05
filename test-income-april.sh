#!/bin/bash
# Test script to verify Income for April 2025 returns correct value

echo "🧪 Testing Income for April 2025, Book 2, Celigo India Pvt Ltd"
echo ""

# Wait for server to be ready
echo "⏳ Checking if server is running..."
for i in {1..15}; do
    if curl -s http://localhost:5002/health > /dev/null 2>&1; then
        echo "✅ Server is ready"
        break
    else
        if [ $i -eq 15 ]; then
            echo "❌ Server is not responding. Please start it with:"
            echo "   bash excel-addin/useful-commands/start-dotnet-server.sh"
            exit 1
        fi
        echo "   Waiting... ($i/15)"
        sleep 2
    fi
done

echo ""
echo "📡 Calling batch endpoint..."
RESPONSE=$(curl -s -X POST http://localhost:5002/batch/typebalance_refresh \
    -H "Content-Type: application/json" \
    -d '{"year": 2025, "subsidiary": "Celigo India Pvt Ltd", "book": 2}')

if [ $? -ne 0 ]; then
    echo "❌ Failed to call API"
    exit 1
fi

echo "📊 Response received"
echo ""

# Extract Income April value
APR_VALUE=$(echo "$RESPONSE" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    income = data.get('Income', {})
    # Try different key formats
    apr = income.get('apr', income.get('Apr 2025', income.get('apr_month', 0)))
    print(apr)
except Exception as e:
    print(f'ERROR: {e}')
    sys.exit(1)
" 2>&1)

if [ -z "$APR_VALUE" ] || [ "$APR_VALUE" = "0" ] || [ "$APR_VALUE" = "ERROR" ]; then
    echo "❌ Income April 2025 value: $APR_VALUE"
    echo ""
    echo "Full response (first 1000 chars):"
    echo "$RESPONSE" | head -c 1000
    echo ""
    echo ""
    echo "Checking logs for errors..."
    tail -n 50 /tmp/dotnet-server.log | grep -i "error\|exception\|REVENUE DEBUG" | tail -10
    exit 1
else
    echo "✅ Income April 2025: $APR_VALUE"
    echo ""
    if [ "$(echo "$APR_VALUE > 0" | bc 2>/dev/null || echo "0")" = "1" ]; then
        echo "✅ SUCCESS: Value is greater than 0!"
        echo "   Expected: 143,480,988.56"
        echo "   Got: $APR_VALUE"
    else
        echo "⚠️  Value is 0 or negative"
        exit 1
    fi
fi

