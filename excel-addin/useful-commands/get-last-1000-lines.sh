#!/bin/bash
# Script to get last 1000 lines of backend server log
# Usage: bash ./get-last-1000-lines.sh

LOG_FILE="/tmp/dotnet-server.log"
LINES=1000

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}📋 Getting last $LINES lines of backend server log...${NC}"
echo "   Log file: $LOG_FILE"
echo ""

if [ ! -f "$LOG_FILE" ]; then
    echo -e "${RED}❌ Log file not found: $LOG_FILE${NC}"
    echo "   Server may not be running. Start it with:"
    echo "   bash ./useful-commands/start-dotnet-server.sh"
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
if [ "$FILE_SIZE" -lt "$LINES" ]; then
    echo -e "${YELLOW}⚠️  Log file has fewer than $LINES lines, showing all $FILE_SIZE lines${NC}"
    ACTUAL_LINES=$FILE_SIZE
else
    ACTUAL_LINES=$LINES
fi

echo ""
echo -e "${GREEN}📄 Last $ACTUAL_LINES lines of log:${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
tail -n "$ACTUAL_LINES" "$LOG_FILE"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo -e "${BLUE}💡 Tip: To watch logs in real time, use:${NC}"
echo "   bash ./useful-commands/watch-logs-realtime.sh"
