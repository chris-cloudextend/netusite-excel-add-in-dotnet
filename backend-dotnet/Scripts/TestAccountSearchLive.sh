#!/bin/bash
# Test script to hit the actual backend endpoint (both direct and via Cloudflare Worker)
# Usage: ./TestAccountSearchLive.sh [pattern]

PATTERN="${1:-Balance}"
DIRECT_PORT="${2:-5002}"
DIRECT_URL="http://localhost:${DIRECT_PORT}"
CLOUDFLARE_URL="https://netsuite-proxy.chris-corcoran.workers.dev"

echo "=========================================="
echo "Testing Account Search Endpoint"
echo "=========================================="
echo "Pattern: '$PATTERN'"
echo ""

# Test direct backend (if running locally)
echo "1. Testing DIRECT backend (localhost:${DIRECT_PORT}):"
echo "   URL: ${DIRECT_URL}/accounts/search?pattern=${PATTERN}"
echo ""
if curl -s --max-time 2 "${DIRECT_URL}/accounts/search?pattern=${PATTERN}" > /dev/null 2>&1; then
    echo "   ✅ Backend is running"
    curl -s "${DIRECT_URL}/accounts/search?pattern=${PATTERN}" | python3 -m json.tool 2>/dev/null || curl -s "${DIRECT_URL}/accounts/search?pattern=${PATTERN}"
else
    echo "   ❌ Backend not running on port ${DIRECT_PORT}"
fi

echo ""
echo ""

# Test Cloudflare Worker proxy
echo "2. Testing CLOUDFLARE WORKER proxy:"
echo "   URL: ${CLOUDFLARE_URL}/accounts/search?pattern=${PATTERN}"
echo ""
RESPONSE=$(curl -s --max-time 10 "${CLOUDFLARE_URL}/accounts/search?pattern=${PATTERN}")
if [ $? -eq 0 ]; then
    echo "   ✅ Worker responded"
    echo "$RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE"
    
    # Check if response has accounts
    COUNT=$(echo "$RESPONSE" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('count', 0))" 2>/dev/null || echo "0")
    if [ "$COUNT" = "0" ]; then
        echo ""
        echo "   ⚠️  WARNING: Response has 0 accounts!"
        echo "   Full response:"
        echo "$RESPONSE"
    fi
else
    echo "   ❌ Worker request failed or timed out"
fi

echo ""
echo "=========================================="
echo "Testing multiple patterns:"
echo "=========================================="

for test_pattern in "Balance" "Bank" "Income" "*" "100"; do
    echo ""
    echo "Pattern: '$test_pattern'"
    echo "Response from Cloudflare Worker:"
    curl -s --max-time 10 "${CLOUDFLARE_URL}/accounts/search?pattern=${test_pattern}" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(f\"  Search Type: {data.get('search_type', 'unknown')}\")
    print(f\"  Count: {data.get('count', 0)}\")
    if data.get('count', 0) > 0:
        print(f\"  First account: {data.get('accounts', [{}])[0].get('Number', 'N/A')} - {data.get('accounts', [{}])[0].get('Name', 'N/A')}\")
    else:
        print(f\"  ⚠️  No accounts returned!\")
        print(f\"  Full response: {json.dumps(data, indent=2)}\")
except Exception as e:
    print(f\"  ❌ Error parsing response: {e}\")
    sys.stdin.seek(0)
    print(sys.stdin.read())
" 2>/dev/null || curl -s --max-time 10 "${CLOUDFLARE_URL}/accounts/search?pattern=${test_pattern}" | head -5
    echo ""
done

