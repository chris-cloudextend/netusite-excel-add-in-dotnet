#!/bin/bash
# Test script to query TYPEBALANCE batch endpoint and document results

BASE_URL="${1:-http://localhost:5000}"
YEAR="${2:-2025}"
SUBSIDIARY="${3:-Celigo India Pvt Ltd}"
BOOK="${4:-2}"

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  TYPEBALANCE BATCH QUERY TEST                                ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "Parameters:"
echo "  Base URL: $BASE_URL"
echo "  Year: $YEAR"
echo "  Subsidiary: $SUBSIDIARY"
echo "  Accounting Book: $BOOK"
echo ""

# Create request payload
PAYLOAD=$(cat <<EOF
{
  "year": $YEAR,
  "subsidiary": "$SUBSIDIARY",
  "department": null,
  "location": null,
  "class": null,
  "book": "$BOOK"
}
EOF
)

echo "Sending POST request to /batch/typebalance_refresh..."
echo ""

RESPONSE=$(curl -s -X POST "$BASE_URL/batch/typebalance_refresh" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")

if [ $? -ne 0 ]; then
    echo "❌ curl failed"
    exit 1
fi

# Check if response contains error
if echo "$RESPONSE" | grep -q '"error"'; then
    echo "❌ Error in response:"
    echo "$RESPONSE" | jq '.'
    exit 1
fi

# Extract and display results
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  RESULTS BY ACCOUNT TYPE AND PERIOD (2025)                  ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

ACCOUNT_TYPES=("Income" "COGS" "Expense" "OthIncome" "OthExpense")
MONTHS=("Jan 2025" "Feb 2025" "Mar 2025" "Apr 2025" "May 2025" "Jun 2025" "Jul 2025" "Aug 2025" "Sep 2025" "Oct 2025" "Nov 2025" "Dec 2025")

for TYPE in "${ACCOUNT_TYPES[@]}"; do
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "📊 $TYPE"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    
    TYPE_DATA=$(echo "$RESPONSE" | jq -r ".balances.$TYPE // empty")
    
    if [ -z "$TYPE_DATA" ] || [ "$TYPE_DATA" = "null" ]; then
        echo "  ❌ NOT FOUND IN RESULTS"
        echo ""
        continue
    fi
    
    TOTAL=0
    MONTHS_WITH_DATA=0
    
    for MONTH in "${MONTHS[@]}"; do
        VALUE=$(echo "$RESPONSE" | jq -r ".balances.$TYPE.\"$MONTH\" // 0")
        
        # Handle null values
        if [ "$VALUE" = "null" ] || [ -z "$VALUE" ]; then
            VALUE=0
        fi
        
        # Format value
        if (( $(echo "$VALUE != 0" | bc -l 2>/dev/null || echo "0") )); then
            VALUE_STR=$(printf "$%'.2f" $VALUE)
            INDICATOR="✅"
            MONTHS_WITH_DATA=$((MONTHS_WITH_DATA + 1))
            TOTAL=$(echo "$TOTAL + $VALUE" | bc -l)
        else
            VALUE_STR="$0.00"
            INDICATOR="  "
        fi
        
        printf "  %s %-12s : %15s\n" "$INDICATOR" "$MONTH" "$VALUE_STR"
    done
    
    echo "  ──────────── : ───────────────"
    TOTAL_STR=$(printf "$%'.2f" $TOTAL)
    printf "  TOTAL (12 months) : %15s (%d months with data)\n" "$TOTAL_STR" "$MONTHS_WITH_DATA"
    echo ""
done

# Summary
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  SUMMARY                                                    ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

for TYPE in "${ACCOUNT_TYPES[@]}"; do
    TYPE_DATA=$(echo "$RESPONSE" | jq -r ".balances.$TYPE // empty")
    
    if [ -z "$TYPE_DATA" ] || [ "$TYPE_DATA" = "null" ]; then
        printf "  ❌ %-12s : NOT FOUND\n" "$TYPE"
        continue
    fi
    
    TOTAL=0
    MONTHS_WITH_DATA=0
    
    for MONTH in "${MONTHS[@]}"; do
        VALUE=$(echo "$RESPONSE" | jq -r ".balances.$TYPE.\"$MONTH\" // 0")
        if [ "$VALUE" != "null" ] && [ -n "$VALUE" ] && (( $(echo "$VALUE != 0" | bc -l 2>/dev/null || echo "0") )); then
            MONTHS_WITH_DATA=$((MONTHS_WITH_DATA + 1))
            TOTAL=$(echo "$TOTAL + $VALUE" | bc -l)
        fi
    done
    
    TOTAL_STR=$(printf "$%'.2f" $TOTAL)
    STATUS="✅"
    if [ $MONTHS_WITH_DATA -eq 0 ]; then
        STATUS="❌"
    fi
    printf "  %s %-12s : %2d/12 months, Total: %15s\n" "$STATUS" "$TYPE" "$MONTHS_WITH_DATA" "$TOTAL_STR"
done

echo ""
echo "✅ Test complete"

