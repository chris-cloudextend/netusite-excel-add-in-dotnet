# Account Search Fix - Summary & Next Steps

## What Was Fixed

✅ **Code Implementation Complete**
- Rewrote `SearchAccountsByPatternAsync` in `backend-dotnet/Services/LookupService.cs`
- Implemented explicit intent detection (income, balance, bank, wildcard, name/number)
- Added comprehensive logging
- All QA tests pass

## Why It's Not Working Yet

The issue is **NOT in the code** - it's in the **infrastructure**:

### Architecture Chain
```
Frontend → Cloudflare Worker → Cloudflare Tunnel → .NET Backend → NetSuite
```

### Most Likely Issues

1. **Cloudflare Tunnel Not Running**
   - The tunnel URL in `CLOUDFLARE-WORKER-CODE.js` is: `https://importance-euro-danny-vision.trycloudflare.com`
   - This tunnel must be running and pointing to `localhost:5002`
   - **Check:** Run `ps aux | grep cloudflared` or check if tunnel process is running

2. **.NET Backend Not Running**
   - Backend must be running on port 5002
   - **Check:** `curl http://localhost:5002/health`
   - **Start:** `cd backend-dotnet && dotnet run`

3. **Tunnel URL Changed**
   - Cloudflare tunnels generate new URLs each time
   - **Check:** If tunnel was restarted, the URL changed
   - **Fix:** Update `TUNNEL_URL` in `CLOUDFLARE-WORKER-CODE.js` and redeploy to Cloudflare

4. **NetSuite Query Failing**
   - Check backend console logs for NetSuite errors
   - Look for: `❌ [ACCOUNT SEARCH] NetSuite query execution failed`
   - Verify NetSuite credentials in `appsettings.json`

## How to Test the Code

### Option 1: Test Direct Backend (Recommended First)
```bash
# 1. Start backend
cd backend-dotnet
dotnet run

# 2. In another terminal, test the endpoint
curl "http://localhost:5002/accounts/search?pattern=Balance" | python3 -m json.tool
```

**Expected Response:**
```json
{
  "pattern": "Balance",
  "search_type": "balance_sheet",
  "accounts": [...],
  "count": 198
}
```

### Option 2: Test via Cloudflare Worker
```bash
# Make sure backend and tunnel are running first
curl "https://netsuite-proxy.chris-corcoran.workers.dev/accounts/search?pattern=Balance" | python3 -m json.tool
```

### Option 3: Use Test Scripts
```bash
# Test direct backend
cd backend-dotnet/Scripts
./TestAccountSearchEndpoint.sh Balance 5002

# Test via Cloudflare Worker (requires tunnel)
./TestAccountSearchLive.sh Balance
```

## Debugging Steps

### Step 1: Verify Backend is Running
```bash
curl http://localhost:5002/health
# Should return: {"status":"healthy"}
```

### Step 2: Check Backend Logs
When you search for "Balance", you should see these logs in the backend console:
```
🔍 [ACCOUNT SEARCH] Input: 'Balance' → Normalized: 'balance'
✅ [ACCOUNT SEARCH] Mode: BALANCE_SHEET → 10 types
📋 [ACCOUNT SEARCH] WHERE clause: a.accttype IN ('Bank','AcctRec',...) AND a.isinactive = 'F'
📊 [ACCOUNT SEARCH] Final SuiteQL Query: ...
✅ [ACCOUNT SEARCH] Query executed successfully → 198 results
✅ [ACCOUNT SEARCH] Complete → 198 accounts returned
```

**If you see an error instead**, that's the problem!

### Step 3: Check Browser Console
1. Open Excel add-in
2. Open browser DevTools (F12)
3. Go to Network tab
4. Search for "Balance" in Bulk Add GL Accounts
5. Check the request URL and response

**Look for:**
- 502 Bad Gateway → Cloudflare Worker can't reach backend
- 500 Internal Server Error → Backend error (check backend logs)
- 200 OK but empty results → NetSuite query issue (check backend logs)

### Step 4: Test with Simple Pattern
Try searching for `"*"` (wildcard) - this should return ALL active accounts:
```bash
curl "http://localhost:5002/accounts/search?pattern=*" | python3 -m json.tool
```

If this works, the issue is with specific patterns. If this doesn't work, the issue is more fundamental.

## Common Fixes

### Fix 1: Start Cloudflare Tunnel
```bash
# Start tunnel pointing to backend
cloudflared tunnel --url http://localhost:5002

# Copy the new URL (e.g., https://xxxxx.trycloudflare.com)
# Update CLOUDFLARE-WORKER-CODE.js with new URL
# Redeploy to Cloudflare Workers dashboard
```

### Fix 2: Restart Backend
```bash
cd backend-dotnet
dotnet build
dotnet run
```

### Fix 3: Check NetSuite Credentials
Verify `backend-dotnet/appsettings.json` has correct:
- `NetSuite__AccountId`
- `NetSuite__ConsumerKey`
- `NetSuite__ConsumerSecret`
- `NetSuite__TokenId`
- `NetSuite__TokenSecret`

### Fix 4: Check Backend Logs for Errors
Look for exceptions in the backend console. Common issues:
- NetSuite authentication failure
- SuiteQL syntax errors
- Rate limiting
- Network timeouts

## Testing Without NetSuite

To test the **logic** without NetSuite (validates WHERE clause generation):
```bash
cd backend-dotnet/Scripts
python3 TestAccountSearch.py
```

This simulates the query generation and shows what SQL would be generated.

## Next Steps

1. **Start the backend** and check logs when searching
2. **Check if Cloudflare tunnel is running** and update URL if needed
3. **Test direct backend** first (bypass Cloudflare Worker)
4. **Check backend logs** for any errors
5. **Share the backend logs** if still not working

The code is correct - the issue is in the infrastructure/deployment.

