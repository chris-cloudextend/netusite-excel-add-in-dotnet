# Account Search Bug Report - No Results Returned

**Date:** 2026-01-07  
**Issue:** Bulk Add GL Accounts search returns empty results for all patterns, including wildcards like `*`

---

## User Report

### Console Output:
```
[Log] === ACCOUNT SEARCH START ===
[Log] Pattern: – "Bank"
[Log] API URL: – "https://netsuite-proxy.chris-corcoran.workers.dev/accounts/search?pattern=Bank"
[Log] Search results:
{
  accounts: [] (0)
  count: 0
  pattern: "Bank"
  search_type: "account_type"
}
```

**Also tested:**
- Pattern `"bank"` (lowercase) - same result (empty)
- Pattern `"*"` (wildcard) - also returns nothing

---

## Code Flow Analysis

### 1. Frontend Request (taskpane.html)

```26869:26891:docs/taskpane.html
console.log('=== ACCOUNT SEARCH START ===');
console.log('Pattern:', pattern);

// Call backend API
// Backend expects 'pattern' parameter
const url = `${getServerUrl()}/accounts/search?pattern=${encodeURIComponent(pattern)}`;
console.log('API URL:', url);

const response = await fetch(url);

if (!response.ok) {
    const errorText = await response.text();
    console.error('API error:', errorText);
    throw new Error(`API error: ${response.status}`);
}

const data = await response.json();
console.log('Search results:', data);

const accounts = data.accounts || [];
```

**Frontend expects:** `data.accounts` array

---

### 2. Backend Controller (AccountController.cs)

```201:237:backend-dotnet/Controllers/AccountController.cs
[HttpGet("/accounts/search")]
public async Task<IActionResult> SearchAccounts(
    [FromQuery] string? pattern = null,
    [FromQuery] string? number = null,
    [FromQuery] string? type = null,
    [FromQuery] string? active_only = "true")
{
    try
    {
        // Support both pattern (Python-style) and number/type (legacy) parameters
        string? searchPattern = pattern;
        if (string.IsNullOrEmpty(searchPattern))
        {
            // Legacy support: combine number and type into pattern
            if (!string.IsNullOrEmpty(number) && !string.IsNullOrEmpty(type))
                searchPattern = $"{number}|{type}";
            else if (!string.IsNullOrEmpty(number))
                searchPattern = number;
            else if (!string.IsNullOrEmpty(type))
                searchPattern = type;
        }

        if (string.IsNullOrEmpty(searchPattern))
            return BadRequest(new { error = "Pattern parameter is required" });

        var activeOnly = active_only?.ToLower() == "true";
        var result = await _lookupService.SearchAccountsByPatternAsync(searchPattern, activeOnly);
        
        // Return format matching Python backend
        return Ok(new 
        { 
            pattern = searchPattern,
            search_type = result.SearchType,
            accounts = result.Items,
            count = result.Items.Count 
        });
    }
    catch (Exception ex)
    {
        _logger.LogError(ex, "Error searching accounts");
        return StatusCode(500, new { error = ex.Message });
    }
}
```

**Controller returns:** Anonymous object with `accounts: result.Items`

---

### 3. Service Method (LookupService.cs)

```1191:1363:backend-dotnet/Services/LookupService.cs
public async Task<AccountSearchResult> SearchAccountsByPatternAsync(string pattern, bool activeOnly = true)
{
    if (string.IsNullOrWhiteSpace(pattern))
        throw new ArgumentException("Pattern is required", nameof(pattern));

    var patternWithoutWildcards = pattern.Replace("*", "").Trim();
    var isTypeSearch = !string.IsNullOrEmpty(patternWithoutWildcards) && 
                      patternWithoutWildcards.Any(char.IsLetter);

    var conditions = new List<string>();
    var matchedTypes = new List<string>();
    string searchType;

    if (isTypeSearch)
    {
        // ACCOUNT TYPE search logic
        // ... builds SQL WHERE clause for account types ...
        searchType = "account_type";
    }
    else
    {
        // ACCOUNT NUMBER search
        var sqlPattern = pattern.Replace("*", "%");
        sqlPattern = NetSuiteService.EscapeSql(sqlPattern);
        conditions.Add($"a.acctnumber LIKE '{sqlPattern}'");
        searchType = "account_number";
    }

    // Filter by active status
    if (activeOnly)
        conditions.Add("a.isinactive = 'F'");

    // Build SuiteQL query
    var query = $@"
        SELECT 
            a.id,
            a.acctnumber,
            a.accountsearchdisplaynamecopy AS accountname,
            a.accttype,
            a.sspecacct,
            p.acctnumber AS parent
        FROM 
            Account a
        LEFT JOIN 
            Account p ON a.parent = p.id
        WHERE 
            {whereClause}
        ORDER BY 
            a.acctnumber";

    var results = await _netSuiteService.QueryPaginatedAsync<JsonElement>(query, orderBy: "a.acctnumber");

    var accounts = results.Select(r => new AccountItem
    {
        Id = r.TryGetProperty("id", out var id) ? id.ToString() : "",
        Number = r.TryGetProperty("acctnumber", out var num) ? num.GetString() ?? "" : "",
        Name = r.TryGetProperty("accountname", out var name) ? name.GetString() ?? "" : "",
        FullName = null,
        Type = r.TryGetProperty("accttype", out var type) ? type.GetString() ?? "" : "",
        SpecialAccountType = r.TryGetProperty("sspecacct", out var spec) && spec.ValueKind != JsonValueKind.Null ? spec.GetString() : null,
        Parent = r.TryGetProperty("parent", out var p) && p.ValueKind != JsonValueKind.Null ? p.GetString() : null
    }).ToList();

    return new AccountSearchResult
    {
        Items = accounts,
        SearchType = searchType,
        MatchedTypes = matchedTypes
    };
}
```

