/*
 * XAVI for NetSuite - .NET Backend
 * 
 * Copyright (c) 2025 Celigo, Inc.
 * All rights reserved.
 */

using System.Text.Json;
using System.Text.Json.Serialization;

namespace XaviApi.Models;

#region Balance Requests

/// <summary>Request for single account balance</summary>
public class BalanceRequest
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
    
    [JsonPropertyName("book")]
    [JsonConverter(typeof(FlexibleIntConverter))]
    public int? Book { get; set; }
}

/// <summary>Request for batch balance retrieval</summary>
public class BatchBalanceRequest
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
    
    [JsonPropertyName("book")]
    [JsonConverter(typeof(FlexibleIntConverter))]
    public int? Book { get; set; }
}

/// <summary>Request for full year refresh</summary>
public class FullYearRefreshRequest
{
    [JsonPropertyName("year")]
    public int Year { get; set; }
    
    [JsonPropertyName("subsidiary")]
    public string? Subsidiary { get; set; }
    
    [JsonPropertyName("department")]
    public string? Department { get; set; }
    
    [JsonPropertyName("class")]
    public string? Class { get; set; }
    
    [JsonPropertyName("location")]
    public string? Location { get; set; }
    
    [JsonPropertyName("book")]
    [JsonConverter(typeof(FlexibleIntConverter))]
    public int? Book { get; set; }
}

/// <summary>
/// Request for year balance optimization endpoint.
/// </summary>
public class YearBalanceRequest
{
    [JsonPropertyName("accounts")]
    public List<string> Accounts { get; set; } = new();
    
    [JsonPropertyName("year")]
    public int Year { get; set; }
    
    [JsonPropertyName("subsidiary")]
    public string? Subsidiary { get; set; }
    
    [JsonPropertyName("accountingbook")]
    [JsonConverter(typeof(FlexibleIntConverter))]
    public int? Book { get; set; }
}

#endregion

#region Balance Responses

/// <summary>Response for single balance query</summary>
public class BalanceResponse
{
    [JsonPropertyName("balance")]
    public decimal Balance { get; set; }
    
    [JsonPropertyName("account")]
    public string Account { get; set; } = string.Empty;
    
    [JsonPropertyName("account_name")]
    public string? AccountName { get; set; }
    
    [JsonPropertyName("account_type")]
    public string? AccountType { get; set; }
    
    [JsonPropertyName("from_period")]
    public string FromPeriod { get; set; } = string.Empty;
    
    [JsonPropertyName("to_period")]
    public string ToPeriod { get; set; } = string.Empty;
    
    [JsonPropertyName("currency")]
    public string? Currency { get; set; }
    
    [JsonPropertyName("cached")]
    public bool Cached { get; set; }
    
    [JsonPropertyName("debug_query")]
    public string? DebugQuery { get; set; }
    
    /// <summary>
    /// One-word error code if query failed (e.g., TIMEOUT, RATELIMIT, NETFAIL).
    /// When set, balance will be 0 and Excel should display this error instead.
    /// </summary>
    [JsonPropertyName("error")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Error { get; set; }
}

/// <summary>Response for batch balance retrieval</summary>
public class BatchBalanceResponse
{
    [JsonPropertyName("balances")]
    public Dictionary<string, Dictionary<string, decimal>> Balances { get; set; } = new();
    
    [JsonPropertyName("account_types")]
    public Dictionary<string, string> AccountTypes { get; set; } = new();
    
    [JsonPropertyName("cached")]
    public bool Cached { get; set; }
    
    [JsonPropertyName("query_count")]
    public int QueryCount { get; set; }
    
    /// <summary>
    /// One-word error code if query failed (e.g., TIMEOUT, RATELIMIT, NETFAIL).
    /// When set, balances may be incomplete and Excel should display this error.
    /// </summary>
    [JsonPropertyName("error")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Error { get; set; }
}

/// <summary>Individual balance item in batch response</summary>
public class BalanceItem
{
    [JsonPropertyName("account")]
    public string Account { get; set; } = string.Empty;
    
    [JsonPropertyName("period")]
    public string Period { get; set; } = string.Empty;
    
    [JsonPropertyName("balance")]
    public decimal Balance { get; set; }
    
    [JsonPropertyName("account_type")]
    public string? AccountType { get; set; }
}

/// <summary>
/// Response for balance change calculation.
/// Returns the change in a BS account between two points in time.
/// </summary>
public class BalanceChangeResponse
{
    [JsonPropertyName("account")]
    public string Account { get; set; } = string.Empty;
    
    [JsonPropertyName("account_type")]
    public string? AccountType { get; set; }
    
    [JsonPropertyName("from_period")]
    public string FromPeriod { get; set; } = string.Empty;
    
    [JsonPropertyName("to_period")]
    public string ToPeriod { get; set; } = string.Empty;
    
    /// <summary>Balance as of from_period (cumulative from inception)</summary>
    [JsonPropertyName("from_balance")]
    public decimal FromBalance { get; set; }
    
    /// <summary>Balance as of to_period (cumulative from inception)</summary>
    [JsonPropertyName("to_balance")]
    public decimal ToBalance { get; set; }
    
    /// <summary>The change: to_balance - from_balance</summary>
    [JsonPropertyName("change")]
    public decimal Change { get; set; }
    
    [JsonPropertyName("cached")]
    public bool Cached { get; set; }
    
