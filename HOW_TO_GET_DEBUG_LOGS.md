# How to Get Debug Logs

**Date:** January 6, 2026  
**Purpose:** Guide for accessing debug logs to troubleshoot BALANCE formula accounting book issues

---

## Quick Start

### Backend Logs (Server)
```bash
# Use the log checking script (recommended)
bash excel-addin/useful-commands/check-balance-logs.sh

# Or view logs directly
tail -f /tmp/dotnet-server.log | grep -E 'BALANCE|accountingBook'
```

### Frontend Logs (Browser)
1. Open Excel
2. Press **F12** (or right-click in task pane → "Inspect Element")
3. Click **Console** tab
4. Look for logs starting with `🔍` or `BALANCE DEBUG`

---

## Detailed Instructions

### 1. Backend Logs (Server-Side)

#### Option A: Use the Log Checking Script (Easiest)
```bash
bash excel-addin/useful-commands/check-balance-logs.sh
```

**What it shows:**
- Recent BALANCE debug entries
- SQL queries with accounting book filters
- BalanceController entries
- Errors related to accounting book
- Last 50 lines of log for context

#### Option B: View Logs Directly
```bash
# View entire log file
cat /tmp/dotnet-server.log

# View last 100 lines
tail -n 100 /tmp/dotnet-server.log

# Watch logs in real-time
tail -f /tmp/dotnet-server.log

# Filter for BALANCE-related logs
grep -E 'BALANCE|accountingBook' /tmp/dotnet-server.log | tail -n 50

# Filter for specific account
grep -E 'account=49998|accountingBook' /tmp/dotnet-server.log | tail -n 50
```

#### Option C: Copy Log File
```bash
# Copy to Desktop
bash excel-addin/useful-commands/copy-backend-log.sh

# Copy to custom location
bash excel-addin/useful-commands/copy-backend-log.sh ~/Desktop/my-log.log
```

---

### 2. Frontend Logs (Browser Console)

#### Step-by-Step:
1. **Open Excel** with your add-in loaded
2. **Open Developer Tools:**
   - **Mac:** Press `F12` or `Cmd+Option+I`
   - **Windows:** Press `F12` or `Ctrl+Shift+I`
   - Or: Right-click in the task pane → "Inspect Element"
3. **Click the "Console" tab**
4. **Filter logs:**
   - Type `BALANCE` in the filter box to see only BALANCE-related logs
   - Type `accountingBook` to see accounting book related logs
   - Type `🔍` to see all debug logs

#### What to Look For:

**BALANCE Function Entry:**
```
🔍 BALANCE DEBUG: account=49998, accountingBook="2" (raw: 2, type: number)
```

**Full Year Refresh:**
```
📊 Full Refresh Request:
   🔍 DEBUG: accountingBook="2" (from first request)
   🔍 DEBUG: Payload includes accountingBook="2"
```

**API Calls:**
```
📤 Cumulative API: 49998 through Jan 2025 [BOOK: 2]
🔍 DEBUG: API params - accountingbook="2" (type: string)
🔍 DEBUG: Full API URL: http://localhost:5002/balance?account=49998&...
🔍 DEBUG: All API params: {account: "49998", accountingbook: "2", ...}
```

---

## What to Check

### ✅ Good Signs (Accounting Book is Working)

**Frontend:**
- `accountingBook="2"` (not empty or "1")
- API URL contains `accountingbook=2`
- Payload includes `accountingBook="2"`

**Backend:**
- `🔍 [BALANCE DEBUG] BalanceController.GetBalance: book=2`
- `🔍 [BALANCE DEBUG] GetBalanceAsync: accountingBook=2`
- SQL query contains `tal.accountingbook = 2` (not `= 1`)

### ❌ Bad Signs (Accounting Book Issue)

**Frontend:**
- `accountingBook=""` or `accountingBook="1"` when U3 is "2"
- API URL contains `accountingbook=` or `accountingbook=1`
- Payload shows `accountingBook=""` or missing

**Backend:**
- `book=null` or `book=1` when U3 is "2"
- `accountingBook=1` when it should be "2"
- SQL query contains `tal.accountingbook = 1` when it should be `= 2`

---

## Example: Testing BALANCE with Book 2

### 1. Set Up Test
- Set Excel cell **U3** to `2` (verify it contains "2")
- Enter formula: `=XAVI.BALANCE("49998", "Jan 2025", "Jan 2025", Q3, "", "", "", U3)`

### 2. Check Frontend Logs (Browser F12)
Look for:
```
🔍 BALANCE DEBUG: account=49998, accountingBook="2" (raw: 2, type: number)
📤 Cumulative API: 49998 through Jan 2025 [BOOK: 2]
🔍 DEBUG: API params - accountingbook="2" (type: string)
```

### 3. Check Backend Logs
```bash
bash excel-addin/useful-commands/check-balance-logs.sh
```

Or:
```bash
tail -f /tmp/dotnet-server.log | grep -E 'BALANCE|accountingBook'
```

Look for:
```
🔍 [BALANCE DEBUG] BalanceController.GetBalance: account=49998, book=2
🔍 [BALANCE DEBUG] GetBalanceAsync: accountingBook=2
🔍 [BALANCE DEBUG] Point-in-time query SQL: ... tal.accountingbook = 2 ...
```

---

## Common Issues

### Issue 1: No Logs Appearing
**Solution:**
- Make sure server is running: `bash excel-addin/useful-commands/start-dotnet-server.sh`
- Check log file exists: `ls -la /tmp/dotnet-server.log`
- Verify browser console is open (F12)

### Issue 2: Logs Show Wrong Accounting Book
**Check:**
- Excel cell U3 actually contains "2" (click on it to verify)
- Formula references U3 correctly: `=XAVI.BALANCE(..., U3)`
- No cached values from previous Book 1 run

### Issue 3: Can't Find Log File
**Solution:**
```bash
# Check if log file exists
ls -la /tmp/dotnet-server.log

# If it doesn't exist, start the server
bash excel-addin/useful-commands/start-dotnet-server.sh

# Then check again
tail -f /tmp/dotnet-server.log
```

---

## Advanced: Filtering Logs

### Backend (Terminal)
```bash
# Only BALANCE debug logs
grep '\[BALANCE DEBUG\]' /tmp/dotnet-server.log

# Only accounting book related
grep 'accountingBook' /tmp/dotnet-server.log

# Only errors
grep -i 'error.*book\|book.*error' /tmp/dotnet-server.log

# Last 20 lines with accounting book
grep 'accountingBook' /tmp/dotnet-server.log | tail -n 20

# Real-time watch with filter
tail -f /tmp/dotnet-server.log | grep --line-buffered 'BALANCE\|accountingBook'
```

### Frontend (Browser Console)
- Type in filter box: `BALANCE` - shows only BALANCE logs
- Type: `accountingBook` - shows only accounting book logs
- Type: `🔍` - shows all debug logs
- Type: `error` - shows only errors

---

## Quick Reference Commands

```bash
# Check logs (recommended)
bash excel-addin/useful-commands/check-balance-logs.sh

# View last 50 lines
tail -n 50 /tmp/dotnet-server.log

# Watch logs in real-time
tail -f /tmp/dotnet-server.log

# Filter for BALANCE
grep -E 'BALANCE|accountingBook' /tmp/dotnet-server.log | tail -n 50

# Copy log to Desktop
bash excel-addin/useful-commands/copy-backend-log.sh
```

---

**End of Guide**

