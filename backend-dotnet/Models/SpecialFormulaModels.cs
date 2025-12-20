/*
 * XAVI for NetSuite - .NET Backend
 * 
 * Copyright (c) 2025 Celigo, Inc.
 * All rights reserved.
 */

using System.Text.Json;
using System.Text.Json.Serialization;

namespace XaviApi.Models;

/// <summary>
/// JSON converter that handles int? from both numbers and strings (including empty strings).
/// Frontend may send accountingBook as "" or "1" instead of null or 1.
/// </summary>
public class FlexibleIntConverter : JsonConverter<int?>
{
    public override int? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType == JsonTokenType.Null)
            return null;
        
        if (reader.TokenType == JsonTokenType.Number)
            return reader.GetInt32();
        
        if (reader.TokenType == JsonTokenType.String)
        {
            var str = reader.GetString();
            if (string.IsNullOrWhiteSpace(str))
                return null;
            if (int.TryParse(str, out var result))
                return result;
            return null;
        }
        
        return null;
    }

    public override void Write(Utf8JsonWriter writer, int? value, JsonSerializerOptions options)
    {
        if (value.HasValue)
            writer.WriteNumberValue(value.Value);
        else
            writer.WriteNullValue();
    }
}

/// <summary>Request for Retained Earnings calculation</summary>
public class RetainedEarningsRequest
{
    [JsonPropertyName("period")]
    public string Period { get; set; } = string.Empty;
    
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

/// <summary>Response for Retained Earnings calculation</summary>
public class RetainedEarningsResponse
{
    [JsonPropertyName("retained_earnings")]
    public decimal RetainedEarnings { get; set; }
    
    [JsonPropertyName("as_of_period")]
    public string AsOfPeriod { get; set; } = string.Empty;
    
    [JsonPropertyName("calculation")]
    public string? Calculation { get; set; }
    
    /// <summary>One-word error code if calculation failed (e.g., TIMEOUT, RATELIMIT)</summary>
    [JsonPropertyName("error")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Error { get; set; }
}

/// <summary>Request for Net Income calculation</summary>
public class NetIncomeRequest
{
    [JsonPropertyName("period")]
    public string Period { get; set; } = string.Empty;
    
    [JsonPropertyName("fromPeriod")]
    public string? FromPeriod { get; set; }
    
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

/// <summary>Response for Net Income calculation</summary>
public class NetIncomeResponse
{
    [JsonPropertyName("net_income")]
    public decimal NetIncome { get; set; }
    
    [JsonPropertyName("period")]
    public string Period { get; set; } = string.Empty;
    
    [JsonPropertyName("income")]
    public decimal? Income { get; set; }
    
    [JsonPropertyName("expenses")]
    public decimal? Expenses { get; set; }
    
    /// <summary>One-word error code if calculation failed (e.g., TIMEOUT, RATELIMIT)</summary>
    [JsonPropertyName("error")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Error { get; set; }
}

/// <summary>Request for CTA (Cumulative Translation Adjustment) calculation</summary>
public class CtaRequest
{
    [JsonPropertyName("period")]
    public string Period { get; set; } = string.Empty;
    
    [JsonPropertyName("subsidiary")]
    public string? Subsidiary { get; set; }
    
    [JsonPropertyName("accountingBook")]
    [JsonConverter(typeof(FlexibleIntConverter))]
    public int? Book { get; set; }
}

/// <summary>Response for CTA calculation</summary>
public class CtaResponse
{
    [JsonPropertyName("cta")]
    public decimal Cta { get; set; }
    
    [JsonPropertyName("as_of_period")]
    public string AsOfPeriod { get; set; } = string.Empty;
    
    [JsonPropertyName("calculation")]
    public string? Calculation { get; set; }
    
    /// <summary>One-word error code if calculation failed (e.g., TIMEOUT, RATELIMIT)</summary>
    [JsonPropertyName("error")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Error { get; set; }
}

