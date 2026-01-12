using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using XaviApi.Services;

namespace XaviApi.Controllers;

/// <summary>
/// Test controller to debug TYPEBALANCE Income query issues
/// </summary>
[ApiController]
[Route("api/test")]
public class TypeBalanceTestController : ControllerBase
{
    private readonly INetSuiteService _netSuiteService;
    private readonly ILookupService _lookupService;
    private readonly ILogger<TypeBalanceTestController> _logger;

    public TypeBalanceTestController(
        INetSuiteService netSuiteService,
        ILookupService lookupService,
        ILogger<TypeBalanceTestController> logger)
    {
        _netSuiteService = netSuiteService;
        _lookupService = lookupService;
        _logger = logger;
    }

    /// <summary>
    /// Test Income query for April 2025 - matches individual query structure exactly
    /// </summary>
    [HttpGet("income-apr-2025")]
    public async Task<IActionResult> TestIncomeApril2025([FromQuery] string subsidiary = "Celigo India Pvt Ltd", [FromQuery] int book = 2)
    {
        try
        {
            // Resolve subsidiary
            var subsidiaryId = await _lookupService.ResolveSubsidiaryIdAsync(subsidiary);
            var targetSub = subsidiaryId ?? "1";
            
            // Get hierarchy
            var hierarchySubs = await _lookupService.GetSubsidiaryHierarchyAsync(targetSub);
            var subFilter = string.Join(", ", hierarchySubs);
            
            // Get April 2025 period
            var periods = await _netSuiteService.GetPeriodsForYearAsync(2025);
            var aprPeriod = periods.FirstOrDefault(p => p.PeriodName?.Contains("Apr") == true);
            
            if (aprPeriod == null || string.IsNullOrEmpty(aprPeriod.Id))
            {
                return BadRequest(new { error = "Could not find April 2025 period" });
            }
            
            var periodId = aprPeriod.Id;
            
            // Build segment filter (same as individual query)
            var segmentWhere = $"tl.subsidiary IN ({subFilter})";
            
            // Individual query structure (EXACT match)
            var individualQuery = $@"
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
                    ) * CASE WHEN a.accttype IN ('Income', 'OthIncome') THEN -1 ELSE 1 END
                ) AS balance
                FROM transactionaccountingline tal
                JOIN transaction t ON t.id = tal.transaction
                JOIN account a ON a.id = tal.account
                JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
                WHERE t.posting = 'T'
                  AND tal.posting = 'T'
                  AND a.accttype IN ('Income')
                  AND t.postingperiod IN ({periodId})
                  AND tal.accountingbook = {book}
                  AND {segmentWhere}";
            
            // Batch query structure (for comparison)
            var batchQuery = $@"
                SELECT 
                    a.accttype AS account_type,
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
                        ) * CASE WHEN a.accttype IN ('Income', 'OthIncome') THEN -1 ELSE 1 END
                    ELSE 0 END) AS apr
                FROM transactionaccountingline tal
                JOIN transaction t ON t.id = tal.transaction
                JOIN account a ON a.id = tal.account
                JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
                WHERE t.posting = 'T'
                  AND tal.posting = 'T'
                  AND a.accttype IN ('Income', 'COGS', 'Expense', 'OthIncome', 'OthExpense')
                  AND t.postingperiod IN ({periodId})
                  AND tal.accountingbook = {book}
                  AND {segmentWhere}
                GROUP BY a.accttype
                ORDER BY a.accttype";
            
            _logger.LogInformation("🔍 [TEST] Testing Income query for April 2025");
            _logger.LogInformation("   Subsidiary: {Sub} → ID {Id}", subsidiary, targetSub);
            _logger.LogInformation("   Hierarchy: {Hierarchy}", subFilter);
            _logger.LogInformation("   Period: {PeriodName} (ID: {PeriodId})", aprPeriod.PeriodName, periodId);
            _logger.LogInformation("   Book: {Book}", book);
            
            // Run individual query
            var individualResult = await _netSuiteService.QueryRawWithErrorAsync(individualQuery);
            var individualBalance = 0m;
            if (individualResult.Success && individualResult.Items.Any())
            {
                var row = individualResult.Items[0];
                if (row.TryGetProperty("balance", out var balProp))
                {
                    if (balProp.ValueKind == JsonValueKind.Number)
                        individualBalance = balProp.GetDecimal();
                    else if (balProp.ValueKind == JsonValueKind.String && decimal.TryParse(balProp.GetString(), out var parsed))
                        individualBalance = parsed;
                }
            }
            
            // Run batch query
            var batchResult = await _netSuiteService.QueryRawWithErrorAsync(batchQuery);
            var batchBalance = 0m;
            if (batchResult.Success && batchResult.Items.Any())
            {
                var incomeRow = batchResult.Items.FirstOrDefault(r => 
                    r.TryGetProperty("account_type", out var typeProp) && 
                    typeProp.GetString() == "Income");
                if (incomeRow.ValueKind != JsonValueKind.Undefined && incomeRow.TryGetProperty("apr", out var aprProp))
                {
                    if (aprProp.ValueKind == JsonValueKind.Number)
                        batchBalance = aprProp.GetDecimal();
                    else if (aprProp.ValueKind == JsonValueKind.String && decimal.TryParse(aprProp.GetString(), out var parsed))
                        batchBalance = parsed;
                }
            }
            
            return Ok(new
            {
                subsidiary = subsidiary,
                subsidiaryId = targetSub,
                hierarchy = subFilter,
                period = aprPeriod.PeriodName,
                periodId = periodId,
                book = book,
                queries = new
                {
                    individual = individualQuery,
                    batch = batchQuery
                },
                results = new
                {
                    individual = new
                    {
                        success = individualResult.Success,
                        balance = individualBalance,
                        error = individualResult.Success ? null : individualResult.ErrorDetails
                    },
                    batch = new
                    {
                        success = batchResult.Success,
                        balance = batchBalance,
                        error = batchResult.Success ? null : batchResult.ErrorDetails,
                        rowCount = batchResult.Items?.Count ?? 0
                    }
                },
                match = individualBalance == batchBalance ? "✅ MATCH" : $"❌ MISMATCH (Individual: {individualBalance:N2}, Batch: {batchBalance:N2})"
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error testing Income query");
            return StatusCode(500, new { error = ex.Message, stackTrace = ex.StackTrace });
        }
    }
}

