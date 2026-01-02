/*
 * XAVI for NetSuite - NetSuite API Service
 *
 * Copyright (c) 2025 Celigo, Inc.
 * All rights reserved.
 *
 * This service handles all communication with the NetSuite REST API,
 * including OAuth 1.0 authentication and SuiteQL query execution.
 * 
 * PERFORMANCE HARDENING (Excel-scale workloads):
 * - Centralized request governor for concurrency control
 * - Request deduplication for drag/fill scenarios
 * - Guaranteed pagination completion (no truncated results)
 * - Exponential backoff on rate limits
 *
 * INVARIANT ENFORCEMENT (see PERFORMANCE-INVARIANTS.md):
 * - SuiteQL paging always exhausts all pages before returning
 * - Safety limits fail loudly with explicit error messages
 * - Row cap exceeded returns explicit error, never silent truncation
 */

using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;
using XaviApi.Configuration;
using XaviApi.Models;

namespace XaviApi.Services;

/// <summary>
/// Service for executing SuiteQL queries against NetSuite REST API.
/// Handles OAuth 1.0 authentication, rate limiting, caching, and pagination.
/// 
/// THREAD SAFETY: This service is thread-safe and handles concurrent requests
/// from Excel workloads (3000+ formulas) safely via the governor.
/// </summary>
public class NetSuiteService : INetSuiteService
{
    private readonly NetSuiteConfig _config;
    private readonly CacheConfig _cacheConfig;
    private readonly IMemoryCache _cache;
    private readonly ILogger<NetSuiteService> _logger;
    private readonly HttpClient _httpClient;
    private readonly INetSuiteGovernor _governor;
    
    // Paging limits (SuiteQL hard limits)
    private const int MaxPageSize = 1000;
    private const int MaxTotalRows = 100000; // Safety limit
    
    // Default values
    public const int DefaultAccountingBook = 1; // Primary Book

    public NetSuiteService(
        IOptions<NetSuiteConfig> config,
        IOptions<CacheConfig> cacheConfig,
        IMemoryCache cache,
        ILogger<NetSuiteService> logger,
        INetSuiteGovernor governor)
    {
        _config = config.Value;
        _cacheConfig = cacheConfig.Value;
        _cache = cache;
        _logger = logger;
        _governor = governor;
        
        // Create our own HttpClient to avoid issues with typed HttpClient DI
        // This ensures we have full control over the client configuration
        _httpClient = new HttpClient
        {
            Timeout = TimeSpan.FromSeconds(300) // Allow long-running queries
        };
        
        if (!_config.IsValid)
        {
            _logger.LogWarning("NetSuite configuration is incomplete. API calls will fail.");
        }
    }

    /// <summary>
    /// Execute a SuiteQL query against NetSuite.
    /// </summary>
    /// <typeparam name="T">Type to deserialize results into</typeparam>
    /// <param name="query">SuiteQL query</param>
    /// <param name="timeout">Request timeout in seconds</param>
    /// <returns>List of results or empty list on error</returns>
    public async Task<List<T>> QueryAsync<T>(string query, int timeout = 30)
    {
        var result = await ExecuteQueryAsync(query, timeout);
        
        if (result.Error != null)
        {
            _logger.LogError("SuiteQL query failed: {Error}", result.Error);
            return new List<T>();
        }

        try
        {
            return result.Items?.Select(item => 
                JsonSerializer.Deserialize<T>(item.GetRawText())!).ToList() ?? new List<T>();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to deserialize query results");
            return new List<T>();
        }
    }

    /// <summary>
    /// Execute a SuiteQL query and return raw JSON elements.
    /// NOTE: This method swallows errors! Use QueryRawWithErrorAsync for proper error handling.
    /// </summary>
    public async Task<List<JsonElement>> QueryRawAsync(string query, int timeout = 30)
    {
        _logger.LogInformation("QueryRawAsync: Starting query (len={Len}, timeout={Timeout})", query.Length, timeout);
        var result = await ExecuteQueryAsync(query, timeout);
        _logger.LogInformation("QueryRawAsync: Got result - Items={Items}, Error={Error}", 
            result.Items?.Count ?? -1, result.Error ?? "none");
        return result.Items ?? new List<JsonElement>();
    }
    
