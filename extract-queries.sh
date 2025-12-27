#!/bin/bash
# Extract and display the actual SuiteQL queries with parameters filled in
# This script runs the test and saves the queries to files

BASE_URL="${BASE_URL:-http://localhost:5002}"
TEST_PERIOD="${TEST_PERIOD:-Feb 2025}"

echo "Extracting queries for period: $TEST_PERIOD"
echo ""

# Get period info
PERIOD_QUERY="SELECT id, periodname, startdate, enddate FROM accountingperiod WHERE periodname = '$TEST_PERIOD' AND isyear = 'F' AND isquarter = 'F' FETCH FIRST 1 ROWS ONLY"

PERIOD_RESPONSE=$(curl -s -X POST "$BASE_URL/test/query" \
  -H "Content-Type: application/json" \
  -d "{\"q\": \"$PERIOD_QUERY\", \"timeout\": 30}")

PERIOD_ID=$(echo "$PERIOD_RESPONSE" | jq -r '.results[0].id // empty')
END_DATE_RAW=$(echo "$PERIOD_RESPONSE" | jq -r '.results[0].enddate // empty' | cut -d'T' -f1)
# Convert date format from MM/DD/YYYY to YYYY-MM-DD if needed
if [[ "$END_DATE_RAW" =~ ^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$ ]]; then
  END_DATE=$(date -j -f "%m/%d/%Y" "$END_DATE_RAW" "+%Y-%m-%d" 2>/dev/null || echo "$END_DATE_RAW")
else
  END_DATE="$END_DATE_RAW"
fi

if [ -z "$PERIOD_ID" ] || [ "$PERIOD_ID" = "null" ]; then
  echo "ERROR: Could not find period '$TEST_PERIOD'"
  exit 1
fi

TARGET_SUB="1"
SUB_FILTER="1"

# Build queries
CURRENT_QUERY="SELECT 
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
                $TARGET_SUB,
                $PERIOD_ID,
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
  AND t.trandate <= TO_DATE('$END_DATE', 'YYYY-MM-DD')
  AND tal.accountingbook = 1
  AND tl.subsidiary IN ($SUB_FILTER)
GROUP BY a.acctnumber, a.accountsearchdisplaynamecopy, a.accttype
ORDER BY a.acctnumber"

PROPOSED_QUERY="SELECT 
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
                $TARGET_SUB,
                $PERIOD_ID,
                'DEFAULT'
            )
        ) * CASE WHEN a.accttype IN ('AcctPay', 'CredCard', 'OthCurrLiab', 'LongTermLiab', 'DeferRevenue', 'Equity', 'RetainedEarnings') THEN -1 ELSE 1 END
    ), 0) AS balance
FROM account a
LEFT JOIN transactionaccountingline tal ON tal.account = a.id
    AND tal.posting = 'T'
LEFT JOIN transaction t ON t.id = tal.transaction
    AND t.posting = 'T'
    AND t.trandate <= TO_DATE('$END_DATE', 'YYYY-MM-DD')
LEFT JOIN TransactionLine tl ON t.id = tl.transaction 
    AND tal.transactionline = tl.id
    AND tl.subsidiary IN ($SUB_FILTER)
WHERE a.accttype IN ('Bank', 'AcctRec', 'OthCurrAsset', 'FixedAsset', 'OthAsset', 'DeferExpense', 'UnbilledRec', 'AcctPay', 'CredCard', 'OthCurrLiab', 'LongTermLiab', 'DeferRevenue', 'Equity', 'RetainedEarnings')
  AND a.isinactive = 'F'
  AND (tal.accountingbook = 1 OR tal.accountingbook IS NULL)
GROUP BY a.acctnumber, a.accountsearchdisplaynamecopy, a.accttype
ORDER BY a.acctnumber"

# Save queries
echo "$CURRENT_QUERY" > current_query.sql
echo "$PROPOSED_QUERY" > proposed_query.sql

echo "✅ Queries extracted with parameters:"
echo "   Period ID: $PERIOD_ID"
echo "   End Date: $END_DATE"
echo "   Subsidiary: $TARGET_SUB"
echo ""
echo "📄 Queries saved to:"
echo "   - current_query.sql"
echo "   - proposed_query.sql"
echo ""
echo "=========================================="
echo "CURRENT QUERY (with parameters):"
echo "=========================================="
echo "$CURRENT_QUERY"
echo ""
echo "=========================================="
echo "PROPOSED QUERY (with parameters):"
echo "=========================================="
echo "$PROPOSED_QUERY"

