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
        
        // CRITICAL: Log immediately when endpoint is called
        _logger.LogInformation("🚀 [BATCH ENDPOINT] /batch/typebalance_refresh called at {Time}", startTime);
        _logger.LogInformation("   Request: Year={Year}, Subsidiary={Sub}, Book={Book}, Dept={Dept}, Loc={Loc}, Class={Class}", 
            request?.Year ?? 0, request?.Subsidiary ?? "null", request?.Book?.ToString() ?? "null", 
            request?.Department ?? "null", request?.Location ?? "null", request?.Class ?? "null");
        
        try
        {
            if (request == null)
            {
                _logger.LogError("❌ [BATCH ENDPOINT] Request is NULL!");
                return BadRequest(new { error = "Request body is required" });
            }
            
            var fiscalYear = request.Year > 0 ? request.Year : DateTime.Now.Year;
            var accountingBook = (request.Book ?? DefaultAccountingBook).ToString();

            _logger.LogInformation("=== BATCH TYPEBALANCE REFRESH: Year {Year}, Book {Book}, Subsidiary {Sub} ===", 
                fiscalYear, accountingBook, request.Subsidiary ?? "null");

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
                
                // CRITICAL FIX: Match individual query structure exactly!
                // Individual query does: TO_NUMBER(BUILTIN.CONSOLIDATE(...)) * signFlip
                // We must do the same: apply sign flip AFTER TO_NUMBER, not inside COALESCE
                // Note: If BUILTIN.CONSOLIDATE returns NULL, TO_NUMBER(NULL) = NULL, and NULL * -1 = NULL (SUM ignores it)
                // This matches the individual query behavior exactly
                // NOTE: BUILTIN.CONSOLIDATE 5th parameter is the consolidation root (subsidiary ID for currency conversion)
                // The accounting book is specified in WHERE clause: tal.accountingbook = {accountingBook}
                var signFlip = $"CASE WHEN a.accttype IN ({incomeTypesSql}) THEN -1 ELSE 1 END";
                monthCases.Add($@"
                    SUM(CASE WHEN t.postingperiod = {periodId} THEN 
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
                  AND t.postingperiod IN ({periodFilter})
                  AND tal.accountingbook = {accountingBook}
                  AND {segmentWhere}
                GROUP BY a.accttype
                ORDER BY a.accttype";

            // CRITICAL DEBUG: Log query details for revenue investigation
            _logger.LogInformation("🔍 [REVENUE DEBUG] Executing batch query for book {Book}, sub {Sub}", accountingBook, request.Subsidiary);
            _logger.LogInformation("   Subsidiary name: '{SubName}'", request.Subsidiary);
            _logger.LogInformation("   Resolved subsidiary ID: {SubId}", subsidiaryId ?? "NULL");
            _logger.LogInformation("   Target subsidiary ID (for BUILTIN.CONSOLIDATE): {TargetSub}", targetSub);
            _logger.LogInformation("   Subsidiary hierarchy (for WHERE filter): {Hierarchy}", subFilter);
            _logger.LogInformation("   Segment WHERE: {SegmentWhere}", segmentWhere);
            _logger.LogInformation("   Period filter: {PeriodFilter}", periodFilter);
            _logger.LogInformation("   Income types SQL: {IncomeTypes}", incomeTypesSql);
            _logger.LogInformation("🔍 [REVENUE DEBUG] Full SQL Query:\n{Query}", query);
            
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
            
            // CRITICAL DEBUG: Log what account types were returned
            var returnedTypes = rows.Select(r => r.TryGetProperty("account_type", out var t) ? t.GetString() : "").Where(t => !string.IsNullOrEmpty(t));
            _logger.LogInformation("🔍 [REVENUE DEBUG] Query returned {Count} rows: {Types}", rows.Count, string.Join(", ", returnedTypes));
            
            // CRITICAL DEBUG: Log ALL rows returned to see what we got
            _logger.LogInformation("🔍 [REVENUE DEBUG] Query returned {Count} rows", rows.Count);
            foreach (var row in rows)
            {
                if (row.TryGetProperty("account_type", out var typeProp))
                {
                    var type = typeProp.GetString() ?? "";
                    _logger.LogInformation("   Row: account_type={Type}", type);
                    
                    // Log all properties in this row to see what columns exist
                    if (type == "Income")
                    {
                        var allProps = new List<string>();
                        foreach (var prop in row.EnumerateObject())
                        {
                            var propValue = prop.Value.ValueKind == JsonValueKind.Number 
                                ? prop.Value.GetDecimal().ToString("N2")
                                : prop.Value.ValueKind == JsonValueKind.Null 
                                    ? "NULL" 
                                    : prop.Value.ToString();
                            allProps.Add($"{prop.Name}={propValue}");
                        }
                        _logger.LogInformation("   Income row properties ({Count}): {Props}", 
                            allProps.Count, string.Join(", ", allProps));
                        
                        // CRITICAL: Check if "apr" column exists and its value
                        if (row.TryGetProperty("apr", out var aprProp))
                        {
                            var aprValue = aprProp.ValueKind == JsonValueKind.Number 
                                ? aprProp.GetDecimal() 
                                : 0;
                            _logger.LogInformation("   ✅ Income 'apr' column found: {Value:N2} (ValueKind: {Kind})", 
                                aprValue, aprProp.ValueKind);
                        }
                        else
                        {
                            _logger.LogWarning("   ❌ Income 'apr' column NOT FOUND in row!");
                            // Check what month columns DO exist
                            var monthCols = row.EnumerateObject()
                                .Where(p => p.Name.Length <= 4 && !p.Name.Equals("account_type", StringComparison.OrdinalIgnoreCase))
                                .Select(p => p.Name)
                                .ToList();
                            _logger.LogInformation("   Available month-like columns: {Cols}", string.Join(", ", monthCols));
                        }
                    }
                }
            }
            
            // CRITICAL DEBUG: Check if Income row exists
            var incomeRow = rows.FirstOrDefault(r => {
                if (r.TryGetProperty("account_type", out var typeProp))
                {
                    var type = typeProp.GetString() ?? "";
                    return type.Equals("Income", StringComparison.OrdinalIgnoreCase);
                }
                return false;
            });
            
            // Check if incomeRow is not default (JsonElement default is empty object)
            if (incomeRow.ValueKind != JsonValueKind.Undefined && incomeRow.ValueKind != JsonValueKind.Null)
            {
                _logger.LogInformation("🔍 [REVENUE DEBUG] Income row found - checking values...");
                // Log ALL month values (not just first 6) to see the full picture
                var allMonths = new[] { "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec_month" };
                decimal totalIncome = 0;
                int monthsWithData = 0;
                int monthsWithNull = 0;
                foreach (var month in allMonths)
                {
                    if (incomeRow.TryGetProperty(month, out var valProp))
                    {
                        decimal val = 0;
                        if (valProp.ValueKind == JsonValueKind.Number)
                            val = valProp.GetDecimal();
                        else if (valProp.ValueKind == JsonValueKind.String)
                        {
                            var strVal = valProp.GetString();
                            if (string.IsNullOrEmpty(strVal) || strVal == "NULL")
                            {
                                monthsWithNull++;
                                _logger.LogWarning("   Income {Month}: NULL (TO_NUMBER returned NULL)", month);
                            }
                            else
                            {
                                decimal.TryParse(strVal, out val);
                            }
                        }
                        else if (valProp.ValueKind == JsonValueKind.Null)
                        {
                            monthsWithNull++;
                            _logger.LogWarning("   Income {Month}: NULL (TO_NUMBER returned NULL)", month);
                        }
                        _logger.LogInformation("   Income {Month}: {Value:N2} (ValueKind: {Kind})", month, val, valProp.ValueKind);
                        if (val != 0)
                        {
                            totalIncome += val;
                            monthsWithData++;
                        }
                    }
                    else
                    {
                        _logger.LogWarning("   Income {Month}: Property not found in result row", month);
                    }
                }
                _logger.LogInformation("   Income summary: {MonthsWithData}/12 months have data, {MonthsWithNull} NULL values, total: {Total:N2}", monthsWithData, monthsWithNull, totalIncome);
                
                // CRITICAL DEBUG: If all values are 0, check if there are Income transactions at all
                if (monthsWithData == 0 && monthsWithNull == 0)
                {
                    _logger.LogWarning("⚠️ [REVENUE DEBUG] All Income values are 0 - checking if Income transactions exist...");
                    // Run a diagnostic query to see if Income transactions exist
                    var diagnosticQuery = $@"
                        SELECT COUNT(*) as transaction_count,
                               SUM(ABS(tal.amount)) as total_amount
                        FROM transactionaccountingline tal
                        JOIN transaction t ON t.id = tal.transaction
                        JOIN account a ON a.id = tal.account
                        JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
                        WHERE t.posting = 'T'
                          AND tal.posting = 'T'
                          AND a.accttype = 'Income'
                          AND t.postingperiod IN ({periodFilter})
                          AND tal.accountingbook = {accountingBook}
                          AND {segmentWhere}";
                    
                    try
                    {
                        var diagResult = await _netSuiteService.QueryRawWithErrorAsync(diagnosticQuery);
                        if (diagResult.Success && diagResult.Items.Any())
                        {
                            var diagRow = diagResult.Items[0];
                            var count = 0;
                            var total = 0m;
                            if (diagRow.TryGetProperty("transaction_count", out var cProp))
                            {
                                if (cProp.ValueKind == JsonValueKind.Number)
                                    count = cProp.GetInt32();
                                else if (cProp.ValueKind == JsonValueKind.String && int.TryParse(cProp.GetString(), out var parsedCount))
                                    count = parsedCount;
                            }
                            if (diagRow.TryGetProperty("total_amount", out var aProp))
                            {
                                if (aProp.ValueKind == JsonValueKind.Number)
                                    total = aProp.GetDecimal();
                                else if (aProp.ValueKind == JsonValueKind.String && decimal.TryParse(aProp.GetString(), out var parsedTotal))
                                    total = parsedTotal;
                            }
                            _logger.LogInformation("   Diagnostic: {Count} Income transactions found, total absolute amount: {Total:N2}", count, total);
                            
                            if (count > 0 && total > 0)
                            {
                                _logger.LogError("❌ [REVENUE DEBUG] Income transactions EXIST ({Count} transactions, {Total:N2} absolute) but batch query returned 0!", count, total);
                                _logger.LogError("   This indicates BUILTIN.CONSOLIDATE is returning NULL for all Income amounts");
                                
                                // Test BUILTIN.CONSOLIDATE directly for one period
                                if (periodIds.Any())
                                {
                                    var testPeriodId = periodIds.First();
                                    var testQuery = $@"
                                        SELECT 
                                            COUNT(*) as count,
                                            SUM(TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', {targetSub}, {testPeriodId}, 'DEFAULT'))) as consolidated_sum,
                                            SUM(tal.amount) as raw_sum
                                        FROM transactionaccountingline tal
                                        JOIN transaction t ON t.id = tal.transaction
                                        JOIN account a ON a.id = tal.account
                                        JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
                                        WHERE t.posting = 'T'
                                          AND tal.posting = 'T'
                                          AND a.accttype = 'Income'
                                          AND t.postingperiod = {testPeriodId}
                                          AND tal.accountingbook = {accountingBook}
                                          AND {segmentWhere}";
                                    
                                    try
                                    {
                                        var testResult = await _netSuiteService.QueryRawWithErrorAsync(testQuery);
                                        if (testResult.Success && testResult.Items.Any())
                                        {
                                            var testRow = testResult.Items[0];
                                            var testCount = 0;
                                            var consolidatedSum = 0m;
                                            var rawSum = 0m;
                                            if (testRow.TryGetProperty("count", out var tcProp))
                                            {
                                                if (tcProp.ValueKind == JsonValueKind.Number)
                                                    testCount = tcProp.GetInt32();
                                                else if (tcProp.ValueKind == JsonValueKind.String && int.TryParse(tcProp.GetString(), out var parsedCount))
                                                    testCount = parsedCount;
                                            }
                                            if (testRow.TryGetProperty("consolidated_sum", out var csProp))
                                            {
                                                if (csProp.ValueKind == JsonValueKind.Number)
                                                    consolidatedSum = csProp.GetDecimal();
                                                else if (csProp.ValueKind == JsonValueKind.String && decimal.TryParse(csProp.GetString(), out var parsedSum))
                                                    consolidatedSum = parsedSum;
                                            }
                                            if (testRow.TryGetProperty("raw_sum", out var rsProp))
                                            {
                                                if (rsProp.ValueKind == JsonValueKind.Number)
                                                    rawSum = rsProp.GetDecimal();
                                                else if (rsProp.ValueKind == JsonValueKind.String && decimal.TryParse(rsProp.GetString(), out var parsedRaw))
                                                    rawSum = parsedRaw;
                                            }
                                            _logger.LogInformation("   Test query (period {PeriodId}): {Count} transactions, consolidated_sum: {Consolidated:N2}, raw_sum: {Raw:N2}", 
                                                testPeriodId, testCount, consolidatedSum, rawSum);
                                            
                                            if (testCount > 0 && rawSum != 0 && consolidatedSum == 0)
                                            {
                                                _logger.LogError("   ❌ CONFIRMED: BUILTIN.CONSOLIDATE returns NULL/0 for Income! Raw sum: {Raw:N2}, Consolidated: {Consolidated:N2}", rawSum, consolidatedSum);
                                            }
                                        }
                                    }
                                    catch (Exception testEx)
                                    {
                                        _logger.LogWarning("   Could not run test query: {Error}", testEx.Message);
                                    }
                                }
                            }
                        }
                    }
                    catch (Exception ex)
                    {
                        _logger.LogWarning("   Could not run diagnostic query: {Error}", ex.Message);
                    }
                }
            }
            else
            {
                _logger.LogWarning("⚠️ [REVENUE DEBUG] Income row NOT FOUND in query results!");
                _logger.LogWarning("   This means the query returned no Income account type data");
                _logger.LogWarning("   Possible causes:");
                _logger.LogWarning("   1. No Income transactions for book {Book} + sub {Sub}", accountingBook, request.Subsidiary);
                _logger.LogWarning("   2. Query filter too restrictive (segmentWhere: {SegmentWhere})", segmentWhere);
                _logger.LogWarning("   3. BUILTIN.CONSOLIDATE returning NULL for all Income amounts");
            }

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
                    JsonElement amountProp = default;
                    bool found = false;
                    
                    // Try exact match first (lowercase as we generate it)
                    found = row.TryGetProperty(colName, out amountProp);
                    
                    // If not found, try case-insensitive lookup (NetSuite might return uppercase)
                    if (!found)
                    {
                        foreach (var prop in row.EnumerateObject())
                        {
                            if (string.Equals(prop.Name, colName, StringComparison.OrdinalIgnoreCase))
                            {
                                amountProp = prop.Value;
                                found = true;
                                _logger.LogDebug("   Found column '{Actual}' (case-insensitive match for '{Expected}')", 
                                    prop.Name, colName);
                                break;
                            }
                        }
                    }
                    
                    if (found && amountProp.ValueKind != JsonValueKind.Null)
                    {
                        if (amountProp.ValueKind == JsonValueKind.String)
                        {
                            var strVal = amountProp.GetString();
                            if (!string.IsNullOrEmpty(strVal) && decimal.TryParse(strVal, out var parsed))
                                amount = parsed;
                        }
                        else if (amountProp.ValueKind == JsonValueKind.Number)
                        {
                            amount = amountProp.GetDecimal();
                        }
                    }
                    
                    balances[acctType][periodName] = amount;
                    
                    // CRITICAL DEBUG: Log Income values as they're processed
                    if (acctType == "Income" && periodName.Contains("Apr"))
                    {
                        _logger.LogInformation("🔍 [REVENUE DEBUG] Processing Income {Period}: colName={ColName}, found={Found}, ValueKind={Kind}, amount={Amount:N2}", 
                            periodName, colName, found, found ? amountProp.ValueKind : JsonValueKind.Undefined, amount);
                    }
                }

                // Log sample for debugging
                if (balances.Count <= 3)
                {
                    var sampleMonth = $"Jan {fiscalYear}";
                    var sampleVal = balances[acctType].GetValueOrDefault(sampleMonth, 0);
                    _logger.LogDebug("{Type}: {Month} = ${Value:N2}", acctType, sampleMonth, sampleVal);
                }
            }

            // CRITICAL VERIFICATION: Log all periods and values for Income and Expense
            // This proves revenue and expenses are returned for all periods (March-Dec 2025)
            if (balances.ContainsKey("Income") || balances.ContainsKey("Expense"))
            {
                var targetYear = fiscalYear;
                var monthsToVerify = new[] { "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec" };
                var verificationLog = new List<string>();
                
                foreach (var month in monthsToVerify)
                {
                    var periodName = $"{month} {targetYear}";
                    
                    if (balances.ContainsKey("Income"))
                    {
                        var incomeValue = balances["Income"].GetValueOrDefault(periodName, 0);
                        verificationLog.Add($"Income:{periodName}={incomeValue:N2}");
                    }
                    
                    if (balances.ContainsKey("Expense"))
                    {
                        var expenseValue = balances["Expense"].GetValueOrDefault(periodName, 0);
                        verificationLog.Add($"Expense:{periodName}={expenseValue:N2}");
                    }
                }
                
                _logger.LogInformation("✅ VERIFICATION: March-Dec {Year} data for book {Book}, sub {Sub}: {Data}", 
                    targetYear, accountingBook, request.Subsidiary, string.Join(" | ", verificationLog));
                
                // Verify all periods are present (none missing)
                var allPeriods = monthMapping.Values.ToList();
                var missingPeriods = new List<string>();
                
                if (balances.ContainsKey("Income"))
                {
                    foreach (var period in allPeriods)
                    {
                        if (!balances["Income"].ContainsKey(period))
                        {
                            missingPeriods.Add($"Income:{period}");
                        }
                    }
                }
                
                if (balances.ContainsKey("Expense"))
                {
                    foreach (var period in allPeriods)
                    {
                        if (!balances["Expense"].ContainsKey(period))
                        {
                            missingPeriods.Add($"Expense:{period}");
                        }
                    }
                }
                
                if (missingPeriods.Any())
                {
                    _logger.LogWarning("⚠️ VERIFICATION FAILED: Missing periods: {Missing}", string.Join(", ", missingPeriods));
                }
                else
                {
                    _logger.LogInformation("✅ VERIFICATION PASSED: All periods present for Income and Expense (none missing)");
                }
            }

            // For any P&L types not in results (no activity), add zeros
            foreach (var ptype in plTypes)
            {
                if (!balances.ContainsKey(ptype))
                {
                    balances[ptype] = monthMapping.Values.ToDictionary(p => p, p => 0m);
                    _logger.LogDebug("Added zero-filled entry for missing account type: {Type}", ptype);
                }
            }

            // CRITICAL FIX: Log all account types being returned to verify Issue 2 fix
            var returnedTypesList = string.Join(", ", balances.Keys.OrderBy(k => k));
            _logger.LogInformation("Returning {Count} account types × 12 months in {Elapsed:F2}s", balances.Count, elapsed);
            _logger.LogInformation("Account types returned: {Types}", returnedTypesList);
            
            // Verify all expected types are present
            var missingTypes = plTypes.Except(balances.Keys).ToList();
            if (missingTypes.Any())
            {
                _logger.LogWarning("⚠️ Missing account types in response (should not happen): {Missing}", string.Join(", ", missingTypes));
            }
            
            // CRITICAL VERIFICATION: Log period count for each account type
            foreach (var acctType in plTypes)
            {
                if (balances.ContainsKey(acctType))
                {
                    var periodCount = balances[acctType].Count;
                    _logger.LogInformation("📊 {Type}: {Count} periods returned", acctType, periodCount);
                    
                    // Log all period names for this type
                    var periodNames = string.Join(", ", balances[acctType].Keys.OrderBy(k => k));
                    _logger.LogDebug("   Periods: {Periods}", periodNames);
                }
            }

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

