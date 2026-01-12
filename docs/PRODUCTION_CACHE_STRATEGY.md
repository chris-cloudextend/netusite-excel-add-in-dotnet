# Production Cache Strategy for Book-Subsidiary Mapping

## Current Implementation (Development)

The current implementation uses an **in-memory cache** that is built on each server instance startup:

- **Pros**: Simple, fast, no external dependencies
- **Cons**: 
  - Cache is rebuilt on every server restart
  - Each instance has its own cache (wasteful in multi-instance deployments)
  - Cache is lost if server crashes
  - Not suitable for horizontal scaling

## Production Requirements

For AWS deployment with thousands of customers, we need:

1. **Distributed Cache**: Shared across all instances
2. **High Availability**: Cache survives server restarts
3. **Performance**: Fast lookups (< 10ms)
4. **Cost Efficiency**: Minimal infrastructure overhead
5. **Scalability**: Handle thousands of concurrent requests

## Recommended Solutions

### Option 1: AWS ElastiCache (Redis) - **RECOMMENDED**

**Implementation:**
- Use Redis cluster for distributed caching
- Cache key format: `book-subsidiary:{accountingBookId}` → `[subsidiaryId1, subsidiaryId2, ...]`
- TTL: 24 hours (refresh daily via scheduled job)
- Fallback: Query NetSuite if cache miss

**Pros:**
- Fast (< 1ms lookups)
- Highly available (multi-AZ)
- Scales automatically
- Industry standard

**Cons:**
- Additional AWS service cost (~$15-50/month for small cluster)
- Requires Redis client library

**Cost Estimate:**
- `cache.t3.micro` (single node): ~$15/month
- `cache.t3.small` (HA): ~$30/month
- Suitable for thousands of customers

### Option 2: DynamoDB - **ALTERNATIVE**

**Implementation:**
- Table: `BookSubsidiaryCache`
- Partition key: `accountingBookId`
- Attribute: `subsidiaryIds` (List of strings)
- TTL: 24 hours

**Pros:**
- Serverless (no infrastructure management)
- Pay-per-use pricing
- Built-in TTL support
- Highly available

**Cons:**
- Slightly slower than Redis (~5-10ms)
- More expensive at scale

**Cost Estimate:**
- First 25GB free, then $0.25/GB/month
- ~$5-20/month for typical usage

### Option 3: Database-Backed Cache (PostgreSQL/MySQL)

**Implementation:**
- Table: `book_subsidiary_cache`
- Columns: `accounting_book_id`, `subsidiary_ids` (JSON array)
- Refresh via scheduled job

**Pros:**
- No additional infrastructure
- Can reuse existing database

**Cons:**
- Slower than Redis (~10-20ms)
- Database load increases
- Not ideal for high-frequency lookups

## Recommended Migration Path

### Phase 1: Current (Development)
- In-memory cache on startup
- Works for single-instance development

### Phase 2: Production MVP (Option 2 - DynamoDB)
- Migrate to DynamoDB for simplicity
- No infrastructure management
- Easy to implement

### Phase 3: Scale (Option 1 - Redis)
- Migrate to ElastiCache when traffic increases
- Better performance for high-volume scenarios

## Implementation Code Changes Needed

### For Redis (ElastiCache):

```csharp
// Add NuGet: StackExchange.Redis
public class RedisBookSubsidiaryCache
{
    private readonly IDatabase _redis;
    
    public async Task<List<string>?> GetSubsidiariesForBookAsync(string bookId)
    {
        var key = $"book-subsidiary:{bookId}";
        var cached = await _redis.StringGetAsync(key);
        if (cached.HasValue)
        {
            return JsonSerializer.Deserialize<List<string>>(cached);
        }
        return null; // Cache miss - query NetSuite
    }
    
    public async Task SetSubsidiariesForBookAsync(string bookId, List<string> subsidiaryIds)
    {
        var key = $"book-subsidiary:{bookId}";
        var json = JsonSerializer.Serialize(subsidiaryIds);
        await _redis.StringSetAsync(key, json, TimeSpan.FromHours(24));
    }
}
```

### For DynamoDB:

```csharp
// Add NuGet: AWSSDK.DynamoDBv2
public class DynamoBookSubsidiaryCache
{
    private readonly IAmazonDynamoDB _dynamoDb;
    private const string TableName = "BookSubsidiaryCache";
    
    public async Task<List<string>?> GetSubsidiariesForBookAsync(string bookId)
    {
        var request = new GetItemRequest
        {
            TableName = TableName,
            Key = new Dictionary<string, AttributeValue>
            {
                { "accountingBookId", new AttributeValue { S = bookId } }
            }
        };
        
        var response = await _dynamoDb.GetItemAsync(request);
        if (response.Item.ContainsKey("subsidiaryIds"))
        {
            return response.Item["subsidiaryIds"].L.Select(x => x.S).ToList();
        }
        return null;
    }
}
```

## Cache Refresh Strategy

### Scheduled Job (AWS Lambda or ECS Task)

Run daily at 2 AM UTC:

```csharp
// Refresh all book-subsidiary mappings
public async Task RefreshCacheAsync()
{
    var query = @"
        SELECT DISTINCT
            tal.accountingbook AS accountingbook_id,
            tl.subsidiary AS subsidiary_id
        FROM TransactionAccountingLine tal
        JOIN TransactionLine tl ON tl.transaction = tal.transaction AND tl.id = tal.transactionline
        WHERE tal.accountingbook IS NOT NULL AND tl.subsidiary IS NOT NULL";
    
    var result = await _netSuiteService.QueryRawWithErrorAsync(query);
    
    // Update cache for each book
    foreach (var book in result.Items.GroupBy(x => x["accountingbook_id"]))
    {
        var subsidiaries = book.Select(x => x["subsidiary_id"].ToString()).Distinct().ToList();
        await _cache.SetSubsidiariesForBookAsync(book.Key, subsidiaries);
    }
}
```

## Monitoring & Alerts

- **Cache Hit Rate**: Should be > 95%
- **Cache Miss Latency**: Track NetSuite query time on cache misses
- **Cache Size**: Monitor memory/table size
- **Refresh Job Status**: Alert if daily refresh fails

## Migration Checklist

- [ ] Choose cache solution (Redis or DynamoDB)
- [ ] Add cache client library to project
- [ ] Implement cache interface abstraction
- [ ] Update `LookupService` to use distributed cache
- [ ] Add cache refresh scheduled job
- [ ] Add monitoring/alerting
- [ ] Test with production-like load
- [ ] Deploy to staging
- [ ] Monitor for 1 week
- [ ] Deploy to production

