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

# Excel Preferences (optional - only if you want to reset all Excel settings)
echo ""
echo "⚙️  Note: Excel preferences are NOT cleared (to preserve your settings)"
echo "   If you need to reset preferences, manually delete:"
echo "   ~/Library/Preferences/com.microsoft.Excel.plist"

echo ""
echo "=========================================="
echo "✅ Excel Cache Clear Complete!"
echo "=========================================="
echo ""
echo "Cleared:"
echo "  - Excel caches"
echo "  - Excel containers (including add-in data and WEF folder)"
echo "  - Excel saved application state"
echo "  - Office group containers (shared add-in data)"
echo ""
echo "Next steps:"
echo "  1. Restart Excel (if it was running, close and reopen)"
echo "  2. Re-add your Excel add-in from the manifest"
echo "  3. Test the new version (4.0.2.2)"
echo ""

