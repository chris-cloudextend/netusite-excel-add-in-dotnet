#!/bin/bash
# Script to check backend server logs with filtering options
# Usage: bash ./check-backend-logs.sh [filter] [lines]
# Examples:
#   bash ./check-backend-logs.sh                    # Show last 100 lines
#   bash ./check-backend-logs.sh "REVENUE DEBUG"    # Show last 100 lines filtered by "REVENUE DEBUG"
#   bash ./check-backend-logs.sh "error" 200        # Show last 200 lines filtered by "error"

LOG_FILE="/tmp/dotnet-server.log"
DEFAULT_LINES=100

# Parse arguments
FILTER="${1:-}"
LINES="${2:-$DEFAULT_LINES}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}📋 Checking backend server logs...${NC}"
echo "   Log file: $LOG_FILE"
echo "   Lines: $LINES"

if [ ! -f "$LOG_FILE" ]; then
    echo -e "${RED}❌ Log file not found: $LOG_FILE${NC}"
    echo "   Server may not be running. Start it with: ./start-dotnet-server.sh"
    exit 1
fi

# Check if log file is readable
if [ ! -r "$LOG_FILE" ]; then
    echo -e "${RED}❌ Cannot read log file: $LOG_FILE${NC}"
    exit 1
fi

# Get file size
FILE_SIZE=$(wc -l < "$LOG_FILE" 2>/dev/null || echo "0")
if [ "$FILE_SIZE" -eq 0 ]; then
    echo -e "${YELLOW}⚠️  Log file is empty${NC}"
    exit 0
fi

echo "   Total lines in log: $FILE_SIZE"
echo ""

if [ -z "$FILTER" ]; then
    # No filter - show last N lines
    echo -e "${GREEN}📄 Last $LINES lines of log:${NC}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    tail -n "$LINES" "$LOG_FILE"
else
    # Filter applied
    echo -e "${GREEN}🔍 Filtering for: "${FILTER}"${NC}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    tail -n "$LINES" "$LOG_FILE" | grep -i --color=always "$FILTER" || echo -e "${YELLOW}   No matches found${NC}"
fi

echo ""
echo -e "${BLUE}💡 Tips:${NC}"
echo "   • Filter by error: ./check-backend-logs.sh error"
echo "   • Filter by REVENUE DEBUG: ./check-backend-logs.sh 'REVENUE DEBUG'"
echo "   • Show more lines: ./check-backend-logs.sh '' 500"
echo "   • Watch live: tail -f $LOG_FILE"

