# Silent Zero Fixes - Review Document

**Date:** January 2, 2025  
**Status:** Phase 1 Complete - Backend Query & Parse Error Handling  
**Restore Branch:** `restore/working-period-dates` (created)

---

## Executive Summary

This document outlines the changes made to eliminate silent zeros in financial formulas. The goal is to ensure that formulas **never return 0 due to errors** - only when it's a legitimate business result (no activity).

**Key Principle:** Finance-critical formulas must **fail loudly** on errors, not silently return 0.

---

## Changes Made

### 1. SpecialFormulaController - Error-Aware Query Execution

**File:** `backend-dotnet/Controllers/SpecialFormulaController.cs`

#### 1.1 CalculateRetainedEarnings Method

**Before:**
```csharp
var priorPlTask = _netSuiteService.QueryRawAsync(priorPlQuery, 120);
var postedReTask = _netSuiteService.QueryRawAsync(postedReQuery, 120);
await Task.WhenAll(priorPlTask, postedReTask);
decimal priorPl = ParseDecimalFromResult(await priorPlTask);
decimal postedRe = ParseDecimalFromResult(await postedReTask);
```

**After:**
```csharp
var priorPlTask = _netSuiteService.QueryRawWithErrorAsync(priorPlQuery, 120);
var postedReTask = _netSuiteService.QueryRawWithErrorAsync(postedReQuery, 120);
await Task.WhenAll(priorPlTask, postedReTask);

// Check for query errors - fail loudly instead of returning 0
var priorPlResult = await priorPlTask;
if (!priorPlResult.Success)
{
    _logger.LogError("Retained Earnings: Prior P&L query failed with {ErrorCode}: {ErrorDetails}", 
        priorPlResult.ErrorCode, priorPlResult.ErrorDetails);
    return StatusCode(500, new { 
        error = "Failed to calculate prior P&L", 
        errorCode = priorPlResult.ErrorCode,
        errorDetails = priorPlResult.ErrorDetails 
    });
}

var postedReResult = await postedReTask;
if (!postedReResult.Success)
{
    _logger.LogError("Retained Earnings: Posted RE query failed with {ErrorCode}: {ErrorDetails}", 
        postedReResult.ErrorCode, postedReResult.ErrorDetails);
    return StatusCode(500, new { 
        error = "Failed to calculate posted RE", 
        errorCode = postedReResult.ErrorCode,
        errorDetails = postedReResult.ErrorDetails 
    });
}

// Parse results only if queries succeeded
decimal priorPl = ParseDecimalFromResult(priorPlResult.Items);
decimal postedRe = ParseDecimalFromResult(postedReResult.Items);
```

**Impact:**
- ✅ Query failures now return HTTP 500 with error details instead of 0
- ✅ Frontend can distinguish between "no data" (0) and "query failed" (error)
- ✅ Errors are logged with error codes for troubleshooting

---

#### 1.2 CalculateCta Method

**Before:**
```csharp
var assetsTask = _netSuiteService.QueryRawAsync(assetsQuery, 120);
var liabilitiesTask = _netSuiteService.QueryRawAsync(liabilitiesQuery, 120);
// ... 4 more queries
await Task.WhenAll(assetsTask, liabilitiesTask, equityTask, priorPlTask, postedReTask, netIncomeTask);
decimal totalAssets = ParseDecimalFromResult(await assetsTask);
// ... parse all results
```

**After:**
```csharp
var assetsTask = _netSuiteService.QueryRawWithErrorAsync(assetsQuery, 120);
var liabilitiesTask = _netSuiteService.QueryRawWithErrorAsync(liabilitiesQuery, 120);
// ... 4 more queries with error handling
await Task.WhenAll(assetsTask, liabilitiesTask, equityTask, priorPlTask, postedReTask, netIncomeTask);

// Check each query result for errors
var assetsResult = await assetsTask;
if (!assetsResult.Success)
{
    _logger.LogError("CTA: Assets query failed with {ErrorCode}: {ErrorDetails}", 
        assetsResult.ErrorCode, assetsResult.ErrorDetails);
    return StatusCode(500, new { 
        error = "Failed to calculate assets", 
        errorCode = assetsResult.ErrorCode,
        errorDetails = assetsResult.ErrorDetails 
    });
}
// ... similar checks for all 6 queries

// Parse results only if all queries succeeded
decimal totalAssets = ParseDecimalFromResult(assetsResult.Items);
// ... parse all results
```

**Impact:**
- ✅ All 6 CTA queries now checked for errors individually
- ✅ If any query fails, entire CTA calculation fails with specific error
- ✅ No silent zeros from failed queries

