#!/bin/bash
# Script to clear backend server log file
# Usage: bash ./clear-logs.sh

LOG_FILE="/tmp/dotnet-server.log"
ARCHIVED_LOG="/tmp/dotnet-server.log.old"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🧹 Clearing backend server logs...${NC}"
echo "   Log file: $LOG_FILE"
echo ""

# Clear current log
if [ -f "$LOG_FILE" ]; then
    > "$LOG_FILE"
    FILE_SIZE=$(wc -l < "$LOG_FILE" 2>/dev/null || echo "0")
    echo -e "${GREEN}✅ Cleared current log file${NC}"
    echo "   File size: $FILE_SIZE lines"
else
    echo -e "${YELLOW}⚠️  Current log file not found: $LOG_FILE${NC}"
fi

# Optionally clear archived log
if [ -f "$ARCHIVED_LOG" ]; then
    read -p "   Also clear archived log ($ARCHIVED_LOG)? [y/N] " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        > "$ARCHIVED_LOG"
        echo -e "${GREEN}✅ Cleared archived log file${NC}"
    else
        echo -e "${BLUE}   Archived log preserved${NC}"
    fi
fi

echo ""
echo -e "${BLUE}💡 Tip: Watch logs in real time with:${NC}"
echo "   bash ./useful-commands/watch-logs-realtime.sh"