    /// <summary>
    /// One-word error code if calculation failed.
    /// INVALIDACCT = account is not a Balance Sheet account
    /// NOTFOUND = account not found
    /// TIMEOUT, RATELIMIT, etc. = query errors
    /// </summary>
    [JsonPropertyName("error")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Error { get; set; }
}

#endregion

#region Type Balance

/// <summary>Request for type balance (e.g., all Income accounts)</summary>
public class TypeBalanceRequest
{
    [JsonPropertyName("accountType")]
    public string AccountType { get; set; } = string.Empty;
    
    [JsonPropertyName("fromPeriod")]
    public string FromPeriod { get; set; } = string.Empty;
    
    [JsonPropertyName("toPeriod")]
    public string ToPeriod { get; set; } = string.Empty;
    
    [JsonPropertyName("subsidiary")]
    public string? Subsidiary { get; set; }
    
    [JsonPropertyName("department")]
    public string? Department { get; set; }
    
    [JsonPropertyName("classId")]
    public string? Class { get; set; }
    
    [JsonPropertyName("location")]
    public string? Location { get; set; }
    
    [JsonPropertyName("accountingBook")]
    [JsonConverter(typeof(FlexibleIntConverter))]
    public int? Book { get; set; }
}

/// <summary>Response for type balance</summary>
public class TypeBalanceResponse
{
    [JsonPropertyName("value")]
    public decimal Value { get; set; }
    
    [JsonPropertyName("balance")]
    public decimal Balance { get; set; }
    
    [JsonPropertyName("accountType")]
    public string AccountType { get; set; } = string.Empty;
    
    [JsonPropertyName("isBalanceSheet")]
    public bool IsBalanceSheet { get; set; }
    
    [JsonPropertyName("fromPeriod")]
    public string? FromPeriod { get; set; }
    
    [JsonPropertyName("toPeriod")]
    public string ToPeriod { get; set; } = string.Empty;
    
    [JsonPropertyName("account_count")]
    public int AccountCount { get; set; }
    
    [JsonPropertyName("accounts")]
    public List<AccountBalance>? Accounts { get; set; }
    
    /// <summary>
    /// One-word error code if query failed (e.g., TIMEOUT, RATELIMIT, NETFAIL).
    /// When set, value will be 0 and Excel should display this error instead.
    /// </summary>
    [JsonPropertyName("error")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Error { get; set; }
}

/// <summary>Account with balance (for type balance drill-down)</summary>
public class AccountBalance
{
    [JsonPropertyName("account")]
    public string Account { get; set; } = string.Empty;
    
    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;
    
    [JsonPropertyName("balance")]
    public decimal Balance { get; set; }
}

#endregion

#region Balance Sheet Report

/// <summary>Request for Balance Sheet report generation</summary>
public class BalanceSheetReportRequest
{
    [JsonPropertyName("period")]
    public string Period { get; set; } = string.Empty;
    
    [JsonPropertyName("subsidiary")]
    public string? Subsidiary { get; set; }
    
    [JsonPropertyName("department")]
    public string? Department { get; set; }
    
    [JsonPropertyName("class")]
    public string? Class { get; set; }
    
    [JsonPropertyName("location")]
    public string? Location { get; set; }
    
    [JsonPropertyName("book")]
    [JsonConverter(typeof(FlexibleIntConverter))]
    public int? Book { get; set; }
    
    /// <summary>If true, skip calculating NETINCOME, RETAINEDEARNINGS, and CTA (for faster report generation)</summary>
    [JsonPropertyName("skip_calculated_rows")]
    public bool SkipCalculatedRows { get; set; } = false;
}

/// <summary>Balance Sheet report row</summary>
public class BalanceSheetRow
{
    [JsonPropertyName("section")]
    public string Section { get; set; } = string.Empty; // Assets, Liabilities, Equity
    
    [JsonPropertyName("subsection")]
    public string Subsection { get; set; } = string.Empty; // Current Assets, Fixed Assets, etc.
    
    [JsonPropertyName("account_number")]
    public string? AccountNumber { get; set; }
    
    [JsonPropertyName("account_name")]
    public string AccountName { get; set; } = string.Empty;
    
    [JsonPropertyName("account_type")]
    public string AccountType { get; set; } = string.Empty;
    
    [JsonPropertyName("parent_account")]
    public string? ParentAccount { get; set; }
    
    [JsonPropertyName("balance")]
    public decimal Balance { get; set; }
    
    [JsonPropertyName("is_calculated")]
    public bool IsCalculated { get; set; }
    
    [JsonPropertyName("source")]
    public string Source { get; set; } = "Account"; // "Account" or "Calculated"
    
    [JsonPropertyName("level")]
    public int Level { get; set; } // 0 = top level, 1 = child, etc.
}

/// <summary>Balance Sheet report response</summary>
public class BalanceSheetReportResponse
{
    [JsonPropertyName("rows")]
    public List<BalanceSheetRow> Rows { get; set; } = new();
    
    [JsonPropertyName("period")]
    public string Period { get; set; } = string.Empty;
    
    [JsonPropertyName("total_assets")]
    public decimal TotalAssets { get; set; }
    
    [JsonPropertyName("total_liabilities")]
    public decimal TotalLiabilities { get; set; }
    
    [JsonPropertyName("total_equity")]
    public decimal TotalEquity { get; set; }
}

#endregion

