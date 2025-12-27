#!/bin/bash
# Test the actual bs_preload query to see if accounts 10413, 10206, 10411 are returned

BASE_URL="${BASE_URL:-http://localhost:5002}"
PERIOD="${PERIOD:-Jan 2025}"

echo "Testing BS Preload query for period: $PERIOD"
echo "Checking if accounts 10413, 10206, 10411 are returned..."
echo ""

# First, get period info
echo "Getting period info..."
PERIOD_RESPONSE=$(curl -s -X POST "$BASE_URL/test/query" \
  -H "Content-Type: application/json" \
  -d "{\"q\": \"SELECT id, periodname, startdate, enddate FROM accountingperiod WHERE periodname = '$PERIOD' AND isyear = 'F' AND isquarter = 'F' FETCH FIRST 1 ROWS ONLY\", \"timeout\": 30}")

PERIOD_ID=$(echo "$PERIOD_RESPONSE" | jq -r '.results[0].id // empty')
END_DATE_RAW=$(echo "$PERIOD_RESPONSE" | jq -r '.results[0].enddate // empty' | cut -d'T' -f1)

if [ -z "$PERIOD_ID" ]; then
    echo "❌ Could not find period $PERIOD"
    exit 1
fi

echo "Period ID: $PERIOD_ID"
echo "End Date: $END_DATE_RAW"
echo ""

# Build the actual bs_preload query (simplified - no segment filters for now)
QUERY="SELECT a.acctnumber, a.accountsearchdisplaynamecopy AS account_name, a.accttype, COALESCE(SUM(CASE WHEN tl.id IS NOT NULL THEN TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', 1, $PERIOD_ID, 'DEFAULT')) * CASE WHEN a.accttype IN ('AcctPay', 'CredCard', 'OthCurrLiab', 'LongTermLiab', 'DeferRevenue', 'Equity', 'RetainedEarnings') THEN -1 ELSE 1 END ELSE 0 END), 0) AS balance FROM account a LEFT JOIN transactionaccountingline tal ON tal.account = a.id AND tal.posting = 'T' AND (tal.accountingbook = 1 OR tal.accountingbook IS NULL) LEFT JOIN transaction t ON t.id = tal.transaction AND t.posting = 'T' AND t.trandate <= TO_DATE('$END_DATE_RAW', 'YYYY-MM-DD') LEFT JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id AND tl.subsidiary IN (1) WHERE a.accttype IN ('Bank', 'AcctRec', 'OthCurrAsset', 'FixedAsset', 'OthAsset', 'DeferExpense', 'UnbilledRec', 'AcctPay', 'CredCard', 'OthCurrLiab', 'LongTermLiab', 'DeferRevenue', 'Equity', 'RetainedEarnings') AND a.isinactive = 'F' AND a.acctnumber IN ('10413', '10206', '10411') GROUP BY a.acctnumber, a.accountsearchdisplaynamecopy, a.accttype ORDER BY a.acctnumber"

echo "Running BS Preload query (filtered to our 3 accounts)..."
echo ""

QUERY_ESCAPED=$(echo "$QUERY" | sed 's/"/\\"/g')
RESPONSE=$(curl -s -X POST "$BASE_URL/test/query" \
  -H "Content-Type: application/json" \
  -d "{\"q\": \"$QUERY_ESCAPED\", \"timeout\": 180}")

ERROR=$(echo "$RESPONSE" | jq -r '.error // empty' 2>/dev/null)

if [ -n "$ERROR" ] && [ "$ERROR" != "null" ]; then
    echo "❌ Error: $ERROR"
    echo "$RESPONSE" | jq '.' 2>/dev/null || echo "$RESPONSE"
    exit 1
fi

RESULTS=$(echo "$RESPONSE" | jq -r '.results[]? // .items[]? // empty' 2>/dev/null)

if [ -z "$RESULTS" ] || [ "$RESULTS" = "null" ]; then
    echo "⚠️  No results returned!"
    echo ""
    echo "This means the query is NOT returning these accounts."
    echo "Possible reasons:"
    echo "  1. Backend query logic is wrong"
    echo "  2. Query has a bug that excludes accounts with no transactions"
    echo "  3. NetSuite SuiteQL doesn't support this LEFT JOIN pattern"
    exit 1
fi

echo "Query Results:"
echo "=============="
echo ""

echo "$RESULTS" | jq -r '
    "Account: " + .acctnumber + 
    " | Name: " + (.account_name // "N/A") + 
    " | Type: " + (.accttype // "N/A") + 
    " | Balance: " + (.balance // "0")
' 2>/dev/null || echo "$RESULTS"

echo ""
echo "Checking if all 3 accounts are present:"
echo ""

for ACCT in 10413 10206 10411; do
    ACCT_INFO=$(echo "$RESULTS" | jq -r "select(.acctnumber == \"$ACCT\")" 2>/dev/null)
    
    if [ -z "$ACCT_INFO" ] || [ "$ACCT_INFO" = "null" ]; then
        echo "❌ Account $ACCT: NOT RETURNED by query"
    else
        BALANCE=$(echo "$ACCT_INFO" | jq -r '.balance // "0"' 2>/dev/null)
        echo "✅ Account $ACCT: RETURNED with balance = $BALANCE"
    fi
done

