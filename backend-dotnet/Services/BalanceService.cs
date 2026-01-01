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

        // Handle year-only format
        if (NetSuiteService.IsYearOnly(fromPeriod))
        {
            var (from, to) = NetSuiteService.ExpandYearToPeriods(fromPeriod);
            fromPeriod = from;
            toPeriod = to;
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
            // Use t.trandate (transaction date) for date filtering
            // Always use BUILTIN.CONSOLIDATE with targetPeriodId (toPeriod's rate)
            
            queryTimeout = 180; // Cumulative queries scan all history
            
            // OPTIMIZATION: Skip TransactionLine join for root consolidated subsidiary with no filters
            var tlJoin = needsTransactionLineJoin 
                ? "JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id" 
                : "";
            var whereSegment = needsTransactionLineJoin ? $"AND {segmentWhere}" : "";
            
            _logger.LogDebug("Point-in-time query: toEndDate={EndDate}, sub={Sub}, periodId={PeriodId}", 
                toEndDate, targetSub, targetPeriodId);
            
            // CRITICAL: Use TARGET period ID (toPeriod) for exchange rate
            // This ensures ALL historical transactions convert at the SAME exchange rate
            // (the target period's rate), which is required for Balance Sheet to balance correctly
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
                      AND t.trandate <= TO_DATE('{toEndDate}', 'YYYY-MM-DD')
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
                // For BS accounts, sum transactions in the date range directly
                // This is mathematically equivalent to: Balance(toDate) - Balance(beforeFromDate)
                // but avoids two expensive cumulative queries
                
                queryTimeout = 60; // Range queries are much faster (single indexed scan)
                
                // Get period dates for range bounds
                var fromPeriodData = await _netSuiteService.GetPeriodAsync(fromPeriod);
                if (fromPeriodData?.StartDate == null)
                {
                    _logger.LogWarning("Could not find period dates for from_period: {FromPeriod}", fromPeriod);
                    return new BalanceResponse
                    {
                        Account = request.Account,
                        FromPeriod = request.FromPeriod,
                        ToPeriod = toPeriod,
                        Balance = 0,
                        Error = $"Could not find period: {fromPeriod}"
                    };
                }
                
                // Convert dates to YYYY-MM-DD format for range query
                // Use accounting period dates (not transaction dates) to match P&L behavior
                // This ensures we only include transactions posted in the specified periods
                var bsFromStartDate = ConvertToYYYYMMDD(fromPeriodData.StartDate);
                var bsToEndDate = ConvertToYYYYMMDD(toPeriodData.EndDate);
                
                _logger.LogDebug("BS period activity (range query): account={Account}, fromPeriod={FromPeriod}, toPeriod={ToPeriod}, fromDate={FromDate}, toDate={ToDate}, periodId={PeriodId}",
                    request.Account, fromPeriod, toPeriod, bsFromStartDate, bsToEndDate, targetPeriodId);
                
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
                
                // CRITICAL: Must join TransactionLine for segment filters AND accounting period
                // Even if no segment filters, we need the accounting period join for date filtering
                var tlJoin = "JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id";
                
                // Single range-bounded query: transactions posted in periods between fromPeriod and toPeriod
                // Uses accounting period dates (not transaction dates) to match P&L behavior
                // This produces the same result as: Balance(toDate) - Balance(beforeFromDate)
                // but only scans the date range, not all history
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
                        JOIN accountingperiod ap ON ap.id = t.postingperiod
                        {tlJoin}
                        WHERE t.posting = 'T'
                          AND tal.posting = 'T'
                          AND {NetSuiteService.BuildAccountFilter(new[] { request.Account })}
                          AND ap.startdate >= TO_DATE('{bsFromStartDate}', 'YYYY-MM-DD')
                          AND ap.enddate <= TO_DATE('{bsToEndDate}', 'YYYY-MM-DD')
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
                // P&L ACCOUNTS: Keep existing behavior unchanged
                // ========================================================================
                // For Income/Expense accounts, continue using the existing logic
                // This ensures 100% backward compatibility for P&L queries
                
                queryTimeout = 180; // May need two cumulative queries
                
                // Get period immediately before fromPeriod
                // For period activity, we need: Balance(toPeriod) - Balance(before fromPeriod)
                // We'll calculate this as two separate cumulative queries and subtract
            
            // Get the end date of the period immediately before fromPeriod
            var fromPeriodData = await _netSuiteService.GetPeriodAsync(fromPeriod);
            if (fromPeriodData?.StartDate == null)
            {
                _logger.LogWarning("Could not find period dates for from_period: {FromPeriod}", fromPeriod);
                return new BalanceResponse
                {
                    Account = request.Account,
                    FromPeriod = request.FromPeriod,
                    ToPeriod = toPeriod,
                    Balance = 0,
                    Error = $"Could not find period: {fromPeriod}"
                };
            }
            
            // Calculate end date of period immediately before fromPeriod
            // This is the day before fromPeriod's start date
            // StartDate is a string in MM/DD/YYYY format, convert to DateTime first
            var fromStartDateObj = DateTime.Parse(fromPeriodData.StartDate!);
            var beforeFromPeriodEndDateObj = fromStartDateObj.AddDays(-1);
            var beforeFromPeriodEndDate = ConvertToYYYYMMDD(beforeFromPeriodEndDateObj.ToString("MM/dd/yyyy"));
            
            _logger.LogDebug("Period activity query: fromPeriod={FromPeriod}, toPeriod={ToPeriod}, beforeFromEndDate={BeforeFromEndDate}, periodId={PeriodId}", 
                fromPeriod, toPeriod, beforeFromPeriodEndDate, targetPeriodId);
            
            // Calculate Balance(toPeriod) - Balance(before fromPeriod)
            // Both use targetPeriodId (toPeriod's rate) for currency conversion
            
            var tlJoin = needsTransactionLineJoin 
                ? "JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id" 
                : "";
            var whereSegment = needsTransactionLineJoin ? $"AND {segmentWhere}" : "";
            
            // Query for balance as of toPeriod (cumulative)
            var toBalanceQuery = $@"
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
                      AND t.trandate <= TO_DATE('{toEndDate}', 'YYYY-MM-DD')
                      AND tal.accountingbook = {accountingBook}
                      {whereSegment}
                ) x";
            
                // Query for balance as of period before fromPeriod (cumulative)
                var beforeFromBalanceQuery = $@"
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
                          AND t.trandate <= TO_DATE('{beforeFromPeriodEndDate}', 'YYYY-MM-DD')
                          AND tal.accountingbook = {accountingBook}
                          {whereSegment}
                    ) x";
                
                // Execute both queries
                var toBalanceResult = await _netSuiteService.QueryRawWithErrorAsync(toBalanceQuery, queryTimeout);
                var beforeFromBalanceResult = await _netSuiteService.QueryRawWithErrorAsync(beforeFromBalanceQuery, queryTimeout);
                
                if (!toBalanceResult.Success)
                {
                    _logger.LogWarning("P&L period activity: toPeriod balance query failed: {Error}", toBalanceResult.ErrorDetails);
                    return new BalanceResponse
                    {
                        Account = request.Account,
                        FromPeriod = request.FromPeriod,
                        ToPeriod = toPeriod,
                        Balance = 0,
                        Error = toBalanceResult.ErrorCode ?? "QUERY_FAILED"
                    };
                }
                
                if (!beforeFromBalanceResult.Success)
                {
                    _logger.LogWarning("P&L period activity: before fromPeriod balance query failed: {Error}", beforeFromBalanceResult.ErrorDetails);
                    return new BalanceResponse
                    {
                        Account = request.Account,
                        FromPeriod = request.FromPeriod,
                        ToPeriod = toPeriod,
                        Balance = 0,
                        Error = beforeFromBalanceResult.ErrorCode ?? "QUERY_FAILED"
                    };
                }
                
                // Extract balances
                decimal toBalance = 0;
                if (toBalanceResult.Items.Any())
                {
                    var row = toBalanceResult.Items.First();
                    if (row.TryGetProperty("balance", out var balProp))
                        toBalance = ParseBalance(balProp);
                }
                
                decimal beforeFromBalance = 0;
                if (beforeFromBalanceResult.Items.Any())
                {
                    var row = beforeFromBalanceResult.Items.First();
                    if (row.TryGetProperty("balance", out var balProp))
                        beforeFromBalance = ParseBalance(balProp);
                }
                
                // Calculate activity: Balance(toPeriod) - Balance(before fromPeriod)
                var activity = toBalance - beforeFromBalance;
                
                _logger.LogInformation("P&L period activity: Balance({ToPeriod})={ToBalance:N2}, Balance(before {FromPeriod})={BeforeBalance:N2}, Activity={Activity:N2}",
                    toPeriod, toBalance, fromPeriod, beforeFromBalance, activity);
                
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

        // Handle year-only format
        if (NetSuiteService.IsYearOnly(fromPeriod))
        {
            var (from, to) = NetSuiteService.ExpandYearToPeriods(fromPeriod);
            fromPeriod = from;
            toPeriod = to;
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
                      AND t.trandate <= TO_DATE('{toEndDate}', 'YYYY-MM-DD')
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

            // For P&L accounts, using t.postingperiod is acceptable (each period uses its own rate)
            // But for consistency and to match NetSuite GL reports, we can also use target period
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
                    JOIN accountingperiod ap ON ap.id = t.postingperiod
                    JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
                    WHERE t.posting = 'T'
                      AND tal.posting = 'T'
                      AND {NetSuiteService.BuildAccountFilter(new[] { request.Account })}
                      AND ap.startdate >= TO_DATE('{fromStartDate}', 'YYYY-MM-DD')
                      AND ap.enddate <= TO_DATE('{toEndDate}', 'YYYY-MM-DD')
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
        
        if (hasPeriodRange)
        {
            // Period range query - get date range for single query
            isPeriodRange = true;
            fromPeriodForRange = request.FromPeriod;
            toPeriodForRange = request.ToPeriod;
            
            var fromPeriodData = await _netSuiteService.GetPeriodAsync(fromPeriodForRange);
            var toPeriodData = await _netSuiteService.GetPeriodAsync(toPeriodForRange);
            
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
            expandedPeriods = request.Periods.SelectMany(p =>
            {
                if (NetSuiteService.IsYearOnly(p))
                {
                    var (from, to) = NetSuiteService.ExpandYearToPeriods(p);
                    return GenerateMonthlyPeriods(from, to);
                }
                return new[] { p };
            }).Distinct().ToList();
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
                foreach (var period in expandedPeriods)
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
                // PERIOD RANGE QUERY: Single query summing all periods in range
                // This is much faster than querying each period separately
                isRangeQuery = true;
                plQuery = $@"
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
                
                _logger.LogInformation("📅 P&L PERIOD RANGE QUERY: {Count} accounts, {From} to {To} ({PeriodCount} periods) - SINGLE QUERY", 
                    plAccounts.Count, fromPeriodForRange, toPeriodForRange, expandedPeriods.Count);
            }
            else
            {
                // PERIOD LIST QUERY: Query specific periods (existing behavior)
                var periodsIn = string.Join(", ", expandedPeriods.Select(p => $"'{NetSuiteService.EscapeSql(p)}'"));
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
                      AND ap.periodname IN ({periodsIn})
                      AND a.accttype IN ({AccountType.PlTypesSql})
                      AND tal.accountingbook = {accountingBook}
                      AND {segmentWhere}
                    GROUP BY a.acctnumber, ap.periodname";
                
                _logger.LogDebug("P&L batch query for {Count} accounts × {Periods} periods", plAccounts.Count, expandedPeriods.Count);
            }
            
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

            if (isRangeQuery)
            {
                // Period range query returns single total per account
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
            else
            {
                // Period list query returns per-period breakdown
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
        
        // Query cumulative balance up to anchor date
        // Use anchor date's period ID for currency conversion (if available)
        // For now, use postingperiod as fallback
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
                  AND {NetSuiteService.BuildAccountFilter(new[] { request.Account })}
                  AND t.trandate <= TO_DATE('{anchorDateStr}', 'YYYY-MM-DD')
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
        
        // Resolve anchor period to date (delegate to accounting calendar)
        var anchorPeriodData = await _netSuiteService.GetPeriodAsync(anchorPeriod);
        if (anchorPeriodData?.EndDate == null)
        {
            return new BatchOpeningBalancesResponse
            {
                Error = $"Could not resolve anchor period: {anchorPeriod}"
            };
        }
        
        // Parse anchor date (end of anchor period)
        var anchorDate = ParseDate(anchorPeriodData.EndDate);
        if (anchorDate == null)
        {
            return new BatchOpeningBalancesResponse
            {
                Error = $"Could not parse anchor date from period: {anchorPeriod}"
            };
        }
        
        var anchorDateStr = anchorDate.Value.ToString("yyyy-MM-dd");
        _logger.LogDebug("Resolved anchor_period={AnchorPeriod} to anchor_date={AnchorDate}", 
            anchorPeriod, anchorDateStr);
        
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
                          AND t.trandate <= TO_DATE('{anchorDateStr}', 'YYYY-MM-DD')
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
}

