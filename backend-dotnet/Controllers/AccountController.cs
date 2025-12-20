/*
 * XAVI for NetSuite - Account Controller
 *
 * Copyright (c) 2025 Celigo, Inc.
 * All rights reserved.
 */

using Microsoft.AspNetCore.Mvc;
using XaviApi.Models;
using XaviApi.Services;

namespace XaviApi.Controllers;

/// <summary>
/// Controller for account queries.
/// </summary>
[ApiController]
public class AccountController : ControllerBase
{
    private readonly ILookupService _lookupService;
    private readonly INetSuiteService _netSuiteService;
    private readonly ILogger<AccountController> _logger;

    public AccountController(
        ILookupService lookupService, 
        INetSuiteService netSuiteService,
        ILogger<AccountController> logger)
    {
        _lookupService = lookupService;
        _netSuiteService = netSuiteService;
        _logger = logger;
    }

    /// <summary>
    /// Get accounts that have actual transaction activity for a given period.
    /// </summary>
    [HttpGet("/accounts/with-activity")]
    public async Task<IActionResult> GetAccountsWithActivity(
        [FromQuery] string period = "Jan 2025",
        [FromQuery] int limit = 10,
        [FromQuery] string types = "Income,Expense,COGS")
    {
        try
        {
            // Parse period to get date range
            var periodData = await _netSuiteService.GetPeriodAsync(period);
            if (periodData == null)
                return BadRequest(new { error = $"Invalid period: {period}" });

            // Convert dates to SQL format
            var startDate = ConvertToSqlDate(periodData.StartDate);
            var endDate = ConvertToSqlDate(periodData.EndDate);

            // Build type filter
            var typesList = types.Split(',').Select(t => $"'{t.Trim()}'");
            var typesSql = string.Join(",", typesList);

            var query = $@"
                SELECT 
                    a.id,
                    a.acctnumber,
                    a.accountsearchdisplaynamecopy AS accountname,
                    a.accttype,
                    a.parent,
                    SUM(ABS(tal.amount)) AS activity_amount,
                    SUM(tal.amount) AS balance
                FROM 
                    Transaction t
                    JOIN TransactionAccountingLine tal ON t.id = tal.transaction
                    JOIN Account a ON tal.account = a.id
                WHERE 
                    t.posting = 'T'
                    AND t.trandate >= TO_DATE('{startDate}', 'YYYY-MM-DD')
                    AND t.trandate <= TO_DATE('{endDate}', 'YYYY-MM-DD')
                    AND a.accttype IN ({typesSql})
                    AND a.parent IS NOT NULL
                    AND a.isinactive = 'F'
                GROUP BY 
                    a.id, a.acctnumber, a.accountsearchdisplaynamecopy, a.accttype, a.parent
                HAVING 
                    SUM(ABS(tal.amount)) > 0
                ORDER BY 
                    CASE a.accttype 
                        WHEN 'Income' THEN 1 
                        WHEN 'OthIncome' THEN 2 
                        WHEN 'COGS' THEN 3 
                        WHEN 'Expense' THEN 4 
                        WHEN 'OthExpense' THEN 5 
                        ELSE 6 
                    END,
                    SUM(ABS(tal.amount)) DESC
                FETCH FIRST {limit * 2} ROWS ONLY";

            var results = await _netSuiteService.QueryRawAsync(query);
            
            var accounts = new List<object>();
            foreach (var row in results.Take(limit))
            {
                var balance = 0m;
                if (row.TryGetProperty("balance", out var balProp))
                {
                    if (balProp.ValueKind == System.Text.Json.JsonValueKind.String)
                        decimal.TryParse(balProp.GetString(), out balance);
                    else if (balProp.ValueKind == System.Text.Json.JsonValueKind.Number)
                        balance = balProp.GetDecimal();
                }

                var acctType = row.TryGetProperty("accttype", out var typeProp) ? typeProp.GetString() ?? "" : "";
                
                // Apply sign convention for Income
                if (acctType == "Income" || acctType == "OthIncome")
                    balance = -balance;

                accounts.Add(new
                {
                    id = row.TryGetProperty("id", out var idProp) ? idProp.ToString() : "",
                    accountnumber = row.TryGetProperty("acctnumber", out var numProp) ? numProp.GetString() : "",
                    accountname = row.TryGetProperty("accountname", out var nameProp) ? nameProp.GetString() : "",
                    accttype = acctType,
                    balance = Math.Round(balance, 2)
                });
            }

            return Ok(new
            {
                period,
                count = accounts.Count,
                accounts
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting accounts with activity");
            return StatusCode(500, new { error = ex.Message });
        }
    }

    private string ConvertToSqlDate(string? mmddyyyy)
    {
        if (string.IsNullOrEmpty(mmddyyyy)) return "";
        if (DateTime.TryParseExact(mmddyyyy, "M/d/yyyy", null, System.Globalization.DateTimeStyles.None, out var date))
            return date.ToString("yyyy-MM-dd");
        if (DateTime.TryParseExact(mmddyyyy, "MM/dd/yyyy", null, System.Globalization.DateTimeStyles.None, out date))
            return date.ToString("yyyy-MM-dd");
        return mmddyyyy;
    }

    /// <summary>
    /// Search for accounts by account number or type.
    /// </summary>
    [HttpGet("/accounts/search")]
    public async Task<IActionResult> SearchAccounts(
        [FromQuery] string? number = null,
        [FromQuery] string? type = null)
    {
        try
        {
            var accounts = await _lookupService.SearchAccountsAsync(number, type);
            return Ok(new { accounts, count = accounts.Count });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error searching accounts");
            return StatusCode(500, new { error = ex.Message });
        }
    }

    /// <summary>
    /// Get account name (POST method for security).
    /// </summary>
    [HttpPost("/account/name")]
    public async Task<IActionResult> GetAccountName([FromBody] AccountNumberRequest request)
    {
        if (string.IsNullOrEmpty(request.Account))
            return BadRequest(new { error = "Account number is required" });

        try
        {
            var name = await _lookupService.GetAccountNameAsync(request.Account);
            return Ok(new { account = request.Account, name = name ?? "Unknown" });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting account name for {Account}", request.Account);
            return StatusCode(500, new { error = ex.Message });
        }
    }

    /// <summary>
    /// Get account name (GET - deprecated, use POST).
    /// </summary>
    [HttpGet("/account/{account_number}/name")]
    public async Task<IActionResult> GetAccountNameDeprecated(string account_number)
    {
        try
        {
            var name = await _lookupService.GetAccountNameAsync(account_number);
            return Ok(new { account = account_number, name = name ?? "Unknown" });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting account name for {Account}", account_number);
            return StatusCode(500, new { error = ex.Message });
        }
    }

    /// <summary>
    /// Get account type (POST method for security).
    /// </summary>
    [HttpPost("/account/type")]
    public async Task<IActionResult> GetAccountType([FromBody] AccountNumberRequest request)
    {
        if (string.IsNullOrEmpty(request.Account))
            return BadRequest(new { error = "Account number is required" });

        try
        {
            var type = await _lookupService.GetAccountTypeAsync(request.Account);
            var displayName = type != null ? AccountType.GetDisplayName(type) : "Unknown";

            return Ok(new
            {
                account = request.Account,
                type,
                display_name = displayName
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting account type for {Account}", request.Account);
            return StatusCode(500, new { error = ex.Message });
        }
    }

    /// <summary>
    /// Get account type (GET - deprecated, use POST).
    /// </summary>
    [HttpGet("/account/{account_number}/type")]
    public async Task<IActionResult> GetAccountTypeDeprecated(string account_number)
    {
        try
        {
            var type = await _lookupService.GetAccountTypeAsync(account_number);
            var displayName = type != null ? AccountType.GetDisplayName(type) : "Unknown";

            return Ok(new
            {
                account = account_number,
                type,
                display_name = displayName
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting account type for {Account}", account_number);
            return StatusCode(500, new { error = ex.Message });
        }
    }

    /// <summary>
    /// Get parent account number (POST method for security).
    /// Returns plain text to match Python behavior.
    /// </summary>
    [HttpPost("/account/parent")]
    public async Task<IActionResult> GetAccountParent([FromBody] AccountNumberRequest request)
    {
        if (string.IsNullOrEmpty(request.Account))
            return BadRequest(new { error = "Account number is required" });

        try
        {
            var parent = await _lookupService.GetAccountParentAsync(request.Account);
            // Return plain text like Python does
            return Content(parent ?? "", "text/plain");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting account parent for {Account}", request.Account);
            return StatusCode(500, new { error = ex.Message });
        }
    }

    /// <summary>
    /// Get parent account (GET - deprecated, use POST).
    /// Returns plain text to match Python behavior.
    /// </summary>
    [HttpGet("/account/{account_number}/parent")]
    public async Task<IActionResult> GetAccountParentDeprecated(string account_number)
    {
        try
        {
            var parent = await _lookupService.GetAccountParentAsync(account_number);
            // Return plain text like Python does
            return Content(parent ?? "", "text/plain");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting account parent for {Account}", account_number);
            return StatusCode(500, new { error = ex.Message });
        }
    }

    /// <summary>
    /// Preload all account titles into cache.
    /// Prevents 429 rate limit errors from concurrent individual requests.
    /// </summary>
    [HttpGet("/account/preload_titles")]
    public async Task<IActionResult> PreloadAccountTitles()
    {
        try
        {
            var titles = await _lookupService.GetAllAccountTitlesAsync();
            _logger.LogInformation("Preloaded {Count} account titles", titles.Count);
            
            // Return format expected by frontend: { loaded: count, status: "success", titles: {...} }
            return Ok(new
            {
                loaded = titles.Count,
                status = "success",
                titles = titles
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error preloading account titles");
            return StatusCode(500, new { error = ex.Message });
        }
    }

    /// <summary>
    /// Get multiple account types at once.
    /// </summary>
    [HttpPost("/batch/account_types")]
    public async Task<IActionResult> BatchGetAccountTypes([FromBody] BatchAccountRequest request)
    {
        if (request.Accounts == null || !request.Accounts.Any())
            return BadRequest(new { error = "At least one account is required" });

        try
        {
            var result = new Dictionary<string, string>();

            foreach (var account in request.Accounts)
            {
                var type = await _lookupService.GetAccountTypeAsync(account);
                result[account] = type ?? "Unknown";
            }

            return Ok(new { account_types = result });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting batch account types");
            return StatusCode(500, new { error = ex.Message });
        }
    }
}

/// <summary>
/// Request with a single account number.
/// </summary>
public class AccountNumberRequest
{
    public string Account { get; set; } = string.Empty;
}

/// <summary>
/// Request with multiple account numbers.
/// </summary>
public class BatchAccountRequest
{
    public List<string> Accounts { get; set; } = new();
}

