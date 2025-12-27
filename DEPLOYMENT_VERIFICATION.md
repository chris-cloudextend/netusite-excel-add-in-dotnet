# Deployment Verification Checklist

## Issue: Zero Balance Accounts Not Cached

### Problem
Accounts 10413, 10206, 10411 are not being cached during preload, causing 3+ minutes of additional API calls.

### Root Cause Analysis
1. ✅ **Backend Query Fix Applied**: The query now uses LEFT JOIN with CASE WHEN to include zero balance accounts
2. ✅ **Query Tested**: Direct query test confirms accounts ARE returned with balance = 0
3. ❓ **Backend Deployment**: Need to verify backend is running updated code

## Deployment Steps

### 1. Backend Deployment
**Action Required:** Restart the .NET backend to load updated code

```bash
# Option 1: Use restart script
./restart-dotnet-backend.sh

# Option 2: Manual restart
cd backend-dotnet
# Kill existing process
pkill -f "dotnet.*run"
# Start fresh
dotnet run
```

**Verification:**
- Check backend logs for: "✅ Problematic accounts found in query results: 10413=0, 10206=0, 10411=0"
- If you see: "⚠️ Problematic accounts NOT found in query results!" → Backend is NOT running updated code

### 2. Frontend Deployment
**Status:** ✅ Already deployed (v4.0.0.50)
- All cache-busting versions updated
- Logging added to track problematic accounts

**Verification:**
- Check browser console for: "✅ All problematic accounts (10413, 10206, 10411) are in cache"
- If you see: "⚠️ Problematic accounts NOT in cache" → Backend query didn't return them

## Verification Steps

### Step 1: Check Backend Logs
After restarting backend, trigger a preload and check logs for:
```
✅ BS PRELOAD [Jan 2025]: X accounts in Ys (Z with zero balance, W with non-zero balance)
   ✅ Problematic accounts found in query results: 10413=0, 10206=0, 10411=0
```

### Step 2: Check Frontend Console
After preload completes, check browser console for:
```
✅ Cached X BS accounts for 1 period(s) (Y with zero balances)
   🔍 Problematic account 10413 cached: balance = 0 for Jan 2025
   🔍 Problematic account 10206 cached: balance = 0 for Jan 2025
   🔍 Problematic account 10411 cached: balance = 0 for Jan 2025
   ✅ All problematic accounts (10413, 10206, 10411) are in cache
```

### Step 3: Test Cache Lookup
After preload, add formulas for 10413, 10206, 10411 and verify:
- Console shows: "✅ Preload cache hit (xavi_balance_cache): 10413 for Jan 2025 = 0"
- Formulas resolve instantly (no API calls)

## If Accounts Still Not Cached

### Possible Causes:
1. **Backend not restarted** → Restart backend
2. **Backend query error** → Check backend logs for query errors
3. **Segment filters excluding accounts** → Check if department/class/location filters are applied
4. **NetSuite SuiteQL limitation** → The CASE WHEN pattern might not be supported (unlikely, but possible)

### Debug Commands:
```bash
# Check if backend is running updated code
curl -X POST http://localhost:5002/test/query \
  -H "Content-Type: application/json" \
  -d '{"q": "SELECT acctnumber, balance FROM (your query here)", "timeout": 180}'

# Check backend logs
tail -f /tmp/dotnet-server.log | grep -i "problematic\|zero balance"
```

## Expected Behavior After Fix

1. **Preload triggers** when first BS formula is entered
2. **Backend query returns** all BS accounts including zero balances
3. **Frontend caches** all accounts (zero and non-zero)
4. **Subsequent formulas** resolve instantly from cache
5. **No individual API calls** for zero balance accounts

## Files Changed

### Backend:
- `backend-dotnet/Controllers/BalanceController.cs`
  - Added logging for zero balance accounts
  - Added logging for problematic accounts (10413, 10206, 10411)
  - Query fix: CASE WHEN tl.id IS NOT NULL in SUM
  - Query fix: Accounting book filter moved to JOIN

### Frontend:
- `docs/taskpane.html`
  - Added logging to verify problematic accounts in cache
  - Enhanced preload completion logging

## Next Steps

1. **Restart backend** to load updated code
2. **Test preload** and check logs
3. **Verify accounts are cached** in console
4. **Test formulas** for 10413, 10206, 10411
5. **Report results** - if still not working, we'll investigate further

