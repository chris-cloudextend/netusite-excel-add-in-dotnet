/*
 * XAVI for NetSuite - Lookup Controller
 *
 * Copyright (c) 2025 Celigo, Inc.
 * All rights reserved.
 */

using Microsoft.AspNetCore.Mvc;
using XaviApi.Services;

namespace XaviApi.Controllers;

/// <summary>
/// Controller for lookup/reference data queries.
/// </summary>
[ApiController]
public class LookupController : ControllerBase
{
    private readonly ILookupService _lookupService;
    private readonly ILogger<LookupController> _logger;

    public LookupController(ILookupService lookupService, ILogger<LookupController> logger)
    {
        _lookupService = lookupService;
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

}

