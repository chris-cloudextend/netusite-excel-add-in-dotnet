/*
 * XAVI for NetSuite - Special Formula Controller
 *
 * Copyright (c) 2025 Celigo, Inc.
 * All rights reserved.
 *
 * Handles specialized financial calculations:
 * - Retained Earnings (prior years' cumulative P&L)
 * - CTA (Cumulative Translation Adjustment)
 * - Net Income
 */

using Microsoft.AspNetCore.Mvc;
using System.Text.Json;
using XaviApi.Models;
using XaviApi.Services;

namespace XaviApi.Controllers;

/// <summary>
/// Controller for specialized financial formulas that require complex calculations.
/// </summary>
[ApiController]
public class SpecialFormulaController : ControllerBase
{
    private readonly INetSuiteService _netSuiteService;
    private readonly ILookupService _lookupService;
    private readonly ILogger<SpecialFormulaController> _logger;
    
    private const int DefaultAccountingBook = 1;

    public SpecialFormulaController(
        INetSuiteService netSuiteService,
        ILookupService lookupService,
        ILogger<SpecialFormulaController> logger)
    {
        _netSuiteService = netSuiteService;
        _lookupService = lookupService;
        _logger = logger;
    }

    /// <summary>
    /// Calculate Retained Earnings (prior years' cumulative P&L).
    /// RE = Sum of all P&L from inception through prior fiscal year end + posted RE adjustments
    /// </summary>
    [HttpPost("/retained-earnings")]
    public async Task<IActionResult> CalculateRetainedEarnings([FromBody] RetainedEarningsRequest request)
    {
        try
        {
            if (string.IsNullOrEmpty(request.Period))
                return BadRequest(new { error = "period is required" });

            _logger.LogInformation("Calculating Retained Earnings for {Period}", request.Period);

            // Resolve subsidiary
            var subsidiaryId = await _lookupService.ResolveSubsidiaryIdAsync(request.Subsidiary);
            var targetSub = subsidiaryId ?? "1";
            
            // Get subsidiary hierarchy
            var hierarchySubs = await _lookupService.GetSubsidiaryHierarchyAsync(targetSub);
            var subFilter = string.Join(", ", hierarchySubs);

            _logger.LogDebug("Subsidiary hierarchy: {Count} subsidiaries", hierarchySubs.Count);

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

            // CRITICAL FIX: Convert accounting book to string (like TYPEBALANCE does)
            // This ensures the SQL query uses the correct type for tal.accountingbook comparison
            var accountingBook = (request.Book ?? DefaultAccountingBook).ToString();

            // Get fiscal year info for the period (needs int for lookup)
            var accountingBookInt = request.Book ?? DefaultAccountingBook;
            var fyInfo = await GetFiscalYearInfoAsync(request.Period, accountingBookInt);
            if (fyInfo == null)
                return BadRequest(new { error = $"Could not find fiscal year for period {request.Period}" });

            var fyStartDate = fyInfo.FyStart;
            var periodEndDate = fyInfo.PeriodEnd;
            var targetPeriodId = fyInfo.PeriodId;

            _logger.LogDebug("Fiscal year starts: {FyStart}, Period ID: {PeriodId}", fyStartDate, targetPeriodId);

            // P&L types SQL
            var plTypesSql = "'Income', 'COGS', 'Expense', 'OthIncome', 'OthExpense'";

            // Sign flip for RE prior P&L: flip ALL P&L by -1 (same as Net Income)
            // This converts: Income (credits/negative) to positive, Expenses (debits/positive) to negative
            // Result: Accumulated Net Income = Income - Expenses
            var signFlipAll = "* -1";

            // CRITICAL FIX: Use fiscal year start period ID from GetFiscalYearInfoAsync (period-based, not date-based)
            var fyStartPeriodId = fyInfo.FyStartPeriodId;
            
            if (fyStartPeriodId == null)
            {
                _logger.LogWarning("Retained Earnings: Could not find period for fiscal year start {FyStart}", fyStartDate);
                return BadRequest(new { error = $"Could not find period for fiscal year start: {fyStartDate}" });
            }
            
            // Query 1: Prior years' P&L (all P&L before fiscal year start)
            // CRITICAL FIX: Use t.postingperiod < fyStartPeriodId instead of ap.enddate < TO_DATE(...)
            // Using Net Income style flip (all * -1) for proper cumulative profit/loss
            var priorPlQuery = $@"
                SELECT SUM(
                    TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', {targetSub}, {targetPeriodId}, 'DEFAULT'))
                    {signFlipAll}
                ) AS value
                FROM transactionaccountingline tal
                JOIN transaction t ON t.id = tal.transaction
                JOIN account a ON a.id = tal.account
                JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
                WHERE t.posting = 'T'
                  AND tal.posting = 'T'
                  AND a.accttype IN ({plTypesSql})
                  AND t.postingperiod < {fyStartPeriodId}
                  AND tal.accountingbook = {accountingBook}
                  AND {segmentWhere}";

            // Query 2: Posted RE adjustments (journal entries to RetainedEarnings accounts)
            // CRITICAL FIX: Use t.postingperiod <= targetPeriodId instead of ap.enddate <= TO_DATE(...)
            // RE is equity (credit/negative), so flip by -1 to get positive for accumulated profits
            var postedReQuery = $@"
                SELECT SUM(
                    TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', {targetSub}, {targetPeriodId}, 'DEFAULT'))
                    * -1
                ) AS value
                FROM transactionaccountingline tal
                JOIN transaction t ON t.id = tal.transaction
                JOIN account a ON a.id = tal.account
                JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
                WHERE t.posting = 'T'
                  AND tal.posting = 'T'
                  AND (a.accttype = 'RetainedEarnings' OR LOWER(a.fullname) LIKE '%retained earnings%')
                  AND t.postingperiod <= {targetPeriodId}
                  AND tal.accountingbook = {accountingBook}
                  AND {segmentWhere}";

            // Execute queries in parallel with error handling
            var priorPlTask = _netSuiteService.QueryRawWithErrorAsync(priorPlQuery, 120);
            var postedReTask = _netSuiteService.QueryRawWithErrorAsync(postedReQuery, 120);

            await Task.WhenAll(priorPlTask, postedReTask);

            // Check for query errors - fail loudly instead of returning 0
            var priorPlResult = await priorPlTask;
            if (!priorPlResult.Success)
            {
                _logger.LogError("Retained Earnings: Prior P&L query failed with {ErrorCode}: {ErrorDetails}", 
                    priorPlResult.ErrorCode, priorPlResult.ErrorDetails);
                return StatusCode(500, new { 
                    error = "Failed to calculate prior P&L", 
                    errorCode = priorPlResult.ErrorCode,
                    errorDetails = priorPlResult.ErrorDetails 
                });
            }

            var postedReResult = await postedReTask;
            if (!postedReResult.Success)
            {
                _logger.LogError("Retained Earnings: Posted RE query failed with {ErrorCode}: {ErrorDetails}", 
                    postedReResult.ErrorCode, postedReResult.ErrorDetails);
                return StatusCode(500, new { 
                    error = "Failed to calculate posted RE", 
                    errorCode = postedReResult.ErrorCode,
                    errorDetails = postedReResult.ErrorDetails 
                });
            }

            // Parse results only if queries succeeded
            decimal priorPl = ParseDecimalFromResult(priorPlResult.Items);
            decimal postedRe = ParseDecimalFromResult(postedReResult.Items);

            var retainedEarnings = priorPl + postedRe;

            _logger.LogInformation("Retained Earnings: prior P&L={PriorPl:N2} + posted RE={PostedRe:N2} = {Total:N2}", 
                priorPl, postedRe, retainedEarnings);

            // Return format matching Python: { "value": ... }
            return Ok(new
            {
                value = retainedEarnings,
                retained_earnings = retainedEarnings,
                prior_pl = priorPl,
                posted_re = postedRe,
                period = request.Period,
                fy_start = fyStartDate
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error calculating retained earnings");
            return StatusCode(500, new { error = ex.Message });
        }
    }

    /// <summary>
    /// Calculate CTA (Cumulative Translation Adjustment) using the PLUG METHOD.
    /// CTA = Total Assets - Total Liabilities - Posted Equity - Prior P&L - Posted RE - Net Income
    /// 
    /// IMPORTANT: This matches the Python implementation exactly:
    /// - NO TransactionLine join (BUILTIN.CONSOLIDATE handles subsidiary filtering)
    /// - Uses ap.enddate for period filtering
    /// - Uses ap.isyear = 'F' AND ap.isquarter = 'F' to exclude summary periods
    /// </summary>
    [HttpPost("/cta")]
    public async Task<IActionResult> CalculateCta([FromBody] CtaRequest request)
    {
        try
        {
            if (string.IsNullOrEmpty(request.Period))
                return BadRequest(new { error = "period is required" });

            _logger.LogInformation("Calculating CTA (PLUG METHOD) for {Period}", request.Period);

            // Resolve subsidiary
            var subsidiaryId = await _lookupService.ResolveSubsidiaryIdAsync(request.Subsidiary);
            var targetSub = subsidiaryId ?? "1";

            // CRITICAL FIX: Convert accounting book to string (like TYPEBALANCE does)
            // This ensures the SQL query uses the correct type for tal.accountingbook comparison
            var accountingBook = (request.Book ?? DefaultAccountingBook).ToString();

            // Get fiscal year info (needs int for lookup)
            var accountingBookInt = request.Book ?? DefaultAccountingBook;
            var fyInfo = await GetFiscalYearInfoAsync(request.Period, accountingBookInt);
            if (fyInfo == null)
                return BadRequest(new { error = $"Could not find fiscal year for period {request.Period}" });

            var periodEndDate = fyInfo.PeriodEnd;
            var fyStartDate = fyInfo.FyStart;
            var targetPeriodId = fyInfo.PeriodId;

            _logger.LogDebug("CTA: Period end={PeriodEnd}, FY start={FyStart}, Period ID={PeriodId}",
                periodEndDate, fyStartDate, targetPeriodId);

            // Account type groups
            var assetTypesSql = AccountType.BsAssetTypesSql;
            var liabilityTypesSql = AccountType.BsLiabilityTypesSql;
            var plTypesSql = "'Income', 'COGS', 'Expense', 'OthIncome', 'OthExpense'";

            // IMPORTANT: NO TransactionLine join - BUILTIN.CONSOLIDATE handles subsidiary filtering
            // Use target_period_id for proper exchange rate translation
            // All sign flips use * -1 to convert credits (negative) to positive display values
            // CRITICAL FIX: Use period IDs instead of dates for all CTA queries

            // Query 1: Total Assets (through period end) - NO flip, debits are already positive
            // CRITICAL FIX: Use t.postingperiod <= targetPeriodId instead of ap.enddate <= TO_DATE(...)
            var assetsQuery = $@"
                SELECT SUM(
                    TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', {targetSub}, {targetPeriodId}, 'DEFAULT'))
                ) AS value
                FROM transactionaccountingline tal
                JOIN transaction t ON t.id = tal.transaction
                JOIN account a ON a.id = tal.account
                WHERE t.posting = 'T'
                  AND tal.posting = 'T'
                  AND a.accttype IN ({assetTypesSql})
                  AND t.postingperiod <= {targetPeriodId}
                  AND tal.accountingbook = {accountingBook}";

            // Query 2: Total Liabilities - flip * -1 to convert credits to positive
            // CRITICAL FIX: Use t.postingperiod <= targetPeriodId instead of ap.enddate <= TO_DATE(...)
            var liabilitiesQuery = $@"
                SELECT SUM(
                    TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', {targetSub}, {targetPeriodId}, 'DEFAULT'))
                    * -1
                ) AS value
                FROM transactionaccountingline tal
                JOIN transaction t ON t.id = tal.transaction
                JOIN account a ON a.id = tal.account
                WHERE t.posting = 'T'
                  AND tal.posting = 'T'
                  AND a.accttype IN ({liabilityTypesSql})
                  AND t.postingperiod <= {targetPeriodId}
                  AND tal.accountingbook = {accountingBook}";

            // Query 3: Posted Equity (excluding Retained Earnings accounts) - flip * -1
            // CRITICAL FIX: Use t.postingperiod <= targetPeriodId instead of ap.enddate <= TO_DATE(...)
            var equityQuery = $@"
                SELECT SUM(
                    TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', {targetSub}, {targetPeriodId}, 'DEFAULT'))
                    * -1
                ) AS value
                FROM transactionaccountingline tal
                JOIN transaction t ON t.id = tal.transaction
                JOIN account a ON a.id = tal.account
                WHERE t.posting = 'T'
                  AND tal.posting = 'T'
                  AND a.accttype = 'Equity'
                  AND LOWER(a.fullname) NOT LIKE '%retained earnings%'
                  AND t.postingperiod <= {targetPeriodId}
                  AND tal.accountingbook = {accountingBook}";

            // Query 4: Prior P&L (all P&L before fiscal year start) - flip ALL * -1 (same as RE)
            // CRITICAL FIX: Use fiscal year start period ID from GetFiscalYearInfoAsync (period-based, not date-based)
            var fyStartPeriodId = fyInfo.FyStartPeriodId;
            
            if (fyStartPeriodId == null)
            {
                _logger.LogWarning("CTA: Could not find period for fiscal year start {FyStart}", fyStartDate);
                return BadRequest(new { error = $"Could not find period for fiscal year start: {fyStartDate}" });
            }
            
            var priorPlQuery = $@"
                SELECT SUM(
                    TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', {targetSub}, {targetPeriodId}, 'DEFAULT'))
                    * -1
                ) AS value
                FROM transactionaccountingline tal
                JOIN transaction t ON t.id = tal.transaction
                JOIN account a ON a.id = tal.account
                WHERE t.posting = 'T'
                  AND tal.posting = 'T'
                  AND a.accttype IN ({plTypesSql})
                  AND t.postingperiod < {fyStartPeriodId}
                  AND tal.accountingbook = {accountingBook}";

            // Query 5: Posted RE adjustments - flip * -1 to convert credits to positive
            // CRITICAL FIX: Use t.postingperiod <= targetPeriodId instead of ap.enddate <= TO_DATE(...)
            var postedReQuery = $@"
                SELECT SUM(
                    TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', {targetSub}, {targetPeriodId}, 'DEFAULT'))
                    * -1
                ) AS value
                FROM transactionaccountingline tal
                JOIN transaction t ON t.id = tal.transaction
                JOIN account a ON a.id = tal.account
                WHERE t.posting = 'T'
                  AND tal.posting = 'T'
                  AND (a.accttype = 'RetainedEarnings' OR LOWER(a.fullname) LIKE '%retained earnings%')
                  AND t.postingperiod <= {targetPeriodId}
                  AND tal.accountingbook = {accountingBook}";

            // Query 6: Net Income (current FY P&L) - flip ALL * -1 (same as Net Income endpoint)
            // CRITICAL FIX: Use t.postingperiod >= fyStartPeriodId AND t.postingperiod <= targetPeriodId
            // (fyStartPeriodId already resolved in Query 4 above)
            var netIncomeQuery = $@"
                SELECT SUM(
                    TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', {targetSub}, {targetPeriodId}, 'DEFAULT'))
                    * -1
                ) AS value
                FROM transactionaccountingline tal
                JOIN transaction t ON t.id = tal.transaction
                JOIN account a ON a.id = tal.account
                WHERE t.posting = 'T'
                  AND tal.posting = 'T'
                  AND a.accttype IN ({plTypesSql})
                  AND t.postingperiod >= {fyStartPeriodId}
                  AND t.postingperiod <= {targetPeriodId}
                  AND tal.accountingbook = {accountingBook}";

            // Execute all 6 queries in parallel with error handling
            var assetsTask = _netSuiteService.QueryRawWithErrorAsync(assetsQuery, 120);
            var liabilitiesTask = _netSuiteService.QueryRawWithErrorAsync(liabilitiesQuery, 120);
            var equityTask = _netSuiteService.QueryRawWithErrorAsync(equityQuery, 120);
            var priorPlTask = _netSuiteService.QueryRawWithErrorAsync(priorPlQuery, 120);
            var postedReTask = _netSuiteService.QueryRawWithErrorAsync(postedReQuery, 120);
            var netIncomeTask = _netSuiteService.QueryRawWithErrorAsync(netIncomeQuery, 120);

            await Task.WhenAll(assetsTask, liabilitiesTask, equityTask, priorPlTask, postedReTask, netIncomeTask);

            // Check for query errors - fail loudly instead of returning 0
            var assetsResult = await assetsTask;
            if (!assetsResult.Success)
            {
                _logger.LogError("CTA: Assets query failed with {ErrorCode}: {ErrorDetails}", 
                    assetsResult.ErrorCode, assetsResult.ErrorDetails);
                return StatusCode(500, new { 
                    error = "Failed to calculate assets", 
                    errorCode = assetsResult.ErrorCode,
                    errorDetails = assetsResult.ErrorDetails 
                });
            }

            var liabilitiesResult = await liabilitiesTask;
            if (!liabilitiesResult.Success)
            {
                _logger.LogError("CTA: Liabilities query failed with {ErrorCode}: {ErrorDetails}", 
                    liabilitiesResult.ErrorCode, liabilitiesResult.ErrorDetails);
                return StatusCode(500, new { 
                    error = "Failed to calculate liabilities", 
                    errorCode = liabilitiesResult.ErrorCode,
                    errorDetails = liabilitiesResult.ErrorDetails 
                });
            }

            var equityResult = await equityTask;
            if (!equityResult.Success)
            {
                _logger.LogError("CTA: Equity query failed with {ErrorCode}: {ErrorDetails}", 
                    equityResult.ErrorCode, equityResult.ErrorDetails);
                return StatusCode(500, new { 
                    error = "Failed to calculate equity", 
                    errorCode = equityResult.ErrorCode,
                    errorDetails = equityResult.ErrorDetails 
                });
            }

            var priorPlResult = await priorPlTask;
            if (!priorPlResult.Success)
            {
                _logger.LogError("CTA: Prior P&L query failed with {ErrorCode}: {ErrorDetails}", 
                    priorPlResult.ErrorCode, priorPlResult.ErrorDetails);
                return StatusCode(500, new { 
                    error = "Failed to calculate prior P&L", 
                    errorCode = priorPlResult.ErrorCode,
                    errorDetails = priorPlResult.ErrorDetails 
                });
            }

            var postedReResult = await postedReTask;
            if (!postedReResult.Success)
            {
                _logger.LogError("CTA: Posted RE query failed with {ErrorCode}: {ErrorDetails}", 
                    postedReResult.ErrorCode, postedReResult.ErrorDetails);
                return StatusCode(500, new { 
                    error = "Failed to calculate posted RE", 
                    errorCode = postedReResult.ErrorCode,
                    errorDetails = postedReResult.ErrorDetails 
                });
            }

            var netIncomeResult = await netIncomeTask;
            if (!netIncomeResult.Success)
            {
                _logger.LogError("CTA: Net Income query failed with {ErrorCode}: {ErrorDetails}", 
                    netIncomeResult.ErrorCode, netIncomeResult.ErrorDetails);
                return StatusCode(500, new { 
                    error = "Failed to calculate net income", 
                    errorCode = netIncomeResult.ErrorCode,
                    errorDetails = netIncomeResult.ErrorDetails 
                });
            }

            // Parse results only if queries succeeded
            decimal totalAssets = ParseDecimalFromResult(assetsResult.Items);
            decimal totalLiabilities = ParseDecimalFromResult(liabilitiesResult.Items);
            decimal postedEquity = ParseDecimalFromResult(equityResult.Items);
            decimal priorPl = ParseDecimalFromResult(priorPlResult.Items);
            decimal postedRe = ParseDecimalFromResult(postedReResult.Items);
            decimal netIncome = ParseDecimalFromResult(netIncomeResult.Items);

            // CTA = Assets - Liabilities - Equity - Prior P&L - Posted RE - Net Income
            var cta = totalAssets - totalLiabilities - postedEquity - priorPl - postedRe - netIncome;

            _logger.LogInformation("CTA: Assets={Assets:N2} - Liabilities={Liabilities:N2} - Equity={Equity:N2} - PriorPL={PriorPl:N2} - PostedRE={PostedRe:N2} - NI={NI:N2} = {CTA:N2}",
                totalAssets, totalLiabilities, postedEquity, priorPl, postedRe, netIncome, cta);

            // Return format matching Python: { "value": ... }
            return Ok(new
            {
                value = cta,
                cta = cta,
                period = request.Period,
                components = new {
                    total_assets = totalAssets,
                    total_liabilities = totalLiabilities,
                    posted_equity = postedEquity,
                    prior_pl = priorPl,
                    posted_re = postedRe,
                    net_income = netIncome
                }
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error calculating CTA");
            return StatusCode(500, new { error = ex.Message });
        }
    }

    /// <summary>
    /// Calculate Net Income (current fiscal year P&L through target period).
    /// NI = Sum of all P&L from fiscal year start (or fromPeriod) through target period end
    /// </summary>
    [HttpPost("/net-income")]
    public async Task<IActionResult> CalculateNetIncome([FromBody] NetIncomeRequest request)
    {
        try
        {
            if (string.IsNullOrEmpty(request.Period))
                return BadRequest(new { error = "period is required" });

            _logger.LogInformation("Calculating Net Income for {Period}", request.Period);

            // Resolve subsidiary
            var subsidiaryId = await _lookupService.ResolveSubsidiaryIdAsync(request.Subsidiary);
            var targetSub = subsidiaryId ?? "1";
            
            // Get subsidiary hierarchy
            var hierarchySubs = await _lookupService.GetSubsidiaryHierarchyAsync(targetSub);
            var subFilter = string.Join(", ", hierarchySubs);

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

            // CRITICAL FIX: Convert accounting book to string (like TYPEBALANCE does)
            // This ensures the SQL query uses the correct type for tal.accountingbook comparison
            var accountingBook = (request.Book ?? DefaultAccountingBook).ToString();

            // Get fiscal year info for the period (needs int for lookup)
            var accountingBookInt = request.Book ?? DefaultAccountingBook;
            var fyInfo = await GetFiscalYearInfoAsync(request.Period, accountingBookInt);
            if (fyInfo == null)
                return BadRequest(new { error = $"Could not find fiscal year for period {request.Period}" });

            // CRITICAL FIX: Use period IDs instead of dates
            string? rangeStartPeriodId;
            if (!string.IsNullOrEmpty(request.FromPeriod))
            {
                // Get period ID for fromPeriod
                var fromPeriodData = await _netSuiteService.GetPeriodAsync(request.FromPeriod);
                if (fromPeriodData == null)
                    return BadRequest(new { error = $"Could not find period: {request.FromPeriod}" });
                rangeStartPeriodId = fromPeriodData.Id;
            }
            else
            {
                // Use fiscal year start period ID
                rangeStartPeriodId = fyInfo.FyStartPeriodId;
            }

            var targetPeriodId = fyInfo.PeriodId;

            _logger.LogDebug("Net Income range: period {StartPeriodId} to {EndPeriodId}", rangeStartPeriodId, targetPeriodId);

            if (rangeStartPeriodId == null)
            {
                var fromPeriodStr = request.FromPeriod ?? "fiscal year start";
                _logger.LogWarning("Net Income: Could not find period for range start {RangeStart}", fromPeriodStr);
                return BadRequest(new { error = $"Could not find period for range start: {fromPeriodStr}" });
            }

            // P&L types SQL and sign flip
            var plTypesSql = "'Income', 'COGS', 'Expense', 'OthIncome', 'OthExpense'";
            
            // Net Income query - flip ALL P&L by -1
            // CRITICAL FIX: Use t.postingperiod >= rangeStartPeriodId AND t.postingperiod <= targetPeriodId
            // instead of date-based filtering
            // Income becomes positive, Expenses become negative
            var netIncomeQuery = $@"
                SELECT SUM(
                    TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', {targetSub}, {targetPeriodId}, 'DEFAULT'))
                    * -1
                ) AS net_income
                FROM transactionaccountingline tal
                JOIN transaction t ON t.id = tal.transaction
                JOIN account a ON a.id = tal.account
                JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
                WHERE t.posting = 'T'
                  AND tal.posting = 'T'
                  AND a.accttype IN ({plTypesSql})
                  AND t.postingperiod >= {rangeStartPeriodId}
                  AND t.postingperiod <= {targetPeriodId}
                  AND tal.accountingbook = {accountingBook}
                  AND {segmentWhere}";

            var result = await _netSuiteService.QueryRawWithErrorAsync(netIncomeQuery, 120);
            
            // Check for query errors - fail loudly instead of returning 0
            if (!result.Success)
            {
                _logger.LogError("Net Income: Query failed with {ErrorCode}: {ErrorDetails}", 
                    result.ErrorCode, result.ErrorDetails);
                return StatusCode(500, new { 
                    error = "Failed to calculate net income", 
                    errorCode = result.ErrorCode,
                    errorDetails = result.ErrorDetails 
                });
            }

            // Parse result only if query succeeded
            decimal netIncome = ParseDecimalFromResult(result.Items, "net_income");

            _logger.LogInformation("Net Income: {NI:N2}", netIncome);

            // Return format matching Python: { "value": ... }
            return Ok(new
            {
                value = netIncome,
                period = request.Period,
                fromPeriod = request.FromPeriod,
                range = new {
                    startPeriodId = rangeStartPeriodId,
                    endPeriodId = targetPeriodId
                },
                fiscal_year = new {
                    start = fyInfo.FyStart,
                    end = fyInfo.FyEnd
                }
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error calculating net income");
            return StatusCode(500, new { error = ex.Message });
        }
    }

    /// <summary>
    /// Helper to get fiscal year info for a period.
    /// Uses period's parent hierarchy to find the correct fiscal year.
    /// Handles both: Month → Quarter → Year and Month → Year (no quarters)
    /// </summary>
    private async Task<FiscalYearInfo?> GetFiscalYearInfoAsync(string periodName, int accountingBook)
    {
        // Query matches Python's approach:
        // 1. tp = target period (monthly)
        // 2. q = quarter (if exists, tp.parent where isquarter='T')
        // 3. fy = fiscal year (q.parent if quarters exist, or tp.parent if no quarters)
        var query = $@"
            SELECT 
                fy.id AS fiscal_year_id,
                fy.startdate AS fy_start,
                fy.enddate AS fy_end,
                tp.id AS period_id,
                tp.startdate AS period_start,
                tp.enddate AS period_end
            FROM accountingperiod tp
            LEFT JOIN accountingperiod q ON q.id = tp.parent AND q.isquarter = 'T'
            LEFT JOIN accountingperiod fy ON (
                (q.parent IS NOT NULL AND fy.id = q.parent) OR
                (q.parent IS NULL AND tp.parent IS NOT NULL AND fy.id = tp.parent)
            )
            WHERE LOWER(tp.periodname) = LOWER('{NetSuiteService.EscapeSql(periodName)}')
              AND tp.isquarter = 'F'
              AND tp.isyear = 'F'
              AND fy.isyear = 'T'
            LIMIT 1";

        var results = await _netSuiteService.QueryRawAsync(query);
        if (!results.Any())
            return null;

        var row = results.First();
        
        string GetDateString(JsonElement row, string propName)
        {
            if (!row.TryGetProperty(propName, out var prop) || prop.ValueKind == JsonValueKind.Null)
                return "";
            var dateStr = prop.GetString() ?? "";
            // Convert MM/DD/YYYY to YYYY-MM-DD
            if (DateTime.TryParseExact(dateStr, "M/d/yyyy", null, System.Globalization.DateTimeStyles.None, out var date))
                return date.ToString("yyyy-MM-dd");
            return dateStr;
        }

        var fiscalYearId = row.TryGetProperty("fiscal_year_id", out var fyId) ? fyId.ToString() : null;
        
        // Get the first period of the fiscal year (using period relationships, not dates)
        string? fyStartPeriodId = null;
        if (!string.IsNullOrEmpty(fiscalYearId))
        {
            var firstPeriodQuery = $@"
                SELECT id
                FROM accountingperiod
                WHERE parent = {fiscalYearId}
                  AND isquarter = 'F'
                  AND isyear = 'F'
                  AND isposting = 'T'
                ORDER BY startdate
                LIMIT 1";
            
            var firstPeriodResults = await _netSuiteService.QueryRawAsync(firstPeriodQuery);
            if (firstPeriodResults.Any())
            {
                var firstPeriodRow = firstPeriodResults.First();
                fyStartPeriodId = firstPeriodRow.TryGetProperty("id", out var idProp) ? idProp.ToString() : null;
            }
        }
        
        return new FiscalYearInfo
        {
            PeriodId = row.TryGetProperty("period_id", out var id) ? id.ToString() : "",
            PeriodStart = GetDateString(row, "period_start"),
            PeriodEnd = GetDateString(row, "period_end"),
            FyStart = GetDateString(row, "fy_start"),
            FyEnd = GetDateString(row, "fy_end"),
            FyStartPeriodId = fyStartPeriodId  // Fiscal year start period ID (for period-based lookups)
        };
    }

    /// <summary>
    /// Parse decimal from query result (handles both string and number types, including scientific notation).
    /// 
    /// CRITICAL: Returns 0 ONLY if query succeeded and value is explicitly null/empty (legitimate zero).
    /// Throws exception if parsing fails (invalid data shape or unparseable string).
    /// </summary>
    private decimal ParseDecimalFromResult(List<JsonElement> results, string fieldName = "value")
    {
        // Empty result set after successful query = legitimate zero (no activity)
        if (!results.Any()) 
            return 0;
            
        var row = results.First();
        
        // Field missing or null = legitimate zero
        if (!row.TryGetProperty(fieldName, out var prop) || prop.ValueKind == JsonValueKind.Null)
            return 0;
        
        if (prop.ValueKind == JsonValueKind.String)
        {
            var strVal = prop.GetString();
            
            // Empty string = legitimate zero
            if (string.IsNullOrEmpty(strVal))
                return 0;
            
            // Handle scientific notation (e.g., "2.402086483E7")
            if (double.TryParse(strVal, System.Globalization.NumberStyles.Float, 
                                System.Globalization.CultureInfo.InvariantCulture, out var dblVal))
            {
                return (decimal)dblVal;
            }
            
            // Try decimal parsing
            if (decimal.TryParse(strVal, out var decVal))
                return decVal;
                
            // String cannot be parsed - this is an error, not a zero
            throw new InvalidOperationException(
                $"Failed to parse decimal from string value '{strVal}' in field '{fieldName}'. " +
                "This indicates a data format issue, not a legitimate zero balance.");
        }
        
        if (prop.ValueKind == JsonValueKind.Number)
            return prop.GetDecimal();
        
        // Unexpected ValueKind (Object, Array, etc.) - this is an error, not a zero
        throw new InvalidOperationException(
            $"Unexpected JSON value kind '{prop.ValueKind}' for field '{fieldName}'. " +
            "Expected Number or String, but got invalid data shape. This indicates a query result format issue.");
    }

    /// <summary>
    /// Fiscal year info helper class.
    /// </summary>
    private class FiscalYearInfo
    {
        public string PeriodId { get; set; } = "";
        public string PeriodStart { get; set; } = "";
        public string PeriodEnd { get; set; } = "";
        public string FyStart { get; set; } = "";
        public string FyEnd { get; set; } = "";
        public string? FyStartPeriodId { get; set; }  // Fiscal year start period ID (for period-based lookups)
    }
}

