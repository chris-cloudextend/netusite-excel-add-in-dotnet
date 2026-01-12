#!/bin/bash
# Remove all Microsoft Office applications except Edge
# This script removes Office apps, caches, preferences, and container data

set -e  # Exit on error

echo "=========================================="
echo "Removing Microsoft Office (except Edge)"
echo "=========================================="
echo ""

# Office Applications to Remove
OFFICE_APPS=(
    "/Applications/Microsoft Excel.app"
    "/Applications/Microsoft Word.app"
    "/Applications/Microsoft PowerPoint.app"
    "/Applications/Microsoft Outlook.app"
    "/Applications/Microsoft OneNote.app"
    "/Applications/Microsoft Teams.app"
    "/Applications/Microsoft AutoUpdate.app"
    "/Applications/Microsoft Office 2019"
    "/Applications/Microsoft Office 2021"
    "/Applications/Microsoft Office"
)

# Remove Office Applications
echo "📦 Removing Office Applications..."
for app in "${OFFICE_APPS[@]}"; do
    if [ -d "$app" ]; then
        echo "   Removing: $app"
        rm -rf "$app"
    fi
done

# Remove Office Caches
echo ""
echo "🗑️  Removing Office Caches..."
CACHE_DIRS=(
    "~/Library/Caches/com.microsoft.Excel"
    "~/Library/Caches/com.microsoft.Word"
    "~/Library/Caches/com.microsoft.PowerPoint"
    "~/Library/Caches/com.microsoft.Outlook"
    "~/Library/Caches/com.microsoft.OneNote"
    "~/Library/Caches/com.microsoft.Office"
    "~/Library/Caches/Microsoft"
    "~/Library/Caches/com.microsoft.office.setupassistant"
    "~/Library/Caches/com.microsoft.autoupdate2"
)

for cache_dir in "${CACHE_DIRS[@]}"; do
    expanded_dir=$(eval echo "$cache_dir")
    if [ -d "$expanded_dir" ]; then
        echo "   Removing: $expanded_dir"
        rm -rf "$expanded_dir"
    fi
done

# Remove Office Preferences
echo ""
echo "⚙️  Removing Office Preferences..."
PREF_DIRS=(
    "~/Library/Preferences/com.microsoft.Excel.plist"
    "~/Library/Preferences/com.microsoft.Excel.securebookmarks.plist"
    "~/Library/Preferences/com.microsoft.Word.plist"
    "~/Library/Preferences/com.microsoft.PowerPoint.plist"
    "~/Library/Preferences/com.microsoft.Outlook.plist"
    "~/Library/Preferences/com.microsoft.OneNote.plist"
    "~/Library/Preferences/com.microsoft.Office.plist"
    "~/Library/Preferences/com.microsoft.office.setupassistant.plist"
    "~/Library/Preferences/com.microsoft.autoupdate2.plist"
    "~/Library/Preferences/com.microsoft.office.licensingV2.plist"
    "~/Library/Preferences/com.microsoft.office.plist"
    "~/Library/Preferences/com.microsoft.Office365ServiceV2.plist"
)

for pref_file in "${PREF_DIRS[@]}"; do
    expanded_file=$(eval echo "$pref_file")
    if [ -f "$expanded_file" ] || [ -d "$expanded_file" ]; then
        echo "   Removing: $expanded_file"
        rm -rf "$expanded_file"
    fi
done

# Remove Office Containers (CRITICAL - Contains add-in data)
echo ""
echo "📁 Removing Office Containers (includes add-in data)..."
CONTAINER_DIRS=(
    "~/Library/Containers/com.microsoft.Excel"
    "~/Library/Containers/com.microsoft.Word"
    "~/Library/Containers/com.microsoft.PowerPoint"
    "~/Library/Containers/com.microsoft.Outlook"
    "~/Library/Containers/com.microsoft.OneNote"
    "~/Library/Containers/com.microsoft.Office"
    "~/Library/Containers/com.microsoft.office.setupassistant"
    "~/Library/Containers/com.microsoft.autoupdate2"
    "~/Library/Containers/com.microsoft.Office365ServiceV2"
)

for container_dir in "${CONTAINER_DIRS[@]}"; do
    expanded_dir=$(eval echo "$container_dir")
    if [ -d "$expanded_dir" ]; then
        echo "   Removing: $expanded_dir"
        rm -rf "$expanded_dir"
    fi
done

