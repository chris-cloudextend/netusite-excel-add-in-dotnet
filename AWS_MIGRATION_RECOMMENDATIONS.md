# AWS Migration Recommendations for XAVI Backend

## Overview

This document outlines recommended changes when migrating the XAVI for NetSuite backend from the current Cloudflare Tunnel (development) to AWS (production).

---

## 1. Timeout Configuration (CRITICAL)

### Current Issue
- Cloudflare Tunnel has a ~100 second timeout (non-configurable)
- Balance Sheet preload takes 60-90 seconds per period
- Results in 524 "Gateway Timeout" errors

### AWS Solution

| AWS Service | Recommended Timeout | Configuration |
|-------------|-------------------|---------------|
| **API Gateway** | 300 seconds | `timeout_milliseconds: 300000` |
| **ALB** | 300 seconds | `idle_timeout.timeout_seconds: 300` |
| **Lambda** (if used) | 180 seconds | `timeout: 180` in function config |
| **ECS Task** | No limit | Container keeps running |

### Code Changes After AWS Migration

Once on AWS with proper timeouts, you can **optionally** revert to parallel period loading for better performance:

```javascript
// Current (sequential, for Cloudflare):
for (const period of periods) {
    await fetch('/batch/bs_preload', { body: { periods: [period] } });
}

// After AWS (parallel, faster):
await fetch('/batch/bs_preload', { body: { periods: periods } });  // Both at once
```

**Performance comparison:**
- Sequential (current): ~140 seconds for 2 periods
- Parallel (AWS): ~90 seconds for 2 periods

---

## 2. Environment Configuration

### Current (Development)
```
Cloudflare Worker → Cloudflare Tunnel → localhost:5002
```

### Recommended (Production)
```
CloudFront → API Gateway → ALB → ECS/EC2
    OR
CloudFront → ALB → ECS/EC2 directly
```

### Environment Variables to Update

| Variable | Dev Value | Production Value |
|----------|-----------|------------------|
| `ASPNETCORE_ENVIRONMENT` | `Development` | `Production` |
| `ASPNETCORE_URLS` | `http://localhost:5002` | `http://0.0.0.0:80` |
| Logging Level | `Debug` | `Warning` or `Information` |

### AWS Secrets Manager

Move sensitive credentials from `appsettings.Development.json` to AWS Secrets Manager:

```json
{
  "NetSuite:ConsumerKey": "...",
  "NetSuite:ConsumerSecret": "...",
  "NetSuite:TokenId": "...",
  "NetSuite:TokenSecret": "...",
  "NetSuite:AccountId": "...",
  "NetSuite:Realm": "..."
}
```

---

## 3. CORS Configuration

### Current (Development)
```csharp
builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
    {
        policy.WithOrigins(
            "https://chris-cloudextend.github.io",
            "https://localhost:3000",
            "null"  // Office Add-in iframe
        )
        .AllowAnyHeader()
        .AllowAnyMethod();
    });
});
```

### Production Changes

Update to production domains:
```csharp
builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
    {
        policy.WithOrigins(
            "https://your-production-domain.com",
            "https://cdn.office.net",  // Office Add-in CDN
            "null"  // Office Add-in iframe
        )
        .AllowAnyHeader()
        .AllowAnyMethod();
    });
});
```

---

## 4. Health Check & Monitoring

### Add AWS-Compatible Health Check

The current `/health` endpoint is good. Ensure it returns quickly for ALB health checks:

```csharp
[HttpGet("/health")]
public IActionResult HealthCheck()
{
    return Ok(new { 
        status = "healthy",
        timestamp = DateTime.UtcNow,
        version = "3.0.5.237"
    });
}
```

### CloudWatch Integration

Add structured logging for CloudWatch:

```csharp
// In Program.cs
builder.Logging.AddAWSProvider(configuration);

// Or use Serilog with CloudWatch sink
builder.Host.UseSerilog((context, config) =>
{
    config.WriteTo.Console()
          .WriteTo.AmazonCloudWatch(...);
});
```

### Recommended CloudWatch Alarms

| Metric | Threshold | Action |
|--------|-----------|--------|
| 5XX Error Rate | > 1% | Alert |
| Latency P99 | > 120s | Alert |
| CPU Utilization | > 80% | Scale Out |
| Memory Utilization | > 80% | Alert |

---

## 5. Caching Improvements

