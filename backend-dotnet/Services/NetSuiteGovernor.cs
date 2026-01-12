/*
 * XAVI for NetSuite - NetSuite Request Governor
 *
 * Copyright (c) 2025 Celigo, Inc.
 * All rights reserved.
 *
 * This service manages NetSuite API request throttling, concurrency control,
 * and request deduplication to handle Excel-scale workloads safely.
 * 
 * Key responsibilities:
 * - Limit concurrent NetSuite requests (default: 3)
 * - Implement exponential backoff on rate limit errors
 * - Deduplicate identical in-flight requests
 * - Provide metrics for monitoring
 *
 * INVARIANT ENFORCEMENT (see PERFORMANCE-INVARIANTS.md):
 * - Identical formulas always collapse into a single NetSuite query
 * - NetSuite concurrency is always bounded by this governor
 * - Safety limits fail loudly with explicit error messages
 */

using System.Collections.Concurrent;

namespace XaviApi.Services;

/// <summary>
/// Safety limit types for explicit failure reporting.
/// </summary>
public enum SafetyLimitType
{
    None,
    MaxRetries,
    RateLimitExceeded,
    RowCapExceeded,
    ConcurrencyTimeout
}

/// <summary>
/// Exception thrown when a safety limit is hit.
/// These should NEVER be swallowed - they indicate a real problem.
/// </summary>
public class SafetyLimitException : Exception
{
    public SafetyLimitType LimitType { get; }
    public string UserFriendlyMessage { get; }
    public string SupportDetails { get; }
    
    public SafetyLimitException(
        SafetyLimitType limitType,
        string userMessage,
        string supportDetails,
        Exception? inner = null) 
        : base(userMessage, inner)
    {
        LimitType = limitType;
        UserFriendlyMessage = userMessage;
        SupportDetails = supportDetails;
    }
    
    /// <summary>
    /// Create a safety limit error result for API responses.
    /// </summary>
    public SafetyLimitError ToErrorResult() => new()
    {
        Error = "safety_limit_exceeded",
        LimitType = LimitType.ToString(),
        Message = UserFriendlyMessage,
        Details = SupportDetails,
        Timestamp = DateTime.UtcNow.ToString("o")
    };
}

/// <summary>
/// Error response structure for safety limit failures.
/// </summary>
public class SafetyLimitError
{
    public string Error { get; set; } = "safety_limit_exceeded";
    public string LimitType { get; set; } = "";
    public string Message { get; set; } = "";
    public string Details { get; set; } = "";
    public string Timestamp { get; set; } = "";
}

/// <summary>
/// Centralized governor for all NetSuite requests.
/// Ensures safe operation under Excel-scale workloads (3000+ formulas).
/// </summary>
public class NetSuiteGovernor : INetSuiteGovernor
{
    private readonly ILogger<NetSuiteGovernor> _logger;
    
    // Concurrency control - NetSuite allows 5 concurrent, we use 3 for safety
    private readonly SemaphoreSlim _concurrencySemaphore;
    private readonly int _maxConcurrency;
    
    // Rate limiting - minimum interval between requests
    private readonly object _rateLimitLock = new();
    private DateTime _lastRequestTime = DateTime.MinValue;
    private readonly int _minRequestIntervalMs;
    
    // Request deduplication - collapse identical in-flight requests
    private readonly ConcurrentDictionary<string, Task<GovernedResult>> _inFlightRequests = new();
    
    // Backoff tracking for rate limit errors
    private readonly object _backoffLock = new();
    private DateTime _backoffUntil = DateTime.MinValue;
    private int _consecutiveRateLimitErrors = 0;
    
    // Metrics
    private long _totalRequests = 0;
    private long _deduplicatedRequests = 0;
    private long _rateLimitErrors = 0;
    private long _retriedRequests = 0;
    private long _safetyLimitHits = 0; // Track explicit safety limit failures

