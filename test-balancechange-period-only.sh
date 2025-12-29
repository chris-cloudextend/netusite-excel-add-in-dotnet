#!/bin/bash
# Test BALANCECHANGE with from_period == to_period (period-only query)
# This should return only February transactions, not cumulative

SERVER_URL="http://localhost:5002"
ACCOUNT="10010"
JAN_BALANCE="2064705.84"  # Known January cumulative balance
EXPECTED_FEB="381646.48"  # Expected February cumulative balance

echo "=========================================="
echo "BALANCECHANGE Period-Only Test"
echo "Account: $ACCOUNT"
echo "Testing: BALANCECHANGE(\"$ACCOUNT\", \"Feb 2025\", \"Feb 2025\")"
echo "=========================================="
echo ""

# Test BALANCECHANGE with from_period == to_period
# This should now use period-only query (much faster)
echo "📅 Testing BALANCECHANGE period-only query..."
START_FEB=$(date +%s.%N)
RESPONSE_FEB=$(curl -s -w "\n%{http_code}" "${SERVER_URL}/balance-change?account=${ACCOUNT}&from_period=Feb%202025&to_period=Feb%202025")
HTTP_CODE_FEB=$(echo "$RESPONSE_FEB" | tail -n1)
BODY_FEB=$(echo "$RESPONSE_FEB" | sed '$d')
END_FEB=$(date +%s.%N)
TIME_FEB=$(echo "$END_FEB - $START_FEB" | bc)

if [ "$HTTP_CODE_FEB" = "200" ]; then
    CHANGE_FEB=$(echo "$BODY_FEB" | python3 -c "import sys, json; print(json.load(sys.stdin).get('change', 'N/A'))" 2>/dev/null || echo "N/A")
    TO_BALANCE=$(echo "$BODY_FEB" | python3 -c "import sys, json; print(json.load(sys.stdin).get('to_balance', 'N/A'))" 2>/dev/null || echo "N/A")
    
    echo "✅ February 2025 Period Change: $CHANGE_FEB"
    echo "⏱️  Time: ${TIME_FEB} seconds"
    echo ""
    
    # Calculate: January + February change = Expected February cumulative
    if [ "$CHANGE_FEB" != "N/A" ] && [ -n "$CHANGE_FEB" ]; then
        CALCULATED_FEB=$(echo "$JAN_BALANCE + $CHANGE_FEB" | bc)
        
        echo "=========================================="
        echo "Calculation"
        echo "=========================================="
        echo "January Cumulative:     \$$JAN_BALANCE"
        echo "February Period Change: \$$CHANGE_FEB"
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
            echo "   Financial correctness: VERIFIED"
        else
            echo "⚠️  DIFFERENCE: \$$DIFF"
            echo "   This may indicate a currency conversion issue"
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
echo "February Period-Only:     ${TIME_FEB} seconds"
echo ""
TIME_SAVINGS=$(echo "77 - $TIME_FEB" | bc)
PERCENT_SAVINGS=$(echo "scale=1; ($TIME_SAVINGS / 77) * 100" | bc)
echo "Time Savings: ${TIME_SAVINGS} seconds (${PERCENT_SAVINGS}% faster)"
echo ""
if [ "$(echo "$TIME_FEB < 50" | bc)" = "1" ]; then
    echo "✅ SUCCESS: Period-only query is significantly faster!"
else
    echo "⚠️  Period-only query time is similar to cumulative - may still be using cumulative logic"
fi

