/*
 * XAVI for NetSuite - Health Controller
 *
 * Copyright (c) 2025 Celigo, Inc.
 * All rights reserved.
 */

using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;
using XaviApi.Configuration;
using XaviApi.Services;

namespace XaviApi.Controllers;

/// <summary>
/// Health check and status endpoints.
/// </summary>
[ApiController]
public class HealthController : ControllerBase
{
    private readonly NetSuiteConfig _config;
    private readonly INetSuiteGovernor _governor;
    private const string Version = "3.0.5.234"; // Updated for performance hardening

    public HealthController(IOptions<NetSuiteConfig> config, INetSuiteGovernor governor)
    {
        _config = config.Value;
        _governor = governor;
    }

    /// <summary>
    /// Home/root endpoint with version and feature info.
    /// </summary>
    [HttpGet("/")]
    public IActionResult Home()
    {
        return Ok(new
        {
            service = "XAVI for NetSuite - .NET Backend",
            version = Version,
            status = "online",
            account = _config.AccountId,
            features = new
            {
                multi_book_accounting = true,
                consolidation = true,
                subsidiaries = true,
                departments = true,
                classes = true,
                locations = true,
                budgets = true
            },
            endpoints = new[]
            {
                "GET /health",
                "GET /balance",
                "POST /type-balance",
                "POST /batch/balance",
                "POST /batch/full_year_refresh",
                "GET /lookups/all",
                "GET /budget",
                "POST /batch/budget"
            }
        });
    }

    /// <summary>
    /// Health check endpoint.
    /// </summary>
    [HttpGet("/health")]
    public IActionResult Health()
    {
        var metrics = _governor.GetMetrics();
        
        return Ok(new
        {
            status = "healthy",
            account = _config.AccountId,
            configured = _config.IsValid,
            governor = new
            {
                currentConcurrency = metrics.CurrentConcurrency,
                maxConcurrency = metrics.MaxConcurrency,
                inFlight = metrics.InFlightRequests,
                isThrottled = metrics.IsInBackoff
            }
        });
    }
    
    /// <summary>
    /// Detailed governor metrics endpoint.
    /// Shows request statistics, deduplication rate, and throttling status.
    /// 
    /// INVARIANT: safetyLimitHits > 0 should be investigated - these are explicit failures.
    /// See docs/PERFORMANCE-INVARIANTS.md for details.
    /// </summary>
    [HttpGet("/metrics")]
    public IActionResult Metrics()
    {
        var metrics = _governor.GetMetrics();
        
        return Ok(new
        {
            governor = new
            {
                totalRequests = metrics.TotalRequests,
                deduplicatedRequests = metrics.DeduplicatedRequests,
                deduplicationRate = $"{metrics.DeduplicationRate:F1}%",
                rateLimitErrors = metrics.RateLimitErrors,
                retriedRequests = metrics.RetriedRequests,
                safetyLimitHits = metrics.SafetyLimitHits, // Explicit failures - should be 0 normally
                currentConcurrency = metrics.CurrentConcurrency,
                maxConcurrency = metrics.MaxConcurrency,
                inFlightRequests = metrics.InFlightRequests,
                isInBackoff = metrics.IsInBackoff
            },
            safetyLimits = new
            {
                maxRowCap = 100000,
                maxRetries = 3,
                description = "Safety limits fail loudly with explicit error messages. " +
                              "safetyLimitHits > 0 indicates an explicit failure occurred."
            },
            info = new
            {
                description = "NetSuite request governor for Excel-scale workloads",
                features = new[]
                {
                    "Concurrency limiting (max 3 concurrent requests)",
                    "Request deduplication (collapse identical drag-fill queries)",
                    "Exponential backoff on rate limits",
                    "Sequential pagination (no parallel page fetching)",
                    "Loud safety limit failures (never silent truncation)"
                },
                documentation = "See docs/PERFORMANCE-INVARIANTS.md for system invariants"
            }
        });
    }

    /// <summary>
    /// Test NetSuite connection.
    /// </summary>
    [HttpGet("/test")]
    public async Task<IActionResult> TestConnection([FromServices] Services.INetSuiteService netSuiteService)
    {
        try
        {
            var results = await netSuiteService.QueryAsync<dynamic>("SELECT 1 as test FROM DUAL");
            return Ok(new
            {
                status = "success",
                message = "NetSuite connection successful",
                account = _config.AccountId
            });
        }
        catch (Exception ex)
        {
            return StatusCode(500, new
            {
                status = "error",
                message = ex.Message
            });
        }
    }
    
