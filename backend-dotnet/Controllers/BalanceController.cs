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
    /// Get the CHANGE in a balance sheet account between two points in time.
    /// Calculated as: balance(toDate) - balance(fromDate)
    /// 
    /// ONLY VALID FOR BALANCE SHEET ACCOUNTS.
    /// P&L accounts will return error "INVALIDACCT".
    /// 
    /// Both fromDate and toDate represent cumulative balances (from inception through that date).
    /// The change is simply the difference between these two ending balances.
    /// </summary>
    /// <remarks>
    /// Example: GET /balance-change?account=10034&amp;from_period=Dec%202024&amp;to_period=Jan%202025
    /// Returns: balance(Jan 2025) - balance(Dec 2024)
    /// </remarks>
    [HttpGet("/balance-change")]
    public async Task<IActionResult> GetBalanceChange(
        [FromQuery] string account,
        [FromQuery] string from_period,
        [FromQuery] string to_period,
        [FromQuery] string? subsidiary = null,
        [FromQuery] string? department = null,
        [FromQuery(Name = "class")] string? classFilter = null,
        [FromQuery] string? location = null,
        [FromQuery] int? book = null)
    {
        if (string.IsNullOrEmpty(account))
            return BadRequest(new { error = "Account number is required" });
        if (string.IsNullOrEmpty(from_period))
            return BadRequest(new { error = "from_period is required" });
        if (string.IsNullOrEmpty(to_period))
            return BadRequest(new { error = "to_period is required" });

        try
        {
            _logger.LogInformation("BALANCECHANGE: account={Account}, from={From}, to={To}", 
                account, from_period, to_period);
            
            // Step 1: Verify this is a Balance Sheet account
            var typeQuery = $"SELECT accttype FROM Account WHERE acctnumber = '{NetSuiteService.EscapeSql(account)}'";
            var typeResult = await _netSuiteService.QueryRawAsync(typeQuery);
            
            if (!typeResult.Any())
            {
                _logger.LogWarning("BALANCECHANGE: Account {Account} not found", account);
                return Ok(new BalanceChangeResponse 
                { 
                    Account = account,
                    FromPeriod = from_period,
                    ToPeriod = to_period,
                    Error = "NOTFOUND"
                });
            }
            
            var acctType = typeResult.First().TryGetProperty("accttype", out var typeProp) 
                ? typeProp.GetString() ?? "" : "";
            var isBsAccount = AccountType.IsBalanceSheet(acctType);
            
            if (!isBsAccount)
            {
                _logger.LogWarning("BALANCECHANGE: Account {Account} is type {Type} (not BS) - returning INVALIDACCT", 
                    account, acctType);
                return Ok(new BalanceChangeResponse 
                { 
                    Account = account,
                    AccountType = acctType,
                    FromPeriod = from_period,
                    ToPeriod = to_period,
                    Error = "INVALIDACCT"
                });
            }
            
            // Step 2: Get balance as of fromDate (cumulative, so from_period is empty)
            var fromRequest = new BalanceRequest
            {
                Account = account,
                FromPeriod = "",  // Cumulative from inception
                ToPeriod = from_period,
                Subsidiary = subsidiary,
                Department = department,
                Class = classFilter,
                Location = location,
                Book = book
            };
            
            var fromResult = await _balanceService.GetBalanceAsync(fromRequest);
            
            // Check for error in fromResult
            if (!string.IsNullOrEmpty(fromResult.Error))
            {
                _logger.LogWarning("BALANCECHANGE: fromBalance query failed with {Error}", fromResult.Error);
                return Ok(new BalanceChangeResponse 
                { 
                    Account = account,
                    AccountType = acctType,
                    FromPeriod = from_period,
                    ToPeriod = to_period,
                    Error = fromResult.Error
                });
            }
            
            // Step 3: Get balance as of toDate (cumulative, so from_period is empty)
            var toRequest = new BalanceRequest
            {
                Account = account,
                FromPeriod = "",  // Cumulative from inception
                ToPeriod = to_period,
                Subsidiary = subsidiary,
                Department = department,
                Class = classFilter,
                Location = location,
                Book = book
            };
            
            var toResult = await _balanceService.GetBalanceAsync(toRequest);
            
            // Check for error in toResult
            if (!string.IsNullOrEmpty(toResult.Error))
            {
                _logger.LogWarning("BALANCECHANGE: toBalance query failed with {Error}", toResult.Error);
                return Ok(new BalanceChangeResponse 
                { 
                    Account = account,
                    AccountType = acctType,
                    FromPeriod = from_period,
                    ToPeriod = to_period,
                    Error = toResult.Error
                });
            }
            
            // Step 4: Calculate change = balance(toDate) - balance(fromDate)
            var change = toResult.Balance - fromResult.Balance;
            
            _logger.LogInformation("BALANCECHANGE: {Account} from {FromPeriod} to {ToPeriod}: {ToBalance:N2} - {FromBalance:N2} = {Change:N2}",
                account, from_period, to_period, toResult.Balance, fromResult.Balance, change);
            
            return Ok(new BalanceChangeResponse
            {
                Account = account,
                AccountType = acctType,
                FromPeriod = from_period,
                ToPeriod = to_period,
                FromBalance = fromResult.Balance,
                ToBalance = toResult.Balance,
                Change = change,
                Cached = fromResult.Cached && toResult.Cached
            });
        }
        catch (SafetyLimitException ex)
        {
            _logger.LogError(ex, "Safety limit hit in balance-change for account {Account}", account);
            return Ok(new BalanceChangeResponse 
            { 
                Account = account,
                FromPeriod = from_period,
                ToPeriod = to_period,
                Error = ex.LimitType.ToString().ToUpper()
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting balance change for account {Account}", account);
            return Ok(new BalanceChangeResponse 
            { 
                Account = account,
                FromPeriod = from_period,
                ToPeriod = to_period,
                Error = "SERVERERR"
            });
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
        
        // Support both single period and multiple periods
        var periodsToLoad = new List<string>();
        if (request.Periods != null && request.Periods.Any())
        {
            periodsToLoad.AddRange(request.Periods.Where(p => !string.IsNullOrEmpty(p)));
        }
        else if (!string.IsNullOrEmpty(request.Period))
        {
            periodsToLoad.Add(request.Period);
        }
        
        if (!periodsToLoad.Any())
            return BadRequest(new { error = "period or periods is required" });

        try
        {
            _logger.LogInformation("📊 BS PRELOAD: Starting for {Count} period(s): {Periods}", 
                periodsToLoad.Count, string.Join(", ", periodsToLoad));
            
            // Results aggregated across all periods
            var allBalances = new Dictionary<string, Dictionary<string, decimal>>();
            var allAccountTypes = new Dictionary<string, string>();
            var allAccountNames = new Dictionary<string, string>();
            var totalCachedCount = 0;
            
            // Resolve common filters (same for all periods)
            var subsidiaryId = await _lookupService.ResolveSubsidiaryIdAsync(request.Subsidiary);
            var targetSub = subsidiaryId ?? "1";
            var hierarchySubs = await _lookupService.GetSubsidiaryHierarchyAsync(targetSub);
            var subFilter = string.Join(", ", hierarchySubs);
            
            var departmentId = await _lookupService.ResolveDimensionIdAsync("department", request.Department);
            var classId = await _lookupService.ResolveDimensionIdAsync("class", request.Class);
            var locationId = await _lookupService.ResolveDimensionIdAsync("location", request.Location);
            
            var segmentFilters = new List<string> { $"tl.subsidiary IN ({subFilter})" };
            if (!string.IsNullOrEmpty(departmentId))
                segmentFilters.Add($"tl.department = {departmentId}");
            if (!string.IsNullOrEmpty(classId))
                segmentFilters.Add($"tl.class = {classId}");
            if (!string.IsNullOrEmpty(locationId))
                segmentFilters.Add($"tl.location = {locationId}");
            var segmentWhere = string.Join(" AND ", segmentFilters);
            
            var accountingBook = request.Book ?? DefaultAccountingBook;
            var filtersHash = $"{targetSub}:{departmentId ?? ""}:{locationId ?? ""}:{classId ?? ""}";
            var cacheExpiry = TimeSpan.FromMinutes(5);
            var bsTypesSql = Models.AccountType.BsTypesSql;
            
            // Process each period
            foreach (var periodName in periodsToLoad)
            {
                var periodStartTime = DateTime.UtcNow;
                
                // Get period info
                var period = await _netSuiteService.GetPeriodAsync(periodName);
                if (period?.EndDate == null)
                {
                    _logger.LogWarning("Could not find period {Period}, skipping", periodName);
                    continue;
                }
                
                var endDate = ConvertToYYYYMMDD(period.EndDate);
                var periodId = !string.IsNullOrEmpty(period.Id) ? period.Id : "NULL";
            
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
            
                _logger.LogDebug("BS Preload [{Period}] query (first 500 chars): {Query}", 
                    periodName, query[..Math.Min(500, query.Length)]);
            
                var queryResult = await _netSuiteService.QueryRawWithErrorAsync(query, 180);
            
                if (!queryResult.Success)
                {
                    _logger.LogWarning("BS Preload query failed for {Period}: {Error}", periodName, queryResult.ErrorDetails);
                    continue; // Skip this period but continue with others
                }
            
                var periodElapsed = (DateTime.UtcNow - periodStartTime).TotalSeconds;
                _logger.LogDebug("BS Preload [{Period}] query time: {Elapsed:F2}s, {Count} accounts", 
                    periodName, periodElapsed, queryResult.Items.Count);
            
                // Process and cache results for this period
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
                
                    // Store account info (same across periods)
                    allAccountTypes[accountNumber] = accountType;
                    allAccountNames[accountNumber] = accountName;
                    
                    // Store balance per period: { "10010": { "Dec 2024": 100, "Dec 2023": 90 } }
                    if (!allBalances.ContainsKey(accountNumber))
                        allBalances[accountNumber] = new Dictionary<string, decimal>();
                    allBalances[accountNumber][periodName] = balance;
                
                    // Cache individual account balance for this period
                    var cacheKey = $"balance:{accountNumber}:{periodName}:{filtersHash}";
                    _cache.Set(cacheKey, balance, cacheExpiry);
                    totalCachedCount++;
                }
                
                _logger.LogInformation("✅ BS PRELOAD [{Period}]: {Count} accounts in {Elapsed:F1}s", 
                    periodName, queryResult.Items.Count, periodElapsed);
            }
            
            var totalElapsed = (DateTime.UtcNow - startTime).TotalSeconds;
            _logger.LogInformation(
                "✅ BS PRELOAD COMPLETE: {Accounts} accounts × {Periods} periods in {Elapsed:F1}s ({Cached} cached)",
                allBalances.Count, periodsToLoad.Count, totalElapsed, totalCachedCount);
            
            return Ok(new
            {
                balances = allBalances,
                account_types = allAccountTypes,
                account_names = allAccountNames,
                periods = periodsToLoad,
                elapsed_seconds = totalElapsed,
                account_count = allBalances.Count,
                period_count = periodsToLoad.Count,
                cached_count = totalCachedCount,
                message = $"Loaded {allBalances.Count} Balance Sheet accounts × {periodsToLoad.Count} period(s) in {totalElapsed:F1}s. Individual formulas will now be instant."
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
/// Supports single period OR multiple periods for comparison scenarios.
/// </summary>
public class BsPreloadRequest
{
    /// <summary>Single period (backward compatible)</summary>
    public string Period { get; set; } = "";
    
    /// <summary>Multiple periods for comparison (e.g., Dec 2024 + Dec 2023)</summary>
    public List<string>? Periods { get; set; }
    
    public string? Subsidiary { get; set; }
    public string? Department { get; set; }
    public string? Class { get; set; }
    public string? Location { get; set; }
    public int? Book { get; set; }
}

