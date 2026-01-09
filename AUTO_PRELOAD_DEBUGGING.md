# Auto-Preload Debugging Guide

## Issue Summary

The taskpane is showing "Could not auto-preload" error, and formulas are timing out waiting for preload to complete.

## Root Cause Analysis

Based on the logs:
1. ✅ Trigger is being set correctly: `📤 Auto-preload trigger queued: netsuite_auto_preload_trigger_...`
2. ✅ Formula is waiting: `⏳ Waiting for preload to start/complete (max 120s)...`
3. ❌ Taskpane isn't processing the trigger OR is failing during formula scan
4. ❌ After timeout, formula falls back to individual API call

## Diagnostic Tools Added

### 1. Manual Debug Functions (Run in Taskpane Console)

```javascript
// Check if triggers exist
window.debugCheckTriggers()

// Manually process triggers
window.debugProcessTriggers()
```

### 2. Enhanced Logging

- **Trigger Detection**: Logs when triggers are found
- **Trigger Processing**: Logs when triggers are processed
- **Formula Scan**: Logs each step of formula scanning
- **Error Details**: Full error stack traces

### 3. Custom Event Fallback

Added custom event listener as fallback for storage events (which may not fire in same-origin contexts).

## Debugging Steps

### Step 1: Verify Trigger is Set

In **functions.js console** (Excel DevTools):
```javascript
// Check if trigger exists
localStorage.getItem('netsuite_auto_preload_trigger_1767992706134_sbz0olnyy')
// Should return JSON string with trigger data
```

### Step 2: Verify Taskpane is Running

In **taskpane console** (Taskpane DevTools):
```javascript
// Check if taskpane is listening
window.debugCheckTriggers()
// Should show any triggers found

// Manually process triggers
window.debugProcessTriggers()
// Should return true if triggers were processed
```

### Step 3: Check Polling

The taskpane polls every 2 seconds. Look for:
```
🔬 TASKPANE: Polling detected X trigger(s)
```

If you don't see this, the polling isn't working.

### Step 4: Check Formula Scan

Look for:
```
🔬 TASKPANE: Starting formula scan for preload
🔬 TASKPANE: Formula scan attempt 1/5
🔬 TASKPANE: Excel.run() started
```

If you see errors after "Excel.run() started", the Excel API call is failing.

## Common Issues

### Issue 1: Storage Events Don't Fire

**Symptom**: No "🔔 Storage event detected" logs

**Cause**: Storage events only fire for changes in OTHER windows/tabs. If functions.js and taskpane.html are in the same origin, events might not fire.

**Solution**: 
- Polling should catch it (every 2 seconds)
- Custom event listener should catch it (immediate)
- Manual `window.debugProcessTriggers()` as fallback

### Issue 2: Excel API Busy

**Symptom**: Error "Wait until the previous call completes"

**Cause**: Excel is processing other operations

**Solution**: Code retries with exponential backoff (up to 5 attempts)

### Issue 3: Formula Scan Fails

**Symptom**: Error in catch block at line 9782

**Cause**: Excel API error, permission issue, or sheet access problem

**Solution**: Check error details in console logs

## Quick Fixes

### If Taskpane Isn't Processing Triggers

1. **Check if taskpane is loaded**:
   ```javascript
   // In taskpane console
   typeof processAutoPreloadTriggers
   // Should return "function"
   ```

2. **Manually trigger**:
   ```javascript
   // In taskpane console
   window.debugProcessTriggers()
   ```

3. **Check polling**:
   ```javascript
   // In taskpane console
   // Look for logs every 2 seconds showing trigger checks
   ```

### If Formula Scan is Failing

1. **Check Excel API availability**:
   ```javascript
   // In taskpane console
   typeof Excel
   // Should return "object"
   ```

2. **Try manual scan**:
   ```javascript
   // The error logs will show exactly what failed
   // Check the error stack trace
   ```

## Expected Log Flow

### Successful Preload:
```
📤 Auto-preload trigger queued: netsuite_auto_preload_trigger_...
🔬 TASKPANE: Found 1 trigger key(s)
🚀 AUTO-PRELOAD TRIGGERED: 1 period(s) - Jan 2025
🔬 TASKPANE: Starting formula scan for preload
🔬 TASKPANE: Formula scan attempt 1/5
🔬 TASKPANE: Excel.run() started
📊 Auto-scan found 1 period(s) in formulas
📋 Periods to preload: Jan 2025
📊 BS PRELOAD: Starting for 1 period(s): Jan 2025
✅ BS PRELOAD COMPLETE: 198 accounts × 1/1 periods completed
```

### Failed Preload:
```
📤 Auto-preload trigger queued: ...
⏳ Waiting for preload to start/complete (max 120s)...
⏳ Period Jan 2025 still requested - taskpane hasn't started yet, waiting longer...
⏳ Period Jan 2025 still not completed after extended wait - proceeding to API path
❌ Auto-preload error: [error details]
```

## Next Steps

1. **Run the diagnostic functions** in taskpane console to see what's happening
2. **Check the enhanced logs** to see exactly where it's failing
3. **Use the automation scripts** to reduce QA cycle time
4. **Share the diagnostic output** so we can identify the exact failure point
