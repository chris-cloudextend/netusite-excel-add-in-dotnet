# XAVI Parallelism Optimization Plan

**Document Version:** 1.0  
**Created:** January 2026  
**Status:** Planning  

---

## Executive Summary

This document outlines the plan for optimizing concurrent NetSuite API requests in XAVI. The current implementation uses conservative parallelism limits due to Cloudflare tunnel constraints. As we migrate to AWS, we can implement more sophisticated concurrency controls for improved performance.

---

## Current Architecture

```
┌─────────────────┐     ┌─────────────────────┐     ┌─────────────────┐     ┌─────────────┐
│   Excel Add-in  │────▶│  Cloudflare Tunnel  │────▶│   C# Backend    │────▶│  NetSuite   │
│  (functions.js) │     │     (Worker)        │     │   (API Server)  │     │    API      │
└─────────────────┘     └─────────────────────┘     └─────────────────┘     └─────────────┘
        │                                                   │
        │                                                   │
   Frontend                                            Backend
   Semaphore                                          (No limit)
   MAX = 2
```

### Current Concurrency Control

**Location:** `functions.js` lines 1454-1457

```javascript
// Limit concurrent batch queries to prevent Cloudflare tunnel overload (524 timeouts)
// GLOBAL semaphore (not scoped per account/worksheet/evaluation wave)
const MAX_CONCURRENT_BS_BATCH_QUERIES = 2; // Start conservative, tune later if safe
let activeBSBatchQueries = 0;
```

**Why it's set to 2:**
- Cloudflare 524 errors (origin timeout) were observed with higher concurrency
- Conservative approach to avoid impacting other NetSuite integrations
- No backend-side coordination across multiple Excel clients

---

## Constraints & Considerations

### NetSuite API Limits

| Tier | Concurrent Request Limit |
|------|--------------------------|
| Standard | 5 concurrent |
| Premium/Enterprise | 10-25 concurrent |

Exceeding limits returns:
- `429 Too Many Requests`
- `SSS_REQUEST_LIMIT_EXCEEDED`

### Query Characteristics

| Query Type | Typical Duration | Resource Intensity |
|------------|------------------|-------------------|
| BS Preload (cumulative) | 60-90 seconds | High |
| P&L Period Activity | 5-15 seconds | Medium |
| Account Metadata | 1-3 seconds | Low |
| Name/Type Lookups | <1 second | Trivial |

### Multi-User Contention

The frontend semaphore is **per Excel instance**, not global:
- User A: 2 concurrent requests
- User B: 2 concurrent requests  
- **Backend sees:** 4 concurrent requests to NetSuite

With 5+ active users, we can easily exceed NetSuite's concurrency limits.

---

## Phase 1: Short-Term (Cloudflare Tunnel)

**Goal:** Improve performance within current infrastructure constraints.

### 1.1 Per-Request-Type Concurrency Limits

Different query types have different impacts. Allow higher parallelism for lightweight queries.

**Frontend Change (`functions.js`):**

```javascript
const CONCURRENCY_LIMITS = {
    bs_preload: 2,        // Heavy cumulative queries - keep conservative
    balance_pl: 3,        // P&L period activity - moderate
    balance_change: 3,    // Balance change queries - moderate
    metadata: 5,          // Name, Type, Parent lookups - lightweight
    budget: 3             // Budget queries - moderate
};

// Separate semaphores per type
const activeCounts = {
    bs_preload: 0,
    balance_pl: 0,
    balance_change: 0,
    metadata: 0,
    budget: 0
};

async function acquireSlot(queryType) {
    const limit = CONCURRENCY_LIMITS[queryType] || 2;
    while (activeCounts[queryType] >= limit) {
        await new Promise(r => setTimeout(r, 100));
    }
    activeCounts[queryType]++;
}

function releaseSlot(queryType) {
    activeCounts[queryType]--;
}
```

**Estimated Impact:** 
- Metadata lookups: ~60% faster
- P&L queries: ~30% faster
- BS queries: No change (already optimized path)

