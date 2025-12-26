#!/bin/bash
# Script to start Cloudflare tunnel and update worker code
# This script:
# 1. Starts the .NET server (if not running)
# 2. Starts the Cloudflare tunnel
# 3. Extracts the tunnel URL
# 4. Updates CLOUDFLARE-WORKER-CODE.js with the new URL
# 5. Displays instructions for deploying to Cloudflare

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TUNNEL_LOG="/tmp/tunnel-output.log"
WORKER_CODE="$SCRIPT_DIR/CLOUDFLARE-WORKER-CODE.js"

echo "🚀 Starting Cloudflare Tunnel Setup..."
echo ""

# Step 1: Ensure server is running
echo "1️⃣  Checking .NET server..."
if ! curl -s http://localhost:5002/health > /dev/null 2>&1; then
    echo "   ⚠️  Server not running, starting it..."
    cd "$SCRIPT_DIR"
    ./start-dotnet-server.sh
    sleep 2
else
    echo "   ✅ Server is already running"
fi

# Step 2: Kill any existing tunnel
echo ""
echo "2️⃣  Stopping any existing tunnel..."
pkill -f "cloudflared tunnel" 2>/dev/null || true
sleep 2

# Step 3: Start tunnel
echo ""
echo "3️⃣  Starting Cloudflare tunnel..."
echo "   (This may take 10-15 seconds to initialize...)"
cd "$SCRIPT_DIR"
cloudflared tunnel --url http://localhost:5002 > "$TUNNEL_LOG" 2>&1 &
TUNNEL_PID=$!

# Step 4: Wait for tunnel URL
echo "   Waiting for tunnel to initialize (PID: $TUNNEL_PID)..."
MAX_WAIT=20
WAIT_COUNT=0
TUNNEL_URL=""

while [ $WAIT_COUNT -lt $MAX_WAIT ]; do
    TUNNEL_URL=$(grep -oE "https://[a-zA-Z0-9-]+\.trycloudflare\.com" "$TUNNEL_LOG" 2>/dev/null | head -1)
    if [ -n "$TUNNEL_URL" ]; then
        break
    fi
    sleep 1
    WAIT_COUNT=$((WAIT_COUNT + 1))
done

if [ -z "$TUNNEL_URL" ]; then
    echo "   ❌ Failed to get tunnel URL after $MAX_WAIT seconds"
    echo "   Check log: $TUNNEL_LOG"
    kill $TUNNEL_PID 2>/dev/null || true
    exit 1
fi

echo "   ✅ Tunnel started: $TUNNEL_URL"

# Step 5: Update worker code
echo ""
echo "4️⃣  Updating CLOUDFLARE-WORKER-CODE.js..."

# Extract tunnel name for comment
TUNNEL_NAME=$(echo "$TUNNEL_URL" | sed 's|https://||' | sed 's|\.trycloudflare\.com||')

# Update the TUNNEL_URL constant
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    sed -i '' "s|const TUNNEL_URL = 'https://[^']*';|const TUNNEL_URL = '$TUNNEL_URL';|" "$WORKER_CODE"
    sed -i '' "s|// CURRENT TUNNEL URL: https://[^ ]*|// CURRENT TUNNEL URL: $TUNNEL_URL|" "$WORKER_CODE"
    sed -i '' "s|// Last Updated: [^)]*|// Last Updated: $(date '+%b %d, %Y') (Tunnel: $TUNNEL_NAME)|" "$WORKER_CODE"
else
    # Linux
    sed -i "s|const TUNNEL_URL = 'https://[^']*';|const TUNNEL_URL = '$TUNNEL_URL';|" "$WORKER_CODE"
    sed -i "s|// CURRENT TUNNEL URL: https://[^ ]*|// CURRENT TUNNEL URL: $TUNNEL_URL|" "$WORKER_CODE"
    sed -i "s|// Last Updated: [^)]*|// Last Updated: $(date '+%b %d, %Y') (Tunnel: $TUNNEL_NAME)|" "$WORKER_CODE"
fi

echo "   ✅ Worker code updated"

# Step 6: Display instructions
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ TUNNEL SETUP COMPLETE"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📋 Tunnel Information:"
echo "   URL: $TUNNEL_URL"
echo "   PID: $TUNNEL_PID"
echo "   Log: $TUNNEL_LOG"
echo ""
echo "📝 Next Steps - Deploy to Cloudflare:"
echo ""
echo "   1. Go to: https://dash.cloudflare.com"
echo "   2. Navigate to: Workers & Pages → netsuite-proxy"
echo "   3. Click: Edit Code"
echo "   4. Open: CLOUDFLARE-WORKER-CODE.js (already updated with new URL)"
echo "   5. Copy ALL contents (Cmd+A, Cmd+C)"
echo "   6. Paste into Cloudflare editor (Cmd+V)"
echo "   7. Click: Save and Deploy"
echo ""
echo "💡 To stop the tunnel:"
echo "   pkill -f 'cloudflared tunnel'"
echo ""
echo "💡 To restart tunnel (after reboot):"
echo "   ./start-tunnel.sh"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

