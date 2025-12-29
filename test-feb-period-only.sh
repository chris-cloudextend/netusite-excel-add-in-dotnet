#!/bin/bash
# Test script to measure February period-only query timing for account 10010
# This queries ONLY February transactions (not cumulative), then adds to January

SERVER_URL="http://localhost:5002"
ACCOUNT="10010"
JAN_BALANCE="2064705.84"  # Known January cumulative balance

echo "=========================================="
echo "February Period-Only Query Test"
echo "Account: $ACCOUNT"
echo "January Cumulative: \$$JAN_BALANCE"
echo "=========================================="
echo ""

# Test February period-only (from_period = to_period = Feb 2025)
# This should query only February transactions, not cumulative
echo "📅 Testing February 2025 (PERIOD ONLY - not cumulative)..."
START_FEB=$(date +%s.%N)
RESPONSE_FEB=$(curl -s -w "\n%{http_code}" "${SERVER_URL}/balance?account=${ACCOUNT}&from_period=Feb%202025&to_period=Feb%202025")
HTTP_CODE_FEB=$(echo "$RESPONSE_FEB" | tail -n1)
BODY_FEB=$(echo "$RESPONSE_FEB" | sed '$d')
END_FEB=$(date +%s.%N)
TIME_FEB=$(echo "$END_FEB - $START_FEB" | bc)

if [ "$HTTP_CODE_FEB" = "200" ]; then
    BALANCE_FEB=$(echo "$BODY_FEB" | python3 -c "import sys, json; print(json.load(sys.stdin).get('balance', 'N/A'))" 2>/dev/null || echo "N/A")
    echo "✅ February 2025 Period Change: $BALANCE_FEB"
    echo "⏱️  Time: ${TIME_FEB} seconds"
    echo ""
    
    # Calculate: January + February change = Expected February cumulative
    if [ "$BALANCE_FEB" != "N/A" ] && [ -n "$BALANCE_FEB" ]; then
        CALCULATED_FEB=$(echo "$JAN_BALANCE + $BALANCE_FEB" | bc)
        EXPECTED_FEB="381646.48"
        
        echo "=========================================="
        echo "Calculation"
        echo "=========================================="
        echo "January Cumulative:     \$$JAN_BALANCE"
        echo "February Period Change: \$$BALANCE_FEB"
        echo "Calculated Feb Total:   \$$CALCULATED_FEB"
        echo "Expected Feb Total:     \$$EXPECTED_FEB"
        echo ""
        
        # Check if it matches
        DIFF=$(echo "$CALCULATED_FEB - $EXPECTED_FEB" | bc)
        ABS_DIFF=$(echo "$DIFF" | sed 's/-//')
        
        # Use a small tolerance for floating point comparison
        TOLERANCE="0.01"
        if [ "$(echo "$ABS_DIFF < $TOLERANCE" | bc)" = "1" ]; then
            echo "✅ MATCH: Calculated value matches expected!"
        else
            echo "⚠️  DIFFERENCE: \$$DIFF"
        fi
    fi
else
    echo "❌ February 2025 failed: HTTP $HTTP_CODE_FEB"
    echo "Response: $BODY_FEB"
fi

echo ""
echo "=========================================="
echo "Summary"
echo "=========================================="
echo "January Cumulative Query:  ~77 seconds (from previous test)"
echo "February Period-Only Query: ${TIME_FEB} seconds"
echo ""
TIME_SAVINGS=$(echo "77 - $TIME_FEB" | bc)
PERCENT_SAVINGS=$(echo "scale=1; ($TIME_SAVINGS / 77) * 100" | bc)
echo "Time Savings: ${TIME_SAVINGS} seconds (${PERCENT_SAVINGS}% faster)"

