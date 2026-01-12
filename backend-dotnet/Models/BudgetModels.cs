/*
 * XAVI for NetSuite - .NET Backend
 * 
 * Copyright (c) 2025 Celigo, Inc.
 * All rights reserved.
 */

using System.Text.Json.Serialization;

namespace XaviApi.Models;

/// <summary>Request for budget data</summary>
public class BudgetRequest
{
    [JsonPropertyName("account")]
    public string Account { get; set; } = string.Empty;
    
    [JsonPropertyName("from_period")]
    public string FromPeriod { get; set; } = string.Empty;
    
    [JsonPropertyName("to_period")]
    public string ToPeriod { get; set; } = string.Empty;
    
    [JsonPropertyName("subsidiary")]
    public string? Subsidiary { get; set; }
    
    [JsonPropertyName("department")]
    public string? Department { get; set; }
    
    [JsonPropertyName("class")]
    public string? Class { get; set; }
    
    [JsonPropertyName("location")]
    public string? Location { get; set; }
    
    [JsonPropertyName("category")]
    public string? Category { get; set; }
}

/// <summary>Response for budget query</summary>
public class BudgetResponse
{
    [JsonPropertyName("amount")]
    public decimal Amount { get; set; }
    
    [JsonPropertyName("account")]
    public string Account { get; set; } = string.Empty;
    
    [JsonPropertyName("from_period")]
    public string FromPeriod { get; set; } = string.Empty;
    
    [JsonPropertyName("to_period")]
    public string ToPeriod { get; set; } = string.Empty;
    
    [JsonPropertyName("category")]
    public string? Category { get; set; }
}

/// <summary>Request for batch budget retrieval</summary>
public class BatchBudgetRequest
{
    [JsonPropertyName("accounts")]
    public List<string> Accounts { get; set; } = new();
    
    [JsonPropertyName("periods")]
    public List<string> Periods { get; set; } = new();
    
    [JsonPropertyName("subsidiary")]
    public string? Subsidiary { get; set; }
    
    [JsonPropertyName("department")]
    public string? Department { get; set; }
    
    [JsonPropertyName("class")]
    public string? Class { get; set; }
    
    [JsonPropertyName("location")]
    public string? Location { get; set; }
    
    [JsonPropertyName("category")]
    public string? Category { get; set; }
}

/// <summary>Response for batch budget retrieval</summary>
public class BatchBudgetResponse
{
    [JsonPropertyName("budgets")]
    public Dictionary<string, Dictionary<string, decimal>> Budgets { get; set; } = new();
    
    [JsonPropertyName("query_count")]
    public int QueryCount { get; set; }
}

/// <summary>Response for all budgets for a year</summary>
public class AllBudgetsResponse
{
    [JsonPropertyName("year")]
    public int Year { get; set; }
    
    [JsonPropertyName("category")]
    public string Category { get; set; } = string.Empty;
    
    [JsonPropertyName("accounts")]
    public Dictionary<string, Dictionary<string, decimal>> Accounts { get; set; } = new();
    
    [JsonPropertyName("account_names")]
    public Dictionary<string, string> AccountNames { get; set; } = new();
    
    [JsonPropertyName("account_types")]
    public Dictionary<string, string> AccountTypes { get; set; } = new();
    
    [JsonPropertyName("account_count")]
    public int AccountCount { get; set; }
}

