/*
 * XAVI for NetSuite - Type Balance Controller
 *
 * Copyright (c) 2025 Celigo, Inc.
 * All rights reserved.
 */

using Microsoft.AspNetCore.Mvc;
using System.Text.Json;
using XaviApi.Models;
using XaviApi.Services;

namespace XaviApi.Controllers;

/// <summary>
/// Controller for type balance queries (aggregated by account type).
/// </summary>
[ApiController]
public class TypeBalanceController : ControllerBase
{
    private readonly IBalanceService _balanceService;
    private readonly INetSuiteService _netSuiteService;
    private readonly ILookupService _lookupService;
    private readonly ILogger<TypeBalanceController> _logger;
    
    private const int DefaultAccountingBook = 1;

    public TypeBalanceController(
        IBalanceService balanceService, 
        INetSuiteService netSuiteService,
        ILookupService lookupService,
        ILogger<TypeBalanceController> logger)
    {
        _balanceService = balanceService;
        _netSuiteService = netSuiteService;
        _lookupService = lookupService;
        _logger = logger;
    }

    /// <summary>
    /// Calculate balance for a specific Account Type.
    /// </summary>
    /// <remarks>
    /// Supported types: Income, Expense, COGS, Asset, Liability, Equity, OthIncome, OthExpense
    /// </remarks>
    [HttpPost("/type-balance")]
    public async Task<IActionResult> GetTypeBalance([FromBody] TypeBalanceRequest request)
    {
        if (string.IsNullOrEmpty(request.AccountType))
            return BadRequest(new { error = "account_type is required" });

        // Check if this is a Balance Sheet type (BS types don't need fromPeriod)
        var isBalanceSheet = Models.AccountType.BsTypes.Any(bt => 
            request.AccountType.Equals(bt, StringComparison.OrdinalIgnoreCase)) ||
            request.AccountType.Equals("Asset", StringComparison.OrdinalIgnoreCase) ||
            request.AccountType.Equals("Liability", StringComparison.OrdinalIgnoreCase) ||
            request.AccountType.Equals("Equity", StringComparison.OrdinalIgnoreCase);

        // Only require fromPeriod for P&L types
        if (!isBalanceSheet && string.IsNullOrEmpty(request.FromPeriod))
            return BadRequest(new { error = "from_period is required for P&L account types" });

        if (string.IsNullOrEmpty(request.ToPeriod))
            return BadRequest(new { error = "to_period is required" });

        try
        {
            var result = await _balanceService.GetTypeBalanceAsync(request);
            return Ok(result);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting type balance for {Type}", request.AccountType);
            return StatusCode(500, new { error = ex.Message });
        }
    }