    public NetSuiteGovernor(ILogger<NetSuiteGovernor> logger, IConfiguration config)
    {
        _logger = logger;
        
        // Read configuration or use safe defaults for Excel workloads
        // NetSuite allows 5 concurrent, but we use 3 for safety margin
        var configuredConcurrency = config.GetValue<int?>("NetSuite:MaxConcurrency");
        var configuredInterval = config.GetValue<int?>("NetSuite:MinRequestIntervalMs");
        
        _maxConcurrency = configuredConcurrency ?? 3; // Default: 3 concurrent
        _minRequestIntervalMs = configuredInterval ?? 100; // Default: 100ms between requests
        
        _concurrencySemaphore = new SemaphoreSlim(_maxConcurrency);
        
        _logger.LogInformation(
            "🛡️ NetSuite Governor initialized: maxConcurrency={MaxConcurrency}, minInterval={MinInterval}ms",
            _maxConcurrency, _minRequestIntervalMs);
    }

    /// <summary>
    /// Execute a request through the governor with throttling and deduplication.
    /// </summary>
    /// <param name="requestKey">Canonical key for deduplication (e.g., hash of query)</param>
    /// <param name="executeFunc">Function that performs the actual request</param>
    /// <param name="timeout">Request timeout in seconds</param>
    /// <param name="maxRetries">Maximum retry attempts on transient errors</param>
    public async Task<GovernedResult> ExecuteAsync(
        string requestKey,
        Func<Task<GovernedResult>> executeFunc,
        int timeout = 30,
        int maxRetries = 3)
    {
        Interlocked.Increment(ref _totalRequests);
        
        // Check for existing in-flight request with same key (deduplication)
        if (_inFlightRequests.TryGetValue(requestKey, out var existingTask))
        {
            Interlocked.Increment(ref _deduplicatedRequests);
            _logger.LogDebug("Request deduplicated: {Key}", requestKey[..Math.Min(50, requestKey.Length)]);
            return await existingTask;
        }
        
        // Create task for this request
        var requestTask = ExecuteWithGovernanceAsync(requestKey, executeFunc, timeout, maxRetries);
        
        // Try to register as the canonical request for this key
        if (!_inFlightRequests.TryAdd(requestKey, requestTask))
        {
            // Another thread beat us - use their task
            if (_inFlightRequests.TryGetValue(requestKey, out existingTask))
            {
                Interlocked.Increment(ref _deduplicatedRequests);
                return await existingTask;
            }
        }
        
        try
        {
            return await requestTask;
        }
        finally
        {
            // Remove from in-flight tracking
            _inFlightRequests.TryRemove(requestKey, out _);
        }
    }

    /// <summary>
    /// Internal execution with throttling, backoff, and retry logic.
    /// </summary>
    private async Task<GovernedResult> ExecuteWithGovernanceAsync(
        string requestKey,
        Func<Task<GovernedResult>> executeFunc,
        int timeout,
        int maxRetries)
    {
        // Wait for backoff if we hit rate limits
        await WaitForBackoffAsync();
        
        // Acquire concurrency slot
        await _concurrencySemaphore.WaitAsync();
        
        try
        {
            // Enforce minimum interval between requests
            EnforceMinimumInterval();
            
            // Execute with retry logic
            return await ExecuteWithRetryAsync(executeFunc, maxRetries);
        }
        finally
        {
            _concurrencySemaphore.Release();
        }
    }

    /// <summary>
    /// Wait if we're in a backoff period due to rate limiting.
    /// </summary>
    private async Task WaitForBackoffAsync()
    {
        DateTime backoffEnd;
        lock (_backoffLock)
        {
            backoffEnd = _backoffUntil;
        }
        
        if (backoffEnd > DateTime.UtcNow)
        {
            var waitTime = backoffEnd - DateTime.UtcNow;
            _logger.LogWarning("Rate limit backoff: waiting {WaitMs}ms", waitTime.TotalMilliseconds);
            await Task.Delay(waitTime);
        }
    }

