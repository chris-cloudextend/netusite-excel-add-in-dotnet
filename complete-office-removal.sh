#!/bin/bash
# Complete Office Removal Script
# WARNING: This will remove ALL Office applications and ALL data
# Use this before reinstalling Office to fix Excel Mac crash

set -e

echo "⚠️  WARNING: This script will remove ALL Microsoft Office applications and ALL data"
echo "⚠️  This includes:"
echo "   - All Office apps (Excel, Word, PowerPoint, Outlook, OneNote)"
echo "   - ALL Office data, caches, preferences, and logs"
echo "   - ALL add-in data and custom function metadata"
echo ""
echo "⚠️  Make sure you have:"
echo "   - Backed up all Excel files"
echo "   - Your Office license key/account information"
echo "   - Any custom Office settings documented"
echo ""
read -p "Type 'YES' to continue (case sensitive): " confirm

if [ "$confirm" != "YES" ]; then
    echo "Cancelled."
    exit 1
fi

echo ""
echo "1. Quitting all Office applications..."
osascript -e 'quit app "Microsoft Excel"' 2>/dev/null || echo "   Excel not running"
osascript -e 'quit app "Microsoft Word"' 2>/dev/null || echo "   Word not running"
osascript -e 'quit app "Microsoft PowerPoint"' 2>/dev/null || echo "   PowerPoint not running"
osascript -e 'quit app "Microsoft Outlook"' 2>/dev/null || echo "   Outlook not running"
osascript -e 'quit app "Microsoft OneNote"' 2>/dev/null || echo "   OneNote not running"
sleep 5

echo ""
echo "2. Removing Office applications..."
sudo rm -rf /Applications/Microsoft\ Excel.app 2>/dev/null && echo "   ✓ Excel removed" || echo "   ✗ Excel not found"
sudo rm -rf /Applications/Microsoft\ Word.app 2>/dev/null && echo "   ✓ Word removed" || echo "   ✗ Word not found"
sudo rm -rf /Applications/Microsoft\ PowerPoint.app 2>/dev/null && echo "   ✓ PowerPoint removed" || echo "   ✗ PowerPoint not found"
sudo rm -rf /Applications/Microsoft\ Outlook.app 2>/dev/null && echo "   ✓ Outlook removed" || echo "   ✗ Outlook not found"
sudo rm -rf /Applications/Microsoft\ OneNote.app 2>/dev/null && echo "   ✓ OneNote removed" || echo "   ✗ OneNote not found"
sudo rm -rf /Applications/Microsoft\ OneDrive.app 2>/dev/null && echo "   ✓ OneDrive removed" || echo "   ✗ OneDrive not found"

echo ""
echo "3. Removing ALL Office container data..."
rm -rf ~/Library/Containers/com.microsoft.Excel 2>/dev/null && echo "   ✓ Excel container removed" || echo "   (Excel container not found)"
rm -rf ~/Library/Containers/com.microsoft.Word 2>/dev/null && echo "   ✓ Word container removed" || echo "   (Word container not found)"
rm -rf ~/Library/Containers/com.microsoft.PowerPoint 2>/dev/null && echo "   ✓ PowerPoint container removed" || echo "   (PowerPoint container not found)"
rm -rf ~/Library/Containers/com.microsoft.Outlook 2>/dev/null && echo "   ✓ Outlook container removed" || echo "   (Outlook container not found)"
rm -rf ~/Library/Containers/com.microsoft.OneNote 2>/dev/null && echo "   ✓ OneNote container removed" || echo "   (OneNote container not found)"
rm -rf ~/Library/Containers/com.microsoft.onenote.mac 2>/dev/null
rm -rf ~/Library/Containers/com.microsoft.Office365ServiceV2 2>/dev/null

echo ""
echo "4. Removing Group Container (shared Office data)..."
rm -rf ~/Library/Group\ Containers/UBF8T346G9.Office 2>/dev/null && echo "   ✓ Group container removed" || echo "   (Group container not found)"

echo ""
echo "5. Removing ALL Office preferences..."
rm -rf ~/Library/Preferences/com.microsoft.Excel* 2>/dev/null && echo "   ✓ Excel preferences removed" || echo "   (No Excel preferences)"
rm -rf ~/Library/Preferences/com.microsoft.Word* 2>/dev/null
rm -rf ~/Library/Preferences/com.microsoft.PowerPoint* 2>/dev/null
rm -rf ~/Library/Preferences/com.microsoft.Outlook* 2>/dev/null
rm -rf ~/Library/Preferences/com.microsoft.Office* 2>/dev/null

echo ""
echo "6. Removing ALL Office caches..."
rm -rf ~/Library/Caches/com.microsoft.Excel* 2>/dev/null && echo "   ✓ Excel caches removed" || echo "   (No Excel caches)"
rm -rf ~/Library/Caches/com.microsoft.Word* 2>/dev/null
rm -rf ~/Library/Caches/com.microsoft.PowerPoint* 2>/dev/null
rm -rf ~/Library/Caches/com.microsoft.Outlook* 2>/dev/null
rm -rf ~/Library/Caches/com.microsoft.Office* 2>/dev/null
rm -rf ~/Library/Caches/Microsoft* 2>/dev/null

echo ""
echo "7. Removing saved application state..."
rm -rf ~/Library/Saved\ Application\ State/com.microsoft.Excel* 2>/dev/null && echo "   ✓ Excel saved state removed" || echo "   (No saved state)"
rm -rf ~/Library/Saved\ Application\ State/com.microsoft.Word* 2>/dev/null
rm -rf ~/Library/Saved\ Application\ State/com.microsoft.PowerPoint* 2>/dev/null
rm -rf ~/Library/Saved\ Application\ State/com.microsoft.Outlook* 2>/dev/null

echo ""
echo "8. Removing Office support files..."
rm -rf ~/Library/Application\ Support/Microsoft/Office 2>/dev/null && echo "   ✓ Office support files removed" || echo "   (No support files)"
rm -rf ~/Library/Application\ Support/Microsoft/Excel 2>/dev/null
rm -rf ~/Library/Application\ Support/Microsoft/Word 2>/dev/null
rm -rf ~/Library/Application\ Support/Microsoft/PowerPoint 2>/dev/null
rm -rf ~/Library/Application\ Support/Microsoft/Outlook 2>/dev/null

echo ""
echo "9. Removing Office logs..."
rm -rf ~/Library/Logs/Microsoft 2>/dev/null && echo "   ✓ Office logs removed" || echo "   (No logs)"
rm -rf ~/Library/Logs/DiagnosticReports/Microsoft* 2>/dev/null

echo ""
echo "10. Removing Office updater data..."
rm -rf ~/Library/Application\ Support/Microsoft\ AutoUpdate 2>/dev/null && echo "   ✓ Updater data removed" || echo "   (No updater data)"

echo ""
echo "✅ COMPLETE OFFICE REMOVAL FINISHED!"
echo ""
echo "Next steps:"
echo "1. Restart your Mac (CRITICAL - clears in-memory caches):"
echo "   sudo reboot"
echo ""
echo "2. After restart, download and reinstall Office from:"
echo "   https://www.microsoft.com/microsoft-365/microsoft-365-and-office"
echo ""
echo "3. Make sure to download STABLE channel, NOT Insider/Beta"
echo ""
echo "4. After installation, load your add-in fresh"
echo ""
echo "See COMPLETE_OFFICE_REINSTALL.md for detailed instructions."


