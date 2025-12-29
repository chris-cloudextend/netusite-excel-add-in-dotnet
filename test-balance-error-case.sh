#!/bin/bash
# Test 3: Error case (fromPeriod provided, toPeriod empty)
# Should return error message

SERVER_URL="http://localhost:5002"
ACCOUNT="10010"
FROM_PERIOD="Jan 2025"
TO_PERIOD=""  # Empty

echo "=========================================="
echo "Test 3: Error Case (Invalid Parameters)"
echo "=========================================="
echo "Account: $ACCOUNT"
echo "Formula: BALANCE(\"$ACCOUNT\", \"$FROM_PERIOD\", \"\")"
echo "Expected: Error message"
echo ""

START_TIME=$(date +%s.%N)
RESPONSE=$(curl -s -w "\n%{http_code}" "${SERVER_URL}/balance?account=${ACCOUNT}&from_period=${FROM_PERIOD// /%20}&to_period=")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')
END_TIME=$(date +%s.%N)
ELAPSED=$(echo "$END_TIME - $START_TIME" | bc)

echo "HTTP Code: $HTTP_CODE"
echo "Response: $BODY"
echo "Time: ${ELAPSED} seconds"
echo ""

# Check if error is present
ERROR=$(echo "$BODY" | python3 -c "import sys, json; d=json.load(sys.stdin); print(d.get('error', 'N/A'))" 2>/dev/null || echo "N/A")

if [ "$ERROR" != "N/A" ] && [ "$ERROR" != "null" ] && [ "$ERROR" != "" ]; then
    echo "✅ SUCCESS: Error message returned"
    echo "Error: $ERROR"
    
    # Check if error message is user-friendly
    if echo "$ERROR" | grep -qi "fromPeriod\|toPeriod\|required\|invalid"; then
        echo "✅ Error message is user-friendly"
    else
        echo "⚠️  Error message may not be user-friendly"
    fi
elif [ "$HTTP_CODE" != "200" ]; then
    echo "✅ SUCCESS: Non-200 status code (error indicated)"
else
    echo "❌ FAILED: Should return error but got success"
    echo "Balance: $(echo "$BODY" | python3 -c "import sys, json; print(json.load(sys.stdin).get('balance', 'N/A'))" 2>/dev/null || echo "N/A")"
fi

echo ""
echo "=========================================="

