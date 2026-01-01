#!/bin/bash

# Test script to verify period range optimization fix
# Simulates the exact request the frontend sends

echo "🧪 Testing Period Range Optimization Fix"
echo "========================================"
echo ""

# Get the server URL from the Cloudflare Worker code
SERVER_URL="https://netsuite-proxy.chris-corcoran.workers.dev"

echo "📡 Server URL: $SERVER_URL"
echo ""

# Test request body (exactly what frontend sends)
REQUEST_BODY='{
  "accounts": ["4220"],
  "from_period": "Jan 2012",
  "to_period": "Dec 2025",
  "periods": []
}'

echo "📤 Request Body:"
echo "$REQUEST_BODY" | jq .
echo ""

echo "🔄 Sending request to /batch/balance..."
echo ""

# Send the request
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
  "$SERVER_URL/batch/balance" \
  -H "Content-Type: application/json" \
  -d "$REQUEST_BODY")

# Split response and status code
HTTP_BODY=$(echo "$RESPONSE" | head -n -1)
HTTP_CODE=$(echo "$RESPONSE" | tail -n 1)

echo "📥 Response Status: $HTTP_CODE"
echo ""

if [ "$HTTP_CODE" = "200" ]; then
    echo "✅ SUCCESS! Request accepted (200 OK)"
    echo ""
    echo "📋 Response Body:"
    echo "$HTTP_BODY" | jq . 2>/dev/null || echo "$HTTP_BODY"
    echo ""
    
    # Check if response contains balance data
    if echo "$HTTP_BODY" | jq -e '.balances."4220"' > /dev/null 2>&1; then
        BALANCE=$(echo "$HTTP_BODY" | jq -r '.balances."4220" | to_entries[0].value' 2>/dev/null)
        if [ "$BALANCE" != "null" ] && [ "$BALANCE" != "" ]; then
            echo "✅ Balance data found: $BALANCE"
        else
            echo "⚠️  Balance data structure present but value is null/empty"
        fi
    else
        echo "⚠️  No balance data found in response"
    fi
else
    echo "❌ FAILED! Request rejected ($HTTP_CODE)"
    echo ""
    echo "📋 Error Response:"
    echo "$HTTP_BODY" | jq . 2>/dev/null || echo "$HTTP_BODY"
    echo ""
    
    if [ "$HTTP_CODE" = "400" ]; then
        echo "🔍 This is a 400 Bad Request - validation error"
        echo "   Check backend logs for details"
    fi
fi

echo ""
echo "========================================"
echo "Test complete"