### 1.2 Request Priority Queue

Ensure lightweight queries aren't blocked by heavy BS preloads.

```javascript
const requestQueue = {
    high: [],    // Metadata lookups (user waiting for cell to resolve)
    medium: [],  // P&L queries (moderate wait time)
    low: []      // BS preloads (background, can wait)
};

function enqueueRequest(request, priority = 'medium') {
    requestQueue[priority].push(request);
    processQueue();
}

async function processQueue() {
    // Process high priority first
    for (const priority of ['high', 'medium', 'low']) {
        while (requestQueue[priority].length > 0 && hasAvailableSlot()) {
            const request = requestQueue[priority].shift();
            executeRequest(request);
        }
    }
}
```

### 1.3 Adaptive Backoff

Reduce concurrency when errors occur, increase when successful.

```javascript
let adaptiveMultiplier = 1.0; // 0.5 to 1.5 range

function adjustConcurrency(queryType, durationMs, hadError) {
    if (hadError || durationMs > 60000) {
        // Slow down
        adaptiveMultiplier = Math.max(0.5, adaptiveMultiplier - 0.1);
        console.warn(`⚠️ Reducing concurrency multiplier to ${adaptiveMultiplier}`);
    } else if (durationMs < 5000 && !hadError) {
        // Speed up cautiously
        adaptiveMultiplier = Math.min(1.5, adaptiveMultiplier + 0.05);
    }
}

function getEffectiveLimit(queryType) {
    const baseLimit = CONCURRENCY_LIMITS[queryType];
    return Math.max(1, Math.floor(baseLimit * adaptiveMultiplier));
}
```

---

## Phase 2: AWS Migration (Backend-Side Control)

**Goal:** Implement proper global rate limiting at the backend where we have visibility across all clients.

### Target Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐     ┌─────────────┐
│   Excel Add-in  │────▶│   AWS API GW    │────▶│   C# Backend    │────▶│  NetSuite   │
│  (functions.js) │     │   + Lambda/ECS  │     │  (with Redis)   │     │    API      │
└─────────────────┘     └─────────────────┘     └─────────────────┘     └─────────────┘
        │                                               │
        │                                               │
   Frontend                                     Global Semaphore
   (relaxed limits)                             (Redis-backed)
                                                MAX = 8 total
```

### 2.1 Backend Global Semaphore

**C# Implementation:**

```csharp
// NetSuiteRateLimiter.cs
public class NetSuiteRateLimiter
{
    // In-process semaphore for single-instance deployments
    private static readonly SemaphoreSlim _localSemaphore = new(8, 8);
    
    // Redis-backed semaphore for multi-instance deployments
    private readonly IDistributedLockProvider _distributedLock;
    
    private readonly ILogger<NetSuiteRateLimiter> _logger;
    
    // Per-query-type limits (subset of global limit)
    private static readonly Dictionary<string, int> _typeLimits = new()
    {
        { "bs_preload", 3 },
        { "balance", 4 },
        { "metadata", 6 }
    };
    
    public async Task<T> ExecuteWithThrottlingAsync<T>(
        string queryType,
        Func<Task<T>> action,
        CancellationToken cancellationToken = default)
    {
        var stopwatch = Stopwatch.StartNew();
        
        // Wait for global slot
        await _localSemaphore.WaitAsync(cancellationToken);
        
        var queueTimeMs = stopwatch.ElapsedMilliseconds;
        if (queueTimeMs > 1000)
        {
            _logger.LogWarning("Request queued for {QueueTime}ms - high contention", queueTimeMs);
        }
        
        try
        {
            return await action();
        }
        finally
        {
            _localSemaphore.Release();
            
            // Telemetry
            var totalTimeMs = stopwatch.ElapsedMilliseconds;
            RecordMetrics(queryType, queueTimeMs, totalTimeMs);
        }
    }
    
