#!/bin/bash
# Test script to measure Balance Sheet query timing for account 10010
# Tests Jan 2025 and Feb 2025 cumulative queries

SERVER_URL="http://localhost:5002"
ACCOUNT="10010"

echo "=========================================="
echo "Balance Sheet Query Timing Test"
echo "Account: $ACCOUNT"
echo "=========================================="
echo ""

# Test January 2025
echo "📅 Testing January 2025 (cumulative from inception)..."
START_JAN=$(date +%s.%N)
RESPONSE_JAN=$(curl -s -w "\n%{http_code}" "${SERVER_URL}/balance?account=${ACCOUNT}&to_period=Jan%202025")
HTTP_CODE_JAN=$(echo "$RESPONSE_JAN" | tail -n1)
BODY_JAN=$(echo "$RESPONSE_JAN" | sed '$d')
END_JAN=$(date +%s.%N)
TIME_JAN=$(echo "$END_JAN - $START_JAN" | bc)

if [ "$HTTP_CODE_JAN" = "200" ]; then
    BALANCE_JAN=$(echo "$BODY_JAN" | python3 -c "import sys, json; print(json.load(sys.stdin).get('balance', 'N/A'))" 2>/dev/null || echo "N/A")
    echo "✅ January 2025: $BALANCE_JAN"
    echo "⏱️  Time: ${TIME_JAN} seconds"
else
    echo "❌ January 2025 failed: HTTP $HTTP_CODE_JAN"
    echo "Response: $BODY_JAN"
fi
echo ""

# Wait a moment between queries
sleep 2

# Test February 2025
echo "📅 Testing February 2025 (cumulative from inception)..."
START_FEB=$(date +%s.%N)
RESPONSE_FEB=$(curl -s -w "\n%{http_code}" "${SERVER_URL}/balance?account=${ACCOUNT}&to_period=Feb%202025")
HTTP_CODE_FEB=$(echo "$RESPONSE_FEB" | tail -n1)
BODY_FEB=$(echo "$RESPONSE_FEB" | sed '$d')
END_FEB=$(date +%s.%N)
TIME_FEB=$(echo "$END_FEB - $START_FEB" | bc)

if [ "$HTTP_CODE_FEB" = "200" ]; then
    BALANCE_FEB=$(echo "$BODY_FEB" | python3 -c "import sys, json; print(json.load(sys.stdin).get('balance', 'N/A'))" 2>/dev/null || echo "N/A")
    echo "✅ February 2025: $BALANCE_FEB"
    echo "⏱️  Time: ${TIME_FEB} seconds"
else
    echo "❌ February 2025 failed: HTTP $HTTP_CODE_FEB"
    echo "Response: $BODY_FEB"
fi
echo ""

# Summary
echo "=========================================="
echo "Summary"
echo "=========================================="
echo "January 2025:  ${TIME_JAN} seconds"
echo "February 2025: ${TIME_FEB} seconds"
echo ""
if [ "$HTTP_CODE_JAN" = "200" ] && [ "$HTTP_CODE_FEB" = "200" ]; then
    DIFF=$(echo "$TIME_FEB - $TIME_JAN" | bc)
    echo "Time Difference: ${DIFF} seconds"
    echo ""
    echo "Expected Feb result: \$381,646.48"
    if [ -n "$BALANCE_FEB" ] && [ "$BALANCE_FEB" != "N/A" ]; then
        FORMATTED_FEB=$(printf "%.2f" "$BALANCE_FEB" 2>/dev/null || echo "$BALANCE_FEB")
        echo "Actual Feb result: \$$FORMATTED_FEB"
        
        # Check if it matches expected
        EXPECTED=381646.48
        if [ "$(echo "$BALANCE_FEB == $EXPECTED" | bc 2>/dev/null)" = "1" ]; then
            echo "✅ MATCH: Result matches expected value!"
        else
            DIFF=$(echo "$BALANCE_FEB - $EXPECTED" | bc 2>/dev/null || echo "N/A")
            echo "⚠️  DIFFERENCE: $DIFF"
        fi
    fi
fi

