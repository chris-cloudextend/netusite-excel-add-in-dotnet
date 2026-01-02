#!/bin/bash
# Enable right-click "Inspect" in Excel task pane on Mac
# This enables developer tools for Office add-ins

echo "🔧 Enabling Excel Developer Tools..."
defaults write com.microsoft.Excel OfficeWebAddinDeveloperExtras -bool true

if [ $? -eq 0 ]; then
    echo "✅ Developer tools enabled for Excel"
    echo ""
    echo "Next steps:"
    echo "  1. Restart Excel (if running)"
    echo "  2. Right-click in the task pane"
    echo "  3. Select 'Inspect Element' to open Web Inspector"
else
    echo "❌ Failed to enable developer tools"
    exit 1
fi

