/*
 * XAVI for NetSuite - Lookup Controller
 *
 * Copyright (c) 2025 Celigo, Inc.
 * All rights reserved.
 */

using Microsoft.AspNetCore.Mvc;
using System.Text.Json;
using XaviApi.Services;

namespace XaviApi.Controllers;

/// <summary>
/// Controller for lookup/reference data queries.
/// </summary>
[ApiController]
public class LookupController : ControllerBase
{
    private readonly ILookupService _lookupService;
    private readonly INetSuiteService _netSuiteService;
    private readonly ILogger<LookupController> _logger;

    public LookupController(ILookupService lookupService, INetSuiteService netSuiteService, ILogger<LookupController> logger)
    {
        _lookupService = lookupService;
        _netSuiteService = netSuiteService;
        _logger = logger;
    }

    /// <summary>
    /// Get all lookups at once (subsidiaries, departments, classes, locations, accounting books).
    /// </summary>
    [HttpGet("/lookups/all")]
    public async Task<IActionResult> GetAllLookups()
    {
        try
        {
            var result = await _lookupService.GetAllLookupsAsync();
            return Ok(result);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting all lookups");
            return StatusCode(500, new { error = ex.Message });
        }
    }

    /// <summary>
    /// Get subsidiaries.
    /// </summary>
    [HttpGet("/subsidiaries")]
    public async Task<IActionResult> GetSubsidiaries()
    {
        try
        {
            var result = await _lookupService.GetSubsidiariesAsync();
            return Ok(new { subsidiaries = result });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting subsidiaries");
            return StatusCode(500, new { error = ex.Message });
        }
    }

    /// <summary>
    /// Get departments.
    /// </summary>
    [HttpGet("/departments")]
    public async Task<IActionResult> GetDepartments()
    {
        try
        {
            var result = await _lookupService.GetDepartmentsAsync();
            return Ok(new { departments = result });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting departments");
            return StatusCode(500, new { error = ex.Message });
        }
    }

    /// <summary>
    /// Get classes.
    /// </summary>
    [HttpGet("/classes")]
    public async Task<IActionResult> GetClasses()
    {
        try
        {
            var result = await _lookupService.GetClassesAsync();
            return Ok(new { classes = result });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting classes");
            return StatusCode(500, new { error = ex.Message });
        }
    }

    /// <summary>
    /// Get locations.
    /// </summary>
    [HttpGet("/locations")]
    public async Task<IActionResult> GetLocations()
    {
        try
        {
            var result = await _lookupService.GetLocationsAsync();
            return Ok(new { locations = result });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting locations");
            return StatusCode(500, new { error = ex.Message });
        }
    }

    /// <summary>
    /// Get accounting books (for Multi-Book Accounting).
    /// </summary>
    [HttpGet("/lookups/accountingbooks")]
    public async Task<IActionResult> GetAccountingBooks()
    {
        try
        {
            var result = await _lookupService.GetAccountingBooksAsync();
            return Ok(new { accountingbooks = result });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting accounting books");
            return StatusCode(500, new { error = ex.Message });
        }
    }

