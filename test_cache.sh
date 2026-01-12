#!/bin/bash
# Test script to verify cache initialization and endpoint

echo "=========================================="
echo "Cache Verification Test"
echo "=========================================="

# Check if server is running
if ! curl -s http://localhost:5002/health > /dev/null 2>&1; then
    echo "❌ Server is not running on port 5002"
    exit 1
fi

echo "✅ Server is running"

# Trigger cache initialization
echo ""
echo "1. Triggering cache initialization..."
RESPONSE=$(curl -s -X POST http://localhost:5002/lookups/cache/initialize)
echo "Response: $RESPONSE"

# Wait a bit for cache to build
echo ""
echo "2. Waiting 10 seconds for cache to build..."
sleep 10

# Test endpoint
echo ""
echo "3. Testing /lookups/accountingbook/2/subsidiaries..."
RESPONSE=$(curl -s http://localhost:5002/lookups/accountingbook/2/subsidiaries)
echo "$RESPONSE" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    subs = d.get('subsidiaries', [])
    print(f'   Found {len(subs)} subsidiary(ies):')
    for s in subs:
        print(f'     ✅ {s.get(\"name\")} (ID: {s.get(\"id\")})')
    if len(subs) > 0 and any(s.get('id') == '2' for s in subs):
        print('   ✅✅✅ SUCCESS: Subsidiary 2 (India) found!')
    elif len(subs) == 0:
        print('   ❌ FAIL: No subsidiaries returned')
    else:
        print(f'   ⚠️  Subsidiary 2 not found. Found IDs: {[s.get(\"id\") for s in subs]}')
except Exception as e:
    print(f'   ❌ Error parsing response: {e}')
    print(f'   Raw response: {sys.stdin.read()}')
"

echo ""
echo "=========================================="

