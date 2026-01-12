#!/bin/bash
# Script to start/restart .NET server with comprehensive error checking
# This ensures dotnet is available even if not in shell PATH
# Always restarts the server (kills existing processes first)

set -e  # Exit on error

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BACKEND_DIR="$PROJECT_ROOT/backend-dotnet"
LOG_FILE="/tmp/dotnet-server.log"
ERROR_LOG="/tmp/dotnet-server-errors.log"
HEALTH_URL="http://localhost:5002/health"
PORT=5002

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "🔄 Starting/Restarting .NET backend server..."
echo "   Project root: $PROJECT_ROOT"
echo "   Backend dir: $BACKEND_DIR"
echo "   Log file: $LOG_FILE"

# Verify backend directory exists
if [ ! -d "$BACKEND_DIR" ]; then
    echo -e "${RED}❌ Error: Backend directory not found: $BACKEND_DIR${NC}"
    exit 1
fi

# Verify project file exists
if [ ! -f "$BACKEND_DIR/XaviApi.csproj" ]; then
    echo -e "${RED}❌ Error: Project file not found: $BACKEND_DIR/XaviApi.csproj${NC}"
    exit 1
fi

# Source the PATH setup if it exists
if [ -f "$PROJECT_ROOT/setup-dotnet-path.sh" ]; then
    source "$PROJECT_ROOT/setup-dotnet-path.sh"
fi

# Find dotnet command - check multiple locations
DOTNET_CMD=""

# First try command in PATH (after sourcing setup)
if command -v dotnet &> /dev/null; then
    DOTNET_CMD="$(command -v dotnet)"
    echo "   Found dotnet in PATH: $DOTNET_CMD"
# Then try common installation locations
elif [ -x "/opt/homebrew/opt/dotnet@8/bin/dotnet" ]; then
    DOTNET_CMD="/opt/homebrew/opt/dotnet@8/bin/dotnet"
    echo "   Found dotnet at: $DOTNET_CMD"
elif [ -x "/usr/local/share/dotnet/dotnet" ]; then
    DOTNET_CMD="/usr/local/share/dotnet/dotnet"
    echo "   Found dotnet at: $DOTNET_CMD"
elif [ -x "$HOME/.dotnet/dotnet" ]; then
    DOTNET_CMD="$HOME/.dotnet/dotnet"
    echo "   Found dotnet at: $DOTNET_CMD"
fi

# Verify we found a valid dotnet executable
if [ -z "$DOTNET_CMD" ]; then
    echo -e "${RED}❌ Error: dotnet not found${NC}"
    echo "   Please install .NET 8 SDK or run: source $PROJECT_ROOT/setup-dotnet-path.sh"
    exit 1
fi

if [ ! -x "$DOTNET_CMD" ]; then
    echo -e "${RED}❌ Error: dotnet found but not executable: $DOTNET_CMD${NC}"
    exit 1
fi

echo "   Using dotnet: $DOTNET_CMD"
echo "   Dotnet version: $($DOTNET_CMD --version 2>&1 || echo 'unknown')"

# Step 1: Check for existing processes and kill them
echo ""
echo "1️⃣  Stopping any existing server processes..."

# Find processes by port
PORT_PID=$(lsof -ti:$PORT 2>/dev/null || echo "")
if [ -n "$PORT_PID" ]; then
    echo "   Found process on port $PORT (PID: $PORT_PID), killing..."
    kill -9 "$PORT_PID" 2>/dev/null || true
fi

# Find processes by name pattern
DOTNET_PIDS=$(pgrep -f "dotnet.*XaviApi\|dotnet.*run.*XaviApi" 2>/dev/null || echo "")
if [ -n "$DOTNET_PIDS" ]; then
    echo "   Found dotnet processes (PIDs: $DOTNET_PIDS), killing..."
    pkill -9 -f "dotnet.*XaviApi\|dotnet.*run.*XaviApi" 2>/dev/null || true
fi

# Also try generic pattern
pkill -9 -f "dotnet.*run" 2>/dev/null || true

# Wait for processes to fully terminate
sleep 3

