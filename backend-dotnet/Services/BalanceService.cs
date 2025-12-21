/*
 * XAVI for NetSuite - Balance Service
 *
 * Copyright (c) 2025 Celigo, Inc.
 * All rights reserved.
 *
 * This service handles GL balance queries, including single account,
 * batch, and type balance calculations.
 *
 * INVARIANT ENFORCEMENT (see docs/PERFORMANCE-INVARIANTS.md):
 * - Batch queries use GetBatchBalanceAsync() to minimize NetSuite calls
 * - All queries route through the governor for concurrency control
 * - Pagination (when used) exhausts all pages before returning
 * - Safety limits fail loudly with explicit error messages
 */

using System.Text.Json;
using Microsoft.Extensions.Caching.Memory;
using XaviApi.Configuration;
using XaviApi.Models;
using Microsoft.Extensions.Options;

namespace XaviApi.Services;

/// <summary>
/// Service for GL balance queries and calculations.
/// </summary>
public class BalanceService : IBalanceService
{
    private readonly INetSuiteService _netSuiteService;
    private readonly ILookupService _lookupService;
    private readonly IMemoryCache _cache;
    private readonly CacheConfig _cacheConfig;
    private readonly ILogger<BalanceService> _logger;
    
    // Default accounting book (Primary Book)
    private const int DefaultAccountingBook = 1;

    public BalanceService(
        INetSuiteService netSuiteService,
        ILookupService lookupService,
        IMemoryCache cache,
        IOptions<CacheConfig> cacheConfig,
        ILogger<BalanceService> logger)
    {
        _netSuiteService = netSuiteService;
        _lookupService = lookupService;
        _cache = cache;
        _cacheConfig = cacheConfig.Value;
        _logger = logger;
    }
    
    /// <summary>
    /// Parse a balance value from JSON, handling scientific notation (e.g., "2.402086483E7").
    /// </summary>
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
            
            // Handle scientific notation (e.g., "2.402086483E7")
            if (double.TryParse(strVal, System.Globalization.NumberStyles.Float, 
                                System.Globalization.CultureInfo.InvariantCulture, out var dblVal))
            {
                return (decimal)dblVal;
            }
            
