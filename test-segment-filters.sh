#!/bin/bash
# Test if segment filters are excluding accounts 10413, 10206, 10411

BASE_URL="${BASE_URL:-http://localhost:5002}"
PERIOD="${PERIOD:-Jan 2025}"

echo "Testing if segment filters exclude accounts 10413, 10206, 10411..."
echo ""

# Get period info
PERIOD_RESPONSE=$(curl -s -X POST "$BASE_URL/test/query" \
  -H "Content-Type: application/json" \
  -d "{\"q\": \"SELECT id, periodname, startdate, enddate FROM accountingperiod WHERE periodname = '$PERIOD' AND isyear = 'F' AND isquarter = 'F' FETCH FIRST 1 ROWS ONLY\", \"timeout\": 30}")

PERIOD_ID=$(echo "$PERIOD_RESPONSE" | jq -r '.results[0].id // empty')
END_DATE_RAW=$(echo "$PERIOD_RESPONSE" | jq -r '.results[0].enddate // empty' | cut -d'T' -f1)
END_DATE=$(date -j -f "%m/%d/%Y" "$END_DATE_RAW" "+%Y-%m-%d" 2>/dev/null || echo "$END_DATE_RAW")

echo "Period ID: $PERIOD_ID"
echo "End Date: $END_DATE"
echo ""

# Test with segment filters (subsidiary filter in JOIN)
echo "Test: Query WITH segment filters (tl.subsidiary IN (1))..."
QUERY="SELECT a.acctnumber, COALESCE(SUM(CASE WHEN tl.id IS NOT NULL THEN TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', 1, $PERIOD_ID, 'DEFAULT')) ELSE 0 END), 0) AS balance FROM account a LEFT JOIN transactionaccountingline tal ON tal.account = a.id AND tal.posting = 'T' AND (tal.accountingbook = 1 OR tal.accountingbook IS NULL) LEFT JOIN transaction t ON t.id = tal.transaction AND t.posting = 'T' AND t.trandate <= TO_DATE('$END_DATE', 'YYYY-MM-DD') LEFT JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id AND tl.subsidiary IN (1) WHERE a.accttype IN ('Bank') AND a.isinactive = 'F' AND a.acctnumber IN ('10413', '10206', '10411') GROUP BY a.acctnumber ORDER BY a.acctnumber"

QUERY_ESCAPED=$(echo "$QUERY" | sed 's/"/\\"/g')
RESPONSE=$(curl -s -X POST "$BASE_URL/test/query" \
  -H "Content-Type: application/json" \
  -d "{\"q\": \"$QUERY_ESCAPED\", \"timeout\": 180}")

ERROR=$(echo "$RESPONSE" | jq -r '.error // empty' 2>/dev/null)
if [ -n "$ERROR" ] && [ "$ERROR" != "null" ]; then
    echo "  ❌ Query failed: $ERROR"
    echo ""
    echo "This suggests NetSuite doesn't support CASE WHEN inside SUM with LEFT JOINs."
    echo "We may need a different approach."
else
    COUNT=$(echo "$RESPONSE" | jq '.row_count // (.results | length)' 2>/dev/null)
    echo "  ✅ Query succeeded: $COUNT accounts returned"
    echo ""
    echo "Results:"
    echo "$RESPONSE" | jq -r '.results[]? | "    \(.acctnumber): balance = \(.balance)"' 2>/dev/null
    
    echo ""
    echo "Checking if all 3 accounts are present:"
    for ACCT in 10413 10206 10411; do
        ACCT_INFO=$(echo "$RESPONSE" | jq -r ".results[]? | select(.acctnumber == \"$ACCT\")" 2>/dev/null)
        if [ -z "$ACCT_INFO" ] || [ "$ACCT_INFO" = "null" ]; then
            echo "  ❌ Account $ACCT: NOT RETURNED"
        else
            BALANCE=$(echo "$ACCT_INFO" | jq -r '.balance // "0"' 2>/dev/null)
            echo "  ✅ Account $ACCT: RETURNED with balance = $BALANCE"
        fi
    done
fi