---

#### 1.3 CalculateNetIncome Method

**Before:**
```csharp
var results = await _netSuiteService.QueryRawAsync(netIncomeQuery, 120);
decimal netIncome = ParseDecimalFromResult(results, "net_income");
```

**After:**
```csharp
var result = await _netSuiteService.QueryRawWithErrorAsync(netIncomeQuery, 120);

// Check for query errors - fail loudly instead of returning 0
if (!result.Success)
{
    _logger.LogError("Net Income: Query failed with {ErrorCode}: {ErrorDetails}", 
        result.ErrorCode, result.ErrorDetails);
    return StatusCode(500, new { 
        error = "Failed to calculate net income", 
        errorCode = result.ErrorCode,
        errorDetails = result.ErrorDetails 
    });
}

// Parse result only if query succeeded
decimal netIncome = ParseDecimalFromResult(result.Items, "net_income");
```

**Impact:**
- ✅ Net Income query failures now return HTTP 500 instead of 0
- ✅ Error details included in response for troubleshooting

---

### 2. ParseDecimalFromResult - Throw on Parse Failures

**File:** `backend-dotnet/Controllers/SpecialFormulaController.cs`

**Before:**
```csharp
private decimal ParseDecimalFromResult(List<JsonElement> results, string fieldName = "value")
{
    if (!results.Any()) return 0;  // ❌ No distinction between "no data" vs "query failed"
    var row = results.First();
    if (!row.TryGetProperty(fieldName, out var prop) || prop.ValueKind == JsonValueKind.Null)
        return 0;
    
    if (prop.ValueKind == JsonValueKind.String)
    {
        var strVal = prop.GetString();
        if (string.IsNullOrEmpty(strVal))
            return 0;
        
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

**After:**
```csharp
private decimal ParseDecimalFromResult(List<JsonElement> results, string fieldName = "value")
{
    // Empty result set after successful query = legitimate zero (no activity)
    if (!results.Any()) 
        return 0;
        
    var row = results.First();
    
    // Field missing or null = legitimate zero
    if (!row.TryGetProperty(fieldName, out var prop) || prop.ValueKind == JsonValueKind.Null)
        return 0;
    
    if (prop.ValueKind == JsonValueKind.String)
    {
        var strVal = prop.GetString();
        
        // Empty string = legitimate zero
        if (string.IsNullOrEmpty(strVal))
            return 0;
        
        // Handle scientific notation (e.g., "2.402086483E7")
        if (double.TryParse(strVal, ..., out var dblVal))
            return (decimal)dblVal;
        
        // Try decimal parsing
        if (decimal.TryParse(strVal, out var decVal))
            return decVal;
            
        // String cannot be parsed - this is an error, not a zero
        throw new InvalidOperationException(
            $"Failed to parse decimal from string value '{strVal}' in field '{fieldName}'. " +
            "This indicates a data format issue, not a legitimate zero balance.");
    }
    
    if (prop.ValueKind == JsonValueKind.Number)
        return prop.GetDecimal();
    
    // Unexpected ValueKind (Object, Array, etc.) - this is an error, not a zero
    throw new InvalidOperationException(
        $"Unexpected JSON value kind '{prop.ValueKind}' for field '{fieldName}'. " +
        "Expected Number or String, but got invalid data shape. This indicates a query result format issue.");
}
```

**Impact:**
- ✅ Returns 0 only for legitimate cases (empty results, null, empty string)
- ✅ Throws exception on parse failures (invalid data shape, unparseable string)
- ✅ Exceptions are caught by controller try-catch and returned as HTTP 500 errors

---

### 3. ParseBalance - Throw on Parse Failures

**File:** `backend-dotnet/Services/BalanceService.cs`

**Before:**
```csharp
private static decimal ParseBalance(JsonElement element)
{
    if (element.ValueKind == JsonValueKind.Null)
        return 0;
    
    if (element.ValueKind == JsonValueKind.Number)
        return element.GetDecimal();
    
    if (element.ValueKind == JsonValueKind.String)
    {
        var strVal = element.GetString();
        if (string.IsNullOrEmpty(strVal))
            return 0;
        
        if (double.TryParse(strVal, ..., out var dblVal))
            return (decimal)dblVal;
        
        if (decimal.TryParse(strVal, out var decVal))
            return decVal;
    }
    
    return 0;  // ❌ Returns 0 if ValueKind is unexpected
}
```

**After:**
```csharp
private static decimal ParseBalance(JsonElement element)
{
    // Null = legitimate zero
    if (element.ValueKind == JsonValueKind.Null)
        return 0;
    
    // Number = direct conversion
    if (element.ValueKind == JsonValueKind.Number)
        return element.GetDecimal();
    
    if (element.ValueKind == JsonValueKind.String)
    {
        var strVal = element.GetString();
        
        // Empty string = legitimate zero
        if (string.IsNullOrEmpty(strVal))
            return 0;
        
        // Handle scientific notation (e.g., "2.402086483E7")
        if (double.TryParse(strVal, ..., out var dblVal))
            return (decimal)dblVal;
        
        // Fallback to decimal parsing
        if (decimal.TryParse(strVal, out var decVal))
            return decVal;
        
        // String cannot be parsed - this is an error, not a zero
        throw new InvalidOperationException(
            $"Failed to parse balance from string value '{strVal}'. " +
            "This indicates a data format issue, not a legitimate zero balance.");
    }
    
    // Unexpected ValueKind (Object, Array, etc.) - this is an error, not a zero
    throw new InvalidOperationException(
        $"Unexpected JSON value kind '{element.ValueKind}' for balance. " +
        "Expected Number or String, but got invalid data shape. This indicates a query result format issue.");
}
```

**Impact:**
- ✅ Used throughout `BalanceService` and `BalanceController`
- ✅ Throws exception on invalid data shapes (Object, Array, unparseable strings)
- ✅ Exceptions propagate to controller error handling

---

### 4. ParseAmount - Throw on Parse Failures

**File:** `backend-dotnet/Services/BudgetService.cs`

**Before:**
```csharp
private static decimal ParseAmount(JsonElement element)
{
    if (element.ValueKind == JsonValueKind.Null)
        return 0;
    
    if (element.ValueKind == JsonValueKind.Number)
        return element.GetDecimal();
    
    if (element.ValueKind == JsonValueKind.String)
    {
        var strVal = element.GetString();
        if (string.IsNullOrEmpty(strVal))
            return 0;
        
        if (double.TryParse(strVal, ..., out var dblVal))
            return (decimal)dblVal;
        
        if (decimal.TryParse(strVal, out var decVal))
            return decVal;
    }
    
    return 0;  // ❌ Returns 0 if ValueKind is unexpected
}
```

**After:**
```csharp
private static decimal ParseAmount(JsonElement element)
{
    // Null = legitimate zero
    if (element.ValueKind == JsonValueKind.Null)
        return 0;
    
    // Number = direct conversion
    if (element.ValueKind == JsonValueKind.Number)
        return element.GetDecimal();
    
    if (element.ValueKind == JsonValueKind.String)
    {
        var strVal = element.GetString();
        
        // Empty string = legitimate zero
        if (string.IsNullOrEmpty(strVal))
            return 0;
        
        // Handle scientific notation
        if (double.TryParse(strVal, ..., out var dblVal))
            return (decimal)dblVal;
        
        if (decimal.TryParse(strVal, out var decVal))
            return decVal;
        
        // String cannot be parsed - this is an error, not a zero
        throw new InvalidOperationException(
            $"Failed to parse budget amount from string value '{strVal}'. " +
            "This indicates a data format issue, not a legitimate zero budget.");
    }
    
    // Unexpected ValueKind (Object, Array, etc.) - this is an error, not a zero
    throw new InvalidOperationException(
        $"Unexpected JSON value kind '{element.ValueKind}' for budget amount. " +
        "Expected Number or String, but got invalid data shape. This indicates a query result format issue.");
}
```

**Impact:**
- ✅ Budget queries now throw on parse failures instead of returning 0
- ✅ Consistent error handling across all financial parsing methods

---

## Error Response Format

All error responses now follow this format:

```json
{
  "error": "Human-readable error message",
  "errorCode": "TIMEOUT|RATE_LIMIT|AUTH_ERROR|QUERY_ERROR|SERVER_ERROR|NET_FAIL|NOT_FOUND",
  "errorDetails": "Full error details for logging/support"
}
```

**Error Codes:**
- `TIMEOUT` - Query timed out
- `RATE_LIMIT` - NetSuite rate limit exceeded
- `AUTH_ERROR` - Authentication failed
- `QUERY_ERROR` - SQL syntax or query error
- `SERVER_ERROR` - Server-side error (parsing, deserialization, etc.)
- `NET_FAIL` - Network failure
- `NOT_FOUND` - Resource not found

---

## What Still Returns 0 (Legitimate Cases)

The following cases **correctly** return 0:

1. **Empty Result Set After Successful Query**
   - Query succeeded, but no rows returned
   - Example: Account has no transactions in period

2. **Explicit NULL from NetSuite**
   - Query succeeded, field value is explicitly NULL
   - Example: `SELECT SUM(amount) AS balance FROM ...` returns `{balance: null}`

3. **Empty String**
   - Query succeeded, field value is empty string
   - Example: `{balance: ""}`

4. **No Activity Period**
   - Account exists but has no activity in the specified period
   - Example: Account 4220 has no transactions in Jan 2025

---

## What Now Throws Errors (Previously Returned 0)

The following cases **now throw errors** instead of returning 0:

1. **Query Failures**
   - NetSuite query failed (auth error, syntax error, timeout, etc.)
   - **Before:** Returned 0
   - **After:** Returns HTTP 500 with error details

2. **Invalid JSON Shape**
   - Unexpected ValueKind (Object, Array instead of Number/String)
   - **Before:** Returned 0
   - **After:** Throws `InvalidOperationException` → HTTP 500

3. **Unparseable Strings**
   - String value that cannot be parsed as number
   - **Before:** Returned 0
   - **After:** Throws `InvalidOperationException` → HTTP 500

---

## Testing Impact

### Before These Changes:
- ❌ Query failures → 0 (silent failure)
- ❌ Parse failures → 0 (silent failure)
- ❌ Invalid data shapes → 0 (silent failure)
- ✅ No activity → 0 (correct)

### After These Changes:
- ✅ Query failures → HTTP 500 error (loud failure)
- ✅ Parse failures → HTTP 500 error (loud failure)
- ✅ Invalid data shapes → HTTP 500 error (loud failure)
- ✅ No activity → 0 (still correct)

---

## Remaining Work

### Phase 2: Additional Backend Endpoints

1. **BalanceController.FullYearRefresh**
   - Replace `QueryRawAsync` with `QueryRawWithErrorAsync`
   - Add error checking before parsing results

2. **TypeBalanceController.BatchTypeBalanceRefresh**
   - Replace `QueryRawAsync` with `QueryRawWithErrorAsync`
   - Add error checking before parsing results

### Phase 3: Frontend Error Propagation

1. **Remove `|| 0` Fallbacks**
   - Update `TYPEBALANCE`, `RETAINEDEARNINGS`, `NETINCOME`, `CTA` functions
   - Check for `data.error` / `data.errorCode` in responses

2. **Excel Error Codes**
   - Map backend error codes to Excel errors:
     - `TIMEOUT` → `#TIMEOUT!`
     - `AUTH_ERROR` → `#AUTH!`
     - `QUERY_ERROR` → `#ERROR!`
     - etc.

