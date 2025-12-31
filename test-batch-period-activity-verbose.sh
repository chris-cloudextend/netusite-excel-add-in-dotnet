#!/bin/bash

# Test batch period activity query with verbose output
ACCOUNTS="10010,10011,10012,10030,10031,10032,10033,10034,10200,10201,10202,10206,10400,10401,10403,10411,10413,10502,10804,10898,10899"
FROM_PERIOD="Feb 2025"
TO_PERIOD="Mar 2025"
SERVER_URL="https://netsuite-proxy.chris-corcoran.workers.dev"

# Build URL
URL="${SERVER_URL}/balance?account=$(echo $ACCOUNTS | sed 's/,/%2C/g')&from_period=$(echo "$FROM_PERIOD" | sed 's/ /%20/g')&to_period=$(echo "$TO_PERIOD" | sed 's/ /%20/g')&batch_mode=true&include_period_breakdown=true"

echo "Testing: $URL"
echo ""

# Make request with verbose output
curl -v "$URL" 2>&1 | head -50
