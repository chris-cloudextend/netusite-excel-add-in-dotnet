#!/bin/bash
# Complete Office Removal Script (Keeping Microsoft Edge)
# WARNING: This will remove ALL Office applications (except Edge) and ALL data
# Use this when Excel crashes after changing function parameter order on Mac
# 
# This script removes:
# - Excel, Word, PowerPoint, Outlook, OneNote, OneDrive, Teams
# - ALL Office data, caches, preferences, and logs
# - ALL add-in data and custom function metadata
# 
# This script KEEPS:
# - Microsoft Edge (browser)
#
# WHY THIS EXISTS:
# Mac Excel caches custom function parameter metadata aggressively. If you change
# the parameter order of a function after it's been registered, Excel on Mac can
# crash on startup. The only reliable fix is to completely remove Office and all
# its caches, then reinstall. This script does the removal part safely.

set -e

echo "⚠️  WARNING: This script will remove ALL Microsoft Office applications (except Edge) and ALL data"
echo "⚠️  This includes:"
echo "   - All Office apps (Excel, Word, PowerPoint, Outlook, OneNote, OneDrive, Teams)"
echo "   - ALL Office data, caches, preferences, and logs"
echo "   - ALL add-in data and custom function metadata"
echo ""
echo "⚠️  This script will KEEP:"
echo "   - Microsoft Edge (browser)"
echo ""
echo "⚠️  Make sure you have:"
echo "   - Backed up all Excel files"
echo "   - Your Office license key/account information"
echo "   - Any custom Office settings documented"
echo ""
read -p "Type 'YES' to continue (case sensitive): " confirm

if [ "$confirm" != "YES" ]; then
    echo "❌ Aborted. Nothing was removed."
    exit 1
fi

echo ""
echo "🗑️  Starting Office removal (keeping Edge)..."
echo ""

# Quit all Office apps first
echo "1. Quitting all Office applications..."
osascript -e 'quit app "Microsoft Excel"' 2>/dev/null || true
osascript -e 'quit app "Microsoft Word"' 2>/dev/null || true
osascript -e 'quit app "Microsoft PowerPoint"' 2>/dev/null || true
osascript -e 'quit app "Microsoft Outlook"' 2>/dev/null || true
osascript -e 'quit app "Microsoft OneNote"' 2>/dev/null || true
osascript -e 'quit app "Microsoft OneDrive"' 2>/dev/null || true
osascript -e 'quit app "Microsoft Teams"' 2>/dev/null || true
sleep 3

# Remove Office apps from Applications folder (but keep Edge)
echo "2. Removing Office applications (keeping Edge)..."
sudo rm -rf /Applications/Microsoft\ Excel.app 2>/dev/null || true
sudo rm -rf /Applications/Microsoft\ Word.app 2>/dev/null || true
sudo rm -rf /Applications/Microsoft\ PowerPoint.app 2>/dev/null || true
sudo rm -rf /Applications/Microsoft\ Outlook.app 2>/dev/null || true
sudo rm -rf /Applications/Microsoft\ OneNote.app 2>/dev/null || true
sudo rm -rf /Applications/Microsoft\ OneDrive.app 2>/dev/null || true
sudo rm -rf /Applications/Microsoft\ Teams.app 2>/dev/null || true
# NOTE: We intentionally do NOT remove Microsoft Edge

# Remove ALL Office container data (this is the critical step)
echo "3. Removing ALL Office container data and caches..."
rm -rf ~/Library/Containers/com.microsoft.Excel 2>/dev/null || true
rm -rf ~/Library/Containers/com.microsoft.Word 2>/dev/null || true
rm -rf ~/Library/Containers/com.microsoft.PowerPoint 2>/dev/null || true
rm -rf ~/Library/Containers/com.microsoft.Outlook 2>/dev/null || true
rm -rf ~/Library/Containers/com.microsoft.OneNote 2>/dev/null || true
rm -rf ~/Library/Containers/com.microsoft.onenote.mac 2>/dev/null || true
rm -rf ~/Library/Containers/com.microsoft.Office365ServiceV2 2>/dev/null || true
# NOTE: We intentionally do NOT remove com.microsoft.edgemac

# Remove Group Container (shared Office data)
echo "4. Removing shared Office group container..."
rm -rf ~/Library/Group\ Containers/UBF8T346G9.Office 2>/dev/null || true

# Remove ALL Office preferences
echo "5. Removing Office preferences..."
rm -rf ~/Library/Preferences/com.microsoft.Excel* 2>/dev/null || true
rm -rf ~/Library/Preferences/com.microsoft.Word* 2>/dev/null || true
rm -rf ~/Library/Preferences/com.microsoft.PowerPoint* 2>/dev/null || true
rm -rf ~/Library/Preferences/com.microsoft.Outlook* 2>/dev/null || true
rm -rf ~/Library/Preferences/com.microsoft.Office* 2>/dev/null || true
# NOTE: We intentionally do NOT remove com.microsoft.edgemac preferences