    /// <summary>
    /// Check NetSuite permissions and features.
    /// Returns account info, feature availability, and table permissions.
    /// </summary>
    [HttpGet("/check-permissions")]
    public async Task<IActionResult> CheckPermissions([FromServices] Services.INetSuiteService netSuiteService)
    {
        try
        {
            var checks = new List<object>();
            var subsidiaries = new List<object>();
            
            // Test basic connection
            try
            {
                await netSuiteService.QueryAsync<dynamic>("SELECT 1 as test FROM DUAL");
            }
            catch (Exception ex)
            {
                return StatusCode(500, new
                {
                    status = "error",
                    message = $"NetSuite connection failed: {ex.Message}",
                    account_id = _config.AccountId
                });
            }
            
            // Check Budgets table
            try
            {
                var budgetQuery = "SELECT COUNT(*) as count FROM budget WHERE isinactive = 'F'";
                var budgetResults = await netSuiteService.QueryAsync<dynamic>(budgetQuery);
                var budgetCount = budgetResults?.FirstOrDefault()?.count ?? 0;
                
                checks.Add(new
                {
                    table = "Budgets",
                    name = "Budgets",
                    enabled = budgetCount > 0,
                    accessible = true,
                    query_result = new { count = budgetCount }
                });
            }
            catch (Exception ex)
            {
                checks.Add(new
                {
                    table = "Budgets",
                    name = "Budgets",
                    enabled = false,
                    accessible = false,
                    error = ex.Message
                });
            }
            
            // Check Subsidiary table and get list
            try
            {
                var subQuery = "SELECT id, name, iselimination FROM subsidiary WHERE isinactive = 'F' ORDER BY name";
                var subResults = await netSuiteService.QueryAsync<dynamic>(subQuery);
                
                foreach (var sub in subResults ?? Enumerable.Empty<dynamic>())
                {
                    subsidiaries.Add(new
                    {
                        id = sub.id,
                        name = sub.name,
                        isElimination = sub.iselimination == "T"
                    });
                }
                
                checks.Add(new
                {
                    table = "Subsidiary",
                    name = "OneWorld Subsidiaries",
                    enabled = subsidiaries.Count > 0,
                    accessible = true,
                    query_result = subsidiaries
                });
            }
            catch (Exception ex)
            {
                checks.Add(new
                {
                    table = "Subsidiary",
                    name = "OneWorld Subsidiaries",
                    enabled = false,
                    accessible = false,
                    error = ex.Message
                });
            }
            
            // Check other required tables
            var requiredTables = new[]
            {
                new { Table = "Account", Name = "Accounts", Required = true },
                new { Table = "Transaction", Name = "Transactions", Required = true },
                new { Table = "TransactionLine", Name = "Transaction Lines", Required = true },
                new { Table = "AccountingPeriod", Name = "Accounting Periods", Required = true },
                new { Table = "Department", Name = "Departments", Required = false },
                new { Table = "Location", Name = "Locations", Required = false },
                new { Table = "Class", Name = "Classes", Required = false }
            };
            
            foreach (var tableInfo in requiredTables)
            {
                try
                {
                    // Test table access with a simple query
                    var testQuery = $"SELECT id FROM {tableInfo.Table} FETCH FIRST 1 ROWS ONLY";
                    await netSuiteService.QueryAsync<dynamic>(testQuery);
                    
                    checks.Add(new
                    {
                        table = tableInfo.Table,
                        name = tableInfo.Name,
                        enabled = true,
                        accessible = true,
                        required = tableInfo.Required
                    });
                }
                catch (Exception ex)
                {
                    checks.Add(new
                    {
                        table = tableInfo.Table,
                        name = tableInfo.Name,
                        enabled = false,
                        accessible = false,
                        required = tableInfo.Required,
                        error = ex.Message
                    });
                }
            }
            
            // Determine overall status
            var allRequiredAccessible = checks
                .Where(c => ((dynamic)c).required == true)
                .All(c => ((dynamic)c).accessible == true);
            
            var status = allRequiredAccessible ? "success" : "warning";
            var message = allRequiredAccessible 
                ? "NetSuite connection successful. All required permissions verified."
                : "NetSuite connection successful, but some permissions may be limited.";
            
            return Ok(new
            {
                status = status,
                message = message,
                account_id = _config.AccountId,
                checks = checks,
                subsidiaries = subsidiaries
            });
        }
        catch (Exception ex)
        {
            return StatusCode(500, new
            {
                status = "error",
                message = ex.Message,
                account_id = _config.AccountId
            });
        }
    }
    
