#!/bin/bash
# Script to copy backend server log to Desktop
# Usage: bash ./copy-backend-log.sh [destination]
# Examples:
#   bash ./copy-backend-log.sh                    # Copy to ~/Desktop/dotnet-server.log
#   bash ./copy-backend-log.sh ~/Desktop/my-log.log  # Copy to custom location

LOG_FILE="/tmp/dotnet-server.log"
ARCHIVED_LOG="/tmp/dotnet-server.log.old"
DEFAULT_DEST="$HOME/Desktop/dotnet-server.log"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Parse destination
DEST="${1:-$DEFAULT_DEST}"

echo -e "${BLUE}📋 Copying backend server log...${NC}"
echo "   Source: $LOG_FILE"
echo "   Destination: $DEST"
echo ""

# Check if current log exists
if [ -f "$LOG_FILE" ]; then
    cp "$LOG_FILE" "$DEST"
    if [ $? -eq 0 ]; then
        FILE_SIZE=$(wc -l < "$LOG_FILE" 2>/dev/null || echo "0")
        echo -e "${GREEN}✅ Copied current log to: $DEST${NC}"
        echo "   File size: $FILE_SIZE lines"
    else
        echo -e "${RED}❌ Failed to copy log file${NC}"
        exit 1
    fi
elif [ -f "$ARCHIVED_LOG" ]; then
    echo -e "${YELLOW}⚠️  Current log not found, copying archived log instead${NC}"
    cp "$ARCHIVED_LOG" "$DEST"
    if [ $? -eq 0 ]; then
        FILE_SIZE=$(wc -l < "$ARCHIVED_LOG" 2>/dev/null || echo "0")
        echo -e "${GREEN}✅ Copied archived log to: $DEST${NC}"
        echo "   File size: $FILE_SIZE lines"
    else
        echo -e "${RED}❌ Failed to copy archived log file${NC}"
        exit 1
    fi
else
    echo -e "${RED}❌ No log files found${NC}"
    echo "   Current log: $LOG_FILE"
    echo "   Archived log: $ARCHIVED_LOG"
    echo ""
    echo "   Server may not be running. Start it with:"
    echo "   bash ./useful-commands/start-dotnet-server.sh"
    exit 1
fi

echo ""
echo -e "${BLUE}💡 Tip: Open the file with:${NC}"
echo "   open $DEST"

