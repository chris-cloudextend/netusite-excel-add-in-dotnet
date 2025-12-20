/*
 * XAVI for NetSuite - Balance Controller
 *
 * Copyright (c) 2025 Celigo, Inc.
 * All rights reserved.
 */

using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Caching.Memory;
using System.Text.Json;
using XaviApi.Models;
using XaviApi.Services;

namespace XaviApi.Controllers;

/// <summary>
/// Controller for GL balance queries.
/// </summary>
[ApiController]
public class BalanceController : ControllerBase
{
    private readonly IBalanceService _balanceService;
    private readonly INetSuiteService _netSuiteService;
    private readonly ILookupService _lookupService;
    private readonly IMemoryCache _cache;
    private readonly ILogger<BalanceController> _logger;
    
    private const int DefaultAccountingBook = 1;

    public BalanceController(
        IBalanceService balanceService, 
        INetSuiteService netSuiteService,
        ILookupService lookupService,
        IMemoryCache cache,
        ILogger<BalanceController> logger)
    {
        _balanceService = balanceService;
        _netSuiteService = netSuiteService;
        _lookupService = lookupService;
        _cache = cache;
        _logger = logger;
    }

    /// <summary>
    /// Get GL account balance with filters.
    /// For Balance Sheet accounts, from_period is optional - will return cumulative from inception.
    /// For P&L accounts, from_period defaults to to_period if not provided.
    /// </summary>
    /// <remarks>
    /// Examples:
    /// - BS cumulative: GET /balance?account=10034&amp;to_period=Jan%202025
    /// - P&L range: GET /balance?account=4010&amp;from_period=Jan%202025&amp;to_period=Mar%202025
    /// </remarks>
    [HttpGet("/balance")]
    public async Task<IActionResult> GetBalance(
        [FromQuery] string account,
        [FromQuery] string? from_period = null,
        [FromQuery] string? to_period = null,
        [FromQuery] string? subsidiary = null,
        [FromQuery] string? department = null,
        [FromQuery(Name = "class")] string? classFilter = null,
        [FromQuery] string? location = null,
        [FromQuery] int? book = null)
    {
        if (string.IsNullOrEmpty(account))
            return BadRequest(new { error = "Account number is required" });

        // Need at least one period for any query
        if (string.IsNullOrEmpty(from_period) && string.IsNullOrEmpty(to_period))
            return BadRequest(new { error = "At least one period (from_period or to_period) is required" });

        try
        {
            // For BS accounts, from_period can be empty (cumulative from inception)
            // For P&L accounts, from_period defaults to to_period if not provided
            var request = new BalanceRequest
            {
                Account = account,
                FromPeriod = from_period ?? "",
                ToPeriod = to_period ?? from_period ?? "",
                Subsidiary = subsidiary,
                Department = department,
                Class = classFilter,
                Location = location,
                Book = book
            };

            var result = await _balanceService.GetBalanceAsync(request);
            return Ok(result);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting balance for account {Account}", account);
            return StatusCode(500, new { error = ex.Message });
        }
    }

    /// <summary>
    /// Get balances for multiple accounts and periods in a single batch.
    /// </summary>
    [HttpPost("/batch/balance")]
    public async Task<IActionResult> BatchBalance([FromBody] BatchBalanceRequest request)
    {
        if (request.Accounts == null || !request.Accounts.Any())
            return BadRequest(new { error = "At least one account is required" });

        if (request.Periods == null || !request.Periods.Any())
            return BadRequest(new { error = "At least one period is required" });

        try
        {
            var result = await _balanceService.GetBatchBalanceAsync(request);
            return Ok(result);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting batch balances");
            return StatusCode(500, new { error = ex.Message });
        }
    }
    
