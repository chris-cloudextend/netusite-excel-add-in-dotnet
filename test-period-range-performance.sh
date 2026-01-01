#!/bin/bash

# Test Income Statement Period Range Performance
# Tests different period ranges and records query times

echo "🧪 Income Statement Period Range Performance Test"
echo "=================================================="
echo ""

SERVER_URL="https://netsuite-proxy.chris-corcoran.workers.dev"
ACCOUNT="4220"
TO_PERIOD="Dec 2025"

# Test ranges: 1 year, 2 years, 3 years, etc.
declare -a FROM_PERIODS=(
    "Jan 2025"  # 1 year
    "Jan 2024"  # 2 years
    "Jan 2023"  # 3 years
    "Jan 2022"  # 4 years
    "Jan 2021"  # 5 years
    "Jan 2020"  # 6 years
    "Jan 2019"  # 7 years
    "Jan 2018"  # 8 years
    "Jan 2017"  # 9 years
    "Jan 2016"  # 10 years
    "Jan 2015"  # 11 years
    "Jan 2014"  # 12 years
    "Jan 2013"  # 13 years
    "Jan 2012"  # 14 years
)

echo "📊 Testing account: $ACCOUNT"
echo "📅 To Period: $TO_PERIOD"
echo ""

# Function to calculate years between periods
calculate_years() {
    local from=$1
    local to=$2
    local from_year=$(echo "$from" | awk '{print $2}')
    local to_year=$(echo "$to" | awk '{print $2}')
    local from_month=$(echo "$from" | awk '{print $1}')
    local to_month=$(echo "$to" | awk '{print $1}')
    
    # Convert month names to numbers
    declare -A months=(
        ["Jan"]=1 ["Feb"]=2 ["Mar"]=3 ["Apr"]=4 ["May"]=5 ["Jun"]=6
        ["Jul"]=7 ["Aug"]=8 ["Sep"]=9 ["Oct"]=10 ["Nov"]=11 ["Dec"]=12
    )
    
    local from_num=$((from_year * 12 + ${months[$from_month]}))
    local to_num=$((to_year * 12 + ${months[$to_month]}))
    local diff=$((to_num - from_num + 1))
    local years=$(echo "scale=1; $diff / 12" | bc)
    
    echo "$years"
}

# Results array
declare -a RESULTS=()

echo "┌─────────────┬──────────────┬─────────────┬──────────────┬─────────────┐"
echo "│ From Period │ Range (years)│ Status Code │ Time (sec)   │ Result      │"
echo "├─────────────┼──────────────┼─────────────┼──────────────┼─────────────┤"

for from_period in "${FROM_PERIODS[@]}"; do
    years=$(calculate_years "$from_period" "$TO_PERIOD")
    
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
    
    RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
        "$SERVER_URL/batch/balance" \
        -H "Content-Type: application/json" \
        -d "$REQUEST_BODY" \
        --max-time 120)
    
    END_TIME=$(date +%s.%N)
    ELAPSED=$(echo "$END_TIME - $START_TIME" | bc)
    
    # Split response and status code
    HTTP_BODY=$(echo "$RESPONSE" | head -n -1)
    HTTP_CODE=$(echo "$RESPONSE" | tail -n 1)
    
    # Parse response
    ERROR=$(echo "$HTTP_BODY" | jq -r '.error // "none"' 2>/dev/null || echo "parse_error")
    BALANCE=$(echo "$HTTP_BODY" | jq -r '.balances."4220" | to_entries[0].value // "N/A"' 2>/dev/null || echo "N/A")
    
    # Determine result status
    if [ "$HTTP_CODE" = "200" ]; then
        if [ "$ERROR" != "none" ] && [ "$ERROR" != "null" ] && [ "$ERROR" != "" ]; then
            RESULT="ERROR: $ERROR"
        elif [ "$BALANCE" != "N/A" ] && [ "$BALANCE" != "null" ] && [ "$BALANCE" != "" ]; then
            RESULT="✅ Success"
        else
            RESULT="⚠️ Empty"
        fi
    else
        RESULT="❌ HTTP $HTTP_CODE"
    fi
    
    # Format elapsed time
    ELAPSED_FORMATTED=$(printf "%.2f" "$ELAPSED")
    
    # Print row
    printf "│ %-11s │ %-12s │ %-11s │ %-12s │ %-11s │\n" \
        "$from_period" "$years" "$HTTP_CODE" "$ELAPSED_FORMATTED" "$RESULT"
    
    # Store result
    RESULTS+=("$from_period|$years|$HTTP_CODE|$ELAPSED|$ERROR|$BALANCE")
    
    # If we hit a timeout, stop testing larger ranges
    if [ "$ERROR" = "TIMEOUT" ]; then
        echo "├─────────────┴──────────────┴─────────────┴──────────────┴─────────────┤"
        echo "⚠️  TIMEOUT detected at $from_period → $TO_PERIOD ($years years)"
        echo "   Stopping further tests (larger ranges will also timeout)"
        break
    fi
    
    # Small delay between requests
    sleep 1
done

echo "└─────────────┴──────────────┴─────────────┴──────────────┴─────────────┘"
echo ""

# Summary
echo "📊 Summary:"
echo "==========="
echo ""

TIMEOUT_FOUND=false
for result in "${RESULTS[@]}"; do
    IFS='|' read -r from years code elapsed error balance <<< "$result"
    if [ "$error" = "TIMEOUT" ]; then
        TIMEOUT_FOUND=true
        echo "❌ First timeout at: $from → $TO_PERIOD ($years years) - ${elapsed}s"
        break
    fi
done

if [ "$TIMEOUT_FOUND" = false ]; then
    echo "✅ No timeouts detected in tested ranges"
fi

echo ""
echo "📈 Performance Analysis:"
echo ""

# Show performance trend
for result in "${RESULTS[@]}"; do
    IFS='|' read -r from years code elapsed error balance <<< "$result"
    if [ "$error" != "TIMEOUT" ] && [ "$error" != "none" ] && [ "$error" != "null" ] && [ "$error" != "" ]; then
        continue
    fi
    printf "  %-11s → %-11s (%4s years): %6.2fs" "$from" "$TO_PERIOD" "$years" "$elapsed"
    if [ "$error" = "TIMEOUT" ]; then
        echo " ❌ TIMEOUT"
    elif [ "$balance" != "N/A" ] && [ "$balance" != "null" ] && [ "$balance" != "" ]; then
        echo " ✅"
    else
        echo " ⚠️"
    fi
done

echo ""
echo "=================================================="
echo "Test complete"

