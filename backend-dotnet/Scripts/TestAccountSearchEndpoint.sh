#!/bin/bash
# Test script to hit the actual backend endpoint
# Usage: ./TestAccountSearchEndpoint.sh [pattern] [port]

PATTERN="${1:-Balance}"
PORT="${2:-5002}"
BASE_URL="http://localhost:${PORT}"

echo "=========================================="
echo "Testing Account Search Endpoint"
echo "=========================================="
echo "Pattern: '$PATTERN'"
echo "URL: ${BASE_URL}/accounts/search?pattern=${PATTERN}"
echo ""

# Test the endpoint
curl -s "${BASE_URL}/accounts/search?pattern=${PATTERN}" | python3 -m json.tool 2>/dev/null || curl -s "${BASE_URL}/accounts/search?pattern=${PATTERN}"

echo ""
echo ""
echo "=========================================="
echo "Testing with different patterns:"
echo "=========================================="

for test_pattern in "Balance" "Bank" "Income" "*" "100"; do
    echo ""
    echo "Pattern: '$test_pattern'"
    echo "Response:"
    curl -s "${BASE_URL}/accounts/search?pattern=${test_pattern}" | python3 -m json.tool 2>/dev/null | head -20 || curl -s "${BASE_URL}/accounts/search?pattern=${test_pattern}" | head -20
    echo ""
done