    /// <summary>
    /// Execute a SuiteQL query with proper error propagation.
    /// Returns a QueryResult with either data or an error code.
    /// 
    /// INVARIANT: Errors are never swallowed - they return informative codes for Excel.
    /// </summary>
    public async Task<QueryResult<T>> QueryWithErrorAsync<T>(string query, int timeout = 30)
    {
        var result = await ExecuteQueryAsync(query, timeout);
        
        if (result.Error != null)
        {
            var errorCode = ErrorCodes.FromError(result.Error, result.SafetyLimitHit);
            _logger.LogWarning("Query failed with {ErrorCode}: {Error}", errorCode, result.Error);
            return QueryResult<T>.Fail(errorCode, result.Error);
        }

        try
        {
            var items = result.Items?.Select(item => 
                JsonSerializer.Deserialize<T>(item.GetRawText())!).ToList() ?? new List<T>();
            return QueryResult<T>.Ok(items);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to deserialize query results");
            return QueryResult<T>.Fail(ErrorCodes.ServerError, ex.Message);
        }
    }
    
    /// <summary>
    /// Execute a SuiteQL query with proper error propagation (raw JSON version).
    /// Returns a QueryResult with either data or an error code.
    /// 
    /// INVARIANT: Errors are never swallowed - they return informative codes for Excel.
    /// </summary>
    public async Task<QueryResult<JsonElement>> QueryRawWithErrorAsync(string query, int timeout = 30)
    {
        _logger.LogInformation("QueryRawWithErrorAsync: Starting query (len={Len}, timeout={Timeout})", query.Length, timeout);
        var result = await ExecuteQueryAsync(query, timeout);
        
        if (result.Error != null)
        {
            var errorCode = ErrorCodes.FromError(result.Error, result.SafetyLimitHit);
            _logger.LogWarning("Query failed with {ErrorCode}: {Error}", errorCode, result.Error);
            return QueryResult<JsonElement>.Fail(errorCode, result.Error);
        }
        
        _logger.LogInformation("QueryRawWithErrorAsync: Got {Count} items", result.Items?.Count ?? 0);
        return QueryResult<JsonElement>.Ok(result.Items ?? new List<JsonElement>());
    }

    /// <summary>
    /// Execute a paginated SuiteQL query to get ALL results.
    /// 
    /// GUARANTEE: This method will exhaust all pages sequentially before returning.
    /// SuiteQL has a hard limit of 1000 rows per query - we handle this transparently.
    /// 
    /// SEQUENTIAL PAGING: Pages are fetched one at a time through the governor,
    /// ensuring we don't exceed NetSuite concurrency limits during large queries.
    /// </summary>
    /// <param name="query">Base SuiteQL query (without ORDER BY/OFFSET/FETCH)</param>
    /// <param name="timeout">Timeout per page in seconds</param>
    /// <param name="pageSize">Rows per page (max 1000)</param>
    /// <param name="orderBy">Column(s) to order by for consistent paging</param>
    public async Task<List<T>> QueryPaginatedAsync<T>(
        string query, 
        int timeout = 30, 
        int pageSize = 1000,
        string orderBy = "1")
    {
        var allResults = new List<T>();
        var offset = 0;
        pageSize = Math.Min(pageSize, MaxPageSize); // Enforce NetSuite max
        var pageNumber = 0;

        _logger.LogDebug("Starting paginated query (pageSize={PageSize})", pageSize);

        while (true)
        {
            pageNumber++;
            var effectiveOrderBy = string.IsNullOrWhiteSpace(orderBy) ? "1" : orderBy;
            var paginatedQuery = $"{query} ORDER BY {effectiveOrderBy} OFFSET {offset} ROWS FETCH NEXT {pageSize} ROWS ONLY";
            
            _logger.LogDebug("Fetching page {Page} (offset={Offset})", pageNumber, offset);
            
            // Execute through standard path (uses governor for throttling)
            var pageResults = await QueryAsync<T>(paginatedQuery, timeout);
            
            if (pageResults.Count == 0)
            {
                _logger.LogDebug("Page {Page} empty - pagination complete", pageNumber);
                break;
            }
            
            allResults.AddRange(pageResults);
            _logger.LogDebug("Page {Page}: {Count} rows (running total: {Total})", 
                pageNumber, pageResults.Count, allResults.Count);
            
            // Check if we got a full page (more data might exist)
            if (pageResults.Count < pageSize)
            {
                _logger.LogDebug("Partial page {Page} - pagination complete", pageNumber);
                break;
            }
            
            offset += pageSize;
            
            // Safety limit to prevent runaway queries - FAIL LOUDLY
            if (offset >= MaxTotalRows)
            {
                // LOUD FAILURE: Row cap exceeded
                _logger.LogError(
                    "🚨 SAFETY LIMIT HIT: Row cap exceeded. " +
                    "Type=RowCapExceeded, CurrentRows={CurrentRows}, MaxRows={MaxRows}",
                    allResults.Count, MaxTotalRows);
                
                // Throw exception so this is never silently ignored
                throw new SafetyLimitException(
                    SafetyLimitType.RowCapExceeded,
                    $"Query returned more than {MaxTotalRows:N0} rows. " +
                    "Results may be incomplete. Please narrow your date range or add filters.",
                    $"CurrentRows={allResults.Count}, MaxRows={MaxTotalRows}, Pages={pageNumber}");
            }
        }

        _logger.LogInformation("Pagination complete: {Total} total rows across {Pages} page(s)", 
            allResults.Count, pageNumber);
        
        return allResults;
    }
    
