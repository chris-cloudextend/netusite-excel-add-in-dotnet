# Testing Setup Guide - Phases 1-3 Changes

## ✅ Question 1: Manifest Cache Busting

**Answer: NO - Manifest update NOT needed**

**Why:**
- The changes made in Phases 1-3 are **backend-only** (.NET code in `backend-dotnet/`)
- The manifest is only for **frontend files** (functions.js, taskpane.html, etc.)
- Backend API changes don't require manifest updates
- Excel will automatically use the new backend code when it makes API calls

**When you WOULD need manifest updates:**
- If you change `docs/functions.js` (frontend)
- If you change `docs/taskpane.html` (frontend)
- If you change `docs/sharedruntime.html` (frontend)

---

## ✅ Question 2: Testing from Excel - Will it Hit the Right Code?

**Answer: YES, but you need to RESTART the .NET backend first**

### Current Status:
- ✅ Backend is running (PID 34466) - but it's running OLD code (started before changes)
- ✅ Tunnel is active (PID 62772) - pointing to `https://importance-euro-danny-vision.trycloudflare.com`
- ✅ You're on branch `fix/accounting-period-ids` - code changes are in working directory
- ⚠️ **Backend needs restart** to load the new code

### How Excel Connects to Your Code:

```
Excel → Cloudflare Worker → Cloudflare Tunnel → Local .NET Backend (localhost:5002)
```

1. **Excel** loads frontend from GitHub Pages (manifest URLs)
2. **Frontend** calls Cloudflare Worker (`netsuite-proxy.chris-corcoran.workers.dev`)
3. **Worker** forwards to Cloudflare Tunnel (`https://importance-euro-danny-vision.trycloudflare.com`)
4. **Tunnel** connects to your local backend (`localhost:5002`)
5. **Backend** uses code from your working directory

**Key Point:** Since the backend runs locally, it uses the code in your working directory. But the running process was started BEFORE your changes, so it needs a restart.

---

## 🔄 Steps to Test Your Changes

### Step 1: Restart the .NET Backend

```bash
# Kill the existing backend
pkill -f "dotnet.*run"

# Restart it (this will load your new code)
cd /Users/chriscorcoran/Documents/Cursor/NetSuite-Excel-AddIn-DotNet
./useful-commands/start-dotnet-server.sh
```

**OR manually:**
```bash
cd backend-dotnet
dotnet run
```

### Step 2: Verify Backend is Running New Code

The backend should start without errors. Check the logs to confirm it's using the new code:
- Look for any compilation errors
- The server should start on `http://localhost:5002`

### Step 3: Verify Tunnel is Still Active

```bash
# Check if tunnel is running
ps aux | grep "cloudflared tunnel" | grep -v grep

# If not running, start it:
./useful-commands/start-tunnel.sh
```

**Note:** The tunnel URL might change when you restart it. If it does:
1. Update `CLOUDFLARE-WORKER-CODE.js` with the new URL
2. Deploy the updated worker code to Cloudflare (see instructions in `start-tunnel.sh` output)

### Step 4: Test in Excel

1. Open Excel
2. Use a formula like: `=XAVI.BALANCE("4220", "2025")` (year-only input)
3. Check the console logs (if you have developer tools enabled)
4. Verify the results match expected behavior

---

## 🔍 Verification Checklist

Before testing, verify:

- [ ] Backend is restarted (killed old process, started new one)
- [ ] Backend starts without compilation errors
- [ ] Tunnel is active (check with `ps aux | grep cloudflared`)
- [ ] Tunnel URL in `CLOUDFLARE-WORKER-CODE.js` matches active tunnel
- [ ] Cloudflare Worker is deployed with correct tunnel URL
- [ ] Excel add-in is loaded (check Insert → My Add-ins)

---

## 🧪 Test Cases to Verify

### Test 1: Year-Only Input
```
=XAVI.BALANCE("4220", "2025")
```
**Expected:** Should resolve to same 12 periods as entering all months individually

### Test 2: Period Range
```
=XAVI.BALANCE("4220", "Jan 2023", "Dec 2025")
```
**Expected:** Should use period IDs for all periods in range

### Test 3: Full-Year Batch (Quick Start)
- Generate full income statement for 2025
- **Expected:** Should use same period IDs as individual month queries

---

## ⚠️ Important Notes

1. **No Git Push Needed for Testing:**
   - The backend runs from your local working directory
   - Changes are already in your local files
   - Just restart the backend to load new code

2. **Tunnel URL May Change:**
   - If you restart the tunnel, it gets a new URL
   - Update `CLOUDFLARE-WORKER-CODE.js` with the new URL
   - Deploy to Cloudflare Worker

3. **Frontend Code Unchanged:**
   - No changes to `docs/functions.js` or other frontend files
   - No manifest update needed
   - Excel will automatically use new backend when making API calls

---

## 🚀 Quick Start Commands

```bash
# 1. Restart backend (loads new code)
pkill -f "dotnet.*run" && cd backend-dotnet && dotnet run

# 2. Verify tunnel is active (restart if needed)
ps aux | grep "cloudflared tunnel" | grep -v grep || ./useful-commands/start-tunnel.sh

# 3. Check backend health
curl http://localhost:5002/health
```

---

**Status:** Ready to test! Just restart the backend and you're good to go.

