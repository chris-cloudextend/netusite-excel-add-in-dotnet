#!/bin/bash
# Test script for BS Preload Query Optimization
# This script tests both the current and proposed LEFT JOIN queries

# Configuration
BASE_URL="${BASE_URL:-http://localhost:5000}"
TEST_PERIOD="${TEST_PERIOD:-Feb 2025}"
TEST_SUBSIDIARY="${TEST_SUBSIDIARY:-Celigo Inc. (Consolidated)}"

echo "=========================================="
echo "BS Preload Query Test Script"
echo "=========================================="
echo "Base URL: $BASE_URL"
echo "Test Period: $TEST_PERIOD"
echo "Test Subsidiary: $TEST_SUBSIDIARY"
echo ""

# Step 1: Get Period Info
echo "Step 1: Getting period information..."
PERIOD_QUERY="SELECT id, periodname, startdate, enddate FROM accountingperiod WHERE periodname = '$TEST_PERIOD' AND isyear = 'F' AND isquarter = 'F' FETCH FIRST 1 ROWS ONLY"

PERIOD_RESPONSE=$(curl -s -X POST "$BASE_URL/test/query" \
  -H "Content-Type: application/json" \
  -d "{\"q\": \"$PERIOD_QUERY\", \"timeout\": 30}")

PERIOD_ID=$(echo "$PERIOD_RESPONSE" | jq -r '.results[0].id // empty')
END_DATE=$(echo "$PERIOD_RESPONSE" | jq -r '.results[0].enddate // empty' | cut -d'T' -f1)

if [ -z "$PERIOD_ID" ] || [ "$PERIOD_ID" = "null" ]; then
  echo "ERROR: Could not find period '$TEST_PERIOD'"
  echo "Response: $PERIOD_RESPONSE"
  exit 1
fi

echo "  Period ID: $PERIOD_ID"
echo "  End Date: $END_DATE"
echo ""

# Step 2: Get Subsidiary Info (simplified - using ID 1 for now)
TARGET_SUB="1"
SUB_FILTER="1"  # Simplified - in real scenario, would get hierarchy

echo "Step 2: Using subsidiary ID: $TARGET_SUB"
echo ""

# Step 3: Build Current Query
echo "Step 3: Building current query..."
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

# Step 4: Build Proposed Query
echo "Step 4: Building proposed query (LEFT JOIN)..."
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

# Step 5: Execute Current Query
echo ""
echo "Step 5: Executing CURRENT query..."
echo "  This may take 60-90 seconds..."
CURRENT_START=$(date +%s)
CURRENT_RESPONSE=$(curl -s -X POST "$BASE_URL/test/query" \
  -H "Content-Type: application/json" \
  -d "{\"q\": \"$CURRENT_QUERY\", \"timeout\": 180}")
CURRENT_END=$(date +%s)
CURRENT_TIME=$((CURRENT_END - CURRENT_START))

CURRENT_ERROR=$(echo "$CURRENT_RESPONSE" | jq -r '.error // empty')
if [ -n "$CURRENT_ERROR" ] && [ "$CURRENT_ERROR" != "null" ]; then
  echo "  ERROR: $CURRENT_ERROR"
  echo "$CURRENT_RESPONSE" | jq '.'
  exit 1
fi

CURRENT_COUNT=$(echo "$CURRENT_RESPONSE" | jq '.row_count // (.results | length)')
echo "  ✅ Current query completed in ${CURRENT_TIME}s"
echo "  Accounts returned: $CURRENT_COUNT"
echo "$CURRENT_RESPONSE" > current_query_results.json
echo "  Results saved to: current_query_results.json"

# Step 6: Execute Proposed Query
echo ""
echo "Step 6: Executing PROPOSED query (LEFT JOIN)..."
echo "  This may take 60-90 seconds..."
PROPOSED_START=$(date +%s)
PROPOSED_RESPONSE=$(curl -s -X POST "$BASE_URL/test/query" \
  -H "Content-Type: application/json" \
  -d "{\"q\": \"$PROPOSED_QUERY\", \"timeout\": 180}")
PROPOSED_END=$(date +%s)
PROPOSED_TIME=$((PROPOSED_END - PROPOSED_START))

PROPOSED_ERROR=$(echo "$PROPOSED_RESPONSE" | jq -r '.error // empty')
if [ -n "$PROPOSED_ERROR" ] && [ "$PROPOSED_ERROR" != "null" ]; then
  echo "  ERROR: $PROPOSED_ERROR"
  echo "$PROPOSED_RESPONSE" | jq '.'
  exit 1
