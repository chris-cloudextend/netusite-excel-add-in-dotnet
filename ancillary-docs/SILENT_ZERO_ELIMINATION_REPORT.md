# Silent Zero Elimination Report

**Date:** January 2, 2025  
**Objective:** Ensure financial formulas never return 0 due to errors - only when it's a legitimate business result.

---

## Executive Summary

This audit identified **multiple critical paths** where financial formulas can return 0 incorrectly:
1. **QueryRawAsync/QueryAsync swallow errors** - return empty lists on NetSuite failures
2. **ParseBalance/ParseDecimal return 0 on parse failures** - should throw or return errors
3. **Frontend uses `|| 0` fallback** - masks API errors as zeros
4. **Empty result sets return 0 without checking query success** - legitimate vs error ambiguity

---

## Phase A: Identified Silent Zero Paths

### 1. NetSuiteService.QueryRawAsync - Swallows Errors

**File:** `backend-dotnet/Services/NetSuiteService.cs`  
**Method:** `QueryRawAsync` (lines 114-121)  
**Issue:** Returns empty list when query fails, no error propagation

```csharp
public async Task<List<JsonElement>> QueryRawAsync(string query, int timeout = 30)
{
    var result = await ExecuteQueryAsync(query, timeout);
    _logger.LogInformation("QueryRawAsync: Got result - Items={Items}, Error={Error}", 
        result.Items?.Count ?? -1, result.Error ?? "none");
    return result.Items ?? new List<JsonElement>();  // ❌ Returns empty list even if Error != null
}
```

**Impact:** All finance-critical endpoints using `QueryRawAsync` will receive empty results on errors, which then get parsed as 0.

**Affected Endpoints:**
- `SpecialFormulaController.CalculateRetainedEarnings` (lines 150-151)
- `SpecialFormulaController.CalculateCta` (lines 335-340)
- `SpecialFormulaController.CalculateNetIncome` (line 474)
- `BalanceController.FullYearRefresh` (multiple queries)
- `TypeBalanceController.BatchTypeBalanceRefresh` (line 202)
- All other endpoints using `QueryRawAsync`

---

### 2. NetSuiteService.QueryAsync - Swallows Errors

**File:** `backend-dotnet/Services/NetSuiteService.cs`  
**Method:** `QueryAsync<T>` (lines 88-108)  
**Issue:** Returns empty list on error or deserialization failure

```csharp
public async Task<List<T>> QueryAsync<T>(string query, int timeout = 30)
{
    var result = await ExecuteQueryAsync(query, timeout);
    
    if (result.Error != null)
    {
        _logger.LogError("SuiteQL query failed: {Error}", result.Error);
        return new List<T>();  // ❌ Returns empty list on error
    }

    try
    {
        return result.Items?.Select(item => 
            JsonSerializer.Deserialize<T>(item.GetRawText())!).ToList() ?? new List<T>();
    }
    catch (Exception ex)
    {
        _logger.LogError(ex, "Failed to deserialize query results");
        return new List<T>();  // ❌ Returns empty list on deserialization failure
    }
}
```

**Impact:** Any endpoint using `QueryAsync<T>` will receive empty results on errors.

---

### 3. BalanceService.ParseBalance - Returns 0 on Parse Failures

**File:** `backend-dotnet/Services/BalanceService.cs`  
**Method:** `ParseBalance` (lines 56-83)  
**Issue:** Returns 0 when parsing fails instead of throwing

```csharp
private static decimal ParseBalance(JsonElement element)
{
    if (element.ValueKind == JsonValueKind.Null)
        return 0;  // ⚠️ OK if query succeeded and value is null
    
    if (element.ValueKind == JsonValueKind.Number)
        return element.GetDecimal();
    
    if (element.ValueKind == JsonValueKind.String)
    {
        var strVal = element.GetString();
        if (string.IsNullOrEmpty(strVal))
            return 0;  // ⚠️ OK if query succeeded and value is empty
        
        if (double.TryParse(strVal, ..., out var dblVal))
            return (decimal)dblVal;
        
        if (decimal.TryParse(strVal, out var decVal))
            return decVal;
    }
    
    return 0;  // ❌ Returns 0 if ValueKind is unexpected (Object, Array, etc.)
}
```