    private void RecordMetrics(string queryType, long queueTimeMs, long totalTimeMs)
    {
        // CloudWatch/Prometheus metrics
        // - netsuite_request_queue_time_ms
        // - netsuite_request_total_time_ms  
        // - netsuite_concurrent_requests (gauge)
        // - netsuite_throttled_requests_total (counter)
    }
}
```

**Usage in Controllers:**

```csharp
[HttpPost("/batch/bs_preload_targeted")]
public async Task<IActionResult> BsPreloadTargeted([FromBody] TargetedBsPreloadRequest request)
{
    return await _rateLimiter.ExecuteWithThrottlingAsync("bs_preload", async () =>
    {
        // Existing implementation
        var result = await _balanceService.PreloadTargetedAsync(request);
        return Ok(result);
    });
}
```

### 2.2 Redis-Backed Distributed Semaphore (Multi-Instance)

For horizontal scaling with multiple backend instances:

```csharp
// DistributedNetSuiteRateLimiter.cs
public class DistributedNetSuiteRateLimiter
{
    private readonly IConnectionMultiplexer _redis;
    private readonly int _maxConcurrent = 8;
    private readonly string _keyPrefix = "xavi:netsuite:semaphore";
    
    public async Task<IAsyncDisposable> AcquireAsync(
        string queryType, 
        TimeSpan timeout,
        CancellationToken cancellationToken = default)
    {
        var slotKey = $"{_keyPrefix}:{Guid.NewGuid()}";
        var db = _redis.GetDatabase();
        
        var deadline = DateTime.UtcNow.Add(timeout);
        
        while (DateTime.UtcNow < deadline)
        {
            // Count current slots
            var currentCount = await db.SetLengthAsync(_keyPrefix);
            
            if (currentCount < _maxConcurrent)
            {
                // Try to acquire slot
                var added = await db.SetAddAsync(_keyPrefix, slotKey);
                if (added)
                {
                    // Set TTL to auto-release on crash (5 minutes)
                    await db.KeyExpireAsync(_keyPrefix, TimeSpan.FromMinutes(5));
                    
                    return new SlotReleaser(db, _keyPrefix, slotKey);
                }
            }
            
            // Wait and retry
            await Task.Delay(100, cancellationToken);
        }
        
        throw new TimeoutException("Could not acquire NetSuite request slot");
    }
    
    private class SlotReleaser : IAsyncDisposable
    {
        private readonly IDatabase _db;
        private readonly string _setKey;
        private readonly string _slotKey;
        
        public SlotReleaser(IDatabase db, string setKey, string slotKey)
        {
            _db = db;
            _setKey = setKey;
            _slotKey = slotKey;
        }
        
        public async ValueTask DisposeAsync()
        {
            await _db.SetRemoveAsync(_setKey, _slotKey);
        }
    }
}
```

### 2.3 Relaxed Frontend Limits

Once backend controls are in place, frontend can be more permissive:

```javascript
// After AWS migration with backend rate limiting
const CONCURRENCY_LIMITS = {
    bs_preload: 4,        // Backend will queue excess
    balance_pl: 6,        
    balance_change: 6,    
    metadata: 10,         
    budget: 6             
};
```

The backend becomes the single source of truth for concurrency control.

### 2.4 Telemetry & Alerting

**Key Metrics to Track:**

| Metric | Description | Alert Threshold |
|--------|-------------|-----------------|
| `netsuite_concurrent_requests` | Current active requests | > 7 for 5 min |
| `netsuite_queue_time_p95` | 95th percentile queue wait | > 5000ms |
| `netsuite_429_errors_total` | Rate limit errors | > 0 per minute |
| `netsuite_524_errors_total` | Timeout errors | > 0 per 5 min |
| `netsuite_request_duration_p95` | 95th percentile query time | > 90s (BS), > 30s (P&L) |

**CloudWatch Dashboard:**

```yaml
# cloudwatch-dashboard.yaml
widgets:
  - type: metric
    properties:
      title: "NetSuite Concurrency"
      metrics:
        - ["XAVI", "netsuite_concurrent_requests"]
      period: 60
      stat: Maximum
      
  - type: metric
    properties:
      title: "Request Queue Time"
      metrics:
        - ["XAVI", "netsuite_queue_time_p95"]
      period: 60
      
  - type: metric  
    properties:
      title: "Error Rate"
      metrics:
        - ["XAVI", "netsuite_429_errors_total", { "stat": "Sum" }]
        - ["XAVI", "netsuite_524_errors_total", { "stat": "Sum" }]
      period: 300
