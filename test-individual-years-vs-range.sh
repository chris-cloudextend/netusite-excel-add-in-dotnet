#!/bin/bash

# Test: Individual year queries vs single range query
# Hypothesis: Summing individual years may be faster than single range query

echo "🧪 Testing: Individual Years vs Single Range Query"
echo "=================================================="
echo ""

SERVER_URL="http://localhost:5002"
ACCOUNT="4220"

echo "📊 Test: 2023 + 2024 + 2025"
echo ""

# Test individual years
echo "1️⃣ Individual Year Queries:"
echo "----------------------------"

TOTAL_TIME=0
TOTAL_BALANCE=0

# Year 2023
echo -n "   Jan 2023 - Dec 2023: "
START=$(date +%s.%N)
RESPONSE=$(curl -s -X POST "$SERVER_URL/batch/balance" \
    -H "Content-Type: application/json" \
    -d '{"accounts":["4220"],"from_period":"Jan 2023","to_period":"Dec 2023","periods":[]}')
END=$(date +%s.%N)
ELAPSED=$(echo "$END - $START" | bc)
TOTAL_TIME=$(echo "$TOTAL_TIME + $ELAPSED" | bc)
BALANCE=$(echo "$RESPONSE" | jq -r '.balances."4220" | to_entries[0].value // 0' 2>/dev/null || echo "0")
TOTAL_BALANCE=$(echo "$TOTAL_BALANCE + $BALANCE" | bc)
printf "%.2fs, Balance: $%.2f\n" "$ELAPSED" "$BALANCE"

# Year 2024
echo -n "   Jan 2024 - Dec 2024: "
START=$(date +%s.%N)
RESPONSE=$(curl -s -X POST "$SERVER_URL/batch/balance" \
    -H "Content-Type: application/json" \
    -d '{"accounts":["4220"],"from_period":"Jan 2024","to_period":"Dec 2024","periods":[]}')
END=$(date +%s.%N)
ELAPSED=$(echo "$END - $START" | bc)
TOTAL_TIME=$(echo "$TOTAL_TIME + $ELAPSED" | bc)
BALANCE=$(echo "$RESPONSE" | jq -r '.balances."4220" | to_entries[0].value // 0' 2>/dev/null || echo "0")
TOTAL_BALANCE=$(echo "$TOTAL_BALANCE + $BALANCE" | bc)
printf "%.2fs, Balance: $%.2f\n" "$ELAPSED" "$BALANCE"

# Year 2025
echo -n "   Jan 2025 - Dec 2025: "
START=$(date +%s.%N)
RESPONSE=$(curl -s -X POST "$SERVER_URL/batch/balance" \
    -H "Content-Type: application/json" \
    -d '{"accounts":["4220"],"from_period":"Jan 2025","to_period":"Dec 2025","periods":[]}')
END=$(date +%s.%N)
ELAPSED=$(echo "$END - $START" | bc)
TOTAL_TIME=$(echo "$TOTAL_TIME + $ELAPSED" | bc)
BALANCE=$(echo "$RESPONSE" | jq -r '.balances."4220" | to_entries[0].value // 0' 2>/dev/null || echo "0")
TOTAL_BALANCE=$(echo "$TOTAL_BALANCE + $BALANCE" | bc)
printf "%.2fs, Balance: $%.2f\n" "$ELAPSED" "$BALANCE"

echo ""
printf "   Total Time: %.2fs\n" "$TOTAL_TIME"
printf "   Total Balance: $%.2f\n" "$TOTAL_BALANCE"
echo ""

# Test single range query
echo "2️⃣ Single Range Query (2023-2025):"
echo "----------------------------------"
START=$(date +%s.%N)
RESPONSE=$(curl -s -X POST "$SERVER_URL/batch/balance" \
    -H "Content-Type: application/json" \
    -d '{"accounts":["4220"],"from_period":"Jan 2023","to_period":"Dec 2025","periods":[]}')
END=$(date +%s.%N)
ELAPSED=$(echo "$END - $START" | bc)
RANGE_BALANCE=$(echo "$RESPONSE" | jq -r '.balances."4220" | to_entries[0].value // 0' 2>/dev/null || echo "0")
printf "   Time: %.2fs\n" "$ELAPSED"
printf "   Balance: $%.2f\n" "$RANGE_BALANCE"
echo ""

# Comparison
echo "📊 Comparison:"
echo "=============="
printf "Individual Years: %.2fs\n" "$TOTAL_TIME"
printf "Single Range:     %.2fs\n" "$ELAPSED"
SPEEDUP=$(echo "scale=2; $ELAPSED / $TOTAL_TIME" | bc)
if (( $(echo "$TOTAL_TIME < $ELAPSED" | bc -l) )); then
    printf "✅ Individual years are %.2fx FASTER\n" "$SPEEDUP"
else
    printf "❌ Single range is %.2fx FASTER\n" "$(echo "scale=2; 1/$SPEEDUP" | bc)"
fi

echo ""
BALANCE_DIFF=$(echo "$TOTAL_BALANCE - $RANGE_BALANCE" | bc | awk '{if ($1<0) print -$1; else print $1}')
if (( $(echo "$BALANCE_DIFF < 0.01" | bc -l) )); then
    echo "✅ Balance matches (difference: $BALANCE_DIFF)"
else
    echo "⚠️  Balance mismatch! Individual: $TOTAL_BALANCE, Range: $RANGE_BALANCE"
fi

echo ""
echo "=================================================="

