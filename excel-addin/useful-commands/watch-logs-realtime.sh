#!/bin/bash
# Script to watch backend server logs in real time
# Usage: bash ./watch-logs-realtime.sh [filter]
# Examples:
#   bash ./watch-logs-realtime.sh                    # Watch all logs
#   bash ./watch-logs-realtime.sh "BALANCE"          # Watch logs filtered by "BALANCE"
#   bash ./watch-logs-realtime.sh "error"            # Watch error logs only

LOG_FILE="/tmp/dotnet-server.log"
FILTER="${1:-}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}👀 Watching backend server logs in real time...${NC}"
echo "   Log file: $LOG_FILE"
if [ -n "$FILTER" ]; then
    echo "   Filter: $FILTER"
fi
echo ""
echo -e "${YELLOW}Press Ctrl+C to stop watching${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
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

# Watch logs with optional filter
if [ -z "$FILTER" ]; then
    # No filter - watch all logs
    tail -f "$LOG_FILE"
else
    # Filter applied - watch filtered logs
    tail -f "$LOG_FILE" | grep --line-buffered -i "$FILTER"
fi