---

### 4. Response Model (LookupModels.cs)

```76:87:backend-dotnet/Models/LookupModels.cs
/// <summary>Account search result with metadata</summary>
public class AccountSearchResult
{
    [JsonPropertyName("accounts")]
    public List<AccountItem> Items { get; set; } = new();
    
    [JsonPropertyName("search_type")]
    public string SearchType { get; set; } = string.Empty;
    
    [JsonIgnore]
    public List<string> MatchedTypes { get; set; } = new();
}
```

**Note:** The `Items` property has `[JsonPropertyName("accounts")]` attribute.

---

## Potential Issues

### Issue 1: Response Serialization Conflict ⚠️ **MOST LIKELY**

**Problem:**
- `AccountSearchResult.Items` has `[JsonPropertyName("accounts")]`
- Controller returns anonymous object: `accounts: result.Items`
- This creates a conflict: the serializer might be using the model's attribute instead of the anonymous object property

**Expected JSON:**
```json
{
  "pattern": "Bank",
  "search_type": "account_type",
  "accounts": [...],
  "count": 0
}
```

**Actual JSON (from console):**
```json
{
  "pattern": "Bank",
  "search_type": "account_type",
  "accounts": [],
  "count": 0
}
```

The structure is correct, but `accounts` is empty. This suggests the query is returning 0 results.

---

### Issue 2: Backend Not Restarted ⚠️ **VERY LIKELY**

**Problem:**
- The `SearchAccountsByPatternAsync` method was recently added
- If the backend hasn't been restarted, it's still running old code
- The old code might not have this method, or might have a different implementation

**Evidence:**
- Response shows `search_type: "account_type"` - this suggests the new code IS running
- But empty results suggest either:
  1. SQL query is wrong
  2. NetSuite query is failing
  3. Results are being filtered out somewhere

---

### Issue 3: SQL Query Generation for Wildcard `*`

**For pattern `"*"`:**
- `patternWithoutWildcards = ""` (empty after removing `*`)
- `isTypeSearch = false` (no letters)
- Goes to account number search path
- `sqlPattern = "%"` (replaces `*` with `%`)
- SQL: `a.acctnumber LIKE '%'` - This should match ALL accounts

**If `*` returns nothing, the query itself might be failing or the NetSuite API call is erroring silently.**

---

### Issue 4: SQL Query for Type Search `"Bank"`

**For pattern `"Bank"`:**
- `patternWithoutWildcards = "Bank"`
- `isTypeSearch = true` (has letters)
- `patternUpper = "BANK"`
- Should find exact match: `exactTypeMatch = "Bank"`
- SQL: `a.accttype = 'Bank' AND a.isinactive = 'F'`

**This should work if:**
1. Backend code is running
2. NetSuite has Bank accounts
3. SQL is correctly formed
4. NetSuite query executes successfully

---

### Issue 5: NetSuite Query Execution Failure

**Possible causes:**
1. `QueryPaginatedAsync` is throwing an exception that's being caught
2. NetSuite API is returning an error that's not being logged
3. Query syntax is invalid for NetSuite SuiteQL
4. Authentication/permissions issue

**Missing:** Backend logs showing:
- `DEBUG - Exact type match: 'Bank'`
- `DEBUG - Final WHERE clause: ...`
- `DEBUG - Account search query: ...`
- Any errors from `QueryPaginatedAsync`

---

## Theory: Most Likely Root Cause

**The backend code was recently added but the backend server hasn't been restarted.**

**Evidence:**
1. Response structure matches new code (`search_type: "account_type"`)
2. But results are empty for ALL patterns (even `*`)
3. This suggests either:
   - Old code is still running (but response format suggests new code)
   - New code is running but SQL queries are failing silently
   - NetSuite connection/authentication issue

**Most likely:** The backend needs to be restarted to load the new `SearchAccountsByPatternAsync` method, OR the NetSuite query is failing but errors aren't being logged/returned to the frontend.

---

## Debugging Steps Needed

1. **Check backend logs** for:
   - `DEBUG - Exact type match: ...`
   - `DEBUG - Final WHERE clause: ...`
   - `DEBUG - Account search query: ...`
   - Any exceptions from `QueryPaginatedAsync`

2. **Verify backend is running latest code:**
   - Check if `SearchAccountsByPatternAsync` method exists
   - Verify backend was restarted after code changes

3. **Test SQL query directly:**
   - Run the generated SQL query against NetSuite manually
   - Verify it returns results

4. **Check NetSuite connection:**
   - Verify authentication is working
   - Check if other endpoints (e.g., `/health`, `/balance`) work

5. **Add more logging:**
   - Log the actual SQL query being sent
   - Log the raw response from NetSuite
   - Log any exceptions in try-catch blocks

---

## Code References Summary

- **Frontend:** `docs/taskpane.html` lines 26869-26891
- **Controller:** `backend-dotnet/Controllers/AccountController.cs` lines 201-244
- **Service:** `backend-dotnet/Services/LookupService.cs` lines 1191-1363
- **Model:** `backend-dotnet/Models/LookupModels.cs` lines 76-87

---

## Next Steps

1. **Restart the .NET backend** to ensure latest code is loaded
2. **Check backend logs** when making a search request
3. **Add exception logging** in the controller to catch any NetSuite query errors
4. **Test with a simple pattern** like `"1*"` (account number) to see if number search works
5. **Verify NetSuite connection** is working for other endpoints