    /// <summary>
    /// Enforce minimum interval between requests.
    /// </summary>
    private void EnforceMinimumInterval()
    {
        lock (_rateLimitLock)
        {
            var elapsed = (DateTime.UtcNow - _lastRequestTime).TotalMilliseconds;
            if (elapsed < _minRequestIntervalMs)
            {
                var sleepTime = _minRequestIntervalMs - (int)elapsed;
                Thread.Sleep(sleepTime);
            }
            _lastRequestTime = DateTime.UtcNow;
        }
    }

    /// <summary>
    /// Execute with exponential backoff retry on transient errors.
    /// 
    /// INVARIANT: Safety limits always fail loudly with explicit error messages.
    /// This method will NEVER return a silent failure.
    /// </summary>
    private async Task<GovernedResult> ExecuteWithRetryAsync(
        Func<Task<GovernedResult>> executeFunc,
        int maxRetries)
    {
        Exception? lastException = null;
        int rateLimitHits = 0;
        
        for (int attempt = 0; attempt <= maxRetries; attempt++)
        {
            try
            {
                var result = await executeFunc();
                
                // Check for rate limit error in result
                if (result.IsRateLimited)
                {
                    rateLimitHits++;
                    Interlocked.Increment(ref _rateLimitErrors);
                    HandleRateLimitError(attempt);
                    
                    if (attempt < maxRetries)
                    {
                        Interlocked.Increment(ref _retriedRequests);
                        continue; // Retry after backoff
                    }
                    else
                    {
                        // LOUD FAILURE: Rate limit exhausted all retries
                        Interlocked.Increment(ref _safetyLimitHits);
                        var error = new SafetyLimitException(
                            SafetyLimitType.RateLimitExceeded,
                            $"NetSuite rate limit exceeded after {maxRetries + 1} attempts. " +
                            "Please wait a moment and try again, or reduce the number of formulas being calculated.",
                            $"RateLimitHits={rateLimitHits}, Attempts={attempt + 1}, " +
                            $"ConsecutiveErrors={_consecutiveRateLimitErrors}");
                        
                        _logger.LogError(
                            "🚨 SAFETY LIMIT HIT: Rate limit exceeded. " +
                            "Type=RateLimitExceeded, Attempts={Attempts}, RateLimitHits={RateLimitHits}",
                            attempt + 1, rateLimitHits);
                        
                        return new GovernedResult
                        {
                            Success = false,
                            Error = error.UserFriendlyMessage,
                            SafetyLimitHit = SafetyLimitType.RateLimitExceeded
                        };
                    }
                }
                else
                {
                    // Success - reset consecutive error count
                    lock (_backoffLock)
                    {
                        _consecutiveRateLimitErrors = 0;
                    }
                }
                
                return result;
            }
            catch (TaskCanceledException ex)
            {
                lastException = ex;
                _logger.LogWarning("Request timed out (attempt {Attempt}/{MaxRetries})", 
                    attempt + 1, maxRetries + 1);
                
                if (attempt < maxRetries)
                {
                    Interlocked.Increment(ref _retriedRequests);
                    await Task.Delay(TimeSpan.FromSeconds(Math.Pow(2, attempt))); // Exponential backoff
                }
            }
            catch (Exception ex)
            {
                lastException = ex;
                _logger.LogError(ex, "Request failed (attempt {Attempt}/{MaxRetries})", 
                    attempt + 1, maxRetries + 1);
                
                // Don't retry on non-transient errors
                break;
            }
        }
        
        // LOUD FAILURE: Max retries exhausted
        Interlocked.Increment(ref _safetyLimitHits);
        
        var userMessage = lastException is TaskCanceledException
            ? $"Request timed out after {maxRetries + 1} attempts. " +
              "NetSuite may be slow or the query too complex. Try refreshing fewer cells at once."
            : $"Request failed after {maxRetries + 1} attempts. " +
              "Check your NetSuite connection and try again.";
        
        _logger.LogError(
            "🚨 SAFETY LIMIT HIT: Max retries exceeded. " +
            "Type=MaxRetries, Attempts={Attempts}, LastError={LastError}",
            maxRetries + 1, lastException?.Message ?? "unknown");
        
        return new GovernedResult
        {
            Success = false,
            Error = userMessage,
            SafetyLimitHit = SafetyLimitType.MaxRetries
        };
    }

