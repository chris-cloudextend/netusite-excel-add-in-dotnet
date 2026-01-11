# Testing Strategy for Excel Add-In

## Problem
QA cycle takes ~15 minutes:
1. Push to git
2. Reboot server
3. Update tunnel
4. Clear Excel cache
5. Enable dev tools
6. Wait for queries to run

## Solution: Multi-Layer Testing Strategy

### Layer 1: Unit Tests (Fastest - No Excel Required)

**Location**: `excel-addin/useful-commands/test-*.js`

**What to test**:
- Pure functions (getFilterKey, normalizePeriodKey, etc.)
- Logic functions (shouldPreloadPeriod, isPeriodCached, etc.)
- Data transformations

**Run**: `node excel-addin/useful-commands/test-preload-logic.js`

**Benefits**:
- Instant feedback (< 1 second)
- No Excel required
- Can test edge cases easily

### Layer 2: Local Simulation (Fast - No Excel Required)

**Location**: `excel-addin/useful-commands/test-functions-locally.js`

**What to test**:
- Function behavior with mocked Office.js
- localStorage operations
- Promise chains
- Error handling

**Run**: `node excel-addin/useful-commands/test-functions-locally.js`

**Benefits**:
- Tests integration without Excel
- Can mock different scenarios
- Fast iteration

### Layer 3: Automated Deployment (Medium - Still Requires Excel)

**Location**: `excel-addin/useful-commands/quick-deploy-and-test.sh`

**What it does**:
- Automates git push, server restart, tunnel update
- Provides cache clear instructions
- Reduces manual steps

**Run**: `bash excel-addin/useful-commands/quick-deploy-and-test.sh "Test message"`

**Benefits**:
- Reduces 15-minute cycle to ~5 minutes
- Eliminates manual steps
- Consistent deployment process

### Layer 4: Watch Mode (Medium - Still Requires Excel)

**Location**: `excel-addin/useful-commands/watch-and-deploy.sh`

**What it does**:
- Watches for file changes
- Automatically deploys on save
- Keeps Excel open for testing

**Run**: `bash excel-addin/useful-commands/watch-and-deploy.sh`

**Benefits**:
- One-time setup, then automatic
- Fast iteration when Excel is already open
- No manual deployment steps

## Recommended Workflow

### For Logic Changes (getFilterKey, normalizePeriodKey, etc.)

1. **Write unit test first** (Layer 1)
   ```bash
   node excel-addin/useful-commands/test-preload-logic.js
   ```

2. **Make changes to functions.js**

3. **Run unit test again** to verify
   ```bash
   node excel-addin/useful-commands/test-preload-logic.js
   ```

4. **Only then test in Excel** (Layer 3 or 4)

### For Integration Changes (batch logic, promise chains, etc.)

1. **Test locally with mocks** (Layer 2)
   ```bash
   node excel-addin/useful-commands/test-functions-locally.js
   ```

2. **Make changes**

3. **Test in Excel** (Layer 3 or 4)

### For UI/UX Changes (taskpane, progress indicators)

1. **Use watch mode** (Layer 4)
   ```bash
   bash excel-addin/useful-commands/watch-and-deploy.sh
   ```

2. **Keep Excel open with DevTools**

3. **Make changes and save** - auto-deploys

## Quick Reference

### Clear Excel Cache (Copy to DevTools Console)
```javascript
// Copy from: excel-addin/useful-commands/clear-excel-cache.js
localStorage.clear(); location.reload();
```

### Quick Deploy
```bash
bash excel-addin/useful-commands/quick-deploy-and-test.sh "Test message"
```

### Watch Mode
```bash
bash excel-addin/useful-commands/watch-and-deploy.sh
```

### Run Unit Tests
```bash
node excel-addin/useful-commands/test-preload-logic.js
```

## Future Improvements

1. **Extract Pure Functions**: Move testable functions to separate modules
2. **Add Jest/Mocha**: More robust testing framework
3. **CI/CD Pipeline**: Automated testing on every commit
4. **Excel Test Harness**: Selenium/Playwright for Excel automation
5. **Mock Backend**: Local mock server for faster testing

## Tips

1. **Test incrementally**: Don't wait until the end to test
2. **Use unit tests for logic**: Catch bugs before Excel testing
3. **Keep Excel open**: Use watch mode to avoid repeated setup
4. **Cache strategically**: Only clear cache when necessary
5. **Use validation logging**: The new diagnostic logs help debug without full QA cycle
