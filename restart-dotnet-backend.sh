#!/bin/bash
# Script to restart .NET backend (kills existing and starts fresh)
# Usage: ./restart-dotnet-backend.sh

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

echo "🔄 Restarting .NET backend..."

# Kill any existing processes
echo "1. Stopping existing server..."
pkill -f "dotnet.*run" 2>/dev/null || echo "   (No existing process found)"
sleep 2

# Start server
echo "2. Starting server..."
cd "$BACKEND_DIR"
nohup "$DOTNET_CMD" run > "$LOG_FILE" 2>&1 &
SERVER_PID=$!
echo "   Server started (PID: $SERVER_PID)"

# Wait for server to be ready
echo "3. Waiting for server to be ready..."
MAX_WAIT=30
WAIT_COUNT=0
while [ $WAIT_COUNT -lt $MAX_WAIT ]; do
    if curl -s "$HEALTH_URL" > /dev/null 2>&1; then
        echo "✅ .NET backend is running and healthy (PID: $SERVER_PID)"
        echo ""
        echo "Health check response:"
        curl -s "$HEALTH_URL" | python3 -m json.tool 2>/dev/null | head -10
        exit 0
    fi
    sleep 1
    WAIT_COUNT=$((WAIT_COUNT + 1))
    if [ $((WAIT_COUNT % 5)) -eq 0 ]; then
        echo "   Still waiting... (${WAIT_COUNT}s)"
    fi
done

echo "❌ Server failed to start within $MAX_WAIT seconds"
if [ -f "$LOG_FILE" ]; then
    echo ""
    echo "Last 30 lines of log:"
    tail -30 "$LOG_FILE"
fi
exit 1

