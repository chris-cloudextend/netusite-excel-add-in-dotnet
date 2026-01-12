/*
 * XAVI for NetSuite - Budget Controller
 *
 * Copyright (c) 2025 Celigo, Inc.
 * All rights reserved.
 */

using Microsoft.AspNetCore.Mvc;
using XaviApi.Models;
using XaviApi.Services;

namespace XaviApi.Controllers;

/// <summary>
/// Controller for budget queries.
/// </summary>
[ApiController]
public class BudgetController : ControllerBase
{
    private readonly IBudgetService _budgetService;
    private readonly ILogger<BudgetController> _logger;

    public BudgetController(IBudgetService budgetService, ILogger<BudgetController> logger)
    {
        _budgetService = budgetService;
        _logger = logger;
    }

    /// <summary>
    /// Get budget amount for an account and period.
    /// </summary>
    [HttpGet("/budget")]
    public async Task<IActionResult> GetBudget(
        [FromQuery] string account,
        [FromQuery] string from_period,
        [FromQuery] string? to_period = null,
        [FromQuery] string? subsidiary = null,
        [FromQuery] string? department = null,
        [FromQuery(Name = "class")] string? classFilter = null,
        [FromQuery] string? location = null,
        [FromQuery] string? category = null,
        [FromQuery(Name = "budget_category")] string? budgetCategory = null)
    {
        if (string.IsNullOrEmpty(account))
            return BadRequest(new { error = "Account number is required" });

        if (string.IsNullOrEmpty(from_period))
            return BadRequest(new { error = "from_period is required" });

        try
        {
            // Accept both 'category' and 'budget_category' parameter names for compatibility
            var finalCategory = category ?? budgetCategory;
            
            var request = new BudgetRequest
            {
                Account = account,
                FromPeriod = from_period,
                ToPeriod = to_period ?? from_period,
                Subsidiary = subsidiary,
                Department = department,
                Class = classFilter,
                Location = location,
                Category = finalCategory
            };

            var result = await _budgetService.GetBudgetAsync(request);
            return Ok(result);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting budget for account {Account}", account);
            return StatusCode(500, new { error = ex.Message });
        }
    }

    /// <summary>
    /// Get budgets for multiple accounts and periods.
    /// </summary>
    [HttpPost("/batch/budget")]
    public async Task<IActionResult> BatchBudget([FromBody] BatchBudgetRequest request)
    {
        if (request.Accounts == null || !request.Accounts.Any())
            return BadRequest(new { error = "At least one account is required" });

        if (request.Periods == null || !request.Periods.Any())
            return BadRequest(new { error = "At least one period is required" });

        try
        {
            var result = await _budgetService.GetBatchBudgetAsync(request);
            return Ok(result);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting batch budgets");
            return StatusCode(500, new { error = ex.Message });
        }
    }

    /// <summary>
    /// Get all budget data for a year.
    /// </summary>
    [HttpGet("/budget/all")]
    public async Task<IActionResult> GetAllBudgets(
        [FromQuery] int year,
        [FromQuery] string? subsidiary = null,
        [FromQuery] string? category = null)
    {
        if (year <= 0)
            return BadRequest(new { error = "year parameter is required and must be > 0" });

        try
        {
            var result = await _budgetService.GetAllBudgetsAsync(year, subsidiary, category);
            return Ok(result);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting all budgets for year {Year}", year);
            return StatusCode(500, new { error = ex.Message });
        }
    }
}

