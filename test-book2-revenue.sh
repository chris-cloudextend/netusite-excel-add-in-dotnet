#!/bin/bash
# Test script to verify backend returns revenue data for Book 2, India subsidiary

SERVER_URL="http://localhost:5002"
ACCOUNTING_BOOK="2"
SUBSIDIARY_NAME="Celigo India Pvt Ltd"
YEAR="2025"

echo "=========================================="
echo "Testing Revenue Data for Book 2"
echo "=========================================="
echo "Server: $SERVER_URL"
echo "Accounting Book: $ACCOUNTING_BOOK"
echo "Subsidiary: $SUBSIDIARY_NAME"
echo "Year: $YEAR"
echo ""

# Step 1: Get subsidiary ID
echo "Step 1: Getting subsidiary ID..."
SUBSIDIARY_RESPONSE=$(curl -s "${SERVER_URL}/lookups/accountingbook/${ACCOUNTING_BOOK}/subsidiaries")
echo "Response: $SUBSIDIARY_RESPONSE" | jq '.' 2>/dev/null || echo "$SUBSIDIARY_RESPONSE"

SUBSIDIARY_ID=$(echo "$SUBSIDIARY_RESPONSE" | jq -r '.subsidiaries[] | select(.name == "'"$SUBSIDIARY_NAME"'") | .id' 2>/dev/null)

if [ -z "$SUBSIDIARY_ID" ]; then
    # Try to get first subsidiary from the list
    SUBSIDIARY_ID=$(echo "$SUBSIDIARY_RESPONSE" | jq -r '.subsidiaries[0].id' 2>/dev/null)
    SUBSIDIARY_NAME=$(echo "$SUBSIDIARY_RESPONSE" | jq -r '.subsidiaries[0].name' 2>/dev/null)
    echo "⚠️  Using first subsidiary from list: $SUBSIDIARY_NAME (ID: $SUBSIDIARY_ID)"
fi

if [ -z "$SUBSIDIARY_ID" ] || [ "$SUBSIDIARY_ID" == "null" ]; then
    echo "❌ ERROR: Could not find subsidiary ID"
    exit 1
fi

echo "✅ Subsidiary ID: $SUBSIDIARY_ID"
echo ""

# Step 2: Test TYPEBALANCE endpoint
echo "Step 2: Testing TYPEBALANCE endpoint..."
echo "POST ${SERVER_URL}/batch/typebalance_refresh"
echo "Payload: { year: $YEAR, subsidiary: \"$SUBSIDIARY_NAME\", accountingBook: $ACCOUNTING_BOOK }"
echo ""

TYPEBALANCE_RESPONSE=$(curl -s -X POST "${SERVER_URL}/batch/typebalance_refresh" \
    -H "Content-Type: application/json" \
    -d "{
        \"year\": $YEAR,
        \"subsidiary\": \"$SUBSIDIARY_NAME\",
        \"accountingBook\": \"$ACCOUNTING_BOOK\"
    }")

echo "Response:"
echo "$TYPEBALANCE_RESPONSE" | jq '.' 2>/dev/null || echo "$TYPEBALANCE_RESPONSE"
echo ""

# Step 3: Extract Income (Revenue) data
echo "Step 3: Extracting Income (Revenue) data..."
INCOME_DATA=$(echo "$TYPEBALANCE_RESPONSE" | jq '.balances.Income' 2>/dev/null)

if [ -z "$INCOME_DATA" ] || [ "$INCOME_DATA" == "null" ]; then
    echo "❌ ERROR: No Income data in response"
    exit 1
fi

echo "Income data:"
echo "$INCOME_DATA" | jq '.' 2>/dev/null || echo "$INCOME_DATA"
echo ""

# Step 4: Check for non-zero values
echo "Step 4: Checking for non-zero revenue values..."
PERIODS_WITH_DATA=0
TOTAL_REVENUE=0

for period in "Jan 2025" "Feb 2025" "Mar 2025" "Apr 2025" "May 2025" "Jun 2025" \
              "Jul 2025" "Aug 2025" "Sep 2025" "Oct 2025" "Nov 2025" "Dec 2025"; do
    VALUE=$(echo "$INCOME_DATA" | jq -r ".[\"$period\"]" 2>/dev/null || echo "0")
    if [ "$VALUE" != "null" ] && [ "$VALUE" != "0" ] && [ -n "$VALUE" ]; then
        PERIODS_WITH_DATA=$((PERIODS_WITH_DATA + 1))
        TOTAL_REVENUE=$(echo "$TOTAL_REVENUE + $VALUE" | bc 2>/dev/null || echo "$TOTAL_REVENUE")
        echo "  ✅ $period: \$$(printf "%.2f" $VALUE | sed ':a;s/\B[0-9]\{3\}\>/,&/;ta')"
    else
        echo "  ❌ $period: \$0.00 (or null)"
    fi
done

echo ""
echo "=========================================="
echo "Summary"
echo "=========================================="
echo "Periods with data: $PERIODS_WITH_DATA/12"
echo "Total Revenue: \$$(printf "%.2f" $TOTAL_REVENUE | sed ':a;s/\B[0-9]\{3\}\>/,&/;ta')"
echo ""

if [ $PERIODS_WITH_DATA -eq 0 ]; then
    echo "❌ ERROR: No revenue data found for Book 2, India subsidiary"
    exit 1
elif [ $PERIODS_WITH_DATA -lt 12 ]; then
    echo "⚠️  WARNING: Only $PERIODS_WITH_DATA/12 periods have data"
else
    echo "✅ SUCCESS: All 12 periods have revenue data"
fi

