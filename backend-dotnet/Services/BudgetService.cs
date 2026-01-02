/*
 * XAVI for NetSuite - Budget Service
 *
 * Copyright (c) 2025 Celigo, Inc.
 * All rights reserved.
 *
 * This service handles budget queries from NetSuite.
 */

using System.Text.Json;
using XaviApi.Models;

namespace XaviApi.Services;

/// <summary>
/// Service for budget queries.
/// </summary>
public class BudgetService : IBudgetService
{
    private readonly INetSuiteService _netSuiteService;
    private readonly ILogger<BudgetService> _logger;

    public BudgetService(INetSuiteService netSuiteService, ILogger<BudgetService> logger)
    {
        _netSuiteService = netSuiteService;
        _logger = logger;
    }
    
    /// <summary>
    /// Parse an amount value from JSON, handling scientific notation (e.g., "2.402086483E7").
    /// </summary>
    private static decimal ParseAmount(JsonElement element)
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
            
            // Handle scientific notation
            if (double.TryParse(strVal, System.Globalization.NumberStyles.Float, 
                                System.Globalization.CultureInfo.InvariantCulture, out var dblVal))
            {
                return (decimal)dblVal;
            }
            
            if (decimal.TryParse(strVal, out var decVal))
                return decVal;
        }
        
        return 0;
    }

    /// <summary>
    /// Get budget amount for a single account and period range.
    /// </summary>
    public async Task<BudgetResponse> GetBudgetAsync(BudgetRequest request)
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

        var fromPeriodData = await _netSuiteService.GetPeriodAsync(fromPeriod);
        var toPeriodData = await _netSuiteService.GetPeriodAsync(toPeriod);

        if (fromPeriodData?.StartDate == null || toPeriodData?.EndDate == null)
        {
            return new BudgetResponse
            {
                Account = request.Account,
                FromPeriod = fromPeriod,
                ToPeriod = toPeriod,
                Amount = 0
            };
        }

        // Get period IDs for the date range
        // If single period, use that period's ID
        // If range, expand to all months in range
        var periodIds = new List<string>();
        
        if (fromPeriod == toPeriod)
        {
            // Single period
            if (fromPeriodData?.Id != null)
                periodIds.Add(fromPeriodData.Id);
        }
        else
        {
            // Range - expand to all months
            var expandedPeriods = GenerateMonthlyPeriods(fromPeriod, toPeriod);
            foreach (var period in expandedPeriods)
            {
                var periodData = await _netSuiteService.GetPeriodAsync(period);
                if (periodData?.Id != null)
                    periodIds.Add(periodData.Id);
            }
        }

        if (!periodIds.Any())
        {
            _logger.LogWarning("No period IDs found for range {From} to {To}", fromPeriod, toPeriod);
            return new BudgetResponse
            {
                Account = request.Account,
                FromPeriod = fromPeriod,
                ToPeriod = toPeriod,
                Category = request.Category,
                Amount = 0
            };
        }

        var periodIdList = string.Join(",", periodIds);

        // Build filters using the correct table structure (Budgets table, not BudgetsMachine)
        var whereClauses = new List<string> 
        { 
            $"a.acctnumber = '{NetSuiteService.EscapeSql(request.Account)}'",
            $"bm.period IN ({periodIdList})"
        };

        // Category filter - use Budgets table (b.category)
        if (!string.IsNullOrEmpty(request.Category))
        {
            if (int.TryParse(request.Category, out var catId))
            {
                whereClauses.Add($"b.category = {catId}");
            }
            else
            {
                // Look up category ID by name
                var catQuery = $@"
                    SELECT id FROM BudgetCategory 
                    WHERE name = '{NetSuiteService.EscapeSql(request.Category)}'
                    FETCH FIRST 1 ROWS ONLY";
                var catResults = await _netSuiteService.QueryRawAsync(catQuery);
                if (catResults.Any())
                {
                    var catRow = catResults.First();
                    if (catRow.TryGetProperty("id", out var catIdProp))
                    {
                        var catIdStr = catIdProp.GetString();
                        if (!string.IsNullOrEmpty(catIdStr))
                            whereClauses.Add($"b.category = {catIdStr}");
                    }
                }
            }
        }

        // Subsidiary filter - use Budgets table (b.subsidiary)
        string? subsidiaryId = null;
        if (!string.IsNullOrEmpty(request.Subsidiary))
        {
            if (int.TryParse(request.Subsidiary, out var subId))
            {
                subsidiaryId = request.Subsidiary;
            }
            else
            {
                // Look up subsidiary ID by name
                var subQuery = $@"
                    SELECT id FROM subsidiary 
                    WHERE name = '{NetSuiteService.EscapeSql(request.Subsidiary)}'
                    FETCH FIRST 1 ROWS ONLY";
                var subResults = await _netSuiteService.QueryRawAsync(subQuery);
                if (subResults.Any())
                {
                    var subRow = subResults.First();
                    if (subRow.TryGetProperty("id", out var subIdProp))
                        subsidiaryId = subIdProp.GetString();
                }
            }
        }

        // Use default subsidiary if not specified
        var targetSub = subsidiaryId ?? "1";

        if (!string.IsNullOrEmpty(subsidiaryId))
        {
            whereClauses.Add($"b.subsidiary = {subsidiaryId}");
        }

        // Department, Class, Location filters - these are on BudgetsMachine but may not be available
        // Skip these for now as they may not be supported in NetSuite's BudgetsMachine structure

        var whereClause = string.Join(" AND ", whereClauses);

        // Query BudgetsMachine table - use correct structure matching GetAllBudgetsAsync
        // CRITICAL: Join through Budgets table (b) to get account and category
        var query = $@"
            SELECT 
                SUM(
                    TO_NUMBER(BUILTIN.CONSOLIDATE(
                        bm.amount, 'LEDGER', 'DEFAULT', 'DEFAULT',
                        {targetSub}, bm.period, 'DEFAULT'
                    ))
                ) as amount
            FROM BudgetsMachine bm
            INNER JOIN Budgets b ON bm.budget = b.id
            INNER JOIN Account a ON b.account = a.id
            WHERE {whereClause}";

        var results = await _netSuiteService.QueryRawAsync(query);

        decimal amount = 0;
        if (results.Any())
        {
            var row = results.First();
            if (row.TryGetProperty("amount", out var amtProp))
                amount = ParseAmount(amtProp);
        }

        return new BudgetResponse
        {
            Account = request.Account,
            FromPeriod = fromPeriod,
            ToPeriod = toPeriod,
            Category = request.Category,
            Amount = amount
        };
    }

    /// <summary>
    /// Get budgets for multiple accounts and periods.
    /// </summary>
    public async Task<BatchBudgetResponse> GetBatchBudgetAsync(BatchBudgetRequest request)
    {
        var result = new BatchBudgetResponse
        {
            Budgets = new Dictionary<string, Dictionary<string, decimal>>()
        };

        if (!request.Accounts.Any() || !request.Periods.Any())
            return result;

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

        // Get all period dates
        var periodDates = new Dictionary<string, (string? Start, string? End)>();
        foreach (var period in expandedPeriods)
        {
            var pd = await _netSuiteService.GetPeriodAsync(period);
            if (pd != null)
                periodDates[period] = (pd.StartDate, pd.EndDate);
        }

        if (!periodDates.Any())
            return result;

        var filters = BuildFilters(request.Subsidiary, request.Department, request.Class, request.Location, request.Category);
        var accountFilter = NetSuiteService.BuildAccountFilter(request.Accounts);
        var minDate = periodDates.Values.Where(v => v.Start != null).Min(v => v.Start);
        var maxDate = periodDates.Values.Where(v => v.End != null).Max(v => v.End);

        var query = $@"
            SELECT 
                a.acctnumber,
                p.periodname,
                SUM(bm.amount) as amount
            FROM BudgetsMachine bm
            JOIN account a ON bm.account = a.id
            JOIN accountingperiod p ON bm.accountingperiod = p.id
            WHERE {accountFilter}
            AND p.startdate >= TO_DATE('{minDate}', 'MM/DD/YYYY')
            AND p.enddate <= TO_DATE('{maxDate}', 'MM/DD/YYYY')
            AND p.isquarter = 'F' AND p.isyear = 'F'
            {filters}
            GROUP BY a.acctnumber, p.periodname";

        var rows = await _netSuiteService.QueryRawAsync(query);

        foreach (var row in rows)
        {
            var acctnumber = row.GetProperty("acctnumber").GetString() ?? "";
            var periodname = row.TryGetProperty("periodname", out var periodProp) ? periodProp.GetString() ?? "" : "";
            var amount = row.TryGetProperty("amount", out var amtProp) 
                ? ParseAmount(amtProp)
                : 0;

            if (!result.Budgets.ContainsKey(acctnumber))
                result.Budgets[acctnumber] = new Dictionary<string, decimal>();

            result.Budgets[acctnumber][periodname] = amount;
        }

        result.QueryCount = 1;
        return result;
    }

    /// <summary>
    /// Build SQL filter clauses.
    /// </summary>
    private string BuildFilters(string? subsidiary, string? department, string? @class, string? location, string? category)
    {
        var filters = new List<string>();

        if (!string.IsNullOrEmpty(subsidiary))
            filters.Add($"bm.subsidiary = (SELECT id FROM subsidiary WHERE name = '{NetSuiteService.EscapeSql(subsidiary)}')");

        if (!string.IsNullOrEmpty(department))
            filters.Add($"bm.department = (SELECT id FROM department WHERE name = '{NetSuiteService.EscapeSql(department)}')");

        if (!string.IsNullOrEmpty(@class))
            filters.Add($"bm.class = (SELECT id FROM classification WHERE name = '{NetSuiteService.EscapeSql(@class)}')");

        if (!string.IsNullOrEmpty(location))
            filters.Add($"bm.location = (SELECT id FROM location WHERE name = '{NetSuiteService.EscapeSql(location)}')");

        if (!string.IsNullOrEmpty(category))
            filters.Add($"bm.budgetcategory = (SELECT id FROM budgetcategory WHERE name = '{NetSuiteService.EscapeSql(category)}')");

        return filters.Any() ? "AND " + string.Join(" AND ", filters) : "";
    }

    /// <summary>
    /// Generate list of monthly periods between from and to.
    /// </summary>
    private IEnumerable<string> GenerateMonthlyPeriods(string from, string to)
    {
        var months = new[] { "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec" };
        var periods = new List<string>();

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
    /// Get all budget data for a given year.
    /// Returns all accounts with budget amounts for each month.
    /// </summary>
    public async Task<AllBudgetsResponse> GetAllBudgetsAsync(int year, string? subsidiary = null, string? category = null)
    {
        var result = new AllBudgetsResponse
        {
            Year = year,
            Category = category ?? "",
            Accounts = new Dictionary<string, Dictionary<string, decimal>>(),
            AccountNames = new Dictionary<string, string>(),
            AccountTypes = new Dictionary<string, string>()
        };

        try
        {
            // Step 1: Get all periods for the year
            var periodQuery = $@"
                SELECT id, periodname, startdate
                FROM AccountingPeriod
                WHERE EXTRACT(YEAR FROM startdate) = {year}
                  AND isquarter = 'F'
                  AND isyear = 'F'
                  AND isadjust = 'F'
                ORDER BY startdate";

            var periodResults = await _netSuiteService.QueryRawAsync(periodQuery);

            if (!periodResults.Any())
            {
                _logger.LogWarning("No accounting periods found for year {Year}", year);
                return result;
            }

            // Step 2: Build period ID to month name mapping
            var periodMap = new Dictionary<string, string>(); // period_id -> month name (e.g., "Jan")
            var monthNames = new[] { "Jan", "Feb", "Mar", "Apr", "May", "Jun", 
                                     "Jul", "Aug", "Sep", "Oct", "Nov", "Dec" };

            foreach (var row in periodResults)
            {
                var periodId = row.TryGetProperty("id", out var idProp) ? idProp.GetString() : null;
                var startdate = row.TryGetProperty("startdate", out var dateProp) ? dateProp.GetString() : null;

                if (string.IsNullOrEmpty(periodId) || string.IsNullOrEmpty(startdate))
                    continue;

                // Parse month from startdate (format: "1/1/2011" or "2011-01-01")
                try
                {
                    int monthNum = 0;
                    if (startdate.Contains('/'))
                    {
                        var parts = startdate.Split('/');
                        if (parts.Length >= 1 && int.TryParse(parts[0], out monthNum))
                        {
                            if (monthNum >= 1 && monthNum <= 12)
                                periodMap[periodId] = monthNames[monthNum - 1];
                        }
                    }
                    else if (startdate.Contains('-'))
                    {
                        var parts = startdate.Split('-');
                        if (parts.Length >= 2 && int.TryParse(parts[1], out monthNum))
                        {
                            if (monthNum >= 1 && monthNum <= 12)
                                periodMap[periodId] = monthNames[monthNum - 1];
                        }
                    }
                }
                catch
                {
                    // Skip invalid dates
                }
            }

            if (!periodMap.Any())
            {
                _logger.LogWarning("Could not parse periods for year {Year}", year);
                return result;
            }

            var periodIds = string.Join(",", periodMap.Keys);

            // Step 3: Build WHERE clauses
            var whereClauses = new List<string> { $"bm.period IN ({periodIds})" };

            // Category filter
            if (!string.IsNullOrEmpty(category))
            {
                if (int.TryParse(category, out var catId))
                {
                    whereClauses.Add($"b.category = {catId}");
                }
                else
                {
                    // Look up category ID by name
                    var catQuery = $@"
                        SELECT id FROM BudgetCategory 
                        WHERE name = '{NetSuiteService.EscapeSql(category)}'
                        FETCH FIRST 1 ROWS ONLY";
                    var catResults = await _netSuiteService.QueryRawAsync(catQuery);
                    if (catResults.Any())
                    {
                        var catRow = catResults.First();
                        if (catRow.TryGetProperty("id", out var catIdProp))
                        {
                            var catIdStr = catIdProp.GetString();
                            if (!string.IsNullOrEmpty(catIdStr))
                                whereClauses.Add($"b.category = {catIdStr}");
                        }
                    }
                }
            }

            // Subsidiary filter - resolve to ID if needed
            string? subsidiaryId = null;
            if (!string.IsNullOrEmpty(subsidiary))
            {
                if (int.TryParse(subsidiary, out var subId))
                {
                    subsidiaryId = subsidiary;
                }
                else
                {
                    // Look up subsidiary ID by name
                    var subQuery = $@"
                        SELECT id FROM subsidiary 
                        WHERE name = '{NetSuiteService.EscapeSql(subsidiary)}'
                        FETCH FIRST 1 ROWS ONLY";
                    var subResults = await _netSuiteService.QueryRawAsync(subQuery);
                    if (subResults.Any())
                    {
                        var subRow = subResults.First();
                        if (subRow.TryGetProperty("id", out var subIdProp))
                            subsidiaryId = subIdProp.GetString();
                    }
                }
            }

            // Use default subsidiary if not specified
            var targetSub = subsidiaryId ?? "1";

            if (!string.IsNullOrEmpty(subsidiaryId))
            {
                whereClauses.Add($"b.subsidiary = {subsidiaryId}");
            }

            var whereClause = string.Join(" AND ", whereClauses);

            // Step 4: Query all budget data
            var query = $@"
                SELECT 
                    a.acctnumber AS account_number,
                    a.accountsearchdisplaynamecopy AS account_name,
                    a.accttype AS account_type,
                    bm.period AS period_id,
                    SUM(
                        TO_NUMBER(BUILTIN.CONSOLIDATE(
                            bm.amount, 'LEDGER', 'DEFAULT', 'DEFAULT',
                            {targetSub}, bm.period, 'DEFAULT'
                        ))
                    ) AS amount
                FROM BudgetsMachine bm
                INNER JOIN Budgets b ON bm.budget = b.id
                INNER JOIN Account a ON b.account = a.id
                WHERE {whereClause}
                GROUP BY a.acctnumber, a.accountsearchdisplaynamecopy, a.accttype, bm.period
                ORDER BY a.acctnumber, bm.period";

            _logger.LogInformation("Querying all budgets for year {Year}", year);
            var budgetResults = await _netSuiteService.QueryRawAsync(query);

            // Step 5: Process results
            foreach (var row in budgetResults)
            {
                var acctNum = row.TryGetProperty("account_number", out var acctNumProp) 
                    ? acctNumProp.GetString() ?? "" : "";
                var acctName = row.TryGetProperty("account_name", out var acctNameProp) 
                    ? acctNameProp.GetString() ?? "" : "";
                var acctType = row.TryGetProperty("account_type", out var acctTypeProp) 
                    ? acctTypeProp.GetString() ?? "" : "";
                var periodId = row.TryGetProperty("period_id", out var periodIdProp) 
                    ? periodIdProp.GetString() ?? "" : "";
                var amount = row.TryGetProperty("amount", out var amtProp) 
                    ? ParseAmount(amtProp) : 0;

                if (string.IsNullOrEmpty(acctNum))
                    continue;

                // Initialize account if needed
                if (!result.Accounts.ContainsKey(acctNum))
                {
                    result.Accounts[acctNum] = new Dictionary<string, decimal>();
                    result.AccountNames[acctNum] = acctName;
                    result.AccountTypes[acctNum] = acctType;
                }

                // Map period ID to month name and add to account data
                if (periodMap.TryGetValue(periodId, out var monthName))
                {
                    var key = $"{monthName} {year}";
                    result.Accounts[acctNum][key] = amount;
                }
            }

            result.AccountCount = result.Accounts.Count;
            _logger.LogInformation("Retrieved {Count} accounts with budget data for year {Year}", result.AccountCount, year);

            return result;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting all budgets for year {Year}", year);
            throw;
        }
    }
}

/// <summary>
/// Interface for budget service (for DI and testing).
/// </summary>
public interface IBudgetService
{
    Task<BudgetResponse> GetBudgetAsync(BudgetRequest request);
    Task<BatchBudgetResponse> GetBatchBudgetAsync(BatchBudgetRequest request);
    Task<AllBudgetsResponse> GetAllBudgetsAsync(int year, string? subsidiary = null, string? category = null);
}