### Current State
- In-memory caching (MemoryCache) - lost on restart
- 5-minute TTL for balance data

### Production Recommendations

#### Option A: ElastiCache (Redis)
```csharp
// Replace MemoryCache with Redis
services.AddStackExchangeRedisCache(options =>
{
    options.Configuration = "your-elasticache-endpoint:6379";
});
```

**Benefits:**
- Survives restarts
- Shared across multiple instances
- Can handle larger datasets

#### Option B: DynamoDB (for persistence)
Use for account titles and lookup data that changes rarely.

---

## 6. Scaling Configuration

### Recommended ECS Configuration

```yaml
# task-definition.json
{
  "cpu": "512",
  "memory": "1024",
  "containerDefinitions": [{
    "healthCheck": {
      "command": ["CMD-SHELL", "curl -f http://localhost/health || exit 1"],
      "interval": 30,
      "timeout": 5,
      "retries": 3
    }
  }]
}
```

### Auto-Scaling Policy

```yaml
# Scale based on request count
TargetTrackingScaling:
  TargetValue: 100  # requests per target
  ScaleOutCooldown: 60
  ScaleInCooldown: 300
```

---

## 7. Security Hardening

### Remove Debug Endpoints

Before production, consider removing or protecting:
- `/test-query` - Direct SuiteQL execution
- `/test-internal-query` - Internal testing
- `/metrics` - Detailed governor metrics

Or add authentication:
```csharp
[Authorize(Roles = "Admin")]
[HttpGet("/test-query")]
public async Task<IActionResult> TestQuery(...) { }
```

### Rate Limiting

Add AWS WAF or application-level rate limiting:
```csharp
services.AddRateLimiter(options =>
{
    options.AddFixedWindowLimiter("api", opt =>
    {
        opt.PermitLimit = 100;
        opt.Window = TimeSpan.FromMinutes(1);
    });
});
```

---

## 8. Frontend (Excel Add-in) Changes

### Update Manifest

Change the API URL in the Excel Add-in manifest:

```xml
<!-- Current (dev) -->
<bt:Url id="API.Url" DefaultValue="https://your-cloudflare-worker.workers.dev"/>

<!-- Production -->
<bt:Url id="API.Url" DefaultValue="https://api.your-domain.com"/>
```

### Update functions.js

```javascript
// Change SERVER_URL based on environment
const SERVER_URL = window.location.hostname.includes('localhost')
    ? 'http://localhost:5002'
    : 'https://api.your-production-domain.com';
```

---

## 9. Deployment Checklist

### Pre-Deployment
- [ ] Update CORS origins for production domain
- [ ] Move secrets to AWS Secrets Manager
- [ ] Update `ASPNETCORE_ENVIRONMENT` to `Production`
- [ ] Configure ALB/API Gateway timeouts (300s)
- [ ] Set up CloudWatch logging
- [ ] Remove or protect debug endpoints

### Post-Deployment
- [ ] Verify health check endpoint responds
- [ ] Test BS preload completes without timeout
- [ ] Test BALANCECHANGE formula with 2 periods
- [ ] Verify CORS allows Office Add-in requests
- [ ] Monitor CloudWatch for errors

### Optional Optimizations
- [ ] Re-enable parallel period loading (if timeouts are resolved)
- [ ] Add ElastiCache for distributed caching
- [ ] Set up auto-scaling policies

---

## 10. Rollback Plan

If issues occur after migration:

1. **Immediate**: Switch DNS/CloudFront back to Cloudflare Worker
2. **Keep Cloudflare Worker running** for 48 hours after migration
3. **Test production** with a subset of users first (beta group)

---

## Summary of Changes by Priority

| Priority | Change | Effort | Impact |
|----------|--------|--------|--------|
| **P0** | Configure 300s timeout on ALB/API Gateway | Low | Eliminates timeout errors |
| **P0** | Update CORS for production domain | Low | Required for add-in to work |
| **P0** | Move secrets to Secrets Manager | Medium | Security requirement |
| **P1** | Add CloudWatch logging | Medium | Observability |
| **P1** | Set up health check alarms | Low | Reliability |
| **P2** | Add ElastiCache | High | Performance at scale |
| **P2** | Re-enable parallel loading | Low | 35% faster preload |
| **P3** | Remove debug endpoints | Low | Security |

---

*Last Updated: December 2024*
*Version: 3.0.5.237*

