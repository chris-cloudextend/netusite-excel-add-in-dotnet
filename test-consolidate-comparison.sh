#!/bin/bash
# Test queries comparing BUILTIN.CONSOLIDATE vs raw tal.amount for book 2, Celigo India Pvt Ltd

SERVER_URL="http://localhost:5002"
SUBSIDIARY_NAME="Celigo India Pvt Ltd"
ACCOUNTING_BOOK="2"

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Testing CONSOLIDATE vs Raw Amount for Book 2, India Sub    ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# Step 1: Get subsidiary ID
echo "Step 1: Getting subsidiary ID for '$SUBSIDIARY_NAME'..."
SUBSIDIARY_RESPONSE=$(curl -s -X GET "$SERVER_URL/lookups/all")
SUBSIDIARY_ID=$(echo "$SUBSIDIARY_RESPONSE" | jq -r ".subsidiaries[] | select(.name == \"$SUBSIDIARY_NAME\") | .id" 2>/dev/null)

if [ -z "$SUBSIDIARY_ID" ] || [ "$SUBSIDIARY_ID" = "null" ]; then
    echo "   ⚠️  Could not find subsidiary ID, trying alternative method..."
    # Try to get it from the book-subsidiary endpoint
    BOOK_SUBS_RESPONSE=$(curl -s -X GET "$SERVER_URL/lookups/accountingbook/$ACCOUNTING_BOOK/subsidiaries")
    SUBSIDIARY_ID=$(echo "$BOOK_SUBS_RESPONSE" | jq -r ".subsidiaries[0].id" 2>/dev/null)
fi

if [ -z "$SUBSIDIARY_ID" ] || [ "$SUBSIDIARY_ID" = "null" ]; then
    echo "   ❌ ERROR: Could not get subsidiary ID. Using default ID 2."
    SUBSIDIARY_ID="2"
else
    echo "   ✅ Subsidiary ID: $SUBSIDIARY_ID"
fi
echo ""

# Step 2: Get a sample period ID (March 2025)
echo "Step 2: Getting period ID for March 2025..."
# We'll use a simplified query that works with period names or we can hardcode a period ID
# For now, let's test with all 2025 periods filtered
PERIOD_FILTER="SELECT id FROM accountingperiod WHERE periodname LIKE 'Mar 2025'"
echo "   Using period filter for March 2025"
echo ""

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  TEST 1: Query WITHOUT BUILTIN.CONSOLIDATE (Raw tal.amount)  ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

QUERY1="SELECT 
    a.accttype AS account_type,
    SUM(CASE WHEN a.accttype IN ('Income', 'OthIncome') THEN -tal.amount ELSE tal.amount END) AS total_amount,
    COUNT(*) AS transaction_count
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
  AND t.postingperiod IN (SELECT id FROM accountingperiod WHERE periodname LIKE 'Mar 2025')
GROUP BY a.accttype"

echo "Query 1 (NO CONSOLIDATE):"
echo "$QUERY1"
echo ""

RESPONSE1=$(curl -s -X POST "$SERVER_URL/test/query" \
  -H "Content-Type: application/json" \
  -d "{\"q\": $(echo "$QUERY1" | jq -Rs .), \"timeout\": 60}")

echo "Response 1:"
echo "$RESPONSE1" | jq '.' 2>/dev/null || echo "$RESPONSE1"
echo ""

AMOUNT1=$(echo "$RESPONSE1" | jq -r '.results[0].total_amount // .results[0].amount // "null"' 2>/dev/null)
COUNT1=$(echo "$RESPONSE1" | jq -r '.results[0].transaction_count // "null"' 2>/dev/null)
echo "   Income Amount (raw): $AMOUNT1"
echo "   Transaction Count: $COUNT1"
echo ""

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  TEST 2: Query WITH BUILTIN.CONSOLIDATE (Current Approach)  ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

QUERY2="SELECT 
    a.accttype AS account_type,
    SUM(
        CASE WHEN a.accttype IN ('Income', 'OthIncome') THEN 
            -TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', $SUBSIDIARY_ID, t.postingperiod, 'DEFAULT'))
        ELSE 
            TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', $SUBSIDIARY_ID, t.postingperiod, 'DEFAULT'))
        END
    ) AS total_amount,
    COUNT(*) AS transaction_count
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
  AND t.postingperiod IN (SELECT id FROM accountingperiod WHERE periodname LIKE 'Mar 2025')
