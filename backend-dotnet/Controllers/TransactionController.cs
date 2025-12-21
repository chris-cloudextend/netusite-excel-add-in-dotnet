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
        [FromQuery] string? fromPeriod = null,
        [FromQuery] string? toPeriod = null)
    {
        if (string.IsNullOrEmpty(account))
            return BadRequest(new { error = "account is required" });
        if (string.IsNullOrEmpty(period))
            return BadRequest(new { error = "period is required" });

        try
        {
            _logger.LogInformation("GetTransactions: account={Account}, period={Period}, fromPeriod={FromPeriod}, toPeriod={ToPeriod}, subsidiary={Subsidiary}",
                account, period, fromPeriod, toPeriod, subsidiary);

            // Parse period(s) to get date range
            var periodData = await _netSuiteService.GetPeriodAsync(period);
            if (periodData == null)
            {
                return BadRequest(new { error = $"Could not find period '{period}'" });
            }

            var fromPeriodData = !string.IsNullOrWhiteSpace(fromPeriod)
                ? await _netSuiteService.GetPeriodAsync(fromPeriod)
                : null;
            var toPeriodData = !string.IsNullOrWhiteSpace(toPeriod)
                ? await _netSuiteService.GetPeriodAsync(toPeriod)
                : null;

            // Prefer explicit from/to if provided, otherwise fall back to main period
            var startDate = fromPeriodData?.StartDate ?? fromPeriodData?.EndDate ?? periodData.StartDate ?? periodData.EndDate;
            var endDate = toPeriodData?.EndDate ?? toPeriodData?.StartDate ?? periodData.EndDate ?? periodData.StartDate;

            // Build subsidiary filter
            var subsidiaryFilter = "";
            if (!string.IsNullOrEmpty(subsidiary))
            {
                var subId = await _lookupService.ResolveSubsidiaryIdAsync(subsidiary);
                if (!string.IsNullOrEmpty(subId))
                {
                    var hierarchy = await _lookupService.GetSubsidiaryHierarchyAsync(subId);
                    var subFilter = string.Join(", ", hierarchy);
                    subsidiaryFilter = $"AND tl.subsidiary IN ({subFilter})";
                }
            }

            // Query transactions
            var query = $@"
                SELECT 
                    t.id AS transaction_id,
                    t.tranid AS transaction_number,
                    t.trandate,
                    t.type AS transaction_type,
                    BUILTIN.DF(t.type) AS type_display,
                    t.memo,
                    t.entity,
                    BUILTIN.DF(t.entity) AS entity_name,
                    tal.debit,
                    tal.credit,
                    tal.amount AS net_amount,
                    tl.memo AS line_memo
                FROM transactionaccountingline tal
                JOIN transaction t ON t.id = tal.transaction
                JOIN transactionline tl ON t.id = tl.transaction AND tal.transactionline = tl.id
                JOIN account a ON a.id = tal.account
                WHERE t.posting = 'T'
                  AND tal.posting = 'T'
                  AND a.acctnumber = '{NetSuiteService.EscapeSql(account)}'
                  AND t.trandate >= TO_DATE('{ConvertToYYYYMMDD(startDate!)}', 'YYYY-MM-DD')
                  AND t.trandate <= TO_DATE('{ConvertToYYYYMMDD(endDate!)}', 'YYYY-MM-DD')
                  {subsidiaryFilter}
                ORDER BY t.trandate DESC, t.tranid";

            var results = await _netSuiteService.QueryPaginatedAsync<JsonElement>(query, orderBy: null, pageSize: 500);

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