```

---

## Phase 3: Advanced Optimizations (Future)

### 3.1 User-Aware Fair Queuing

Prevent one power user from starving others:

```csharp
public class FairQueueRateLimiter
{
    private readonly ConcurrentDictionary<string, Queue<TaskCompletionSource<bool>>> _userQueues = new();
    
    public async Task<IAsyncDisposable> AcquireAsync(string userId, string queryType)
    {
        // Round-robin across user queues
        // Ensures each user gets fair share of capacity
    }
}
```

### 3.2 Predictive Pre-warming

Analyze user patterns and pre-fetch likely needed data:

```csharp
public class PredictivePreloader
{
    public async Task AnalyzeAndPreload(string userId, string currentPeriod)
    {
        // If user always queries Jan-Dec, and they just opened Jan,
        // proactively preload Feb-Dec in background
    }
}
```

### 3.3 Query Result Caching (Redis)

Cache NetSuite responses server-side to reduce API calls:

```csharp
public async Task<BalanceResult> GetBalanceWithCacheAsync(BalanceRequest request)
{
    var cacheKey = $"balance:{request.Account}:{request.Period}:{request.Book}";
    
    // Check Redis cache first
    var cached = await _redis.GetAsync<BalanceResult>(cacheKey);
    if (cached != null)
    {
        return cached;
    }
    
    // Query NetSuite
    var result = await _rateLimiter.ExecuteWithThrottlingAsync("balance", async () =>
    {
        return await _netSuiteService.QueryBalanceAsync(request);
    });
    
    // Cache for 15 minutes
    await _redis.SetAsync(cacheKey, result, TimeSpan.FromMinutes(15));
    
    return result;
}
```

---

## Implementation Checklist

### Phase 1 (Current Sprint - Cloudflare)
- [ ] Implement per-request-type concurrency limits
- [ ] Add adaptive backoff on errors
- [ ] Add basic telemetry (console logging with timestamps)
- [ ] Test with simulated multi-user load

### Phase 2 (AWS Migration)
- [ ] Create `NetSuiteRateLimiter` service
- [ ] Integrate rate limiter into all controllers
- [ ] Set up Redis for distributed locking
- [ ] Create CloudWatch dashboard
- [ ] Set up alerting for 429/524 errors
- [ ] Load test with realistic user patterns
- [ ] Relax frontend limits after backend control confirmed

### Phase 3 (Future Enhancements)
- [ ] User-aware fair queuing
- [ ] Predictive pre-warming based on usage patterns
- [ ] Server-side query result caching

---

## Appendix: Testing Concurrency Changes

### Local Load Test Script

```javascript
// test-concurrency.js
async function simulateMultipleUsers(userCount, queriesPerUser) {
    const users = [];
    
    for (let u = 0; u < userCount; u++) {
        users.push((async () => {
            for (let q = 0; q < queriesPerUser; q++) {
                const start = Date.now();
                try {
                    await fetch('/balance?account=10010&to_period=Dec%202024');
                    console.log(`User ${u} Query ${q}: ${Date.now() - start}ms`);
                } catch (e) {
                    console.error(`User ${u} Query ${q}: FAILED - ${e.message}`);
                }
            }
        })());
    }
    
    await Promise.all(users);
}

// Simulate 5 users each making 10 queries
simulateMultipleUsers(5, 10);
```

### Metrics to Capture During Testing

1. **Queue Wait Time:** How long requests wait before starting
2. **Total Request Time:** End-to-end including queue wait
3. **Error Rate:** 429s, 524s, and other failures
4. **NetSuite Concurrency Meter:** Check NetSuite's usage dashboard

---

## Contact

For questions about this plan, contact the XAVI engineering team.