GROUP BY a.accttype"

echo "Query 2 (WITH CONSOLIDATE):"
echo "$QUERY2"
echo ""

RESPONSE2=$(curl -s -X POST "$SERVER_URL/test/query" \
  -H "Content-Type: application/json" \
  -d "{\"q\": $(echo "$QUERY2" | jq -Rs .), \"timeout\": 60}")

echo "Response 2:"
echo "$RESPONSE2" | jq '.' 2>/dev/null || echo "$RESPONSE2"
echo ""

AMOUNT2=$(echo "$RESPONSE2" | jq -r '.results[0].total_amount // .results[0].amount // "null"' 2>/dev/null)
COUNT2=$(echo "$RESPONSE2" | jq -r '.results[0].transaction_count // "null"' 2>/dev/null)
echo "   Income Amount (consolidate): $AMOUNT2"
echo "   Transaction Count: $COUNT2"
echo ""

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  TEST 3: Query WITH COALESCE (New Approach)                 ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

QUERY3="SELECT 
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
    ) AS total_amount,
    COUNT(*) AS transaction_count
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
  AND t.postingperiod IN (SELECT id FROM accountingperiod WHERE periodname LIKE 'Mar 2025')
GROUP BY a.accttype"

echo "Query 3 (WITH COALESCE):"
echo "$QUERY3"
echo ""

RESPONSE3=$(curl -s -X POST "$SERVER_URL/test/query" \
  -H "Content-Type: application/json" \
  -d "{\"q\": $(echo "$QUERY3" | jq -Rs .), \"timeout\": 60}")

echo "Response 3:"
echo "$RESPONSE3" | jq '.' 2>/dev/null || echo "$RESPONSE3"
echo ""

AMOUNT3=$(echo "$RESPONSE3" | jq -r '.results[0].total_amount // .results[0].amount // "null"' 2>/dev/null)
COUNT3=$(echo "$RESPONSE3" | jq -r '.results[0].transaction_count // "null"' 2>/dev/null)
echo "   Income Amount (coalesce): $AMOUNT3"
echo "   Transaction Count: $COUNT3"
echo ""

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  COMPARISON SUMMARY                                          ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "Query 1 (NO CONSOLIDATE):     Amount=$AMOUNT1, Count=$COUNT1"
echo "Query 2 (WITH CONSOLIDATE):   Amount=$AMOUNT2, Count=$COUNT2"
echo "Query 3 (WITH COALESCE):      Amount=$AMOUNT3, Count=$COUNT3"
echo ""

if [ "$AMOUNT1" != "null" ] && [ "$AMOUNT1" != "0" ] && [ "$AMOUNT1" != "" ]; then
    if [ "$AMOUNT1" = "$AMOUNT3" ]; then
        echo "✅ SUCCESS: Query 1 (raw) and Query 3 (coalesce) MATCH"
        echo "   Recommendation: Use COALESCE approach (single CONSOLIDATE call, handles NULL)"
    elif [ "$AMOUNT2" = "$AMOUNT3" ]; then
        echo "✅ SUCCESS: Query 2 (consolidate) and Query 3 (coalesce) MATCH"
        echo "   Recommendation: Use COALESCE approach (CONSOLIDATE works, COALESCE is safe fallback)"
    elif [ "$AMOUNT2" = "null" ] || [ "$AMOUNT2" = "0" ]; then
        echo "⚠️  WARNING: Query 2 (consolidate) returned NULL/0, but Query 3 (coalesce) has data"
        echo "   This confirms BUILTIN.CONSOLIDATE returns NULL for single subsidiary"
        echo "   Recommendation: Use COALESCE approach (required for single subsidiary)"
    else
        echo "⚠️  WARNING: All three queries returned different results"
        echo "   Need further investigation"
    fi
else
    echo "❌ ERROR: Query 1 (raw) returned no data - no transactions found"
    echo "   Cannot compare - check if transactions exist for book $ACCOUNTING_BOOK, sub $SUBSIDIARY_ID"
fi

