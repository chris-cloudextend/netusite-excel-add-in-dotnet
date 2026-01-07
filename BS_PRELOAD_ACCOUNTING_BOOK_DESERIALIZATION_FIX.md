# BS PRELOAD Accounting Book Deserialization Fix

## Critical Issue Found

The BS PRELOAD endpoint was **not receiving the accounting book parameter** from the frontend, causing it to always default to book 1 (Primary Book) instead of using the book specified in formulas.

## Root Cause

**JSON Property Name Mismatch:**

- **Frontend sends:** `accountingBook: "2"` (line 9431 in `taskpane.html`)
- **Backend model expects:** `book` (no `[JsonPropertyName]` attribute)
- **Result:** `request.Book` is always `null`, defaults to `DefaultAccountingBook = 1`

## Evidence from Logs

**BS PRELOAD (WRONG - using book 1):**
```
accountingBook=1, filtersHash=2::::1
cacheKey=balance:13000:May 2025:2::::1
balance=7,855,937.00
```

**Individual Query (CORRECT - using book 2):**
```
accountingBook=2, filtersHash=2::::2
cacheKey=balance:13000:May 2025:2::::2
balance=8,314,265.34
```

## Fix Applied

Added `[JsonPropertyName("accountingBook")]` attribute to both preload request models:

### 1. BsPreloadRequest (line 3815)
```csharp
/// <summary>Accounting book ID (e.g., 1 for Primary Book, 2 for India GAAP)</summary>
[System.Text.Json.Serialization.JsonPropertyName("accountingBook")]
[System.Text.Json.Serialization.JsonConverter(typeof(Models.FlexibleIntConverter))]
public int? Book { get; set; }
```

### 2. TargetedBsPreloadRequest (line 3834)
```csharp
/// <summary>Accounting book ID (e.g., 1 for Primary Book, 2 for India GAAP)</summary>
[System.Text.Json.Serialization.JsonPropertyName("accountingBook")]
[System.Text.Json.Serialization.JsonConverter(typeof(Models.FlexibleIntConverter))]
public int? Book { get; set; }
```

## Why This Fixes It

1. **JsonPropertyName("accountingBook")** - Maps frontend's `accountingBook` to backend's `Book` property
2. **FlexibleIntConverter** - Handles string "2" or number 2 from frontend
3. **Now `request.Book` will be 2** instead of null, so `accountingBook = (request.Book ?? DefaultAccountingBook).ToString()` will be "2"

## Impact

- **Before:** BS PRELOAD always used book 1, cached wrong values
- **After:** BS PRELOAD uses the correct book from formulas, caches correct values
- **Account 13000:** Will now return 8,314,265.34 (not 7,855,937) when dragging down formulas

## Testing

After restarting the backend:
1. Clear cache for account 13000
2. Drag down formulas with book 2
3. BS PRELOAD should log: `accountingBook=2, filtersHash=2::::2`
4. Cache key should be: `balance:13000:May 2025:2::::2`
5. Balance should be: 8,314,265.34 (matches individual query and NetSuite)

## Files Changed

- `backend-dotnet/Controllers/BalanceController.cs`
  - Added `[JsonPropertyName("accountingBook")]` to `BsPreloadRequest.Book` (line 3815)
  - Added `[JsonPropertyName("accountingBook")]` to `TargetedBsPreloadRequest.Book` (line 3834)
  - Added `[JsonConverter(typeof(Models.FlexibleIntConverter))]` to both (handles string/number conversion)
  - Added debug logging to verify accounting book is received correctly

