#!/bin/bash

SERVER_URL="https://netsuite-proxy.chris-corcoran.workers.dev"
ACCOUNT="4220"

echo "=========================================="
echo "Testing Query Performance for Account $ACCOUNT"
echo "=========================================="
echo ""

# Test 1: Full range (Jan 2012 to Jan 2025 - 13 years)
echo "TEST 1: Full Range (Jan 2012 to Jan 2025)"
echo "------------------------------------------"
START1=$(date +%s.%N)
RESPONSE1=$(curl -s -w "\nHTTP_STATUS:%{http_code}\nTIME_TOTAL:%{time_total}\n" \
  "${SERVER_URL}/balance?account=${ACCOUNT}&from_period=Jan%202012&to_period=Jan%202025")
END1=$(date +%s.%N)
ELAPSED1=$(echo "$END1 - $START1" | bc)

HTTP_STATUS1=$(echo "$RESPONSE1" | grep "HTTP_STATUS" | cut -d: -f2)
TIME_TOTAL1=$(echo "$RESPONSE1" | grep "TIME_TOTAL" | cut -d: -f2)
BODY1=$(echo "$RESPONSE1" | sed '/HTTP_STATUS/d' | sed '/TIME_TOTAL/d')

echo "HTTP Status: $HTTP_STATUS1"
echo "Curl Time Total: ${TIME_TOTAL1}s"
echo "Elapsed Time: ${ELAPSED1}s"
echo "Response:"
echo "$BODY1" | head -10
echo ""

# Test 2: Just 2025 (Jan 2025 to Jan 2025 - 1 year)
echo "=========================================="
echo "TEST 2: Single Year (Jan 2025 to Jan 2025)"
echo "------------------------------------------"
START2=$(date +%s.%N)
RESPONSE2=$(curl -s -w "\nHTTP_STATUS:%{http_code}\nTIME_TOTAL:%{time_total}\n" \
  "${SERVER_URL}/balance?account=${ACCOUNT}&from_period=Jan%202025&to_period=Jan%202025")
END2=$(date +%s.%N)
ELAPSED2=$(echo "$END2 - $START2" | bc)

HTTP_STATUS2=$(echo "$RESPONSE2" | grep "HTTP_STATUS" | cut -d: -f2)
TIME_TOTAL2=$(echo "$RESPONSE2" | grep "TIME_TOTAL" | cut -d: -f2)
BODY2=$(echo "$RESPONSE2" | sed '/HTTP_STATUS/d' | sed '/TIME_TOTAL/d')

echo "HTTP Status: $HTTP_STATUS2"
echo "Curl Time Total: ${TIME_TOTAL2}s"
echo "Elapsed Time: ${ELAPSED2}s"
echo "Response:"
echo "$BODY2" | head -10
echo ""

# Test 3: Just 2025 using year endpoint (if available)
echo "=========================================="
echo "TEST 3: Single Year via /batch/balance/year (2025)"
echo "------------------------------------------"
START3=$(date +%s.%N)
RESPONSE3=$(curl -s -X POST -H "Content-Type: application/json" \
  -w "\nHTTP_STATUS:%{http_code}\nTIME_TOTAL:%{time_total}\n" \
  -d "{\"accounts\":[\"${ACCOUNT}\"],\"year\":2025}" \
  "${SERVER_URL}/batch/balance/year")
END3=$(date +%s.%N)
ELAPSED3=$(echo "$END3 - $START3" | bc)

HTTP_STATUS3=$(echo "$RESPONSE3" | grep "HTTP_STATUS" | cut -d: -f2)
TIME_TOTAL3=$(echo "$RESPONSE3" | grep "TIME_TOTAL" | cut -d: -f2)
BODY3=$(echo "$RESPONSE3" | sed '/HTTP_STATUS/d' | sed '/TIME_TOTAL/d')

echo "HTTP Status: $HTTP_STATUS3"
echo "Curl Time Total: ${TIME_TOTAL3}s"
echo "Elapsed Time: ${ELAPSED3}s"
echo "Response:"
echo "$BODY3" | head -10
echo ""

echo "=========================================="
echo "Summary"
echo "=========================================="
echo "Full Range (2012-2025): ${ELAPSED1}s - Status: $HTTP_STATUS1"
echo "Single Year (2025): ${ELAPSED2}s - Status: $HTTP_STATUS2"
echo "Year Endpoint (2025): ${ELAPSED3}s - Status: $HTTP_STATUS3"
