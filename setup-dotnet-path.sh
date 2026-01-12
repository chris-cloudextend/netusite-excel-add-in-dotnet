#!/bin/bash
# Setup script to add .NET to PATH for agents
# This ensures dotnet is available regardless of shell configuration

# Add Homebrew dotnet@8 to PATH if it exists
if [ -d "/opt/homebrew/opt/dotnet@8/bin" ]; then
    export PATH="/opt/homebrew/opt/dotnet@8/bin:$PATH"
    echo "✓ Added /opt/homebrew/opt/dotnet@8/bin to PATH"
fi

# Verify dotnet is available
if command -v dotnet &> /dev/null; then
    echo "✓ dotnet is available: $(which dotnet)"
    echo "✓ dotnet version: $(dotnet --version)"
else
    echo "⚠️  dotnet not found in PATH"
    echo "   Attempting to use /opt/homebrew/opt/dotnet@8/bin/dotnet directly"
    if [ -x "/opt/homebrew/opt/dotnet@8/bin/dotnet" ]; then
        echo "✓ Found dotnet at /opt/homebrew/opt/dotnet@8/bin/dotnet"
        alias dotnet="/opt/homebrew/opt/dotnet@8/bin/dotnet"
    else
        echo "❌ dotnet not found. Install with: brew install dotnet@8"
        exit 1
    fi
fi

