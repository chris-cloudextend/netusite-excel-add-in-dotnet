# Book Change Fixes - Summary

## Issue 1: Cache Persistence ✅ FIXED

**Problem**: The book-subsidiary cache was in-memory only, so it was lost on server restart, causing long delays on first use.

**Solution**: 
- Added file-based persistence to `LookupService.cs`
- Cache is saved to disk at: `~/Library/Application Support/XaviApi/book-subsidiary-cache.json` (Mac) or `%AppData%\XaviApi\book-subsidiary-cache.json` (Windows)
- Cache is loaded on server startup (non-blocking)
- Cache is saved after building from NetSuite

**Benefits**:
- Cache survives server restarts
- First use after restart is instant (no 5-30 second wait)
- Cache is NOT cleared by frontend cache clearing (it's backend-only)

**Files Changed**:
- `backend-dotnet/Services/LookupService.cs`: Added `LoadCacheFromDiskAsync()` and `SaveCacheToDiskAsync()` methods

---

## Issue 2: Book 2 → Book 1 Change ✅ FIXED

**Problem**: When changing from book 2 back to book 1, nothing happened - no modal appeared, user wasn't prompted to select a subsidiary.

**Solution**:
- Modified `taskpane.html` to show modal for Primary Book (book 1) when changing TO it
- Modal shows ALL subsidiaries (since Primary Book allows all)
- Updated transition flag logic to include Primary Book
- Updated guard clause in `functions.js` to check Primary Book transitions
- Added transition flag clearing after user selects subsidiary for Primary Book

**Flow**:
1. User changes U3 from "2" to "1"
2. Transition flag is set (now includes Primary Book)
3. Formulas show #N/A (guard clause blocks execution)
4. Modal appears with all subsidiaries
5. User selects subsidiary
6. Q3 is updated
7. Transition flag is updated with `newSubsidiary`
8. Transition flag is cleared after 1 second
9. Formulas can now execute

**Files Changed**:
- `docs/taskpane.html`: 
  - Set transition flag for ALL books (including Primary Book)
  - Show modal for Primary Book with all subsidiaries
  - Clear transition flag after user selects subsidiary
- `docs/functions.js`: 
  - Guard clause now checks ALL books (including Primary Book)
  - Blocks execution until user selects subsidiary

---

## Testing Checklist

### Test 1: Cache Persistence
1. Start server
2. Wait for cache to build (check logs)
3. Verify cache file exists: `~/Library/Application Support/XaviApi/book-subsidiary-cache.json`
4. Restart server
5. Check logs - should see "✅ Loaded book-subsidiary cache from disk"
6. Change book in Excel - should be instant (no wait for cache)

### Test 2: Book 2 → Book 1 Change
1. Set U3 to book 2
2. Select subsidiary from modal
3. Change U3 to book 1
4. **Expected**: Modal appears with all subsidiaries
5. Select a subsidiary
6. **Expected**: Q3 updates, formulas execute correctly

### Test 3: Book 1 → Book 2 Change
1. Set U3 to book 1
2. Select subsidiary from modal
3. Change U3 to book 2
4. **Expected**: Modal appears with filtered subsidiaries
5. Select a subsidiary
6. **Expected**: Q3 updates, formulas execute correctly

---

## Deployment Steps

1. **Restart Backend Server**:
   ```bash
   bash excel-addin/useful-commands/start-dotnet-server.sh
   ```

2. **Verify Cache File Location**:
   - Mac: `~/Library/Application Support/XaviApi/book-subsidiary-cache.json`
   - Windows: `%AppData%\XaviApi\book-subsidiary-cache.json`

3. **Push to Git**:
   ```bash
   git add .
   git commit -m "Fix book change: add cache persistence, show modal for Primary Book"
   git push
   ```

4. **Clear Excel Cache** (for testing):
   - Remove and re-add the add-in in Excel

---

## Notes

- **Cache Protection**: The book-subsidiary cache is backend-only and is NOT cleared by frontend cache clearing operations. It only rebuilds if:
  - Server restarts and cache file doesn't exist
  - Cache file is manually deleted
  - Cache initialization fails

- **Primary Book Behavior**: Primary Book (book 1) now shows a modal with ALL subsidiaries, allowing the user to select which subsidiary to use. This ensures consistency with other books.

- **Transition Flag**: The transition flag is now set for ALL books (including Primary Book) to ensure formulas show #N/A while the user is selecting a subsidiary.

