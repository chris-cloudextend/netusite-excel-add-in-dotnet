# Next Steps: Balance Sheet Grid Batching Implementation

## ✅ Frontend Implementation Complete

The frontend code is fully implemented and ready. All batching logic is in place with:
- Hard account type gate (Income/Expense isolation)
- Queue-based pattern detection
- Anchor inference
- Batched query execution
- Clean fallback behavior

---

## 🔧 Required: Backend API Extensions

The frontend will gracefully fall back to individual requests if backend doesn't support these parameters yet, but for batching to work, you need to extend the backend.

### 1. Extend `/balance` Endpoint - `anchor_date` Parameter

**File**: `backend-dotnet/Controllers/BalanceController.cs`

**Location**: `GetBalance` method (around line 54)

**New Parameter**: `[FromQuery] string? anchor_date = null`

**Behavior**:
- When `anchor_date` is provided (YYYY-MM-DD format) with empty `from_period` and `to_period`:
  - Return opening balance as of the anchor date (last day of previous month)
  - Equivalent to cumulative balance from inception through anchor date
  - This is used for the first query in batch processing

**Example Request**:
```
GET /balance?account=10010&from_period=&to_period=&anchor_date=2024-12-31&subsidiary=&department=&location=&class=&accountingbook=
```

**Response**: Same format as existing (number as text or JSON)

---

### 2. Extend `/balance` Endpoint - Batch Mode Parameters

**File**: `backend-dotnet/Controllers/BalanceController.cs`

**Location**: `GetBalance` method (around line 54)

**New Parameters**:
- `[FromQuery] bool batch_mode = false`
- `[FromQuery] bool include_period_breakdown = false`

**Behavior**:
- When `batch_mode=true` and `include_period_breakdown=true`:
  - Calculate period activity for each month in the range (from_period → to_period)
  - Return JSON with per-period breakdown instead of single value
  - This is used for the second query in batch processing

**Example Request**:
```
GET /balance?account=10010&from_period=Jan%202025&to_period=Dec%202025&batch_mode=true&include_period_breakdown=true&subsidiary=&department=&location=&class=&accountingbook=
```

**Response Format** (when batch_mode=true):
```json
{
  "total": 50000.00,
  "period_activity": {
    "Jan 2025": 5000.00,
    "Feb 2025": -2000.00,
    "Mar 2025": 3000.00,
    ...
  }
}
```

**Response Format** (when batch_mode=false or not provided):
- Same as existing (number as text or JSON with total only)

---

### 3. Backend Service Layer Changes

**File**: `backend-dotnet/Services/BalanceService.cs`

You may need to extend `GetBalanceAsync` method to:
1. Handle `anchor_date` parameter for opening balance queries
2. Support period breakdown calculation when `batch_mode=true`

**Key Implementation Notes**:
- `anchor_date` should query cumulative balance up to that date
- Period breakdown should calculate activity for each month in the range
- Maintain backward compatibility (all new parameters are optional)

---

## 🧪 Testing Plan

Once backend is extended, test in this order:

### 1. Income Statement Isolation Test
- Formula: `=XAVI.BALANCE("40000", "Jan 2025", "Jan 2025")`
- **Expected**: Works exactly as before, no grid detection, no batching
- **Verify**: No batching logs in console

### 2. Balance Sheet Single Cell Test
- Formula: `=XAVI.BALANCE("10010", , "Jan 2025")`
- **Expected**: Works as before (no grid, uses existing logic)
- **Verify**: Individual API call, no batching

### 3. Balance Sheet Grid Test (Success Case)
- Formula: `=XAVI.BALANCE("10010", , C$2)` dragged across 12 months
- **Expected**:
  - Pattern detected: `🎯 BS GRID PATTERN DETECTED` log
  - One batched query (2 API calls): opening balance + period activity
  - Inferred anchor date logged
  - Correct ending balances in all cells
  - No per-period preload logs
  - Fast resolution

### 4. Fallback Test
- Test with backend that doesn't support new parameters yet
- **Expected**: Falls back to individual requests gracefully
- **Verify**: No errors, all cells resolve correctly

---

## 📝 Version Bumping & Deployment

After backend is ready and tested:

1. **Update Version Numbers**:
   - `docs/functions.js`: Update `FUNCTIONS_VERSION` constant
   - `excel-addin/manifest.xml`: Update `<Version>` tag and all `?v=` URL params
   - `docs/taskpane.html`: Update `functions.js` script src `?v=` param
   - `docs/sharedruntime.html`: Update `functions.js` script src `?v=` param
   - `docs/functions.html`: Update `functions.js` script src `?v=` param

2. **Commit & Push**:
   ```bash
   git add .
   git commit -m "feat: Add balance sheet grid batching for cumulative formulas"
   git push
   ```

3. **Clear Excel Cache** (for testing):
   - Remove add-in from Excel
   - Close Excel completely
   - Run cache clearing script (if available)
   - Re-add add-in

---

## 🔍 Verification Checklist

After deployment, verify:

- [ ] Income statement formulas work exactly as before
- [ ] Balance sheet single cells work as before
- [ ] Balance sheet grid batching works (pattern detected, 2 API calls, correct balances)
- [ ] January balances match NetSuite exactly (validates anchor math)
- [ ] No per-period preload logs when batching is active
- [ ] Fallback works if backend doesn't support new parameters
- [ ] No Excel crashes or instability

---

## 📚 Documentation

The implementation plan is documented in:
- `IMPLEMENTATION_PLAN_BS_BATCHING.md` - Full implementation plan
- Code comments in `docs/functions.js` - Inline documentation

---

## ⚠️ Important Notes

1. **Backward Compatibility**: All new backend parameters are optional. Existing calls work unchanged.

2. **Error Handling**: If `anchor_date` is invalid or `batch_mode` parameters are malformed, return error response (same as existing error handling).

3. **Performance**: Batch mode may be slower for large period ranges. Consider adding limits (e.g., max 24 periods).

4. **Flag if Limitation Found**: If the existing `/balance` endpoint architecture truly cannot support these parameters (e.g., requires major refactor), flag it explicitly before proceeding.

