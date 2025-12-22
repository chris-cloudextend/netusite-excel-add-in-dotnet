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
    /// Get annual P&L totals using NetSuite's year periods (optimized year endpoint).
    /// This is faster than querying 12 months because NetSuite pre-calculates year totals.
    /// Returns: { balances: { "60010": { "FY 2025": 43983641.42 } } }
    /// </summary>
    [HttpPost("/batch/balance/year")]
    public async Task<IActionResult> GetBalanceYear([FromBody] YearBalanceRequest request)
    {
        if (request.Accounts == null || !request.Accounts.Any())
            return BadRequest(new { error = "accounts list is required" });
        if (request.Year <= 0)
            return BadRequest(new { error = "year is required" });

        try
        {
            var year = request.Year;
            var accountingBook = request.Book ?? DefaultAccountingBook;

            _logger.LogInformation("📊 YEAR BALANCE: {Count} accounts for FY {Year}", request.Accounts.Count, year);

            // Resolve subsidiary
            var subsidiaryId = await _lookupService.ResolveSubsidiaryIdAsync(request.Subsidiary);
            var targetSub = subsidiaryId ?? "1";
            var hierarchySubs = await _lookupService.GetSubsidiaryHierarchyAsync(targetSub);
            var subFilter = string.Join(", ", hierarchySubs);

            // Build account filter
            var accountFilter = string.Join("', '", request.Accounts.Select(a => NetSuiteService.EscapeSql(a)));
            var incomeTypesSql = "'Income', 'OthIncome'";
            var periodName = $"FY {year}";

            // Query all 12 months and SUM
            var query = $@"
                SELECT 
                    a.acctnumber,
                    SUM(
                        TO_NUMBER(
                            BUILTIN.CONSOLIDATE(
                                tal.amount,
                                'LEDGER',
                                'DEFAULT',
                                'DEFAULT',
                                {targetSub},
                                ap.id,
                                'DEFAULT'
                            )
                        ) * CASE WHEN a.accttype IN ({incomeTypesSql}) THEN -1 ELSE 1 END
                    ) as balance
                FROM transactionaccountingline tal
                JOIN transaction t ON t.id = tal.transaction
                JOIN account a ON a.id = tal.account
                JOIN accountingperiod ap ON ap.id = t.postingperiod
                JOIN transactionline tl ON t.id = tl.transaction AND tal.transactionline = tl.id
                WHERE t.posting = 'T'
                  AND tal.posting = 'T'
                  AND a.acctnumber IN ('{accountFilter}')
                  AND EXTRACT(YEAR FROM ap.startdate) = {year}
                  AND ap.isyear = 'F' AND ap.isquarter = 'F'
                  AND tal.accountingbook = {accountingBook}
                  AND tl.subsidiary IN ({subFilter})
                GROUP BY a.acctnumber";

            var results = await _netSuiteService.QueryRawAsync(query, 60);

            var balances = new Dictionary<string, Dictionary<string, decimal>>();
            foreach (var row in results)
            {
                var acctNum = row.TryGetProperty("acctnumber", out var acctProp) ? acctProp.GetString() ?? "" : "";
                var balance = row.TryGetProperty("balance", out var balProp) ? ParseBalance(balProp) : 0;
                
                if (!string.IsNullOrEmpty(acctNum))
                {
                    balances[acctNum] = new Dictionary<string, decimal> { { periodName, balance } };
                }
            }

            _logger.LogInformation("✅ YEAR BALANCE: Got {Count} accounts", balances.Count);

            return Ok(new { balances, period = periodName });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in year balance");
            return StatusCode(500, new { error = ex.Message });
        }
    }

    /// <summary>
    /// Get Balance Sheet balances for multiple periods (efficient multi-period query).
    /// This is an alias for bs_preload - returns all BS accounts for requested periods.
    /// Frontend expects: { balances: { "10010": { "Dec 2024": 123 }, ... } }
    /// </summary>
    [HttpPost("/batch/bs_periods")]
    public Task<IActionResult> GetBsPeriodsMulti([FromBody] BsPreloadRequest request)
    {
        // Delegate to the preload endpoint which returns the same format
        return PreloadBalanceSheetAccounts(request);
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
            
                // Sign flip for Balance Sheet: Liabilities and Equity are stored as negative credits,
                // need to flip to positive for display (same as NetSuite reports)
                var signFlipSql = Models.AccountType.SignFlipTypesSql;
            
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
                            ) * CASE WHEN a.accttype IN ({signFlipSql}) THEN -1 ELSE 1 END
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
    /// TARGETED BS Preload - Only preload specific accounts (from sheet scan).
    /// Much faster than preloading all 200+ accounts when sheet only uses 10-20.
    /// </summary>
    /// <remarks>
    /// Used by smart preload feature that scans the sheet first.
    /// Example: If sheet has 15 BS accounts × 2 periods = ~20 seconds (vs ~140 for all accounts)
    /// </remarks>
    [HttpPost("/batch/bs_preload_targeted")]
    public async Task<IActionResult> PreloadBalanceSheetTargeted([FromBody] TargetedBsPreloadRequest request)
    {
        var startTime = DateTime.UtcNow;
        
        if (request.Accounts == null || !request.Accounts.Any())
            return BadRequest(new { error = "accounts array is required" });
        if (request.Periods == null || !request.Periods.Any())
            return BadRequest(new { error = "periods array is required" });

        try
        {
            _logger.LogInformation("📊 TARGETED BS PRELOAD: {AccountCount} accounts × {PeriodCount} periods", 
                request.Accounts.Count, request.Periods.Count);
            
            var allBalances = new Dictionary<string, Dictionary<string, decimal>>();
            var allAccountTypes = new Dictionary<string, string>();
            var totalCachedCount = 0;
            
            // Resolve common filters
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
            
            // Build account filter
            var accountFilter = string.Join("', '", request.Accounts.Select(a => NetSuiteService.EscapeSql(a)));
            
            // Process each period
            foreach (var periodName in request.Periods)
            {
                var periodStartTime = DateTime.UtcNow;
                
                var period = await _netSuiteService.GetPeriodAsync(periodName);
                if (period?.EndDate == null)
                {
                    _logger.LogWarning("Could not find period {Period}, skipping", periodName);
                    continue;
                }
                
                var endDate = ConvertToYYYYMMDD(period.EndDate);
                var periodId = !string.IsNullOrEmpty(period.Id) ? period.Id : "NULL";
                
                // Sign flip for Balance Sheet: Liabilities and Equity are stored as negative credits,
                // need to flip to positive for display (same as NetSuite reports)
                var signFlipSql = Models.AccountType.SignFlipTypesSql;
                
                // Query ONLY the specific accounts
                var query = $@"
                    SELECT 
                        a.acctnumber,
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
                            ) * CASE WHEN a.accttype IN ({signFlipSql}) THEN -1 ELSE 1 END
                        ) AS balance
                    FROM transactionaccountingline tal
                    JOIN transaction t ON t.id = tal.transaction
                    JOIN account a ON a.id = tal.account
                    JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
                    WHERE t.posting = 'T'
                      AND tal.posting = 'T'
                      AND a.acctnumber IN ('{accountFilter}')
                      AND t.trandate <= TO_DATE('{endDate}', 'YYYY-MM-DD')
                      AND tal.accountingbook = {accountingBook}
                      AND {segmentWhere}
                    GROUP BY a.acctnumber, a.accttype
                    ORDER BY a.acctnumber";
                
                _logger.LogDebug("Targeted BS Preload [{Period}] for {Count} accounts", periodName, request.Accounts.Count);
                
                var queryResult = await _netSuiteService.QueryRawWithErrorAsync(query, 120);
                
                if (!queryResult.Success)
                {
                    _logger.LogWarning("Targeted BS Preload query failed for {Period}: {Error}", periodName, queryResult.ErrorDetails);
                    continue;
                }
                
                var periodElapsed = (DateTime.UtcNow - periodStartTime).TotalSeconds;
                _logger.LogDebug("Targeted BS Preload [{Period}] time: {Elapsed:F2}s, {Count} accounts", 
                    periodName, periodElapsed, queryResult.Items.Count);
                
                foreach (var item in queryResult.Items)
                {
                    if (!item.TryGetProperty("acctnumber", out var acctProp)) continue;
                    var accountNumber = acctProp.GetString() ?? "";
                    if (string.IsNullOrEmpty(accountNumber)) continue;
                    
                    var acctType = item.TryGetProperty("accttype", out var typeProp) 
                        ? typeProp.GetString() ?? "" : "";
                    var balance = item.TryGetProperty("balance", out var balProp) 
                        ? ParseBalance(balProp) : 0;
                    
                    if (!allBalances.ContainsKey(accountNumber))
                        allBalances[accountNumber] = new Dictionary<string, decimal>();
                    
                    allBalances[accountNumber][periodName] = balance;
                    allAccountTypes[accountNumber] = acctType;
                    
                    // Cache this balance
                    var cacheKey = $"balance:{accountNumber}:{periodName}:{filtersHash}";
                    _cache.Set(cacheKey, balance, cacheExpiry);
                    totalCachedCount++;
                }
            }
            
            var totalElapsed = (DateTime.UtcNow - startTime).TotalSeconds;
            _logger.LogInformation("✅ TARGETED BS PRELOAD: {AccountCount} accounts × {PeriodCount} periods in {Elapsed:F1}s", 
                allBalances.Count, request.Periods.Count, totalElapsed);
            
            return Ok(new
            {
                balances = allBalances,
                account_types = allAccountTypes,
                periods = request.Periods,
                elapsed_seconds = totalElapsed,
                account_count = allBalances.Count,
                period_count = request.Periods.Count,
                cached_count = totalCachedCount,
                message = $"Loaded {allBalances.Count} accounts × {request.Periods.Count} period(s) in {totalElapsed:F1}s"
            });
        }
        catch (SafetyLimitException ex)
        {
            _logger.LogError(ex, "Safety limit in targeted BS preload");
            return StatusCode(500, new { error = ex.LimitType.ToString(), message = ex.UserFriendlyMessage });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in targeted BS preload");
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
    
    /// <summary>
    /// Generate structured Balance Sheet report for a given period.
    /// Returns all BS accounts with non-zero balances, grouped by section/subsection,
    /// with parent-child hierarchy, plus calculated rows (NETINCOME, RETAINEDEARNINGS, CTA).
    /// </summary>
    [HttpPost("/balance-sheet/report")]
    public async Task<IActionResult> GenerateBalanceSheetReport([FromBody] BalanceSheetReportRequest request)
    {
        var startTime = DateTime.UtcNow;
        
        try
        {
            if (string.IsNullOrEmpty(request.Period))
                return BadRequest(new { error = "period is required" });

            _logger.LogInformation("═══════════════════════════════════════════════════════");
            _logger.LogInformation("📊 BALANCE SHEET REPORT - Starting (using bs_preload cache)");
            _logger.LogInformation("   Period: '{Period}'", request.Period);
            _logger.LogInformation("   Subsidiary: {Sub}", request.Subsidiary ?? "(all)");
            _logger.LogInformation("   Department: {Dept}", request.Department ?? "(all)");
            _logger.LogInformation("   Class: {Class}", request.Class ?? "(all)");
            _logger.LogInformation("   Location: {Loc}", request.Location ?? "(all)");
            _logger.LogInformation("═══════════════════════════════════════════════════════");

            // Resolve filters
            var subsidiaryId = await _lookupService.ResolveSubsidiaryIdAsync(request.Subsidiary);
            var targetSub = subsidiaryId ?? "1";
            var hierarchySubs = await _lookupService.GetSubsidiaryHierarchyAsync(targetSub);
            var subFilter = string.Join(", ", hierarchySubs);
            
            var departmentId = await _lookupService.ResolveDimensionIdAsync("department", request.Department);
            var classId = await _lookupService.ResolveDimensionIdAsync("class", request.Class);
            var locationId = await _lookupService.ResolveDimensionIdAsync("location", request.Location);
            var accountingBook = request.Book ?? DefaultAccountingBook;

            // Build segment filters
            var segmentFilters = new List<string> { $"COALESCE(tl.subsidiary, t.subsidiary) IN ({subFilter})" };
            if (!string.IsNullOrEmpty(departmentId))
                segmentFilters.Add($"COALESCE(tl.department, t.department) = {departmentId}");
            if (!string.IsNullOrEmpty(classId))
                segmentFilters.Add($"COALESCE(tl.class, t.class) = {classId}");
            if (!string.IsNullOrEmpty(locationId))
                segmentFilters.Add($"COALESCE(tl.location, t.location) = {locationId}");
            var segmentWhere = string.Join(" AND ", segmentFilters);

            // Get period data
            var periodData = await _netSuiteService.GetPeriodAsync(request.Period);
            if (periodData?.EndDate == null)
                return BadRequest(new { error = $"Could not find period: {request.Period}" });

            var periodEndDate = ConvertToYYYYMMDD(periodData.EndDate);
            var targetPeriodId = periodData.Id ?? "NULL";

            _logger.LogDebug("Balance Sheet Report: period end={EndDate}, period ID={PeriodId}", periodEndDate, targetPeriodId);

            // OPTIMIZATION: Use bs_preload to get balances (cached and faster)
            // Then build report structure from cached data + fetch parent relationships
            _logger.LogInformation("🔄 Step 1: Calling bs_preload to get/cache all BS account balances...");
            var preloadStartTime = DateTime.UtcNow;
            
            var preloadRequest = new BsPreloadRequest
            {
                Period = request.Period,
                Subsidiary = request.Subsidiary,
                Department = request.Department,
                Class = request.Class,
                Location = request.Location,
                Book = request.Book
            };
            
            var preloadResult = await PreloadBalanceSheetAccounts(preloadRequest);
            var preloadElapsed = (DateTime.UtcNow - preloadStartTime).TotalSeconds;
            _logger.LogInformation("✅ Step 1 complete: bs_preload finished in {Elapsed:F1}s", preloadElapsed);
            
            if (preloadResult is not OkObjectResult okResult)
            {
                _logger.LogError("❌ bs_preload failed - cannot build Balance Sheet report");
                return preloadResult;
            }
            
            var preloadData = okResult.Value;
            var preloadType = preloadData.GetType();
            var balancesProperty = preloadType.GetProperty("balances");
            var accountTypesProperty = preloadType.GetProperty("account_types");
            var accountNamesProperty = preloadType.GetProperty("account_names");
            
            if (balancesProperty?.GetValue(preloadData) is not Dictionary<string, Dictionary<string, decimal>> allBalances ||
                accountTypesProperty?.GetValue(preloadData) is not Dictionary<string, string> allAccountTypes ||
                accountNamesProperty?.GetValue(preloadData) is not Dictionary<string, string> allAccountNames)
            {
                return StatusCode(500, new { error = "Failed to parse bs_preload response" });
            }
            
            // Get balances for the requested period
            // Include ALL accounts from bs_preload, even with zero balance
            // This ensures parent accounts and accounts that should appear in the report are included
            var periodBalances = new Dictionary<string, decimal>();
            foreach (var (account, periodBalancesDict) in allBalances)
            {
                if (periodBalancesDict.TryGetValue(request.Period, out var balance))
                {
                    periodBalances[account] = balance;
                }
            }
            
            _logger.LogInformation("📊 Step 1 data: Got {Count} BS accounts from bs_preload ({NonZero} with non-zero balances)", 
                periodBalances.Count, periodBalances.Values.Count(b => b != 0));
            
            // Step 2: Fetch parent relationships and account names for accounts with balances
            _logger.LogInformation("🔄 Step 2: Fetching account info and parent relationships...");
            var accountNumbers = periodBalances.Keys.ToList();
            
            Dictionary<string, string?> parentMap = new();
            Dictionary<string, string> accountNameMap = new();
            Dictionary<string, string> accountTypeMap = new();
            
            if (accountNumbers.Any())
            {
                var parentNumbersList = string.Join(", ", accountNumbers.Select(n => $"'{NetSuiteService.EscapeSql(n)}'"));
                var accountInfoQuery = $@"
                    SELECT 
                        a.acctnumber,
                        a.accountsearchdisplaynamecopy AS account_name,
                        a.accttype,
                        p.acctnumber AS parent_number
                    FROM account a
                    LEFT JOIN account p ON a.parent = p.id
                    WHERE a.acctnumber IN ({parentNumbersList})
                      AND a.isinactive = 'F'";
                
                _logger.LogInformation("   Querying account table for {Count} accounts...", accountNumbers.Count);
                var accountInfoResults = await _netSuiteService.QueryRawAsync(accountInfoQuery, 30);
                _logger.LogInformation("✅ Step 2 complete: Got account info for {Count} accounts", accountInfoResults.Count);
                
                foreach (var row in accountInfoResults)
                {
                    var acctNum = row.TryGetProperty("acctnumber", out var numProp) ? numProp.GetString() ?? "" : "";
                    var acctName = row.TryGetProperty("account_name", out var nameProp) ? nameProp.GetString() ?? "" : "";
                    var acctType = row.TryGetProperty("accttype", out var typeProp) ? typeProp.GetString() ?? "" : "";
                    var parentNum = row.TryGetProperty("parent_number", out var pProp) && pProp.ValueKind != JsonValueKind.Null 
                        ? pProp.GetString() : null;
                    
                    if (!string.IsNullOrEmpty(acctNum))
                    {
                        parentMap[acctNum] = parentNum;
                        if (!string.IsNullOrEmpty(acctName))
                            accountNameMap[acctNum] = acctName;
                        else if (allAccountNames.TryGetValue(acctNum, out var cachedName))
                            accountNameMap[acctNum] = cachedName;
                        
                        if (!string.IsNullOrEmpty(acctType))
                            accountTypeMap[acctNum] = acctType;
                        else if (allAccountTypes.TryGetValue(acctNum, out var cachedType))
                            accountTypeMap[acctNum] = cachedType;
                    }
                }
            }
            
            // Section mapping based on accttype (exact NetSuite behavior)
            var currentAssetTypes = new[] { AccountType.Bank, AccountType.AcctRec, AccountType.OthCurrAsset };
            var fixedAssetTypes = new[] { AccountType.FixedAsset };
            var otherAssetTypes = new[] { AccountType.OthAsset };
            var currentLiabilityTypes = new[] { AccountType.AcctPay, AccountType.CredCard, AccountType.OthCurrLiab };
            var longTermLiabilityTypes = new[] { AccountType.LongTermLiab };
            var equityTypes = new[] { AccountType.Equity };

            // Build account map with parent relationships from cached data
            var accountMap = new Dictionary<string, BalanceSheetRow>();
            var parentChildMap = new Dictionary<string, List<string>>(); // parent -> children
            var parentAccountNumbers = new HashSet<string>(); // Track parent accounts that need to be included

            // Process ALL accounts from bs_preload (including zero balance accounts)
            // Zero balance accounts may be parent accounts or accounts that should appear in the report
            // Also track which accounts are parents so we can include them even if they have zero balance
            var allAccountNumbers = new HashSet<string>(periodBalances.Keys);
            
            foreach (var (acctNum, balance) in periodBalances)
            {
                // Get account info - prefer from accountInfoQuery, fallback to bs_preload cache
                var acctName = accountNameMap.GetValueOrDefault(acctNum, 
                    allAccountNames.GetValueOrDefault(acctNum, ""));
                var acctType = accountTypeMap.GetValueOrDefault(acctNum, 
                    allAccountTypes.GetValueOrDefault(acctNum, ""));
                var parentNum = parentMap.GetValueOrDefault(acctNum);

                if (string.IsNullOrEmpty(acctNum) || string.IsNullOrEmpty(acctType))
                {
                    _logger.LogWarning("Skipping account {Account} - missing account number or type", acctNum);
                    continue;
                }
                
                // Track parent accounts that have children with non-zero balances
                if (!string.IsNullOrEmpty(parentNum))
                {
                    parentAccountNumbers.Add(parentNum);
                }

                // Determine section and subsection
                string section, subsection;
                if (currentAssetTypes.Contains(acctType))
                {
                    section = "Assets";
                    subsection = "Current Assets";
                }
                else if (fixedAssetTypes.Contains(acctType))
                {
                    section = "Assets";
                    subsection = "Fixed Assets";
                }
                else if (otherAssetTypes.Contains(acctType))
                {
                    section = "Assets";
                    subsection = "Other Assets";
                }
                else if (currentLiabilityTypes.Contains(acctType))
                {
                    section = "Liabilities";
                    subsection = "Current Liabilities";
                }
                else if (longTermLiabilityTypes.Contains(acctType))
                {
                    section = "Liabilities";
                    subsection = "Long Term Liabilities";
                }
                else if (equityTypes.Contains(acctType))
                {
                    section = "Equity";
                    subsection = "Equity";
                }
                else
                {
                    // DeferExpense, DeferRevenue, RetainedEarnings, UnbilledRec - map appropriately
                    if (acctType == AccountType.DeferExpense || acctType == AccountType.UnbilledRec)
                    {
                        section = "Assets";
                        subsection = "Current Assets";
                    }
                    else if (acctType == AccountType.DeferRevenue)
                    {
                        section = "Liabilities";
                        subsection = "Current Liabilities";
                    }
                    else if (acctType == AccountType.RetainedEarnings)
                    {
                        section = "Equity";
                        subsection = "Equity";
                    }
                    else
                    {
                        continue; // Skip unknown types
                    }
                }

                var bsRow = new BalanceSheetRow
                {
                    Section = section,
                    Subsection = subsection,
                    AccountNumber = acctNum,
                    AccountName = acctName,
                    AccountType = acctType,
                    ParentAccount = parentNum,
                    Balance = balance,
                    IsCalculated = false,
                    Source = "Account",
                    Level = 0 // Will be calculated later
                };

                accountMap[acctNum] = bsRow;

                // Track parent-child relationships
                if (!string.IsNullOrEmpty(parentNum))
                {
                    if (!parentChildMap.ContainsKey(parentNum))
                        parentChildMap[parentNum] = new List<string>();
                    parentChildMap[parentNum].Add(acctNum);
                    parentAccountNumbers.Add(parentNum); // Track parents that have children with balances
                }
            }

            // Fetch parent accounts that have children with non-zero balances (even if parent has zero balance)
            // Also include parents that might not be in periodBalances (zero balance, no transactions)
            var missingParents = parentAccountNumbers
                .Where(p => !accountMap.ContainsKey(p) && !allAccountNumbers.Contains(p))
                .ToList();
            if (missingParents.Any())
            {
                _logger.LogDebug("Fetching {Count} parent accounts that have children with balances", missingParents.Count);
                
                var parentNumbersList = string.Join(", ", missingParents.Select(p => $"'{NetSuiteService.EscapeSql(p)}'"));
                var parentQuery = $@"
                    SELECT 
                        a.acctnumber,
                        a.accountsearchdisplaynamecopy AS account_name,
                        a.accttype,
                        p.acctnumber AS parent_number,
                        0 AS balance
                    FROM account a
                    LEFT JOIN account p ON a.parent = p.id
                    WHERE a.acctnumber IN ({parentNumbersList})
                      AND a.isinactive = 'F'";
                
                var parentResults = await _netSuiteService.QueryRawAsync(parentQuery, 30);
                
                foreach (var row in parentResults)
                {
                    var acctNum = row.TryGetProperty("acctnumber", out var acctProp) ? acctProp.GetString() ?? "" : "";
                    var acctName = row.TryGetProperty("account_name", out var nameProp) ? nameProp.GetString() ?? "" : "";
                    var acctType = row.TryGetProperty("accttype", out var typeProp) ? typeProp.GetString() ?? "" : "";
                    var parentNum = row.TryGetProperty("parent_number", out var parentProp) && parentProp.ValueKind != JsonValueKind.Null 
                        ? parentProp.GetString() : null;

                    if (string.IsNullOrEmpty(acctNum) || string.IsNullOrEmpty(acctType))
                        continue;

                    // Determine section and subsection (same logic as above)
                    string section, subsection;
                    if (currentAssetTypes.Contains(acctType))
                    {
                        section = "Assets";
                        subsection = "Current Assets";
                    }
                    else if (fixedAssetTypes.Contains(acctType))
                    {
                        section = "Assets";
                        subsection = "Fixed Assets";
                    }
                    else if (otherAssetTypes.Contains(acctType))
                    {
                        section = "Assets";
                        subsection = "Other Assets";
                    }
                    else if (currentLiabilityTypes.Contains(acctType))
                    {
                        section = "Liabilities";
                        subsection = "Current Liabilities";
                    }
                    else if (longTermLiabilityTypes.Contains(acctType))
                    {
                        section = "Liabilities";
                        subsection = "Long Term Liabilities";
                    }
                    else if (equityTypes.Contains(acctType))
                    {
                        section = "Equity";
                        subsection = "Equity";
                    }
                    else
                    {
                        if (acctType == AccountType.DeferExpense || acctType == AccountType.UnbilledRec)
                        {
                            section = "Assets";
                            subsection = "Current Assets";
                        }
                        else if (acctType == AccountType.DeferRevenue)
                        {
                            section = "Liabilities";
                            subsection = "Current Liabilities";
                        }
                        else if (acctType == AccountType.RetainedEarnings)
                        {
                            section = "Equity";
                            subsection = "Equity";
                        }
                        else
                        {
                            continue;
                        }
                    }

                    var bsRow = new BalanceSheetRow
                    {
                        Section = section,
                        Subsection = subsection,
                        AccountNumber = acctNum,
                        AccountName = acctName,
                        AccountType = acctType,
                        ParentAccount = parentNum,
                        Balance = 0, // Parent has zero balance but included because children have balances
                        IsCalculated = false,
                        Source = "Account",
                        Level = 0
                    };

                    accountMap[acctNum] = bsRow;
                    
                    // Track parent's parent if exists
                    if (!string.IsNullOrEmpty(parentNum))
                    {
                        if (!parentChildMap.ContainsKey(parentNum))
                            parentChildMap[parentNum] = new List<string>();
                        parentChildMap[parentNum].Add(acctNum);
                    }
                }
            }

            // Calculate levels based on parent-child hierarchy
            void SetLevels(string accountNum, int level)
            {
                if (accountMap.ContainsKey(accountNum))
                {
                    accountMap[accountNum].Level = level;
                    if (parentChildMap.ContainsKey(accountNum))
                    {
                        foreach (var child in parentChildMap[accountNum])
                        {
                            SetLevels(child, level + 1);
                        }
                    }
                }
            }

            // Set levels starting from top-level accounts (no parent)
            foreach (var accountNum in accountMap.Keys)
            {
                if (string.IsNullOrEmpty(accountMap[accountNum].ParentAccount))
                {
                    SetLevels(accountNum, 0);
                }
            }

            // Build hierarchical tree structure
            var accountTree = new Dictionary<string, List<string>>(); // parent -> children
            var topLevelAccounts = new List<string>();

            foreach (var account in accountMap.Values)
            {
                if (string.IsNullOrEmpty(account.ParentAccount))
                {
                    topLevelAccounts.Add(account.AccountNumber ?? "");
                }
                else
                {
                    if (!accountTree.ContainsKey(account.ParentAccount))
                        accountTree[account.ParentAccount] = new List<string>();
                    accountTree[account.ParentAccount].Add(account.AccountNumber ?? "");
                }
            }

            // Mark parent accounts that have children as headers
            foreach (var accountNum in accountMap.Keys)
            {
                if (accountTree.ContainsKey(accountNum) && accountTree[accountNum].Any())
                {
                    accountMap[accountNum].IsParentHeader = true;
                }
            }

            // Recursive function to build ordered list hierarchically
            void AddAccountHierarchy(string accountNum, List<BalanceSheetRow> orderedRows, string currentSection, string currentSubsection)
            {
                if (!accountMap.ContainsKey(accountNum))
                    return;

                var account = accountMap[accountNum];
                
                // Only add if it matches the current section/subsection (for proper grouping)
                if (account.Section == currentSection && account.Subsection == currentSubsection)
                {
                    // Add parent header first (if it's a parent), then add the account itself
                    // Parent headers are category labels, but if they have a balance, also show as account row
                    if (account.IsParentHeader)
                    {
                        // Create a separate header row (will be rendered differently in frontend)
                        // This is a header-only row (no formula)
                        var headerRow = new BalanceSheetRow
                        {
                            Section = account.Section,
                            Subsection = account.Subsection,
                            AccountNumber = account.AccountNumber,
                            AccountName = account.AccountName,
                            AccountType = account.AccountType,
                            ParentAccount = account.ParentAccount,
                            Balance = 0, // Header has no balance
                            IsParentHeader = true,
                            IsCalculated = false,
                            Source = "ParentHeader",
                            Level = account.Level
                        };
                        orderedRows.Add(headerRow);
                        
                        // If parent account also has a balance, add it as a regular account row too
                        if (account.Balance != 0)
                        {
                            var accountRow = new BalanceSheetRow
                            {
                                Section = account.Section,
                                Subsection = account.Subsection,
                                AccountNumber = account.AccountNumber,
                                AccountName = account.AccountName,
                                AccountType = account.AccountType,
                                ParentAccount = account.ParentAccount,
                                Balance = account.Balance,
                                IsParentHeader = false, // This is the account row, not the header
                                IsCalculated = false,
                                Source = "Account",
                                Level = account.Level
                            };
                            orderedRows.Add(accountRow);
                        }
                    }
                    else
                    {
                        // Regular account row
                        orderedRows.Add(account);
                    }
                    
                    // Add children recursively
                    if (accountTree.ContainsKey(accountNum))
                    {
                        var children = accountTree[accountNum].OrderBy(n => n).ToList();
                        foreach (var childNum in children)
                        {
                            AddAccountHierarchy(childNum, orderedRows, currentSection, currentSubsection);
                        }
                        
                        // Add subtotal after children
                        if (children.Any())
                        {
                            var childBalances = children
                                .Where(c => accountMap.ContainsKey(c))
                                .Select(c => accountMap[c].Balance)
                                .ToList();
                            
                            var subtotal = new BalanceSheetRow
                            {
                                Section = account.Section,
                                Subsection = account.Subsection,
                                AccountName = $"Total {account.AccountName}",
                                IsSubtotal = true,
                                SubtotalFor = accountNum,
                                Balance = childBalances.Sum(),
                                IsCalculated = true,
                                Source = "Subtotal",
                                Level = account.Level + 1
                            };
                            orderedRows.Add(subtotal);
                        }
                    }
                }
            }

            // Build ordered list of rows using hierarchical traversal
            var rows = new List<BalanceSheetRow>();

            // Section order: Assets, Liabilities, Equity
            var sectionOrder = new[] { "Assets", "Liabilities", "Equity" };
            var subsectionOrder = new Dictionary<string, int>
            {
                { "Current Assets", 1 },
                { "Fixed Assets", 2 },
                { "Other Assets", 3 },
                { "Current Liabilities", 1 },
                { "Long Term Liabilities", 2 },
                { "Equity", 1 }
            };

            foreach (var section in sectionOrder)
            {
                var subsections = accountMap.Values
                    .Where(r => r.Section == section)
                    .Select(r => r.Subsection)
                    .Distinct()
                    .OrderBy(s => subsectionOrder.GetValueOrDefault(s, 999))
                    .ToList();

                foreach (var subsection in subsections)
                {
                    // Get all account types in this subsection, ordered by display priority
                    var accountTypesInSubsection = accountMap.Values
                        .Where(r => r.Section == section && r.Subsection == subsection)
                        .Select(r => r.AccountType)
                        .Distinct()
                        .ToList();

                    // Define account type ordering within each subsection (matches NetSuite standard)
                    var typeOrder = new Dictionary<string, int>();
                    if (subsection == "Current Assets")
                    {
                        typeOrder = new Dictionary<string, int>
                        {
                            { AccountType.Bank, 1 },
                            { AccountType.AcctRec, 2 },
                            { AccountType.OthCurrAsset, 3 },
                            { AccountType.DeferExpense, 4 },
                            { AccountType.UnbilledRec, 5 }
                        };
                    }
                    else if (subsection == "Fixed Assets")
                    {
                        typeOrder = new Dictionary<string, int>
                        {
                            { AccountType.FixedAsset, 1 }
                        };
                    }
                    else if (subsection == "Other Assets")
                    {
                        typeOrder = new Dictionary<string, int>
                        {
                            { AccountType.OthAsset, 1 }
                        };
                    }
                    else if (subsection == "Current Liabilities")
                    {
                        typeOrder = new Dictionary<string, int>
                        {
                            { AccountType.AcctPay, 1 },
                            { AccountType.CredCard, 2 },
                            { AccountType.OthCurrLiab, 3 },
                            { AccountType.DeferRevenue, 4 }
                        };
                    }
                    else if (subsection == "Long Term Liabilities")
                    {
                        typeOrder = new Dictionary<string, int>
                        {
                            { AccountType.LongTermLiab, 1 }
                        };
                    }
                    else if (subsection == "Equity")
                    {
                        typeOrder = new Dictionary<string, int>
                        {
                            { AccountType.Equity, 1 },
                            { AccountType.RetainedEarnings, 2 }
                        };
                    }

                    // Process each account type in order
                    var orderedTypes = accountTypesInSubsection
                        .OrderBy(t => typeOrder.GetValueOrDefault(t, 999))
                        .ThenBy(t => t)
                        .ToList();

                    foreach (var accountType in orderedTypes)
                    {
                        var typeDisplayName = Models.AccountType.GetDisplayName(accountType);
                        
                        // Get all accounts of this type in this subsection
                        var accountsOfType = accountMap.Values
                            .Where(r => r.Section == section && 
                                       r.Subsection == subsection &&
                                       r.AccountType == accountType)
                            .ToList();

                        if (!accountsOfType.Any())
                            continue;

                        // Add type header
                        var typeHeader = new BalanceSheetRow
                        {
                            Section = section,
                            Subsection = subsection,
                            AccountName = typeDisplayName,
                            AccountType = accountType,
                            IsTypeHeader = true,
                            TypeCategory = typeDisplayName,
                            IsCalculated = false,
                            Source = "TypeHeader",
                            Level = 0
                        };
                        rows.Add(typeHeader);

                        // Track start row for type subtotal (will be set by frontend)
                        var typeStartRow = rows.Count;

                        // Get top-level accounts of this type (no parent, or parent not of this type)
                        var typeTopLevel = topLevelAccounts
                            .Where(acctNum => accountMap.ContainsKey(acctNum) &&
                                             accountMap[acctNum].Section == section &&
                                             accountMap[acctNum].Subsection == subsection &&
                                             accountMap[acctNum].AccountType == accountType)
                            .OrderBy(acctNum => accountMap[acctNum].AccountNumber)
                            .ToList();

                        // Also include accounts that have parents, but their parent is not of this type
                        var typeOrphaned = accountMap.Values
                            .Where(r => r.Section == section && 
                                       r.Subsection == subsection &&
                                       r.AccountType == accountType &&
                                       !string.IsNullOrEmpty(r.ParentAccount) &&
                                       (!accountMap.ContainsKey(r.ParentAccount) ||
                                        accountMap[r.ParentAccount].AccountType != accountType))
                            .Select(r => r.AccountNumber ?? "")
                            .OrderBy(acctNum => acctNum)
                            .ToList();

                        // Add top-level accounts of this type hierarchically
                        foreach (var topLevelAcct in typeTopLevel)
                        {
                            AddAccountHierarchy(topLevelAcct, rows, section, subsection);
                        }

                        // Add orphaned accounts of this type
                        foreach (var orphanAcct in typeOrphaned)
                        {
                            if (accountMap.ContainsKey(orphanAcct))
                            {
                                rows.Add(accountMap[orphanAcct]);
                                // Add children if any
                                if (accountTree.ContainsKey(orphanAcct))
                                {
                                    var children = accountTree[orphanAcct]
                                        .Where(c => accountMap.ContainsKey(c) &&
                                                   accountMap[c].Section == section &&
                                                   accountMap[c].Subsection == subsection &&
                                                   accountMap[c].AccountType == accountType)
                                        .OrderBy(n => n)
                                        .ToList();
                                    
                                    foreach (var childNum in children)
                                    {
                                        AddAccountHierarchy(childNum, rows, section, subsection);
                                    }
                                    
                                    // Add subtotal if there are children
                                    if (children.Any())
                                    {
                                        var childBalances = children
                                            .Select(c => accountMap[c].Balance)
                                            .ToList();
                                        
                                        var subtotal = new BalanceSheetRow
                                        {
                                            Section = section,
                                            Subsection = subsection,
                                            AccountName = $"Total {accountMap[orphanAcct].AccountName}",
                                            IsSubtotal = true,
                                            SubtotalFor = orphanAcct,
                                            Balance = childBalances.Sum(),
                                            IsCalculated = true,
                                            Source = "Subtotal",
                                            Level = accountMap[orphanAcct].Level + 1
                                        };
                                        rows.Add(subtotal);
                                    }
                                }
                            }
                        }

                        // Add type subtotal (sum of all accounts of this type, including parent accounts with balances)
                        var typeAccountBalances = accountsOfType
                            .Where(a => !a.IsParentHeader || a.Balance != 0) // Include parent headers only if they have balances
                            .Select(a => a.Balance)
                            .ToList();
                        
                        if (typeAccountBalances.Any())
                        {
                            var typeSubtotal = new BalanceSheetRow
                            {
                                Section = section,
                                Subsection = subsection,
                                AccountName = $"Total {typeDisplayName}",
                                AccountType = accountType,
                                IsSubtotal = true,
                                Balance = typeAccountBalances.Sum(),
                                IsCalculated = true,
                                Source = "TypeSubtotal",
                                Level = 1
                            };
                            rows.Add(typeSubtotal);
                        }
                    }
                }
            }

            // Calculate special formulas (only if not skipped)
            if (request.SkipCalculatedRows)
            {
                _logger.LogInformation("⏭️  Step 3: Skipping calculated rows (NETINCOME, RETAINEDEARNINGS, CTA) - will be added separately");
            }
            else
            {
                _logger.LogInformation("🔄 Step 3: Calculating special rows (NETINCOME, RETAINEDEARNINGS, CTA)...");
                var calcStartTime = DateTime.UtcNow;

                // Get fiscal year info for special formulas
                var fyInfo = await GetFiscalYearInfoAsync(request.Period, accountingBook);
                if (fyInfo == null)
                {
                    _logger.LogWarning("Could not get fiscal year info - skipping calculated rows");
                }
                else
                {
                // Calculate NETINCOME
                decimal netIncome = 0;
                try
                {
                    var netIncomeRequest = new NetIncomeRequest
                    {
                        Period = request.Period,
                        Subsidiary = request.Subsidiary,
                        Department = request.Department,
                        Class = request.Class,
                        Location = request.Location,
                        Book = request.Book
                    };
                    // Call net-income endpoint logic inline (simplified)
                    var plTypesSql = "'Income', 'COGS', 'Expense', 'OthIncome', 'OthExpense'";
                    var fyStartDate = ConvertToYYYYMMDD(fyInfo.FyStart);
                    var netIncomeQuery = $@"
                        SELECT SUM(
                            TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', {targetSub}, {targetPeriodId}, 'DEFAULT'))
                            * -1
                        ) AS value
                        FROM transactionaccountingline tal
                        JOIN transaction t ON t.id = tal.transaction
                        JOIN account a ON a.id = tal.account
                        JOIN accountingperiod ap ON ap.id = t.postingperiod
                        JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
                        WHERE t.posting = 'T'
                          AND tal.posting = 'T'
                          AND a.accttype IN ({plTypesSql})
                          AND ap.startdate >= TO_DATE('{fyStartDate}', 'YYYY-MM-DD')
                          AND ap.enddate <= TO_DATE('{periodEndDate}', 'YYYY-MM-DD')
                          AND tal.accountingbook = {accountingBook}
                          AND {segmentWhere}";
                    var niResults = await _netSuiteService.QueryRawAsync(netIncomeQuery, 120);
                    if (niResults.Any())
                    {
                        var niRow = niResults.First();
                        netIncome = ParseBalance(niRow.TryGetProperty("value", out var niProp) ? niProp : default);
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "Error calculating Net Income");
                }

                // Calculate RETAINEDEARNINGS
                decimal retainedEarnings = 0;
                try
                {
                    var plTypesSql = "'Income', 'COGS', 'Expense', 'OthIncome', 'OthExpense'";
                    var fyStartDate = ConvertToYYYYMMDD(fyInfo.FyStart);
                    // Prior P&L
                    var priorPlQuery = $@"
                        SELECT SUM(
                            TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', {targetSub}, {targetPeriodId}, 'DEFAULT'))
                            * -1
                        ) AS value
                        FROM transactionaccountingline tal
                        JOIN transaction t ON t.id = tal.transaction
                        JOIN account a ON a.id = tal.account
                        JOIN accountingperiod ap ON ap.id = t.postingperiod
                        JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
                        WHERE t.posting = 'T'
                          AND tal.posting = 'T'
                          AND a.accttype IN ({plTypesSql})
                          AND ap.enddate < TO_DATE('{fyStartDate}', 'YYYY-MM-DD')
                          AND tal.accountingbook = {accountingBook}
                          AND {segmentWhere}";
                    var priorPlResults = await _netSuiteService.QueryRawAsync(priorPlQuery, 120);
                    decimal priorPl = priorPlResults.Any() 
                        ? ParseBalance(priorPlResults.First().TryGetProperty("value", out var ppProp) ? ppProp : default)
                        : 0;
                    
                    // Posted RE
                    var postedReQuery = $@"
                        SELECT SUM(
                            TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', {targetSub}, {targetPeriodId}, 'DEFAULT'))
                            * -1
                        ) AS value
                        FROM transactionaccountingline tal
                        JOIN transaction t ON t.id = tal.transaction
                        JOIN account a ON a.id = tal.account
                        JOIN accountingperiod ap ON ap.id = t.postingperiod
                        JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
                        WHERE t.posting = 'T'
                          AND tal.posting = 'T'
                          AND (a.accttype = 'RetainedEarnings' OR LOWER(a.fullname) LIKE '%retained earnings%')
                          AND ap.enddate <= TO_DATE('{periodEndDate}', 'YYYY-MM-DD')
                          AND tal.accountingbook = {accountingBook}
                          AND {segmentWhere}";
                    var postedReResults = await _netSuiteService.QueryRawAsync(postedReQuery, 120);
                    decimal postedRe = postedReResults.Any()
                        ? ParseBalance(postedReResults.First().TryGetProperty("value", out var prProp) ? prProp : default)
                        : 0;
                    
                    retainedEarnings = priorPl + postedRe;
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "Error calculating Retained Earnings");
                }

                // Calculate CTA using plug method
                decimal cta = 0;
                try
                {
                    var assetTypesSql = AccountType.BsAssetTypesSql;
                    var liabilityTypesSql = AccountType.BsLiabilityTypesSql;
                    var plTypesSql = "'Income', 'COGS', 'Expense', 'OthIncome', 'OthExpense'";
                    
                    // Total Assets
                    var assetsQuery = $@"
                        SELECT SUM(
                            TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', {targetSub}, {targetPeriodId}, 'DEFAULT'))
                        ) AS value
                        FROM transactionaccountingline tal
                        JOIN transaction t ON t.id = tal.transaction
                        JOIN account a ON a.id = tal.account
                        JOIN accountingperiod ap ON ap.id = t.postingperiod
                        WHERE t.posting = 'T'
                          AND tal.posting = 'T'
                          AND a.accttype IN ({assetTypesSql})
                          AND ap.enddate <= TO_DATE('{periodEndDate}', 'YYYY-MM-DD')
                          AND ap.isyear = 'F'
                          AND ap.isquarter = 'F'
                          AND tal.accountingbook = {accountingBook}";
                    
                    // Total Liabilities
                    var liabilitiesQuery = $@"
                        SELECT SUM(
                            TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', {targetSub}, {targetPeriodId}, 'DEFAULT'))
                            * -1
                        ) AS value
                        FROM transactionaccountingline tal
                        JOIN transaction t ON t.id = tal.transaction
                        JOIN account a ON a.id = tal.account
                        JOIN accountingperiod ap ON ap.id = t.postingperiod
                        WHERE t.posting = 'T'
                          AND tal.posting = 'T'
                          AND a.accttype IN ({liabilityTypesSql})
                          AND ap.enddate <= TO_DATE('{periodEndDate}', 'YYYY-MM-DD')
                          AND ap.isyear = 'F'
                          AND ap.isquarter = 'F'
                          AND tal.accountingbook = {accountingBook}";
                    
                    // Posted Equity (excluding RE)
                    var equityQuery = $@"
                        SELECT SUM(
                            TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', {targetSub}, {targetPeriodId}, 'DEFAULT'))
                            * -1
                        ) AS value
                        FROM transactionaccountingline tal
                        JOIN transaction t ON t.id = tal.transaction
                        JOIN account a ON a.id = tal.account
                        JOIN accountingperiod ap ON ap.id = t.postingperiod
                        WHERE t.posting = 'T'
                          AND tal.posting = 'T'
                          AND a.accttype = 'Equity'
                          AND LOWER(a.fullname) NOT LIKE '%retained earnings%'
                          AND ap.enddate <= TO_DATE('{periodEndDate}', 'YYYY-MM-DD')
                          AND ap.isyear = 'F'
                          AND ap.isquarter = 'F'
                          AND tal.accountingbook = {accountingBook}";
                    
                    var assetsTask = _netSuiteService.QueryRawAsync(assetsQuery, 120);
                    var liabilitiesTask = _netSuiteService.QueryRawAsync(liabilitiesQuery, 120);
                    var equityTask = _netSuiteService.QueryRawAsync(equityQuery, 120);
                    
                    await Task.WhenAll(assetsTask, liabilitiesTask, equityTask);
                    
                    decimal ctaTotalAssets = assetsTask.Result.Any()
                        ? ParseBalance(assetsTask.Result.First().TryGetProperty("value", out var aProp) ? aProp : default)
                        : 0;
                    decimal ctaTotalLiabilities = liabilitiesTask.Result.Any()
                        ? ParseBalance(liabilitiesTask.Result.First().TryGetProperty("value", out var lProp) ? lProp : default)
                        : 0;
                    decimal ctaPostedEquity = equityTask.Result.Any()
                        ? ParseBalance(equityTask.Result.First().TryGetProperty("value", out var eProp) ? eProp : default)
                        : 0;
                    
                    // Prior P&L (for CTA calculation)
                    var fyStartDate = ConvertToYYYYMMDD(fyInfo.FyStart);
                    var priorPlQuery = $@"
                        SELECT SUM(
                            TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', {targetSub}, {targetPeriodId}, 'DEFAULT'))
                            * -1
                        ) AS value
                        FROM transactionaccountingline tal
                        JOIN transaction t ON t.id = tal.transaction
                        JOIN account a ON a.id = tal.account
                        JOIN accountingperiod ap ON ap.id = t.postingperiod
                        WHERE t.posting = 'T'
                          AND tal.posting = 'T'
                          AND a.accttype IN ({plTypesSql})
                          AND ap.enddate < TO_DATE('{fyStartDate}', 'YYYY-MM-DD')
                          AND ap.isyear = 'F'
                          AND ap.isquarter = 'F'
                          AND tal.accountingbook = {accountingBook}";
                    
                    // Posted RE (for CTA)
                    var postedReQuery = $@"
                        SELECT SUM(
                            TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', {targetSub}, {targetPeriodId}, 'DEFAULT'))
                            * -1
                        ) AS value
                        FROM transactionaccountingline tal
                        JOIN transaction t ON t.id = tal.transaction
                        JOIN account a ON a.id = tal.account
                        JOIN accountingperiod ap ON ap.id = t.postingperiod
                        WHERE t.posting = 'T'
                          AND tal.posting = 'T'
                          AND (a.accttype = 'RetainedEarnings' OR LOWER(a.fullname) LIKE '%retained earnings%')
                          AND ap.enddate <= TO_DATE('{periodEndDate}', 'YYYY-MM-DD')
                          AND ap.isyear = 'F'
                          AND ap.isquarter = 'F'
                          AND tal.accountingbook = {accountingBook}";
                    
                    var priorPlTask = _netSuiteService.QueryRawAsync(priorPlQuery, 120);
                    var postedReTask = _netSuiteService.QueryRawAsync(postedReQuery, 120);
                    await Task.WhenAll(priorPlTask, postedReTask);
                    
                    decimal priorPl = priorPlTask.Result.Any()
                        ? ParseBalance(priorPlTask.Result.First().TryGetProperty("value", out var ppProp) ? ppProp : default)
                        : 0;
                    decimal postedRe = postedReTask.Result.Any()
                        ? ParseBalance(postedReTask.Result.First().TryGetProperty("value", out var prProp) ? prProp : default)
                        : 0;
                    
                    // CTA = Assets - Liabilities - Equity - Prior P&L - Posted RE - Net Income
                    cta = ctaTotalAssets - ctaTotalLiabilities - ctaPostedEquity - priorPl - postedRe - netIncome;
                }
                catch (Exception ex)
                {
                    var calcElapsedError = (DateTime.UtcNow - calcStartTime).TotalSeconds;
                    _logger.LogWarning(ex, "Error calculating CTA after {Elapsed:F1}s", calcElapsedError);
                }
                
                var calcElapsedFinal = (DateTime.UtcNow - calcStartTime).TotalSeconds;
                _logger.LogInformation("✅ Step 3 complete: Calculated special rows in {Elapsed:F1}s (NETINCOME={NetInc}, RE={RE}, CTA={CTA})",
                    calcElapsedFinal, netIncome, retainedEarnings, cta);

                // Add calculated rows to Equity section (in correct order)
                var equityRows = rows.Where(r => r.Section == "Equity").ToList();
                var equityInsertIndex = rows.FindIndex(r => r.Section == "Equity");
                
                // Insert NETINCOME before retained earnings accounts
                var retainedEarningsAccounts = equityRows.Where(r => r.AccountType == AccountType.RetainedEarnings).ToList();
                int netIncomeIndex = retainedEarningsAccounts.Any()
                    ? rows.FindIndex(r => r.AccountNumber == retainedEarningsAccounts.First().AccountNumber)
                    : equityInsertIndex + equityRows.Count;

                rows.Insert(netIncomeIndex, new BalanceSheetRow
                {
                    Section = "Equity",
                    Subsection = "Equity",
                    AccountNumber = null,
                    AccountName = "Net Income",
                    AccountType = "Calculated",
                    ParentAccount = null,
                    Balance = netIncome,
                    IsCalculated = true,
                    Source = "Calculated",
                    Level = 0
                });

                // Insert RETAINEDEARNINGS after NETINCOME
                int reIndex = rows.FindIndex(r => r.IsCalculated && r.AccountName == "Net Income") + 1;
                rows.Insert(reIndex, new BalanceSheetRow
                {
                    Section = "Equity",
                    Subsection = "Equity",
                    AccountNumber = null,
                    AccountName = "Retained Earnings",
                    AccountType = "Calculated",
                    ParentAccount = null,
                    Balance = retainedEarnings,
                    IsCalculated = true,
                    Source = "Calculated",
                    Level = 0
                });

                // Insert CTA after RETAINEDEARNINGS
                int ctaIndex = rows.FindIndex(r => r.IsCalculated && r.AccountName == "Retained Earnings") + 1;
                rows.Insert(ctaIndex, new BalanceSheetRow
                {
                    Section = "Equity",
                    Subsection = "Equity",
                    AccountNumber = null,
                    AccountName = "Cumulative Translation Adjustment",
                    AccountType = "Calculated",
                    ParentAccount = null,
                    Balance = cta,
                    IsCalculated = true,
                    Source = "Calculated",
                    Level = 0
                });
                }
            }

            // Calculate totals
            var totalAssets = rows.Where(r => r.Section == "Assets").Sum(r => r.Balance);
            var totalLiabilities = rows.Where(r => r.Section == "Liabilities").Sum(r => r.Balance);
            var totalEquity = rows.Where(r => r.Section == "Equity").Sum(r => r.Balance);

            var totalElapsed = (DateTime.UtcNow - startTime).TotalSeconds;
            _logger.LogInformation("═══════════════════════════════════════════════════════");
            _logger.LogInformation("✅ BALANCE SHEET REPORT COMPLETE");
            _logger.LogInformation("   Accounts: {AccountCount}", accountMap.Count);
            _logger.LogInformation("   Total rows: {RowCount}", rows.Count);
            _logger.LogInformation("   Total time: {Elapsed:F1}s", totalElapsed);
            _logger.LogInformation("═══════════════════════════════════════════════════════");

            return Ok(new BalanceSheetReportResponse
            {
                Rows = rows,
                Period = request.Period,
                TotalAssets = totalAssets,
                TotalLiabilities = totalLiabilities,
                TotalEquity = totalEquity
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error generating Balance Sheet report");
            return StatusCode(500, new { error = ex.Message });
        }
    }
    
    /// <summary>
    /// Helper to get fiscal year info for a period (used by special formulas).
    /// </summary>
    private async Task<FiscalYearInfo?> GetFiscalYearInfoAsync(string periodName, int accountingBook)
    {
        try
        {
            var periodData = await _netSuiteService.GetPeriodAsync(periodName);
            if (periodData == null)
                return null;

            // Get fiscal year start
            var fyQuery = $@"
                SELECT MIN(startdate) AS fy_start
                FROM accountingperiod
                WHERE EXTRACT(YEAR FROM startdate) = EXTRACT(YEAR FROM TO_DATE('{ConvertToYYYYMMDD(periodData.StartDate)}', 'YYYY-MM-DD'))
                  AND isyear = 'F'
                  AND isquarter = 'F'
                  AND isadjust = 'F'";
            
            var fyResults = await _netSuiteService.QueryRawAsync(fyQuery);
            if (!fyResults.Any())
                return null;

            var fyStartStr = fyResults.First().TryGetProperty("fy_start", out var fyProp) 
                ? fyProp.GetString() : null;
            
            if (string.IsNullOrEmpty(fyStartStr))
                return null;

            return new FiscalYearInfo
            {
                FyStart = ConvertToYYYYMMDD(fyStartStr),
                PeriodEnd = ConvertToYYYYMMDD(periodData.EndDate),
                PeriodId = periodData.Id
            };
        }
        catch
        {
            return null;
        }
    }
    
    private class FiscalYearInfo
    {
        public string FyStart { get; set; } = "";
        public string PeriodEnd { get; set; } = "";
        public string? PeriodId { get; set; }
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

/// <summary>
/// Request for TARGETED Balance Sheet preload.
/// Only loads specific accounts (from sheet scan) instead of all BS accounts.
/// </summary>
public class TargetedBsPreloadRequest
{
    /// <summary>Specific account numbers to preload</summary>
    public List<string> Accounts { get; set; } = new();
    
    /// <summary>Periods to preload</summary>
    public List<string> Periods { get; set; } = new();
    
    public string? Subsidiary { get; set; }
    public string? Department { get; set; }
    public string? Class { get; set; }
    public string? Location { get; set; }
    public int? Book { get; set; }
}

