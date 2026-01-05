#!/bin/bash
# Script to commit and push changes to git
# This script will:
# 1. Show current git status
# 2. Add all changes
# 3. Commit with a message (or prompt for one)
# 4. Push to remote

set -e  # Exit on error

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

cd "$PROJECT_ROOT"

echo "📤 Git Push Script"
echo "=================="
echo ""

# Check if we're in a git repository
if ! git rev-parse --git-dir > /dev/null 2>&1; then
    echo -e "${RED}❌ Error: Not a git repository${NC}"
    exit 1
fi

# Show current branch
CURRENT_BRANCH=$(git branch --show-current)
echo -e "${BLUE}Current branch: ${CURRENT_BRANCH}${NC}"
echo ""

# Show status
echo "📋 Current git status:"
git status --short
echo ""

# Check if there are changes to commit
if [ -z "$(git status --porcelain)" ]; then
    echo -e "${YELLOW}⚠️  No changes to commit${NC}"
    exit 0
fi

# Get commit message
if [ -z "$1" ]; then
    echo -e "${YELLOW}Enter commit message (or press Enter for default):${NC}"
    read -r COMMIT_MSG
    if [ -z "$COMMIT_MSG" ]; then
        COMMIT_MSG="Update: $(date '+%Y-%m-%d %H:%M:%S')"
        echo -e "${BLUE}Using default message: ${COMMIT_MSG}${NC}"
    fi
else
    COMMIT_MSG="$1"
    echo -e "${BLUE}Using provided message: ${COMMIT_MSG}${NC}"
fi

echo ""

# Add all changes
echo "1️⃣  Adding all changes..."
git add -A
echo -e "${GREEN}✓ Changes staged${NC}"
echo ""

# Commit
echo "2️⃣  Committing changes..."
git commit -m "$COMMIT_MSG"
echo -e "${GREEN}✓ Changes committed${NC}"
echo ""

# Show remote
REMOTE=$(git remote | head -1)
if [ -z "$REMOTE" ]; then
    echo -e "${YELLOW}⚠️  No remote configured. Skipping push.${NC}"
    exit 0
fi

REMOTE_URL=$(git remote get-url "$REMOTE" 2>/dev/null || echo "unknown")
echo -e "${BLUE}Remote: ${REMOTE} (${REMOTE_URL})${NC}"
echo ""

# Push
echo "3️⃣  Pushing to ${REMOTE}/${CURRENT_BRANCH}..."
if git push "$REMOTE" "$CURRENT_BRANCH"; then
    echo ""
    echo -e "${GREEN}✅ Successfully pushed to ${REMOTE}/${CURRENT_BRANCH}${NC}"
    echo ""
    echo "📊 Latest commit:"
    git log --oneline -1
else
    echo ""
    echo -e "${RED}❌ Push failed${NC}"
    exit 1
fi

