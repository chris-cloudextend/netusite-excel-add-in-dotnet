# Cache Verification Steps

## Status
The code has been updated with:
1. ✅ Enhanced logging for cache initialization
2. ✅ Manual cache trigger endpoint: `POST /lookups/cache/initialize`
3. ✅ Transaction-based cache using `TransactionLine.subsidiary`

However, the cache initialization is **not running automatically** on server startup. The background task in `Program.cs` may be failing silently.

## Manual Verification Steps

### Step 1: Verify Server is Running
```bash
curl http://localhost:5002/health
```

### Step 2: Manually Trigger Cache Initialization
```bash
curl -X POST http://localhost:5002/lookups/cache/initialize
```

Wait 30-60 seconds for the query to complete, then check logs:
```bash
tail -100 /tmp/dotnet-server.log | grep -i "Building accounting book\|Book-subsidiary cache built\|Query returned\|Health:"
```

You should see:
- `Building accounting book to subsidiaries cache from transaction data...`
- `📊 Executing cache query (timeout: 60s)...`
- `📊 Query returned X rows`
- `✅ Book-subsidiary cache built: X books, Y book-subsidiary mappings`
- `📊 Book-Subsidiary Health: Book 2 -> [2]`

### Step 3: Test the Endpoint
```bash
curl http://localhost:5002/lookups/accountingbook/2/subsidiaries
```

Expected response should include subsidiary 2 (India) for book 2:
```json
{
  "allSubsidiaries": false,
  "subsidiaries": [
    {
      "id": "2",
      "name": "Celigo India Pvt Ltd",
      ...
    }
  ]
}
```

## If Cache Still Not Working

1. **Check if server is running new code:**
   - Look for log message: `⏳ Starting book-subsidiary cache initialization in background...`
   - If not found, server is running old code - rebuild and restart

2. **Rebuild and restart:**
   ```bash
   cd backend-dotnet
   dotnet clean
   dotnet build
   pkill -9 -f "dotnet.*run"
   rm -f /tmp/dotnet-server.log
   nohup dotnet run > /tmp/dotnet-server.log 2>&1 &
   ```

3. **Check for errors in logs:**
   ```bash
   tail -200 /tmp/dotnet-server.log | grep -i "error\|exception\|fail" | tail -20
   ```

## Production Strategy

See `docs/PRODUCTION_CACHE_STRATEGY.md` for AWS deployment options (Redis ElastiCache or DynamoDB).

