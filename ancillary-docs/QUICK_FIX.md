# Quick Fix: Restart Server to Load New Cache Code

## The Problem
The server is running **old compiled code** - the cache initialization isn't running because the server needs to be restarted with the new build.

## Solution: Restart the Server

### Option 1: Use the Script (Easiest)
```bash
./RESTART_SERVER.sh
```

This will:
1. Stop the old server
2. Clean and rebuild
3. Start the new server
4. Check for cache initialization

### Option 2: Manual Steps

1. **Stop the server:**
   ```bash
   pkill -9 -f "dotnet.*run"
   ```

2. **Clean and rebuild:**
   ```bash
   cd backend-dotnet
   dotnet clean
   dotnet build
   ```

3. **Start the server:**
   ```bash
   rm -f /tmp/dotnet-server.log
   nohup dotnet run > /tmp/dotnet-server.log 2>&1 &
   ```

4. **Wait 60 seconds**, then check logs:
   ```bash
   tail -100 /tmp/dotnet-server.log | grep -i "cache\|Building accounting book"
   ```

5. **Or manually trigger cache:**
   ```bash
   curl -X POST http://localhost:5002/lookups/cache/initialize
   sleep 30
   tail -50 /tmp/dotnet-server.log | grep -i "cache\|Building accounting book"
   ```

## What You Should See

After restart, you should see these messages in the logs:
- `⏳ Starting book-subsidiary cache initialization in background...`
- `Building accounting book to subsidiaries cache from transaction data...`
- `📊 Executing cache query (timeout: 60s)...`
- `✅ Book-subsidiary cache built: X books, Y mappings`
- `📊 Book-Subsidiary Health: Book 2 -> [2]`

## Test the Endpoint

Once cache is built:
```bash
curl http://localhost:5002/lookups/accountingbook/2/subsidiaries
```

Should return subsidiary 2 (India) for book 2.