    /// <summary>
    /// Debug endpoint to run raw SuiteQL queries with full response details.
    /// This version does NOT use the typed HttpClient - it creates a fresh one.
    /// </summary>
    [HttpPost("/test/query")]
    public async Task<IActionResult> TestQuery([FromBody] QueryRequest request)
    {
        try
        {
            using var httpClient = new HttpClient();
            httpClient.Timeout = TimeSpan.FromSeconds(request.Timeout ?? 120);
            
            var url = $"https://{_config.AccountId}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql";
            var authHeader = Services.OAuth1Helper.GenerateAuthorizationHeader(
                "POST", url,
                _config.AccountId, _config.ConsumerKey, _config.ConsumerSecret,
                _config.TokenId, _config.TokenSecret);
            
            var httpRequest = new HttpRequestMessage(HttpMethod.Post, url);
            httpRequest.Headers.Authorization = System.Net.Http.Headers.AuthenticationHeaderValue.Parse(authHeader);
            httpRequest.Headers.Add("Prefer", "transient");
            httpRequest.Content = new StringContent(
                System.Text.Json.JsonSerializer.Serialize(new { q = request.Q }),
                System.Text.Encoding.UTF8,
                "application/json");
            
            var response = await httpClient.SendAsync(httpRequest);
            var content = await response.Content.ReadAsStringAsync();
            
            if (response.IsSuccessStatusCode)
            {
                var json = System.Text.Json.JsonDocument.Parse(content);
                var items = json.RootElement.TryGetProperty("items", out var itemsElement)
                    ? itemsElement.EnumerateArray().ToList()
                    : new List<System.Text.Json.JsonElement>();
                    
                return Ok(new
                {
                    query = request.Q,
                    row_count = items.Count,
                    results = items
                });
            }
            else
            {
                return StatusCode((int)response.StatusCode, new
                {
                    query = request.Q,
                    error = content
                });
            }
        }
        catch (Exception ex)
        {
            return StatusCode(500, new
            {
                query = request.Q,
                error = ex.Message,
                stack = ex.StackTrace
            });
        }
    }
    
    /// <summary>
    /// Debug endpoint to run raw SuiteQL and see full HTTP response.
    /// </summary>
    [HttpPost("/test/raw")]
    public async Task<IActionResult> TestRawQuery([FromBody] QueryRequest request)
    {
        try
        {
            using var httpClient = new HttpClient();
            
            var url = $"https://{_config.AccountId}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql";
            var authHeader = Services.OAuth1Helper.GenerateAuthorizationHeader(
                "POST", url,
                _config.AccountId, _config.ConsumerKey, _config.ConsumerSecret,
                _config.TokenId, _config.TokenSecret);
            
            var httpRequest = new HttpRequestMessage(HttpMethod.Post, url);
            httpRequest.Headers.Authorization = System.Net.Http.Headers.AuthenticationHeaderValue.Parse(authHeader);
            httpRequest.Headers.Add("Prefer", "transient");
            httpRequest.Content = new StringContent(
                System.Text.Json.JsonSerializer.Serialize(new { q = request.Q }),
                System.Text.Encoding.UTF8,
                "application/json");
            
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(request.Timeout ?? 60));
            var response = await httpClient.SendAsync(httpRequest, cts.Token);
            var content = await response.Content.ReadAsStringAsync();
            
            return Ok(new
            {
                status_code = (int)response.StatusCode,
                query = request.Q,
                raw_response = content
            });
        }
        catch (Exception ex)
        {
            return StatusCode(500, new
            {
                query = request.Q,
                error = ex.Message
            });
        }
    }
}

public class QueryRequest
{
    public string Q { get; set; } = "";
    public int? Timeout { get; set; }
}