# Remove Office Saved Application State
echo ""
echo "💾 Removing Saved Application State..."
STATE_DIRS=(
    "~/Library/Saved Application State/com.microsoft.Excel.savedState"
    "~/Library/Saved Application State/com.microsoft.Word.savedState"
    "~/Library/Saved Application State/com.microsoft.PowerPoint.savedState"
    "~/Library/Saved Application State/com.microsoft.Outlook.savedState"
    "~/Library/Saved Application State/com.microsoft.OneNote.savedState"
    "~/Library/Saved Application State/com.microsoft.Office.savedState"
)

for state_dir in "${STATE_DIRS[@]}"; do
    expanded_dir=$(eval echo "$state_dir")
    if [ -d "$expanded_dir" ]; then
        echo "   Removing: $expanded_dir"
        rm -rf "$expanded_dir"
    fi
done

# Remove Office Group Containers
echo ""
echo "👥 Removing Office Group Containers..."
GROUP_DIRS=(
    "~/Library/Group Containers/UBF8T346G9.Office"
    "~/Library/Group Containers/UBF8T346G9.OfficeOsfWebHost"
    "~/Library/Group Containers/UBF8T346G9.ms"
    "~/Library/Group Containers/UBF8T346G9.OfficeOneDriveSyncIntegration"
)

for group_dir in "${GROUP_DIRS[@]}"; do
    expanded_dir=$(eval echo "$group_dir")
    if [ -d "$expanded_dir" ]; then
        echo "   Removing: $expanded_dir"
        rm -rf "$expanded_dir"
    fi
done

# Remove Office Logs
echo ""
echo "📋 Removing Office Logs..."
LOG_DIRS=(
    "~/Library/Logs/Microsoft"
    "~/Library/Logs/DiagnosticReports/Microsoft Excel*"
    "~/Library/Logs/DiagnosticReports/Microsoft Word*"
    "~/Library/Logs/DiagnosticReports/Microsoft PowerPoint*"
)

for log_pattern in "${LOG_DIRS[@]}"; do
    expanded_pattern=$(eval echo "$log_pattern")
    if ls $expanded_pattern 1> /dev/null 2>&1; then
        echo "   Removing: $expanded_pattern"
        rm -rf $expanded_pattern
    fi
done

# Remove Office Receipts (for App Store versions)
echo ""
echo "🧾 Removing Office Receipts..."
RECEIPT_DIRS=(
    "/private/var/db/receipts/com.microsoft.Excel*"
    "/private/var/db/receipts/com.microsoft.Word*"
    "/private/var/db/receipts/com.microsoft.PowerPoint*"
    "/private/var/db/receipts/com.microsoft.Outlook*"
    "/private/var/db/receipts/com.microsoft.OneNote*"
    "/private/var/db/receipts/com.microsoft.Office*"
)

for receipt_pattern in "${RECEIPT_DIRS[@]}"; do
    if ls $receipt_pattern 1> /dev/null 2>&1; then
        echo "   Removing: $receipt_pattern"
        sudo rm -rf $receipt_pattern
    fi
done

# Remove Office Launch Agents/Daemons
echo ""
echo "🚀 Removing Office Launch Agents..."
LAUNCH_AGENTS=(
    "~/Library/LaunchAgents/com.microsoft.office.licensingV2.helper.plist"
    "~/Library/LaunchAgents/com.microsoft.office.licensing.helper.plist"
)

for agent in "${LAUNCH_AGENTS[@]}"; do
    expanded_agent=$(eval echo "$agent")
    if [ -f "$expanded_agent" ]; then
        echo "   Removing: $expanded_agent"
        rm -f "$expanded_agent"
        # Unload if loaded
        launchctl unload "$expanded_agent" 2>/dev/null || true
    fi
done

# Clear Office-related Spotlight index (optional but recommended)
echo ""
echo "🔍 Clearing Spotlight index for Office files..."
mdutil -E / 2>/dev/null || true

echo ""
echo "=========================================="
echo "✅ Office Removal Complete!"
echo "=========================================="
echo ""
echo "Removed:"
echo "  - All Office applications (Excel, Word, PowerPoint, Outlook, OneNote, Teams)"
echo "  - All Office caches"
echo "  - All Office preferences"
echo "  - All Office containers (including add-in data)"
echo "  - All Office saved application state"
echo "  - All Office group containers"
echo "  - All Office logs"
echo ""
echo "⚠️  Note: Microsoft Edge was NOT removed (as requested)"
echo ""
echo "Next steps:"
echo "  1. Restart your Mac (recommended)"
echo "  2. Reinstall Office from Microsoft 365 or App Store"
echo "  3. Re-add your Excel add-in"
echo ""