# Remove ALL Office caches
echo "6. Removing Office caches..."
rm -rf ~/Library/Caches/com.microsoft.Excel* 2>/dev/null || true
rm -rf ~/Library/Caches/com.microsoft.Word* 2>/dev/null || true
rm -rf ~/Library/Caches/com.microsoft.PowerPoint* 2>/dev/null || true
rm -rf ~/Library/Caches/com.microsoft.Outlook* 2>/dev/null || true
rm -rf ~/Library/Caches/com.microsoft.Office* 2>/dev/null || true
# NOTE: We intentionally do NOT remove com.microsoft.edgemac caches

# Remove Office saved application state
echo "7. Removing saved application state..."
rm -rf ~/Library/Saved\ Application\ State/com.microsoft.Excel* 2>/dev/null || true
rm -rf ~/Library/Saved\ Application\ State/com.microsoft.Word* 2>/dev/null || true
rm -rf ~/Library/Saved\ Application\ State/com.microsoft.PowerPoint* 2>/dev/null || true
rm -rf ~/Library/Saved\ Application\ State/com.microsoft.Outlook* 2>/dev/null || true
rm -rf ~/Library/Saved\ Application\ State/com.microsoft.Office* 2>/dev/null || true

# Remove Office logs
echo "8. Removing Office logs..."
rm -rf ~/Library/Logs/Microsoft 2>/dev/null || true

# Remove Office add-in data (critical for custom functions)
echo "9. Removing Office add-in data and custom function metadata..."
rm -rf ~/Library/Containers/com.microsoft.Excel/Data/Documents/wef 2>/dev/null || true
rm -rf ~/Library/Group\ Containers/UBF8T346G9.Office/wef 2>/dev/null || true

# Remove Office update data
echo "10. Removing Office update data..."
rm -rf ~/Library/Application\ Support/Microsoft/Office 2>/dev/null || true

# Remove Office license data
echo "11. Removing Office license data..."
rm -rf ~/Library/Application\ Support/Microsoft/Office/Licenses 2>/dev/null || true

# Remove Office autoupdate data
echo "12. Removing Office autoupdate data..."
rm -rf ~/Library/Application\ Support/Microsoft/Office/Updates 2>/dev/null || true

# Remove Office shared cache
echo "13. Removing Office shared cache..."
rm -rf ~/Library/Application\ Support/Microsoft/Office/SharedCache 2>/dev/null || true

# Remove Office identity cache
echo "14. Removing Office identity cache..."
rm -rf ~/Library/Application\ Support/Microsoft/Office/IdentityCache 2>/dev/null || true

# Remove Office credential cache
echo "15. Removing Office credential cache..."
rm -rf ~/Library/Application\ Support/Microsoft/Office/Credentials 2>/dev/null || true

# Remove Office custom dictionaries
echo "16. Removing Office custom dictionaries..."
rm -rf ~/Library/Spelling 2>/dev/null || true

# Remove Office templates
echo "17. Removing Office templates..."
rm -rf ~/Library/Application\ Support/Microsoft/Office/User\ Templates 2>/dev/null || true

# Remove Office startup items
echo "18. Removing Office startup items..."
rm -rf ~/Library/LaunchAgents/com.microsoft.* 2>/dev/null || true

# Remove Office helper tools
echo "19. Removing Office helper tools..."
rm -rf ~/Library/Application\ Support/Microsoft/Office/Office\ Helper\ Tools 2>/dev/null || true

# Remove Office crash reports
echo "20. Removing Office crash reports..."
rm -rf ~/Library/Logs/DiagnosticReports/*Excel* 2>/dev/null || true
rm -rf ~/Library/Logs/DiagnosticReports/*Word* 2>/dev/null || true
rm -rf ~/Library/Logs/DiagnosticReports/*PowerPoint* 2>/dev/null || true
rm -rf ~/Library/Logs/DiagnosticReports/*Outlook* 2>/dev/null || true

echo ""
echo "✅ Office removal complete (Edge preserved)"
echo ""
echo "📋 Next steps:"
echo "   1. Restart your Mac (recommended)"
echo "   2. Reinstall Microsoft Office from office.com or App Store"
echo "   3. Sign in with your Microsoft account"
echo "   4. Reinstall the XAVI add-in"
echo ""
echo "⚠️  Note: All Excel files are safe (they're stored in Documents, not removed)"
echo "⚠️  Note: Microsoft Edge was preserved and should still work"

