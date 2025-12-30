#!/bin/bash
# Create and open the WEF folder for Excel add-ins on Mac
# WEF folder is where Excel stores manifest files for sideloaded add-ins

WEF_FOLDER="$HOME/Library/Containers/com.microsoft.Excel/Data/Documents/wef"

echo "=========================================="
echo "Creating WEF Folder for Excel Add-ins"
echo "=========================================="
echo ""

# Create the folder if it doesn't exist
if [ ! -d "$WEF_FOLDER" ]; then
    echo "📁 Creating WEF folder..."
    mkdir -p "$WEF_FOLDER" 2>/dev/null && {
        echo "   ✅ Created: $WEF_FOLDER"
    } || {
        echo "   ❌ Failed to create WEF folder"
        echo "   This might require Excel to be running first"
        exit 1
    }
else
    echo "   ℹ️  WEF folder already exists: $WEF_FOLDER"
fi

echo ""
echo "📂 Opening WEF folder in Finder..."
open "$WEF_FOLDER"

echo ""
echo "=========================================="
echo "✅ WEF Folder Ready!"
echo "=========================================="
echo ""
echo "Location: $WEF_FOLDER"
echo ""
echo "To sideload an add-in:"
echo "  1. Copy your manifest.xml file to this folder"
echo "  2. Restart Excel"
echo "  3. The add-in should appear in Excel's Insert > Add-ins menu"
echo ""

