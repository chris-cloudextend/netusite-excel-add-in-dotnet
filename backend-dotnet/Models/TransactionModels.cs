/*
 * XAVI for NetSuite - .NET Backend
 * 
 * Copyright (c) 2025 Celigo, Inc.
 * All rights reserved.
 */

using System.Text.Json.Serialization;

namespace XaviApi.Models;

/// <summary>Request for GL transaction details (drill-down)</summary>
public class TransactionRequest
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
}

/// <summary>GL transaction line item</summary>
public class TransactionLine
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;
    
    [JsonPropertyName("tranid")]
    public string TranId { get; set; } = string.Empty;
    
    [JsonPropertyName("trandate")]
    public string TranDate { get; set; } = string.Empty;
    
    [JsonPropertyName("type")]
    public string Type { get; set; } = string.Empty;
    
    [JsonPropertyName("memo")]
    public string? Memo { get; set; }
    
    [JsonPropertyName("entity")]
    public string? Entity { get; set; }
    
    [JsonPropertyName("amount")]
    public decimal Amount { get; set; }
    
    [JsonPropertyName("debit")]
    public decimal? Debit { get; set; }
    
    [JsonPropertyName("credit")]
    public decimal? Credit { get; set; }
    
    [JsonPropertyName("department")]
    public string? Department { get; set; }
    
    [JsonPropertyName("class")]
    public string? Class { get; set; }
    
    [JsonPropertyName("location")]
    public string? Location { get; set; }
}

/// <summary>Response for transaction drill-down</summary>
public class TransactionResponse
{
    [JsonPropertyName("transactions")]
    public List<TransactionLine> Transactions { get; set; } = new();
    
    [JsonPropertyName("total")]
    public decimal Total { get; set; }
    
    [JsonPropertyName("count")]
    public int Count { get; set; }
    
    [JsonPropertyName("account")]
    public string Account { get; set; } = string.Empty;
    
    [JsonPropertyName("from_period")]
    public string FromPeriod { get; set; } = string.Empty;
    
    [JsonPropertyName("to_period")]
    public string ToPeriod { get; set; } = string.Empty;
}

