#!/bin/bash
# Direct test of queries with proper JSON escaping

BASE_URL="${BASE_URL:-http://localhost:5002}"
TEST_PERIOD="${TEST_PERIOD:-Feb 2025}"

echo "Testing BS Preload Queries"
echo "Period: $TEST_PERIOD"
echo ""

# Get period info
PERIOD_RESPONSE=$(curl -s -X POST "$BASE_URL/test/query" \
  -H "Content-Type: application/json" \
  -d '{"q": "SELECT id, periodname, startdate, enddate FROM accountingperiod WHERE periodname = '\''Feb 2025'\'' AND isyear = '\''F'\'' AND isquarter = '\''F'\'' FETCH FIRST 1 ROWS ONLY", "timeout": 30}')

PERIOD_ID=$(echo "$PERIOD_RESPONSE" | jq -r '.results[0].id // empty')
END_DATE_RAW=$(echo "$PERIOD_RESPONSE" | jq -r '.results[0].enddate // empty' | cut -d'T' -f1)

if [[ "$END_DATE_RAW" =~ ^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$ ]]; then
  END_DATE=$(date -j -f "%m/%d/%Y" "$END_DATE_RAW" "+%Y-%m-%d" 2>/dev/null || echo "$END_DATE_RAW")
else
  END_DATE="$END_DATE_RAW"
fi

echo "Period ID: $PERIOD_ID"
echo "End Date: $END_DATE"
echo ""

# Build queries as single-line strings
CURRENT_QUERY="SELECT a.acctnumber, a.accountsearchdisplaynamecopy AS account_name, a.accttype, SUM(TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', 1, $PERIOD_ID, 'DEFAULT')) * CASE WHEN a.accttype IN ('AcctPay', 'CredCard', 'OthCurrLiab', 'LongTermLiab', 'DeferRevenue', 'Equity', 'RetainedEarnings') THEN -1 ELSE 1 END) AS balance FROM transactionaccountingline tal JOIN transaction t ON t.id = tal.transaction JOIN account a ON a.id = tal.account JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id WHERE t.posting = 'T' AND tal.posting = 'T' AND a.accttype IN ('Bank', 'AcctRec', 'OthCurrAsset', 'FixedAsset', 'OthAsset', 'DeferExpense', 'UnbilledRec', 'AcctPay', 'CredCard', 'OthCurrLiab', 'LongTermLiab', 'DeferRevenue', 'Equity', 'RetainedEarnings') AND t.trandate <= TO_DATE('$END_DATE', 'YYYY-MM-DD') AND tal.accountingbook = 1 AND tl.subsidiary IN (1) GROUP BY a.acctnumber, a.accountsearchdisplaynamecopy, a.accttype ORDER BY a.acctnumber"

PROPOSED_QUERY="SELECT a.acctnumber, a.accountsearchdisplaynamecopy AS account_name, a.accttype, COALESCE(SUM(TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', 1, $PERIOD_ID, 'DEFAULT')) * CASE WHEN a.accttype IN ('AcctPay', 'CredCard', 'OthCurrLiab', 'LongTermLiab', 'DeferRevenue', 'Equity', 'RetainedEarnings') THEN -1 ELSE 1 END), 0) AS balance FROM account a LEFT JOIN transactionaccountingline tal ON tal.account = a.id AND tal.posting = 'T' LEFT JOIN transaction t ON t.id = tal.transaction AND t.posting = 'T' AND t.trandate <= TO_DATE('$END_DATE', 'YYYY-MM-DD') LEFT JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id AND tl.subsidiary IN (1) WHERE a.accttype IN ('Bank', 'AcctRec', 'OthCurrAsset', 'FixedAsset', 'OthAsset', 'DeferExpense', 'UnbilledRec', 'AcctPay', 'CredCard', 'OthCurrLiab', 'LongTermLiab', 'DeferRevenue', 'Equity', 'RetainedEarnings') AND a.isinactive = 'F' AND (tal.accountingbook = 1 OR tal.accountingbook IS NULL) GROUP BY a.acctnumber, a.accountsearchdisplaynamecopy, a.accttype ORDER BY a.acctnumber"

echo "Testing CURRENT query..."
CURRENT_START=$(date +%s)
CURRENT_RESPONSE=$(curl -s -X POST "$BASE_URL/test/query" \
  -H "Content-Type: application/json" \
  -d "{\"q\": \"$CURRENT_QUERY\", \"timeout\": 180}")
CURRENT_END=$(date +%s)
CURRENT_TIME=$((CURRENT_END - CURRENT_START))

CURRENT_ERROR=$(echo "$CURRENT_RESPONSE" | jq -r '.error // empty')
if [ -n "$CURRENT_ERROR" ] && [ "$CURRENT_ERROR" != "null" ]; then
  echo "  ❌ ERROR: $CURRENT_ERROR"
  echo "$CURRENT_RESPONSE" | jq '.'
else
  CURRENT_COUNT=$(echo "$CURRENT_RESPONSE" | jq '.row_count // (.results | length)')
  echo "  ✅ Completed in ${CURRENT_TIME}s"
  echo "  Accounts: $CURRENT_COUNT"
fi

echo ""
echo "Testing PROPOSED query..."
PROPOSED_START=$(date +%s)
PROPOSED_RESPONSE=$(curl -s -X POST "$BASE_URL/test/query" \
  -H "Content-Type: application/json" \
  -d "{\"q\": \"$PROPOSED_QUERY\", \"timeout\": 180}")
PROPOSED_END=$(date +%s)
PROPOSED_TIME=$((PROPOSED_END - PROPOSED_START))

PROPOSED_ERROR=$(echo "$PROPOSED_RESPONSE" | jq -r '.error // empty')
if [ -n "$PROPOSED_ERROR" ] && [ "$PROPOSED_ERROR" != "null" ]; then
  echo "  ❌ ERROR: $PROPOSED_ERROR"
  echo "$PROPOSED_RESPONSE" | jq '.'
else
  PROPOSED_COUNT=$(echo "$PROPOSED_RESPONSE" | jq '.row_count // (.results | length)')
  echo "  ✅ Completed in ${PROPOSED_TIME}s"
  echo "  Accounts: $PROPOSED_COUNT"
fi

echo ""
echo "=========================================="
echo "Results"
echo "=========================================="
echo "Current:  ${CURRENT_TIME}s, $CURRENT_COUNT accounts"
echo "Proposed: ${PROPOSED_TIME}s, $PROPOSED_COUNT accounts"

if [ "$PROPOSED_COUNT" -gt "$CURRENT_COUNT" ]; then
  echo "✅ Proposed returns MORE accounts"
fi

# Save formatted queries
cat > current_query_formatted.sql << 'EOF'
SELECT 
    a.acctnumber,
    a.accountsearchdisplaynamecopy AS account_name,
    a.accttype,
    SUM(
        TO_NUMBER(
            BUILTIN.CONSOLIDATE(
                tal.amount,
                'LEDGER',
                'DEFAULT',
                'DEFAULT',
                1,
                345,
                'DEFAULT'
            )
        ) * CASE WHEN a.accttype IN ('AcctPay', 'CredCard', 'OthCurrLiab', 'LongTermLiab', 'DeferRevenue', 'Equity', 'RetainedEarnings') THEN -1 ELSE 1 END
    ) AS balance
FROM transactionaccountingline tal
JOIN transaction t ON t.id = tal.transaction
JOIN account a ON a.id = tal.account
JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
WHERE t.posting = 'T'
  AND tal.posting = 'T'
  AND a.accttype IN ('Bank', 'AcctRec', 'OthCurrAsset', 'FixedAsset', 'OthAsset', 'DeferExpense', 'UnbilledRec', 'AcctPay', 'CredCard', 'OthCurrLiab', 'LongTermLiab', 'DeferRevenue', 'Equity', 'RetainedEarnings')
  AND t.trandate <= TO_DATE('2025-02-28', 'YYYY-MM-DD')
  AND tal.accountingbook = 1
  AND tl.subsidiary IN (1)
GROUP BY a.acctnumber, a.accountsearchdisplaynamecopy, a.accttype
ORDER BY a.acctnumber
EOF

cat > proposed_query_formatted.sql << 'EOF'
SELECT 
    a.acctnumber,
    a.accountsearchdisplaynamecopy AS account_name,
    a.accttype,
    COALESCE(SUM(
        TO_NUMBER(
            BUILTIN.CONSOLIDATE(
                tal.amount,
                'LEDGER',
                'DEFAULT',
                'DEFAULT',
                1,
                345,
                'DEFAULT'
            )
        ) * CASE WHEN a.accttype IN ('AcctPay', 'CredCard', 'OthCurrLiab', 'LongTermLiab', 'DeferRevenue', 'Equity', 'RetainedEarnings') THEN -1 ELSE 1 END
    ), 0) AS balance
FROM account a
LEFT JOIN transactionaccountingline tal ON tal.account = a.id
    AND tal.posting = 'T'
LEFT JOIN transaction t ON t.id = tal.transaction
    AND t.posting = 'T'
    AND t.trandate <= TO_DATE('2025-02-28', 'YYYY-MM-DD')
LEFT JOIN TransactionLine tl ON t.id = tl.transaction 
    AND tal.transactionline = tl.id
    AND tl.subsidiary IN (1)
WHERE a.accttype IN ('Bank', 'AcctRec', 'OthCurrAsset', 'FixedAsset', 'OthAsset', 'DeferExpense', 'UnbilledRec', 'AcctPay', 'CredCard', 'OthCurrLiab', 'LongTermLiab', 'DeferRevenue', 'Equity', 'RetainedEarnings')
  AND a.isinactive = 'F'
  AND (tal.accountingbook = 1 OR tal.accountingbook IS NULL)
GROUP BY a.acctnumber, a.accountsearchdisplaynamecopy, a.accttype
ORDER BY a.acctnumber
EOF

echo ""
echo "Formatted queries saved to:"
echo "  - current_query_formatted.sql"
echo "  - proposed_query_formatted.sql"