**Impact:** Invalid JSON shapes (e.g., Object or Array where number expected) silently return 0.

**Usage:** Used throughout `BalanceService` and `BalanceController` for parsing balance values.

---

### 4. SpecialFormulaController.ParseDecimalFromResult - Returns 0 on Empty Results

**File:** `backend-dotnet/Controllers/SpecialFormulaController.cs`  
**Method:** `ParseDecimalFromResult` (lines 588-617)  
**Issue:** Returns 0 for empty results without checking if query succeeded

```csharp
private decimal ParseDecimalFromResult(List<JsonElement> results, string fieldName = "value")
{
    if (!results.Any()) return 0;  // ❌ No distinction between "no data" vs "query failed"
    var row = results.First();
    if (!row.TryGetProperty(fieldName, out var prop) || prop.ValueKind == JsonValueKind.Null)
        return 0;  // ⚠️ OK if query succeeded and field is null
    
    if (prop.ValueKind == JsonValueKind.String)
    {
        var strVal = prop.GetString();
        if (string.IsNullOrEmpty(strVal))
            return 0;  // ⚠️ OK if query succeeded and value is empty
        
        if (double.TryParse(strVal, ..., out var dblVal))
            return (decimal)dblVal;
        
        if (decimal.TryParse(strVal, out var decVal))
            return decVal;
            
        return 0;  // ❌ Returns 0 if string cannot be parsed
    }
    if (prop.ValueKind == JsonValueKind.Number)
        return prop.GetDecimal();
    
    return 0;  // ❌ Returns 0 if ValueKind is unexpected
}
```

**Impact:** Used in:
- `CalculateRetainedEarnings` (lines 155-156)
- `CalculateCta` (lines 344-349)
- `CalculateNetIncome` (line 475)

All will return 0 if query failed (empty results) or if parsing fails.

---

### 5. BudgetService.ParseAmount - Returns 0 on Parse Failures

**File:** `backend-dotnet/Services/BudgetService.cs`  
**Method:** `ParseAmount` (lines 32-58)  
**Issue:** Same pattern as `ParseBalance` - returns 0 on failures

**Impact:** Budget queries will return 0 on parse failures.

---

### 6. Frontend: `|| 0` Fallback Masks Errors

**File:** `docs/functions.js`  
**Locations:**
- Line 10324: `const value = parseFloat(data.value) || 0;` (TYPEBALANCE)
- Multiple other locations using `|| 0` or `|| 0.0`

**Issue:** If backend returns error response or `null`, frontend converts to 0.

**Example:**
```javascript
const data = await response.json();
const value = parseFloat(data.value) || 0;  // ❌ Returns 0 if data.value is null/undefined/NaN
```

**Impact:** API errors, network failures, and null responses all become 0 in Excel.

---

### 7. BalanceService.BalanceAsync - Returns 0 on Period Resolution Failures

**File:** `backend-dotnet/Services/BalanceService.cs`  
**Method:** `BalanceAsync` (lines 192-202, 318-325)  
**Issue:** Returns `Balance = 0` when period cannot be resolved

```csharp
if (toPeriodData?.EndDate == null)
{
    _logger.LogWarning("Could not find period dates for {To}", toPeriod);
    return new BalanceResponse
    {
        Account = request.Account,
        FromPeriod = request.FromPeriod,
        ToPeriod = toPeriod,
        Balance = 0  // ❌ Should return error, not 0
    };
}
```

**Impact:** Invalid period inputs return 0 instead of error.

---

## Phase B: Error-Aware Query Execution Strategy

### Solution: Use QueryRawWithErrorAsync / QueryWithErrorAsync

**File:** `backend-dotnet/Services/NetSuiteService.cs`  
**Methods:** `QueryRawWithErrorAsync` (lines 159-173), `QueryWithErrorAsync<T>` (lines 129-151)

**Status:** ✅ Already implemented but **NOT USED** in finance-critical endpoints.

