#!/bin/bash
# Script to ensure .NET backend is always running
# This can be run as a cron job or manually to restart if needed

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend-dotnet"
LOG_FILE="/tmp/dotnet-server.log"
HEALTH_URL="http://localhost:5002/health"

# Find dotnet
DOTNET_CMD=""
if command -v dotnet &> /dev/null; then
    DOTNET_CMD="dotnet"
elif [ -f "/opt/homebrew/opt/dotnet@8/bin/dotnet" ]; then
    DOTNET_CMD="/opt/homebrew/opt/dotnet@8/bin/dotnet"
elif [ -f "/usr/local/share/dotnet/dotnet" ]; then
    DOTNET_CMD="/usr/local/share/dotnet/dotnet"
elif [ -f "$HOME/.dotnet/dotnet" ]; then
    DOTNET_CMD="$HOME/.dotnet/dotnet"
fi

if [ -z "$DOTNET_CMD" ] || [ ! -x "$DOTNET_CMD" ]; then
    echo "❌ Error: dotnet not found"
    exit 1
fi

# Check if server is running
if curl -s "$HEALTH_URL" > /dev/null 2>&1; then
    echo "✅ .NET backend is running and healthy"
    exit 0
fi

echo "⚠️  .NET backend is not responding, restarting..."

# Kill any existing processes
pkill -f "dotnet.*run" 2>/dev/null || true
sleep 2

# Start server
cd "$BACKEND_DIR"
nohup "$DOTNET_CMD" run > "$LOG_FILE" 2>&1 &
SERVER_PID=$!

# Wait for server to be ready
echo "Waiting for server to start..."
MAX_WAIT=30
WAIT_COUNT=0
while [ $WAIT_COUNT -lt $MAX_WAIT ]; do
    if curl -s "$HEALTH_URL" > /dev/null 2>&1; then
        echo "✅ .NET backend started successfully (PID: $SERVER_PID)"
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

