# Deploy Cloudflare Worker - Quick Instructions

## Current Tunnel URL
**https://receive-integrating-fossil-majority.trycloudflare.com**

## Steps to Deploy

1. **Go to Cloudflare Dashboard**
   - URL: https://dash.cloudflare.com
   - Sign in if needed

2. **Navigate to Workers**
   - Click: **Workers & Pages** in left sidebar
   - Click: **netsuite-proxy** (or your worker name)

3. **Edit Code**
   - Click: **Edit Code** button (or **Quick Edit**)
   - This opens the code editor

4. **Replace All Code**
   - Select ALL existing code (Cmd+A / Ctrl+A)
   - Delete it
   - Open: `CLOUDFLARE-WORKER-CODE.js` from this project
   - Copy ALL contents (Cmd+A, Cmd+C)
   - Paste into Cloudflare editor (Cmd+V / Ctrl+V)

5. **Deploy**
   - Click: **Save and Deploy** button
   - Wait for deployment to complete (usually < 10 seconds)

6. **Verify**
   - The worker should now proxy to the new tunnel URL
   - Test by checking if the add-in can connect

## Important Notes

- **Tunnel URL changes** every time you restart the tunnel
- When tunnel restarts, you'll need to:
  1. Get new tunnel URL: `grep -oE "https://[a-zA-Z0-9-]+\.trycloudflare\.com" /tmp/tunnel-output.log`
  2. Update `CLOUDFLARE-WORKER-CODE.js` with new URL
  3. Deploy to Cloudflare Workers again

## Current Configuration

- **Backend**: .NET Core (backend-dotnet/)
- **Tunnel URL**: https://receive-integrating-fossil-majority.trycloudflare.com
- **Account**: 589861 (Production)
- **Last Updated**: Dec 25, 2025

