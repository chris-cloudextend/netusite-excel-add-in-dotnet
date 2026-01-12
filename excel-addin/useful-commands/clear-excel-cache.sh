#!/bin/bash
# Clear Excel caches for add-in updates
# This script clears Excel caches without removing the application

set +e  # Don't exit on error (handle permission errors gracefully)

echo "=========================================="
echo "Clearing Excel Caches for Add-in Updates"
echo "=========================================="
echo ""

# Check if Excel is running
if pgrep -x "Microsoft Excel" > /dev/null; then
    echo "⚠️  WARNING: Excel is currently running!"
    echo "   Please close Excel before clearing caches."
    echo "   Press Ctrl+C to cancel, or Enter to continue anyway..."
    read -r
fi

# Excel Cache Directories
echo "🗑️  Clearing Excel Caches..."
EXCEL_CACHE_DIRS=(
    "$HOME/Library/Caches/com.microsoft.Excel"
    "$HOME/Library/Caches/Microsoft/Excel"
)

for cache_dir in "${EXCEL_CACHE_DIRS[@]}"; do
    if [ -d "$cache_dir" ]; then
        echo "   Removing: $cache_dir"
        rm -rf "$cache_dir"
    fi
done

# Excel Container (CRITICAL - Contains add-in data and WEF folder)
echo ""
echo "📁 Clearing Excel Containers (includes add-in data and WEF folder)..."
EXCEL_CONTAINER_DIRS=(
    "$HOME/Library/Containers/com.microsoft.Excel"
)

# Store WEF folder path before clearing
WEF_FOLDER="$HOME/Library/Containers/com.microsoft.Excel/Data/Documents/wef"

for container_dir in "${EXCEL_CONTAINER_DIRS[@]}"; do
    if [ -d "$container_dir" ]; then
        echo "   Removing: $container_dir"
        rm -rf "$container_dir" 2>/dev/null || {
            echo "   ⚠️  Permission denied for some files (this is normal on macOS)"
            echo "   Clearing accessible files only..."
            # Try to clear specific subdirectories that are usually accessible
            find "$container_dir" -type d -name "Data" -exec rm -rf {} + 2>/dev/null || true
            find "$container_dir" -type d -name "Library" -exec rm -rf {} + 2>/dev/null || true
        }
    fi
done

# Recreate WEF folder for sideloaded add-ins
echo ""
echo "📁 Recreating WEF folder for sideloaded add-ins..."
if [ ! -d "$WEF_FOLDER" ]; then
    mkdir -p "$WEF_FOLDER" 2>/dev/null && {
        echo "   ✅ Created: $WEF_FOLDER"
    } || {
        echo "   ⚠️  Could not create WEF folder (may need to restart Excel first)"
    }
else
    echo "   ℹ️  WEF folder already exists: $WEF_FOLDER"
fi

# Excel Saved Application State
echo ""
echo "💾 Clearing Excel Saved Application State..."
EXCEL_STATE_DIRS=(
    "$HOME/Library/Saved Application State/com.microsoft.Excel.savedState"
)

for state_dir in "${EXCEL_STATE_DIRS[@]}"; do
    if [ -d "$state_dir" ]; then
        echo "   Removing: $state_dir"
        rm -rf "$state_dir" 2>/dev/null || echo "   ⚠️  Permission denied (this is normal on macOS)"
    fi
done

# Office Group Containers (contains shared add-in data)
echo ""
echo "👥 Clearing Office Group Containers (shared add-in data)..."
OFFICE_GROUP_DIRS=(
    "$HOME/Library/Group Containers/UBF8T346G9.Office"
    "$HOME/Library/Group Containers/UBF8T346G9.OfficeOsfWebHost"
)

for group_dir in "${OFFICE_GROUP_DIRS[@]}"; do
    if [ -d "$group_dir" ]; then
        echo "   Removing: $group_dir"
        rm -rf "$group_dir" 2>/dev/null || {
            echo "   ⚠️  Permission denied for some files (this is normal on macOS)"
            echo "   Clearing accessible files only..."
            # Try to clear WEF folder specifically (where Excel stores add-in files)
            find "$group_dir" -type d -name "wef" -exec rm -rf {} + 2>/dev/null || true
            find "$group_dir" -type d -path "*/wef/*" -exec rm -rf {} + 2>/dev/null || true
        }
    fi
