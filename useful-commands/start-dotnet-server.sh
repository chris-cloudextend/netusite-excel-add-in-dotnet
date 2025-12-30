#!/bin/bash
# Script to start .NET server with PATH setup
# This ensures dotnet is available even if not in shell PATH
# If server is already running, it will restart it

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_DIR="$PROJECT_ROOT/backend-dotnet"
LOG_FILE="/tmp/dotnet-server.log"
HEALTH_URL="http://localhost:5002/health"

# Source the PATH setup if it exists
if [ -f "$PROJECT_ROOT/setup-dotnet-path.sh" ]; then
    source "$PROJECT_ROOT/setup-dotnet-path.sh"
fi

# Use dotnet command (will use alias if needed)
DOTNET_CMD="dotnet"
if ! command -v dotnet &> /dev/null; then
    if [ -f "/opt/homebrew/opt/dotnet@8/bin/dotnet" ]; then
        DOTNET_CMD="/opt/homebrew/opt/dotnet@8/bin/dotnet"
    elif [ -f "/usr/local/share/dotnet/dotnet" ]; then
        DOTNET_CMD="/usr/local/share/dotnet/dotnet"
    elif [ -f "$HOME/.dotnet/dotnet" ]; then
        DOTNET_CMD="$HOME/.dotnet/dotnet"
    else
        echo "❌ Error: dotnet not found"
        exit 1
    fi
fi

# Check if server is already running and healthy
if curl -s "$HEALTH_URL" > /dev/null 2>&1; then
    echo "✅ .NET backend is already running and healthy"
    echo "   To restart, kill the process first: pkill -f 'dotnet.*run'"
    exit 0
fi

# Kill any existing server processes
echo "Stopping any existing server..."
pkill -f "dotnet.*run" 2>/dev/null || true
sleep 2

# Start server
cd "$BACKEND_DIR"
echo "Starting .NET server on port 5002..."
echo "Logs: $LOG_FILE"
nohup "$DOTNET_CMD" run > "$LOG_FILE" 2>&1 &
SERVER_PID=$!

# Wait for server to be ready
echo "Waiting for server to start (PID: $SERVER_PID)..."
MAX_WAIT=30
WAIT_COUNT=0
while [ $WAIT_COUNT -lt $MAX_WAIT ]; do
    if curl -s "$HEALTH_URL" > /dev/null 2>&1; then
        echo "✅ .NET backend started successfully!"
        echo "   Health: $HEALTH_URL"
        echo "   PID: $SERVER_PID"
        echo "   Logs: $LOG_FILE"
        exit 0
    fi
    sleep 1
    WAIT_COUNT=$((WAIT_COUNT + 1))
done

echo "❌ Server failed to start within $MAX_WAIT seconds"
if [ -f "$LOG_FILE" ]; then
    echo "Last 20 lines of log:"
    tail -20 "$LOG_FILE"
fi
exit 1

