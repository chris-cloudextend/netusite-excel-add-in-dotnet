#!/bin/bash
# Test 2: Period activity (both fromPeriod and toPeriod provided)
# Should return net activity between fromPeriod and toPeriod

SERVER_URL="http://localhost:5002"
ACCOUNT="10010"
FROM_PERIOD="Jan 2025"
TO_PERIOD="Apr 2025"

echo "=========================================="
echo "Test 2: Period Activity (Range Query)"
echo "=========================================="
echo "Account: $ACCOUNT"
echo "Formula: BALANCE(\"$ACCOUNT\", \"$FROM_PERIOD\", \"$TO_PERIOD\")"
echo "Expected: Net activity from $FROM_PERIOD through $TO_PERIOD"
echo ""

START_TIME=$(date +%s.%N)
RESPONSE=$(curl -s -w "\n%{http_code}" "${SERVER_URL}/balance?account=${ACCOUNT}&from_period=${FROM_PERIOD// /%20}&to_period=${TO_PERIOD// /%20}")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')
END_TIME=$(date +%s.%N)
ELAPSED=$(echo "$END_TIME - $START_TIME" | bc)

if [ "$HTTP_CODE" = "200" ]; then
    BALANCE=$(echo "$BODY" | python3 -c "import sys, json; print(json.load(sys.stdin).get('balance', 'N/A'))" 2>/dev/null || echo "N/A")
    FROM_PERIOD_RESP=$(echo "$BODY" | python3 -c "import sys, json; print(json.load(sys.stdin).get('from_period', 'N/A'))" 2>/dev/null || echo "N/A")
    TO_PERIOD_RESP=$(echo "$BODY" | python3 -c "import sys, json; print(json.load(sys.stdin).get('to_period', 'N/A'))" 2>/dev/null || echo "N/A")
    
    echo "✅ SUCCESS"
    echo "Balance (activity): \$$BALANCE"
    echo "From Period: $FROM_PERIOD_RESP"
    echo "To Period: $TO_PERIOD_RESP"
    echo "Time: ${ELAPSED} seconds"
    echo ""
    
    if [ "$FROM_PERIOD_RESP" != "null" ] && [ "$FROM_PERIOD_RESP" != "" ] && [ "$FROM_PERIOD_RESP" != "None" ]; then
        echo "✅ From Period is provided (correct for period activity)"
    else
        echo "⚠️  From Period is empty: $FROM_PERIOD_RESP"
    fi
    
    # Compare with point-in-time to verify it's different
    echo ""
    echo "Comparing with point-in-time query..."
    PT_RESPONSE=$(curl -s "${SERVER_URL}/balance?account=${ACCOUNT}&to_period=${TO_PERIOD// /%20}")
    PT_BALANCE=$(echo "$PT_RESPONSE" | python3 -c "import sys, json; print(json.load(sys.stdin).get('balance', 'N/A'))" 2>/dev/null || echo "N/A")
    
    echo "Point-in-time (Apr): \$$PT_BALANCE"
    echo "Period activity (Jan-Apr): \$$BALANCE"
    
    if [ "$BALANCE" != "$PT_BALANCE" ]; then
        echo "✅ Values differ (expected - period activity vs cumulative)"
    else
        echo "⚠️  Values are the same (may be correct if no activity, or may indicate issue)"
    fi
else
    echo "❌ FAILED: HTTP $HTTP_CODE"
    echo "Response: $BODY"
fi

echo ""
echo "=========================================="

