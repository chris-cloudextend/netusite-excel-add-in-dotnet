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

        var filters = BuildFilters(request.Subsidiary, request.Department, request.Class, request.Location, request.Category);

        // Query BudgetsMachine table for period-level budget data
        var query = $@"
            SELECT 
                SUM(bm.amount) as amount
            FROM BudgetsMachine bm
            JOIN account a ON bm.account = a.id
            JOIN accountingperiod p ON bm.accountingperiod = p.id
            WHERE a.acctnumber = '{NetSuiteService.EscapeSql(request.Account)}'
            AND p.startdate >= TO_DATE('{fromPeriodData.StartDate}', 'MM/DD/YYYY')
            AND p.enddate <= TO_DATE('{toPeriodData.EndDate}', 'MM/DD/YYYY')
            AND p.isquarter = 'F' AND p.isyear = 'F'
            {filters}";

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
}

/// <summary>
/// Interface for budget service (for DI and testing).
/// </summary>
public interface IBudgetService
{
    Task<BudgetResponse> GetBudgetAsync(BudgetRequest request);
    Task<BatchBudgetResponse> GetBatchBudgetAsync(BatchBudgetRequest request);
}

