#!/bin/bash

# Test script to verify 114 accounts in a single request for Q1, Q2, Q3, Q4
# This tests whether the backend can handle all 114 accounts without chunking

BACKEND_URL="${1:-http://localhost:5002}"

# All 114 accounts from the user's logs
ACCOUNTS=(
  "4230" "40290" "4270" "4220" "4451" "4620" "4401" "4600" "4231" "4712"
  "4623" "4810" "4628" "4710" "50005" "50102" "4621" "4624" "4622" "50199"
  "49998" "50202" "4611" "49000" "50203" "50204" "50103" "50205" "50299" "60010"
  "60011" "60020" "50200" "60100" "60200" "59999" "60210" "60300" "60042" "60305"
  "60040" "60955" "60960" "60905" "60980" "60032" "60990" "60030" "60910" "61004"
  "61006" "61005" "61001" "61007" "61003" "60201" "60031" "60950" "62104" "62107"
  "64011" "64010" "64030" "64045" "64022" "64060" "62105" "65005" "65021" "65030"
  "65002" "65003" "65035" "64020" "65040" "66011" "66015" "65001" "65020" "66020"
  "67105" "66005" "66010" "67115" "67205" "67800" "67100" "67210" "68010" "68012"
  "68015" "68017" "68100" "68013" "68300" "68200" "69999" "68101" "68014" "80030"
  "66025" "80110" "80045" "80020" "80040" "80115" "70000" "89200" "89002" "70005"
  "89000" "68104" "89100" "80005"
)

echo "=========================================="
echo "Testing 114 Accounts in Single Request"
echo "Backend: $BACKEND_URL"
echo "=========================================="
echo ""

# Test each quarter
for QUARTER in "Q1" "Q2" "Q3" "Q4"; do
  case $QUARTER in
    "Q1")
      FROM_PERIOD="Jan 2025"
      TO_PERIOD="Mar 2025"
      ;;
    "Q2")
      FROM_PERIOD="Apr 2025"
      TO_PERIOD="Jun 2025"
      ;;
    "Q3")
      FROM_PERIOD="Jul 2025"
      TO_PERIOD="Sep 2025"
      ;;
    "Q4")
      FROM_PERIOD="Oct 2025"
      TO_PERIOD="Dec 2025"
      ;;
  esac

  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "Testing $QUARTER: $FROM_PERIOD → $TO_PERIOD"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""

  # Build JSON request body
  JSON_BODY=$(cat <<EOF
{
  "accounts": [
$(printf '    "%s",\n' "${ACCOUNTS[@]}" | sed '$s/,$//')
  ],
  "from_period": "$FROM_PERIOD",
  "to_period": "$TO_PERIOD",
  "periods": [],
  "book": "1"
}
EOF
)

  echo "📤 Sending request with ${#ACCOUNTS[@]} accounts..."
  echo "   Period range: $FROM_PERIOD to $TO_PERIOD"
  echo ""

  START_TIME=$(date +%s.%N)
  
  # Make the API call
  RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BACKEND_URL/batch/balance" \
    -H "Content-Type: application/json" \
    -d "$JSON_BODY")
  
  END_TIME=$(date +%s.%N)
  ELAPSED=$(echo "$END_TIME - $START_TIME" | bc)
  
  # Extract HTTP status code (last line)
  HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
  BODY=$(echo "$RESPONSE" | sed '$d')
  
  echo "📥 Response received in ${ELAPSED}s"
  echo "   HTTP Status: $HTTP_CODE"
  echo ""
  
  if [ "$HTTP_CODE" = "200" ]; then
    # Count accounts in response
    ACCOUNT_COUNT=$(echo "$BODY" | jq -r '.balances | length' 2>/dev/null || echo "0")
    ERROR_COUNT=$(echo "$BODY" | jq -r '[.balances[] | select(.error != null)] | length' 2>/dev/null || echo "0")
    
    echo "✅ SUCCESS!"
    echo "   Accounts returned: $ACCOUNT_COUNT"
    echo "   Errors: $ERROR_COUNT"
    
    # Show first few results
    echo ""
    echo "   Sample results (first 5):"
    echo "$BODY" | jq -r '.balances[0:5] | .[] | "      \(.account): \(.balance // "ERROR: \(.error // "unknown")")"' 2>/dev/null || echo "      (Could not parse response)"
    
    # Save full response
    echo "$BODY" | jq '.' > "test-114-accounts-${QUARTER}-response.json" 2>/dev/null
    echo ""
    echo "   Full response saved to: test-114-accounts-${QUARTER}-response.json"
  else
    echo "❌ FAILED!"
    echo "   Error response:"
    echo "$BODY" | jq '.' 2>/dev/null || echo "$BODY"
    
    # Save error response
    echo "$BODY" > "test-114-accounts-${QUARTER}-error.json"
    echo ""
    echo "   Error saved to: test-114-accounts-${QUARTER}-error.json"
  fi
  
  echo ""
  echo ""
done

echo "=========================================="
echo "Test Complete"
echo "=========================================="