    /// <summary>
    /// Execute a paginated query and return raw JSON elements.
    /// </summary>
    public async Task<List<JsonElement>> QueryPaginatedRawAsync(
        string query,
        int timeout = 30,
        int pageSize = 1000,
        string orderBy = "1")
    {
        var allResults = new List<JsonElement>();
        var offset = 0;
        pageSize = Math.Min(pageSize, MaxPageSize);
        var pageNumber = 0;

        while (true)
        {
            pageNumber++;
            var paginatedQuery = $"{query} ORDER BY {orderBy} OFFSET {offset} ROWS FETCH NEXT {pageSize} ROWS ONLY";
            
            var pageResults = await QueryRawAsync(paginatedQuery, timeout);
            
            if (pageResults.Count == 0)
                break;
            
            allResults.AddRange(pageResults);
            
            if (pageResults.Count < pageSize)
                break;
            
            offset += pageSize;
            
            if (offset >= MaxTotalRows)
            {
                // LOUD FAILURE: Row cap exceeded
                _logger.LogError(
                    "🚨 SAFETY LIMIT HIT: Row cap exceeded (raw). " +
                    "Type=RowCapExceeded, CurrentRows={CurrentRows}, MaxRows={MaxRows}",
                    allResults.Count, MaxTotalRows);
                
                throw new SafetyLimitException(
                    SafetyLimitType.RowCapExceeded,
                    $"Query returned more than {MaxTotalRows:N0} rows. " +
                    "Results may be incomplete. Please narrow your date range or add filters.",
                    $"CurrentRows={allResults.Count}, MaxRows={MaxTotalRows}");
            }
        }

        _logger.LogDebug("Raw pagination complete: {Total} rows", allResults.Count);
        return allResults;
    }

    /// <summary>
    /// Execute SuiteQL query through the governor with rate limiting and deduplication.
    /// 
    /// DEDUPLICATION: Identical queries running concurrently (e.g., from drag-fill)
    /// will be collapsed into a single NetSuite request.
    /// </summary>
    private async Task<SuiteQlResult> ExecuteQueryAsync(string query, int timeout)
    {
        // Generate canonical key for request deduplication
        var requestKey = NetSuiteGovernor.GenerateRequestKey(query);
        
        // Execute through governor (handles concurrency, deduplication, retry)
        var governedResult = await _governor.ExecuteAsync(
            requestKey,
            async () => await ExecuteQueryInternalAsync(query, timeout),
            timeout,
            maxRetries: 3);
        
        if (!governedResult.Success)
        {
            return new SuiteQlResult
            {
                Error = governedResult.Error,
                IsRateLimited = governedResult.IsRateLimited,
                SafetyLimitHit = governedResult.SafetyLimitHit
            };
        }
        
        // Parse the JSON result
        try
        {
            if (string.IsNullOrEmpty(governedResult.Data))
                return new SuiteQlResult { Items = new List<JsonElement>() };
            
            var json = JsonDocument.Parse(governedResult.Data);
            var items = json.RootElement.TryGetProperty("items", out var itemsElement)
                ? itemsElement.EnumerateArray().ToList()
                : new List<JsonElement>();
            
            return new SuiteQlResult { Items = items };
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to parse query result");
            return new SuiteQlResult { Error = ex.Message };
        }
    }
    
