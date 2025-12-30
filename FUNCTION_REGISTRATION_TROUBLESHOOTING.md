# Function Registration Troubleshooting Guide

## Problem
`XAVI.BALANCE` and other custom functions return `#VALUE` errors immediately. Functions are not being registered with Excel.

## ROOT CAUSE FOUND (v4.0.1.7)
**Orphaned JSDoc closing tag** at line 9195: A standalone `*/` without a matching opening `/**` was breaking the JSDoc parser. This prevented Excel from properly parsing function metadata, causing registration to fail silently.

**Fix Applied**: Removed the orphaned `*/` tag. All 12 custom functions now have properly formatted JSDoc blocks.

## Symptoms
- Functions return `#VALUE` immediately when entered
- No registration logs appear in sharedruntime console
- Expected logs like "✅ Custom functions registered with Excel" are missing
- Functions.js loads successfully (version log appears) but registration IIFE doesn't execute

## Root Cause Analysis

### Issue 1: Registration IIFE Not Executing
The registration code is wrapped in an IIFE at the end of `functions.js`:
```javascript
(function registerCustomFunctions() {
    console.log('🔧 registerCustomFunctions() IIFE executing...');
    // ... registration code ...
})();
```

**Problem**: If this IIFE doesn't execute, functions won't register. Possible causes:
1. Syntax error earlier in file prevents IIFE from running
2. File is truncated or incomplete
3. Extra closing braces causing parsing issues

### Issue 2: Office.onReady Timing
The registration code waits for `Office.onReady()`:
```javascript
if (typeof Office !== 'undefined' && Office.onReady) {
    Office.onReady(function(info) {
        // Register functions
    });
}
```

**Problem**: In shared runtime mode, `Office.onReady()` might:
- Already have fired before functions.js loads
- Not fire at all if Office.js loaded in a different context
- Be called but the callback never executes

### Issue 3: CustomFunctions API Availability
Registration requires `CustomFunctions.associate`:
```javascript
if (typeof CustomFunctions !== 'undefined' && CustomFunctions.associate) {
    CustomFunctions.associate('BALANCE', BALANCE);
    // ...
}
```

**Problem**: `CustomFunctions` might not be available:
- Not loaded yet when registration attempts
- Not available in shared runtime context
- API changed or deprecated

## Code Snippets for Diagnosis

### Registration IIFE (end of functions.js)
```javascript
(function registerCustomFunctions() {
    console.log('🔧 registerCustomFunctions() IIFE executing...');
    console.log('   typeof Office:', typeof Office);
    console.log('   typeof CustomFunctions:', typeof CustomFunctions);
    
    function doRegistration() {
        console.log('🔧 doRegistration() called');
        if (typeof CustomFunctions !== 'undefined' && CustomFunctions.associate) {
            try {
                console.log('🔧 Attempting to register custom functions...');
                CustomFunctions.associate('BALANCE', BALANCE);
                // ... other functions ...
                console.log('✅ Custom functions registered with Excel');
                return true;
            } catch (error) {
                console.error('❌ Error registering custom functions:', error);
                return false;
            }
        } else {
            console.warn('⚠️ CustomFunctions not available yet');
            return false;
        }
    }
    
    // Try immediate registration if already available
    if (typeof Office !== 'undefined' && typeof CustomFunctions !== 'undefined' && CustomFunctions.associate) {
        console.log('🔧 Office and CustomFunctions already available - attempting immediate registration');
        if (doRegistration()) {
            return; // Success
        }
    }
    
    // Wait for Office.onReady()
    if (typeof Office !== 'undefined' && Office.onReady) {
        console.log('🔧 Office.onReady available - setting up callback');
        Office.onReady(function(info) {
            console.log('📋 Office.onReady() fired - registering custom functions');
            doRegistration();
        });
    } else {
        // Fallback: Poll for Office.js
        console.log('🔧 Office.onReady not available - setting up polling fallback');
        // ... polling code ...
    }
})();
```

### BALANCE Function Date/Period Handling
```javascript
async function BALANCE(account, fromPeriod, toPeriod, subsidiary, department, location, classId, accountingBook) {
    // ... validation ...
    
    // Convert date values to "Mon YYYY" format
    // Excel passes dates as serial numbers (e.g., 45658 for 1/1/2025)
    fromPeriod = normalizePeriodKey(fromPeriod, true) || fromPeriod;
    toPeriod = normalizePeriodKey(toPeriod, false) || toPeriod;
    
    console.log(`📅 BALANCE periods: ${rawFrom} → "${fromPeriod}", ${rawTo} → "${toPeriod}"`);
    
    // ... rest of function ...
}
```

