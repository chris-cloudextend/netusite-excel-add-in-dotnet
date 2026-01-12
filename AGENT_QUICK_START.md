# Quick Start for Agents

**⚠️ CRITICAL:** If `dotnet` command is not found, run this first:

```bash
cd /Users/chriscorcoran/Documents/Cursor/NetSuite-Excel-AddIn-DotNet
source ./setup-dotnet-path.sh
```

## Start Server and Tunnel

```bash
cd /Users/chriscorcoran/Documents/Cursor/NetSuite-Excel-AddIn-DotNet
./start-server-and-tunnel.sh
```

This will:
1. Setup PATH  for dotnet automatically
2. Start .NET server on port 5002
3. Start Cloudflare tunnel
4. Display the tunnel URL

## Start Server Only

```bash
cd /Users/chriscorcoran/Documents/Cursor/NetSuite-Excel-AddIn-DotNet
./start-dotnet-server.sh
```

## Manual Start

```bash
# Setup PATH
source ./setup-dotnet-path.sh

# Start server
cd backend-dotnet
dotnet run

# In another terminal, start tunnel
cloudflared tunnel --url http://localhost:5002
```

## Verify

```bash
# Check server
curl http://localhost:5002/health

# Check processes
ps aux | grep "dotnet.*run"
ps aux | grep "cloudflared tunnel"
```

## Stop

```bash
pkill -f "dotnet.*run"
pkill -f "cloudflared tunnel"
```

---
**Full guide:** See `AGENT_START_GUIDE.md` for detailed instructions.

