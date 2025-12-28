# Excel Crash Analysis - Recent Code Changes

## Issue Identified

Excel crashed when typing a formula. After investigating the recent code changes, I found a **critical blocking issue** that could cause Excel to freeze or crash.

## Root Cause: Synchronous Busy-Wait Loop

In `addPeriodToRequestQueue()` (lines 636-704 in `docs/functions.js`), there's a **synchronous busy-wait loop**:

```javascript
const start = Date.now();
while (Date.now() - start < 10) {}  // 10ms delay
```

### Why This Causes Crashes

1. **Excel's JavaScript Runtime is Single-Threaded**: Custom functions run in a single JavaScript thread. Blocking loops freeze the entire thread.

2. **Called During Formula Evaluation**: `addPeriodToRequestQueue()` is called from within the `BALANCE()` custom function when a period is not found in the manifest.

3. **Potential Blocking Duration**: If the CAS (Compare-And-Swap) retry logic triggers, this could block Excel for up to **100ms** (10 attempts × 10ms each), which is enough to cause Excel to hang or crash.

4. **No Yield to Event Loop**: The busy-wait loop doesn't yield to the event loop, preventing Excel from processing other operations.

## Other Potential Issues

1. **Multiple BUSY Errors**: There are 15 instances of `throw new Error('BUSY')` in the BALANCE function. While Excel should handle these, if Excel's error handling is cached from the old version, it might not handle them correctly.

2. **Function Order**: The manifest functions (`getManifest`, `updatePeriodStatus`, etc.) are defined before `normalizePeriodKey()`, but they call `normalizePeriodKey()`. However, since JavaScript hoists function declarations, this should be fine.

3. **localStorage Operations**: Multiple synchronous localStorage operations in a tight loop could also cause issues, but the busy-wait loop is the primary concern.

## Solution

### Immediate Action (Already Done)
✅ **Office Removal Script Executed**: All Office caches and metadata have been removed. This will clear any cached function metadata that might conflict with the new code.

### Code Fix Required (Before Reinstalling)

The synchronous busy-wait loop must be removed. Options:

1. **Remove the delay entirely** (simplest): The CAS retry logic doesn't need a delay - it can retry immediately since localStorage operations are fast.

2. **Use setTimeout** (if delay is truly needed): But this would require making `addPeriodToRequestQueue()` async, which might not be compatible with how it's called.

3. **Remove CAS retry logic** (if not critical): For a queue that's only written from one context (formulas), a simple append might be sufficient.

**Recommendation**: Remove the busy-wait loop entirely. The CAS logic can retry immediately without a delay, as localStorage operations are synchronous and fast.

## Next Steps

1. ✅ Office removal complete - user should restart Mac and reinstall Office
2. ⚠️ **FIX THE CODE** before user reinstalls - remove the blocking loop
3. After fix, user reinstalls Office and add-in
4. Test with fresh installation

## Code Location

- **File**: `docs/functions.js`
- **Function**: `addPeriodToRequestQueue()` (lines 636-704)
- **Problem Lines**: 686 and 693 (synchronous busy-wait loops)