    /// <summary>
    /// Handle rate limit error with exponential backoff.
    /// </summary>
    private void HandleRateLimitError(int attempt)
    {
        lock (_backoffLock)
        {
            _consecutiveRateLimitErrors++;
            
            // Exponential backoff: 1s, 2s, 4s, 8s, max 30s
            var backoffSeconds = Math.Min(30, Math.Pow(2, _consecutiveRateLimitErrors));
            _backoffUntil = DateTime.UtcNow.AddSeconds(backoffSeconds);
            
            _logger.LogWarning(
                "Rate limit hit ({Count} consecutive). Backoff for {Seconds}s",
                _consecutiveRateLimitErrors, backoffSeconds);
        }
    }

    /// <summary>
    /// Get current governor metrics.
    /// </summary>
    public GovernorMetrics GetMetrics()
    {
        return new GovernorMetrics
        {
            TotalRequests = Interlocked.Read(ref _totalRequests),
            DeduplicatedRequests = Interlocked.Read(ref _deduplicatedRequests),
            RateLimitErrors = Interlocked.Read(ref _rateLimitErrors),
            RetriedRequests = Interlocked.Read(ref _retriedRequests),
            SafetyLimitHits = Interlocked.Read(ref _safetyLimitHits),
            CurrentConcurrency = _maxConcurrency - _concurrencySemaphore.CurrentCount,
            MaxConcurrency = _maxConcurrency,
            InFlightRequests = _inFlightRequests.Count,
            IsInBackoff = _backoffUntil > DateTime.UtcNow
        };
    }

    /// <summary>
    /// Generate a canonical request key for deduplication.
    /// </summary>
    public static string GenerateRequestKey(string query)
    {
        // Normalize whitespace and generate hash
        var normalized = System.Text.RegularExpressions.Regex.Replace(query, @"\s+", " ").Trim();
        
        using var sha = System.Security.Cryptography.SHA256.Create();
        var hash = sha.ComputeHash(System.Text.Encoding.UTF8.GetBytes(normalized));
        return Convert.ToBase64String(hash)[..16]; // Use first 16 chars for brevity
    }
}

/// <summary>
/// Result wrapper from governed execution.
/// </summary>
public class GovernedResult
{
    public bool Success { get; set; }
    public string? Error { get; set; }
    public string? Data { get; set; }
    public bool IsRateLimited { get; set; }
    
    /// <summary>
    /// If not None, indicates which safety limit was hit.
    /// These should NEVER be ignored - they represent explicit failures.
    /// </summary>
    public SafetyLimitType SafetyLimitHit { get; set; } = SafetyLimitType.None;
}

/// <summary>
/// Governor metrics for monitoring.
/// </summary>
public class GovernorMetrics
{
    public long TotalRequests { get; set; }
    public long DeduplicatedRequests { get; set; }
    public long RateLimitErrors { get; set; }
    public long RetriedRequests { get; set; }
    public long SafetyLimitHits { get; set; } // Explicit safety limit failures
    public int CurrentConcurrency { get; set; }
    public int MaxConcurrency { get; set; }
    public int InFlightRequests { get; set; }
    public bool IsInBackoff { get; set; }
    
    public double DeduplicationRate => TotalRequests > 0 
        ? (double)DeduplicatedRequests / TotalRequests * 100 
        : 0;
}

/// <summary>
/// Interface for NetSuite Governor (for DI and testing).
/// </summary>
public interface INetSuiteGovernor
{
    Task<GovernedResult> ExecuteAsync(
        string requestKey,
        Func<Task<GovernedResult>> executeFunc,
        int timeout = 30,
        int maxRetries = 3);
    
    GovernorMetrics GetMetrics();
}

