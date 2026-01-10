# Test Plan: Book Change and Validation Fixes

## Issue 1: Cache Check Timeout
**Problem**: Progress overlay stuck on "Checking if book-subsidiary cache is ready..."

**Fix Applied**:
- Added 120-second timeout to cache check
- Added error handling to proceed if server is unreachable after 10 seconds
- Force proceed if timeout is reached
- **CRITICAL**: Modal appears IMMEDIATELY when cache is ready (does NOT wait for timeout)

**Test Steps**:
1. Change U3 from book 1 to book 2
2. Observe progress overlay appears
3. Wait for cache to be ready (should complete within 120 seconds)
4. **VERIFY IN CONSOLE**: Look for log message `✅✅✅ CACHE READY - Breaking loop immediately`
5. **VERIFY IN CONSOLE**: Look for log message `✅✅✅ PROOF: Overlay removed immediately after cache ready`
6. **VERIFY IN CONSOLE**: Look for log message `✅✅✅ PROOF: About to show subsidiary selection modal NOW`
7. Verify overlay closes IMMEDIATELY (not waiting for timeout)
8. Verify subsidiary selection modal appears IMMEDIATELY after overlay closes

**Expected Result - Normal Case (Cache Ready Quickly)**:
- Cache becomes ready (e.g., after 5-30 seconds)
- Overlay closes IMMEDIATELY when cache is ready
- Modal appears IMMEDIATELY after overlay closes
- Total time: Cache initialization time (typically 5-30 seconds)

**Expected Result - Timeout Case (Cache Not Ready After 120 Seconds)**:
- After 120 seconds, timeout occurs
- Console shows: `⚠️⚠️⚠️ TIMEOUT: Cache not ready after 120s timeout - proceeding anyway`
- Overlay closes
- System attempts to fetch subsidiaries (may fail or return empty list)
- Modal appears with whatever subsidiaries were fetched (may be empty)
- User can still proceed, but may see limited/no subsidiaries in modal
- **Note**: This is a fallback - normally cache should be ready much sooner

**Proof of Immediate Modal Appearance**:
- Check console logs for the `✅✅✅` messages above
- These prove the modal appears as soon as cache is ready, not waiting for timeout

---

## Issue 2: Invalid Book-Subsidiary Combination Alert
**Problem**: User can select invalid combinations (e.g., Book 2 + Celigo Europe B.V.) and only see #N/A errors

**Fix Applied**:
- Added validation when Q3 (subsidiary) changes
- Check if selected subsidiary is enabled for current book
- Show alert in task pane with clear instructions
- Show toast notification

**Test Steps**:
1. Set U3 to book 2
2. Select a valid subsidiary (e.g., "Celigo India Pvt Ltd") from modal
3. Verify no error appears
4. Manually change Q3 to an invalid subsidiary (e.g., "Celigo Europe B.V.")
5. Verify error alert appears in task pane
6. Verify toast notification appears
7. Verify alert shows:
   - Clear error message
   - Instructions on what to do
   - Dismiss button

**Expected Result**: 
- Valid combinations: No error
- Invalid combinations: Alert in task pane + toast, clear instructions

---

## Verification Checklist

- [ ] Cache check completes within 120 seconds
- [ ] Progress overlay closes after cache is ready
- [ ] Subsidiary selection modal appears after overlay closes
- [ ] Valid book-subsidiary combinations show no error
- [ ] Invalid combinations show alert in task pane
- [ ] Invalid combinations show toast notification
- [ ] Alert is dismissible
- [ ] Alert provides clear instructions

