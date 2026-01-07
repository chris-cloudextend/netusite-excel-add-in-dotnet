# Account Search Debugging Guide

## Issue: Account search returns no results

### Architecture
1. **Frontend** (`taskpane.html`) → calls `https://netsuite-proxy.chris-corcoran.workers.dev/accounts/search?pattern=Balance`
2. **Cloudflare Worker** → proxies to `https://importance-euro-danny-vision.trycloudflare.com/accounts/search?pattern=Balance`
3. **Cloudflare Tunnel** → forwards to `http://localhost:5002/accounts/search?pattern=Balance`
4. **.NET Backend** → executes NetSuite query via `LookupService.SearchAccountsByPatternAsync`

### Debugging Steps

#### 1. Check if .NET backend is running
```bash
curl http://localhost:5002/health
# Should return: {"status":"healthy"}
```

#### 2. Check if Cloudflare Tunnel is running
```bash
# Check if tunnel process is running
ps aux | grep cloudflared

# Or check if tunnel URL responds
curl https://importance-euro-danny-vision.trycloudflare.com/health
```

#### 3. Test direct backend endpoint
```bash
cd backend-dotnet/Scripts
./TestAccountSearchEndpoint.sh Balance 5002
```

#### 4. Test via Cloudflare Worker
```bash
cd backend-dotnet/Scripts
./TestAccountSearchLive.sh Balance
```

#### 5. Check backend logs
Look for these log messages in the .NET backend console:
- `🔍 [ACCOUNT SEARCH] Input: 'Balance' → Normalized: 'balance'`
- `✅ [ACCOUNT SEARCH] Mode: BALANCE_SHEET → 10 types`
- `📋 [ACCOUNT SEARCH] WHERE clause: ...`
- `📊 [ACCOUNT SEARCH] Final SuiteQL Query: ...`
- `✅ [ACCOUNT SEARCH] Query executed successfully → X results`

#### 6. Common Issues

**Issue: Backend not running**
- Solution: Start the .NET backend: `cd backend-dotnet && dotnet run`

**Issue: Cloudflare Tunnel not running**
- Solution: Start tunnel: `cloudflared tunnel --url http://localhost:5002`
- Update `CLOUDFLARE-WORKER-CODE.js` with new tunnel URL

**Issue: Tunnel URL changed**
- Solution: Update `TUNNEL_URL` in `CLOUDFLARE-WORKER-CODE.js` and redeploy to Cloudflare

**Issue: NetSuite query failing**
- Check backend logs for NetSuite errors
- Verify NetSuite credentials in `appsettings.json`
- Check if NetSuite account has SuiteQL permissions

**Issue: CORS errors**
- Cloudflare Worker should handle CORS
- Check browser console for CORS errors

### Testing the Code

To test the account search logic without NetSuite:

```bash
cd backend-dotnet/Scripts
python3 TestAccountSearch.py
```

This simulates the WHERE clause generation and validates the logic.

### Manual Testing

1. **Start .NET backend:**
   ```bash
   cd backend-dotnet
   dotnet run
   ```

2. **Start Cloudflare Tunnel (if needed):**
   ```bash
   cloudflared tunnel --url http://localhost:5002
   ```

3. **Test direct backend:**
   ```bash
   curl "http://localhost:5002/accounts/search?pattern=Balance" | python3 -m json.tool
   ```

4. **Test via Cloudflare Worker:**
   ```bash
   curl "https://netsuite-proxy.chris-corcoran.workers.dev/accounts/search?pattern=Balance" | python3 -m json.tool
   ```

5. **Check browser console:**
   - Open Excel add-in
   - Open browser DevTools (F12)
   - Go to Network tab
   - Search for "Balance" in Bulk Add GL Accounts
   - Check the request/response

### Expected Response Format

```json
{
  "pattern": "Balance",
  "search_type": "balance_sheet",
  "accounts": [
    {
      "Id": "123",
      "Number": "10010",
      "Name": "Cash",
      "Type": "Bank",
      "SpecialAccountType": null,
      "Parent": null
    }
  ],
  "count": 198
}
```

### If Still Not Working

1. Check backend logs for exceptions
2. Verify NetSuite credentials are correct
3. Test with a simple pattern like `"*"` (should return all active accounts)
4. Check if other endpoints work (e.g., `/health`, `/account/type`)
5. Verify the Cloudflare Worker is deployed with latest code

