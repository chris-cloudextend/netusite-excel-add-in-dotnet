/*
 * XAVI for NetSuite - .NET Backend
 * 
 * Copyright (c) 2025 Celigo, Inc.
 * All rights reserved.
 */

namespace XaviApi.Configuration;

/// <summary>
/// NetSuite OAuth 1.0 configuration settings
/// </summary>
public class NetSuiteConfig
{
    public const string SectionName = "NetSuite";
    
    /// <summary>NetSuite account ID (e.g., "1234567" or "1234567_SB1" for sandbox)</summary>
    public string AccountId { get; set; } = string.Empty;
    
    /// <summary>OAuth 1.0 Consumer Key from NetSuite integration</summary>
    public string ConsumerKey { get; set; } = string.Empty;
    
    /// <summary>OAuth 1.0 Consumer Secret from NetSuite integration</summary>
    public string ConsumerSecret { get; set; } = string.Empty;
    
    /// <summary>OAuth 1.0 Token ID from NetSuite user credentials</summary>
    public string TokenId { get; set; } = string.Empty;
    
    /// <summary>OAuth 1.0 Token Secret from NetSuite user credentials</summary>
    public string TokenSecret { get; set; } = string.Empty;
    
    /// <summary>NetSuite SuiteQL REST API base URL</summary>
    public string SuiteQlUrl => $"https://{AccountId}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql";
    
    /// <summary>Validate that all required credentials are present</summary>
    public bool IsValid => 
        !string.IsNullOrEmpty(AccountId) &&
        !string.IsNullOrEmpty(ConsumerKey) &&
        !string.IsNullOrEmpty(ConsumerSecret) &&
        !string.IsNullOrEmpty(TokenId) &&
        !string.IsNullOrEmpty(TokenSecret);
}

/// <summary>
/// CORS configuration settings
/// </summary>
public class CorsConfig
{
    public const string SectionName = "Cors";
    
    public string[] AllowedOrigins { get; set; } = Array.Empty<string>();
}

/// <summary>
/// Cache configuration settings
/// </summary>
public class CacheConfig
{
    public const string SectionName = "Cache";
    
    /// <summary>TTL for balance cache in seconds (default 5 minutes)</summary>
    public int BalanceCacheTtlSeconds { get; set; } = 300;
    
    /// <summary>TTL for lookup cache in minutes (default 60 minutes)</summary>
    public int LookupCacheTtlMinutes { get; set; } = 60;
}

