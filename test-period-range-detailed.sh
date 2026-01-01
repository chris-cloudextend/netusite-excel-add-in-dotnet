#!/bin/bash

# Detailed Performance Test for Income Statement Period Ranges
# Tests different ranges and records detailed timing and results

echo "🧪 Detailed Income Statement Period Range Performance Test"
echo "=========================================================="
echo ""

SERVER_URL="http://localhost:5002"
ACCOUNT="4220"
TO_PERIOD="Dec 2025"

# Test ranges
declare -a TEST_RANGES=(
    "Jan 2025|1"
    "Jan 2024|2"
    "Jan 2023|3"
    "Jan 2022|4"
    "Jan 2021|5"
    "Jan 2020|6"
    "Jan 2019|7"
    "Jan 2018|8"
    "Jan 2017|9"
    "Jan 2016|10"
    "Jan 2015|11"
    "Jan 2014|12"
    "Jan 2013|13"
    "Jan 2012|14"
)

echo "📊 Testing account: $ACCOUNT"
echo "📅 To Period: $TO_PERIOD"
echo ""

echo "┌─────────────┬──────────┬──────────────┬──────────────┬──────────────────────┐"
echo "│ From Period │ Years    │ Time (sec)   │ Status       │ Balance              │"
echo "├─────────────┼──────────┼──────────────┼──────────────┼──────────────────────┤"

for range_info in "${TEST_RANGES[@]}"; do
    IFS='|' read -r from_period years <<< "$range_info"
    
    # Build request
    REQUEST_BODY=$(cat <<EOF
{
  "accounts": ["$ACCOUNT"],
  "from_period": "$from_period",
  "to_period": "$TO_PERIOD",
  "periods": []
}
EOF
)
    
    # Make request and measure time
    START_TIME=$(date +%s.%N)
    
    RESPONSE=$(curl -s -X POST \
        "$SERVER_URL/batch/balance" \
        -H "Content-Type: application/json" \
        -d "$REQUEST_BODY" \
        --max-time 300)
    
    END_TIME=$(date +%s.%N)
    ELAPSED=$(echo "$END_TIME - $START_TIME" | bc)
    
    # Parse response
    HTTP_CODE=$(echo "$RESPONSE" | jq -r '. // empty' 2>/dev/null | head -1 || echo "200")
    ERROR=$(echo "$RESPONSE" | jq -r '.error // "none"' 2>/dev/null || echo "parse_error")
    BALANCE=$(echo "$RESPONSE" | jq -r '.balances."4220" | to_entries[0].value // "N/A"' 2>/dev/null || echo "N/A")
    
    # Format balance
    if [ "$BALANCE" != "N/A" ] && [ "$BALANCE" != "null" ] && [ "$BALANCE" != "" ]; then
        BALANCE_FORMATTED=$(printf "$%.2f" "$BALANCE" 2>/dev/null || echo "$BALANCE")
    else
        BALANCE_FORMATTED="N/A"
    fi
    
    # Determine status
    if [ "$ERROR" != "none" ] && [ "$ERROR" != "null" ] && [ "$ERROR" != "" ]; then
        STATUS="❌ $ERROR"
    elif [ "$BALANCE" != "N/A" ] && [ "$BALANCE" != "null" ] && [ "$BALANCE" != "" ]; then
        STATUS="✅ Success"
    else
        STATUS="⚠️ Empty"
    fi
    
    # Format elapsed time
    ELAPSED_FORMATTED=$(printf "%.2f" "$ELAPSED")
    
    # Print row
    printf "│ %-11s │ %-8s │ %-12s │ %-12s │ %-20s │\n" \
        "$from_period" "$years" "$ELAPSED_FORMATTED" "$STATUS" "$BALANCE_FORMATTED"
    
    # Small delay between requests
    sleep 2
done

echo "└─────────────┴──────────┴──────────────┴──────────────┴──────────────────────┘"
echo ""
echo "=========================================================="
echo "Test complete"