### normalizePeriodKey Function
```javascript
function normalizePeriodKey(period, isFromPeriod = false) {
    if (!period && period !== 0) {
        return isFromPeriod ? null : null; // Empty is allowed for fromPeriod
    }
    
    // Handle Excel date serial numbers
    if (typeof period === 'number') {
        const date = new Date((period - 25569) * 86400 * 1000); // Excel epoch
        const month = date.getMonth();
        const year = date.getFullYear();
        return `${MONTH_NAMES[month]} ${year}`;
    }
    
    // Handle date strings
    if (typeof period === 'string') {
        // Try parsing as date
        const parsed = parsePeriod(period);
        if (parsed) {
            return `${MONTH_NAMES[parsed.month]} ${parsed.year}`;
        }
        // Already in "Mon YYYY" format
        return period;
    }
    
    return null;
}
```

## Diagnostic Steps

### Step 1: Verify IIFE Execution
Check sharedruntime console for:
- `🔧 registerCustomFunctions() IIFE executing...`
- If missing, IIFE is not running (syntax error or file truncation)

### Step 2: Check Office.js Availability
Look for logs showing:
- `typeof Office: ...`
- `typeof CustomFunctions: ...`
- `Office.onReady available: ...`

### Step 3: Verify Registration Path
Check which path executes:
- `🔧 Office and CustomFunctions already available - attempting immediate registration`
- `🔧 Office.onReady available - setting up callback`
- `🔧 Office.onReady not available - setting up polling fallback`

### Step 4: Check Registration Success
Look for:
- `✅ Custom functions registered with Excel` (success)
- `❌ Error registering custom functions:` (failure with error details)
- `⚠️ CustomFunctions not available yet` (API not ready)

### Step 5: Verify Date/Period Conversion
When BALANCE is called, check for:
- `📅 BALANCE periods: ... → "..."`
- Verify Excel date serials are converted correctly
- Check that period strings are parsed properly

## Fixes Applied

### Fix 1: Added Immediate Registration Attempt
If Office and CustomFunctions are already available when functions.js loads, attempt registration immediately instead of waiting for Office.onReady().

### Fix 2: Enhanced Logging
Added comprehensive logging at every step to diagnose where registration fails.

### Fix 3: Multiple Fallback Paths
- Immediate registration if available
- Office.onReady() callback
- Polling fallback with timeout
- Direct registration after timeout if CustomFunctions available

## Testing Checklist

- [ ] Functions.js loads (version log appears)
- [ ] Registration IIFE executes (first debug log appears)
- [ ] Office.js is available (typeof Office log shows "object")
- [ ] CustomFunctions API is available (typeof CustomFunctions log shows "object")
- [ ] Registration succeeds (success log appears)
- [ ] Functions work (no #VALUE errors)
- [ ] Date/period parameters convert correctly (period conversion logs show correct format)

## Expected Console Output (Success Case)

```
📦 XAVI functions.js loaded - version 4.0.1.5
🔧 registerCustomFunctions() IIFE executing...
   typeof Office: object
   typeof CustomFunctions: object
   Office.onReady available: true
🔧 Office and CustomFunctions already available - attempting immediate registration
🔧 doRegistration() called
🔧 Attempting to register custom functions...
✅ Custom functions registered with Excel
```

## Common Failure Patterns

### Pattern 1: IIFE Not Executing
**Symptoms**: No registration logs at all
**Cause**: Syntax error or file truncation
**Fix**: Check file syntax, verify file is complete

### Pattern 2: CustomFunctions Not Available
**Symptoms**: `⚠️ CustomFunctions not available yet`
**Cause**: API not loaded or not available in context
**Fix**: Ensure Office.js loads before functions.js, check shared runtime setup

### Pattern 3: Office.onReady Never Fires
**Symptoms**: No `📋 Office.onReady() fired` log
**Cause**: Office.onReady() already fired or not available
**Fix**: Use immediate registration path, add polling fallback

### Pattern 4: Registration Throws Error
**Symptoms**: `❌ Error registering custom functions:` with stack trace
**Cause**: Function definitions missing or invalid
**Fix**: Check that all functions (BALANCE, NAME, etc.) are defined before registration

## Related Files
- `docs/functions.js` - Main functions file with registration code
- `docs/sharedruntime.html` - Shared runtime page that loads functions.js
- `excel-addin/manifest.xml` - Add-in manifest defining runtime