done

# CRITICAL: Office.js Web Host Cache (OsfWebHost) - This is where Office.js caches add-in resources
echo ""
echo "🌐 Clearing Office.js Web Host Cache (OsfWebHost) - CRITICAL for add-in updates..."
OSFWEBHOST_DIRS=(
    "$HOME/Library/Containers/com.Microsoft.OsfWebHost"
    "$HOME/Library/Containers/com.microsoft.OsfWebHost"
)

for osf_dir in "${OSFWEBHOST_DIRS[@]}"; do
    if [ -d "$osf_dir" ]; then
        echo "   Removing: $osf_dir"
        rm -rf "$osf_dir" 2>/dev/null || {
            echo "   ⚠️  Permission denied for some files (this is normal on macOS)"
            echo "   Clearing accessible files only..."
            # Try to clear Data folder specifically (contains cached resources)
            if [ -d "$osf_dir/Data" ]; then
                rm -rf "$osf_dir/Data"/* 2>/dev/null || true
            fi
        }
    fi
done

# Excel Container - Additional cache locations
echo ""
echo "📦 Clearing Excel Container caches (add-in metadata and resources)..."
EXCEL_CONTAINER_CACHES=(
    "$HOME/Library/Containers/com.microsoft.Excel/Data/Library/Caches"
    "$HOME/Library/Containers/com.microsoft.Excel/Data/Library/Application Support/Microsoft/Office/16.0/Wef"
    "$HOME/Library/Containers/com.microsoft.Excel/Data/Library/Application Support/Microsoft/Office/16.0/Wef/CustomFunctions"
    "$HOME/Library/Containers/com.microsoft.Excel/Data/Library/Application Support/Microsoft/Office/16.0/Wef/AppCommands"
)

for cache_path in "${EXCEL_CONTAINER_CACHES[@]}"; do
    if [ -d "$cache_path" ]; then
        echo "   Removing: $cache_path"
        rm -rf "$cache_path" 2>/dev/null || {
            echo "   ⚠️  Permission denied (this is normal on macOS)"
        }
    fi
done

# Office 365 Service Cache
echo ""
echo "☁️  Clearing Office 365 Service Cache..."
OFFICE365_CACHES=(
    "$HOME/Library/Containers/com.microsoft.Office365ServiceV2/Data/Caches/com.microsoft.Office365ServiceV2"
    "$HOME/Library/Containers/com.microsoft.Office365ServiceV2/Data/Caches"
)

for cache_path in "${OFFICE365_CACHES[@]}"; do
    if [ -d "$cache_path" ]; then
        echo "   Removing: $cache_path"
        rm -rf "$cache_path" 2>/dev/null || {
            echo "   ⚠️  Permission denied (this is normal on macOS)"
        }
    fi
done

# Excel Preferences (optional - only if you want to reset all Excel settings)
echo ""
echo "⚙️  Note: Excel preferences are NOT cleared (to preserve your settings)"
echo "   If you need to reset preferences, manually delete:"
echo "   ~/Library/Preferences/com.microsoft.Excel.plist"

echo ""
echo "=========================================="
echo "✅ Cache clearing complete!"
echo "=========================================="
echo ""
echo "📋 Summary of cleared locations:"
echo "   ✅ Excel caches"
echo "   ✅ Excel containers (including WEF folder)"
echo "   ✅ Excel saved application state"
echo "   ✅ Office group containers"
echo "   ✅ Office.js Web Host Cache (OsfWebHost) - CRITICAL"
echo "   ✅ Excel container caches (WEF metadata)"
echo "   ✅ Office 365 Service Cache"
echo ""
echo "⚠️  IMPORTANT: If Excel is running, you MUST:"
echo "   1. Quit Excel completely (Cmd+Q, not just close window)"
echo "   2. Wait 5 seconds"
echo "   3. Reopen Excel"
echo "   4. Re-add your add-in from the manifest"
echo ""
echo "💡 If the version still shows incorrectly:"
echo "   1. Remove the add-in from Excel (Insert > My Add-ins > ... > Remove)"
echo "   2. Copy manifest.xml to: ~/Library/Containers/com.microsoft.Excel/Data/Documents/wef/"
echo "   3. Restart Excel"
echo "   4. Insert > My Add-ins > Developer > Add from File"
echo ""