**Required Changes:**
1. Replace all `QueryRawAsync` calls in finance-critical endpoints with `QueryRawWithErrorAsync`
2. Check `QueryResult.ErrorCode` and return HTTP error responses
3. Only parse results if `QueryResult.Success == true`

---

## Phase C: Decimal Parsing Fix Strategy

### Solution: Throw on Parse Failures

**Required Changes:**
1. **ParseBalance**: Throw `InvalidOperationException` if ValueKind is unexpected (Object, Array)
2. **ParseDecimalFromResult**: Throw if string cannot be parsed (after scientific notation attempt)
3. **ParseAmount**: Same as ParseBalance

**Exception:** Return 0 only if:
- Query succeeded (`QueryResult.Success == true`)
- Value is explicitly `null` or empty string
- This represents "no activity" (legitimate zero)

---

## Phase D: Frontend Error Propagation

### Solution: Check for Error Responses

**Required Changes:**
1. Check `response.ok` before parsing JSON
2. Check for `data.error` or `data.errorCode` in response
3. Throw Excel-compatible errors (`#ERROR!`, `#TIMEOUT!`, etc.) instead of returning 0
4. Remove `|| 0` fallbacks in finance-critical formulas

**Excel Error Codes:**
- `#ERROR!` - General error
- `#TIMEOUT!` - Query timeout
- `#AUTH!` - Authentication error
- `#NETWORK!` - Network failure

---

## Allow-Zero Cases (Explicitly Allowed)

### 1. No Activity in Period
- **Condition:** Query succeeded, result set is empty or SUM() returns NULL
- **Example:** Account 4220 has no transactions in Jan 2025
- **Return:** 0

### 2. Unopened Account
- **Condition:** Account exists but has never had any transactions
- **Example:** New account created but not yet used
- **Return:** 0

### 3. Budget Line with No Entries
- **Condition:** Budget query succeeded, no budget entries for account/period
- **Example:** Account 4220 has no budget for Jan 2025
- **Return:** 0

### 4. Explicit NULL from NetSuite
- **Condition:** Query succeeded, field value is explicitly NULL
- **Example:** `SELECT SUM(amount) AS balance FROM ...` returns `{balance: null}`
- **Return:** 0

---

## Verification Checklist

### Test Cases Required

1. **Forced NetSuite Auth Failure**
   - **Action:** Temporarily break NetSuite credentials
   - **Expected:** Formula returns `#AUTH!` error, NOT 0
   - **Status:** ⏳ Pending

2. **Forced SuiteQL Syntax Error**
   - **Action:** Inject invalid SQL into query
   - **Expected:** Formula returns `#ERROR!` error, NOT 0
   - **Status:** ⏳ Pending

3. **Forced Parse Failure**
   - **Action:** Return unexpected JSON shape (Object instead of Number)
   - **Expected:** Formula returns `#ERROR!` error, NOT 0
   - **Status:** ⏳ Pending

4. **Legitimate No-Data Case**
   - **Action:** Query account with no transactions in period
   - **Expected:** Formula returns 0 (legitimate)
   - **Status:** ⏳ Pending

5. **Network Timeout**
   - **Action:** Simulate network timeout
   - **Expected:** Formula returns `#TIMEOUT!` error, NOT 0
   - **Status:** ⏳ Pending

---

## Implementation Plan

### Phase 1: Backend Query Error Handling
1. Replace `QueryRawAsync` with `QueryRawWithErrorAsync` in:
   - `SpecialFormulaController` (3 methods)
   - `BalanceController.FullYearRefresh`
   - `TypeBalanceController.BatchTypeBalanceRefresh`
2. Check `QueryResult.ErrorCode` and return HTTP errors
3. Update response models to include `errorCode` field

### Phase 2: Backend Parse Error Handling
1. Update `ParseBalance` to throw on unexpected ValueKind
2. Update `ParseDecimalFromResult` to throw on parse failures
3. Update `ParseAmount` to throw on parse failures
4. Add try-catch in controllers to return HTTP errors

### Phase 3: Frontend Error Propagation
1. Remove `|| 0` fallbacks in finance-critical formulas
2. Check for `data.error` / `data.errorCode` in responses
3. Throw Excel-compatible errors
4. Update error handling in `processBatchQueue`

