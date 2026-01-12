#!/bin/bash
# Test queries to compare BUILTIN.CONSOLIDATE vs raw tal.amount for book 2, Celigo India Pvt Ltd

SERVER_URL="http://localhost:5002"
SUBSIDIARY_NAME="Celigo India Pvt Ltd"
ACCOUNTING_BOOK="2"
PERIOD="Mar 2025"  # Test with one period first

echo "=========================================="
echo "Testing CONSOLIDATE vs Raw Amount Queries"
echo "=========================================="
echo "Book: $ACCOUNTING_BOOK"
echo "Subsidiary: $SUBSIDIARY_NAME"
echo "Period: $PERIOD"
echo ""

# First, get subsidiary ID and period ID
echo "Step 1: Getting subsidiary ID..."
SUBSIDIARY_RESPONSE=$(curl -s -X GET "$SERVER_URL/lookups/all")
SUBSIDIARY_ID=$(echo "$SUBSIDIARY_RESPONSE" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "   Subsidiary ID: $SUBSIDIARY_ID"
echo ""

# Get period ID (we'll need to query periods for 2025)
echo "Step 2: Getting period ID for $PERIOD..."
# For now, let's assume we know the period ID or get it from the lookup
# We'll use a simplified query that works with period name

echo ""
echo "=========================================="
echo "TEST 1: Query WITHOUT BUILTIN.CONSOLIDATE"
echo "=========================================="
echo "Using raw tal.amount directly"
echo ""

QUERY1=$(cat <<EOF
SELECT 
    a.accttype AS account_type,
    SUM(CASE WHEN a.accttype IN ('Income', 'OthIncome') THEN -tal.amount ELSE tal.amount END) AS amount
FROM transactionaccountingline tal
JOIN transaction t ON t.id = tal.transaction
JOIN account a ON a.id = tal.account
JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
WHERE t.posting = 'T'
  AND tal.posting = 'T'
  AND a.accttype = 'Income'
  AND a.isinactive = 'F'
  AND tal.accountingbook = $ACCOUNTING_BOOK
  AND tl.subsidiary = $SUBSIDIARY_ID
GROUP BY a.accttype
EOF
)

echo "Query 1 (NO CONSOLIDATE):"
echo "$QUERY1"
echo ""

RESPONSE1=$(curl -s -X POST "$SERVER_URL/test/query" \
  -H "Content-Type: application/json" \
  -d "{\"q\": \"$QUERY1\", \"timeout\": 60}")

echo "Response 1:"
echo "$RESPONSE1" | jq '.' 2>/dev/null || echo "$RESPONSE1"
echo ""

echo "=========================================="
echo "TEST 2: Query WITH BUILTIN.CONSOLIDATE"
echo "=========================================="
echo "Using BUILTIN.CONSOLIDATE (current approach)"
echo ""

QUERY2=$(cat <<EOF
SELECT 
    a.accttype AS account_type,
    SUM(
        CASE WHEN a.accttype IN ('Income', 'OthIncome') THEN 
            -TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', $SUBSIDIARY_ID, t.postingperiod, 'DEFAULT'))
        ELSE 
            TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', $SUBSIDIARY_ID, t.postingperiod, 'DEFAULT'))
        END
    ) AS amount
FROM transactionaccountingline tal
JOIN transaction t ON t.id = tal.transaction
JOIN account a ON a.id = tal.account
JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
WHERE t.posting = 'T'
  AND tal.posting = 'T'
  AND a.accttype = 'Income'
  AND a.isinactive = 'F'
  AND tal.accountingbook = $ACCOUNTING_BOOK
  AND tl.subsidiary = $SUBSIDIARY_ID
GROUP BY a.accttype
EOF
)

echo "Query 2 (WITH CONSOLIDATE):"
echo "$QUERY2"
echo ""

RESPONSE2=$(curl -s -X POST "$SERVER_URL/test/query" \
  -H "Content-Type: application/json" \
  -d "{\"q\": \"$QUERY2\", \"timeout\": 60}")

echo "Response 2:"
echo "$RESPONSE2" | jq '.' 2>/dev/null || echo "$RESPONSE2"
echo ""

echo "=========================================="
echo "TEST 3: Query WITH COALESCE (NEW APPROACH)"
echo "=========================================="
echo "Using COALESCE to handle NULL from CONSOLIDATE"
echo ""

QUERY3=$(cat <<EOF
SELECT 
    a.accttype AS account_type,
    SUM(
        CASE WHEN a.accttype IN ('Income', 'OthIncome') THEN 
            -COALESCE(
                TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', $SUBSIDIARY_ID, t.postingperiod, 'DEFAULT')),
                tal.amount
            )
        ELSE 
            COALESCE(
                TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', $SUBSIDIARY_ID, t.postingperiod, 'DEFAULT')),
                tal.amount
            )
        END
    ) AS amount
FROM transactionaccountingline tal
JOIN transaction t ON t.id = tal.transaction
JOIN account a ON a.id = tal.account
JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
WHERE t.posting = 'T'
  AND tal.posting = 'T'
  AND a.accttype = 'Income'
  AND a.isinactive = 'F'
  AND tal.accountingbook = $ACCOUNTING_BOOK
  AND tl.subsidiary = $SUBSIDIARY_ID
GROUP BY a.accttype
EOF
)

echo "Query 3 (WITH COALESCE):"
echo "$QUERY3"
echo ""

RESPONSE3=$(curl -s -X POST "$SERVER_URL/test/query" \
  -H "Content-Type: application/json" \
  -d "{\"q\": \"$QUERY3\", \"timeout\": 60}")

echo "Response 3:"
echo "$RESPONSE3" | jq '.' 2>/dev/null || echo "$RESPONSE3"
echo ""

echo "=========================================="
echo "COMPARISON SUMMARY"
echo "=========================================="
echo "Extracting Income amounts from each response..."
echo ""

AMOUNT1=$(echo "$RESPONSE1" | grep -o '"amount":[^,}]*' | head -1 | cut -d':' -f2 | tr -d ' ')
AMOUNT2=$(echo "$RESPONSE2" | grep -o '"amount":[^,}]*' | head -1 | cut -d':' -f2 | tr -d ' ')
AMOUNT3=$(echo "$RESPONSE3" | grep -o '"amount":[^,}]*' | head -1 | cut -d':' -f2 | tr -d ' ')

echo "Query 1 (NO CONSOLIDATE):     $AMOUNT1"
echo "Query 2 (WITH CONSOLIDATE):   $AMOUNT2"
echo "Query 3 (WITH COALESCE):      $AMOUNT3"
echo ""

if [ "$AMOUNT1" = "$AMOUNT3" ] && [ "$AMOUNT1" != "null" ] && [ "$AMOUNT1" != "0" ]; then
    echo "✅ SUCCESS: Query 1 and Query 3 match (COALESCE works as fallback)"
    echo "   Recommendation: Use COALESCE approach (single CONSOLIDATE call)"
elif [ "$AMOUNT2" = "$AMOUNT3" ] && [ "$AMOUNT2" != "null" ] && [ "$AMOUNT2" != "0" ]; then
    echo "✅ SUCCESS: Query 2 and Query 3 match (CONSOLIDATE works, COALESCE is safe)"
    echo "   Recommendation: Use COALESCE approach (handles both cases)"
else
    echo "⚠️  WARNING: Results differ - need investigation"
    echo "   Query 1 (raw): $AMOUNT1"
    echo "   Query 2 (consolidate): $AMOUNT2"
    echo "   Query 3 (coalesce): $AMOUNT3"
fi