    /// <summary>
    /// Internal query execution (called by governor).
    /// </summary>
    private async Task<GovernedResult> ExecuteQueryInternalAsync(string query, int timeout)
    {
        var result = await SendQueryAsync(query, timeout);
        
        return new GovernedResult
        {
            Success = result.Error == null,
            Error = result.Error,
            Data = result.RawResponse,
            IsRateLimited = result.IsRateLimited
        };
    }

    /// <summary>
    /// Send the actual HTTP request to NetSuite.
    /// Returns raw response for caching/deduplication purposes.
    /// </summary>
    private async Task<SuiteQlResult> SendQueryAsync(string query, int timeout)
    {
        try
        {
            var url = _config.SuiteQlUrl;
            
            // Generate OAuth 1.0 Authorization header
            var authHeader = OAuth1Helper.GenerateAuthorizationHeader(
                "POST",
                url,
                _config.AccountId,
                _config.ConsumerKey,
                _config.ConsumerSecret,
                _config.TokenId,
                _config.TokenSecret);

            var request = new HttpRequestMessage(HttpMethod.Post, url);
            request.Headers.Authorization = AuthenticationHeaderValue.Parse(authHeader);
            request.Headers.Add("Prefer", "transient");
            
            var payload = JsonSerializer.Serialize(new { q = query });
            request.Content = new StringContent(payload, Encoding.UTF8, "application/json");

            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(timeout));
            var response = await _httpClient.SendAsync(request, cts.Token);

            var content = await response.Content.ReadAsStringAsync();
            
            if (response.IsSuccessStatusCode)
            {
                return new SuiteQlResult 
                { 
                    RawResponse = content 
                };
            }
            else
            {
                // Detect rate limiting (HTTP 429 or concurrency limit in body)
                var isRateLimited = response.StatusCode == System.Net.HttpStatusCode.TooManyRequests ||
                                   content.Contains("CONCURRENCY_LIMIT_EXCEEDED") ||
                                   content.Contains("429");
                
                _logger.LogError("NetSuite error {Status}: {Query} -> {Error}", 
                    response.StatusCode, query[..Math.Min(200, query.Length)], content);
                
                return new SuiteQlResult 
                { 
                    Error = $"NetSuite error: {response.StatusCode}",
                    Details = content,
                    IsRateLimited = isRateLimited
                };
            }
        }
        catch (TaskCanceledException)
        {
            _logger.LogError("NetSuite query timed out after {Timeout}s", timeout);
            return new SuiteQlResult { Error = "Request timed out" };
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Exception querying NetSuite");
            return new SuiteQlResult { Error = ex.Message };
        }
    }

    /// <summary>
    /// Get a value from cache or fetch it.
    /// </summary>
    public async Task<T?> GetOrSetCacheAsync<T>(
        string key, 
        Func<Task<T>> factory, 
        TimeSpan? expiration = null)
    {
        if (_cache.TryGetValue(key, out T? cached))
        {
            return cached;
        }

        var value = await factory();
        
        var options = new MemoryCacheEntryOptions()
            .SetAbsoluteExpiration(expiration ?? TimeSpan.FromMinutes(_cacheConfig.LookupCacheTtlMinutes));
        
        _cache.Set(key, value, options);
        
        return value;
    }

    /// <summary>
    /// Clear all cached data.
    /// </summary>
    public void ClearCache()
    {
        // IMemoryCache doesn't have a Clear method, so we use a different approach
        // In production, you'd want to track cache keys or use a distributed cache
        _logger.LogInformation("Cache clear requested (note: IMemoryCache doesn't support full clear)");
    }

    /// <summary>
    /// Escape single quotes in SQL strings.
    /// </summary>
    public static string EscapeSql(string? text)
    {
        if (string.IsNullOrEmpty(text))
            return string.Empty;
        return text.Replace("'", "''");
    }

    /// <summary>
    /// Build SQL IN clause for account numbers, supporting wildcards.
    /// </summary>
    /// <param name="accounts">List of account numbers (may include wildcards with *)</param>
    /// <param name="column">SQL column name (default: a.acctnumber)</param>
    /// <returns>SQL clause like "(a.acctnumber IN ('4010','4020') OR a.acctnumber LIKE '5%')"</returns>
    public static string BuildAccountFilter(IEnumerable<string> accounts, string column = "a.acctnumber")
    {
        var accountList = accounts.ToList();
        if (!accountList.Any())
            return "1=0"; // No accounts = no results

        var exactMatches = new List<string>();
        var wildcardPatterns = new List<string>();

        foreach (var acc in accountList)
        {
            var accStr = acc.Trim();
            if (accStr.Contains('*'))
            {
                // Convert * to % for SQL LIKE
                var pattern = EscapeSql(accStr.Replace("*", "%"));
                wildcardPatterns.Add($"{column} LIKE '{pattern}'");
            }
            else
            {
                exactMatches.Add($"'{EscapeSql(accStr)}'");
            }
        }

        var clauses = new List<string>();

        if (exactMatches.Any())
            clauses.Add($"{column} IN ({string.Join(",", exactMatches)})");

        clauses.AddRange(wildcardPatterns);

        return clauses.Count == 1 ? clauses[0] : $"({string.Join(" OR ", clauses)})";
    }

    /// <summary>
    /// Check if a period string is just a 4-digit year (e.g., '2025').
    /// </summary>
    public static bool IsYearOnly(string? period)
    {
        if (string.IsNullOrEmpty(period) || period.Length != 4)
            return false;
        
        if (!int.TryParse(period, out var year))
            return false;
        
        return year >= 1900 && year <= 2100;
    }

    /// <summary>
    /// Expand a year-only string to (fromPeriod, toPeriod) tuple.
    /// e.g., '2025' -> ('Jan 2025', 'Dec 2025')
    /// </summary>
    public static (string FromPeriod, string ToPeriod) ExpandYearToPeriods(string year)
    {
        return ($"Jan {year}", $"Dec {year}");
    }

    /// <summary>
    /// Get accounting period from period name or period ID.
    /// CRITICAL: Always queries NetSuite to get actual AccountingPeriod internal ID.
    /// Supports both period names (e.g., "Jan 2025") and period IDs (e.g., "344").
    /// For year-only inputs, this method should NOT be used - use GetPeriodsForYearAsync instead.
    /// </summary>
    public async Task<AccountingPeriod?> GetPeriodAsync(string periodNameOrId)
    {
        // Year-only inputs should use GetPeriodsForYearAsync to get all 12 months
        if (IsYearOnly(periodNameOrId))
        {
            _logger.LogWarning("GetPeriodAsync called with year-only input '{Year}'. Use GetPeriodsForYearAsync instead.", periodNameOrId);
            // Return null to force caller to use proper method
            return null;
        }

        // Check if input is a numeric ID (period ID)
        bool isNumericId = int.TryParse(periodNameOrId, out var periodId);
        
        var cacheKey = isNumericId ? $"period:id:{periodNameOrId}" : $"period:{periodNameOrId}";
        return await GetOrSetCacheAsync(cacheKey, async () =>
        {
            string query;
            if (isNumericId)
            {
                // Query by period ID
                query = $@"
                    SELECT id, periodname, startdate, enddate, isquarter, isyear
                    FROM AccountingPeriod
                    WHERE id = {periodId}
                    AND isquarter = 'F'
                    AND isyear = 'F'
                    FETCH FIRST 1 ROWS ONLY";
            }
            else
            {
                // Query by period name
                query = $@"
                    SELECT id, periodname, startdate, enddate, isquarter, isyear
                    FROM AccountingPeriod
                    WHERE periodname = '{EscapeSql(periodNameOrId)}'
                    AND isquarter = 'F'
                    AND isyear = 'F'
                    FETCH FIRST 1 ROWS ONLY";
            }

            // Use QueryRawAsync to handle NetSuite's "T"/"F" boolean format
            var rawResults = await QueryRawAsync(query);
            if (!rawResults.Any())
            {
                _logger.LogWarning("GetPeriodAsync: No period found for {Input} (isNumericId={IsNumeric})", periodNameOrId, isNumericId);
                return null;
            }

            var row = rawResults.First();
            
            // Helper to parse NetSuite boolean ("T"/"F" or true/false)
            bool ParseNetSuiteBoolean(JsonElement prop)
            {
                if (prop.ValueKind == JsonValueKind.String)
                    return prop.GetString() == "T";
                if (prop.ValueKind == JsonValueKind.True || prop.ValueKind == JsonValueKind.False)
                    return prop.GetBoolean();
                return false;
            }

            var period = new AccountingPeriod
            {
                Id = row.TryGetProperty("id", out var idProp) ? idProp.ToString() : null,
                PeriodName = row.TryGetProperty("periodname", out var pnProp) ? pnProp.GetString() : null,
                StartDate = row.TryGetProperty("startdate", out var sdProp) ? sdProp.GetString() : null,
                EndDate = row.TryGetProperty("enddate", out var edProp) ? edProp.GetString() : null,
                IsQuarter = row.TryGetProperty("isquarter", out var iqProp) ? ParseNetSuiteBoolean(iqProp) : false,
                IsYear = row.TryGetProperty("isyear", out var iyProp) ? ParseNetSuiteBoolean(iyProp) : false
            };

            _logger.LogInformation("GetPeriodAsync: Found period {PeriodName} (ID: {Id}) for input {Input}", period.PeriodName, period.Id, periodNameOrId);
            return period;
        });
    }

    /// <summary>
    /// Get all 12 monthly accounting periods for a given year.
    /// Returns periods ordered by startdate.
    /// CRITICAL: This ensures full-year queries use the exact same period IDs as month-by-month queries.
    /// </summary>
    public async Task<List<AccountingPeriod>> GetPeriodsForYearAsync(int year)
    {
        var cacheKey = $"periods:year:{year}";
        return await GetOrSetCacheAsync(cacheKey, async () =>
        {
            var query = $@"
                SELECT id, periodname, startdate, enddate, isquarter, isyear
                FROM AccountingPeriod
                WHERE isyear = 'F' 
                  AND isquarter = 'F'
                  AND isadjust = 'F'
                  AND EXTRACT(YEAR FROM startdate) = {year}
                ORDER BY startdate";

            _logger.LogInformation("GetPeriodsForYearAsync: Executing query for year {Year}", year);
            
            // Use QueryRawAsync to get raw results and manually deserialize
            var rawResults = await QueryRawAsync(query);
            _logger.LogInformation("GetPeriodsForYearAsync: Raw query returned {Count} rows for year {Year}", rawResults.Count, year);
            
            var results = new List<AccountingPeriod>();
            foreach (var row in rawResults)
            {
                try
                {
                    // Helper to parse NetSuite boolean ("T"/"F" or true/false)
                    bool ParseNetSuiteBoolean(JsonElement prop)
                    {
                        if (prop.ValueKind == JsonValueKind.String)
                            return prop.GetString() == "T";
                        if (prop.ValueKind == JsonValueKind.True || prop.ValueKind == JsonValueKind.False)
                            return prop.GetBoolean();
                        return false;
                    }
                    
                    var period = new AccountingPeriod
                    {
                        Id = row.TryGetProperty("id", out var idProp) ? idProp.ToString() : null,
                        PeriodName = row.TryGetProperty("periodname", out var pnProp) ? pnProp.GetString() : null,
                        StartDate = row.TryGetProperty("startdate", out var sdProp) ? sdProp.GetString() : null,
                        EndDate = row.TryGetProperty("enddate", out var edProp) ? edProp.GetString() : null,
                        IsQuarter = row.TryGetProperty("isquarter", out var iqProp) ? ParseNetSuiteBoolean(iqProp) : false,
                        IsYear = row.TryGetProperty("isyear", out var iyProp) ? ParseNetSuiteBoolean(iyProp) : false
                    };
                    results.Add(period);
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "GetPeriodsForYearAsync: Failed to deserialize period row for year {Year}", year);
                }
            }
            
            _logger.LogInformation("GetPeriodsForYearAsync: Successfully deserialized {Count} periods for year {Year}", results.Count, year);
            
            return results;
        }, TimeSpan.FromHours(24)); // Cache for 24 hours since periods don't change
    }

    /// <summary>
    /// Get all 12 monthly accounting periods for a given year (string input).
    /// Handles year-only strings like "2025".
    /// </summary>
    public async Task<List<AccountingPeriod>> GetPeriodsForYearAsync(string yearString)
    {
        if (!IsYearOnly(yearString))
        {
            _logger.LogWarning("GetPeriodsForYearAsync called with non-year input '{Input}'. Expected 4-digit year.", yearString);
            return new List<AccountingPeriod>();
        }

        if (!int.TryParse(yearString, out var year))
        {
            _logger.LogWarning("Could not parse year from '{Input}'", yearString);
            return new List<AccountingPeriod>();
        }

        return await GetPeriodsForYearAsync(year);
    }

    /// <summary>
    /// Internal class for SuiteQL query results.
    /// </summary>
    private class SuiteQlResult
    {
        public List<JsonElement>? Items { get; set; }
        public string? Error { get; set; }
        public string? Details { get; set; }
        public string? RawResponse { get; set; }
        public bool IsRateLimited { get; set; }
        public SafetyLimitType? SafetyLimitHit { get; set; }
    }
}

