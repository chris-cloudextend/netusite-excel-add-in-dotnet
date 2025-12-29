#!/bin/bash
# Test 1: Point-in-time balance (fromPeriod null/empty)
# Should return cumulative balance as of toPeriod

SERVER_URL="http://localhost:5002"
ACCOUNT="10010"
TO_PERIOD="Apr 2025"

echo "=========================================="
echo "Test 1: Point-in-Time Balance"
echo "=========================================="
echo "Account: $ACCOUNT"
echo "Formula: BALANCE(\"$ACCOUNT\",, \"$TO_PERIOD\")"
echo "Expected: Cumulative balance as of $TO_PERIOD"
echo ""

START_TIME=$(date +%s.%N)
RESPONSE=$(curl -s -w "\n%{http_code}" "${SERVER_URL}/balance?account=${ACCOUNT}&to_period=${TO_PERIOD// /%20}")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')
END_TIME=$(date +%s.%N)
ELAPSED=$(echo "$END_TIME - $START_TIME" | bc)

if [ "$HTTP_CODE" = "200" ]; then
    BALANCE=$(echo "$BODY" | python3 -c "import sys, json; print(json.load(sys.stdin).get('balance', 'N/A'))" 2>/dev/null || echo "N/A")
    FROM_PERIOD=$(echo "$BODY" | python3 -c "import sys, json; print(json.load(sys.stdin).get('from_period', 'N/A'))" 2>/dev/null || echo "N/A")
    TO_PERIOD_RESP=$(echo "$BODY" | python3 -c "import sys, json; print(json.load(sys.stdin).get('to_period', 'N/A'))" 2>/dev/null || echo "N/A")
    
    echo "✅ SUCCESS"
    echo "Balance: \$$BALANCE"
    echo "From Period: $FROM_PERIOD (should be empty/null)"
    echo "To Period: $TO_PERIOD_RESP"
    echo "Time: ${ELAPSED} seconds"
    echo ""
    
    if [ "$FROM_PERIOD" = "null" ] || [ "$FROM_PERIOD" = "" ] || [ "$FROM_PERIOD" = "None" ]; then
        echo "✅ From Period is empty/null (correct for point-in-time)"
    else
        echo "⚠️  From Period is not empty: $FROM_PERIOD"
    fi
else
    echo "❌ FAILED: HTTP $HTTP_CODE"
    echo "Response: $BODY"
fi

echo ""
echo "=========================================="

