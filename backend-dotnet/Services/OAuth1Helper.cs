/*
 * XAVI for NetSuite - OAuth 1.0 Helper
 *
 * Copyright (c) 2025 Celigo, Inc.
 * All rights reserved.
 *
 * NetSuite requires OAuth 1.0 (NOT OAuth 2.0) for REST API authentication.
 * This helper generates the OAuth 1.0 signature and Authorization header.
 */

using System.Security.Cryptography;
using System.Text;
using System.Web;

namespace XaviApi.Services;

/// <summary>
/// OAuth 1.0 signature generator for NetSuite REST API.
/// NetSuite uses HMAC-SHA256 signature method (not SHA1).
/// </summary>
public static class OAuth1Helper
{
    /// <summary>
    /// Generate OAuth 1.0 Authorization header for NetSuite API request.
    /// </summary>
    /// <param name="httpMethod">HTTP method (GET, POST, etc.)</param>
    /// <param name="url">Full request URL (without query string for POST)</param>
    /// <param name="realm">NetSuite account ID</param>
    /// <param name="consumerKey">OAuth consumer key</param>
    /// <param name="consumerSecret">OAuth consumer secret</param>
    /// <param name="tokenId">OAuth token ID</param>
    /// <param name="tokenSecret">OAuth token secret</param>
    /// <returns>Authorization header value</returns>
    public static string GenerateAuthorizationHeader(
        string httpMethod,
        string url,
        string realm,
        string consumerKey,
        string consumerSecret,
        string tokenId,
        string tokenSecret)
    {
        var timestamp = GetTimestamp();
        var nonce = GetNonce();

        // OAuth parameters (alphabetically sorted for signature base string)
        var oauthParams = new SortedDictionary<string, string>
        {
            { "oauth_consumer_key", consumerKey },
            { "oauth_nonce", nonce },
            { "oauth_signature_method", "HMAC-SHA256" },
            { "oauth_timestamp", timestamp },
            { "oauth_token", tokenId },
            { "oauth_version", "1.0" }
        };

        // Generate signature
        var signature = GenerateSignature(
            httpMethod,
            url,
            oauthParams,
            consumerSecret,
            tokenSecret);

        // Build Authorization header
        var headerParams = new List<string>
        {
            $"realm=\"{UrlEncode(realm)}\"",
            $"oauth_consumer_key=\"{UrlEncode(consumerKey)}\"",
            $"oauth_token=\"{UrlEncode(tokenId)}\"",
            $"oauth_signature_method=\"HMAC-SHA256\"",
            $"oauth_timestamp=\"{timestamp}\"",
            $"oauth_nonce=\"{UrlEncode(nonce)}\"",
            $"oauth_version=\"1.0\"",
            $"oauth_signature=\"{UrlEncode(signature)}\""
        };

        return "OAuth " + string.Join(", ", headerParams);
    }

    /// <summary>
    /// Generate OAuth 1.0 signature using HMAC-SHA256.
    /// </summary>
    private static string GenerateSignature(
        string httpMethod,
        string url,
        SortedDictionary<string, string> oauthParams,
        string consumerSecret,
        string tokenSecret)
    {
        // Build parameter string (sorted alphabetically)
        var paramString = string.Join("&",
            oauthParams.Select(kvp => $"{UrlEncode(kvp.Key)}={UrlEncode(kvp.Value)}"));

        // Parse URL to get base URL (without query string)
        var uri = new Uri(url);
        var baseUrl = $"{uri.Scheme}://{uri.Host}{uri.AbsolutePath}";

        // Build signature base string
        var signatureBaseString = $"{httpMethod.ToUpper()}&{UrlEncode(baseUrl)}&{UrlEncode(paramString)}";

        // Build signing key
        var signingKey = $"{UrlEncode(consumerSecret)}&{UrlEncode(tokenSecret)}";

        // Generate HMAC-SHA256 signature
        using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(signingKey));
        var hash = hmac.ComputeHash(Encoding.UTF8.GetBytes(signatureBaseString));
        return Convert.ToBase64String(hash);
    }

    /// <summary>
    /// Get Unix timestamp in seconds.
    /// </summary>
    private static string GetTimestamp()
    {
        return DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString();
    }

    /// <summary>
    /// Generate a unique nonce for the request.
    /// </summary>
    private static string GetNonce()
    {
        return Guid.NewGuid().ToString("N");
    }

    /// <summary>
    /// URL-encode a string per OAuth 1.0 spec (RFC 3986).
    /// </summary>
    private static string UrlEncode(string value)
    {
        if (string.IsNullOrEmpty(value))
            return string.Empty;

        // OAuth 1.0 requires uppercase hex encoding and specific character handling
        var encoded = new StringBuilder();
        foreach (var c in value)
        {
            if (IsUnreserved(c))
            {
                encoded.Append(c);
            }
            else
            {
                encoded.Append('%');
                encoded.Append(((int)c).ToString("X2"));
            }
        }
        return encoded.ToString();
    }

    /// <summary>
    /// Check if character is unreserved per RFC 3986.
    /// </summary>
    private static bool IsUnreserved(char c)
    {
        return (c >= 'A' && c <= 'Z') ||
               (c >= 'a' && c <= 'z') ||
               (c >= '0' && c <= '9') ||
               c == '-' || c == '.' || c == '_' || c == '~';
    }
}

