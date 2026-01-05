#!/bin/bash
# Script to commit and push changes to GitHub

cd /Users/chriscorcoran/Documents/Cursor/NetSuite-Excel-AddIn-DotNet

echo "=========================================="
echo "Git Push Script"
echo "=========================================="
echo ""

# Check status
echo "1. Checking git status..."
git status --short

echo ""
echo "2. Staging all changes..."
git add -A

echo ""
echo "3. Committing changes..."
git commit -m "FIX: Timing from overlay start, backend revenue debug logging - v4.0.6.72"

echo ""
echo "4. Pushing to GitHub..."
git push origin main

echo ""
echo "5. Verifying push..."
git log --oneline -3

echo ""
echo "=========================================="
echo "✅ Done! Check GitHub to confirm."
echo "=========================================="

