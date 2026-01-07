/*
 * XAVI for NetSuite - .NET Backend
 * 
 * Copyright (c) 2025 Celigo, Inc.
 * All rights reserved.
 */

using System.Text.Json.Serialization;

namespace XaviApi.Models;

/// <summary>Generic lookup item (Subsidiary, Department, Class, Location)</summary>
public class LookupItem
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;
    
    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;
    
    [JsonPropertyName("fullname")]
    public string? FullName { get; set; }
    
    [JsonPropertyName("parent")]
    public string? Parent { get; set; }
}

/// <summary>Subsidiary with currency info</summary>
public class SubsidiaryItem : LookupItem
{
    [JsonPropertyName("currency")]
    public string? Currency { get; set; }
    
    [JsonPropertyName("currency_symbol")]
    public string? CurrencySymbol { get; set; }
    
    [JsonPropertyName("depth")]
    public int Depth { get; set; }
    
    [JsonPropertyName("isConsolidated")]
    public bool IsConsolidated { get; set; }
    
    [JsonPropertyName("isElimination")]
    public bool IsElimination { get; set; }
}

/// <summary>Account lookup item</summary>
public class AccountItem
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;
    
    // Use lowercase 'accountnumber' to match frontend expectations
    [JsonPropertyName("accountnumber")]
    public string Number { get; set; } = string.Empty;
    
    // Use lowercase 'accountname' to match frontend expectations  
    [JsonPropertyName("accountname")]
    public string Name { get; set; } = string.Empty;
    
    [JsonPropertyName("fullname")]
    public string? FullName { get; set; }
    
    // Use lowercase 'accttype' to match frontend expectations
    [JsonPropertyName("accttype")]
    public string Type { get; set; } = string.Empty;
    
    [JsonPropertyName("parent")]
    public string? Parent { get; set; }
    
    // Add special account type for cash flow statements
    [JsonPropertyName("sspecacct")]
    public string? SpecialAccountType { get; set; }
}

/// <summary>Account search result with metadata</summary>
public class AccountSearchResult
{
    [JsonPropertyName("accounts")]
    public List<AccountItem> Items { get; set; } = new();
    
    [JsonPropertyName("search_type")]
    public string SearchType { get; set; } = string.Empty;
    
    [JsonIgnore]
    public List<string> MatchedTypes { get; set; } = new();
}

/// <summary>Accounting book item</summary>
public class AccountingBookItem
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;
    
    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;
    
    [JsonPropertyName("isprimary")]
    public bool IsPrimary { get; set; }
}

/// <summary>Budget category item</summary>
public class BudgetCategoryItem
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;
    
    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;
}

/// <summary>Currency item</summary>
public class CurrencyItem
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;
    
    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;
    
    [JsonPropertyName("symbol")]
    public string Symbol { get; set; } = string.Empty;
    
    [JsonPropertyName("displayname")]
    public string? DisplayName { get; set; }
}

/// <summary>Response containing all lookups</summary>
public class AllLookupsResponse
{
    [JsonPropertyName("subsidiaries")]
    public List<SubsidiaryItem> Subsidiaries { get; set; } = new();
    
    [JsonPropertyName("departments")]
    public List<LookupItem> Departments { get; set; } = new();
    
    [JsonPropertyName("classes")]
    public List<LookupItem> Classes { get; set; } = new();
    
    [JsonPropertyName("locations")]
    public List<LookupItem> Locations { get; set; } = new();
    
    [JsonPropertyName("accountingbooks")]
    public List<AccountingBookItem> AccountingBooks { get; set; } = new();
    
    [JsonPropertyName("budgetcategories")]
    public List<BudgetCategoryItem> BudgetCategories { get; set; } = new();
}

/// <summary>Accounting period</summary>
public class AccountingPeriod
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;
    
    [JsonPropertyName("periodname")]
    public string PeriodName { get; set; } = string.Empty;
    
    [JsonPropertyName("startdate")]
    public string? StartDate { get; set; }
    
    [JsonPropertyName("enddate")]
    public string? EndDate { get; set; }
    
    [JsonPropertyName("isquarter")]
    public bool IsQuarter { get; set; }
    
    [JsonPropertyName("isyear")]
    public bool IsYear { get; set; }
}

/// <summary>Subsidiary display item with consolidation eligibility</summary>
public class SubsidiaryDisplayItem
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;
    
    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;
    
    [JsonPropertyName("fullName")]
    public string? FullName { get; set; }
    
    [JsonPropertyName("canConsolidate")]
    public bool CanConsolidate { get; set; }
    
    [JsonPropertyName("isLeaf")]
    public bool IsLeaf { get; set; }
}

/// <summary>Response for book-scoped subsidiaries following NetSuite rules</summary>
public class BookScopedSubsidiariesResponse
{
    [JsonPropertyName("allSubsidiaries")]
    public bool AllSubsidiaries { get; set; }
    
    [JsonPropertyName("subsidiaries")]
    public List<SubsidiaryDisplayItem> Subsidiaries { get; set; } = new();
    
    [JsonPropertyName("isSingleSubsidiaryBook")]
    public bool IsSingleSubsidiaryBook { get; set; }
}

