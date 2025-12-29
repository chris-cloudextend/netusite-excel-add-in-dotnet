#!/bin/bash
# Test script to query ONLY February 2025 transactions (period-only, not cumulative)
# This simulates what the incremental approach would need

SERVER_URL="http://localhost:5002"
ACCOUNT="10010"
JAN_BALANCE="2064705.84"  # Known January cumulative balance
EXPECTED_FEB="381646.48"  # Expected February cumulative balance

echo "=========================================="
echo "February Period-Only Query Test"
echo "Account: $ACCOUNT"
echo "January Cumulative: \$$JAN_BALANCE"
echo "Expected Feb Cumulative: \$$EXPECTED_FEB"
echo "=========================================="
echo ""
echo "NOTE: Current API treats BS accounts as cumulative."
echo "This test uses from_period=to_period to attempt period-only query."
echo ""

# The issue: When we specify from_period=Feb&to_period=Feb for a BS account,
# the backend still uses cumulative logic. We need to test what the period-only
# query would return if we could force it.

# For now, let's test what happens when we query with period range
# The backend should detect it as BS and use cumulative, but let's see the timing

echo "📅 Testing February 2025 with from_period=to_period..."
echo "   (Backend may still use cumulative for BS accounts)"
START_FEB=$(date +%s.%N)
RESPONSE_FEB=$(curl -s -w "\n%{http_code}" "${SERVER_URL}/balance?account=${ACCOUNT}&from_period=Feb%202025&to_period=Feb%202025")
HTTP_CODE_FEB=$(echo "$RESPONSE_FEB" | tail -n1)
BODY_FEB=$(echo "$RESPONSE_FEB" | sed '$d')
END_FEB=$(date +%s.%N)
TIME_FEB=$(echo "$END_FEB - $START_FEB" | bc)

if [ "$HTTP_CODE_FEB" = "200" ]; then
    BALANCE_FEB=$(echo "$BODY_FEB" | python3 -c "import sys, json; print(json.load(sys.stdin).get('balance', 'N/A'))" 2>/dev/null || echo "N/A")
    echo "✅ February 2025 Result: $BALANCE_FEB"
    echo "⏱️  Time: ${TIME_FEB} seconds"
    echo ""
    
    # Check if this is cumulative or period-only
    if [ "$(echo "$BALANCE_FEB == $EXPECTED_FEB" | bc 2>/dev/null)" = "1" ]; then
        echo "⚠️  This appears to be CUMULATIVE (matches expected Feb cumulative)"
        echo "   The backend is treating this as BS and using cumulative logic."
        echo ""
        echo "For incremental approach, we need PERIOD-ONLY query that:"
        echo "  1. Queries only Feb transactions (not all history)"
        echo "  2. Uses Feb period's exchange rate"
        echo "  3. Returns period change, not cumulative"
    else
        echo "This might be period-only, but doesn't match expected cumulative."
    fi
    
    # Calculate what period change would be
    if [ "$BALANCE_FEB" != "N/A" ] && [ -n "$BALANCE_FEB" ]; then
        PERIOD_CHANGE=$(echo "$EXPECTED_FEB - $JAN_BALANCE" | bc)
        echo ""
        echo "=========================================="
        echo "Expected Calculation"
        echo "=========================================="
        echo "January Cumulative:     \$$JAN_BALANCE"
        echo "Expected Feb Cumulative: \$$EXPECTED_FEB"
        echo "Required Period Change:  \$$PERIOD_CHANGE"
        echo ""
        echo "If we could get period-only query:"
        echo "  Jan Cumulative + Feb Period Change = Feb Cumulative"
        echo "  \$$JAN_BALANCE + \$$PERIOD_CHANGE = \$$EXPECTED_FEB"
    fi
else
    echo "❌ February 2025 failed: HTTP $HTTP_CODE_FEB"
    echo "Response: $BODY_FEB"
fi

echo ""
echo "=========================================="
echo "Summary"
echo "=========================================="
echo "January Cumulative Query:  ~77 seconds"
echo "February Query Time:      ${TIME_FEB} seconds"
echo ""
echo "⚠️  ISSUE: Backend uses cumulative logic for BS accounts"
echo "   even when from_period=to_period is specified."
echo ""
echo "To test incremental approach, we need to:"
echo "  1. Modify backend to support period-only queries for BS accounts"
echo "  2. Or create a test endpoint that forces period-only logic"
echo "  3. Query should use: ap.startdate >= Feb_start AND ap.enddate <= Feb_end"
echo "  4. Query should use target period's exchange rate (Feb rate)"

