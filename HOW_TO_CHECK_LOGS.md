# How to Check Server Logs

## Quick Commands

### 1. View the last 50 lines of the log
Open Terminal and run:
```bash
tail -50 /tmp/dotnet-server.log
```

### 2. View the last 100 lines
```bash
tail -100 /tmp/dotnet-server.log
```

### 3. Watch the log in real-time (updates as new entries appear)
```bash
tail -f /tmp/dotnet-server.log
```
Press `Ctrl+C` to stop watching.

### 4. Search for specific text (cache-related messages)
```bash
grep -i "cache\|Building accounting book\|Book-subsidiary" /tmp/dotnet-server.log | tail -20
```

### 5. Search for errors
```bash
grep -i "error\|fail\|exception" /tmp/dotnet-server.log | tail -20
```

### 6. View the entire log file
```bash
cat /tmp/dotnet-server.log
```
(Note: This might be very long - use with caution)

## What to Look For

### After manually triggering cache initialization:
Look for these messages:
- `⏳ Starting book-subsidiary cache initialization in background...`
- `Building accounting book to subsidiaries cache from transaction data...`
- `📊 Executing cache query (timeout: 60s)...`
- `📊 Query returned X rows`
- `✅ Book-subsidiary cache built: X books, Y book-subsidiary mappings`
- `📊 Book-Subsidiary Health: Book 2 -> [2]`

### If you see errors:
- `Error initializing book-subsidiary cache` - Something went wrong
- `Failed to build book-subsidiary cache` - Query failed
- `No subsidiaries found for accounting book 2` - Cache is empty (might be expected if no transactions exist)

## Step-by-Step: Check if Cache is Working

1. **Open Terminal** (Applications > Utilities > Terminal)

2. **Check if server is running:**
   ```bash
   curl http://localhost:5002/health
   ```
   Should return JSON with `"status": "healthy"`

3. **Trigger cache initialization:**
   ```bash
   curl -X POST http://localhost:5002/lookups/cache/initialize
   ```

4. **Wait 30-60 seconds**, then check logs:
   ```bash
   tail -100 /tmp/dotnet-server.log | grep -i "cache\|Building accounting book\|Book-subsidiary\|Query returned"
   ```

5. **Test the endpoint:**
   ```bash
   curl http://localhost:5002/lookups/accountingbook/2/subsidiaries
   ```

## Alternative: Open Log File in Text Editor

You can also open the log file directly:
1. Open Finder
2. Press `Cmd+Shift+G` (Go to Folder)
3. Type: `/tmp`
4. Find `dotnet-server.log`
5. Open it with TextEdit or any text editor

Note: The file updates in real-time, so you may need to refresh to see new entries.

