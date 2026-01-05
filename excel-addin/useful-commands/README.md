# Useful Commands

This folder contains helpful scripts for development and debugging.

## Commands

### 1. Enable Excel Developer Tools
**File**: `enable-excel-developer-tools.sh`

Enables right-click "Inspect Element" in Excel task pane on Mac.

**Usage**:
```bash
./useful-commands/enable-excel-developer-tools.sh
```

**What it does**:
- Sets `OfficeWebAddinDeveloperExtras` preference to enable developer tools
- After running, restart Excel and right-click in task pane to access "Inspect Element"

---

### 2. Start .NET Server
**File**: `start-dotnet-server.sh`

Starts the .NET backend server on port 5002.

**Usage**:
```bash
./useful-commands/start-dotnet-server.sh
```

**What it does**:
- Checks if server is already running (exits if healthy)
- Kills any existing server processes
- Starts server in background
- Waits for health check endpoint to respond
- Logs to `/tmp/dotnet-server.log`

**Health Check**: `http://localhost:5002/health`

---

### 3. Start Cloudflare Tunnel
**File**: `start-tunnel.sh`

Starts Cloudflare tunnel to expose local .NET server to the internet.

**Usage**:
```bash
./useful-commands/start-tunnel.sh
```

**What it does**:
1. Checks if .NET server is running (starts it if not)
2. Stops any existing tunnel processes
3. Starts new Cloudflare tunnel
4. Extracts tunnel URL from logs
5. Updates `CLOUDFLARE-WORKER-CODE.js` with new tunnel URL
6. Displays deployment instructions

**Requirements**:
- `cloudflared` must be installed (`brew install cloudflared`)
- .NET server must be running (or will be started automatically)

**To stop tunnel**:
```bash
pkill -f 'cloudflared tunnel'
```

---

### 4. Clear Excel Cache
**File**: `clear-excel-cache.sh`

Clears Excel caches for add-in updates without removing the application.

**Usage**:
```bash
./useful-commands/clear-excel-cache.sh
```

**What it does**:
- Clears Excel caches (`~/Library/Caches/com.microsoft.Excel`)
- Clears Excel containers (including add-in data and WEF folder)
- Clears Excel saved application state
- Clears Office group containers (shared add-in data)
- Recreates the WEF folder after clearing

**Note**: Some files may be protected by macOS System Integrity Protection (this is normal).

**After running**:
1. Restart Excel (if running, close and reopen)
2. Re-add your Excel add-in from the manifest
3. Test the new version

---

### 5. Create and Open WEF Folder
**File**: `create-wef-folder.sh`

Creates the WEF folder where Excel stores manifest files for sideloaded add-ins, and opens it in Finder.

**Usage**:
```bash
./useful-commands/create-wef-folder.sh
```

**What it does**:
- Creates the WEF folder at `~/Library/Containers/com.microsoft.Excel/Data/Documents/wef`
- Opens the folder in Finder
- Displays instructions for sideloading add-ins

**Location**: `~/Library/Containers/com.microsoft.Excel/Data/Documents/wef`

**To sideload an add-in**:
1. Copy your `manifest.xml` file to this folder
2. Restart Excel
3. The add-in should appear in Excel's Insert > Add-ins menu

---

### 6. Check Backend Logs
**File**: `check-backend-logs.sh`

Views backend server logs with optional filtering.

**Usage**:
```bash
# Show last 100 lines (default)
bash ./useful-commands/check-backend-logs.sh

# Filter by search term (case-insensitive)
bash ./useful-commands/check-backend-logs.sh "REVENUE DEBUG"

# Show more lines with filter
bash ./useful-commands/check-backend-logs.sh "error" 200

# Or run from within the useful-commands directory:
cd excel-addin/useful-commands
bash check-backend-logs.sh "REVENUE DEBUG"
```

**What it does**:
- Reads from `/tmp/dotnet-server.log`
- Shows last N lines (default: 100)
- Optional case-insensitive filtering
- Color-coded output for better readability

**Common filters**:
- `"REVENUE DEBUG"` - Income/revenue debugging logs
- `"error"` - Error messages
- `"Income"` - Income-related logs
- `"subsidiary"` - Subsidiary-related logs

**To watch logs live**:
```bash
tail -f /tmp/dotnet-server.log
```

---

## Quick Reference

```bash
# Enable developer tools (one-time setup)
./useful-commands/enable-excel-developer-tools.sh

# Start development server
./useful-commands/start-dotnet-server.sh

# Start tunnel (requires server running)
./useful-commands/start-tunnel.sh

# Clear Excel cache (before testing new version)
./useful-commands/clear-excel-cache.sh

# Create and open WEF folder (for sideloading add-ins)
./useful-commands/create-wef-folder.sh

# Check backend server logs
bash ./useful-commands/check-backend-logs.sh                    # Last 100 lines
bash ./useful-commands/check-backend-logs.sh "REVENUE DEBUG"   # Filter by "REVENUE DEBUG"
bash ./useful-commands/check-backend-logs.sh "error" 200        # Last 200 lines filtered by "error"
```

---

## Notes

- All scripts are executable and can be run from the project root
- Scripts handle path resolution automatically
- Logs are written to `/tmp/` for easy access
- Scripts check for existing processes before starting new ones

