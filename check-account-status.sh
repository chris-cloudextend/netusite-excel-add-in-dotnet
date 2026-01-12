#!/bin/bash
# Check if accounts 10413, 10206, 10411 are inactive or have issues

BASE_URL="${BASE_URL:-http://localhost:5002}"

echo "Checking account status for 10413, 10206, 10411..."
echo "Backend URL: $BASE_URL"
echo ""

# Check if backend is running
if ! curl -s "$BASE_URL/health" > /dev/null 2>&1; then
    echo "❌ Backend not running. Please start the backend first."
    echo "   Run: cd backend-dotnet && dotnet run"
    exit 1
fi

echo "✅ Backend is running"
echo ""

# Query to check account status (single line, properly escaped)
QUERY="SELECT acctnumber, accountsearchdisplaynamecopy AS account_name, accttype, isinactive, CASE WHEN isinactive = 'T' THEN 'Inactive' ELSE 'Active' END AS status FROM account WHERE acctnumber IN ('10413', '10206', '10411') ORDER BY acctnumber"

echo "Querying NetSuite for account status..."
echo "Query: $QUERY"
echo ""

# Check if /test/query endpoint exists (from test-queries-direct.sh pattern)
# Need to properly escape the query for JSON
QUERY_ESCAPED=$(echo "$QUERY" | sed 's/"/\\"/g')
RESPONSE=$(curl -s -X POST "$BASE_URL/test/query" \
  -H "Content-Type: application/json" \
  -d "{\"q\": \"$QUERY_ESCAPED\", \"timeout\": 30}")

# Check if response has error
ERROR=$(echo "$RESPONSE" | jq -r '.error // empty' 2>/dev/null)

if [ -n "$ERROR" ] && [ "$ERROR" != "null" ]; then
    echo "❌ Error querying NetSuite: $ERROR"
    echo ""
    echo "Trying alternative method..."
    echo ""
    echo "Please check account status manually in NetSuite:"
    echo "  Lists > Accounting > Accounts"
    echo "  Search for: 10413, 10206, 10411"
    echo ""
    echo "Or use the backend's account lookup endpoint:"
    echo "  curl \"$BASE_URL/account/search?number=10413\""
    echo "  curl \"$BASE_URL/account/search?number=10206\""
    echo "  curl \"$BASE_URL/account/search?number=10411\""
    exit 1
fi

# Parse results
echo "Account Status Results:"
echo "======================="
echo ""

RESULTS=$(echo "$RESPONSE" | jq -r '.results[]? // .items[]? // empty' 2>/dev/null)

if [ -z "$RESULTS" ] || [ "$RESULTS" = "null" ]; then
    echo "⚠️  No results returned. Accounts may not exist or query failed."
    echo ""
    echo "Raw response:"
    echo "$RESPONSE" | jq '.' 2>/dev/null || echo "$RESPONSE"
    exit 1
fi

# Display results
echo "$RESULTS" | jq -r '
    "Account: " + .acctnumber + 
    " | Name: " + (.account_name // "N/A") + 
    " | Type: " + (.accttype // "N/A") + 
    " | Status: " + (.status // (if .isinactive == "T" then "Inactive" else "Active" end))
' 2>/dev/null || echo "$RESULTS"

echo ""
echo "Analysis:"
echo "========="

# Check each account
for ACCT in 10413 10206 10411; do
    ACCT_INFO=$(echo "$RESULTS" | jq -r "select(.acctnumber == \"$ACCT\")" 2>/dev/null)
    
    if [ -z "$ACCT_INFO" ] || [ "$ACCT_INFO" = "null" ]; then
        echo "❌ Account $ACCT: NOT FOUND in NetSuite"
    else
        IS_INACTIVE=$(echo "$ACCT_INFO" | jq -r '.isinactive // "F"' 2>/dev/null)
        ACCT_TYPE=$(echo "$ACCT_INFO" | jq -r '.accttype // ""' 2>/dev/null)
        
        if [ "$IS_INACTIVE" = "T" ]; then
            echo "❌ Account $ACCT: INACTIVE (isinactive = 'T')"
        elif [ -z "$ACCT_TYPE" ]; then
            echo "⚠️  Account $ACCT: Found but missing account type"
        else
            echo "✅ Account $ACCT: Active, Type: $ACCT_TYPE"
        fi
    fi
done

echo ""
echo "If accounts are inactive, they will be excluded by: WHERE a.isinactive = 'F'"
echo "This is why they don't appear in the preload cache."
