#!/bin/bash

# Test batch period activity query for 21 accounts across Feb-Mar 2025
# This tests the backend's batch period activity endpoint

ACCOUNTS="10010,10011,10012,10030,10031,10032,10033,10034,10200,10201,10202,10206,10400,10401,10403,10411,10413,10502,10804,10898,10899"
FROM_PERIOD="Feb 2025"
TO_PERIOD="Mar 2025"
SERVER_URL="https://netsuite-proxy.chris-corcoran.workers.dev"

echo "=========================================="
echo "Testing Batch Period Activity Query"
echo "=========================================="
echo ""
echo "Accounts: $ACCOUNTS"
echo "Period Range: $FROM_PERIOD → $TO_PERIOD"
echo ""

# Build URL with proper encoding
URL="${SERVER_URL}/balance?account=$(echo $ACCOUNTS | sed 's/,/%2C/g')&from_period=$(echo "$FROM_PERIOD" | sed 's/ /%20/g')&to_period=$(echo "$TO_PERIOD" | sed 's/ /%20/g')&batch_mode=true&include_period_breakdown=true"

echo "URL: $URL"
echo ""
echo "Making request..."
echo ""

# Make the request
curl -X GET "$URL" \
  -H "Content-Type: application/json" \
  -w "\n\nHTTP Status: %{http_code}\n" \
  -s | jq '.' || echo "Response is not valid JSON or jq is not installed"

echo ""
echo "=========================================="
echo "Test Complete"
echo "=========================================="
