/*
 * XAVI for NetSuite - Transaction Drill-Down Controller
 * Provides endpoints for fetching transaction details for drill-down functionality.
 */

using Microsoft.AspNetCore.Mvc;
using System.Text.Json;
using XaviApi.Services;

namespace XaviApi.Controllers;

[ApiController]
public class TransactionController : ControllerBase
{
    private readonly INetSuiteService _netSuiteService;
    private readonly ILookupService _lookupService;
    private readonly ILogger<TransactionController> _logger;

    public TransactionController(
        INetSuiteService netSuiteService,
        ILookupService lookupService,
        ILogger<TransactionController> logger)
    {
        _netSuiteService = netSuiteService;
        _lookupService = lookupService;
        _logger = logger;
    }

    /// <summary>
    /// Get transactions for an account and period (for drill-down).
    /// </summary>
    [HttpGet("/transactions")]
    public async Task<IActionResult> GetTransactions(
        [FromQuery] string account,
        [FromQuery] string period,
        [FromQuery] string? subsidiary = null,
        [FromQuery] string? department = null,
        [FromQuery(Name = "class")] string? classId = null,
        [FromQuery] string? location = null)
    {
        if (string.IsNullOrEmpty(account))
            return BadRequest(new { error = "account is required" });
        if (string.IsNullOrEmpty(period))
            return BadRequest(new { error = "period is required" });

        try
        {
            account = account.Trim();
            period = period.Trim();
            _logger.LogInformation("GetTransactions: account={Account}, period={Period}, subsidiary={Subsidiary}, dept={Dept}, class={Class}, loc={Loc}",
                account, period, subsidiary, department, classId, location);

            // Resolve filters to IDs
            var resolvedSubsidiary = string.IsNullOrWhiteSpace(subsidiary) ? null : await _lookupService.ResolveSubsidiaryIdAsync(subsidiary.Trim());
            var resolvedDept = string.IsNullOrWhiteSpace(department) ? null : await _lookupService.ResolveDimensionIdAsync("department", department.Trim());
            var resolvedClass = string.IsNullOrWhiteSpace(classId) ? null : await _lookupService.ResolveDimensionIdAsync("class", classId.Trim());
            var resolvedLocation = string.IsNullOrWhiteSpace(location) ? null : await _lookupService.ResolveDimensionIdAsync("location", location.Trim());

            // Build subsidiary filter
            var subsidiaryFilter = "";
            if (!string.IsNullOrEmpty(resolvedSubsidiary))
            {
                var hierarchy = await _lookupService.GetSubsidiaryHierarchyAsync(resolvedSubsidiary);
                var subFilter = string.Join(", ", hierarchy);
                subsidiaryFilter = $"AND tl.subsidiary IN ({subFilter})";
            }

            // Account filter supports wildcard like "4*" similar to Python version
            var acct = NetSuiteService.EscapeSql(account);
            var accountFilter = account.Contains('*')
                ? $"a.acctnumber LIKE '{acct.Replace("*", "%")}'"
                : $"a.acctnumber = '{acct}'";

            // Period filter: month by periodname; year-only handled via date range
            string periodFilter;
            if (period.Length == 4 && int.TryParse(period, out _))
            {
                // Year-only: Jan 1 to Dec 31 of year
                var year = period.Trim();
                periodFilter = $"t.trandate >= TO_DATE('{year}-01-01', 'YYYY-MM-DD') AND t.trandate <= TO_DATE('{year}-12-31', 'YYYY-MM-DD')";
            }
            else
            {
                // Join AccountingPeriod and match periodname exactly (month)
                periodFilter = $"ap.periodname = '{NetSuiteService.EscapeSql(period)}'";
            }

            var deptFilter = string.IsNullOrEmpty(resolvedDept) ? "" : $"AND tl.department = {resolvedDept}";
            var classFilter = string.IsNullOrEmpty(resolvedClass) ? "" : $"AND tl.class = {resolvedClass}";
            var locationFilter = string.IsNullOrEmpty(resolvedLocation) ? "" : $"AND tl.location = {resolvedLocation}";

            // Query transactions (raw, not consolidated) to match Python logic
            var baseQuery = $@"
                SELECT 
                    t.id AS transaction_id,
                    t.tranid AS transaction_number,
                    t.trandisplayname AS transaction_type,
                    t.recordtype AS record_type,
                    TO_CHAR(t.trandate, 'YYYY-MM-DD') AS trandate,
                    e.entityid AS entity_name,
                    e.id AS entity_id,
                    t.memo,
                    SUM(COALESCE(tal.debit, 0)) AS debit,
                    SUM(COALESCE(tal.credit, 0)) AS credit,
                    a.acctnumber AS account_number,
                    a.accountsearchdisplayname AS account_name,
                    tl.memo AS line_memo
                FROM 
                    transaction t
                INNER JOIN 
                    transactionline tl ON t.id = tl.transaction
                INNER JOIN 
                    transactionaccountingline tal ON t.id = tal.transaction AND tl.id = tal.transactionline
                INNER JOIN 
                    account a ON tal.account = a.id
                INNER JOIN
                    accountingperiod ap ON t.postingperiod = ap.id
                LEFT JOIN
                    entity e ON t.entity = e.id
                WHERE 
                    t.posting = 'T'
                    AND tal.posting = 'T'
                    AND {accountFilter}
                    AND {periodFilter}
                    {subsidiaryFilter}
                    {deptFilter}
                    {classFilter}
                    {locationFilter}
                GROUP BY
                    t.id, t.tranid, t.trandisplayname, t.recordtype, t.trandate,
                    e.entityid, e.id, t.memo, a.acctnumber, a.accountsearchdisplayname, tl.memo
            ";

            const string orderByClause = "t.trandate, t.tranid";
            var results = await _netSuiteService.QueryPaginatedAsync<JsonElement>(baseQuery, orderBy: orderByClause, pageSize: 500);

            // Fallback 1: if subsidiary filter was applied and returned no rows, retry without subsidiary filter
            if ((results == null || results.Count == 0) && !string.IsNullOrEmpty(resolvedSubsidiary))
            {
                _logger.LogWarning("GetTransactions: no rows with subsidiary filter; retrying without subsidiary for account={Account}, period={Period}", account, period);
                var queryNoSub = baseQuery.Replace(subsidiaryFilter, string.Empty);
                results = await _netSuiteService.QueryPaginatedAsync<JsonElement>(queryNoSub, orderBy: orderByClause, pageSize: 500);
            }

            // Fallback 2: if still no rows, retry using date-range filter on trandate instead of AccountingPeriod match
            if (results == null || results.Count == 0)
            {
                var periodData = await _netSuiteService.GetPeriodAsync(period);
                if (periodData != null)
                {
                    var startDate = periodData.StartDate ?? periodData.EndDate;
                    var endDate = periodData.EndDate ?? periodData.StartDate;

                    if (!string.IsNullOrEmpty(startDate) && !string.IsNullOrEmpty(endDate))
                    {
                        var dateFilter = $"t.trandate >= TO_DATE('{NetSuiteService.EscapeSql(startDate)}', 'YYYY-MM-DD') AND t.trandate <= TO_DATE('{NetSuiteService.EscapeSql(endDate)}', 'YYYY-MM-DD')";
                        var periodFilterDate = dateFilter;

                        var queryDate = baseQuery
                            .Replace($"AND {periodFilter}", $"AND {periodFilterDate}");

                        _logger.LogWarning("GetTransactions: no rows with periodname filter; retrying with date range for account={Account}, period={Period}", account, period);
                        results = await _netSuiteService.QueryPaginatedAsync<JsonElement>(queryDate, orderBy: orderByClause, pageSize: 500);

                        // If still empty and subsidiary was set, try without subsidiary on date-range
                        if ((results == null || results.Count == 0) && !string.IsNullOrEmpty(resolvedSubsidiary))
                        {
                            var queryDateNoSub = queryDate.Replace(subsidiaryFilter, string.Empty);
                            _logger.LogWarning("GetTransactions: date-range retry still empty; retrying without subsidiary for account={Account}, period={Period}", account, period);
                            results = await _netSuiteService.QueryPaginatedAsync<JsonElement>(queryDateNoSub, orderBy: orderByClause, pageSize: 500);
                        }
                    }
                }
            }

            var transactions = results.Select(r => new
            {
                transaction_id = r.TryGetProperty("transaction_id", out var tid) ? tid.ToString() : "",
                transaction_number = r.TryGetProperty("transaction_number", out var tnum) 
                    ? tnum.GetString() ?? "" : "",
                trandate = r.TryGetProperty("trandate", out var td) ? td.GetString() : "",
                transaction_type = r.TryGetProperty("transaction_type", out var tt) 
                    ? tt.GetString() ?? "" : "",
                type_display = r.TryGetProperty("type_display", out var ttd) 
                    ? ttd.GetString() ?? "" : "",
                memo = r.TryGetProperty("memo", out var m) && m.ValueKind != JsonValueKind.Null 
                    ? m.GetString() : "",
                entity_name = r.TryGetProperty("entity_name", out var en) && en.ValueKind != JsonValueKind.Null 
                    ? en.GetString() : "",
                debit = r.TryGetProperty("debit", out var db) && db.ValueKind != JsonValueKind.Null 
                    ? ParseDecimal(db) : 0m,
                credit = r.TryGetProperty("credit", out var cr) && cr.ValueKind != JsonValueKind.Null 
                    ? ParseDecimal(cr) : 0m,
                net_amount = r.TryGetProperty("net_amount", out var na) && na.ValueKind != JsonValueKind.Null 
                    ? ParseDecimal(na) : 0m,
                line_memo = r.TryGetProperty("line_memo", out var lm) && lm.ValueKind != JsonValueKind.Null 
                    ? lm.GetString() : ""
            }).ToList();

            _logger.LogInformation("GetTransactions: Found {Count} transactions", transactions.Count);

            return Ok(new { transactions, count = transactions.Count });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting transactions for account {Account}", account);
            return StatusCode(500, new { error = ex.Message });
        }
    }

    private static string ConvertToYYYYMMDD(string date)
    {
        // Handle various date formats from NetSuite
        if (DateTime.TryParse(date, out var dt))
        {
            return dt.ToString("yyyy-MM-dd");
        }
        return date;
    }

    private static decimal ParseDecimal(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.Number)
        {
            return element.GetDecimal();
        }
        if (element.ValueKind == JsonValueKind.String)
        {
            var str = element.GetString() ?? "0";
            if (decimal.TryParse(str, System.Globalization.NumberStyles.Any, 
                System.Globalization.CultureInfo.InvariantCulture, out var d))
            {
                return d;
            }
        }
        return 0;
    }
}