3. **Error Handling in processBatchQueue**
   - Ensure batch processing propagates errors correctly

### Phase 4: Documentation & Verification

1. **Allow-Zero List**
   - Document all explicit allow-zero cases

2. **Verification Checklist**
   - Test cases for forced failures
   - Test cases for legitimate zeros

---

## Risk Assessment

**Low Risk:**
- ✅ Changes are isolated to error handling paths
- ✅ Legitimate zeros still work correctly
- ✅ All changes compile without errors
- ✅ Restore branch created for rollback

**Medium Risk:**
- ⚠️ Frontend needs updates to handle new error format
- ⚠️ Existing Excel sheets may show errors instead of 0 (this is intentional)

**Mitigation:**
- Test with real NetSuite data before deployment
- Verify legitimate zeros still return 0
- Update frontend before deploying backend changes

---

## Files Changed

1. `backend-dotnet/Controllers/SpecialFormulaController.cs`
   - Updated 3 methods to use `QueryRawWithErrorAsync`
   - Updated `ParseDecimalFromResult` to throw on parse failures

2. `backend-dotnet/Services/BalanceService.cs`
   - Updated `ParseBalance` to throw on parse failures

3. `backend-dotnet/Services/BudgetService.cs`
   - Updated `ParseAmount` to throw on parse failures

---

## Next Steps

1. **Review this document** - Confirm approach is correct
2. **Test changes** - Verify legitimate zeros still work
3. **Continue with Phase 2** - Update remaining backend endpoints
4. **Continue with Phase 3** - Update frontend error handling
5. **Complete Phase 4** - Documentation and verification

---

## Questions for Review

1. Is the error response format acceptable?
2. Should we proceed with Phase 2 (BalanceController, TypeBalanceController)?
3. Should we proceed with Phase 3 (Frontend updates)?
4. Are there any other endpoints that should be prioritized?

