# XAVI for NetSuite - Performance & Correctness Invariants

> **Purpose**: This document defines non-negotiable system invariants that ensure correct and safe behavior under Excel-scale workloads (3000+ formulas).
>
> **Audience**: All engineers modifying the C# backend should read this document first.

---

## Core Invariants

### 1. Identical Formulas Always Collapse into a Single Query

**Invariant**: When multiple identical formulas are evaluated (e.g., drag-fill, copy-paste, Refresh All), they MUST collapse into a single NetSuite request.

**Implementation**:
- `NetSuiteGovernor.GenerateRequestKey()` creates a canonical hash of each query
- `NetSuiteGovernor.ExecuteAsync()` checks for in-flight requests with the same key
- Second (and subsequent) identical requests await the first request's result

**Where Enforced**: `NetSuiteGovernor.cs`, lines 87-106

**Test Scenario**: Drag-fill 100+ identical `XAVI.BALANCE` formulas → exactly 1 NetSuite query

```csharp
// From NetSuiteGovernor.cs - Request Deduplication
if (_inFlightRequests.TryGetValue(requestKey, out var existingTask))
{
    Interlocked.Increment(ref _deduplicatedRequests);
    _logger.LogDebug("Request deduplicated: {Key}", ...);
    return await existingTask;
}
```

---

### 2. Drag-Fill and Refresh All Never Trigger Per-Cell Queries

**Invariant**: Excel recalculation events that affect many cells MUST NOT result in per-cell NetSuite queries.

**Implementation**:
- Frontend batches requests in `processBatchQueue()` with a 500ms timer
- Backend `batch/balance` and `batch/full_year_refresh` endpoints handle multiple accounts/periods
- Governor deduplicates any identical queries that slip through

**Where Enforced**: 
- Frontend: `functions.js`, `processBatchQueue()`
- Backend: `BalanceController.cs`, batch endpoints
- Governor: `NetSuiteGovernor.cs`, deduplication

**Why This Matters**: A Refresh All on a 3000-formula sheet should result in ~10-50 NetSuite queries, not 3000.

---

### 3. SuiteQL Paging Always Exhausts All Pages

**Invariant**: Paginated queries MUST fetch all pages before returning results. Partial results are NEVER acceptable.

**Implementation**:
- `NetSuiteService.QueryPaginatedAsync()` loops until `pageResults.Count < pageSize`
- No early exits except for safety limits (which fail loudly)
- Sequential page fetching through the governor (no parallel page requests)

**Where Enforced**: `NetSuiteService.cs`, lines 143-186

**Test Scenario**: Query returning 1,500 rows → exactly 2 pages fetched → 1,500 rows returned

```csharp
// From NetSuiteService.cs - Guaranteed Pagination Completion
while (true)
{
    var pageResults = await QueryAsync<T>(paginatedQuery, timeout);
    
    if (pageResults.Count == 0) break;
    
    allResults.AddRange(pageResults);
    
    if (pageResults.Count < pageSize) break; // Last page
    
    offset += pageSize;
}
```

---

### 4. NetSuite Concurrency is Always Bounded

**Invariant**: Concurrent NetSuite requests MUST NOT exceed the configured limit (default: 3).

**Implementation**:
- `NetSuiteGovernor` uses a `SemaphoreSlim(_maxConcurrency)` to limit active requests
- All queries route through `_governor.ExecuteAsync()`
- Paging happens sequentially within a single semaphore slot

**Where Enforced**: `NetSuiteGovernor.cs`, lines 130-145

**Configuration**: `appsettings.json` → `NetSuite:MaxConcurrency` (default: 3)

```csharp
// From NetSuiteGovernor.cs - Concurrency Control
await _concurrencySemaphore.WaitAsync();
try
{
    // Only 3 concurrent requests allowed
    return await ExecuteWithRetryAsync(executeFunc, maxRetries);
}
finally
{
    _concurrencySemaphore.Release();
}
```

---

### 5. Refresh All is Deterministic

**Invariant**: Same inputs MUST produce same results, regardless of timing or load.

**Implementation**:
- Request deduplication ensures identical queries return identical results
- No random delays or jitter that could affect result ordering
- Caching ensures subsequent requests return same data within TTL

**Why This Matters**: Finance users expect consistent numbers. A Refresh All should not produce different results if run twice in quick succession.

---

### 6. Safety Limits Fail Loudly, Never Silently

**Invariant**: When a safety limit is hit, the system MUST return an explicit error. Silent truncation or partial results are NEVER acceptable.

