# Cache Debugging Guide

## Issue: Cache File Not Being Created

If the cache file doesn't exist after server restart, here's how to debug:

### Step 1: Check Server Status

```bash
# From project root
curl http://localhost:5002/health
```

If server is not running, start it:
```bash
bash excel-addin/useful-commands/start-dotnet-server.sh
```

### Step 2: Check Cache Status

```bash
# From project root
bash excel-addin/useful-commands/check-cache-status.sh
```

This will show:
- Server health
- Cache status endpoint response
- Cache file location and existence
- Recent cache-related log entries

### Step 3: Check Backend Logs

```bash
# From project root
bash excel-addin/useful-commands/check-backend-logs.sh "cache" 100
```

Look for:
- `⏳ Starting book-subsidiary cache initialization in background...`
- `🚀 Calling InitializeBookSubsidiaryCacheAsync...`
- `✅ Book-subsidiary cache built: X books, Y mappings`
- `💾 Saved book-subsidiary cache to disk: ...`
- Any error messages

### Step 4: Manual Cache Initialization

If cache isn't initializing automatically, you can trigger it manually:

```bash
curl -X POST http://localhost:5002/lookups/cache/initialize
```

### Step 5: Verify Cache File Location

The cache file should be at:
- **Mac**: `~/Library/Application Support/XaviApi/book-subsidiary-cache.json`
- **Windows**: `%AppData%\XaviApi\book-subsidiary-cache.json`

Check if directory exists:
```bash
# Mac
ls -la ~/Library/Application\ Support/XaviApi/

# Create directory if needed
mkdir -p ~/Library/Application\ Support/XaviApi/
```

### Common Issues

1. **Server not running**: Cache initialization only happens on server startup
2. **NetSuite query timeout**: The cache query might be timing out (60s timeout)
3. **Permission errors**: The app might not have write permissions to the cache directory
4. **Cache initialization failing silently**: Check backend logs for errors

### Expected Behavior

1. **On server startup**:
   - Server starts
   - After 2 seconds, cache initialization begins in background
   - Query runs against NetSuite (may take 30-60 seconds)
   - Cache is built and saved to disk
   - Log shows: `✅ Book-subsidiary cache built: X books, Y mappings`
   - Log shows: `💾 Saved book-subsidiary cache to disk: ...`

2. **On subsequent startups**:
   - Server starts
   - Cache is loaded from disk immediately
   - Log shows: `✅ Loaded book-subsidiary cache from disk: X books, Y mappings`
   - No NetSuite query needed

3. **If cache file doesn't exist**:
   - Server starts
   - Log shows: `📁 No cached book-subsidiary data found on disk, will build from NetSuite`
   - Cache initialization runs (same as first startup)

### Troubleshooting

If cache is still not working:

1. **Check NetSuite connectivity**:
   ```bash
   curl http://localhost:5002/health
   ```
   Should return `{"status":"healthy",...}`

2. **Check if cache endpoint is working**:
   ```bash
   curl http://localhost:5002/lookups/cache/status
   ```
   Should return `{"ready":true/false,...}`

3. **Check backend logs for errors**:
   ```bash
   tail -100 /tmp/dotnet-server.log | grep -i "error\|exception\|cache"
   ```

4. **Restart server and watch logs**:
   ```bash
   bash excel-addin/useful-commands/start-dotnet-server.sh
   # Watch for cache initialization messages
   ```