fi

PROPOSED_COUNT=$(echo "$PROPOSED_RESPONSE" | jq '.row_count // (.results | length)')
echo "  ✅ Proposed query completed in ${PROPOSED_TIME}s"
echo "  Accounts returned: $PROPOSED_COUNT"
echo "$PROPOSED_RESPONSE" > proposed_query_results.json
echo "  Results saved to: proposed_query_results.json"

# Step 7: Compare Results
echo ""
echo "=========================================="
echo "Comparison Results"
echo "=========================================="
echo "Current Query:"
echo "  Execution time: ${CURRENT_TIME}s"
echo "  Accounts returned: $CURRENT_COUNT"
echo ""
echo "Proposed Query:"
echo "  Execution time: ${PROPOSED_TIME}s"
echo "  Accounts returned: $PROPOSED_COUNT"
echo ""

# Check if proposed returns more accounts
if [ "$PROPOSED_COUNT" -gt "$CURRENT_COUNT" ]; then
  DIFF=$((PROPOSED_COUNT - CURRENT_COUNT))
  echo "  ✅ Proposed query returns $DIFF MORE accounts (includes zero-balance accounts)"
elif [ "$PROPOSED_COUNT" -eq "$CURRENT_COUNT" ]; then
  echo "  ⚠️  Both queries return same number of accounts (unexpected)"
else
  echo "  ⚠️  Proposed query returns fewer accounts (unexpected)"
fi

# Performance comparison
if [ "$PROPOSED_TIME" -lt "$CURRENT_TIME" ]; then
  IMPROVEMENT=$((CURRENT_TIME - PROPOSED_TIME))
  PERCENT=$((IMPROVEMENT * 100 / CURRENT_TIME))
  echo "  ✅ Proposed query is ${IMPROVEMENT}s faster (${PERCENT}% improvement)"
elif [ "$PROPOSED_TIME" -eq "$CURRENT_TIME" ]; then
  echo "  ✅ Performance is similar"
else
  SLOWER=$((PROPOSED_TIME - CURRENT_TIME))
  PERCENT=$((SLOWER * 100 / CURRENT_TIME))
  echo "  ⚠️  Proposed query is ${SLOWER}s slower (${PERCENT}% slower)"
fi

# Check for account 10206
echo ""
echo "Checking for account 10206 (the one that wasn't cached)..."
ACCT_10206_CURRENT=$(echo "$CURRENT_RESPONSE" | jq -r '.results[] | select(.acctnumber == "10206") | .balance // empty')
ACCT_10206_PROPOSED=$(echo "$PROPOSED_RESPONSE" | jq -r '.results[] | select(.acctnumber == "10206") | .balance // empty')

if [ -z "$ACCT_10206_CURRENT" ] || [ "$ACCT_10206_CURRENT" = "null" ]; then
  echo "  ⚠️  Account 10206 NOT in current query results"
else
  echo "  ✅ Account 10206 in current query: balance = $ACCT_10206_CURRENT"
fi

if [ -z "$ACCT_10206_PROPOSED" ] || [ "$ACCT_10206_PROPOSED" = "null" ]; then
  echo "  ❌ Account 10206 NOT in proposed query results (unexpected!)"
else
  echo "  ✅ Account 10206 in proposed query: balance = $ACCT_10206_PROPOSED"
fi

# Check for zero balances
echo ""
echo "Checking zero-balance accounts in proposed query..."
ZERO_COUNT=$(echo "$PROPOSED_RESPONSE" | jq '[.results[] | select(.balance == 0)] | length')
echo "  Accounts with zero balance: $ZERO_COUNT"

# Summary
echo ""
echo "=========================================="
echo "Test Summary"
echo "=========================================="
if [ "$PROPOSED_COUNT" -ge "$CURRENT_COUNT" ] && [ -n "$ACCT_10206_PROPOSED" ]; then
  echo "✅ TEST PASSED"
  echo "   - Proposed query returns all accounts (including zero-balance)"
  echo "   - Account 10206 is included"
  echo "   - Ready for implementation"
else
  echo "❌ TEST FAILED"
  echo "   - Review results above"
  echo "   - Check query syntax"
  echo "   - Verify NetSuite permissions"
fi
echo ""
echo "Detailed results saved to:"
echo "  - current_query_results.json"
echo "  - proposed_query_results.json"