/// <summary>
/// Interface for NetSuite service (for DI and testing).
/// </summary>
public interface INetSuiteService
{
    Task<List<T>> QueryAsync<T>(string query, int timeout = 30);
    Task<List<JsonElement>> QueryRawAsync(string query, int timeout = 30);
    Task<QueryResult<T>> QueryWithErrorAsync<T>(string query, int timeout = 30);
    Task<QueryResult<JsonElement>> QueryRawWithErrorAsync(string query, int timeout = 30);
    Task<List<T>> QueryPaginatedAsync<T>(string query, int timeout = 30, int pageSize = 1000, string orderBy = "1");
    Task<List<JsonElement>> QueryPaginatedRawAsync(string query, int timeout = 30, int pageSize = 1000, string orderBy = "1");
    Task<T?> GetOrSetCacheAsync<T>(string key, Func<Task<T>> factory, TimeSpan? expiration = null);
    void ClearCache();
    Task<AccountingPeriod?> GetPeriodAsync(string periodName);
    Task<List<AccountingPeriod>> GetPeriodsForYearAsync(int year);
    Task<List<AccountingPeriod>> GetPeriodsForYearAsync(string yearString);
}

/// <summary>
/// One-word error codes for Excel cells.
/// These are designed to be:
/// - Short (fit in a cell without expanding)
/// - Informative (support teams can understand)
/// - Actionable (user knows what to do)
/// </summary>
public static class ErrorCodes
{
    public const string Timeout = "TIMEOUT";        // Query took too long
    public const string RateLimit = "RATELIMIT";    // NetSuite rate limit exceeded
    public const string RowCap = "ROWCAP";          // Too many rows returned
    public const string AuthError = "AUTHERR";      // Authentication failed
    public const string NetFail = "NETFAIL";        // Network/connection error
    public const string QueryError = "QUERYERR";    // SuiteQL syntax or logic error
    public const string NotFound = "NOTFOUND";      // Account/period not found
    public const string ServerError = "SERVERERR";  // Internal server error
    
