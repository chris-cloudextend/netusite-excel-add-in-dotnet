# Complete Office Reinstall Instructions - Excel Mac Crash Fix

## ⚠️ IMPORTANT: Backup First
Before proceeding, ensure you have:
- All Excel files saved and backed up
- Office license key/account information
- Any custom Office settings documented

## Step 1: Quit All Office Applications
```bash
osascript -e 'quit app "Microsoft Excel"'
osascript -e 'quit app "Microsoft Word"'
osascript -e 'quit app "Microsoft PowerPoint"'
osascript -e 'quit app "Microsoft Outlook"'
osascript -e 'quit app "Microsoft OneNote"'
```

Wait 10 seconds to ensure all processes are fully terminated.

## Step 2: Remove Office Applications
```bash
# Remove Office apps from Applications folder
sudo rm -rf /Applications/Microsoft\ Excel.app
sudo rm -rf /Applications/Microsoft\ Word.app
sudo rm -rf /Applications/Microsoft\ PowerPoint.app
sudo rm -rf /Applications/Microsoft\ Outlook.app
sudo rm -rf /Applications/Microsoft\ OneNote.app
sudo rm -rf /Applications/Microsoft\ OneDrive.app
```

## Step 3: Remove ALL Office Data and Caches
```bash
# Remove ALL Office container data (this is the critical step)
rm -rf ~/Library/Containers/com.microsoft.Excel
rm -rf ~/Library/Containers/com.microsoft.Word
rm -rf ~/Library/Containers/com.microsoft.PowerPoint
rm -rf ~/Library/Containers/com.microsoft.Outlook
rm -rf ~/Library/Containers/com.microsoft.OneNote
rm -rf ~/Library/Containers/com.microsoft.onenote.mac
rm -rf ~/Library/Containers/com.microsoft.Office365ServiceV2

# Remove Group Container (shared Office data)
rm -rf ~/Library/Group\ Containers/UBF8T346G9.Office

# Remove ALL Office preferences
rm -rf ~/Library/Preferences/com.microsoft.Excel*
rm -rf ~/Library/Preferences/com.microsoft.Word*
rm -rf ~/Library/Preferences/com.microsoft.PowerPoint*
rm -rf ~/Library/Preferences/com.microsoft.Outlook*
rm -rf ~/Library/Preferences/com.microsoft.Office*

# Remove ALL Office caches
rm -rf ~/Library/Caches/com.microsoft.Excel*
rm -rf ~/Library/Caches/com.microsoft.Word*
rm -rf ~/Library/Caches/com.microsoft.PowerPoint*
rm -rf ~/Library/Caches/com.microsoft.Outlook*
rm -rf ~/Library/Caches/com.microsoft.Office*
rm -rf ~/Library/Caches/Microsoft*

# Remove saved application state
rm -rf ~/Library/Saved\ Application\ State/com.microsoft.Excel*
rm -rf ~/Library/Saved\ Application\ State/com.microsoft.Word*
rm -rf ~/Library/Saved\ Application\ State/com.microsoft.PowerPoint*
rm -rf ~/Library/Saved\ Application\ State/com.microsoft.Outlook*

# Remove Office support files
rm -rf ~/Library/Application\ Support/Microsoft/Office
rm -rf ~/Library/Application\ Support/Microsoft/Excel
rm -rf ~/Library/Application\ Support/Microsoft/Word
rm -rf ~/Library/Application\ Support/Microsoft/PowerPoint
rm -rf ~/Library/Application\ Support/Microsoft/Outlook

# Remove Office logs
rm -rf ~/Library/Logs/Microsoft
rm -rf ~/Library/Logs/DiagnosticReports/Microsoft*

# Remove Office updater data
rm -rf ~/Library/Application\ Support/Microsoft\ AutoUpdate
```

## Step 4: Remove Office from Keychain (Optional but Recommended)
1. Open **Keychain Access** (Applications > Utilities)
2. Search for "Microsoft" or "Office"
3. Delete all Microsoft/Office related entries
4. This ensures no corrupted credentials interfere

## Step 5: Restart Your Mac
**This is critical** - restart to clear any in-memory caches:
```bash
sudo reboot
```

Or manually: Apple Menu > Restart

## Step 6: Download and Reinstall Office
1. Go to: https://www.microsoft.com/microsoft-365/microsoft-365-and-office
2. Sign in with your Microsoft account
3. Download **Microsoft 365 for Mac** (or Office 2021 if you have standalone license)
4. **Important**: Download the **Current Channel (Stable)** version, NOT Insider/Beta
5. Install Office following the installer prompts
6. Sign in with your Microsoft account when prompted

## Step 7: Verify Excel Version
After installation, check you're on stable release:
```bash
defaults read /Applications/Microsoft\ Excel.app/Contents/Info.plist CFBundleShortVersionString
```

You should see something like `16.84.x` or `16.85.x` (stable), NOT `16.105.x` (Insider).

## Step 8: Load Your Add-in Fresh
1. Copy your manifest to the wef folder:
   ```bash
   cp excel-addin/manifest-claude.xml ~/Library/Containers/com.microsoft.Excel/Data/Documents/wef/
   ```

2. Open Excel (fresh start - no cached metadata)

3. Go to **Insert > Add-ins > My Add-ins**

4. Find your add-in and click **Add** (it will appear as NEW due to new Add-in ID)

5. Test autocomplete by typing `=XAVI.BAL` and clicking on a function name

## Step 9: If Still Crashing
If the crash persists after complete reinstall, the issue may be:

1. **macOS Beta Compatibility Issue**
   - You're on macOS 26.2 (beta/developer preview)
   - Excel Mac may not be fully compatible
   - Consider downgrading to stable macOS or waiting for Excel update

2. **Excel Mac Custom Functions Bug**
   - This is a known Excel Mac limitation
   - Consider using Office on the web for testing
   - Or wait for Microsoft to fix the bug

3. **Manifest/Add-in Configuration Issue**
   - Review manifest for any SharedRuntime conflicts
   - Try a minimal manifest with just one function

## Alternative: Try Stable Excel Channel First
Before full reinstall, try switching to stable channel:

1. Open Excel
2. Go to **Help > Check for Updates**
3. If on Insider channel, switch to **Current Channel (Stable)**
4. Update Excel
5. Test again

This is less disruptive than full reinstall.