            // Fallback to decimal parsing
            if (decimal.TryParse(strVal, out var decVal))
                return decVal;
        }
        
        return 0;
    }

    /// <summary>
    /// Get balance for a single account with optional filters.
    /// Properly handles consolidated subsidiaries and uses optimized queries.
    /// 
    /// CRITICAL: Balance Sheet accounts use CUMULATIVE balance (inception through to_period).
    /// P&L accounts use PERIOD RANGE balance (from_period through to_period).
    /// </summary>
    public async Task<BalanceResponse> GetBalanceAsync(BalanceRequest request)
    {
        var fromPeriod = request.FromPeriod;
        var toPeriod = string.IsNullOrEmpty(request.ToPeriod) ? request.FromPeriod : request.ToPeriod;

        // Handle year-only format
        if (NetSuiteService.IsYearOnly(fromPeriod))
        {
            var (from, to) = NetSuiteService.ExpandYearToPeriods(fromPeriod);
            fromPeriod = from;
            toPeriod = to;
        }

        // ========================================================================
        // AUTO-DETECT BALANCE SHEET ACCOUNTS
        // BS accounts need CUMULATIVE balance (inception through to_period)
        // P&L accounts need PERIOD RANGE balance (from_period through to_period)
        // ========================================================================
        bool isBsAccount = false;
        string? detectedAccountType = null;
        
        if (!string.IsNullOrEmpty(request.Account) && !request.Account.Contains('*'))
        {
            // For single account, query its type
            var typeQuery = $"SELECT accttype FROM Account WHERE acctnumber = '{NetSuiteService.EscapeSql(request.Account)}'";
            var typeResult = await _netSuiteService.QueryRawAsync(typeQuery);
            if (typeResult.Any())
            {
                var acctType = typeResult.First().TryGetProperty("accttype", out var typeProp) 
                    ? typeProp.GetString() ?? "" : "";
                detectedAccountType = acctType;
                isBsAccount = AccountType.IsBalanceSheet(acctType);
                _logger.LogDebug("Account {Account} type: {Type}, is_bs: {IsBs}", request.Account, acctType, isBsAccount);
            }
        }
        else if (!string.IsNullOrEmpty(request.Account) && request.Account.Contains('*'))
        {
            // For wildcard accounts, check if ALL matching accounts are BS or P&L
            var wildcardFilter = NetSuiteService.BuildAccountFilter(new[] { request.Account }, "acctnumber");
            var typeQuery = $"SELECT DISTINCT accttype FROM Account WHERE {wildcardFilter}";
            var typeResult = await _netSuiteService.QueryRawAsync(typeQuery);
            if (typeResult.Any())
            {
                var types = typeResult.Select(r => r.TryGetProperty("accttype", out var p) ? p.GetString() ?? "" : "").ToList();
                var bsTypes = types.Where(AccountType.IsBalanceSheet).ToList();
                var plTypes = types.Where(t => !AccountType.IsBalanceSheet(t)).ToList();
                
                if (bsTypes.Any() && !plTypes.Any())
                {
                    isBsAccount = true;
                    _logger.LogDebug("Wildcard {Account}: ALL matching accounts are BS", request.Account);
                }
                else if (plTypes.Any() && !bsTypes.Any())
                {
                    isBsAccount = false;
                    _logger.LogDebug("Wildcard {Account}: ALL matching accounts are P&L", request.Account);
                }
                else
                {
                    // Mixed types - default to P&L behavior (safer)
                    isBsAccount = false;
                    _logger.LogDebug("Wildcard {Account}: MIXED types - using P&L behavior", request.Account);
                }
            }
        }

        // For BS accounts, ignore from_period (use cumulative from inception)
        if (isBsAccount && !string.IsNullOrEmpty(fromPeriod) && !string.IsNullOrEmpty(toPeriod))
        {
            _logger.LogDebug("BS account detected: using cumulative through {ToPeriod} (ignoring from_period={FromPeriod})", toPeriod, fromPeriod);
            fromPeriod = ""; // Clear from_period for cumulative calculation
        }

        // Get period dates
        var toPeriodData = await _netSuiteService.GetPeriodAsync(toPeriod);

        if (toPeriodData?.EndDate == null)
        {
            _logger.LogWarning("Could not find period dates for {To}", toPeriod);
            return new BalanceResponse
            {
                Account = request.Account,
                FromPeriod = request.FromPeriod,
                ToPeriod = toPeriod,
                Balance = 0
            };
        }

        // Convert dates to YYYY-MM-DD format
        var toEndDate = ConvertToYYYYMMDD(toPeriodData.EndDate);
        var fromStartDate = "";
        if (!string.IsNullOrEmpty(fromPeriod))
        {
            var fromPeriodData = await _netSuiteService.GetPeriodAsync(fromPeriod);
            if (fromPeriodData?.StartDate != null)
                fromStartDate = ConvertToYYYYMMDD(fromPeriodData.StartDate);
        }

        // Resolve subsidiary name to ID and get hierarchy
        var subsidiaryId = await _lookupService.ResolveSubsidiaryIdAsync(request.Subsidiary);
        var targetSub = subsidiaryId ?? "1";
        
        // Get subsidiary hierarchy (all children for consolidated view)
        var hierarchySubs = await _lookupService.GetSubsidiaryHierarchyAsync(targetSub);
        var subFilter = string.Join(", ", hierarchySubs);

        // Resolve other dimension names to IDs
        var departmentId = await _lookupService.ResolveDimensionIdAsync("department", request.Department);
        var classId = await _lookupService.ResolveDimensionIdAsync("class", request.Class);
        var locationId = await _lookupService.ResolveDimensionIdAsync("location", request.Location);

        // OPTIMIZATION: For root consolidated subsidiary with no other filters,
        // skip the TransactionLine join entirely (it includes ALL subs anyway)
        var needsTransactionLineJoin = !string.IsNullOrEmpty(departmentId) || 
                                        !string.IsNullOrEmpty(classId) || 
                                        !string.IsNullOrEmpty(locationId) ||
                                        targetSub != "1"; // Only root can skip
        
        // Build segment filters using TransactionLine (tl) if needed
        var segmentFilters = new List<string>();
        if (needsTransactionLineJoin)
        {
            segmentFilters.Add($"tl.subsidiary IN ({subFilter})");
            if (!string.IsNullOrEmpty(departmentId))
                segmentFilters.Add($"tl.department = {departmentId}");
            if (!string.IsNullOrEmpty(classId))
                segmentFilters.Add($"tl.class = {classId}");
            if (!string.IsNullOrEmpty(locationId))
                segmentFilters.Add($"tl.location = {locationId}");
        }
        var segmentWhere = segmentFilters.Any() ? string.Join(" AND ", segmentFilters) : "1=1";

        var accountingBook = request.Book ?? DefaultAccountingBook;

        // ========================================================================
        // CACHE CHECK: For single non-wildcard accounts, check if we have a cached balance
        // This is populated by the /batch/bs_preload endpoint for instant lookups
        // ========================================================================
        if (!request.Account.Contains('*'))
        {
            var filtersHash = $"{targetSub}:{departmentId ?? ""}:{locationId ?? ""}:{classId ?? ""}";
            var cacheKey = $"balance:{request.Account}:{toPeriod}:{filtersHash}";
            
            if (_cache.TryGetValue(cacheKey, out decimal cachedBalance))
            {
                _logger.LogInformation("⚡ CACHE HIT: {Account} for {Period} = ${Balance:N2}", 
                    request.Account, toPeriod, cachedBalance);
                return new BalanceResponse
                {
                    Account = request.Account,
                    FromPeriod = request.FromPeriod,
                    ToPeriod = toPeriod,
                    Balance = cachedBalance,
                    Cached = true
                };
            }
        }

        string query;
        int queryTimeout;
        
        if (isBsAccount)
        {
            // BALANCE SHEET: Cumulative from inception through to_period
            // Use t.trandate (transaction date) instead of ap.startdate/enddate
            // 
            // SIGN FLIP for Balance Sheet:
            // - Assets (Bank, AcctRec, FixedAsset, etc.): Stored positive (debit balance) → NO FLIP
            // - Liabilities (AcctPay, CredCard, LongTermLiab, etc.): Stored negative (credit balance) → FLIP to positive
            // - Equity (Equity, RetainedEarnings): Stored negative (credit balance) → FLIP to positive
            //
            // This matches NetSuite's standard Balance Sheet report display.
            var signFlip = $"CASE WHEN a.accttype IN ({AccountType.SignFlipTypesSql}) THEN -1 ELSE 1 END";
            
            // Use longer timeout for cumulative BS queries (they scan all historical data)
            // NetSuite CONSOLIDATE over all historical data can take 2-3 minutes
            queryTimeout = 180;
            
            // OPTIMIZATION: Skip TransactionLine join for root consolidated subsidiary with no filters
            var tlJoin = needsTransactionLineJoin 
                ? "JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id" 
                : "";
            var whereSegment = needsTransactionLineJoin ? $"AND {segmentWhere}" : "";
            
            _logger.LogDebug("BS query: needsTlJoin={NeedsTl}, toEndDate={EndDate}, sub={Sub}", 
                needsTransactionLineJoin, toEndDate, targetSub);
            
            query = $@"
                SELECT SUM(x.cons_amt) AS balance
                FROM (
                    SELECT
                        TO_NUMBER(
                            BUILTIN.CONSOLIDATE(
                                tal.amount,
                                'LEDGER',
                                'DEFAULT',
                                'DEFAULT',
                                {targetSub},
                                t.postingperiod,
                                'DEFAULT'
                            )
                        ) * {signFlip} AS cons_amt
                    FROM transactionaccountingline tal
                    JOIN transaction t ON t.id = tal.transaction
                    JOIN account a ON a.id = tal.account
                    {tlJoin}
                    WHERE t.posting = 'T'
                      AND tal.posting = 'T'
                      AND {NetSuiteService.BuildAccountFilter(new[] { request.Account })}
                      AND t.trandate <= TO_DATE('{toEndDate}', 'YYYY-MM-DD')
                      AND tal.accountingbook = {accountingBook}
                      {whereSegment}
                ) x";
        }
        else
        {
            // P&L: Period range from from_period to to_period
            // Sign flip for Income types (credits stored negative, display positive)
            var signFlip = $"CASE WHEN a.accttype IN ({AccountType.IncomeTypesSql}) THEN -1 ELSE 1 END";
            
            // Standard timeout for P&L queries
            queryTimeout = 30;
            
            // Need from_period for P&L
            if (string.IsNullOrEmpty(fromStartDate))
            {
                _logger.LogWarning("P&L account but no from_period specified, using to_period as range");
                fromStartDate = ConvertToYYYYMMDD(toPeriodData.StartDate ?? toPeriodData.EndDate!);
            }

            query = $@"
                SELECT SUM(x.cons_amt) AS balance
                FROM (
                    SELECT
                        TO_NUMBER(
                            BUILTIN.CONSOLIDATE(
                                tal.amount,
                                'LEDGER',
                                'DEFAULT',
                                'DEFAULT',
                                {targetSub},
                                t.postingperiod,
                                'DEFAULT'
                            )
                        ) * {signFlip} AS cons_amt
                    FROM transactionaccountingline tal
                    JOIN transaction t ON t.id = tal.transaction
                    JOIN account a ON a.id = tal.account
                    JOIN accountingperiod ap ON ap.id = t.postingperiod
                    JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
                    WHERE t.posting = 'T'
                      AND tal.posting = 'T'
                      AND {NetSuiteService.BuildAccountFilter(new[] { request.Account })}
                      AND ap.startdate >= TO_DATE('{fromStartDate}', 'YYYY-MM-DD')
                      AND ap.enddate <= TO_DATE('{toEndDate}', 'YYYY-MM-DD')
                      AND tal.accountingbook = {accountingBook}
                      AND {segmentWhere}
                ) x";
        }

        // Use error-aware query method to propagate failures to Excel
        var queryResult = await _netSuiteService.QueryRawWithErrorAsync(query, queryTimeout);
        
        // INVARIANT: Errors fail loudly - return informative error code to Excel
        if (!queryResult.Success)
        {
            _logger.LogWarning("Balance query failed with {ErrorCode}: {Details}", 
                queryResult.ErrorCode, queryResult.ErrorDetails);
            
            return new BalanceResponse
            {
                Account = request.Account,
                FromPeriod = request.FromPeriod,
                ToPeriod = toPeriod,
                Balance = 0,
                Error = queryResult.ErrorCode // One-word error for Excel cell
            };
        }

        decimal balance = 0;
        string? accountName = null;
        string? accountType = detectedAccountType;

        if (queryResult.Items.Any())
        {
            var row = queryResult.Items.First();
            
            if (row.TryGetProperty("balance", out var balProp))
            {
                balance = ParseBalance(balProp);
            }
        }

        // Get account name and type from lookup service
        accountName = await _lookupService.GetAccountNameAsync(request.Account);
        if (accountType == null)
            accountType = await _lookupService.GetAccountTypeAsync(request.Account);

        return new BalanceResponse
        {
            Account = request.Account,
            AccountName = accountName,
            AccountType = accountType,
            FromPeriod = request.FromPeriod, // Return original request periods
            ToPeriod = toPeriod,
            Balance = balance
            // Error is null (success) - not included in JSON due to JsonIgnoreCondition.WhenWritingNull
        };
    }

    /// <summary>
    /// Get balances for multiple accounts and periods in a single batch.
    /// Uses proper TransactionLine join and subsidiary hierarchy.
    /// 
    /// CRITICAL OPTIMIZATION (from Python):
    /// - P&L accounts: ONE query for all accounts × all periods
    /// - BS accounts: ONE query per period for ALL BS accounts (cumulative needs per-period calculation)
    /// - Check cache first before making queries (populated by full year refresh)
    /// </summary>
    public async Task<BatchBalanceResponse> GetBatchBalanceAsync(BatchBalanceRequest request)
    {
        var result = new BatchBalanceResponse
        {
            Balances = new Dictionary<string, Dictionary<string, decimal>>(),
            AccountTypes = new Dictionary<string, string>()
        };

        if (!request.Accounts.Any() || !request.Periods.Any())
            return result;

        // Build filters hash for cache key
        var subsidiaryId = await _lookupService.ResolveSubsidiaryIdAsync(request.Subsidiary);
        var targetSub = subsidiaryId ?? "1";
        var departmentId = await _lookupService.ResolveDimensionIdAsync("department", request.Department);
        var classId = await _lookupService.ResolveDimensionIdAsync("class", request.Class);
        var locationId = await _lookupService.ResolveDimensionIdAsync("location", request.Location);
        var filtersHash = $"{targetSub}:{departmentId ?? ""}:{locationId ?? ""}:{classId ?? ""}";
        
        // CACHE CHECK: Try to serve entirely from cache (like Python's balance_cache)
        var allInCache = true;
        var cachedBalances = new Dictionary<string, Dictionary<string, decimal>>();
        
        foreach (var account in request.Accounts)
        {
            cachedBalances[account] = new Dictionary<string, decimal>();
            foreach (var period in request.Periods)
            {
                var cacheKey = $"balance:{account}:{period}:{filtersHash}";
                if (_cache.TryGetValue(cacheKey, out decimal cachedBalance))
                {
                    cachedBalances[account][period] = cachedBalance;
                }
                else
                {
                    allInCache = false;
                }
            }
        }
        
        if (allInCache)
        {
            _logger.LogInformation("⚡ BACKEND CACHE HIT: {Accounts} accounts × {Periods} periods", 
                request.Accounts.Count, request.Periods.Count);
            result.Balances = cachedBalances;
            result.Cached = true;
            return result;
        }
        _logger.LogDebug("Cache miss - querying NetSuite");

        // Expand periods that are year-only
        var expandedPeriods = request.Periods.SelectMany(p =>
        {
            if (NetSuiteService.IsYearOnly(p))
            {
                var (from, to) = NetSuiteService.ExpandYearToPeriods(p);
                return GenerateMonthlyPeriods(from, to);
            }
            return new[] { p };
        }).Distinct().ToList();

        // Get all period dates (with ID for BS CONSOLIDATE)
        var periodInfo = new Dictionary<string, (string? Start, string? End, string? Id)>();
        foreach (var period in expandedPeriods)
        {
            var pd = await _netSuiteService.GetPeriodAsync(period);
            if (pd != null)
                periodInfo[period] = (pd.StartDate, pd.EndDate, pd.Id);
        }

        if (!periodInfo.Any())
        {
            _logger.LogWarning("No valid periods found");
            return result;
        }

        // Get subsidiary hierarchy for query (subsidiaryId and targetSub already resolved for cache check)
        var hierarchySubs = await _lookupService.GetSubsidiaryHierarchyAsync(targetSub);
        var subFilter = string.Join(", ", hierarchySubs);

        // Build segment filters using TransactionLine (tl) - dimension IDs already resolved
        var segmentFilters = new List<string> { $"tl.subsidiary IN ({subFilter})" };
        if (!string.IsNullOrEmpty(departmentId))
            segmentFilters.Add($"tl.department = {departmentId}");
        if (!string.IsNullOrEmpty(classId))
            segmentFilters.Add($"tl.class = {classId}");
        if (!string.IsNullOrEmpty(locationId))
            segmentFilters.Add($"tl.location = {locationId}");
        var segmentWhere = string.Join(" AND ", segmentFilters);

        var accountingBook = request.Book ?? DefaultAccountingBook;
        int queryCount = 0;

        // ===========================================================================
        // STEP 1: Classify accounts into P&L vs BS (single quick query)
        // NOTE: Use 'acctnumber' not 'a.acctnumber' because Account table has no alias here
        // ===========================================================================
        var accountFilterForType = NetSuiteService.BuildAccountFilter(request.Accounts, "acctnumber");
        var typeQuery = $"SELECT acctnumber, accttype FROM Account WHERE {accountFilterForType}";
        var typeResult = await _netSuiteService.QueryRawAsync(typeQuery);
        queryCount++;

        var plAccounts = new List<string>();
        var bsAccounts = new List<string>();

        foreach (var row in typeResult)
        {
            var acctnumber = row.TryGetProperty("acctnumber", out var numProp) ? numProp.GetString() ?? "" : "";
            var accttype = row.TryGetProperty("accttype", out var typeProp) ? typeProp.GetString() ?? "" : "";
            result.AccountTypes[acctnumber] = accttype;

            if (AccountType.IsBalanceSheet(accttype))
                bsAccounts.Add(acctnumber);
            else
                plAccounts.Add(acctnumber);
        }

        _logger.LogDebug("Account classification: {PlCount} P&L, {BsCount} BS", plAccounts.Count, bsAccounts.Count);

        // ===========================================================================
        // STEP 2: Query P&L accounts (ONE query for all accounts × all periods)
        // ===========================================================================
        if (plAccounts.Any())
        {
            var plAccountFilter = NetSuiteService.BuildAccountFilter(plAccounts);
            var periodsIn = string.Join(", ", expandedPeriods.Select(p => $"'{NetSuiteService.EscapeSql(p)}'"));
            var signFlip = $"CASE WHEN a.accttype IN ({AccountType.IncomeTypesSql}) THEN -1 ELSE 1 END";

            var plQuery = $@"
                SELECT 
                    a.acctnumber,
                    ap.periodname,
                    SUM(
                        TO_NUMBER(
                            BUILTIN.CONSOLIDATE(
                                tal.amount,
                                'LEDGER',
                                'DEFAULT',
                                'DEFAULT',
                                {targetSub},
                                t.postingperiod,
                                'DEFAULT'
                            )
                        ) * {signFlip}
                    ) as balance
                FROM transactionaccountingline tal
                JOIN transaction t ON t.id = tal.transaction
                JOIN account a ON a.id = tal.account
                JOIN accountingperiod ap ON ap.id = t.postingperiod
                JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
                WHERE t.posting = 'T'
                  AND tal.posting = 'T'
                  AND {plAccountFilter}
                  AND ap.periodname IN ({periodsIn})
                  AND a.accttype IN ({AccountType.PlTypesSql})
                  AND tal.accountingbook = {accountingBook}
                  AND {segmentWhere}
                GROUP BY a.acctnumber, ap.periodname";

            _logger.LogDebug("P&L batch query for {Count} accounts × {Periods} periods", plAccounts.Count, expandedPeriods.Count);
            
            // Use error-aware query method
            var plResult = await _netSuiteService.QueryRawWithErrorAsync(plQuery);
            queryCount++;
            
            // INVARIANT: Errors fail loudly - return error code to caller
            if (!plResult.Success)
            {
                _logger.LogWarning("P&L batch query failed with {ErrorCode}: {Details}", 
                    plResult.ErrorCode, plResult.ErrorDetails);
                result.Error = plResult.ErrorCode;
                return result; // Return partial results with error
            }

            foreach (var row in plResult.Items)
            {
                var acctnumber = row.TryGetProperty("acctnumber", out var numProp) ? numProp.GetString() ?? "" : "";
                var periodname = row.TryGetProperty("periodname", out var periodProp) ? periodProp.GetString() ?? "" : "";

                decimal balance = 0;
                if (row.TryGetProperty("balance", out var balProp))
                {
                    balance = ParseBalance(balProp);
                }

                if (!result.Balances.ContainsKey(acctnumber))
                    result.Balances[acctnumber] = new Dictionary<string, decimal>();

                result.Balances[acctnumber][periodname] = balance;
            }
        }

        // ===========================================================================
        // STEP 3: Query BS accounts (ONE query per period for ALL BS accounts)
        // BS accounts need cumulative balance from inception through period end
        // IMPORTANT: Python's build_bs_query_single_period has NO sign flip - 
        // uses raw BUILTIN.CONSOLIDATE amounts. Match that behavior exactly.
        // ===========================================================================
        if (bsAccounts.Any())
        {
            var bsAccountFilter = NetSuiteService.BuildAccountFilter(bsAccounts);
            // No sign flip for batch BS - Python doesn't flip either

            foreach (var (period, info) in periodInfo)
            {
                if (info.End == null) continue;

                var endDate = ConvertToYYYYMMDD(info.End);
                var periodId = info.Id ?? "NULL";

                var bsQuery = $@"
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
                                    {periodId},
                                    'DEFAULT'
                                )
                            )
                        ) as balance
                    FROM transactionaccountingline tal
                    JOIN transaction t ON t.id = tal.transaction
                    JOIN account a ON a.id = tal.account
                    JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
                    WHERE t.posting = 'T'
                      AND tal.posting = 'T'
                      AND {bsAccountFilter}
                      AND a.accttype NOT IN ({AccountType.PlTypesSql})
                      AND t.trandate <= TO_DATE('{endDate}', 'YYYY-MM-DD')
                      AND tal.accountingbook = {accountingBook}
                      AND {segmentWhere}
                    GROUP BY a.acctnumber";

                _logger.LogDebug("BS batch query for {Count} accounts, period {Period}", bsAccounts.Count, period);
                
                // Use error-aware query method with longer timeout for BS
                var bsResult = await _netSuiteService.QueryRawWithErrorAsync(bsQuery, 90);
                queryCount++;
                
                // INVARIANT: Errors fail loudly - return error code to caller
                if (!bsResult.Success)
                {
                    _logger.LogWarning("BS batch query failed with {ErrorCode} for period {Period}: {Details}", 
                        bsResult.ErrorCode, period, bsResult.ErrorDetails);
                    result.Error = bsResult.ErrorCode;
                    return result; // Return partial results with error
                }

                foreach (var row in bsResult.Items)
                {
                    var acctnumber = row.TryGetProperty("acctnumber", out var numProp) ? numProp.GetString() ?? "" : "";

                    decimal balance = 0;
                    if (row.TryGetProperty("balance", out var balProp))
                    {
                        balance = ParseBalance(balProp);
                    }

                    if (!result.Balances.ContainsKey(acctnumber))
                        result.Balances[acctnumber] = new Dictionary<string, decimal>();

                    result.Balances[acctnumber][period] = balance;
                }
            }
        }

        // ===========================================================================
        // STEP 4: Handle wildcard patterns - sum results for "4*" style patterns
        // ===========================================================================
        foreach (var originalAccount in request.Accounts)
        {
            if (originalAccount.Contains('*'))
            {
                var pattern = originalAccount.Replace("*", "");
                var wildcardTotals = new Dictionary<string, decimal>();

                foreach (var (accountNum, periodBalances) in result.Balances)
                {
                    if (accountNum.StartsWith(pattern))
                    {
                        foreach (var (period, balance) in periodBalances)
                        {
                            if (!wildcardTotals.ContainsKey(period))
                                wildcardTotals[period] = 0;
                            wildcardTotals[period] += balance;
                        }
                    }
                }

                result.Balances[originalAccount] = wildcardTotals;
                _logger.LogDebug("Wildcard '{Pattern}' summed: {Periods}", originalAccount, wildcardTotals.Count);
            }
        }

        // Fill in zeros for missing account/period combinations
        foreach (var account in request.Accounts)
        {
            if (!result.Balances.ContainsKey(account))
                result.Balances[account] = new Dictionary<string, decimal>();

            foreach (var period in expandedPeriods)
            {
                if (!result.Balances[account].ContainsKey(period))
                    result.Balances[account][period] = 0;
            }
        }

        result.QueryCount = queryCount;
        return result;
    }

    /// <summary>
    /// Get balance for an account type (e.g., all Income accounts).
    /// Properly handles consolidated subsidiaries and uses optimized queries.
    /// Matches Python implementation for correct results.
    /// </summary>
    public async Task<TypeBalanceResponse> GetTypeBalanceAsync(TypeBalanceRequest request)
    {
        var fromPeriod = request.FromPeriod;
        var toPeriod = string.IsNullOrEmpty(request.ToPeriod) ? request.FromPeriod : request.ToPeriod;

        // Determine if this is a Balance Sheet or P&L type (needed before period handling)
        var isBalanceSheet = AccountType.BsTypes.Any(bt => 
            request.AccountType.Equals(bt, StringComparison.OrdinalIgnoreCase)) ||
            request.AccountType.Equals("Asset", StringComparison.OrdinalIgnoreCase) ||
            request.AccountType.Equals("Liability", StringComparison.OrdinalIgnoreCase) ||
            request.AccountType.Equals("Equity", StringComparison.OrdinalIgnoreCase);

        // Handle year-only format (only for P&L types - BS types don't use fromPeriod)
        if (!isBalanceSheet && NetSuiteService.IsYearOnly(fromPeriod))
        {
            var (from, to) = NetSuiteService.ExpandYearToPeriods(fromPeriod);
            fromPeriod = from;
            toPeriod = to;
        }

        // For BS types, fromPeriod is ignored (cumulative from inception)
        // Only fetch fromPeriodData for P&L types
        AccountingPeriod? fromPeriodData = null;
        if (!isBalanceSheet && !string.IsNullOrEmpty(fromPeriod))
        {
            fromPeriodData = await _netSuiteService.GetPeriodAsync(fromPeriod);
        }
        
        var toPeriodData = await _netSuiteService.GetPeriodAsync(toPeriod);

        // Validate periods: P&L needs both, BS only needs toPeriod
        if (!isBalanceSheet && (fromPeriodData?.StartDate == null || toPeriodData?.EndDate == null))
        {
            _logger.LogWarning("Could not find period dates for P&L type: {From} to {To}", fromPeriod, toPeriod);
            return new TypeBalanceResponse
            {
                AccountType = request.AccountType,
                FromPeriod = fromPeriod,
                ToPeriod = toPeriod,
                Balance = 0
            };
        }
        
        if (isBalanceSheet && toPeriodData?.EndDate == null)
        {
            _logger.LogWarning("Could not find period date for BS type: {To}", toPeriod);
            return new TypeBalanceResponse
            {
                AccountType = request.AccountType,
                FromPeriod = fromPeriod,
                ToPeriod = toPeriod,
                Balance = 0
            };
        }

        // Convert dates to YYYY-MM-DD format (required by NetSuite)
        var fromStartDate = fromPeriodData?.StartDate != null ? ConvertToYYYYMMDD(fromPeriodData.StartDate) : null;
        var toEndDate = ConvertToYYYYMMDD(toPeriodData!.EndDate);
        
        _logger.LogDebug("TypeBalance periods: {FromPeriod} ({FromDate}) to {ToPeriod} ({ToDate})", 
            fromPeriod, fromStartDate ?? "inception", toPeriod, toEndDate);

        // Resolve subsidiary name to ID and get hierarchy
        var subsidiaryId = await _lookupService.ResolveSubsidiaryIdAsync(request.Subsidiary);
        var targetSub = subsidiaryId ?? "1"; // Default to subsidiary 1 (usually root)
        
        // Get subsidiary hierarchy (all children for consolidated view)
        var hierarchySubs = await _lookupService.GetSubsidiaryHierarchyAsync(targetSub);
        var subFilter = string.Join(", ", hierarchySubs);
        
        _logger.LogDebug("TypeBalance: subsidiary '{Sub}' → ID {Id}, hierarchy: {Hierarchy}", 
            request.Subsidiary, targetSub, subFilter);

        // Resolve other dimension names to IDs
        var departmentId = await _lookupService.ResolveDimensionIdAsync("department", request.Department);
        var classId = await _lookupService.ResolveDimensionIdAsync("class", request.Class);
        var locationId = await _lookupService.ResolveDimensionIdAsync("location", request.Location);

        // Build segment filters using TransactionLine (tl) - this is critical!
        var segmentFilters = new List<string> { $"tl.subsidiary IN ({subFilter})" };
        if (!string.IsNullOrEmpty(departmentId))
            segmentFilters.Add($"tl.department = {departmentId}");
        if (!string.IsNullOrEmpty(classId))
            segmentFilters.Add($"tl.class = {classId}");
        if (!string.IsNullOrEmpty(locationId))
            segmentFilters.Add($"tl.location = {locationId}");
        var segmentWhere = string.Join(" AND ", segmentFilters);

        // Map user-friendly type names to NetSuite account types
        var typeFilter = MapAccountType(request.AccountType);
        var accountingBook = request.Book ?? DefaultAccountingBook;

        _logger.LogInformation("TypeBalance: type={Type}, isBalanceSheet={IsBS}, typeFilter={Filter}", 
            request.AccountType, isBalanceSheet, typeFilter);

        string query;
        
        if (isBalanceSheet)
        {
            // BALANCE SHEET: Cumulative from inception through toPeriod
            // Sign flip for Liabilities and Equity (credits stored negative, display positive)
            var signFlip = $"CASE WHEN a.accttype IN ({AccountType.SignFlipTypesSql}) THEN -1 ELSE 1 END";
            
            // Get period ID for BUILTIN.CONSOLIDATE exchange rate
            var targetPeriodId = !string.IsNullOrEmpty(toPeriodData?.Id) ? toPeriodData.Id : "NULL";
            
            _logger.LogDebug("TypeBalance BS: periodId={PeriodId}, endDate={EndDate}", targetPeriodId, toEndDate);
            
            query = $@"
                SELECT SUM(
                    TO_NUMBER(
                        BUILTIN.CONSOLIDATE(
                            tal.amount,
                            'LEDGER',
                            'DEFAULT',
                            'DEFAULT',
                            {targetSub},
                            {targetPeriodId},
                            'DEFAULT'
                        )
                    ) * {signFlip}
                ) AS balance
                FROM transactionaccountingline tal
                JOIN transaction t ON t.id = tal.transaction
                JOIN account a ON a.id = tal.account
                JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
                WHERE t.posting = 'T'
                  AND tal.posting = 'T'
                  AND a.accttype IN ({typeFilter})
                  AND t.trandate <= TO_DATE('{toEndDate}', 'YYYY-MM-DD')
                  AND tal.accountingbook = {accountingBook}
                  AND {segmentWhere}";
        }
        else
        {
            // P&L: Period range from fromPeriod to toPeriod
            // Sign flip for Income types (credits stored negative, display positive)
            var signFlip = $"CASE WHEN a.accttype IN ({AccountType.IncomeTypesSql}) THEN -1 ELSE 1 END";
            
            query = $@"
                SELECT SUM(
                    TO_NUMBER(
                        BUILTIN.CONSOLIDATE(
                            tal.amount,
                            'LEDGER',
                            'DEFAULT',
                            'DEFAULT',
                            {targetSub},
                            t.postingperiod,
                            'DEFAULT'
                        )
                    ) * {signFlip}
                ) AS balance
                FROM transactionaccountingline tal
                JOIN transaction t ON t.id = tal.transaction
                JOIN account a ON a.id = tal.account
                JOIN accountingperiod ap ON ap.id = t.postingperiod
                JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
                WHERE t.posting = 'T'
                  AND tal.posting = 'T'
                  AND a.accttype IN ({typeFilter})
                  AND ap.startdate >= TO_DATE('{fromStartDate}', 'YYYY-MM-DD')
                  AND ap.enddate <= TO_DATE('{toEndDate}', 'YYYY-MM-DD')
                  AND tal.accountingbook = {accountingBook}
                  AND {segmentWhere}";
        }

        _logger.LogDebug("TypeBalance query for {Type}: {Query}", request.AccountType, query[..Math.Min(800, query.Length)]);

        // BS queries scanning all historical data need longer timeout
        var queryTimeout = isBalanceSheet ? 120 : 60;
        
        // Use error-aware query method to propagate failures to Excel
        var queryResult = await _netSuiteService.QueryRawWithErrorAsync(query, queryTimeout);
        
        // INVARIANT: Errors fail loudly - return informative error code to Excel
        if (!queryResult.Success)
        {
            _logger.LogWarning("TypeBalance query failed with {ErrorCode}: {Details}", 
                queryResult.ErrorCode, queryResult.ErrorDetails);
            
            return new TypeBalanceResponse
            {
                Value = 0,
                AccountType = request.AccountType,
                IsBalanceSheet = isBalanceSheet,
                ToPeriod = toPeriod,
                Error = queryResult.ErrorCode // One-word error for Excel cell
            };
        }

        decimal totalBalance = 0;
        if (queryResult.Items.Any())
        {
            var row = queryResult.Items.First();
            if (row.TryGetProperty("balance", out var balProp))
            {
                totalBalance = ParseBalance(balProp);
            }
        }

        _logger.LogDebug("TypeBalance {Type}: ${Balance:N2}", request.AccountType, totalBalance);

        return new TypeBalanceResponse
        {
            Value = totalBalance,
            AccountType = request.AccountType,
            IsBalanceSheet = isBalanceSheet,
            FromPeriod = isBalanceSheet ? null : fromPeriod,
            ToPeriod = toPeriod,
            Balance = totalBalance,
            AccountCount = 0,
            Accounts = new List<AccountBalance>()
        };
    }

    /// <summary>
    /// Get per-account balances for an account type (used by TYPEBALANCE drill-down step 1).
    /// Mirrors Python behavior: P&L types use period range; BS types are cumulative through toPeriod.
    /// </summary>
    public async Task<List<AccountBalance>> GetTypeBalanceAccountsAsync(TypeBalanceRequest request, bool useSpecialAccountType = false)
    {
        var fromPeriod = request.FromPeriod;
        var toPeriod = string.IsNullOrEmpty(request.ToPeriod) ? request.FromPeriod : request.ToPeriod;

        // Handle year-only (e.g., "2025")
        if (NetSuiteService.IsYearOnly(fromPeriod))
        {
            var (from, to) = NetSuiteService.ExpandYearToPeriods(fromPeriod);
            fromPeriod = from;
            toPeriod = to;
        }

        var fromPeriodData = await _netSuiteService.GetPeriodAsync(fromPeriod);
        var toPeriodData = await _netSuiteService.GetPeriodAsync(toPeriod);

        if (fromPeriodData?.StartDate == null || toPeriodData?.EndDate == null)
        {
            _logger.LogWarning("AccountsByType: missing period dates for {From} → {To}", fromPeriod, toPeriod);
            return new List<AccountBalance>();
        }

        var fromStartDate = ConvertToYYYYMMDD(fromPeriodData.StartDate);
        var toEndDate = ConvertToYYYYMMDD(toPeriodData.EndDate);

        // Resolve subsidiary + hierarchy (names → IDs), fall back to no filter if unresolved
        var subsidiaryId = await _lookupService.ResolveSubsidiaryIdAsync(request.Subsidiary);
        var targetSub = !string.IsNullOrEmpty(subsidiaryId) ? subsidiaryId : "1";
        List<string> hierarchySubs = new();
        if (!string.IsNullOrEmpty(subsidiaryId))
        {
            hierarchySubs = await _lookupService.GetSubsidiaryHierarchyAsync(subsidiaryId);
        }
        else if (!string.IsNullOrEmpty(request.Subsidiary))
        {
            _logger.LogWarning("AccountsByType: could not resolve subsidiary '{Sub}' to ID - not applying subsidiary filter", request.Subsidiary);
        }

        // Resolve dimensions (names → IDs)
        var departmentId = await _lookupService.ResolveDimensionIdAsync("department", request.Department);
        var classId = await _lookupService.ResolveDimensionIdAsync("class", request.Class);
        var locationId = await _lookupService.ResolveDimensionIdAsync("location", request.Location);

        var subsidiaryExpr = "COALESCE(tl.subsidiary, t.subsidiary)";
        var departmentExpr = "COALESCE(tl.department, t.department)";
        var classExpr = "COALESCE(tl.class, t.class)";
        var locationExpr = "COALESCE(tl.location, t.location)";

        var segmentFilters = new List<string>();
        if (hierarchySubs.Any())
            segmentFilters.Add($"{subsidiaryExpr} IN ({string.Join(", ", hierarchySubs)})");
        if (!string.IsNullOrEmpty(departmentId))
            segmentFilters.Add($"{departmentExpr} = {departmentId}");
        if (!string.IsNullOrEmpty(classId))
            segmentFilters.Add($"{classExpr} = {classId}");
        if (!string.IsNullOrEmpty(locationId))
            segmentFilters.Add($"{locationExpr} = {locationId}");
        var segmentWhere = segmentFilters.Count > 0 ? string.Join(" AND ", segmentFilters) : "1 = 1";

        var typeFilter = MapAccountType(request.AccountType);
        var typeWhere = useSpecialAccountType
            ? $"a.sspecacct = '{NetSuiteService.EscapeSql(request.AccountType)}'"
            : $"a.accttype IN ({typeFilter})";
        var accountingBook = request.Book ?? DefaultAccountingBook;

        var isBalanceSheet = AccountType.BsTypes.Any(bt =>
            request.AccountType.Equals(bt, StringComparison.OrdinalIgnoreCase)) ||
            request.AccountType.Equals("Asset", StringComparison.OrdinalIgnoreCase) ||
            request.AccountType.Equals("Liability", StringComparison.OrdinalIgnoreCase) ||
            request.AccountType.Equals("Equity", StringComparison.OrdinalIgnoreCase);

        _logger.LogDebug("AccountsByType: type={Type}, BS={IsBS}, from={From}, to={To}, sub={Sub}, dept={Dept}, class={Class}, loc={Loc}",
            request.AccountType, isBalanceSheet, fromPeriod, toPeriod, hierarchySubs.Any() ? string.Join(",", hierarchySubs) : "(none)",
            departmentId ?? "(none)", classId ?? "(none)", locationId ?? "(none)");

        string query;
        if (isBalanceSheet)
        {
            var signFlip = $"CASE WHEN a.accttype IN ({AccountType.SignFlipTypesSql}) THEN -1 ELSE 1 END";
            var targetPeriodId = !string.IsNullOrEmpty(toPeriodData?.Id) ? toPeriodData.Id : "NULL";

            query = $@"
                SELECT 
                    a.acctnumber,
                    a.accountsearchdisplayname AS name,
                    SUM(
                        TO_NUMBER(
                            BUILTIN.CONSOLIDATE(
                                tal.amount,
                                'LEDGER',
                                'DEFAULT',
                                'DEFAULT',
                                {targetSub},
                                {targetPeriodId},
                                'DEFAULT'
                            )
                        ) * {signFlip}
                    ) AS balance
                FROM transactionaccountingline tal
                JOIN transaction t ON t.id = tal.transaction
                JOIN account a ON a.id = tal.account
                JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
                WHERE t.posting = 'T'
                  AND tal.posting = 'T'
                  AND {typeWhere}
                  AND a.isinactive = 'F'
                  AND t.trandate <= TO_DATE('{toEndDate}', 'YYYY-MM-DD')
                  AND tal.accountingbook = {accountingBook}
                  AND {segmentWhere}
                GROUP BY a.acctnumber, a.accountsearchdisplayname, a.accttype
                ORDER BY a.acctnumber";
        }
        else
        {
            var signFlip = $"CASE WHEN a.accttype IN ({AccountType.IncomeTypesSql}) THEN -1 ELSE 1 END";

            query = $@"
                SELECT 
                    a.acctnumber,
                    a.accountsearchdisplayname AS name,
                    SUM(
                        TO_NUMBER(
                            BUILTIN.CONSOLIDATE(
                                tal.amount,
                                'LEDGER',
                                'DEFAULT',
                                'DEFAULT',
                                {targetSub},
                                t.postingperiod,
                                'DEFAULT'
                            )
                        ) * {signFlip}
                    ) AS balance
                FROM transactionaccountingline tal
                JOIN transaction t ON t.id = tal.transaction
                JOIN account a ON a.id = tal.account
                JOIN accountingperiod ap ON ap.id = t.postingperiod
                JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
                WHERE t.posting = 'T'
                  AND tal.posting = 'T'
                  AND {typeWhere}
                  AND a.isinactive = 'F'
                  AND ap.startdate >= TO_DATE('{fromStartDate}', 'YYYY-MM-DD')
                  AND ap.enddate <= TO_DATE('{toEndDate}', 'YYYY-MM-DD')
                  AND tal.accountingbook = {accountingBook}
                  AND {segmentWhere}
                GROUP BY a.acctnumber, a.accountsearchdisplayname, a.accttype
                ORDER BY a.acctnumber";
        }

        _logger.LogDebug("AccountsByType query: {Query}", query[..Math.Min(800, query.Length)]);

        var queryTimeout = isBalanceSheet ? 120 : 60;
        var queryResult = await _netSuiteService.QueryRawWithErrorAsync(query, queryTimeout);
        if (!queryResult.Success)
        {
            _logger.LogWarning("AccountsByType query failed with {ErrorCode}: {Details}",
                queryResult.ErrorCode, queryResult.ErrorDetails);
            return new List<AccountBalance>();
        }

        static bool TryGetDecimal(JsonElement row, string property, out decimal value, Func<JsonElement, decimal> parser)
        {
            if (row.TryGetProperty(property, out var prop))
            {
                value = parser(prop);
                return true;
            }
            value = 0;
            return false;
        }

        var accounts = new List<AccountBalance>();
        foreach (var row in queryResult.Items)
        {
            // Log raw row for debugging mismatched column names / nulls
            _logger.LogDebug("AccountsByType row: {Row}", row.ToString());

            var acctNum = row.TryGetProperty("acctnumber", out var numProp) ? numProp.GetString() ?? "" : "";
            var name = row.TryGetProperty("name", out var nameProp) ? nameProp.GetString() ?? "" : "";
            decimal bal = 0;
            // Try common aliases for the aggregated balance
            if (!TryGetDecimal(row, "balance", out bal, ParseBalance) &&
                !TryGetDecimal(row, "BALANCE", out bal, ParseBalance) &&
                !TryGetDecimal(row, "sum", out bal, ParseBalance) &&
                !TryGetDecimal(row, "SUM", out bal, ParseBalance) &&
                !TryGetDecimal(row, "total", out bal, ParseBalance) &&
                !TryGetDecimal(row, "TOTAL", out bal, ParseBalance))
            {
                // Fallback: first numeric property (if any)
                foreach (var prop in row.EnumerateObject())
                {
                    if (prop.Value.ValueKind == JsonValueKind.Number || prop.Value.ValueKind == JsonValueKind.String)
                    {
                        try
                        {
                            bal = ParseBalance(prop.Value);
                            break;
                        }
                        catch
                        {
                            // continue to next property
                        }
                    }
                }
            }

            accounts.Add(new AccountBalance
            {
                Account = acctNum,
                Name = name,
                Balance = bal
            });
        }

        return accounts;
    }
    
    /// <summary>
    /// Convert date from MM/DD/YYYY to YYYY-MM-DD format.
    /// </summary>
    private string ConvertToYYYYMMDD(string mmddyyyy)
    {
        if (DateTime.TryParseExact(mmddyyyy, "M/d/yyyy", null, System.Globalization.DateTimeStyles.None, out var date))
        {
            return date.ToString("yyyy-MM-dd");
        }
        // Try alternate format
        if (DateTime.TryParseExact(mmddyyyy, "MM/dd/yyyy", null, System.Globalization.DateTimeStyles.None, out date))
        {
            return date.ToString("yyyy-MM-dd");
        }
        // Return as-is if parsing fails
        _logger.LogWarning("Could not parse date: {Date}", mmddyyyy);
        return mmddyyyy;
    }

    /// <summary>
    /// Map user-friendly type names to NetSuite account type filter.
    /// For TYPEBALANCE queries, each type is queried separately (Income, OthIncome, etc.)
    /// </summary>
    private string MapAccountType(string accountType)
    {
        // For exact P&L types, return as-is (but include COGS legacy spelling)
        var exactPlTypes = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "Income", "OthIncome", "Expense", "OthExpense", "COGS"
        };
        
        if (exactPlTypes.Contains(accountType))
        {
            if (accountType.Equals("COGS", StringComparison.OrdinalIgnoreCase))
            {
                // NetSuite sometimes returns "Cost of Goods Sold" instead of "COGS"
                return "'COGS', 'Cost of Goods Sold'";
            }
            return $"'{accountType}'";
        }

        return accountType.ToLower() switch
        {
            // For combined types (used by other queries, not TYPEBALANCE)
            "revenue" => "'Income'",
            "expenses" => "'Expense'",
            "cost of goods sold" => "'COGS'",
            "asset" or "assets" => AccountType.BsAssetTypesSql,
            "liability" or "liabilities" => AccountType.BsLiabilityTypesSql,
            "equity" => AccountType.BsEquityTypesSql,
            _ => $"'{NetSuiteService.EscapeSql(accountType)}'"
        };
    }

    /// <summary>
    /// Generate list of monthly periods between from and to.
    /// </summary>
    private IEnumerable<string> GenerateMonthlyPeriods(string from, string to)
    {
        var months = new[] { "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec" };
        var periods = new List<string>();

        // Parse from period (e.g., "Jan 2025")
        var fromParts = from.Split(' ');
        var toParts = to.Split(' ');

        if (fromParts.Length != 2 || toParts.Length != 2)
            return new[] { from };

        var fromMonth = Array.IndexOf(months, fromParts[0]);
        var fromYear = int.Parse(fromParts[1]);
        var toMonth = Array.IndexOf(months, toParts[0]);
        var toYear = int.Parse(toParts[1]);

        var currentMonth = fromMonth;
        var currentYear = fromYear;

        while (currentYear < toYear || (currentYear == toYear && currentMonth <= toMonth))
        {
            periods.Add($"{months[currentMonth]} {currentYear}");
            currentMonth++;
            if (currentMonth > 11)
            {
                currentMonth = 0;
                currentYear++;
            }
        }

        return periods;
    }
}

/// <summary>
/// Interface for balance service (for DI and testing).
/// </summary>
public interface IBalanceService
{
    Task<BalanceResponse> GetBalanceAsync(BalanceRequest request);
    Task<BatchBalanceResponse> GetBatchBalanceAsync(BatchBalanceRequest request);
    Task<TypeBalanceResponse> GetTypeBalanceAsync(TypeBalanceRequest request);

    /// <summary>
    /// Get per-account balances for an account type (drill-down).
    /// </summary>
    Task<List<AccountBalance>> GetTypeBalanceAccountsAsync(TypeBalanceRequest request, bool useSpecialAccountType = false);
}