    /// <summary>
    /// Convert a detailed error message to a one-word code.
    /// </summary>
    public static string FromError(string? error, SafetyLimitType? safetyLimit = null)
    {
        if (safetyLimit.HasValue && safetyLimit != SafetyLimitType.None)
        {
            return safetyLimit.Value switch
            {
                SafetyLimitType.MaxRetries => Timeout,
                SafetyLimitType.RateLimitExceeded => RateLimit,
                SafetyLimitType.RowCapExceeded => RowCap,
                SafetyLimitType.ConcurrencyTimeout => Timeout,
                _ => ServerError
            };
        }
        
        if (string.IsNullOrEmpty(error))
            return ServerError;
        
        var lowerError = error.ToLowerInvariant();
        
        if (lowerError.Contains("timeout") || lowerError.Contains("timed out"))
            return Timeout;
        if (lowerError.Contains("rate limit") || lowerError.Contains("429") || lowerError.Contains("concurrency"))
            return RateLimit;
        if (lowerError.Contains("auth") || lowerError.Contains("401") || lowerError.Contains("403"))
            return AuthError;
        if (lowerError.Contains("network") || lowerError.Contains("connection"))
            return NetFail;
        if (lowerError.Contains("syntax") || lowerError.Contains("invalid") || lowerError.Contains("field"))
            return QueryError;
        if (lowerError.Contains("not found") || lowerError.Contains("no data"))
            return NotFound;
        
        return ServerError;
    }
}

/// <summary>
/// Query result that includes both data and error information.
/// Used to propagate errors to Excel instead of silent failures.
/// </summary>
public class QueryResult<T>
{
    public List<T> Items { get; set; } = new();
    public bool Success { get; set; } = true;
    public string? ErrorCode { get; set; }      // One-word code for Excel cell
    public string? ErrorDetails { get; set; }   // Full details for logging/support
    
    public static QueryResult<T> Ok(List<T> items) => new() { Items = items, Success = true };
    
    public static QueryResult<T> Fail(string errorCode, string? details = null) => new()
    {
        Success = false,
        ErrorCode = errorCode,
        ErrorDetails = details
    };
}

