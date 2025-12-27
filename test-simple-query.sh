#!/bin/bash
# Test a simpler version of the query to see what NetSuite supports

BASE_URL="${BASE_URL:-http://localhost:5002}"
PERIOD="${PERIOD:-Jan 2025}"

echo "Testing simpler query patterns..."
echo ""

# Get period info
PERIOD_RESPONSE=$(curl -s -X POST "$BASE_URL/test/query" \
  -H "Content-Type: application/json" \
  -d "{\"q\": \"SELECT id, periodname, startdate, enddate FROM accountingperiod WHERE periodname = '$PERIOD' AND isyear = 'F' AND isquarter = 'F' FETCH FIRST 1 ROWS ONLY\", \"timeout\": 30}")

PERIOD_ID=$(echo "$PERIOD_RESPONSE" | jq -r '.results[0].id // empty')
END_DATE_RAW=$(echo "$PERIOD_RESPONSE" | jq -r '.results[0].enddate // empty' | cut -d'T' -f1)

# Convert date format
END_DATE=$(date -j -f "%m/%d/%Y" "$END_DATE_RAW" "+%Y-%m-%d" 2>/dev/null || echo "$END_DATE_RAW")

echo "Period ID: $PERIOD_ID"
echo "End Date: $END_DATE"
echo ""

# Test 1: Simple LEFT JOIN without CASE in SUM
echo "Test 1: Simple LEFT JOIN (no CASE in SUM)..."
QUERY1="SELECT a.acctnumber, COALESCE(SUM(TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', 1, $PERIOD_ID, 'DEFAULT'))), 0) AS balance FROM account a LEFT JOIN transactionaccountingline tal ON tal.account = a.id AND tal.posting = 'T' LEFT JOIN transaction t ON t.id = tal.transaction AND t.posting = 'T' AND t.trandate <= TO_DATE('$END_DATE', 'YYYY-MM-DD') WHERE a.accttype IN ('Bank') AND a.isinactive = 'F' AND a.acctnumber IN ('10413', '10206', '10411') GROUP BY a.acctnumber ORDER BY a.acctnumber"

QUERY1_ESCAPED=$(echo "$QUERY1" | sed 's/"/\\"/g')
RESPONSE1=$(curl -s -X POST "$BASE_URL/test/query" \
  -H "Content-Type: application/json" \
  -d "{\"q\": \"$QUERY1_ESCAPED\", \"timeout\": 180}")

ERROR1=$(echo "$RESPONSE1" | jq -r '.error // empty' 2>/dev/null)
if [ -n "$ERROR1" ] && [ "$ERROR1" != "null" ]; then
    echo "  ❌ Failed: $ERROR1"
else
    COUNT1=$(echo "$RESPONSE1" | jq '.row_count // (.results | length)' 2>/dev/null)
    echo "  ✅ Success: $COUNT1 accounts returned"
    echo "$RESPONSE1" | jq -r '.results[]? | "    \(.acctnumber): \(.balance)"' 2>/dev/null
fi

echo ""