**Safety Limits**:
| Limit | Value | Error When Hit |
|-------|-------|----------------|
| Max Rows | 100,000 | `SafetyLimitException(RowCapExceeded)` |
| Max Retries | 3 | `GovernedResult.SafetyLimitHit = MaxRetries` |
| Rate Limit | Sustained | `GovernedResult.SafetyLimitHit = RateLimitExceeded` |

**Error Codes for Excel Cells** (one-word, support-friendly):
| Code | Meaning | User Action |
|------|---------|-------------|
| `TIMEOUT` | Query took too long | Refresh fewer cells at once |
| `RATELIMIT` | NetSuite rate limit exceeded | Wait a moment, retry |
| `ROWCAP` | Too many rows (>100k) | Narrow date range or filters |
| `AUTHERR` | Authentication failed | Check credentials |
| `NETFAIL` | Network/connection error | Check internet connection |
| `QUERYERR` | SuiteQL syntax error | Report to support |
| `NOTFOUND` | Account/period not found | Verify account number |
| `SERVERERR` | Internal server error | Report to support |

**Implementation**:
- `SafetyLimitException` for row cap failures
- `GovernedResult.SafetyLimitHit` for governor failures
- Distinct logging with 🚨 prefix: `"🚨 SAFETY LIMIT HIT: ..."`

**Where Enforced**: 
- `NetSuiteService.cs`, pagination row cap
- `NetSuiteGovernor.cs`, retry and rate limit handling

```csharp
// From NetSuiteService.cs - Loud Failure on Row Cap
if (offset >= MaxTotalRows)
{
    _logger.LogError(
        "🚨 SAFETY LIMIT HIT: Row cap exceeded. " +
        "Type=RowCapExceeded, CurrentRows={CurrentRows}, MaxRows={MaxRows}",
        allResults.Count, MaxTotalRows);
    
    throw new SafetyLimitException(
        SafetyLimitType.RowCapExceeded,
        $"Query returned more than {MaxTotalRows:N0} rows. " +
        "Results may be incomplete. Please narrow your date range or add filters.",
        $"CurrentRows={allResults.Count}, MaxRows={MaxTotalRows}, Pages={pageNumber}");
}
```

---

## Monitoring & Metrics

The governor exposes metrics at `/metrics` endpoint:

```json
{
  "governor": {
    "totalRequests": 1234,
    "deduplicatedRequests": 456,
    "deduplicationRate": 36.9,
    "rateLimitErrors": 2,
    "retriedRequests": 5,
    "safetyLimitHits": 0,
    "currentConcurrency": 2,
    "maxConcurrency": 3,
    "inFlightRequests": 2,
    "isInBackoff": false
  }
}
```

**Key Metrics to Watch**:
- `deduplicationRate` > 30% on large worksheets = batching working correctly
- `safetyLimitHits` > 0 = investigate, these should be rare
- `rateLimitErrors` > 10 = consider reducing `MaxConcurrency`

---

## Testing Checklist

Before deploying changes, verify these scenarios:

- [ ] **Drag-fill 100 identical formulas** → 1 NetSuite query (check `deduplicatedRequests`)
- [ ] **Refresh All on 3000-formula sheet** → bounded concurrency, no timeouts
- [ ] **Query returning 1500 rows** → 2 pages fetched, 1500 rows returned
- [ ] **Simulated rate limit** → exponential backoff, eventual recovery
- [ ] **Row cap exceeded** → explicit error message, not silent truncation

---

## Code Locations

| Component | File | Key Functions |
|-----------|------|---------------|
| Governor | `Services/NetSuiteGovernor.cs` | `ExecuteAsync()`, `GenerateRequestKey()` |
| Pagination | `Services/NetSuiteService.cs` | `QueryPaginatedAsync()` |
| Batching | `Services/BalanceService.cs` | `GetBatchBalanceAsync()` |
| Safety Limits | `Services/NetSuiteGovernor.cs` | `SafetyLimitException` |
| Metrics | `Controllers/HealthController.cs` | `/metrics` endpoint |

---

## Adding New Formula Types

When adding a new formula type, ensure:

1. **Route through governor**: Use `_netSuiteService.QueryAsync()` or `QueryPaginatedAsync()`
2. **Support batching**: Accept multiple accounts/periods where possible
3. **Respect caching**: Use `GetOrSetCacheAsync()` for repeated lookups
4. **Document behavior**: Update this file if new invariants apply

---

*Last Updated: December 2024*
*Version: 1.0 (Performance Hardening Release)*

