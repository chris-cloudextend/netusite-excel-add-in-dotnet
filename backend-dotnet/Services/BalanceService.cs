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
    /// 
    /// CRITICAL: Returns 0 ONLY if value is explicitly null or empty (legitimate zero).
    /// Throws exception if parsing fails (invalid data shape or unparseable string).
    /// </summary>
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
            if (double.TryParse(strVal, System.Globalization.NumberStyles.Float, 
                                System.Globalization.CultureInfo.InvariantCulture, out var dblVal))
            {
                return (decimal)dblVal;
            }
            
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

    /// <summary>
    /// Get balance for a single account with optional filters.
    /// Properly handles consolidated subsidiaries and uses optimized queries.
    /// 
    /// CRITICAL: Balance Sheet accounts use CUMULATIVE balance (inception through to_period).
    /// P&L accounts use PERIOD RANGE balance (from_period through to_period).
    /// </summary>
    public async Task<BalanceResponse> GetBalanceAsync(BalanceRequest request)
    {
        // ========================================================================
        // ANCHOR DATE HANDLING: Opening balance as of anchor date
        // When anchor_date is provided with empty from_period and to_period,
        // return opening balance (cumulative from inception through anchor date)
        // ========================================================================
        if (!string.IsNullOrEmpty(request.AnchorDate) && 
            string.IsNullOrEmpty(request.FromPeriod) && 
            string.IsNullOrEmpty(request.ToPeriod))
        {
            return await GetOpeningBalanceAsync(request);
        }
        
        // ========================================================================
        // BATCH MODE HANDLING: Period activity breakdown
        // When batch_mode=true and include_period_breakdown=true,
        // return per-period activity breakdown instead of single total
        // ========================================================================
        if (request.BatchMode && request.IncludePeriodBreakdown && 
            !string.IsNullOrEmpty(request.FromPeriod) && 
            !string.IsNullOrEmpty(request.ToPeriod))
        {
            return await GetPeriodActivityBreakdownAsync(request);
        }
        
        // ========================================================================
        // VALIDATE PARAMETER SHAPE FIRST (before any defaults)
        // ========================================================================
        bool hasFromPeriod = !string.IsNullOrEmpty(request.FromPeriod);
        bool hasToPeriod = !string.IsNullOrEmpty(request.ToPeriod);
        
        // Invalid: fromPeriod provided but toPeriod is empty
        if (hasFromPeriod && !hasToPeriod)
        {
            _logger.LogWarning("Invalid parameter shape: fromPeriod provided ({FromPeriod}) but toPeriod is empty", request.FromPeriod);
            return new BalanceResponse
            {
                Account = request.Account,
                FromPeriod = request.FromPeriod,
                ToPeriod = request.ToPeriod,
                Balance = 0,
                Error = "Invalid parameters: fromPeriod provided but toPeriod is required. For point-in-time balance, leave fromPeriod empty."
            };
        }
        
        var fromPeriod = request.FromPeriod;
        var toPeriod = string.IsNullOrEmpty(request.ToPeriod) ? request.FromPeriod : request.ToPeriod;

        // Handle year-only format - get actual period IDs from NetSuite
        if (NetSuiteService.IsYearOnly(fromPeriod))
        {
            var yearPeriods = await _netSuiteService.GetPeriodsForYearAsync(fromPeriod);
            if (yearPeriods.Count == 12)
            {
                fromPeriod = yearPeriods.First().PeriodName;
                toPeriod = yearPeriods.Last().PeriodName;
            }
            else
            {
                _logger.LogWarning("Expected 12 periods for year {Year}, got {Count}", fromPeriod, yearPeriods.Count);
                return new BalanceResponse
                {
                    Account = request.Account,
                    FromPeriod = request.FromPeriod,
                    ToPeriod = request.ToPeriod,
                    Balance = 0,
                    Error = $"Could not resolve 12 periods for year {fromPeriod}"
                };
            }
        }

        // ========================================================================
        // PARAMETER-DRIVEN BEHAVIOR (No account-type branching)
        // 
        // 1. Point-in-time balance (fromPeriod null/empty + toPeriod provided):
        //    - Return consolidated balance as of end of toPeriod
        //    - Always use BUILTIN.CONSOLIDATE(..., targetPeriodId = toPeriod)
        //    - Query: t.trandate <= toEndDate (cumulative from inception)
        //
        // 2. Period activity (both fromPeriod AND toPeriod provided):
        //    - Return net activity between fromPeriod and toPeriod
        //    - Always use BUILTIN.CONSOLIDATE(..., targetPeriodId = toPeriod)
        //    - Query: ap.startdate >= fromStartDate AND ap.enddate <= toEndDate
        // ========================================================================
        
        // Re-validate after year expansion
        hasFromPeriod = !string.IsNullOrEmpty(fromPeriod);
        hasToPeriod = !string.IsNullOrEmpty(toPeriod);
        
        // Determine query mode based on parameters
        bool isPointInTime = !hasFromPeriod && hasToPeriod;
        bool isPeriodActivity = hasFromPeriod && hasToPeriod;
        
        _logger.LogDebug("BALANCE query mode: PointInTime={PointInTime}, PeriodActivity={PeriodActivity}, fromPeriod={FromPeriod}, toPeriod={ToPeriod}",
            isPointInTime, isPeriodActivity, fromPeriod, toPeriod);

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

        // Get target period ID for currency conversion
        // CRITICAL: For Balance Sheet accounts, ALL amounts must be translated at the SAME period-end rate
        // to ensure the balance sheet balances correctly. Using t.postingperiod would cause each transaction
        // to use its own period's rate, leading to balance sheet imbalances.
        // For P&L accounts, using t.postingperiod is acceptable (each transaction uses its own period's rate).
        var targetPeriodId = toPeriodData.Id;
        if (string.IsNullOrEmpty(targetPeriodId))
        {
            _logger.LogWarning("Period {Period} has no ID, falling back to postingperiod for consolidation", toPeriod);
            targetPeriodId = "t.postingperiod"; // Fallback
        }

        string query;
        int queryTimeout;
        
        // Universal sign flip: Handles both BS and P&L accounts
        // BS: Liabilities/Equity need flip (stored negative, display positive)
        // P&L: Income needs flip (stored negative, display positive)
        var signFlip = $@"
            CASE 
                WHEN a.accttype IN ({AccountType.SignFlipTypesSql}) THEN -1  -- BS: Liabilities/Equity
                WHEN a.accttype IN ({AccountType.IncomeTypesSql}) THEN -1     -- P&L: Income
                ELSE 1 
            END";
        
        if (isPointInTime)
        {
            // POINT-IN-TIME BALANCE: Cumulative from inception through to_period
            // CRITICAL FIX: Use t.postingperiod <= toPeriodId instead of t.trandate <= toEndDate
            // This ensures month-by-month and batched queries use identical period filtering
            // Always use BUILTIN.CONSOLIDATE with targetPeriodId (toPeriod's rate)
            
            queryTimeout = 180; // Cumulative queries scan all history
            
            // OPTIMIZATION: Skip TransactionLine join for root consolidated subsidiary with no filters
            var tlJoin = needsTransactionLineJoin 
                ? "JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id" 
                : "";
            var whereSegment = needsTransactionLineJoin ? $"AND {segmentWhere}" : "";
            
            // Validate that we have the period ID
            if (string.IsNullOrEmpty(targetPeriodId))
            {
                _logger.LogWarning("Point-in-time query: toPeriod {ToPeriod} has no ID, cannot use period-based filtering", toPeriod);
                return new BalanceResponse
                {
                    Account = request.Account,
                    FromPeriod = request.FromPeriod,
                    ToPeriod = toPeriod,
                    Balance = 0,
                    Error = $"Could not resolve period ID for {toPeriod}"
                };
            }
            
            _logger.LogDebug("Point-in-time query: toPeriodId={PeriodId}, sub={Sub}", 
                targetPeriodId, targetSub);
            
            // CRITICAL: Use TARGET period ID (toPeriod) for exchange rate
            // This ensures ALL historical transactions convert at the SAME exchange rate
            // (the target period's rate), which is required for Balance Sheet to balance correctly
            // CRITICAL FIX: Filter by postingperiod <= toPeriodId instead of trandate <= toEndDate
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
                                {targetPeriodId},
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
                      AND t.postingperiod <= {targetPeriodId}
                      AND tal.accountingbook = {accountingBook}
                      {whereSegment}
                ) x";
        }
        else if (isPeriodActivity)
        {
            // PERIOD ACTIVITY: Net activity between from_period and to_period
            // 
            // OPTIMIZATION: For Balance Sheet accounts, use a single range-bounded query instead of
            // two cumulative queries. This is mathematically equivalent but much faster:
            // - Range query: SUM(transactions WHERE date >= fromDate AND date <= toDate)
            // - Equivalent to: Balance(toDate) - Balance(beforeFromDate)
            // - Uses indexed date filters, avoids scanning all history twice
            //
            // For P&L accounts (Income/Expense), keep existing behavior unchanged.
            
            // Detect account type early to branch logic
            var accountTypeForActivity = await _lookupService.GetAccountTypeAsync(request.Account);
            var isBalanceSheetAccount = AccountType.IsBalanceSheet(accountTypeForActivity ?? "");
            
            if (isBalanceSheetAccount)
            {
                // ========================================================================
                // BALANCE SHEET OPTIMIZATION: Single range-bounded query
                // ========================================================================
                // For BS accounts, sum transactions in the period range directly
                // CRITICAL FIX: Use t.postingperiod IN (periodId1, periodId2, ...) instead of date ranges
                // This ensures month-by-month and batched queries use identical period filtering
                
                queryTimeout = 60; // Range queries are much faster (single indexed scan)
                
                // Get all period IDs in the range
                var periodIdsInRange = await GetPeriodIdsInRangeAsync(fromPeriod, toPeriod);
                
                if (!periodIdsInRange.Any())
                {
                    _logger.LogWarning("Could not find period IDs for range: {FromPeriod} to {ToPeriod}", fromPeriod, toPeriod);
                    return new BalanceResponse
                    {
                        Account = request.Account,
                        FromPeriod = request.FromPeriod,
                        ToPeriod = toPeriod,
                        Balance = 0,
                        Error = $"Could not resolve period IDs for range {fromPeriod} to {toPeriod}"
                    };
                }
                
                var periodIdList = string.Join(", ", periodIdsInRange);
                
                _logger.LogDebug("BS period activity (range query): account={Account}, fromPeriod={FromPeriod}, toPeriod={ToPeriod}, periodCount={Count}, periodId={PeriodId}",
                    request.Account, fromPeriod, toPeriod, periodIdsInRange.Count, targetPeriodId);
                
                // Build segment filters if needed (reuse existing segmentWhere logic)
                // For BS range queries, we still need subsidiary filtering if not root
                var bsSegmentWhere = "";
                if (needsTransactionLineJoin)
                {
                    var bsSegmentFilters = new List<string>();
                    bsSegmentFilters.Add($"tl.subsidiary IN ({subFilter})");
                    if (!string.IsNullOrEmpty(departmentId))
                        bsSegmentFilters.Add($"tl.department = {departmentId}");
                    if (!string.IsNullOrEmpty(classId))
                        bsSegmentFilters.Add($"tl.class = {classId}");
                    if (!string.IsNullOrEmpty(locationId))
                        bsSegmentFilters.Add($"tl.location = {locationId}");
                    bsSegmentWhere = $"AND {string.Join(" AND ", bsSegmentFilters)}";
                }
                
                // CRITICAL: Must join TransactionLine for segment filters
                // No longer need accounting period join since we filter by postingperiod directly
                var tlJoin = needsTransactionLineJoin 
                    ? "JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id" 
                    : "";
                
                // Single range-bounded query: transactions posted in periods between fromPeriod and toPeriod
                // CRITICAL FIX: Filter by t.postingperiod IN (periodId1, periodId2, ...) instead of date ranges
                // This ensures identical period filtering regardless of batching
                var rangeActivityQuery = $@"
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
                                    {targetPeriodId},
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
                          AND t.postingperiod IN ({periodIdList})
                          AND tal.accountingbook = {accountingBook}
                          {bsSegmentWhere}
                    ) x";
                
                // Execute single range query
                var rangeResult = await _netSuiteService.QueryRawWithErrorAsync(rangeActivityQuery, queryTimeout);
                
                if (!rangeResult.Success)
                {
                    _logger.LogWarning("BS period activity (range query) failed: {Error}", rangeResult.ErrorDetails);
                    return new BalanceResponse
                    {
                        Account = request.Account,
                        FromPeriod = request.FromPeriod,
                        ToPeriod = toPeriod,
                        Balance = 0,
                        Error = rangeResult.ErrorCode ?? "QUERY_FAILED"
                    };
                }
                
                // Extract activity from range query result
                decimal activity = 0;
                if (rangeResult.Items.Any())
                {
                    var row = rangeResult.Items.First();
                    if (row.TryGetProperty("balance", out var balProp))
                        activity = ParseBalance(balProp);
                }
                
                _logger.LogInformation("BS period activity (range query): Account={Account}, FromPeriod={FromPeriod}, ToPeriod={ToPeriod}, Activity={Activity:N2}",
                    request.Account, fromPeriod, toPeriod, activity);
                
                // Get account name for response
                var accountNameForActivity = await _lookupService.GetAccountNameAsync(request.Account);
                
                return new BalanceResponse
                {
                    Account = request.Account,
                    AccountName = accountNameForActivity,
                    AccountType = accountTypeForActivity,
                    FromPeriod = request.FromPeriod,
                    ToPeriod = toPeriod,
                    Balance = activity
                };
            }
            else
            {
                // ========================================================================
                // P&L ACCOUNTS: Period activity using period IDs
                // ========================================================================
                // CRITICAL FIX: Use t.postingperiod IN (periodId1, periodId2, ...) instead of date-based cumulative queries
                // This ensures month-by-month and batched queries use identical period filtering
                // Mathematically equivalent to: Balance(toPeriod) - Balance(beforeFromPeriod)
                // but directly sums transactions in the period range
                
                queryTimeout = 60; // Range queries are faster than cumulative queries
                
                // Get all period IDs in the range
                var periodIdsInRange = await GetPeriodIdsInRangeAsync(fromPeriod, toPeriod);
                
                if (!periodIdsInRange.Any())
                {
                    _logger.LogWarning("Could not find period IDs for range: {FromPeriod} to {ToPeriod}", fromPeriod, toPeriod);
                    return new BalanceResponse
                    {
                        Account = request.Account,
                        FromPeriod = request.FromPeriod,
                        ToPeriod = toPeriod,
                        Balance = 0,
                        Error = $"Could not resolve period IDs for range {fromPeriod} to {toPeriod}"
                    };
                }
                
                var periodIdList = string.Join(", ", periodIdsInRange);
                
                _logger.LogDebug("P&L period activity query: fromPeriod={FromPeriod}, toPeriod={ToPeriod}, periodCount={Count}, periodId={PeriodId}", 
                    fromPeriod, toPeriod, periodIdsInRange.Count, targetPeriodId);
                
                var tlJoin = needsTransactionLineJoin 
                    ? "JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id" 
                    : "";
                var whereSegment = needsTransactionLineJoin ? $"AND {segmentWhere}" : "";
                
                // Single query: sum transactions in periods between fromPeriod and toPeriod
                // CRITICAL FIX: Filter by t.postingperiod IN (periodId1, periodId2, ...) instead of date-based cumulative queries
                var periodActivityQuery = $@"
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
                                    {targetPeriodId},
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
                          AND t.postingperiod IN ({periodIdList})
                          AND tal.accountingbook = {accountingBook}
                          {whereSegment}
                    ) x";
                
                // Execute single query
                var activityResult = await _netSuiteService.QueryRawWithErrorAsync(periodActivityQuery, queryTimeout);
                
                if (!activityResult.Success)
                {
                    _logger.LogWarning("P&L period activity query failed: {Error}", activityResult.ErrorDetails);
                    return new BalanceResponse
                    {
                        Account = request.Account,
                        FromPeriod = request.FromPeriod,
                        ToPeriod = toPeriod,
                        Balance = 0,
                        Error = activityResult.ErrorCode ?? "QUERY_FAILED"
                    };
                }
                
                // Extract activity
                decimal activity = 0;
                if (activityResult.Items.Any())
                {
                    var row = activityResult.Items.First();
                    if (row.TryGetProperty("balance", out var balProp))
                        activity = ParseBalance(balProp);
                }
                
                _logger.LogInformation("P&L period activity: Account={Account}, FromPeriod={FromPeriod}, ToPeriod={ToPeriod}, Activity={Activity:N2}",
                    request.Account, fromPeriod, toPeriod, activity);
                
                // Get account name for response
                var accountNameForActivity = await _lookupService.GetAccountNameAsync(request.Account);
                var accountTypeForActivityInner = await _lookupService.GetAccountTypeAsync(request.Account);
                
                return new BalanceResponse
                {
                    Account = request.Account,
                    AccountName = accountNameForActivity,
                    AccountType = accountTypeForActivityInner,
                    FromPeriod = request.FromPeriod,
                    ToPeriod = toPeriod,
                    Balance = activity
                };
            }
        }
        else
        {
            // Should not reach here (validation above should catch invalid parameter shapes)
            _logger.LogError("Invalid query mode: fromPeriod={FromPeriod}, toPeriod={ToPeriod}", fromPeriod, toPeriod);
            return new BalanceResponse
            {
                Account = request.Account,
                FromPeriod = request.FromPeriod,
                ToPeriod = request.ToPeriod,
                Balance = 0,
                Error = "Invalid parameter combination"
            };
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
        string? accountType = null; // No longer detecting account type (parameter-driven)

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
    /// Get balance for BALANCEBETA with explicit currency control for consolidation.
    /// Currency parameter determines consolidation root, while subsidiary filters transactions.
    /// Transaction filtering uses exact subsidiary match (not hierarchy).
    /// </summary>
    public async Task<BalanceBetaResponse> GetBalanceBetaAsync(BalanceBetaRequest request)
    {
        var fromPeriod = request.FromPeriod;
        var toPeriod = string.IsNullOrEmpty(request.ToPeriod) ? request.FromPeriod : request.ToPeriod;

        // Handle year-only format - get actual period IDs from NetSuite
        if (NetSuiteService.IsYearOnly(fromPeriod))
        {
            var yearPeriods = await _netSuiteService.GetPeriodsForYearAsync(fromPeriod);
            if (yearPeriods.Count == 12)
            {
                fromPeriod = yearPeriods.First().PeriodName;
                toPeriod = yearPeriods.Last().PeriodName;
            }
            else
            {
                _logger.LogWarning("Expected 12 periods for year {Year}, got {Count}", fromPeriod, yearPeriods.Count);
                return new BalanceBetaResponse
                {
                    Account = request.Account,
                    FromPeriod = request.FromPeriod,
                    ToPeriod = request.ToPeriod,
                    Balance = 0,
                    Error = $"Could not resolve 12 periods for year {fromPeriod}"
                };
            }
        }

        // Auto-detect Balance Sheet accounts (same as BALANCE)
        bool isBsAccount = false;
        string? detectedAccountType = null;
        
        if (!string.IsNullOrEmpty(request.Account) && !request.Account.Contains('*'))
        {
            var typeQuery = $"SELECT accttype FROM Account WHERE acctnumber = '{NetSuiteService.EscapeSql(request.Account)}'";
            var typeResult = await _netSuiteService.QueryRawAsync(typeQuery);
            if (typeResult.Any())
            {
                var acctType = typeResult.First().TryGetProperty("accttype", out var typeProp) 
                    ? typeProp.GetString() ?? "" : "";
                detectedAccountType = acctType;
                isBsAccount = AccountType.IsBalanceSheet(acctType);
            }
        }
        else if (!string.IsNullOrEmpty(request.Account) && request.Account.Contains('*'))
        {
            var wildcardFilter = NetSuiteService.BuildAccountFilter(new[] { request.Account }, "acctnumber");
            var typeQuery = $"SELECT DISTINCT accttype FROM Account WHERE {wildcardFilter}";
            var typeResult = await _netSuiteService.QueryRawAsync(typeQuery);
            if (typeResult.Any())
            {
                var types = typeResult.Select(r => r.TryGetProperty("accttype", out var p) ? p.GetString() ?? "" : "").ToList();
                var bsTypes = types.Where(AccountType.IsBalanceSheet).ToList();
                var plTypes = types.Where(t => !AccountType.IsBalanceSheet(t)).ToList();
                
                if (bsTypes.Any() && !plTypes.Any())
                    isBsAccount = true;
            }
        }

        if (isBsAccount && !string.IsNullOrEmpty(fromPeriod) && !string.IsNullOrEmpty(toPeriod))
        {
            fromPeriod = ""; // Clear from_period for cumulative calculation
        }

        // Get period dates
        var toPeriodData = await _netSuiteService.GetPeriodAsync(toPeriod);
        if (toPeriodData?.EndDate == null)
        {
            return new BalanceBetaResponse
            {
                Account = request.Account,
                FromPeriod = request.FromPeriod,
                ToPeriod = toPeriod,
                Balance = 0
            };
        }

        var toEndDate = ConvertToYYYYMMDD(toPeriodData.EndDate);
        var fromStartDate = "";
        if (!string.IsNullOrEmpty(fromPeriod))
        {
            var fromPeriodData = await _netSuiteService.GetPeriodAsync(fromPeriod);
            if (fromPeriodData?.StartDate != null)
                fromStartDate = ConvertToYYYYMMDD(fromPeriodData.StartDate);
        }

        // Resolve filtered subsidiary (for transaction filtering)
        var subsidiaryId = await _lookupService.ResolveSubsidiaryIdAsync(request.Subsidiary);
        var filteredSubId = subsidiaryId ?? "1";

        // Resolve currency to consolidation root
        string consolidationRootId;
        if (!string.IsNullOrEmpty(request.Currency))
        {
            _logger.LogInformation("BALANCECURRENCY: Resolving currency {Currency} for subsidiary {SubId} (filtered: {FilteredSubId})",
                request.Currency, request.Subsidiary, filteredSubId);
            var resolvedRoot = await _lookupService.ResolveCurrencyToConsolidationRootAsync(request.Currency, filteredSubId);
            if (resolvedRoot == null)
            {
                _logger.LogWarning("Could not resolve currency {Currency} to consolidation root for subsidiary {SubId}. No valid consolidation path exists in ConsolidatedExchangeRate.",
                    request.Currency, filteredSubId);
                return new BalanceBetaResponse
                {
                    Account = request.Account,
                    FromPeriod = request.FromPeriod,
                    ToPeriod = toPeriod,
                    Balance = 0,
                    Error = "INV_SUB_CUR",
                    Currency = request.Currency,
                    ConsolidationRoot = null
                };
            }
            consolidationRootId = resolvedRoot;
            _logger.LogInformation("BALANCECURRENCY: Using consolidation root {ConsolidationRootId} for currency {Currency} (filtered subsidiary: {FilteredSubId})",
                consolidationRootId, request.Currency, filteredSubId);
        }
        else
        {
            // No currency provided: use filtered subsidiary as consolidation root (matches BALANCE behavior)
            consolidationRootId = filteredSubId;
        }

        // Resolve other dimension names to IDs
        var departmentId = await _lookupService.ResolveDimensionIdAsync("department", request.Department);
        var classId = await _lookupService.ResolveDimensionIdAsync("class", request.Class);
        var locationId = await _lookupService.ResolveDimensionIdAsync("location", request.Location);

        var accountingBook = request.Book ?? DefaultAccountingBook;

        // Build segment filters for subsidiary filtering
        // CRITICAL: When using BUILTIN.CONSOLIDATE with a currency consolidation root,
        // we need to filter to the filtered subsidiary's hierarchy (not just exact match)
        // so that BUILTIN.CONSOLIDATE can properly convert the amounts.
        // However, we still filter to ensure we only get transactions from the requested subsidiary.
        var segmentFilters = new List<string>();
        
        // For subsidiary filtering: use hierarchy to include child subsidiaries
        // This ensures BUILTIN.CONSOLIDATE can properly convert amounts
        var hierarchySubs = await _lookupService.GetSubsidiaryHierarchyAsync(filteredSubId);
        var subFilter = string.Join(", ", hierarchySubs);
        segmentFilters.Add($"tl.subsidiary IN ({subFilter})");
        
        if (!string.IsNullOrEmpty(departmentId))
            segmentFilters.Add($"tl.department = {departmentId}");
        if (!string.IsNullOrEmpty(classId))
            segmentFilters.Add($"tl.class = {classId}");
        if (!string.IsNullOrEmpty(locationId))
            segmentFilters.Add($"tl.location = {locationId}");
        var segmentWhere = string.Join(" AND ", segmentFilters);

        // Get target period ID for currency conversion
        // For Balance Sheet: use target period ID to ensure all amounts convert at same exchange rate
        // For P&L: can use t.postingperiod (each transaction uses its own period's rate)
        var targetPeriodId = toPeriodData.Id;
        if (string.IsNullOrEmpty(targetPeriodId))
        {
            _logger.LogWarning("Period {Period} has no ID, falling back to postingperiod for consolidation", toPeriod);
            targetPeriodId = "t.postingperiod"; // Fallback
        }

        string query;
        int queryTimeout;
        
        if (isBsAccount)
        {
            var signFlip = $"CASE WHEN a.accttype IN ({AccountType.SignFlipTypesSql}) THEN -1 ELSE 1 END";
            queryTimeout = 180;
            
            // CRITICAL: For Balance Sheet, use TARGET period ID (not t.postingperiod)
            // This ensures ALL historical transactions convert at the SAME exchange rate
            // (the target period's rate), which is required for Balance Sheet to balance correctly
            // 
            // IMPORTANT: BUILTIN.CONSOLIDATE returns NULL for transactions that cannot be consolidated
            // to the target subsidiary. We filter out NULLs to only include successfully converted amounts.
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
                                {consolidationRootId},
                                {targetPeriodId},
                                'DEFAULT'
                            )
                        ) * {signFlip} AS cons_amt
                    FROM transactionaccountingline tal
                    JOIN transaction t ON t.id = tal.transaction
                    JOIN account a ON a.id = tal.account
                    JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
                    WHERE t.posting = 'T'
                      AND tal.posting = 'T'
                      AND {NetSuiteService.BuildAccountFilter(new[] { request.Account })}
                      AND t.postingperiod <= {targetPeriodId}
                      AND tal.accountingbook = {accountingBook}
                      AND {segmentWhere}
                      AND BUILTIN.CONSOLIDATE(
                          tal.amount,
                          'LEDGER',
                          'DEFAULT',
                          'DEFAULT',
                          {consolidationRootId},
                          {targetPeriodId},
                          'DEFAULT'
                      ) IS NOT NULL
                ) x";
        }
        else
        {
            var signFlip = $"CASE WHEN a.accttype IN ({AccountType.IncomeTypesSql}) THEN -1 ELSE 1 END";
            queryTimeout = 30;
            
            if (string.IsNullOrEmpty(fromStartDate))
            {
                fromStartDate = ConvertToYYYYMMDD(toPeriodData.StartDate ?? toPeriodData.EndDate!);
            }

            // CRITICAL FIX: Use period IDs instead of date ranges for P&L period activity
            // Get all period IDs in the range
            var periodIdsInRange = await GetPeriodIdsInRangeAsync(fromPeriod, toPeriod);
            
            if (!periodIdsInRange.Any())
            {
                _logger.LogWarning("BalanceBeta P&L: Could not find period IDs for range: {FromPeriod} to {ToPeriod}", fromPeriod, toPeriod);
                return new BalanceBetaResponse
                {
                    Account = request.Account,
                    FromPeriod = request.FromPeriod,
                    ToPeriod = toPeriod,
                    Balance = 0,
                    Error = $"Could not resolve period IDs for range {fromPeriod} to {toPeriod}"
                };
            }
            
            var periodIdList = string.Join(", ", periodIdsInRange);
            
            _logger.LogDebug("BalanceBeta P&L: fromPeriod={FromPeriod}, toPeriod={ToPeriod}, periodCount={Count}", 
                fromPeriod, toPeriod, periodIdsInRange.Count);
            
            // IMPORTANT: BUILTIN.CONSOLIDATE returns NULL for transactions that cannot be consolidated
            // to the target subsidiary. We filter out NULLs to only include successfully converted amounts.
            // CRITICAL FIX: Filter by t.postingperiod IN (periodId1, periodId2, ...) instead of date ranges
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
                                {consolidationRootId},
                                {targetPeriodId},
                                'DEFAULT'
                            )
                        ) * {signFlip} AS cons_amt
                    FROM transactionaccountingline tal
                    JOIN transaction t ON t.id = tal.transaction
                    JOIN account a ON a.id = tal.account
                    JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
                    WHERE t.posting = 'T'
                      AND tal.posting = 'T'
                      AND {NetSuiteService.BuildAccountFilter(new[] { request.Account })}
                      AND t.postingperiod IN ({periodIdList})
                      AND tal.accountingbook = {accountingBook}
                      AND {segmentWhere}
                      AND BUILTIN.CONSOLIDATE(
                          tal.amount,
                          'LEDGER',
                          'DEFAULT',
                          'DEFAULT',
                          {consolidationRootId},
                          {targetPeriodId},
                          'DEFAULT'
                      ) IS NOT NULL
                ) x";
        }

        // DETAILED LOGGING: Single-account query timing
        var queryStartTime = DateTime.UtcNow;
        _logger.LogInformation("═══════════════════════════════════════════════════════");
        _logger.LogInformation("📊 SINGLE-ACCOUNT BALANCE QUERY");
        _logger.LogInformation("   Account: {Account}", request.Account);
        _logger.LogInformation("   Period: {ToPeriod} (end date: {ToEndDate})", request.ToPeriod, toEndDate);
        _logger.LogInformation("   Account Type: {AccountType}", isBsAccount ? "Balance Sheet" : "P&L");
        _logger.LogInformation("   Start Time: {StartTime:yyyy-MM-dd HH:mm:ss.fff} UTC", queryStartTime);
        _logger.LogInformation("   Date Scope: ALL transactions from inception through {ToEndDate} (t.trandate <= TO_DATE('{ToEndDate}', 'YYYY-MM-DD'))", toEndDate, toEndDate);
        _logger.LogInformation("   No lower bound on date - includes all historical transactions");
        _logger.LogInformation("   Target Period ID: {TargetPeriodId}", targetPeriodId);
        _logger.LogInformation("═══════════════════════════════════════════════════════");
        
        var queryResult = await _netSuiteService.QueryRawWithErrorAsync(query, queryTimeout);
        var queryElapsed = (DateTime.UtcNow - queryStartTime).TotalSeconds;
        
        _logger.LogInformation("⏱️ SINGLE-ACCOUNT QUERY TIMING");
        _logger.LogInformation("   Query Duration: {Elapsed:F2}s", queryElapsed);
        _logger.LogInformation("   End Time: {EndTime:yyyy-MM-dd HH:mm:ss.fff} UTC", DateTime.UtcNow);
        _logger.LogInformation("═══════════════════════════════════════════════════════");
        
        if (!queryResult.Success)
        {
            return new BalanceBetaResponse
            {
                Account = request.Account,
                FromPeriod = request.FromPeriod,
                ToPeriod = toPeriod,
                Balance = 0,
                Error = queryResult.ErrorCode,
                Currency = request.Currency,
                ConsolidationRoot = consolidationRootId
            };
        }

        decimal balance = 0;
        bool hasResults = false;
        if (queryResult.Items.Any())
        {
            var row = queryResult.Items.First();
            if (row.TryGetProperty("balance", out var balProp))
            {
                // Check if balance is null (which means BUILTIN.CONSOLIDATE returned NULL for all rows)
                if (balProp.ValueKind == System.Text.Json.JsonValueKind.Null)
                {
                    _logger.LogWarning("BUILTIN.CONSOLIDATE returned NULL for all transactions. Currency {Currency} cannot be converted from subsidiary {FilteredSubId} to consolidation root {ConsolidationRootId}",
                        request.Currency, filteredSubId, consolidationRootId);
                    return new BalanceBetaResponse
                    {
                        Account = request.Account,
                        FromPeriod = request.FromPeriod,
                        ToPeriod = toPeriod,
                        Balance = 0,
                        Error = "INV_SUB_CUR",
                        Currency = request.Currency,
                        ConsolidationRoot = consolidationRootId
                    };
                }
                balance = ParseBalance(balProp);
                hasResults = true;
            }
        }
        
        // If no results and we have a consolidation root, it means BUILTIN.CONSOLIDATE filtered out all transactions
        // This indicates the currency conversion path is invalid
        if (!hasResults && !string.IsNullOrEmpty(request.Currency) && !string.IsNullOrEmpty(consolidationRootId))
        {
            _logger.LogWarning("No results returned from query with currency {Currency} and consolidation root {ConsolidationRootId}. All transactions were filtered out by BUILTIN.CONSOLIDATE (invalid conversion path).",
                request.Currency, consolidationRootId);
            return new BalanceBetaResponse
            {
                Account = request.Account,
                FromPeriod = request.FromPeriod,
                ToPeriod = toPeriod,
                Balance = 0,
                Error = "INV_SUB_CUR",
                Currency = request.Currency,
                ConsolidationRoot = consolidationRootId
            };
        }

        var accountName = await _lookupService.GetAccountNameAsync(request.Account);
        if (detectedAccountType == null)
            detectedAccountType = await _lookupService.GetAccountTypeAsync(request.Account);

        return new BalanceBetaResponse
        {
            Account = request.Account,
            AccountName = accountName,
            AccountType = detectedAccountType,
            FromPeriod = request.FromPeriod,
            ToPeriod = toPeriod,
            Balance = balance,
            Currency = request.Currency,
            ConsolidationRoot = consolidationRootId
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

        // Support both period list and period range
        bool hasPeriodList = request.Periods != null && request.Periods.Any();
        bool hasPeriodRange = !string.IsNullOrEmpty(request.FromPeriod) && !string.IsNullOrEmpty(request.ToPeriod);
        
        if (!request.Accounts.Any() || (!hasPeriodList && !hasPeriodRange))
            return result;

        // Build filters hash for cache key
        var subsidiaryId = await _lookupService.ResolveSubsidiaryIdAsync(request.Subsidiary);
        var targetSub = subsidiaryId ?? "1";
        var departmentId = await _lookupService.ResolveDimensionIdAsync("department", request.Department);
        var classId = await _lookupService.ResolveDimensionIdAsync("class", request.Class);
        var locationId = await _lookupService.ResolveDimensionIdAsync("location", request.Location);
        var filtersHash = $"{targetSub}:{departmentId ?? ""}:{locationId ?? ""}:{classId ?? ""}";
        
        // ========================================================================
        // PERIOD RANGE HANDLING: Support both period list and period range
        // ========================================================================
        List<string> expandedPeriods;
        bool isPeriodRange = false;
        string? fromPeriodForRange = null;
        string? toPeriodForRange = null;
        string? fromStartDate = null;
        string? toEndDate = null;
        
        // CRITICAL: Map resolved period names back to original period inputs
        // This ensures frontend receives balances keyed by original input (e.g., "344" → balance)
        // Key = resolved period name (from NetSuite), Value = original input (from frontend)
        Dictionary<string, string> periodNameToOriginalMapping = new Dictionary<string, string>();
        
        // Store period data for later use in P&L query logic
        AccountingPeriod? fromPeriodData = null;
        AccountingPeriod? toPeriodData = null;
        
        if (hasPeriodRange)
        {
            // Period range query - get date range for single query
            isPeriodRange = true;
            fromPeriodForRange = request.FromPeriod;
            toPeriodForRange = request.ToPeriod;
            
            fromPeriodData = await _netSuiteService.GetPeriodAsync(fromPeriodForRange);
            toPeriodData = await _netSuiteService.GetPeriodAsync(toPeriodForRange);
            
            if (fromPeriodData?.StartDate == null || toPeriodData?.EndDate == null)
            {
                _logger.LogWarning("Could not resolve period dates for range: {From} to {To}", 
                    fromPeriodForRange, toPeriodForRange);
                return result;
            }
            
            fromStartDate = ConvertToYYYYMMDD(fromPeriodData.StartDate);
            toEndDate = ConvertToYYYYMMDD(toPeriodData.EndDate);
            
            // For cache, we still need to expand periods to check cache
            var periodsInRange = await GetPeriodsInRangeAsync(fromPeriodForRange, toPeriodForRange);
            expandedPeriods = periodsInRange;
            
            _logger.LogInformation("📅 PERIOD RANGE QUERY: {From} to {To} ({Count} periods) - using date range query", 
                fromPeriodForRange, toPeriodForRange, expandedPeriods.Count);
        }
        else
        {
            // Period list query - expand periods that are year-only
            // CRITICAL: Maintain mapping from resolved period name to original period input
            // This ensures frontend receives balances keyed by original input (e.g., "344" → balance)
            expandedPeriods = new List<string>();
            foreach (var p in request.Periods)
            {
                if (NetSuiteService.IsYearOnly(p))
                {
                    // Get actual period IDs from NetSuite for this year
                    var yearPeriods = await _netSuiteService.GetPeriodsForYearAsync(p);
                    foreach (var period in yearPeriods)
                    {
                        expandedPeriods.Add(period.PeriodName);
                        periodNameToOriginalMapping[period.PeriodName] = period.PeriodName; // Year expansion: resolved = original
                    }
                }
                else
                {
                    // Resolve period ID to period name (e.g., "344" → "Jan 2025")
                    var resolvedPeriod = await _netSuiteService.GetPeriodAsync(p);
                    if (resolvedPeriod != null && !string.IsNullOrEmpty(resolvedPeriod.PeriodName))
                    {
                        expandedPeriods.Add(resolvedPeriod.PeriodName);
                        periodNameToOriginalMapping[resolvedPeriod.PeriodName] = p; // Map resolved name back to original input
                    }
                    else
                    {
                        // If resolution fails, use original (fallback)
                        expandedPeriods.Add(p);
                        periodNameToOriginalMapping[p] = p;
                    }
                }
            }
            expandedPeriods = expandedPeriods.Distinct().ToList();
        }
        
        // CACHE CHECK: Try to serve entirely from cache (like Python's balance_cache)
        var allInCache = true;
        var cachedBalances = new Dictionary<string, Dictionary<string, decimal>>();
        
        foreach (var account in request.Accounts)
        {
            cachedBalances[account] = new Dictionary<string, decimal>();
            
            if (isPeriodRange)
            {
                // For period range, check cache using the range key
                var rangeCacheKey = $"balance:{account}:{fromPeriodForRange}:{toPeriodForRange}:{filtersHash}";
                if (_cache.TryGetValue(rangeCacheKey, out decimal cachedBalance))
                {
                    // Store under a single key representing the range
                    cachedBalances[account][$"{fromPeriodForRange} to {toPeriodForRange}"] = cachedBalance;
                }
                else
                {
                    allInCache = false;
                }
            }
            else
            {
                // For period list, check each period
                // CRITICAL: Use expandedPeriods for cache lookup (cache is keyed by resolved period names)
                // But use original periods for response keys
                foreach (var period in expandedPeriods)
                {
                    var cacheKey = $"balance:{account}:{period}:{filtersHash}";
                    if (_cache.TryGetValue(cacheKey, out decimal cachedBalance))
                    {
                        // Map resolved period name back to original input for response
                        var originalPeriod = periodNameToOriginalMapping.TryGetValue(period, out var orig) ? orig : period;
                        cachedBalances[account][originalPeriod] = cachedBalance;
                    }
                    else
                    {
                        allInCache = false;
                    }
                }
            }
        }
        
        if (allInCache)
        {
            _logger.LogInformation("⚡ BACKEND CACHE HIT: {Accounts} accounts × {Periods} periods", 
                request.Accounts.Count, isPeriodRange ? "range" : expandedPeriods.Count.ToString());
            result.Balances = cachedBalances;
            result.Cached = true;
            return result;
        }
        _logger.LogDebug("Cache miss - querying NetSuite");

        // Get all period dates (with ID for BS CONSOLIDATE)
        // For period range queries, we don't need to expand periods - we use date range directly
        var periodInfo = new Dictionary<string, (string? Start, string? End, string? Id)>();
        
        if (isPeriodRange)
        {
            // For period range queries, we only need the date range (fromStartDate, toEndDate)
            // We don't need to expand periods for the query itself, but we do need them for cache keys
            // If period expansion failed but we have dates, we can still proceed
            if (expandedPeriods.Any())
            {
                // Get period info for cache purposes
                foreach (var period in expandedPeriods)
                {
                    var pd = await _netSuiteService.GetPeriodAsync(period);
                    if (pd != null)
                        periodInfo[period] = (pd.StartDate, pd.EndDate, pd.Id);
                }
            }
            
            // For period range queries, validate that we have date range
            if (string.IsNullOrEmpty(fromStartDate) || string.IsNullOrEmpty(toEndDate))
            {
                _logger.LogWarning("❌ Period range query missing date range - fromStartDate: {From}, toEndDate: {To}", 
                    fromStartDate, toEndDate);
                return result;
            }
            
            _logger.LogInformation("✅ Period range query validated - using date range: {From} to {To}", 
                fromStartDate, toEndDate);
        }
        else
        {
            // For period list queries, we need expanded periods
            foreach (var period in expandedPeriods)
            {
                var pd = await _netSuiteService.GetPeriodAsync(period);
                if (pd != null)
                    periodInfo[period] = (pd.StartDate, pd.EndDate, pd.Id);
            }

            if (!periodInfo.Any())
            {
                _logger.LogWarning("❌ No valid periods found in period list");
                return result;
            }
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
        // STEP 2: Query P&L accounts
        // OPTIMIZATION: Use date range query for period ranges (single query instead of per-period)
        // ===========================================================================
        if (plAccounts.Any())
        {
            var plAccountFilter = NetSuiteService.BuildAccountFilter(plAccounts);
            var signFlip = $"CASE WHEN a.accttype IN ({AccountType.IncomeTypesSql}) THEN -1 ELSE 1 END";

            string plQuery;
            bool isRangeQuery = false;
            
            if (isPeriodRange)
            {
                // OPTIMIZATION: For ranges >2 years, split into individual year queries
                // This avoids NetSuite query execution plan threshold that causes 310x slowdown
                var fromDate = ParseDate(fromPeriodData!.StartDate);
                var toDate = ParseDate(toPeriodData!.EndDate);
                var yearsDiff = 0.0;
                
                if (fromDate.HasValue && toDate.HasValue)
                {
                    var totalDays = (toDate.Value - fromDate.Value).TotalDays;
                    yearsDiff = totalDays / 365.25; // Account for leap years
                }
                
                if (yearsDiff > 2.0)
                {
                    // Split into individual year queries for better performance
                    _logger.LogInformation("📅 P&L PERIOD RANGE QUERY: {Count} accounts, {From} to {To} ({Years:F1} years) - SPLITTING INTO YEAR QUERIES", 
                        plAccounts.Count, fromPeriodForRange, toPeriodForRange, yearsDiff);
                    
                    // Generate year ranges
                    var yearRanges = await GenerateYearRangesAsync(fromPeriodForRange, toPeriodForRange);
                    
                    if (yearRanges.Count == 0)
                    {
                        _logger.LogWarning("Could not generate year ranges for {From} to {To}", fromPeriodForRange, toPeriodForRange);
                        // Fall back to single query using period IDs
                        isRangeQuery = true;
                        var periodIdsInRange = await GetPeriodIdsInRangeAsync(fromPeriodForRange, toPeriodForRange);
                        if (!periodIdsInRange.Any())
                        {
                            _logger.LogWarning("Could not resolve period IDs for range: {From} to {To}", fromPeriodForRange, toPeriodForRange);
                            result.Error = "NOTFOUND";
                            return result;
                        }
                        var periodIdList = string.Join(", ", periodIdsInRange);
                        plQuery = BuildPeriodRangeQueryByIds(plAccountFilter, periodIdList, targetSub, signFlip, accountingBook, segmentWhere);
                    }
                    else
                    {
                        // OPTIMIZATION: Use full_year_refresh query pattern for each year
                        // This gets all 12 months in one query (like quick start), then extract specific months
                        // Much faster than summing entire year ranges
                        var yearBalances = new Dictionary<string, decimal>();
                        
                        // Extract years from ranges
                        var years = new HashSet<int>();
                        foreach (var yearRange in yearRanges)
                        {
                            var fromParts = yearRange.FromPeriod.Split(' ');
                            var toParts = yearRange.ToPeriod.Split(' ');
                            if (fromParts.Length == 2 && int.TryParse(fromParts[1], out var fromYear))
                                years.Add(fromYear);
                            if (toParts.Length == 2 && int.TryParse(toParts[1], out var toYear))
                                years.Add(toYear);
                        }
                        
                        // Get all periods in the original range to determine which months to extract
                        var allPeriodsInRange = await GetPeriodsInRangeAsync(fromPeriodForRange, toPeriodForRange);
                        
                        // For each year, use full_year_refresh pattern to get all 12 months
                        foreach (var year in years.OrderBy(y => y))
                        {
                            _logger.LogDebug("   Querying full year {Year} (all 12 months) using optimized pattern", year);
                            
                            // Use the same query pattern as full_year_refresh
                            var yearResult = await GetFullYearBalancesAsync(year, plAccounts, targetSub, accountingBook, segmentWhere);
                            queryCount++;
                            
                            if (yearResult == null)
                            {
                                _logger.LogWarning("Year query failed for {Year}", year);
                                continue;
                            }
                            
                            // Extract only the months that are in our period range for this year
                            var yearPeriods = allPeriodsInRange.Where(p => 
                            {
                                var parts = p.Split(' ');
                                return parts.Length == 2 && int.TryParse(parts[1], out var pYear) && pYear == year;
                            }).ToList();
                            
                            // Sum balances for months in range
                            foreach (var account in plAccounts)
                            {
                                if (!yearResult.ContainsKey(account))
                                    continue;
                                
                                var accountYearBalances = yearResult[account];
                                decimal yearTotal = 0;
                                
                                foreach (var period in yearPeriods)
                                {
                                    if (accountYearBalances.TryGetValue(period, out var periodBalance))
                                    {
                                        yearTotal += periodBalance;
                                    }
                                }
                                
                                if (!yearBalances.ContainsKey(account))
                                    yearBalances[account] = 0;
                                yearBalances[account] += yearTotal;
                            }
                        }
                        
                        // Store combined results
                        foreach (var account in plAccounts)
                        {
                            if (!result.Balances.ContainsKey(account))
                                result.Balances[account] = new Dictionary<string, decimal>();
                            
                            var totalBalance = yearBalances.GetValueOrDefault(account, 0);
                            var rangeKey = $"{fromPeriodForRange} to {toPeriodForRange}";
                            result.Balances[account][rangeKey] = totalBalance;
                            
                            // Cache the result
                            var rangeCacheKey = $"balance:{account}:{fromPeriodForRange}:{toPeriodForRange}:{filtersHash}";
                            _cache.Set(rangeCacheKey, totalBalance, TimeSpan.FromHours(24));
                        }
                        
                        _logger.LogInformation("✅ Year-split query complete: {Count} accounts, {YearCount} years, total balance calculated", 
                            plAccounts.Count, years.Count);
                        
                        // Skip the single query execution below - set plQuery to empty to skip
                        plQuery = ""; // Empty string signals that year-split was used, skip single query
                    }
                }
                else
                {
                    // PERIOD RANGE QUERY: Single query summing all periods in range (≤2 years)
                    // CRITICAL FIX: Use period IDs instead of date ranges
                    // This is faster for small ranges and ensures identical period filtering
                    isRangeQuery = true;
                    var periodIdsInRange = await GetPeriodIdsInRangeAsync(fromPeriodForRange, toPeriodForRange);
                    if (!periodIdsInRange.Any())
                    {
                        _logger.LogWarning("Could not resolve period IDs for range: {From} to {To}", fromPeriodForRange, toPeriodForRange);
                        result.Error = "NOTFOUND";
                        return result;
                    }
                    var periodIdList = string.Join(", ", periodIdsInRange);
                    plQuery = BuildPeriodRangeQueryByIds(plAccountFilter, periodIdList, targetSub, signFlip, accountingBook, segmentWhere);
                    
                    _logger.LogInformation("📅 P&L PERIOD RANGE QUERY: {Count} accounts, {From} to {To} ({PeriodCount} periods, {Years:F1} years) - SINGLE QUERY (using period IDs)", 
                        plAccounts.Count, fromPeriodForRange, toPeriodForRange, periodIdsInRange.Count, yearsDiff);
                }
            }
            else
            {
                // PERIOD LIST QUERY: Query specific periods using period IDs
                // CRITICAL FIX: Use t.postingperiod IN (periodId1, periodId2, ...) instead of ap.periodname IN (...)
                // Get period IDs for all expanded periods
                var periodIds = new List<string>();
                foreach (var periodName in expandedPeriods)
                {
                    var periodData = await _netSuiteService.GetPeriodAsync(periodName);
                    if (periodData?.Id != null)
                    {
                        periodIds.Add(periodData.Id);
                    }
                    else
                    {
                        _logger.LogWarning("Could not resolve period ID for {PeriodName}", periodName);
                    }
                }
                
                if (!periodIds.Any())
                {
                    _logger.LogWarning("No valid period IDs found for period list query");
                    result.Error = "NOTFOUND";
                    return result;
                }
                
                var periodIdList = string.Join(", ", periodIds);
                // Join to accountingperiod to get periodname for result mapping
                plQuery = $@"
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
                      AND t.postingperiod IN ({periodIdList})
                      AND a.accttype IN ({AccountType.PlTypesSql})
                      AND tal.accountingbook = {accountingBook}
                      AND {segmentWhere}
                    GROUP BY a.acctnumber, ap.periodname";
                
                _logger.LogDebug("P&L batch query for {Count} accounts × {Periods} periods (using period IDs)", plAccounts.Count, expandedPeriods.Count);
            }
            
            // Use error-aware query method
            // For period range queries, use longer timeout (up to 5 minutes for large ranges)
            // Period list queries use default 30s timeout
            // Skip query execution if year-split was used (plQuery will be empty string)
            if (!string.IsNullOrEmpty(plQuery))
            {
                int plQueryTimeout = isRangeQuery ? 300 : 30; // 5 minutes for range, 30s for list
                if (isRangeQuery)
                {
                    _logger.LogInformation("⏱️ Using extended timeout ({Timeout}s) for period range query", plQueryTimeout);
                }
                var plResult = await _netSuiteService.QueryRawWithErrorAsync(plQuery, plQueryTimeout);
                queryCount++;
            
                // INVARIANT: Errors fail loudly - return error code to caller
                if (!plResult.Success)
                {
                    _logger.LogWarning("P&L batch query failed with {ErrorCode}: {Details}", 
                        plResult.ErrorCode, plResult.ErrorDetails);
                    result.Error = plResult.ErrorCode;
                    return result; // Return partial results with error
                }

                if (isRangeQuery)
                {
                    // Period range query returns single total per account
                    if (plResult.Items != null)
                    {
                        foreach (var row in plResult.Items)
                        {
                            var acctnumber = row.TryGetProperty("acctnumber", out var numProp) ? numProp.GetString() ?? "" : "";
                            decimal balance = 0;
                            if (row.TryGetProperty("balance", out var balProp))
                            {
                                balance = ParseBalance(balProp);
                            }

                            if (!result.Balances.ContainsKey(acctnumber))
                                result.Balances[acctnumber] = new Dictionary<string, decimal>();

                            // Store under range key for consistency
                            var rangeKey = $"{fromPeriodForRange} to {toPeriodForRange}";
                            result.Balances[acctnumber][rangeKey] = balance;
                            
                            // Also cache using range key
                            var rangeCacheKey = $"balance:{acctnumber}:{fromPeriodForRange}:{toPeriodForRange}:{filtersHash}";
                            _cache.Set(rangeCacheKey, balance, TimeSpan.FromHours(24));
                        }
                    }
                }
                else
                {
                    // Period list query returns per-period breakdown
                    if (plResult.Items != null)
                    {
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

                            // CRITICAL: Use original period input as key (e.g., "344") instead of resolved name (e.g., "Jan 2025")
                            // This ensures frontend can find the balance using the original period it sent
                            var originalPeriod = periodNameToOriginalMapping.TryGetValue(periodname, out var orig) ? orig : periodname;
                            result.Balances[acctnumber][originalPeriod] = balance;
                        }
                    }
                }
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

            // For period range queries, BS accounts are not supported (they need specific periods)
            // Only P&L accounts support period range queries
            if (isPeriodRange)
            {
                _logger.LogWarning("⚠️ Balance Sheet accounts with period range not supported - BS accounts need specific periods");
                // Skip BS accounts for period range queries
            }
            else
            {
                foreach (var (period, info) in periodInfo)
            {
                if (info.End == null) continue;

                var endDate = ConvertToYYYYMMDD(info.End);
                var periodId = info.Id ?? "NULL";

                if (string.IsNullOrEmpty(periodId) || periodId == "NULL")
                {
                    _logger.LogWarning("BS batch query: period {Period} has no ID, cannot use period-based filtering", period);
                    continue; // Skip this period
                }

                // CRITICAL FIX: Use t.postingperiod <= periodId instead of t.trandate <= TO_DATE(...)
                // This ensures month-by-month and batched queries use identical period filtering
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
                      AND t.postingperiod <= {periodId}
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

                    // CRITICAL: Use original period input as key (e.g., "344") instead of resolved name (e.g., "Jan 2025")
                    // This ensures frontend can find the balance using the original period it sent
                    var originalPeriod = periodNameToOriginalMapping.TryGetValue(period, out var orig) ? orig : period;
                    result.Balances[acctnumber][originalPeriod] = balance;
                }
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
        // CRITICAL: Use original period inputs (from request.Periods) not expandedPeriods
        // This ensures response keys match what frontend sent
        foreach (var account in request.Accounts)
        {
            if (!result.Balances.ContainsKey(account))
                result.Balances[account] = new Dictionary<string, decimal>();

            // Use original periods from request, not expanded periods
            foreach (var originalPeriod in request.Periods)
            {
                // Skip year-only periods (they get expanded, zeros filled per expanded period)
                if (NetSuiteService.IsYearOnly(originalPeriod))
                {
                    // For year-only, check each expanded period
                    foreach (var expandedPeriod in expandedPeriods)
                    {
                        var orig = periodNameToOriginalMapping.TryGetValue(expandedPeriod, out var o) ? o : expandedPeriod;
                        if (!result.Balances[account].ContainsKey(orig))
                            result.Balances[account][orig] = 0;
                    }
                }
                else
                {
                    // For regular periods, use original input
                    if (!result.Balances[account].ContainsKey(originalPeriod))
                        result.Balances[account][originalPeriod] = 0;
                }
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
            var yearPeriods = await _netSuiteService.GetPeriodsForYearAsync(fromPeriod);
            if (yearPeriods.Count == 12)
            {
                fromPeriod = yearPeriods.First().PeriodName;
                toPeriod = yearPeriods.Last().PeriodName;
            }
            else
            {
                _logger.LogWarning("Expected 12 periods for year {Year}, got {Count}", fromPeriod, yearPeriods.Count);
                return new TypeBalanceResponse
                {
                    AccountType = request.AccountType,
                    FromPeriod = request.FromPeriod,
                    ToPeriod = request.ToPeriod,
                    Balance = 0,
                    Error = $"Could not resolve 12 periods for year {fromPeriod}"
                };
            }
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
            
            // Get period ID for BUILTIN.CONSOLIDATE exchange rate and filtering
            var targetPeriodId = !string.IsNullOrEmpty(toPeriodData?.Id) ? toPeriodData.Id : "NULL";
            
            if (string.IsNullOrEmpty(toPeriodData?.Id))
            {
                _logger.LogWarning("TypeBalance BS: toPeriod {ToPeriod} has no ID, cannot use period-based filtering", toPeriod);
                return new TypeBalanceResponse
                {
                    AccountType = request.AccountType,
                    FromPeriod = fromPeriod,
                    ToPeriod = toPeriod,
                    Balance = 0,
                    Error = $"Could not resolve period ID for {toPeriod}"
                };
            }
            
            _logger.LogDebug("TypeBalance BS: periodId={PeriodId}, endDate={EndDate}", targetPeriodId, toEndDate);
            
            // CRITICAL FIX: Use t.postingperiod <= toPeriodId instead of t.trandate <= toEndDate
            // This ensures month-by-month and batched queries use identical period filtering
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
                  AND t.postingperiod <= {targetPeriodId}
                  AND tal.accountingbook = {accountingBook}
                  AND {segmentWhere}";
        }
        else
        {
            // P&L: Period range from fromPeriod to toPeriod
            // Sign flip for Income types (credits stored negative, display positive)
            var signFlip = $"CASE WHEN a.accttype IN ({AccountType.IncomeTypesSql}) THEN -1 ELSE 1 END";
            
            // CRITICAL FIX: Use period IDs instead of date ranges
            // Get all period IDs in the range
            var periodIdsInRange = await GetPeriodIdsInRangeAsync(fromPeriod, toPeriod);
            
            if (!periodIdsInRange.Any())
            {
                _logger.LogWarning("TypeBalance P&L: Could not find period IDs for range: {FromPeriod} to {ToPeriod}", fromPeriod, toPeriod);
                return new TypeBalanceResponse
                {
                    AccountType = request.AccountType,
                    FromPeriod = fromPeriod,
                    ToPeriod = toPeriod,
                    Balance = 0,
                    Error = $"Could not resolve period IDs for range {fromPeriod} to {toPeriod}"
                };
            }
            
            var periodIdList = string.Join(", ", periodIdsInRange);
            
            _logger.LogDebug("TypeBalance P&L: fromPeriod={FromPeriod}, toPeriod={ToPeriod}, periodCount={Count}", 
                fromPeriod, toPeriod, periodIdsInRange.Count);
            
            // CRITICAL FIX: Filter by t.postingperiod IN (periodId1, periodId2, ...) instead of date ranges
            // This ensures month-by-month and batched queries use identical period filtering
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
                JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
                WHERE t.posting = 'T'
                  AND tal.posting = 'T'
                  AND a.accttype IN ({typeFilter})
                  AND t.postingperiod IN ({periodIdList})
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

        // Handle year-only (e.g., "2025") - get actual period IDs from NetSuite
        if (NetSuiteService.IsYearOnly(fromPeriod))
        {
            var yearPeriods = await _netSuiteService.GetPeriodsForYearAsync(fromPeriod);
            if (yearPeriods.Count == 12)
            {
                fromPeriod = yearPeriods.First().PeriodName;
                toPeriod = yearPeriods.Last().PeriodName;
            }
            else
            {
                _logger.LogWarning("Expected 12 periods for year {Year}, got {Count}", fromPeriod, yearPeriods.Count);
                return new List<AccountBalance>();
            }
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

            if (string.IsNullOrEmpty(toPeriodData?.Id))
            {
                _logger.LogWarning("AccountsByType BS: toPeriod {ToPeriod} has no ID, cannot use period-based filtering", toPeriod);
                return new List<AccountBalance>();
            }

            // CRITICAL FIX: Use t.postingperiod <= toPeriodId instead of t.trandate <= toEndDate
            // This ensures month-by-month and batched queries use identical period filtering
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
                  AND t.postingperiod <= {targetPeriodId}
                  AND tal.accountingbook = {accountingBook}
                  AND {segmentWhere}
                GROUP BY a.acctnumber, a.accountsearchdisplayname, a.accttype
                ORDER BY a.acctnumber";
        }
        else
        {
            var signFlip = $"CASE WHEN a.accttype IN ({AccountType.IncomeTypesSql}) THEN -1 ELSE 1 END";

            // CRITICAL FIX: Use period IDs instead of date ranges
            // Get all period IDs in the range
            var periodIdsInRange = await GetPeriodIdsInRangeAsync(fromPeriod, toPeriod);
            
            if (!periodIdsInRange.Any())
            {
                _logger.LogWarning("AccountsByType P&L: Could not find period IDs for range: {FromPeriod} to {ToPeriod}", fromPeriod, toPeriod);
                return new List<AccountBalance>();
            }
            
            var periodIdList = string.Join(", ", periodIdsInRange);
            
            _logger.LogDebug("AccountsByType P&L: fromPeriod={FromPeriod}, toPeriod={ToPeriod}, periodCount={Count}", 
                fromPeriod, toPeriod, periodIdsInRange.Count);

            // CRITICAL FIX: Filter by t.postingperiod IN (periodId1, periodId2, ...) instead of date ranges
            // This ensures month-by-month and batched queries use identical period filtering
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
                JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
                WHERE t.posting = 'T'
                  AND tal.posting = 'T'
                  AND {typeWhere}
                  AND a.isinactive = 'F'
                  AND t.postingperiod IN ({periodIdList})
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
    /// Get opening balance as of anchor date (for balance sheet grid batching).
    /// Returns cumulative balance from inception through anchor date.
    /// </summary>
    private async Task<BalanceResponse> GetOpeningBalanceAsync(BalanceRequest request)
    {
        _logger.LogInformation("Opening balance query: account={Account}, anchor_date={AnchorDate}", 
            request.Account, request.AnchorDate);
        
        // Validate anchor_date format (YYYY-MM-DD)
        if (!DateTime.TryParseExact(request.AnchorDate, "yyyy-MM-dd", null, 
            System.Globalization.DateTimeStyles.None, out var anchorDate))
        {
            return new BalanceResponse
            {
                Account = request.Account,
                Balance = 0,
                Error = $"Invalid anchor_date format: {request.AnchorDate}. Expected YYYY-MM-DD."
            };
        }
        
        // Resolve subsidiary and get hierarchy
        var subsidiaryId = await _lookupService.ResolveSubsidiaryIdAsync(request.Subsidiary);
        var targetSub = subsidiaryId ?? "1";
        var hierarchySubs = await _lookupService.GetSubsidiaryHierarchyAsync(targetSub);
        var subFilter = string.Join(", ", hierarchySubs);
        
        // Resolve dimension filters
        var departmentId = await _lookupService.ResolveDimensionIdAsync("department", request.Department);
        var classId = await _lookupService.ResolveDimensionIdAsync("class", request.Class);
        var locationId = await _lookupService.ResolveDimensionIdAsync("location", request.Location);
        
        var needsTransactionLineJoin = !string.IsNullOrEmpty(departmentId) || 
                                        !string.IsNullOrEmpty(classId) || 
                                        !string.IsNullOrEmpty(locationId) ||
                                        targetSub != "1";
        
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
        var whereSegment = needsTransactionLineJoin ? $"AND {segmentWhere}" : "";
        
        var accountingBook = request.Book ?? DefaultAccountingBook;
        var anchorDateStr = anchorDate.ToString("yyyy-MM-dd");
        
        // CRITICAL FIX: Find the accounting period that contains the anchor date
        // Then use the period ID for filtering instead of the date
        var anchorPeriodQuery = $@"
            SELECT id, periodname
            FROM accountingperiod
            WHERE TO_DATE('{anchorDateStr}', 'YYYY-MM-DD') >= startdate
              AND TO_DATE('{anchorDateStr}', 'YYYY-MM-DD') <= enddate
              AND isposting = 'T'
              AND isquarter = 'F'
              AND isyear = 'F'
            FETCH FIRST 1 ROWS ONLY";
        
        var anchorPeriodResult = await _netSuiteService.QueryRawAsync(anchorPeriodQuery, 30);
        if (anchorPeriodResult == null || !anchorPeriodResult.Any())
        {
            _logger.LogWarning("Opening balance: Could not find period for anchor date {AnchorDate}", anchorDateStr);
            return new BalanceResponse
            {
                Account = request.Account,
                Balance = 0,
                Error = $"Could not find accounting period for anchor date {anchorDateStr}"
            };
        }
        
        var anchorPeriodRow = anchorPeriodResult.First();
        var anchorPeriodId = anchorPeriodRow.TryGetProperty("id", out var idProp) 
            ? idProp.ToString() 
            : null;
        
        if (string.IsNullOrEmpty(anchorPeriodId))
        {
            _logger.LogWarning("Opening balance: Period found but has no ID for anchor date {AnchorDate}", anchorDateStr);
            return new BalanceResponse
            {
                Account = request.Account,
                Balance = 0,
                Error = $"Period has no ID for anchor date {anchorDateStr}"
            };
        }
        
        _logger.LogDebug("Opening balance: anchor_date={AnchorDate}, anchor_period_id={PeriodId}", 
            anchorDateStr, anchorPeriodId);
        
        // Universal sign flip
        var signFlip = $@"
            CASE 
                WHEN a.accttype IN ({AccountType.SignFlipTypesSql}) THEN -1
                WHEN a.accttype IN ({AccountType.IncomeTypesSql}) THEN -1
                ELSE 1 
            END";
        
        var tlJoin = needsTransactionLineJoin 
            ? "JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id" 
            : "";
        
        // CRITICAL FIX: Use t.postingperiod <= anchorPeriodId instead of t.trandate <= anchorDate
        // This ensures month-by-month and batched queries use identical period filtering
        // Use anchor period ID for currency conversion to ensure consistent exchange rates
        var query = $@"
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
                            {anchorPeriodId},
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
                  AND t.postingperiod <= {anchorPeriodId}
                  AND tal.accountingbook = {accountingBook}
                  {whereSegment}
            ) x";
        
        _logger.LogDebug("Opening balance query: anchor_date={AnchorDate}, account={Account}", 
            anchorDateStr, request.Account);
        
        var queryResult = await _netSuiteService.QueryRawWithErrorAsync(query, 180);
        
        if (!queryResult.Success)
        {
            _logger.LogError("Opening balance query failed: {Error}", queryResult.ErrorDetails);
            return new BalanceResponse
            {
                Account = request.Account,
                Balance = 0,
                Error = queryResult.ErrorCode ?? "NETFAIL"
            };
        }
        
        var balance = 0m;
        if (queryResult.Items != null && queryResult.Items.Any())
        {
            var row = queryResult.Items.First();
            balance = ParseBalance(row.TryGetProperty("balance", out var balProp) ? balProp : default);
        }
        
        return new BalanceResponse
        {
            Account = request.Account,
            Balance = balance,
            Total = balance
        };
    }
    
    /// <summary>
    /// Get period activity breakdown for batch mode (for balance sheet grid batching).
    /// Returns per-period activity for each month in the range.
    /// </summary>
    private async Task<BalanceResponse> GetPeriodActivityBreakdownAsync(BalanceRequest request)
    {
        _logger.LogInformation("Period activity breakdown: account={Account}, from_period={FromPeriod}, to_period={ToPeriod}", 
            request.Account, request.FromPeriod, request.ToPeriod);
        
        // Get period dates
        var fromPeriodData = await _netSuiteService.GetPeriodAsync(request.FromPeriod);
        var toPeriodData = await _netSuiteService.GetPeriodAsync(request.ToPeriod);
        
        if (fromPeriodData?.StartDate == null || toPeriodData?.EndDate == null)
        {
            return new BalanceResponse
            {
                Account = request.Account,
                FromPeriod = request.FromPeriod,
                ToPeriod = request.ToPeriod,
                Balance = 0,
                Error = "Could not find period dates"
            };
        }
        
        // Get all periods between fromPeriod and toPeriod
        var periods = await GetPeriodsInRangeAsync(request.FromPeriod, request.ToPeriod);
        if (!periods.Any())
        {
            return new BalanceResponse
            {
                Account = request.Account,
                FromPeriod = request.FromPeriod,
                ToPeriod = request.ToPeriod,
                Balance = 0,
                Error = "Could not find periods in range"
            };
        }
        
        // Resolve subsidiary and get hierarchy
        var subsidiaryId = await _lookupService.ResolveSubsidiaryIdAsync(request.Subsidiary);
        var targetSub = subsidiaryId ?? "1";
        var hierarchySubs = await _lookupService.GetSubsidiaryHierarchyAsync(targetSub);
        var subFilter = string.Join(", ", hierarchySubs);
        
        // Resolve dimension filters
        var departmentId = await _lookupService.ResolveDimensionIdAsync("department", request.Department);
        var classId = await _lookupService.ResolveDimensionIdAsync("class", request.Class);
        var locationId = await _lookupService.ResolveDimensionIdAsync("location", request.Location);
        
        var needsTransactionLineJoin = !string.IsNullOrEmpty(departmentId) || 
                                        !string.IsNullOrEmpty(classId) || 
                                        !string.IsNullOrEmpty(locationId) ||
                                        targetSub != "1";
        
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
        var whereSegment = needsTransactionLineJoin ? $"AND {segmentWhere}" : "";
        
        var accountingBook = request.Book ?? DefaultAccountingBook;
        
        // Universal sign flip (single line to avoid SQL syntax issues in NetSuite)
        var signFlip = $"CASE WHEN a.accttype IN ({AccountType.SignFlipTypesSql}) THEN -1 WHEN a.accttype IN ({AccountType.IncomeTypesSql}) THEN -1 ELSE 1 END";
        
        var tlJoin = needsTransactionLineJoin 
            ? "JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id" 
            : "";
        
        // Get period IDs for the range
        var periodIds = new List<string>();
        var periodNames = new List<string>();
        foreach (var period in periods)
        {
            var periodData = await _netSuiteService.GetPeriodAsync(period);
            if (periodData?.Id != null)
            {
                periodIds.Add(periodData.Id);
                periodNames.Add(period);
            }
        }
        
        if (!periodIds.Any())
        {
            return new BalanceResponse
            {
                Account = request.Account,
                FromPeriod = request.FromPeriod,
                ToPeriod = request.ToPeriod,
                Balance = 0,
                Error = "Could not resolve period IDs"
            };
        }
        
        // Query per-period activity
        // CRITICAL FIX: For single-period queries, use the period ID directly instead of ap.id
        // For multi-period queries, use the LAST period ID (target period) for all transactions
        // NetSuite's BUILTIN.CONSOLIDATE does not accept column references (ap.id) as the period parameter
        var periodIdList = string.Join(",", periodIds);
        // Use the last period ID (target period) for currency conversion - this ensures consistent exchange rates
        var targetPeriodIdForConsolidate = periodIds.Count > 0 ? periodIds[periodIds.Count - 1] : "NULL";
        
        var query = $@"
            SELECT 
                ap.periodname AS period_name,
                ap.startdate AS period_startdate,
                SUM(
                    TO_NUMBER(
                        BUILTIN.CONSOLIDATE(
                            tal.amount,
                            'LEDGER',
                            'DEFAULT',
                            'DEFAULT',
                            {targetSub},
                            {targetPeriodIdForConsolidate},
                            'DEFAULT'
                        )
                    ) * {signFlip}
                ) AS period_activity
            FROM transactionaccountingline tal
            JOIN transaction t ON t.id = tal.transaction
            JOIN account a ON a.id = tal.account
            JOIN accountingperiod ap ON ap.id = t.postingperiod
            {tlJoin}
            WHERE t.posting = 'T'
              AND tal.posting = 'T'
              AND {NetSuiteService.BuildAccountFilter(new[] { request.Account })}
              AND ap.id IN ({periodIdList})
              AND tal.accountingbook = {accountingBook}
              {whereSegment}
            GROUP BY ap.periodname, ap.startdate
            ORDER BY ap.startdate";
        
        _logger.LogDebug("Period activity breakdown query: {PeriodCount} periods", periodIds.Count);
        
        // CRITICAL DEBUG: Log full query for troubleshooting
        _logger.LogDebug("Full period activity query:\n{Query}", query);
        
        var queryResult = await _netSuiteService.QueryRawWithErrorAsync(query, 300);
        
        if (!queryResult.Success)
        {
            _logger.LogError("Period activity breakdown query failed: {Error}", queryResult.ErrorDetails);
            return new BalanceResponse
            {
                Account = request.Account,
                FromPeriod = request.FromPeriod,
                ToPeriod = request.ToPeriod,
                Balance = 0,
                Error = queryResult.ErrorCode ?? "NETFAIL"
            };
        }
        
        // Build period activity dictionary
        var periodActivity = new Dictionary<string, decimal>();
        var total = 0m;
        
        if (queryResult.Items != null)
        {
            foreach (var row in queryResult.Items)
            {
                var periodName = row.TryGetProperty("period_name", out var pnProp) 
                    ? pnProp.GetString() ?? "" 
                    : "";
                var activity = ParseBalance(row.TryGetProperty("period_activity", out var actProp) 
                    ? actProp 
                    : default);
                
                if (!string.IsNullOrEmpty(periodName))
                {
                    periodActivity[periodName] = activity;
                    total += activity;
                }
            }
        }
        
        // Ensure all periods in range are included (even if zero activity)
        foreach (var periodName in periodNames)
        {
            if (!periodActivity.ContainsKey(periodName))
            {
                periodActivity[periodName] = 0m;
            }
        }
        
        return new BalanceResponse
        {
            Account = request.Account,
            FromPeriod = request.FromPeriod,
            ToPeriod = request.ToPeriod,
            Balance = total,
            Total = total,
            PeriodActivity = periodActivity
        };
    }
    
    /// <summary>
    /// Get all period names between fromPeriod and toPeriod (inclusive).
    /// Made public for controller to check period count limits.
    /// </summary>
    public async Task<List<string>> GetPeriodsInRangeAsync(string fromPeriod, string toPeriod)
    {
        var periods = new List<string>();
        
        // Get period data
        var fromPeriodData = await _netSuiteService.GetPeriodAsync(fromPeriod);
        var toPeriodData = await _netSuiteService.GetPeriodAsync(toPeriod);
        
        if (fromPeriodData?.StartDate == null || toPeriodData?.StartDate == null)
            return periods;
        
        // Parse dates
        var fromDate = ParseDate(fromPeriodData.StartDate);
        var toDate = ParseDate(toPeriodData.StartDate);
        
        if (fromDate == null || toDate == null)
            return periods;
        
        // Query all periods in the range
        var fromDateStr = fromDate.Value.ToString("yyyy-MM-dd");
        var toDateStr = toDate.Value.ToString("yyyy-MM-dd");
        
        var query = $@"
            SELECT periodname
            FROM accountingperiod
            WHERE startdate >= TO_DATE('{fromDateStr}', 'YYYY-MM-DD')
              AND startdate <= TO_DATE('{toDateStr}', 'YYYY-MM-DD')
              AND isposting = 'T'
            ORDER BY startdate";
        
        var queryResult = await _netSuiteService.QueryRawWithErrorAsync(query, 30);
        
        if (queryResult.Success && queryResult.Items != null)
        {
            foreach (var row in queryResult.Items)
            {
                var periodName = row.TryGetProperty("periodname", out var pnProp) 
                    ? pnProp.GetString() 
                    : null;
                if (!string.IsNullOrEmpty(periodName))
                {
                    periods.Add(periodName);
                }
            }
        }
        
        return periods;
    }

    /// <summary>
    /// Get all AccountingPeriod internal IDs in a range (e.g., "Jan 2023" to "Dec 2025").
    /// CRITICAL: Returns actual period IDs from NetSuite, ensuring month-by-month and batched queries use identical periods.
    /// </summary>
    public async Task<List<string>> GetPeriodIdsInRangeAsync(string fromPeriod, string toPeriod)
    {
        var periodIds = new List<string>();
        
        // Get period data to determine date range
        var fromPeriodData = await _netSuiteService.GetPeriodAsync(fromPeriod);
        var toPeriodData = await _netSuiteService.GetPeriodAsync(toPeriod);
        
        if (fromPeriodData?.StartDate == null || toPeriodData?.StartDate == null)
            return periodIds;
        
        // Parse dates
        var fromDate = ParseDate(fromPeriodData.StartDate);
        var toDate = ParseDate(toPeriodData.StartDate);
        
        if (fromDate == null || toDate == null)
            return periodIds;
        
        // Query all period IDs in the range
        var fromDateStr = fromDate.Value.ToString("yyyy-MM-dd");
        var toDateStr = toDate.Value.ToString("yyyy-MM-dd");
        
        var query = $@"
            SELECT id
            FROM accountingperiod
            WHERE startdate >= TO_DATE('{fromDateStr}', 'YYYY-MM-DD')
              AND startdate <= TO_DATE('{toDateStr}', 'YYYY-MM-DD')
              AND isposting = 'T'
              AND isquarter = 'F'
              AND isyear = 'F'
            ORDER BY startdate";
        
        var queryResult = await _netSuiteService.QueryRawWithErrorAsync(query, 30);
        
        if (queryResult.Success && queryResult.Items != null)
        {
            foreach (var row in queryResult.Items)
            {
                var periodId = row.TryGetProperty("id", out var idProp) 
                    ? idProp.ToString() 
                    : null;
                if (!string.IsNullOrEmpty(periodId))
                {
                    periodIds.Add(periodId);
                }
            }
        }
        
        return periodIds;
    }
    
    /// <summary>
    /// Generate year ranges for a period range (e.g., "Jan 2023" to "Dec 2025" -> [("Jan 2023", "Dec 2023"), ("Jan 2024", "Dec 2024"), ("Jan 2025", "Dec 2025")]).
    /// Uses calendar years extracted from period names for reliable year boundaries.
    /// </summary>
    private async Task<List<(string FromPeriod, string ToPeriod)>> GenerateYearRangesAsync(string fromPeriod, string toPeriod)
    {
        var ranges = new List<(string, string)>();
        
        // Parse period names to extract years (e.g., "Jan 2023" -> 2023)
        var fromParts = fromPeriod.Split(' ');
        var toParts = toPeriod.Split(' ');
        
        if (fromParts.Length != 2 || toParts.Length != 2)
            return ranges;
        
        if (!int.TryParse(fromParts[1], out var fromYear) || !int.TryParse(toParts[1], out var toYear))
            return ranges;
        
        // Generate year ranges: for each year from fromYear to toYear, create "Jan YYYY" to "Dec YYYY"
        var months = new[] { "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec" };
        
        for (int year = fromYear; year <= toYear; year++)
        {
            string yearFromPeriod, yearToPeriod;
            
            if (year == fromYear && year == toYear)
            {
                // Same year - use original from/to periods
                yearFromPeriod = fromPeriod;
                yearToPeriod = toPeriod;
            }
            else if (year == fromYear)
            {
                // First year - use original from period, end with Dec
                yearFromPeriod = fromPeriod;
                yearToPeriod = $"Dec {year}";
            }
            else if (year == toYear)
            {
                // Last year - start with Jan, use original to period
                yearFromPeriod = $"Jan {year}";
                yearToPeriod = toPeriod;
            }
            else
            {
                // Middle years - full year
                yearFromPeriod = $"Jan {year}";
                yearToPeriod = $"Dec {year}";
            }
            
            // Verify periods exist before adding
            var fromPeriodData = await _netSuiteService.GetPeriodAsync(yearFromPeriod);
            var toPeriodData = await _netSuiteService.GetPeriodAsync(yearToPeriod);
            
            if (fromPeriodData != null && toPeriodData != null)
            {
                ranges.Add((yearFromPeriod, yearToPeriod));
            }
            else
            {
                _logger.LogWarning("Could not verify periods for year range: {From} to {To}", yearFromPeriod, yearToPeriod);
            }
        }
        
        return ranges;
    }
    
    /// <summary>
    /// Get full year balances for ALL accounts using the optimized full_year_refresh query pattern.
    /// Returns: { account: { period: balance } } for all 12 months of the year.
    /// This queries ALL P&L accounts × ALL 12 months in ONE query (like quick start).
    /// </summary>
    private async Task<Dictionary<string, Dictionary<string, decimal>>?> GetFullYearBalancesAsync(
        int year, List<string> requestedAccounts, string targetSub, int accountingBook, string segmentWhere)
    {
        try
        {
            // CRITICAL FIX: Use GetPeriodsForYearAsync to get the exact same periods
            // that would be selected if user entered all 12 months individually
            // This ensures month-by-month and full-year queries use identical period IDs
            var periods = await _netSuiteService.GetPeriodsForYearAsync(year);
            if (periods.Count != 12)
            {
                _logger.LogWarning("Expected 12 periods for year {Year}, got {Count}", year, periods.Count);
                return null;
            }
            
            // Build account filter (filter by requested accounts if provided)
            var accountFilter = requestedAccounts.Any() 
                ? NetSuiteService.BuildAccountFilter(requestedAccounts) 
                : "1=1"; // No filter = get all accounts (like quick start)
            
            var incomeTypesSql = "'Income', 'OthIncome'";
            
            // Build month columns dynamically (same pattern as full_year_refresh)
            var monthCases = new List<string>();
            
            foreach (var period in periods)
            {
                var periodId = period.Id;
                var periodName = period.PeriodName;
                
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
                return null;
            
            var monthColumns = string.Join(",\n", monthCases);
            
            // Get period IDs for filter
            var periodIds = periods
                .Where(p => !string.IsNullOrEmpty(p.Id))
                .Select(p => p.Id)
                .ToList();
            var periodFilter = string.Join(", ", periodIds);
            
            // P&L account types only
            var plTypesSql = "'Income', 'COGS', 'Expense', 'OthIncome', 'OthExpense'";
            
            // Build the main query - ONE query gets ALL accounts × ALL 12 months (like quick start)
            var query = $@"
                SELECT 
                    a.acctnumber AS account_number,
                    {monthColumns}
                FROM transactionaccountingline tal
                JOIN transaction t ON t.id = tal.transaction
                JOIN account a ON a.id = tal.account
                JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
                WHERE t.posting = 'T'
                  AND tal.posting = 'T'
                  AND a.accttype IN ({plTypesSql})
                  AND ({accountFilter})
                  AND t.postingperiod IN ({periodFilter})
                  AND tal.accountingbook = {accountingBook}
                  AND {segmentWhere}
                GROUP BY a.acctnumber
                ORDER BY a.acctnumber";
            
            _logger.LogDebug("Executing full year query for year {Year}: ALL accounts × 12 months in ONE query", year);
            
            var rows = await _netSuiteService.QueryRawAsync(query, 60);
            
            // Month column mapping
            var monthMapping = new Dictionary<string, string>();
            foreach (var period in periods)
            {
                var periodName = period.PeriodName;
                if (string.IsNullOrEmpty(periodName))
                    continue;
                
                var monthAbbr = periodName.Split(' ').FirstOrDefault()?.ToLower() ?? "";
                if (string.IsNullOrEmpty(monthAbbr))
                    continue;
                
                var colName = monthAbbr == "dec" ? "dec_month" : monthAbbr;
                monthMapping[colName] = periodName;
            }
            
            // Transform results
            var balances = new Dictionary<string, Dictionary<string, decimal>>();
            
            foreach (var row in rows)
            {
                var accountNumber = row.TryGetProperty("account_number", out var numProp) ? numProp.GetString() ?? "" : "";
                if (string.IsNullOrEmpty(accountNumber))
                    continue;
                
                balances[accountNumber] = new Dictionary<string, decimal>();
                
                foreach (var (colName, periodName) in monthMapping)
                {
                    decimal amount = 0;
                    if (row.TryGetProperty(colName, out var amountProp) && amountProp.ValueKind != JsonValueKind.Null)
                    {
                        if (amountProp.ValueKind == JsonValueKind.String)
                        {
                            var strVal = amountProp.GetString();
                            if (!string.IsNullOrEmpty(strVal) && double.TryParse(strVal, System.Globalization.NumberStyles.Float, 
                                System.Globalization.CultureInfo.InvariantCulture, out var dblVal))
                                amount = (decimal)dblVal;
                        }
                        else if (amountProp.ValueKind == JsonValueKind.Number)
                            amount = amountProp.GetDecimal();
                    }
                    balances[accountNumber][periodName] = amount;
                }
            }
            
            _logger.LogDebug("Full year query returned {Count} accounts × 12 months", balances.Count);
            
            return balances;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting full year balances for year {Year}", year);
            return null;
        }
    }
    
    /// <summary>
    /// Build a period range query for P&L accounts.
    /// </summary>
    private string BuildPeriodRangeQuery(string plAccountFilter, string fromStartDate, string toEndDate, 
        string targetSub, string signFlip, int accountingBook, string segmentWhere)
    {
        return $@"
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
              AND ap.startdate >= TO_DATE('{fromStartDate}', 'YYYY-MM-DD')
              AND ap.enddate <= TO_DATE('{toEndDate}', 'YYYY-MM-DD')
              AND a.accttype IN ({AccountType.PlTypesSql})
              AND tal.accountingbook = {accountingBook}
              AND {segmentWhere}
            GROUP BY a.acctnumber";
    }
    
    /// <summary>
    /// Build period range query using period IDs instead of dates.
    /// CRITICAL: Uses t.postingperiod IN (periodId1, periodId2, ...) to ensure identical period filtering.
    /// </summary>
    private string BuildPeriodRangeQueryByIds(string plAccountFilter, string periodIdList, 
        string targetSub, string signFlip, int accountingBook, string segmentWhere)
    {
        return $@"
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
                            t.postingperiod,
                            'DEFAULT'
                        )
                    ) * {signFlip}
                ) as balance
            FROM transactionaccountingline tal
            JOIN transaction t ON t.id = tal.transaction
            JOIN account a ON a.id = tal.account
            JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
            WHERE t.posting = 'T'
              AND tal.posting = 'T'
              AND {plAccountFilter}
              AND t.postingperiod IN ({periodIdList})
              AND a.accttype IN ({AccountType.PlTypesSql})
              AND tal.accountingbook = {accountingBook}
              AND {segmentWhere}
            GROUP BY a.acctnumber";
    }

    /// <summary>
    /// Parse date string (handles MM/DD/YYYY and YYYY-MM-DD formats).
    /// </summary>
    private DateTime? ParseDate(string dateStr)
    {
        if (string.IsNullOrEmpty(dateStr))
            return null;
        
        // Try MM/DD/YYYY format
        if (DateTime.TryParseExact(dateStr, "M/d/yyyy", null, 
            System.Globalization.DateTimeStyles.None, out var date1))
            return date1;
        
        if (DateTime.TryParseExact(dateStr, "MM/dd/yyyy", null, 
            System.Globalization.DateTimeStyles.None, out var date2))
            return date2;
        
        // Try YYYY-MM-DD format
        if (DateTime.TryParseExact(dateStr, "yyyy-MM-dd", null, 
            System.Globalization.DateTimeStyles.None, out var date3))
            return date3;
        
        // Try general parsing
        if (DateTime.TryParse(dateStr, out var date4))
            return date4;
        
        return null;
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
    
    /// <summary>
    /// PHASE 2: Column-based batch opening balances for multiple accounts.
    /// Returns opening balances as of anchor period (resolved to date in service layer).
    /// 
    /// CRITICAL: This is additive only - does not modify existing single-account behavior.
    /// Loops accounts internally for correctness (NetSuite batching optimization TODO).
    /// </summary>
    public async Task<BatchOpeningBalancesResponse> GetOpeningBalancesBatchAsync(
        List<string> accounts,
        string anchorPeriod,
        string? subsidiary = null,
        string? department = null,
        string? classFilter = null,
        string? location = null,
        int? book = null)
    {
        _logger.LogInformation("Batch opening balances: {AccountCount} accounts, anchor_period={AnchorPeriod}", 
            accounts.Count, anchorPeriod);
        
        // CRITICAL FIX: Get anchor period ID instead of using date
        var anchorPeriodData = await _netSuiteService.GetPeriodAsync(anchorPeriod);
        if (anchorPeriodData?.Id == null)
        {
            return new BatchOpeningBalancesResponse
            {
                Error = $"Could not resolve anchor period ID: {anchorPeriod}"
            };
        }
        
        var anchorPeriodId = anchorPeriodData.Id;
        
        // Also get end date for logging
        var anchorDateStr = anchorPeriodData.EndDate != null 
            ? ConvertToYYYYMMDD(anchorPeriodData.EndDate) 
            : "unknown";
        
        _logger.LogDebug("Resolved anchor_period={AnchorPeriod} to anchor_period_id={PeriodId}, anchor_date={AnchorDate}", 
            anchorPeriod, anchorPeriodId, anchorDateStr);
        
        // Resolve subsidiary and get hierarchy
        var subsidiaryId = await _lookupService.ResolveSubsidiaryIdAsync(subsidiary);
        var targetSub = subsidiaryId ?? "1";
        var hierarchySubs = await _lookupService.GetSubsidiaryHierarchyAsync(targetSub);
        var subFilter = string.Join(", ", hierarchySubs);
        
        // Resolve dimension filters
        var departmentId = await _lookupService.ResolveDimensionIdAsync("department", department);
        var classId = await _lookupService.ResolveDimensionIdAsync("class", classFilter);
        var locationId = await _lookupService.ResolveDimensionIdAsync("location", location);
        
        var needsTransactionLineJoin = !string.IsNullOrEmpty(departmentId) || 
                                        !string.IsNullOrEmpty(classId) || 
                                        !string.IsNullOrEmpty(locationId) ||
                                        targetSub != "1";
        
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
        var whereSegment = needsTransactionLineJoin ? $"AND {segmentWhere}" : "";
        
        var accountingBook = book ?? DefaultAccountingBook;
        
        // Universal sign flip
        var signFlip = $@"
            CASE 
                WHEN a.accttype IN ({AccountType.SignFlipTypesSql}) THEN -1
                WHEN a.accttype IN ({AccountType.IncomeTypesSql}) THEN -1
                ELSE 1 
            END";
        
        var tlJoin = needsTransactionLineJoin 
            ? "JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id" 
            : "";
        
        // ========================================================================
        // PHASE 2: Loop accounts internally for correctness
        // TODO: Optimize with NetSuite batching (single SuiteQL query with IN clause)
        // ========================================================================
        var balances = new Dictionary<string, decimal>();
        var errors = new List<string>();
        
        foreach (var account in accounts)
        {
            try
            {
                // Query opening balance for this account
                var query = $@"
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
                          AND {NetSuiteService.BuildAccountFilter(new[] { account })}
                          AND t.postingperiod <= {anchorPeriodId}
                          AND tal.accountingbook = {accountingBook}
                          {whereSegment}
                    ) x";
                
                var queryResult = await _netSuiteService.QueryRawWithErrorAsync(query, 180);
                
                if (!queryResult.Success)
                {
                    _logger.LogError("Opening balance query failed for account {Account}: {Error}", 
                        account, queryResult.ErrorDetails);
                    errors.Add($"{account}: {queryResult.ErrorCode ?? "NETFAIL"}");
                    continue;
                }
                
                var balance = 0m;
                if (queryResult.Items != null && queryResult.Items.Any())
                {
                    var row = queryResult.Items.First();
                    balance = ParseBalance(row.TryGetProperty("balance", out var balProp) ? balProp : default);
                }
                
                balances[account] = balance;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error getting opening balance for account {Account}", account);
                errors.Add($"{account}: {ex.Message}");
            }
        }
        
        // CRITICAL: All accounts must be present (missing accounts indicate error)
        if (balances.Count != accounts.Count)
        {
            var missingAccounts = accounts.Where(a => !balances.ContainsKey(a)).ToList();
            return new BatchOpeningBalancesResponse
            {
                Balances = balances,
                Error = $"Missing accounts: {string.Join(", ", missingAccounts)}"
            };
        }
        
        if (errors.Any())
        {
            return new BatchOpeningBalancesResponse
            {
                Balances = balances,
                Error = $"Partial failure: {string.Join("; ", errors)}"
            };
        }
        
        return new BatchOpeningBalancesResponse
        {
            Balances = balances
        };
    }
    
    /// <summary>
    /// PHASE 2: Column-based batch period activity for multiple accounts.
    /// Returns per-period activity breakdown for all accounts across period range.
    /// 
    /// CRITICAL: This is additive only - does not modify existing single-account behavior.
    /// Loops accounts internally for correctness (NetSuite batching optimization TODO).
    /// Always returns nested { account → { period → number } } shape, even for single period.
    /// </summary>
    public async Task<BatchPeriodActivityResponse> GetPeriodActivityBatchAsync(
        List<string> accounts,
        string fromPeriod,
        string toPeriod,
        string? subsidiary = null,
        string? department = null,
        string? classFilter = null,
        string? location = null,
        int? book = null)
    {
        _logger.LogInformation("Batch period activity: {AccountCount} accounts, from_period={FromPeriod}, to_period={ToPeriod}", 
            accounts.Count, fromPeriod, toPeriod);
        
        // Get all periods between fromPeriod and toPeriod
        var periods = await GetPeriodsInRangeAsync(fromPeriod, toPeriod);
        if (!periods.Any())
        {
            return new BatchPeriodActivityResponse
            {
                Error = "Could not find periods in range"
            };
        }
        
        // Resolve subsidiary and get hierarchy
        var subsidiaryId = await _lookupService.ResolveSubsidiaryIdAsync(subsidiary);
        var targetSub = subsidiaryId ?? "1";
        var hierarchySubs = await _lookupService.GetSubsidiaryHierarchyAsync(targetSub);
        var subFilter = string.Join(", ", hierarchySubs);
        
        // Resolve dimension filters
        var departmentId = await _lookupService.ResolveDimensionIdAsync("department", department);
        var classId = await _lookupService.ResolveDimensionIdAsync("class", classFilter);
        var locationId = await _lookupService.ResolveDimensionIdAsync("location", location);
        
        var needsTransactionLineJoin = !string.IsNullOrEmpty(departmentId) || 
                                        !string.IsNullOrEmpty(classId) || 
                                        !string.IsNullOrEmpty(locationId) ||
                                        targetSub != "1";
        
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
        var whereSegment = needsTransactionLineJoin ? $"AND {segmentWhere}" : "";
        
        var accountingBook = book ?? DefaultAccountingBook;
        
        // Universal sign flip
        var signFlip = $@"
            CASE 
                WHEN a.accttype IN ({AccountType.SignFlipTypesSql}) THEN -1
                WHEN a.accttype IN ({AccountType.IncomeTypesSql}) THEN -1
                ELSE 1 
            END";
        
        var tlJoin = needsTransactionLineJoin 
            ? "JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id" 
            : "";
        
        // Get period IDs for the range
        var periodIds = new List<string>();
        var periodNames = new List<string>();
        foreach (var period in periods)
        {
            var periodData = await _netSuiteService.GetPeriodAsync(period);
            if (periodData?.Id != null)
            {
                periodIds.Add(periodData.Id);
                periodNames.Add(period);
            }
        }
        
        if (!periodIds.Any())
        {
            return new BatchPeriodActivityResponse
            {
                Error = "Could not resolve period IDs"
            };
        }
        
        // ========================================================================
        // PHASE 2: Loop accounts internally for correctness
        // TODO: Optimize with NetSuite batching (single SuiteQL query with IN clause for accounts)
        // ========================================================================
        var periodActivity = new Dictionary<string, Dictionary<string, decimal>>();
        var errors = new List<string>();
        
        // CRITICAL FX FIX: Use target period's exchange rate for all periods (matching single-account query and NetSuite Balance Sheet reports)
        // This ensures all period activities are converted at the same rate, making cumulative balances consistent
        // Using each period's own rate (ap.id) would create "mixed rate" balances that don't match NetSuite
        var targetPeriodIdForConsolidate = periodIds.Count > 0 ? periodIds[periodIds.Count - 1] : "NULL";
        
        foreach (var account in accounts)
        {
            try
            {
                // Query per-period activity for this account
                var periodIdList = string.Join(",", periodIds);
                var query = $@"
                    SELECT 
                        ap.periodname AS period_name,
                        SUM(
                            TO_NUMBER(
                                BUILTIN.CONSOLIDATE(
                                    tal.amount,
                                    'LEDGER',
                                    'DEFAULT',
                                    'DEFAULT',
                                    {targetSub},
                                    {targetPeriodIdForConsolidate},
                                    'DEFAULT'
                                )
                            ) * {signFlip}
                        ) AS period_activity
                    FROM transactionaccountingline tal
                    JOIN transaction t ON t.id = tal.transaction
                    JOIN account a ON a.id = tal.account
                    JOIN accountingperiod ap ON ap.id = t.postingperiod
                    {tlJoin}
                    WHERE t.posting = 'T'
                      AND tal.posting = 'T'
                      AND {NetSuiteService.BuildAccountFilter(new[] { account })}
                      AND ap.id IN ({periodIdList})
                      AND tal.accountingbook = {accountingBook}
                      {whereSegment}
                    GROUP BY ap.periodname
                    ORDER BY ap.startdate";
                
                _logger.LogDebug("Period activity query for account {Account}: {PeriodCount} periods", 
                    account, periodIds.Count);
                
                var queryResult = await _netSuiteService.QueryRawWithErrorAsync(query, 300);
                
                if (!queryResult.Success)
                {
                    _logger.LogError("Period activity query failed for account {Account}: {Error}", 
                        account, queryResult.ErrorDetails);
                    errors.Add($"{account}: {queryResult.ErrorCode ?? "NETFAIL"}");
                    continue;
                }
                
                // Build period activity dictionary for this account
                var accountActivity = new Dictionary<string, decimal>();
                
                if (queryResult.Items != null)
                {
                    foreach (var row in queryResult.Items)
                    {
                        var periodName = row.TryGetProperty("period_name", out var pnProp) 
                            ? pnProp.GetString() ?? "" 
                            : "";
                        var activity = ParseBalance(row.TryGetProperty("period_activity", out var actProp) 
                            ? actProp 
                            : default);
                        
                        if (!string.IsNullOrEmpty(periodName))
                        {
                            accountActivity[periodName] = activity;
                        }
                    }
                }
                
                // CRITICAL: Ensure all periods in range are included (even if zero activity)
                // Missing periods must be explicitly returned as 0
                foreach (var periodName in periodNames)
                {
                    if (!accountActivity.ContainsKey(periodName))
                    {
                        accountActivity[periodName] = 0m;
                    }
                }
                
                periodActivity[account] = accountActivity;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error getting period activity for account {Account}", account);
                errors.Add($"{account}: {ex.Message}");
            }
        }
        
        // CRITICAL: All accounts must be present (missing accounts indicate error)
        if (periodActivity.Count != accounts.Count)
        {
            var missingAccounts = accounts.Where(a => !periodActivity.ContainsKey(a)).ToList();
            return new BatchPeriodActivityResponse
            {
                PeriodActivity = periodActivity,
                Error = $"Missing accounts: {string.Join(", ", missingAccounts)}"
            };
        }
        
        if (errors.Any())
        {
            return new BatchPeriodActivityResponse
            {
                PeriodActivity = periodActivity,
                Error = $"Partial failure: {string.Join("; ", errors)}"
            };
        }
        
        return new BatchPeriodActivityResponse
        {
            PeriodActivity = periodActivity
        };
    }
}

/// <summary>
/// Interface for balance service (for DI and testing).
/// </summary>
public interface IBalanceService
{
    Task<BalanceResponse> GetBalanceAsync(BalanceRequest request);
    Task<BalanceBetaResponse> GetBalanceBetaAsync(BalanceBetaRequest request);
    Task<BatchBalanceResponse> GetBatchBalanceAsync(BatchBalanceRequest request);
    Task<TypeBalanceResponse> GetTypeBalanceAsync(TypeBalanceRequest request);

    /// <summary>
    /// Get per-account balances for an account type (drill-down).
    /// </summary>
    Task<List<AccountBalance>> GetTypeBalanceAccountsAsync(TypeBalanceRequest request, bool useSpecialAccountType = false);
    
    /// <summary>
    /// PHASE 2: Column-based batch opening balances for multiple accounts.
    /// Returns opening balances as of anchor period (resolved to date in service layer).
    /// </summary>
    Task<BatchOpeningBalancesResponse> GetOpeningBalancesBatchAsync(
        List<string> accounts,
        string anchorPeriod,
        string? subsidiary = null,
        string? department = null,
        string? classFilter = null,
        string? location = null,
        int? book = null);
    
    /// <summary>
    /// PHASE 2: Column-based batch period activity for multiple accounts.
    /// Returns per-period activity breakdown for all accounts across period range.
    /// </summary>
    Task<BatchPeriodActivityResponse> GetPeriodActivityBatchAsync(
        List<string> accounts,
        string fromPeriod,
        string toPeriod,
        string? subsidiary = null,
        string? department = null,
        string? classFilter = null,
        string? location = null,
        int? book = null);
    
    /// <summary>
    /// Get all period names between fromPeriod and toPeriod (inclusive).
    /// Made public for controller to check period count limits.
    /// </summary>
    Task<List<string>> GetPeriodsInRangeAsync(string fromPeriod, string toPeriod);
    
    /// <summary>
    /// Get all period IDs between fromPeriod and toPeriod (inclusive).
    /// Used for period-ID-based filtering in queries.
    /// </summary>
    Task<List<string>> GetPeriodIdsInRangeAsync(string fromPeriod, string toPeriod);
}