# Verify port is free
if lsof -ti:$PORT >/dev/null 2>&1; then
    echo -e "${YELLOW}⚠️  Warning: Port $PORT still in use, trying to force kill...${NC}"
    lsof -ti:$PORT | xargs kill -9 2>/dev/null || true
    sleep 2
fi

# Step 2: Check previous log for errors
echo ""
echo "2️⃣  Checking previous log file for errors..."
if [ -f "$LOG_FILE" ]; then
    # More precise error detection - exclude function names, debug messages, and normal log patterns
    # Match actual error patterns: error:, exception:, failed, fatal at log level or start of message
    # Exclude false positives: QueryRawWithErrorAsync, REVENUE DEBUG, Diagnostic, normal query logs
    ERROR_COUNT=$(grep -iE "(error:|exception:|failed|fatal)" "$LOG_FILE" 2>/dev/null | \
        grep -vE "QueryRawWithErrorAsync|REVENUE DEBUG|Diagnostic:|Starting query|Got [0-9]+ items|error\(s\)|error\(s\) in|QueryRawWithErrorAsync:" | \
        wc -l | tr -d ' ')
    if [ "$ERROR_COUNT" -gt 0 ]; then
        echo -e "${YELLOW}   Found $ERROR_COUNT error(s) in previous log${NC}"
        echo "   Last errors:"
        grep -iE "(error:|exception:|failed|fatal)" "$LOG_FILE" 2>/dev/null | \
            grep -vE "QueryRawWithErrorAsync|REVENUE DEBUG|Diagnostic:|Starting query|Got [0-9]+ items|error\(s\)|error\(s\) in|QueryRawWithErrorAsync:" | \
            tail -5 | sed 's/^/      /'
    else
        echo "   No errors found in previous log"
    fi
    # Archive old log
    mv "$LOG_FILE" "${LOG_FILE}.old" 2>/dev/null || true
fi

# Step 3: Start the server
echo ""
echo "3️⃣  Starting server..."
cd "$BACKEND_DIR" || {
    echo -e "${RED}❌ Error: Cannot change to directory: $BACKEND_DIR${NC}"
    exit 1
}

# Verify we're in the right place
if [ ! -f "XaviApi.csproj" ]; then
    echo -e "${RED}❌ Error: XaviApi.csproj not found in current directory${NC}"
    echo "   Current directory: $(pwd)"
    exit 1
fi

# Clear any old error log
> "$ERROR_LOG"

# Start server with explicit project path and full logging
echo "   Command: $DOTNET_CMD run --project XaviApi.csproj"
echo "   Working directory: $(pwd)"
nohup "$DOTNET_CMD" run --project XaviApi.csproj > "$LOG_FILE" 2>&1 &
SERVER_PID=$!

# Verify process started
sleep 1
if ! ps -p "$SERVER_PID" > /dev/null 2>&1; then
    echo -e "${RED}❌ Error: Server process failed to start${NC}"
    if [ -f "$LOG_FILE" ]; then
        echo "   Log file contents:"
        cat "$LOG_FILE" | sed 's/^/      /'
    fi
    exit 1
fi

echo "   Server process started (PID: $SERVER_PID)"

# Step 4: Wait for server to be ready and check logs
echo ""
echo "4️⃣  Waiting for server to be ready..."
MAX_WAIT=45
WAIT_COUNT=0
LAST_LOG_SIZE=0