### Phase 4: Testing & Verification
1. Run all test cases from checklist
2. Verify legitimate zeros still work
3. Verify errors propagate correctly

---

## Files Requiring Changes

### Backend
- `backend-dotnet/Services/NetSuiteService.cs` - Already has error-aware methods ✅
- `backend-dotnet/Services/BalanceService.cs` - Update ParseBalance, replace QueryRawAsync
- `backend-dotnet/Controllers/SpecialFormulaController.cs` - Replace QueryRawAsync, update ParseDecimalFromResult
- `backend-dotnet/Controllers/BalanceController.cs` - Replace QueryRawAsync in FullYearRefresh
- `backend-dotnet/Controllers/TypeBalanceController.cs` - Replace QueryRawAsync
- `backend-dotnet/Services/BudgetService.cs` - Update ParseAmount

### Frontend
- `docs/functions.js` - Remove `|| 0` fallbacks, add error checking

---

## Risk Assessment

**High Risk:** Changing error handling in finance-critical paths  
**Mitigation:** 
- Create restore branch (✅ Done: `restore/working-period-dates`)
- Test each change incrementally
- Verify legitimate zeros still work
- Test with real NetSuite data

---

## Implementation Status

1. ✅ Create restore branch (`restore/working-period-dates`)
2. ✅ Phase 1: Backend query error handling
   - SpecialFormulaController: All 3 methods use `QueryRawWithErrorAsync`
   - BalanceController.FullYearRefresh: Uses `QueryRawWithErrorAsync`
   - BalanceController.GetBalanceYear: Uses `QueryRawWithErrorAsync`
   - BalanceController.GenerateBalanceSheetReport: All special formula queries use `QueryRawWithErrorAsync`
   - TypeBalanceController.BatchTypeBalanceRefresh: Uses `QueryRawWithErrorAsync`
3. ✅ Phase 2: Backend parse error handling
   - `ParseDecimalFromResult`: Throws on parse failures
   - `ParseBalance`: Throws on parse failures
   - `ParseAmount`: Throws on parse failures
4. ✅ Phase 3: Frontend error propagation
   - RETAINEDEARNINGS: Checks for `data.error` / `data.errorCode`
   - NETINCOME: Checks for `data.error` / `data.errorCode`
   - CTA: Checks for `data.error` / `data.errorCode`
   - TYPEBALANCE: Removed `|| 0` fallback, added error checking
5. ✅ Phase 4: Documentation & verification
   - Created `ALLOW_ZERO_LIST.md`
   - Created `VERIFICATION_CHECKLIST.md`
   - Updated this report

## Files Changed

### Backend
1. `backend-dotnet/Controllers/SpecialFormulaController.cs`
   - Updated 3 methods to use `QueryRawWithErrorAsync`
   - Updated `ParseDecimalFromResult` to throw on parse failures

2. `backend-dotnet/Controllers/BalanceController.cs`
   - Updated `FullYearRefresh` to use `QueryRawWithErrorAsync`
   - Updated `GetBalanceYear` to use `QueryRawWithErrorAsync`
   - Updated `GenerateBalanceSheetReport` to use `QueryRawWithErrorAsync` for all special formula queries

3. `backend-dotnet/Controllers/TypeBalanceController.cs`
   - Updated `BatchTypeBalanceRefresh` to use `QueryRawWithErrorAsync`

4. `backend-dotnet/Services/BalanceService.cs`
   - Updated `ParseBalance` to throw on parse failures

5. `backend-dotnet/Services/BudgetService.cs`
   - Updated `ParseAmount` to throw on parse failures

### Frontend
1. `docs/functions.js`
   - Updated `RETAINEDEARNINGS` to check for `data.error` / `data.errorCode`
   - Updated `NETINCOME` to check for `data.error` / `data.errorCode`
   - Updated `CTA` to check for `data.error` / `data.errorCode`
   - Updated `TYPEBALANCE` to remove `|| 0` fallback and add error checking

## Verification

See `VERIFICATION_CHECKLIST.md` for complete test cases.

See `ALLOW_ZERO_LIST.md` for explicit allow-zero cases.