    /// <summary>
    /// Batch refresh type balances for a full year using ONE optimized query.
    /// Instead of 60 API calls (5 types × 12 months), makes just 1 query.
    /// </summary>
    [HttpPost("/batch/typebalance_refresh")]
    public async Task<IActionResult> BatchTypeBalanceRefresh([FromBody] TypeBalanceRefreshRequest request)
    {
        var startTime = DateTime.UtcNow;
        
        try
        {
            var fiscalYear = request.Year > 0 ? request.Year : DateTime.Now.Year;
            var accountingBook = request.Book ?? DefaultAccountingBook;

            _logger.LogInformation("=== BATCH TYPEBALANCE REFRESH: Year {Year} ===", fiscalYear);

            // Resolve subsidiary name to ID and get hierarchy
            var subsidiaryId = await _lookupService.ResolveSubsidiaryIdAsync(request.Subsidiary);
            var targetSub = subsidiaryId ?? "1"; // Default to root subsidiary
            
            // Get subsidiary hierarchy (all children for consolidated view)
            var hierarchySubs = await _lookupService.GetSubsidiaryHierarchyAsync(targetSub);
            var subFilter = string.Join(", ", hierarchySubs);

            _logger.LogDebug("Subsidiary: '{Sub}' → ID {Id}, hierarchy: {Hierarchy}", 
                request.Subsidiary, targetSub, subFilter);

            // Resolve other dimensions
            var departmentId = await _lookupService.ResolveDimensionIdAsync("department", request.Department);
            var classId = await _lookupService.ResolveDimensionIdAsync("class", request.Class);
            var locationId = await _lookupService.ResolveDimensionIdAsync("location", request.Location);

            // Build segment filters
            var segmentFilters = new List<string> { $"tl.subsidiary IN ({subFilter})" };
            if (!string.IsNullOrEmpty(departmentId))
                segmentFilters.Add($"tl.department = {departmentId}");
            if (!string.IsNullOrEmpty(classId))
                segmentFilters.Add($"tl.class = {classId}");
            if (!string.IsNullOrEmpty(locationId))
                segmentFilters.Add($"tl.location = {locationId}");
            var segmentWhere = string.Join(" AND ", segmentFilters);

            // Get fiscal year periods using shared period resolver (not calendar inference)
            var yearPeriods = await _netSuiteService.GetPeriodsForYearAsync(fiscalYear);
            if (!yearPeriods.Any())
            {
                return BadRequest(new { error = $"No periods found for year {fiscalYear}" });
            }

            _logger.LogDebug("Found {Count} periods for FY {Year}", yearPeriods.Count, fiscalYear);
            
            // Convert AccountingPeriod objects to JsonElement format for compatibility
            var periods = yearPeriods.Select(p => {
                var dict = new Dictionary<string, object>();
                dict["id"] = p.Id ?? "";
                dict["periodname"] = p.PeriodName ?? "";
                dict["startdate"] = p.StartDate ?? "";
                dict["enddate"] = p.EndDate ?? "";
                return System.Text.Json.JsonSerializer.SerializeToElement(dict);
            }).ToList();

            // Build the optimized batch query - ONE query gets ALL types × ALL months
            // Using CASE WHEN to pivot by account type and period
            var incomeTypesSql = "'Income', 'OthIncome'";
            
            // Build month columns dynamically based on actual periods
            var monthCases = new List<string>();
            foreach (var period in periods)
            {
                var periodId = period.TryGetProperty("id", out var idProp) ? idProp.ToString() : "";
                var periodName = period.TryGetProperty("periodname", out var nameProp) ? nameProp.GetString() ?? "" : "";
                
                if (string.IsNullOrEmpty(periodId) || string.IsNullOrEmpty(periodName))
                    continue;

                // Extract month abbreviation (e.g., "Jan 2025" -> "jan")
                var monthAbbr = periodName.Split(' ').FirstOrDefault()?.ToLower() ?? "";
                if (string.IsNullOrEmpty(monthAbbr))
                    continue;

                // Handle 'dec' specially since it might be reserved
                var colName = monthAbbr == "dec" ? "dec_month" : monthAbbr;
                
                monthCases.Add($@"
                    SUM(CASE WHEN t.postingperiod = {periodId} THEN 
                        TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', {targetSub}, t.postingperiod, 'DEFAULT'))
                        * CASE WHEN a.accttype IN ({incomeTypesSql}) THEN -1 ELSE 1 END
                    ELSE 0 END) AS {colName}");
            }

            if (!monthCases.Any())
            {
                return BadRequest(new { error = "No valid periods found" });
            }

            var monthColumns = string.Join(",\n", monthCases);

            // Get all period IDs for the filter
            var periodIds = periods
                .Select(p => p.TryGetProperty("id", out var idProp) ? idProp.ToString() : "")
                .Where(id => !string.IsNullOrEmpty(id))
                .ToList();
            var periodFilter = string.Join(", ", periodIds);

            // Build the main query - pivots by account type
            var query = $@"
                SELECT 
                    a.accttype AS account_type,
                    {monthColumns}
                FROM transactionaccountingline tal
                JOIN transaction t ON t.id = tal.transaction
                JOIN account a ON a.id = tal.account
                JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
                WHERE t.posting = 'T'
                  AND tal.posting = 'T'
                  AND a.accttype IN ('Income', 'COGS', 'Expense', 'OthIncome', 'OthExpense')
                  AND a.isinactive = 'F'
                  AND t.postingperiod IN ({periodFilter})
                  AND tal.accountingbook = {accountingBook}
                  AND {segmentWhere}
                GROUP BY a.accttype
                ORDER BY a.accttype";

            _logger.LogDebug("Executing batch query...");

            var result = await _netSuiteService.QueryRawWithErrorAsync(query);
            
            // Check for query errors - fail loudly instead of returning empty results
            if (!result.Success)
            {
                _logger.LogError("Batch Type Balance Refresh: Query failed with {ErrorCode}: {ErrorDetails}", 
                    result.ErrorCode, result.ErrorDetails);
                return StatusCode(500, new { 
                    error = "Failed to fetch type balances", 
                    errorCode = result.ErrorCode,
                    errorDetails = result.ErrorDetails 
                });
            }

            var rows = result.Items;
            var elapsed = (DateTime.UtcNow - startTime).TotalSeconds;
            _logger.LogDebug("Query time: {Elapsed:F2} seconds, {Count} account type rows", elapsed, rows.Count);

            // Build month column mapping dynamically from actual periods (not hardcoded)
            // This ensures period names match exactly between query columns and result mapping
            var monthMapping = new Dictionary<string, string>();
            foreach (var period in periods)
            {
                var periodId = period.TryGetProperty("id", out var idProp) ? idProp.ToString() : "";
                var periodName = period.TryGetProperty("periodname", out var nameProp) ? nameProp.GetString() ?? "" : "";
                
                if (string.IsNullOrEmpty(periodId) || string.IsNullOrEmpty(periodName))
                    continue;

                // Extract month abbreviation (e.g., "Jan 2025" -> "jan")
                var monthAbbr = periodName.Split(' ').FirstOrDefault()?.ToLower() ?? "";
                if (string.IsNullOrEmpty(monthAbbr))
                    continue;

                // Handle 'dec' specially since it might be reserved
                var colName = monthAbbr == "dec" ? "dec_month" : monthAbbr;
                monthMapping[colName] = periodName; // Use actual period name from NetSuite
            }

            // Transform results to nested dict: { accountType: { period: value } }
            var balances = new Dictionary<string, Dictionary<string, decimal>>();
            var plTypes = new[] { "Income", "COGS", "Expense", "OthIncome", "OthExpense" };

            foreach (var row in rows)
            {
                var acctType = row.TryGetProperty("account_type", out var typeProp) ? typeProp.GetString() ?? "" : "";
                if (string.IsNullOrEmpty(acctType))
                    continue;

                balances[acctType] = new Dictionary<string, decimal>();

                foreach (var (colName, periodName) in monthMapping)
                {
                    decimal amount = 0;
                    if (row.TryGetProperty(colName, out var amountProp) && amountProp.ValueKind != JsonValueKind.Null)
                    {
                        if (amountProp.ValueKind == JsonValueKind.String)
                            decimal.TryParse(amountProp.GetString(), out amount);
                        else if (amountProp.ValueKind == JsonValueKind.Number)
                            amount = amountProp.GetDecimal();
                    }
                    balances[acctType][periodName] = amount;
                }

                // Log sample for debugging
                if (balances.Count <= 3)
                {
                    var sampleMonth = $"Jan {fiscalYear}";
                    var sampleVal = balances[acctType].GetValueOrDefault(sampleMonth, 0);
                    _logger.LogDebug("{Type}: {Month} = ${Value:N2}", acctType, sampleMonth, sampleVal);
                }
            }

            // For any P&L types not in results (no activity), add zeros
            foreach (var ptype in plTypes)
            {
                if (!balances.ContainsKey(ptype))
                {
                    balances[ptype] = monthMapping.Values.ToDictionary(p => p, p => 0m);
                }
            }

            _logger.LogInformation("Returning {Count} account types × 12 months in {Elapsed:F2}s", balances.Count, elapsed);

            return Ok(new
            {
                balances = balances,
                year = fiscalYear,
                elapsed_seconds = elapsed,
                types_loaded = balances.Count,
                subsidiary = request.Subsidiary
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in batch typebalance refresh");
            return StatusCode(500, new { error = ex.Message });
        }
    }
}

/// <summary>
/// Request for batch type balance refresh.
/// </summary>
public class TypeBalanceRefreshRequest
{
    [System.Text.Json.Serialization.JsonPropertyName("year")]
    public int Year { get; set; }
    
    [System.Text.Json.Serialization.JsonPropertyName("subsidiary")]
    public string? Subsidiary { get; set; }
    
    [System.Text.Json.Serialization.JsonPropertyName("department")]
    public string? Department { get; set; }
    
    [System.Text.Json.Serialization.JsonPropertyName("class")]
    public string? Class { get; set; }
    
    [System.Text.Json.Serialization.JsonPropertyName("location")]
    public string? Location { get; set; }
    
    [System.Text.Json.Serialization.JsonPropertyName("accountingBook")]
    public int? Book { get; set; }
}

