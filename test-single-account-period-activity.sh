#!/bin/bash

# Test single account first to see if the endpoint works
ACCOUNT="10010"
FROM_PERIOD="Feb 2025"
TO_PERIOD="Mar 2025"
SERVER_URL="https://netsuite-proxy.chris-corcoran.workers.dev"

URL="${SERVER_URL}/balance?account=${ACCOUNT}&from_period=$(echo "$FROM_PERIOD" | sed 's/ /%20/g')&to_period=$(echo "$TO_PERIOD" | sed 's/ /%20/g')&batch_mode=true&include_period_breakdown=true"

echo "Testing single account: $URL"
echo ""

curl -s "$URL" | python3 -m json.tool 2>/dev/null || curl -s "$URL"