    /// <summary>
    /// Get the subsidiary associated with an accounting book.
    /// Returns the most common subsidiary for transactions in that book.
    /// Also includes information about whether there are multiple subsidiaries.
    /// </summary>
    [HttpGet("/lookups/accountingbook/{bookId}/subsidiary")]
    public async Task<IActionResult> GetSubsidiaryForAccountingBook([FromRoute] string bookId)
    {
        try
        {
            // First check if there are multiple subsidiaries
            var allSubsidiaryIds = await _lookupService.GetSubsidiariesForAccountingBookAsync(bookId);
            
            // If null, it's Primary Book (all subsidiaries valid)
            if (allSubsidiaryIds == null)
            {
                return Ok(new 
                { 
                    subsidiaryId = (string?)null, 
                    message = "Primary Book - all subsidiaries are valid",
                    hasMultipleSubsidiaries = true,
                    subsidiaryCount = 0
                });
            }
            
            // If empty list, no subsidiaries found
            if (!allSubsidiaryIds.Any())
            {
                return Ok(new 
                { 
                    subsidiaryId = (string?)null, 
                    message = "No subsidiaries found for this accounting book",
                    hasMultipleSubsidiaries = false,
                    subsidiaryCount = 0
                });
            }
            
            // If multiple subsidiaries, return the most common one but indicate there are multiple
            var hasMultiple = allSubsidiaryIds.Count > 1;
            var subsidiaryId = await _lookupService.GetSubsidiaryForAccountingBookAsync(bookId);
            
            if (subsidiaryId == null)
            {
                return Ok(new 
                { 
                    subsidiaryId = (string?)null, 
                    message = "No specific subsidiary associated with this accounting book",
                    hasMultipleSubsidiaries = hasMultiple,
                    subsidiaryCount = allSubsidiaryIds.Count
                });
            }

            // Get subsidiary name for response
            var subsidiaries = await _lookupService.GetSubsidiariesAsync();
            var subsidiary = subsidiaries.FirstOrDefault(s => s.Id == subsidiaryId);
            
            return Ok(new 
            { 
                subsidiaryId = subsidiaryId,
                subsidiaryName = subsidiary?.Name ?? (string?)null,
                subsidiaryFullName = subsidiary?.FullName ?? (string?)null,
                hasMultipleSubsidiaries = hasMultiple,
                subsidiaryCount = allSubsidiaryIds.Count,
                message = hasMultiple 
                    ? $"This accounting book has {allSubsidiaryIds.Count} subsidiaries. Most common: {subsidiary?.Name ?? subsidiaryId}"
                    : null
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting subsidiary for accounting book {BookId}", bookId);
            return StatusCode(500, new { error = ex.Message });
        }
    }

    /// <summary>
    /// Get all subsidiaries that have transactions in the given accounting book.
    /// Returns null for Primary Book (ID 1) to indicate all subsidiaries are valid.
    /// </summary>
    [HttpGet("/lookups/accountingbook/{bookId}/subsidiaries")]
    public async Task<IActionResult> GetSubsidiariesForAccountingBook([FromRoute] string bookId)
    {
        try
        {
            // Use new book-scoped method that follows NetSuite rules
            var response = await _lookupService.GetBookScopedSubsidiariesAsync(bookId);
            return Ok(response);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting subsidiaries for accounting book {BookId}", bookId);
            return StatusCode(500, new { error = ex.Message });
        }
    }

    /// <summary>
    /// Check if the book-subsidiary cache is initialized and ready.
    /// </summary>
    [HttpGet("/lookups/cache/status")]
    public async Task<IActionResult> GetCacheStatus()
    {
        try
        {
            if (_lookupService is XaviApi.Services.LookupService service)
            {
                var isReady = await service.IsBookSubsidiaryCacheReadyAsync();
                return Ok(new 
                { 
                    ready = isReady,
                    message = isReady ? "Cache is ready" : "Cache is still initializing",
                    timestamp = DateTime.UtcNow
                });
            }
            return BadRequest(new { error = "LookupService is not the expected type" });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error checking cache status");
            return StatusCode(500, new { error = ex.Message });
        }
    }

    /// <summary>
    /// Manually trigger cache initialization (for debugging/admin use).
    /// </summary>
    [HttpPost("/lookups/cache/initialize")]
    public async Task<IActionResult> InitializeCache()
    {
        try
        {
            if (_lookupService is XaviApi.Services.LookupService service)
            {
                _logger.LogInformation("🔄 Manual cache initialization triggered");
                await service.InitializeBookSubsidiaryCacheAsync();
                return Ok(new { message = "Cache initialization completed", timestamp = DateTime.UtcNow });
            }
            return BadRequest(new { error = "LookupService is not the expected type" });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error during manual cache initialization");
            return StatusCode(500, new { error = ex.Message });
        }
    }

    /// <summary>
    /// Get the default subsidiary for an accounting book based on NetSuite-compatible rules.
    /// Optionally accepts a current subsidiary ID - if it's enabled for the book, it will be returned.
    /// </summary>
    [HttpGet("/lookups/accountingbook/{bookId}/default-subsidiary")]
    public async Task<IActionResult> GetDefaultSubsidiaryForAccountingBook(
        [FromRoute] string bookId,
        [FromQuery] string? currentSubsidiaryId = null)
    {
        try
        {
            var defaultSubsidiaryId = await _lookupService.GetDefaultSubsidiaryForAccountingBookAsync(bookId, currentSubsidiaryId);
            
            if (defaultSubsidiaryId == null)
            {
                return Ok(new 
                { 
                    subsidiaryId = (string?)null,
                    message = "Primary Book or no enabled subsidiaries - no default needed"
                });
            }

            // Get subsidiary name for response
            var subsidiaries = await _lookupService.GetSubsidiariesAsync();
            var subsidiary = subsidiaries.FirstOrDefault(s => s.Id == defaultSubsidiaryId);
            
            return Ok(new 
            { 
                subsidiaryId = defaultSubsidiaryId,
                subsidiaryName = subsidiary?.Name ?? (string?)null,
                subsidiaryFullName = subsidiary?.FullName ?? (string?)null,
                message = $"Default subsidiary for accounting book {bookId}"
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting default subsidiary for accounting book {BookId}", bookId);
            return StatusCode(500, new { error = ex.Message });
        }
    }

    /// <summary>
    /// Get budget categories.
    /// </summary>
    [HttpGet("/lookups/budget-categories")]
    public async Task<IActionResult> GetBudgetCategories()
    {
        try
        {
            var result = await _lookupService.GetBudgetCategoriesAsync();
            return Ok(new { categories = result });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting budget categories");
            return StatusCode(500, new { error = ex.Message });
        }
    }

    /// <summary>
    /// Get currencies for each subsidiary.
    /// Returns format expected by frontend for currency formatting.
    /// If subsidiary parameter provided, returns currencies for BALANCECURRENCY dropdown.
    /// </summary>
    [HttpGet("/lookups/currencies")]
    public async Task<IActionResult> GetCurrencies([FromQuery] string? subsidiary = null)
    {
        try
        {
            // If subsidiary provided, return BALANCECURRENCY format
            if (!string.IsNullOrEmpty(subsidiary))
            {
                string? subsidiaryId = await _lookupService.ResolveSubsidiaryIdAsync(subsidiary);
                if (subsidiaryId == null)
                {
                    return BadRequest(new { error = $"Could not resolve subsidiary: {subsidiary}" });
                }

                var result = await _lookupService.GetCurrenciesAsync(subsidiaryId);
                return Ok(new { currencies = result });
            }

            // Otherwise, return existing format for backward compatibility
            var subsidiaries = await _lookupService.GetSubsidiariesAsync();
            
            // Map ISO currency codes to display symbols
            var codeToSymbol = new Dictionary<string, string>
            {
                { "USD", "$" }, { "EUR", "€" }, { "GBP", "£" }, { "JPY", "¥" },
                { "CNY", "¥" }, { "INR", "₹" }, { "AUD", "A$" }, { "CAD", "C$" },
                { "HKD", "HK$" }, { "SGD", "S$" }, { "NZD", "NZ$" }, { "CHF", "CHF" },
                { "SEK", "kr" }, { "NOK", "kr" }, { "DKK", "kr" }, { "BRL", "R$" },
                { "ZAR", "R" }, { "KRW", "₩" }, { "MXN", "$" }, { "PLN", "zł" },
                { "CZK", "Kč" }, { "HUF", "Ft" }, { "RON", "lei" }, { "THB", "฿" },
                { "PHP", "₱" }, { "MYR", "RM" }, { "IDR", "Rp" }, { "VND", "₫" },
                { "TWD", "NT$" }, { "ILS", "₪" }, { "TRY", "₺" }, { "RUB", "₽" }
            };
            
            // Excel number formats for currency symbols
            var symbolFormats = new Dictionary<string, string>
            {
                { "$", "$#,##0.00" },
                { "€", "€#,##0.00" },
                { "£", "£#,##0.00" },
                { "¥", "¥#,##0" },
                { "₹", "[$₹-en-IN]#,##0.00" },
                { "A$", "[$A$-en-AU]#,##0.00" },
                { "C$", "[$C$-en-CA]#,##0.00" },
                { "HK$", "[$HK$-zh-HK]#,##0.00" },
                { "S$", "[$S$-en-SG]#,##0.00" },
                { "NZ$", "[$NZ$-en-NZ]#,##0.00" },
                { "CHF", "[$CHF-de-CH] #,##0.00" },
                { "kr", "[$kr-sv-SE] #,##0.00" },
                { "R$", "[$R$-pt-BR] #,##0.00" },
                { "R", "[$R-en-ZA] #,##0.00" },
                { "₩", "[$₩-ko-KR]#,##0" },
                { "zł", "[$zł-pl-PL] #,##0.00" },
                { "Kč", "[$Kč-cs-CZ] #,##0.00" },
                { "Ft", "[$Ft-hu-HU] #,##0" },
                { "lei", "[$lei-ro-RO] #,##0.00" },
                { "฿", "[$฿-th-TH]#,##0.00" },
                { "₱", "[$₱-en-PH]#,##0.00" },
                { "RM", "[$RM-ms-MY] #,##0.00" },
                { "Rp", "[$Rp-id-ID] #,##0" },
                { "₫", "[$₫-vi-VN]#,##0" },
                { "NT$", "[$NT$-zh-TW]#,##0.00" },
                { "₪", "[$₪-he-IL]#,##0.00" },
                { "₺", "[$₺-tr-TR]#,##0.00" },
                { "₽", "[$₽-ru-RU] #,##0.00" }
            };

            // Build currencies map: subsidiary_id -> symbol
            // Handle duplicate IDs (consolidated versions) by using first occurrence
            var currencies = new Dictionary<string, string>();
            string defaultSubsidiary = "1";
            
            // Group by ID to handle duplicates (consolidated versions have same ID)
            var uniqueSubs = subsidiaries
                .GroupBy(s => s.Id)
                .Select(g => g.First())
                .ToList();
            
            foreach (var sub in uniqueSubs)
            {
                // Get symbol from currency code
                var symbol = sub.CurrencySymbol ?? "$";
                if (codeToSymbol.TryGetValue(symbol, out var mappedSymbol))
                {
                    symbol = mappedSymbol;
                }
                currencies[sub.Id] = symbol;
                
                // Find the parent/root subsidiary (no parent = root)
                if (string.IsNullOrEmpty(sub.Parent))
                {
                    defaultSubsidiary = sub.Id;
                }
            }

            return Ok(new
            {
                currencies = currencies,
                formats = symbolFormats,
                default_subsidiary = defaultSubsidiary
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting currencies");
            return StatusCode(500, new { error = ex.Message });
        }
    }

    /// <summary>
    /// Get all accounting periods from a start year to the current date.
    /// Returns periods with internal ID, period ID, year, month, and period name.
    /// </summary>
    [HttpGet("/periods/from-year")]
    public async Task<IActionResult> GetPeriodsFromYear([FromQuery] int startYear)
    {
        try
        {
            if (startYear < 2000 || startYear > 2099)
            {
                return BadRequest(new { error = "Start year must be between 2000 and 2099" });
            }

            var currentYear = DateTime.Now.Year;
            var periods = new List<object>();

            _logger.LogInformation("GetPeriodsFromYear: Requesting periods from {StartYear} to {CurrentYear}", startYear, currentYear);

            // Get periods for each year from startYear to currentYear
            for (int year = startYear; year <= currentYear; year++)
            {
                _logger.LogInformation("GetPeriodsFromYear: Fetching periods for year {Year}", year);
                var yearPeriods = await _netSuiteService.GetPeriodsForYearAsync(year);
                _logger.LogInformation("GetPeriodsFromYear: Found {Count} periods for year {Year}", yearPeriods.Count, year);
                
                foreach (var period in yearPeriods)
                {
                    // Extract month from period name (e.g., "Jan 2025" -> "Jan")
                    var month = "";
                    if (!string.IsNullOrEmpty(period.PeriodName))
                    {
                        var parts = period.PeriodName.Split(' ');
                        if (parts.Length > 0)
                        {
                            month = parts[0];
                        }
                    }

                    periods.Add(new
                    {
                        internal_id = period.Id,
                        period_id = period.Id, // Same as internal_id for AccountingPeriod
                        period_name = period.PeriodName,
                        year = year,
                        month = month,
                        start_date = period.StartDate,
                        end_date = period.EndDate
                    });
                }
            }

            _logger.LogInformation("GetPeriodsFromYear: Returning {Count} total periods", periods.Count);

            return Ok(new
            {
                start_year = startYear,
                end_year = currentYear,
                count = periods.Count,
                periods = periods
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting periods from year {StartYear}", startYear);
            return StatusCode(500, new { error = ex.Message });
        }
    }

}