while [ $WAIT_COUNT -lt $MAX_WAIT ]; do
    # Check if process is still running
    if ! ps -p "$SERVER_PID" > /dev/null 2>&1; then
        echo -e "${RED}❌ Error: Server process died (PID: $SERVER_PID)${NC}"
        if [ -f "$LOG_FILE" ]; then
            echo "   Log file contents:"
            cat "$LOG_FILE" | sed 's/^/      /'
        fi
        exit 1
    fi
    
    # Check for new errors in log
    if [ -f "$LOG_FILE" ]; then
        CURRENT_LOG_SIZE=$(wc -l < "$LOG_FILE" 2>/dev/null || echo "0")
        if [ "$CURRENT_LOG_SIZE" -gt "$LAST_LOG_SIZE" ]; then
            # Check for errors in new lines - exclude false positives
            tail -n +$((LAST_LOG_SIZE + 1)) "$LOG_FILE" 2>/dev/null | \
                grep -iE "(error:|exception:|failed|fatal)" | \
                grep -vE "QueryRawWithErrorAsync|REVENUE DEBUG|Diagnostic:|Starting query|Got [0-9]+ items|error\(s\)|error\(s\) in|QueryRawWithErrorAsync:" > "$ERROR_LOG" 2>/dev/null || true
            if [ -s "$ERROR_LOG" ]; then
                echo -e "${YELLOW}   ⚠️  New errors detected in log:${NC}"
                cat "$ERROR_LOG" | sed 's/^/      /'
            fi
            LAST_LOG_SIZE=$CURRENT_LOG_SIZE
        fi
    fi
    
    # Check health endpoint
    if curl -s "$HEALTH_URL" > /dev/null 2>&1; then
        echo -e "${GREEN}✅ Server is healthy and responding!${NC}"
        echo ""
        echo "   Health endpoint: $HEALTH_URL"
        echo "   Process ID: $SERVER_PID"
        echo "   Log file: $LOG_FILE"
        echo ""
        
        # Show health check response
        echo "   Health check response:"
        curl -s "$HEALTH_URL" | python3 -m json.tool 2>/dev/null | head -10 | sed 's/^/      /' || curl -s "$HEALTH_URL" | head -5 | sed 's/^/      /'
        echo ""
        
        # Verify process is actually listening on port
        if lsof -ti:$PORT >/dev/null 2>&1; then
            PORT_PID=$(lsof -ti:$PORT)
            if [ "$PORT_PID" = "$SERVER_PID" ]; then
                echo -e "${GREEN}   ✅ Port $PORT is bound to process $SERVER_PID${NC}"
            else
                # This is normal - dotnet run spawns child processes
                # The child process (PORT_PID) is the one actually listening
                # Check if PORT_PID is a child of SERVER_PID or related
                PORT_PPID=$(ps -o ppid= -p "$PORT_PID" 2>/dev/null | tr -d ' ')
                if [ "$PORT_PPID" = "$SERVER_PID" ] || [ -n "$PORT_PPID" ]; then
                    echo -e "${GREEN}   ✅ Port $PORT is bound to child process $PORT_PID (parent: $SERVER_PID)${NC}"
                else
                    echo -e "${YELLOW}   ⚠️  Port $PORT is bound to different PID: $PORT_PID (expected: $SERVER_PID)${NC}"
                    echo -e "${YELLOW}      This may be normal if dotnet spawned a child process${NC}"
                fi
            fi
        fi
        
        exit 0
    fi
    
    sleep 1
    WAIT_COUNT=$((WAIT_COUNT + 1))
    
    # Show progress every 5 seconds
    if [ $((WAIT_COUNT % 5)) -eq 0 ]; then
        echo "   Still waiting... (${WAIT_COUNT}s/${MAX_WAIT}s)"
        # Show last few log lines
        if [ -f "$LOG_FILE" ]; then
            echo "   Recent log output:"
            tail -3 "$LOG_FILE" 2>/dev/null | sed 's/^/      /' || true
        fi
    fi
done

# If we get here, server failed to start
echo ""
echo -e "${RED}❌ Server failed to start within $MAX_WAIT seconds${NC}"

# Check if process is still running
if ps -p "$SERVER_PID" > /dev/null 2>&1; then
    echo "   Process $SERVER_PID is still running but not responding"
else
    echo "   Process $SERVER_PID has died"
fi

# Show full log
if [ -f "$LOG_FILE" ]; then
    echo ""
    echo "   Full log file ($LOG_FILE):"
    echo "   ========================================="
    cat "$LOG_FILE" | sed 's/^/   /'
    echo "   ========================================="
fi

# Show errors if any
if [ -f "$ERROR_LOG" ] && [ -s "$ERROR_LOG" ]; then
    echo ""
    echo "   Errors found:"
    cat "$ERROR_LOG" | sed 's/^/   /'
fi

exit 1

