#!/bin/bash
# Script to check backend logs for BALANCE formula accounting book debugging

LOG_FILE="/tmp/dotnet-server.log"
BACKEND_HEALTH_URL="http://localhost:5002/health"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🔍 Checking BALANCE Formula Accounting Book Debug Logs${NC}"
echo "=========================================="
echo ""

# 1. Check if server is running
echo -e "1️⃣ Checking if server is running..."
if curl -s "$BACKEND_HEALTH_URL" > /dev/null 2>&1; then
    echo -e "   ${GREEN}✅ Server is running${NC}"
else
    echo -e "   ${RED}❌ Server is NOT running. Please start it with: bash excel-addin/useful-commands/start-dotnet-server.sh${NC}"
    exit 1
fi
echo ""

# 2. Check for BALANCE debug logs
echo -e "2️⃣ Checking for BALANCE debug logs..."
echo -e "   ${YELLOW}Recent BALANCE debug entries:${NC}"
grep -E "\[BALANCE DEBUG\]|BALANCE.*accountingBook|accountingBook.*BALANCE" "$LOG_FILE" | tail -n 30 | sed 's/^/            /'
echo ""

# 3. Check for accounting book in SQL queries
echo -e "3️⃣ Checking for accounting book in SQL queries..."
echo -e "   ${YELLOW}Recent SQL queries with accountingbook:${NC}"
grep -E "tal\.accountingbook|accountingBook.*=" "$LOG_FILE" | tail -n 20 | sed 's/^/            /'
echo ""

# 4. Check for Book parameter in controller
echo -e "4️⃣ Checking for Book parameter in BalanceController..."
echo -e "   ${YELLOW}Recent BalanceController entries:${NC}"
grep -E "BalanceController.*book|GetBalance.*book" "$LOG_FILE" | tail -n 15 | sed 's/^/            /'
echo ""

# 5. Check for any errors related to accounting book
echo -e "5️⃣ Checking for errors related to accounting book..."
echo -e "   ${YELLOW}Recent errors:${NC}"
grep -iE "error.*book|book.*error|accounting.*book.*error" "$LOG_FILE" | tail -n 10 | sed 's/^/            /'
echo ""

# 6. Show last 50 lines of log for context
echo -e "6️⃣ Last 50 lines of log (for context):${NC}"
tail -n 50 "$LOG_FILE" | sed 's/^/            /'
echo ""

echo -e "${GREEN}✅ Log check complete${NC}"
echo ""
echo -e "${YELLOW}💡 Tip: To see real-time logs, run:${NC}"
echo -e "   tail -f $LOG_FILE | grep -E 'BALANCE|accountingBook'"