    /// <summary>
    /// OPTIMIZED FULL-YEAR REFRESH - Get ALL P&L accounts for an entire fiscal year in ONE query.
    /// Uses pivoted query (one row per account, 12 month columns) for optimal performance.
    /// </summary>
    /// <remarks>
    /// Expected performance: less than 30 seconds for ALL accounts × 12 months.
    /// Used by Full Income Statement generator.
    /// </remarks>
    [HttpPost("/batch/full_year_refresh")]
    public async Task<IActionResult> FullYearRefresh([FromBody] FullYearRefreshRequest request)
    {
        var startTime = DateTime.UtcNow;
        
        try
        {
            var fiscalYear = request.Year > 0 ? request.Year : DateTime.Now.Year;
            var accountingBook = request.Book ?? DefaultAccountingBook;

            _logger.LogInformation("=== FULL YEAR REFRESH (OPTIMIZED PIVOTED QUERY): {Year} ===", fiscalYear);

            // Resolve subsidiary name to ID and get hierarchy
            var subsidiaryId = await _lookupService.ResolveSubsidiaryIdAsync(request.Subsidiary);
            var targetSub = subsidiaryId ?? "1";
            
            // Get subsidiary hierarchy (all children for consolidated view)
            var hierarchySubs = await _lookupService.GetSubsidiaryHierarchyAsync(targetSub);
            var subFilter = string.Join(", ", hierarchySubs);

            _logger.LogDebug("Target subsidiary: {Sub}, hierarchy: {Count} subsidiaries", targetSub, hierarchySubs.Count);

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

            // Get fiscal year periods
            var periodsQuery = $@"
                SELECT id, periodname, startdate, enddate
                FROM accountingperiod
                WHERE isyear = 'F' AND isquarter = 'F'
                  AND EXTRACT(YEAR FROM startdate) = {fiscalYear}
                  AND isadjust = 'F'
                ORDER BY startdate";
            
            var periods = await _netSuiteService.QueryRawAsync(periodsQuery);
            if (!periods.Any())
            {
                return BadRequest(new { error = $"No periods found for fiscal year {fiscalYear}" });
            }

            _logger.LogDebug("Found {Count} periods for FY {Year}", periods.Count, fiscalYear);

            // Build pivoted query - one row per account, 12 month columns
            var incomeTypesSql = "'Income', 'OthIncome'";
            
            // Build month columns dynamically
            var monthCases = new List<string>();
            foreach (var period in periods)
            {
                var periodId = period.TryGetProperty("id", out var idProp) ? idProp.ToString() : "";
                var periodName = period.TryGetProperty("periodname", out var nameProp) ? nameProp.GetString() ?? "" : "";
                
                if (string.IsNullOrEmpty(periodId) || string.IsNullOrEmpty(periodName))
                    continue;

                var monthAbbr = periodName.Split(' ').FirstOrDefault()?.ToLower() ?? "";
                if (string.IsNullOrEmpty(monthAbbr))
                    continue;

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

            // Get period IDs for filter
            var periodIds = periods
                .Select(p => p.TryGetProperty("id", out var idProp) ? idProp.ToString() : "")
                .Where(id => !string.IsNullOrEmpty(id))
                .ToList();
            var periodFilter = string.Join(", ", periodIds);

            // P&L account types only
            var plTypesSql = "'Income', 'COGS', 'Expense', 'OthIncome', 'OthExpense'";

            // Build the main query - one row per account
            var query = $@"
                SELECT 
                    a.acctnumber AS account_number,
                    a.accountsearchdisplaynamecopy AS account_name,
                    a.accttype AS account_type,
                    {monthColumns}
                FROM transactionaccountingline tal
                JOIN transaction t ON t.id = tal.transaction
                JOIN account a ON a.id = tal.account
                JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
                WHERE t.posting = 'T'
                  AND tal.posting = 'T'
                  AND a.accttype IN ({plTypesSql})
                  AND t.postingperiod IN ({periodFilter})
                  AND tal.accountingbook = {accountingBook}
                  AND {segmentWhere}
                GROUP BY a.acctnumber, a.accountsearchdisplaynamecopy, a.accttype
                ORDER BY a.acctnumber";

            _logger.LogDebug("Executing full year refresh query...");

            var rows = await _netSuiteService.QueryRawAsync(query);

            var elapsed = (DateTime.UtcNow - startTime).TotalSeconds;
            _logger.LogDebug("Query time: {Elapsed:F2} seconds, {Count} account rows", elapsed, rows.Count);

            // Month column mapping
            var monthMapping = new Dictionary<string, string>
            {
                { "jan", $"Jan {fiscalYear}" },
                { "feb", $"Feb {fiscalYear}" },
                { "mar", $"Mar {fiscalYear}" },
                { "apr", $"Apr {fiscalYear}" },
                { "may", $"May {fiscalYear}" },
                { "jun", $"Jun {fiscalYear}" },
                { "jul", $"Jul {fiscalYear}" },
                { "aug", $"Aug {fiscalYear}" },
                { "sep", $"Sep {fiscalYear}" },
                { "oct", $"Oct {fiscalYear}" },
                { "nov", $"Nov {fiscalYear}" },
                { "dec_month", $"Dec {fiscalYear}" }
            };

            // Transform results to nested dict: { account: { period: value } }
            var balances = new Dictionary<string, Dictionary<string, decimal>>();
            var accountTypes = new Dictionary<string, string>();
            var accountNames = new Dictionary<string, string>();

            foreach (var row in rows)
            {
                var accountNumber = row.TryGetProperty("account_number", out var numProp) ? numProp.GetString() ?? "" : "";
                var accountName = row.TryGetProperty("account_name", out var nameProp) ? nameProp.GetString() ?? "" : "";
                var accountType = row.TryGetProperty("account_type", out var typeProp) ? typeProp.GetString() ?? "" : "";
                
                if (string.IsNullOrEmpty(accountNumber))
                    continue;

                balances[accountNumber] = new Dictionary<string, decimal>();
                accountTypes[accountNumber] = accountType;
                accountNames[accountNumber] = accountName;

                foreach (var (colName, periodName) in monthMapping)
                {
                    decimal amount = 0;
                    if (row.TryGetProperty(colName, out var amountProp) && amountProp.ValueKind != JsonValueKind.Null)
                    {
                        // Handle scientific notation (e.g., "2.402086483E7")
                        if (amountProp.ValueKind == JsonValueKind.String)
                        {
                            var strVal = amountProp.GetString();
                            if (!string.IsNullOrEmpty(strVal))
                            {
                                if (double.TryParse(strVal, System.Globalization.NumberStyles.Float, 
                                                    System.Globalization.CultureInfo.InvariantCulture, out var dblVal))
                                    amount = (decimal)dblVal;
                            }
                        }
                        else if (amountProp.ValueKind == JsonValueKind.Number)
                            amount = amountProp.GetDecimal();
                    }
                    balances[accountNumber][periodName] = amount;
                }
            }

            // Cache all results for fast subsequent lookups
            var filtersHash = $"{targetSub}:{departmentId ?? ""}:{locationId ?? ""}:{classId ?? ""}";
            var cacheExpiry = TimeSpan.FromMinutes(5); // 5-minute TTL like Python
            int cachedCount = 0;
            
            foreach (var (account, periodBalances) in balances)
            {
                foreach (var (period, balance) in periodBalances)
                {
                    var cacheKey = $"balance:{account}:{period}:{filtersHash}";
                    _cache.Set(cacheKey, balance, cacheExpiry);
                    cachedCount++;
                }
            }
            
            _logger.LogInformation("Cached {CachedCount} balance values (5-min TTL)", cachedCount);

            _logger.LogInformation("Returning {Count} accounts × 12 months (P&L) in {Elapsed:F2}s", balances.Count, elapsed);

            return Ok(new
            {
                balances = balances,
                account_types = accountTypes,
                account_names = accountNames,
                year = fiscalYear,
                elapsed_seconds = elapsed,
                account_count = balances.Count,
                cached = true
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in full year refresh");
            return StatusCode(500, new { error = ex.Message });
        }
    }
    
    /// <summary>
    /// Preload ALL Balance Sheet accounts for a given period.
    /// This is critical for performance - BS cumulative queries are slow (~70s),
    /// but batching ALL BS accounts into one query takes only slightly longer.
    /// After preload, individual BS formulas hit cache and are instant.
    /// </summary>
    /// <remarks>
    /// Performance benchmarks:
    /// - 1 BS account: ~74 seconds
    /// - 10 BS accounts: ~66 seconds (batched)
    /// - 30 BS accounts: ~66 seconds (batched)
    /// - 100+ BS accounts: ~70 seconds (batched)
    /// </remarks>
    [HttpPost("/batch/bs_preload")]
    public async Task<IActionResult> PreloadBalanceSheetAccounts([FromBody] BsPreloadRequest request)
    {
        var startTime = DateTime.UtcNow;
        
        if (string.IsNullOrEmpty(request.Period))
            return BadRequest(new { error = "period is required" });

        try
        {
            _logger.LogInformation("📊 BS PRELOAD: Starting for period {Period}", request.Period);
            
            // Get period info
            var period = await _netSuiteService.GetPeriodAsync(request.Period);
            if (period?.EndDate == null)
                return BadRequest(new { error = $"Could not find period {request.Period}" });
            
            // Resolve subsidiary
            var subsidiaryId = await _lookupService.ResolveSubsidiaryIdAsync(request.Subsidiary);
            var targetSub = subsidiaryId ?? "1";
            
            // Get subsidiary hierarchy
            var hierarchySubs = await _lookupService.GetSubsidiaryHierarchyAsync(targetSub);
            var subFilter = string.Join(", ", hierarchySubs);
            
            // Resolve dimension IDs
            var departmentId = await _lookupService.ResolveDimensionIdAsync("department", request.Department);
            var classId = await _lookupService.ResolveDimensionIdAsync("class", request.Class);
            var locationId = await _lookupService.ResolveDimensionIdAsync("location", request.Location);
            
            // Build segment filter
            var segmentFilters = new List<string> { $"tl.subsidiary IN ({subFilter})" };
            if (!string.IsNullOrEmpty(departmentId))
                segmentFilters.Add($"tl.department = {departmentId}");
            if (!string.IsNullOrEmpty(classId))
                segmentFilters.Add($"tl.class = {classId}");
            if (!string.IsNullOrEmpty(locationId))
                segmentFilters.Add($"tl.location = {locationId}");
            var segmentWhere = string.Join(" AND ", segmentFilters);
            
            var accountingBook = request.Book ?? DefaultAccountingBook;
            var endDate = ConvertToYYYYMMDD(period.EndDate);
            
            // Get period ID for CONSOLIDATE exchange rate
            var periodId = !string.IsNullOrEmpty(period.Id) ? period.Id : "NULL";
            
            // Query ALL Balance Sheet accounts at once
            // BS types: Bank, AcctRec, OthCurrAsset, FixedAsset, OthAsset, AcctPay, 
            //           CreditCard, OthCurrLiab, LongTermLiab, Equity, RetainEarn
            var bsTypesSql = Models.AccountType.BsTypesSql;
            
            var query = $@"
                SELECT 
                    a.acctnumber,
                    a.accountsearchdisplaynamecopy AS account_name,
                    a.accttype,
                    SUM(
                        TO_NUMBER(
                            BUILTIN.CONSOLIDATE(
                                tal.amount,
                                'LEDGER',
                                'DEFAULT',
                                'DEFAULT',
                                {targetSub},
                                {periodId},
                                'DEFAULT'
                            )
                        )
                    ) AS balance
                FROM transactionaccountingline tal
                JOIN transaction t ON t.id = tal.transaction
                JOIN account a ON a.id = tal.account
                JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
                WHERE t.posting = 'T'
                  AND tal.posting = 'T'
                  AND a.accttype IN ({bsTypesSql})
                  AND t.trandate <= TO_DATE('{endDate}', 'YYYY-MM-DD')
                  AND tal.accountingbook = {accountingBook}
                  AND {segmentWhere}
                GROUP BY a.acctnumber, a.accountsearchdisplaynamecopy, a.accttype
                ORDER BY a.acctnumber";
            
            _logger.LogDebug("BS Preload query (first 500 chars): {Query}", query[..Math.Min(500, query.Length)]);
            
            // Use error-aware query with 180s timeout for BS cumulative
            var queryResult = await _netSuiteService.QueryRawWithErrorAsync(query, 180);
            
            if (!queryResult.Success)
            {
                _logger.LogWarning("BS Preload query failed: {Error}", queryResult.ErrorDetails);
                return StatusCode(500, new { error = queryResult.ErrorCode, details = queryResult.ErrorDetails });
            }
            
            var elapsed = (DateTime.UtcNow - startTime).TotalSeconds;
            _logger.LogDebug("BS Preload query time: {Elapsed:F2}s, {Count} accounts", elapsed, queryResult.Items.Count);
            
            // Build filters hash for cache key
            var filtersHash = $"{targetSub}:{departmentId ?? ""}:{locationId ?? ""}:{classId ?? ""}";
            
            // Transform results and cache
            var balances = new Dictionary<string, decimal>();
            var accountTypes = new Dictionary<string, string>();
            var accountNames = new Dictionary<string, string>();
            var cacheExpiry = TimeSpan.FromMinutes(5);
            var cachedCount = 0;
            
            foreach (var row in queryResult.Items)
            {
                var accountNumber = row.TryGetProperty("acctnumber", out var numProp) ? numProp.GetString() ?? "" : "";
                var accountName = row.TryGetProperty("account_name", out var nameProp) ? nameProp.GetString() ?? "" : "";
                var accountType = row.TryGetProperty("accttype", out var typeProp) ? typeProp.GetString() ?? "" : "";
                
                if (string.IsNullOrEmpty(accountNumber))
                    continue;
                
                decimal balance = 0;
                if (row.TryGetProperty("balance", out var balProp) && balProp.ValueKind != JsonValueKind.Null)
                {
                    balance = ParseBalance(balProp);
                }
                
                balances[accountNumber] = balance;
                accountTypes[accountNumber] = accountType;
                accountNames[accountNumber] = accountName;
                
                // Cache individual account balance
                var cacheKey = $"balance:{accountNumber}:{request.Period}:{filtersHash}";
                _cache.Set(cacheKey, balance, cacheExpiry);
                cachedCount++;
            }
            
            var totalElapsed = (DateTime.UtcNow - startTime).TotalSeconds;
            _logger.LogInformation(
                "✅ BS PRELOAD COMPLETE: {Count} accounts in {Elapsed:F1}s ({PerAccount:F2}s per account average, {Cached} cached)",
                balances.Count, totalElapsed, balances.Count > 0 ? totalElapsed / balances.Count : 0, cachedCount);
            
            return Ok(new
            {
                balances = balances,
                account_types = accountTypes,
                account_names = accountNames,
                period = request.Period,
                elapsed_seconds = totalElapsed,
                account_count = balances.Count,
                cached_count = cachedCount,
                message = $"Loaded {balances.Count} Balance Sheet accounts in {totalElapsed:F1}s. Individual formulas will now be instant."
            });
        }
        catch (SafetyLimitException ex)
        {
            _logger.LogError(ex, "Safety limit hit in BS preload");
            return StatusCode(500, new { error = ex.LimitType.ToString(), message = ex.UserFriendlyMessage });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in BS preload");
            return StatusCode(500, new { error = "SERVERERR", message = ex.Message });
        }
    }
    
    /// <summary>
    /// Parse balance value handling scientific notation.
    /// </summary>
    private static decimal ParseBalance(System.Text.Json.JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.Number)
            return element.GetDecimal();
        
        if (element.ValueKind == JsonValueKind.String)
        {
            var str = element.GetString();
            if (!string.IsNullOrEmpty(str) && decimal.TryParse(str, 
                System.Globalization.NumberStyles.Float, 
                System.Globalization.CultureInfo.InvariantCulture, out var result))
            {
                return result;
            }
        }
        
        return 0;
    }
    
    /// <summary>
    /// Convert date from MM/DD/YYYY to YYYY-MM-DD format.
    /// </summary>
    private static string ConvertToYYYYMMDD(string mmddyyyy)
    {
        if (DateTime.TryParseExact(mmddyyyy, "M/d/yyyy", null, 
            System.Globalization.DateTimeStyles.None, out var date))
        {
            return date.ToString("yyyy-MM-dd");
        }
        if (DateTime.TryParseExact(mmddyyyy, "MM/dd/yyyy", null, 
            System.Globalization.DateTimeStyles.None, out date))
        {
            return date.ToString("yyyy-MM-dd");
        }
        return mmddyyyy;
    }
}

/// <summary>
/// Request for Balance Sheet preload.
/// </summary>
public class BsPreloadRequest
{
    public string Period { get; set; } = "";
    public string? Subsidiary { get; set; }
    public string? Department { get; set; }
    public string? Class { get; set; }
    public string? Location { get; set; }
    public int? Book { get; set; }
}

