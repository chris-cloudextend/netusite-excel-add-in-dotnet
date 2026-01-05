/*
 * XAVI for NetSuite - Lookup Service
 *
 * Copyright (c) 2025 Celigo, Inc.
 * All rights reserved.
 *
 * This service handles lookup queries for subsidiaries, departments,
 * classes, locations, accounts, and other reference data.
 */

using System;
using System.Text.Json;
using XaviApi.Models;

namespace XaviApi.Services;

/// <summary>
/// Service for lookup/reference data queries.
/// </summary>
public class LookupService : ILookupService
{
    private readonly INetSuiteService _netSuiteService;
    private readonly ILogger<LookupService> _logger;
    
    // Cache mapping accountingBookId -> list of valid subsidiary IDs
    // Built on startup from transaction data
    private readonly Dictionary<string, List<string>> _bookSubsidiaryCache = new();
    private readonly SemaphoreSlim _cacheLock = new(1, 1);
    private bool _cacheInitialized = false;

    public LookupService(INetSuiteService netSuiteService, ILogger<LookupService> logger)
    {
        _netSuiteService = netSuiteService;
        _logger = logger;
    }
    
    /// <summary>
    /// Initialize the accounting book to subsidiaries cache on startup.
    /// This builds a mapping from accountingBookId to valid subsidiary IDs
    /// based on transaction data (TransactionAccountingLine + Transaction).
    /// </summary>
    public async Task InitializeBookSubsidiaryCacheAsync()
    {
        await _cacheLock.WaitAsync();
        try
        {
            if (_cacheInitialized)
            {
                return; // Already initialized
            }
            
            _logger.LogInformation("Building accounting book to subsidiaries cache from transaction data...");
            
            // Query all distinct (accountingbook, subsidiary) pairs from accounting lines
            // This is an existence lookup - we only care about which combinations exist
            // Note: We use TransactionLine.subsidiary (not Transaction.subsidiary) because
            // TransactionLine has the correct subsidiary for each accounting line.
            // We include names via BUILTIN.DF for potential future use, but only use IDs for caching.
            // No ORDER BY needed - we sort in C# after building the cache for better performance.
            var query = @"
                SELECT DISTINCT
                    tal.accountingbook                     AS accountingbook_id,
                    BUILTIN.DF(tal.accountingbook)         AS accountingbook_name,
                    tl.subsidiary                          AS subsidiary_id,
                    BUILTIN.DF(tl.subsidiary)              AS subsidiary_name
                FROM
                    TransactionAccountingLine tal
                JOIN
                    TransactionLine tl
                        ON tl.transaction = tal.transaction
                       AND tl.id = tal.transactionline
                WHERE
                    tal.accountingbook IS NOT NULL
                    AND tl.subsidiary IS NOT NULL";
            
            _logger.LogInformation("📊 Executing cache query (timeout: 60s)...");
            var result = await _netSuiteService.QueryRawWithErrorAsync(query, timeout: 60);
            
            if (!result.Success)
            {
                _logger.LogError("❌ Failed to build book-subsidiary cache: {ErrorCode} - {ErrorDetails}", 
                    result.ErrorCode ?? "Unknown", 
                    result.ErrorDetails ?? "Unknown error");
                _cacheInitialized = true; // Mark as initialized to prevent retries
                return;
            }
            
            _logger.LogInformation("📊 Query returned {Count} rows", result.Items?.Count ?? 0);
            
            // Build the cache dictionary
            foreach (var item in result.Items)
            {
                // Use the new field names: accountingbook_id and subsidiary_id
                if (item.TryGetProperty("accountingbook_id", out var bookProp) &&
                    item.TryGetProperty("subsidiary_id", out var subProp))
                {
                    var bookId = bookProp.ToString();
                    var subId = subProp.ToString();
                    
                    if (!string.IsNullOrEmpty(bookId) && !string.IsNullOrEmpty(subId))
                    {
                        if (!_bookSubsidiaryCache.ContainsKey(bookId))
                        {
                            _bookSubsidiaryCache[bookId] = new List<string>();
                        }
                        
                        if (!_bookSubsidiaryCache[bookId].Contains(subId))
                        {
                            _bookSubsidiaryCache[bookId].Add(subId);
                        }
                    }
                }
            }
            
            // Sort subsidiary lists for consistency
            foreach (var bookId in _bookSubsidiaryCache.Keys.ToList())
            {
                _bookSubsidiaryCache[bookId] = _bookSubsidiaryCache[bookId]
                    .OrderBy(id => id)
                    .ToList();
            }
            
            var totalBooks = _bookSubsidiaryCache.Count;
            var totalMappings = _bookSubsidiaryCache.Values.Sum(list => list.Count);
            
            _logger.LogInformation("✅ Book-subsidiary cache built: {BookCount} books, {MappingCount} book-subsidiary mappings", 
                totalBooks, totalMappings);
            
            // Lightweight health log per book for debugging
            var healthLog = new List<string>();
            foreach (var kvp in _bookSubsidiaryCache.OrderBy(k => k.Key))
            {
                var subList = string.Join(", ", kvp.Value);
                healthLog.Add($"Book {kvp.Key} -> [{subList}]");
                _logger.LogDebug("  Book {BookId}: {Count} subsidiaries ({Subsidiaries})", 
                    kvp.Key, kvp.Value.Count, subList);
            }
            
            // Log health summary in a single line for easy scanning
            _logger.LogInformation("📊 Book-Subsidiary Health: {HealthSummary}", string.Join(" | ", healthLog));
            
            _cacheInitialized = true;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error building book-subsidiary cache");
            _cacheInitialized = true; // Mark as initialized to prevent retries
        }
        finally
        {
            _cacheLock.Release();
        }
    }

    /// <summary>
    /// Check if the book-subsidiary cache is ready.
    /// </summary>
    public async Task<bool> IsBookSubsidiaryCacheReadyAsync()
    {
        await _cacheLock.WaitAsync();
        try
        {
            return _cacheInitialized;
        }
        finally
        {
            _cacheLock.Release();
        }
    }

    /// <summary>
    /// Get all subsidiaries.
    /// For parent subsidiaries (those with children), also adds "(Consolidated)" versions.
    /// </summary>
    public async Task<List<SubsidiaryItem>> GetSubsidiariesAsync()
    {
        return await _netSuiteService.GetOrSetCacheAsync("lookups:subsidiaries", async () =>
        {
            // Note: 'elimination' field may not exist in all NetSuite accounts
            // Try querying with elimination first, fall back if it fails
            var query = @"
                SELECT s.id, s.name, s.fullname, s.parent, c.symbol as currency_symbol, c.name as currency_code
                FROM subsidiary s
                LEFT JOIN currency c ON s.currency = c.id
                WHERE s.isinactive = 'F'
                ORDER BY s.fullname";

            // Use QueryRawWithErrorAsync to get proper error information
            var queryResult = await _netSuiteService.QueryRawWithErrorAsync(query);
            
            if (!queryResult.Success)
            {
                _logger.LogError("Failed to query subsidiaries: {Error}", queryResult.ErrorCode);
                throw new Exception($"Subsidiary query failed: {queryResult.ErrorCode}");
            }
            
            var results = queryResult.Items ?? new List<JsonElement>();
            _logger.LogInformation("Subsidiary query returned {Count} results", results.Count);
            
            // Parse results - elimination field may not exist, so default to false
            var allSubs = results.Select(r => new SubsidiaryItem
            {
                Id = r.TryGetProperty("id", out var id) ? id.ToString() : "",
                Name = r.TryGetProperty("name", out var name) ? name.GetString() ?? "" : "",
                FullName = r.TryGetProperty("fullname", out var fn) ? fn.GetString() : null,
                Parent = r.TryGetProperty("parent", out var p) && p.ValueKind != JsonValueKind.Null ? p.ToString() : null,
                CurrencySymbol = r.TryGetProperty("currency_symbol", out var cs) ? cs.GetString() : null,
                Currency = r.TryGetProperty("currency_code", out var cc) ? cc.GetString() : null,
                // Elimination field doesn't exist in all NetSuite accounts - default to false
                // If needed, we can identify elimination subsidiaries by name pattern or other means
                IsElimination = false
            }).ToList(); // Don't filter by elimination since field doesn't exist
            
            // Identify parent subsidiaries (those that have children)
            var parentIds = new HashSet<string>(
                allSubs.Where(s => !string.IsNullOrEmpty(s.Parent))
                       .Select(s => s.Parent!)
            );
            
            // Calculate depth for each subsidiary
            int GetDepth(string subId)
            {
                int depth = 0;
                var current = allSubs.FirstOrDefault(s => s.Id == subId);
                while (current != null && !string.IsNullOrEmpty(current.Parent))
                {
                    depth++;
                    current = allSubs.FirstOrDefault(s => s.Id == current.Parent);
                }
                return depth;
            }
            
            // Build final list with consolidated versions for parents
            var finalList = new List<SubsidiaryItem>();
            foreach (var sub in allSubs)
            {
                sub.Depth = GetDepth(sub.Id);
                finalList.Add(sub);
                
                // If this is a parent, also add "(Consolidated)" version
                if (parentIds.Contains(sub.Id))
                {
                    finalList.Add(new SubsidiaryItem
                    {
                        Id = sub.Id,  // Same ID - BUILTIN.CONSOLIDATE handles consolidation
                        Name = $"{sub.Name} (Consolidated)",
                        FullName = sub.FullName != null ? $"{sub.FullName} (Consolidated)" : null,
                        Parent = sub.Parent,
                        CurrencySymbol = sub.CurrencySymbol,
                        Currency = sub.Currency,
                        Depth = sub.Depth,
                        IsConsolidated = true,
                        IsElimination = sub.IsElimination
                    });
                }
            }
            
            return finalList;
        }) ?? new List<SubsidiaryItem>();
    }

    /// <summary>
    /// Get all departments.
    /// </summary>
    public async Task<List<LookupItem>> GetDepartmentsAsync()
    {
        return await _netSuiteService.GetOrSetCacheAsync("lookups:departments", async () =>
        {
            var query = @"
                SELECT id, name, fullname, parent
                FROM department
                WHERE isinactive = 'F'
                ORDER BY fullname";

            var results = await _netSuiteService.QueryRawAsync(query);
            return results.Select(r => new LookupItem
            {
                Id = r.TryGetProperty("id", out var id) ? id.ToString() : "",
                Name = r.TryGetProperty("name", out var name) ? name.GetString() ?? "" : "",
                FullName = r.TryGetProperty("fullname", out var fn) ? fn.GetString() : null,
                Parent = r.TryGetProperty("parent", out var p) && p.ValueKind != JsonValueKind.Null ? p.ToString() : null
            }).ToList();
        }) ?? new List<LookupItem>();
    }

    /// <summary>
    /// Get all classes.
    /// </summary>
    public async Task<List<LookupItem>> GetClassesAsync()
    {
        return await _netSuiteService.GetOrSetCacheAsync("lookups:classes", async () =>
        {
            var query = @"
                SELECT id, name, fullname, parent
                FROM classification
                WHERE isinactive = 'F'
                ORDER BY fullname";

            var results = await _netSuiteService.QueryRawAsync(query);
            return results.Select(r => new LookupItem
            {
                Id = r.TryGetProperty("id", out var id) ? id.ToString() : "",
                Name = r.TryGetProperty("name", out var name) ? name.GetString() ?? "" : "",
                FullName = r.TryGetProperty("fullname", out var fn) ? fn.GetString() : null,
                Parent = r.TryGetProperty("parent", out var p) && p.ValueKind != JsonValueKind.Null ? p.ToString() : null
            }).ToList();
        }) ?? new List<LookupItem>();
    }

    /// <summary>
    /// Get all locations.
    /// </summary>
    public async Task<List<LookupItem>> GetLocationsAsync()
    {
        return await _netSuiteService.GetOrSetCacheAsync("lookups:locations", async () =>
        {
            var query = @"
                SELECT id, name, fullname, parent
                FROM location
                WHERE isinactive = 'F'
                ORDER BY fullname";

            var results = await _netSuiteService.QueryRawAsync(query);
            return results.Select(r => new LookupItem
            {
                Id = r.TryGetProperty("id", out var id) ? id.ToString() : "",
                Name = r.TryGetProperty("name", out var name) ? name.GetString() ?? "" : "",
                FullName = r.TryGetProperty("fullname", out var fn) ? fn.GetString() : null,
                Parent = r.TryGetProperty("parent", out var p) && p.ValueKind != JsonValueKind.Null ? p.ToString() : null
            }).ToList();
        }) ?? new List<LookupItem>();
    }

    /// <summary>
    /// Get all subsidiaries that have transactions in the given accounting book.
    /// Returns a list of subsidiary IDs. For Primary Book (ID 1), returns null to indicate all subsidiaries.
    /// 
    /// This method uses the pre-built cache from transaction data (built on startup).
    /// A subsidiary is valid for a book if at least one accounting line exists for that (book, subsidiary) pair.
    /// </summary>
    public async Task<List<string>?> GetSubsidiariesForAccountingBookAsync(string accountingBookId)
    {
        if (string.IsNullOrEmpty(accountingBookId) || accountingBookId == "1")
        {
            // Primary Book (ID 1) is typically associated with all subsidiaries
            // Return null to indicate all subsidiaries are valid
            return null;
        }

        // Ensure cache is initialized
        if (!_cacheInitialized)
        {
            await InitializeBookSubsidiaryCacheAsync();
        }
        
        // Look up in cache (thread-safe read)
        await _cacheLock.WaitAsync();
        try
        {
            if (_bookSubsidiaryCache.TryGetValue(accountingBookId, out var subsidiaries))
            {
                _logger.LogDebug("Book {BookId} has {Count} valid subsidiaries from cache: {Subsidiaries}", 
                    accountingBookId, subsidiaries.Count, string.Join(", ", subsidiaries));
                return new List<string>(subsidiaries); // Return a copy
            }
            else
            {
                // Book has no subsidiaries with postings
                _logger.LogWarning("No subsidiaries found for accounting book {BookId} (no transactions exist for this book)", 
                    accountingBookId);
                return new List<string>(); // Return empty list
            }
        }
        finally
        {
            _cacheLock.Release();
        }
    }

    /// <summary>
    /// Get the most common subsidiary associated with an accounting book.
    /// This is determined by querying transactions to find which subsidiary
    /// has the most transactions for the given accounting book.
    /// Returns null if no clear relationship exists (e.g., Primary Book).
    /// </summary>
    public async Task<string?> GetSubsidiaryForAccountingBookAsync(string accountingBookId)
    {
        if (string.IsNullOrEmpty(accountingBookId) || accountingBookId == "1")
        {
            // Primary Book (ID 1) is typically associated with all subsidiaries
            // Return null to indicate no specific subsidiary (use current filter)
            return null;
        }

        var cacheKey = $"lookups:accountingbook:{accountingBookId}:subsidiary";
        return await _netSuiteService.GetOrSetCacheAsync(cacheKey, async () =>
        {
            // Query to find the most common subsidiary for this accounting book
            // by counting transactions grouped by subsidiary
            var query = $@"
                SELECT 
                    tl.subsidiary AS id,
                    COUNT(*) AS transaction_count
                FROM TransactionAccountingLine tal
                JOIN TransactionLine tl ON tal.transactionline = tl.id
                WHERE tal.accountingbook = {NetSuiteService.EscapeSql(accountingBookId)}
                  AND tl.subsidiary IS NOT NULL
                GROUP BY tl.subsidiary
                ORDER BY transaction_count DESC
                FETCH FIRST 1 ROWS ONLY";

            var result = await _netSuiteService.QueryRawWithErrorAsync(query);
            
            if (!result.Success || !result.Items.Any())
            {
                _logger.LogWarning("Could not find subsidiary for accounting book {BookId}", accountingBookId);
                return null;
            }

            var row = result.Items.First();
            var subsidiaryId = row.TryGetProperty("id", out var idProp) ? idProp.ToString() : null;
            
            if (!string.IsNullOrEmpty(subsidiaryId))
            {
                // Get subsidiary name for logging
                var subsidiary = await GetSubsidiariesAsync();
                var subItem = subsidiary.FirstOrDefault(s => s.Id == subsidiaryId);
                var subName = subItem?.Name ?? $"ID {subsidiaryId}";
                _logger.LogInformation("Accounting book {BookId} is associated with subsidiary {SubId} ({SubName})", 
                    accountingBookId, subsidiaryId, subName);
            }

            return subsidiaryId;
        }, TimeSpan.FromHours(24)); // Cache for 24 hours since this relationship rarely changes
    }

    /// <summary>
    /// Get book-scoped subsidiaries following NetSuite's deterministic rules.
    /// Only subsidiaries explicitly enabled for the book are returned.
    /// Hierarchy is recomputed using only enabled subsidiaries.
    /// Consolidation eligibility is determined based on whether parent and children are both enabled.
    /// </summary>
    public async Task<BookScopedSubsidiariesResponse> GetBookScopedSubsidiariesAsync(string accountingBookId)
    {
        if (string.IsNullOrEmpty(accountingBookId) || accountingBookId == "1")
        {
            // Primary Book - all subsidiaries are valid
            return new BookScopedSubsidiariesResponse
            {
                AllSubsidiaries = true,
                Subsidiaries = new List<SubsidiaryDisplayItem>(),
                IsSingleSubsidiaryBook = false
            };
        }

        var cacheKey = $"lookups:accountingbook:{accountingBookId}:bookscoped";
        return await _netSuiteService.GetOrSetCacheAsync(cacheKey, async () =>
        {
            // Step 1: Get enabled subsidiaries for this book
            var enabledSubsidiaryIds = await GetSubsidiariesForAccountingBookAsync(accountingBookId);
            
            if (enabledSubsidiaryIds == null || enabledSubsidiaryIds.Count == 0)
            {
                // No subsidiaries enabled - return empty response
                _logger.LogWarning("No subsidiaries enabled for accounting book {BookId}", accountingBookId);
                return new BookScopedSubsidiariesResponse
                {
                    AllSubsidiaries = false,
                    Subsidiaries = new List<SubsidiaryDisplayItem>(),
                    IsSingleSubsidiaryBook = false
                };
            }
            
            // Step 2: Get all subsidiaries (for hierarchy lookup)
            var allSubsidiaries = await GetSubsidiariesAsync();
            
            // Step 3: Filter to ONLY enabled subsidiaries
            var enabledSubsidiaries = allSubsidiaries
                .Where(s => enabledSubsidiaryIds.Contains(s.Id))
                .ToList();
            
            if (enabledSubsidiaries.Count == 0)
            {
                _logger.LogWarning("No matching subsidiaries found for enabled IDs");
                return new BookScopedSubsidiariesResponse
                {
                    AllSubsidiaries = false,
                    Subsidiaries = new List<SubsidiaryDisplayItem>(),
                    IsSingleSubsidiaryBook = false
                };
            }
            
            // Step 4: Recompute hierarchy using ONLY enabled subsidiaries
            // Build parent-child relationships within the enabled set
            var enabledSubsidiarySet = new HashSet<string>(enabledSubsidiaryIds);
            var childrenMap = new Dictionary<string, List<SubsidiaryItem>>();
            
            foreach (var sub in enabledSubsidiaries)
            {
                // Find parent, but only if parent is also enabled
                if (!string.IsNullOrEmpty(sub.Parent) && enabledSubsidiarySet.Contains(sub.Parent))
                {
                    if (!childrenMap.ContainsKey(sub.Parent))
                    {
                        childrenMap[sub.Parent] = new List<SubsidiaryItem>();
                    }
                    childrenMap[sub.Parent].Add(sub);
                }
            }
            
            // Step 5: Determine consolidation eligibility
            // A subsidiary can be consolidated if:
            // - It is enabled (already filtered)
            // - It has at least one child in the enabled set
            var consolidationEligible = new HashSet<string>();
            foreach (var sub in enabledSubsidiaries)
            {
                if (childrenMap.ContainsKey(sub.Id) && childrenMap[sub.Id].Count > 0)
                {
                    consolidationEligible.Add(sub.Id);
                }
            }
            
            // Step 6: Handle single-subsidiary books (Rule 5)
            if (enabledSubsidiaryIds.Count == 1)
            {
                var singleSub = enabledSubsidiaries.First();
                var hasChildren = childrenMap.ContainsKey(singleSub.Id) && childrenMap[singleSub.Id].Count > 0;
                
                if (!hasChildren)
                {
                    // Leaf node - return only this subsidiary, no consolidation
                    return new BookScopedSubsidiariesResponse
                    {
                        AllSubsidiaries = false,
                        Subsidiaries = new List<SubsidiaryDisplayItem>
                        {
                            new SubsidiaryDisplayItem
                            {
                                Id = singleSub.Id,
                                Name = singleSub.Name,
                                FullName = singleSub.FullName,
                                CanConsolidate = false,
                                IsLeaf = true
                            }
                        },
                        IsSingleSubsidiaryBook = true
                    };
                }
            }
            
            // Step 7: Build response with consolidation flags
            var displayItems = enabledSubsidiaries.Select(s => new SubsidiaryDisplayItem
            {
                Id = s.Id,
                Name = s.Name,
                FullName = s.FullName,
                CanConsolidate = consolidationEligible.Contains(s.Id),
                IsLeaf = !childrenMap.ContainsKey(s.Id) || childrenMap[s.Id].Count == 0
            }).OrderBy(s => s.Name).ToList();
            
            return new BookScopedSubsidiariesResponse
            {
                AllSubsidiaries = false,
                Subsidiaries = displayItems,
                IsSingleSubsidiaryBook = enabledSubsidiaryIds.Count == 1 && !consolidationEligible.Any()
            };
        }, TimeSpan.FromHours(24)); // Cache for 24 hours
    }

    /// <summary>
    /// Get the default subsidiary for an accounting book based on NetSuite-compatible rules.
    /// 
    /// Rules:
    /// 1. If current subsidiary is in enabled set S, keep it unchanged
    /// 2. Otherwise, find all subsidiaries in S that have at least one child also in S
    /// 3. Select the highest-level parent (closest to root) as default
    /// 4. If no parent with children, select using deterministic ordering (lowest ID)
    /// </summary>
    public async Task<string?> GetDefaultSubsidiaryForAccountingBookAsync(string accountingBookId, string? currentSubsidiaryId = null)
    {
        if (string.IsNullOrEmpty(accountingBookId) || accountingBookId == "1")
        {
            // Primary Book - no default needed
            return null;
        }

        // Step 1: Build set S of enabled subsidiaries
        var enabledSubsidiaryIds = await GetSubsidiariesForAccountingBookAsync(accountingBookId);
        
        if (enabledSubsidiaryIds == null || enabledSubsidiaryIds.Count == 0)
        {
            _logger.LogWarning("No enabled subsidiaries for accounting book {BookId}, cannot determine default", accountingBookId);
            return null;
        }

        var enabledSet = new HashSet<string>(enabledSubsidiaryIds);

        // Step 2: If current subsidiary is in S, keep it unchanged
        if (!string.IsNullOrEmpty(currentSubsidiaryId) && enabledSet.Contains(currentSubsidiaryId))
        {
            _logger.LogInformation("Current subsidiary {SubId} is enabled for book {BookId}, keeping it", 
                currentSubsidiaryId, accountingBookId);
            return currentSubsidiaryId;
        }

        // Step 3: Get all subsidiaries to build hierarchy
        var allSubsidiaries = await GetSubsidiariesAsync();
        var enabledSubsidiaries = allSubsidiaries
            .Where(s => enabledSet.Contains(s.Id))
            .ToList();

        // Build parent-child map within enabled set only
        var childrenMap = new Dictionary<string, List<SubsidiaryItem>>();
        foreach (var sub in enabledSubsidiaries)
        {
            if (!string.IsNullOrEmpty(sub.Parent) && enabledSet.Contains(sub.Parent))
            {
                if (!childrenMap.ContainsKey(sub.Parent))
                {
                    childrenMap[sub.Parent] = new List<SubsidiaryItem>();
                }
                childrenMap[sub.Parent].Add(sub);
            }
        }

        // Step 4: Find all subsidiaries in S that have at least one child also in S
        var parentsWithChildren = enabledSubsidiaries
            .Where(s => childrenMap.ContainsKey(s.Id) && childrenMap[s.Id].Count > 0)
            .ToList();

        if (parentsWithChildren.Count > 0)
        {
            // Step 5: Select highest-level parent (closest to root)
            // Calculate depth for each parent (distance from root)
            int GetDepth(string subId)
            {
                int depth = 0;
                var current = enabledSubsidiaries.FirstOrDefault(s => s.Id == subId);
                while (current != null && !string.IsNullOrEmpty(current.Parent) && enabledSet.Contains(current.Parent))
                {
                    depth++;
                    current = enabledSubsidiaries.FirstOrDefault(s => s.Id == current.Parent);
                }
                return depth;
            }

            // Find parent with minimum depth (closest to root)
            var highestLevelParent = parentsWithChildren
                .OrderBy(s => GetDepth(s.Id))
                .ThenBy(s => s.Id) // Deterministic tie-breaker
                .First();

            _logger.LogInformation("Selected highest-level parent subsidiary {SubId} ({SubName}) for book {BookId} (has {ChildCount} enabled children)", 
                highestLevelParent.Id, highestLevelParent.Name, accountingBookId, childrenMap[highestLevelParent.Id].Count);
            
            return highestLevelParent.Id;
        }

        // Step 6: No parent with children - select using deterministic ordering (lowest ID)
        var defaultSub = enabledSubsidiaries
            .OrderBy(s => s.Id)
            .First();

        _logger.LogInformation("No parent with children found for book {BookId}, selected subsidiary {SubId} ({SubName}) using deterministic ordering", 
            accountingBookId, defaultSub.Id, defaultSub.Name);

        return defaultSub.Id;
    }

    /// <summary>
    /// Get all accounting books.
    /// </summary>
    public async Task<List<AccountingBookItem>> GetAccountingBooksAsync()
    {
        return await _netSuiteService.GetOrSetCacheAsync("lookups:accountingbooks", async () =>
        {
            // Try direct AccountingBook table query first (without isinactive filter - field doesn't exist)
            var query = @"
                SELECT id, name, isprimary
                FROM AccountingBook
                ORDER BY isprimary DESC, name";

            var result = await _netSuiteService.QueryRawWithErrorAsync(query);
            
            // If direct query fails, fall back to getting distinct books from transactions
            if (!result.Success)
            {
                _logger.LogWarning("Direct AccountingBook query failed: {Error}, trying fallback approach", result.ErrorCode);
                
                // Fallback: Get distinct accounting books from TransactionAccountingLine
                var fallbackQuery = @"
                    SELECT DISTINCT tal.accountingbook AS id
                    FROM TransactionAccountingLine tal
                    WHERE tal.accountingbook IS NOT NULL";
                
                var fallbackResult = await _netSuiteService.QueryRawWithErrorAsync(fallbackQuery);
                if (!fallbackResult.Success)
                {
                    _logger.LogError("Fallback accounting books query also failed: {Error}", fallbackResult.ErrorCode);
                    // Return at least Primary Book (ID 1) as default
                    return new List<AccountingBookItem>
                    {
                        new AccountingBookItem { Id = "1", Name = "Primary Book (Primary)", IsPrimary = true }
                    };
                }
                
                // Build book list from transaction data
                var books = new List<AccountingBookItem>();
                foreach (var r in fallbackResult.Items ?? new List<JsonElement>())
                {
                    var bookId = r.TryGetProperty("id", out var idProp) ? idProp.ToString() : "";
                    if (string.IsNullOrEmpty(bookId)) continue;
                    
                    // ID 1 is always Primary Book in NetSuite
                    var isPrimary = bookId == "1";
                    var bookName = isPrimary ? "Primary Book" : $"Book {bookId}";
                    
                    books.Add(new AccountingBookItem
                    {
                        Id = bookId,
                        Name = isPrimary ? $"{bookName} (Primary)" : bookName,
                        IsPrimary = isPrimary
                    });
                }
                
                // Ensure Primary Book is included
                if (!books.Any(b => b.Id == "1"))
                {
                    books.Insert(0, new AccountingBookItem 
                    { 
                        Id = "1", 
                        Name = "Primary Book (Primary)", 
                        IsPrimary = true 
                    });
                }
                
                _logger.LogInformation("Retrieved {Count} accounting books from transactions (fallback)", books.Count);
                return books;
            }

            // Direct query succeeded - parse results
            var directBooks = new List<AccountingBookItem>();
            foreach (var r in result.Items ?? new List<JsonElement>())
            {
                var id = r.TryGetProperty("id", out var idProp) ? idProp.ToString() : "";
                var name = r.TryGetProperty("name", out var nameProp) ? nameProp.GetString() ?? "" : "";
                
                // Parse isprimary - NetSuite returns "T"/"F" strings
                var isPrimary = false;
                if (r.TryGetProperty("isprimary", out var ipProp))
                {
                    if (ipProp.ValueKind == System.Text.Json.JsonValueKind.String)
                    {
                        isPrimary = ipProp.GetString()?.Equals("T", StringComparison.OrdinalIgnoreCase) == true;
                    }
                    else if (ipProp.ValueKind == System.Text.Json.JsonValueKind.True)
                    {
                        isPrimary = true;
                    }
                }

                // Mark primary book for clarity (match Python backend behavior)
                var displayName = name;
                if (isPrimary && !name.Contains("(Primary)"))
                {
                    displayName = $"{name} (Primary)";
                }

                directBooks.Add(new AccountingBookItem
                {
                    Id = id,
                    Name = displayName,
                    IsPrimary = isPrimary
                });
            }

            _logger.LogInformation("Retrieved {Count} accounting books", directBooks.Count);
            return directBooks;
        }) ?? new List<AccountingBookItem>();
    }

    /// <summary>
    /// Get budget categories.
    /// </summary>
    public async Task<List<BudgetCategoryItem>> GetBudgetCategoriesAsync()
    {
        return await _netSuiteService.GetOrSetCacheAsync("lookups:budgetcategories", async () =>
        {
            var query = @"
                SELECT id, name
                FROM budgetcategory
                WHERE isinactive = 'F'
                ORDER BY name";

            var results = await _netSuiteService.QueryRawAsync(query);
            return results.Select(r => new BudgetCategoryItem
            {
                Id = r.TryGetProperty("id", out var id) ? id.ToString() : "",
                Name = r.TryGetProperty("name", out var name) ? name.GetString() ?? "" : ""
            }).ToList();
        }) ?? new List<BudgetCategoryItem>();
    }

    /// <summary>
    /// Get all lookups at once.
    /// </summary>
    public async Task<AllLookupsResponse> GetAllLookupsAsync()
    {
        var subsidiaries = GetSubsidiariesAsync();
        var departments = GetDepartmentsAsync();
        var classes = GetClassesAsync();
        var locations = GetLocationsAsync();
        var books = GetAccountingBooksAsync();
        var categories = GetBudgetCategoriesAsync();

        await Task.WhenAll(subsidiaries, departments, classes, locations, books, categories);

        return new AllLookupsResponse
        {
            Subsidiaries = await subsidiaries,
            Departments = await departments,
            Classes = await classes,
            Locations = await locations,
            AccountingBooks = await books,
            BudgetCategories = await categories
        };
    }

    /// <summary>
    /// Get account name by account number.
    /// </summary>
    public async Task<string?> GetAccountNameAsync(string accountNumber)
    {
        var cacheKey = $"account:name:{accountNumber}";
        return await _netSuiteService.GetOrSetCacheAsync(cacheKey, async () =>
        {
            var query = $@"
                SELECT accountsearchdisplayname
                FROM account
                WHERE acctnumber = '{NetSuiteService.EscapeSql(accountNumber)}'
                FETCH FIRST 1 ROWS ONLY";

            var results = await _netSuiteService.QueryRawAsync(query);
            if (results.Any())
            {
                var row = results.First();
                return row.TryGetProperty("accountsearchdisplayname", out var name) ? name.GetString() : null;
            }
            return null;
        });
    }

    /// <summary>
    /// Get account type by account number.
    /// </summary>
    public async Task<string?> GetAccountTypeAsync(string accountNumber)
    {
        var cacheKey = $"account:type:{accountNumber}";
        return await _netSuiteService.GetOrSetCacheAsync(cacheKey, async () =>
        {
            var query = $@"
                SELECT accttype
                FROM account
                WHERE acctnumber = '{NetSuiteService.EscapeSql(accountNumber)}'
                FETCH FIRST 1 ROWS ONLY";

            var results = await _netSuiteService.QueryRawAsync(query);
            if (results.Any())
            {
                var row = results.First();
                return row.TryGetProperty("accttype", out var type) ? type.GetString() : null;
            }
            return null;
        });
    }

    /// <summary>
    /// Get account parent by account number.
    /// </summary>
    public async Task<string?> GetAccountParentAsync(string accountNumber)
    {
        var query = $@"
            SELECT p.acctnumber as parent_number
            FROM account a
            LEFT JOIN account p ON a.parent = p.id
            WHERE a.acctnumber = '{NetSuiteService.EscapeSql(accountNumber)}'
            FETCH FIRST 1 ROWS ONLY";

        var results = await _netSuiteService.QueryRawAsync(query);
        if (results.Any())
        {
            var row = results.First();
            // Check if parent_number exists and is not null
            if (row.TryGetProperty("parent_number", out var parentProp) && 
                parentProp.ValueKind != JsonValueKind.Null)
            {
                var parentValue = parentProp.GetString();
                // Return null for empty strings (account has no parent)
                return string.IsNullOrEmpty(parentValue) ? null : parentValue;
            }
        }
        return null;
    }

    /// <summary>
    /// Search accounts by number or type.
    /// </summary>
    public async Task<List<AccountItem>> SearchAccountsAsync(string? number = null, string? type = null)
    {
        var conditions = new List<string> { "a.isinactive = 'F'" };

        if (!string.IsNullOrEmpty(number))
        {
            // Support wildcards: "4*" becomes LIKE '4%', "*income*" becomes LIKE '%income%'
            // Also support "*" alone to return all accounts
            var pattern = number.Replace("*", "%");
            if (!pattern.Contains('%')) pattern += "%";  // Add trailing % if no wildcard
            conditions.Add($"a.acctnumber LIKE '{NetSuiteService.EscapeSql(pattern)}'");
        }

        if (!string.IsNullOrEmpty(type))
            // Case-insensitive account type matching - allows "income" or "Income"
            conditions.Add($"UPPER(a.accttype) = UPPER('{NetSuiteService.EscapeSql(type)}')");

        // Note: Don't include ORDER BY - QueryPaginatedAsync adds it
        var query = $@"
            SELECT a.id, a.acctnumber, a.accountsearchdisplayname as name, a.fullname, a.accttype, a.sspecacct, p.acctnumber as parent
            FROM account a
            LEFT JOIN account p ON a.parent = p.id
            WHERE {string.Join(" AND ", conditions)}";

        var results = await _netSuiteService.QueryPaginatedAsync<JsonElement>(query, orderBy: "a.acctnumber");
        return results.Select(r => new AccountItem
        {
            Id = r.TryGetProperty("id", out var id) ? id.ToString() : "",
            Number = r.TryGetProperty("acctnumber", out var num) ? num.GetString() ?? "" : "",
            Name = r.TryGetProperty("name", out var name) ? name.GetString() ?? "" : "",
            FullName = r.TryGetProperty("fullname", out var fn) ? fn.GetString() : null,
            Type = r.TryGetProperty("accttype", out var type2) ? type2.GetString() ?? "" : "",
            SpecialAccountType = r.TryGetProperty("sspecacct", out var spec) && spec.ValueKind != JsonValueKind.Null ? spec.GetString() : null,
            Parent = r.TryGetProperty("parent", out var p) && p.ValueKind != JsonValueKind.Null ? p.GetString() : null
        }).ToList();
    }

    /// <summary>
    /// Get all account titles for preloading cache.
    /// </summary>
    public async Task<Dictionary<string, string>> GetAllAccountTitlesAsync()
    {
        // Note: Don't include ORDER BY here - QueryPaginatedAsync adds it
        var query = @"
            SELECT acctnumber, accountsearchdisplaynamecopy as account_name
            FROM Account
            WHERE isinactive = 'F'";

        var results = await _netSuiteService.QueryPaginatedAsync<JsonElement>(query, orderBy: "acctnumber");
        var titles = new Dictionary<string, string>();

        foreach (var r in results)
        {
            var acctnumber = r.TryGetProperty("acctnumber", out var num) ? num.GetString() ?? "" : "";
            var name = r.TryGetProperty("account_name", out var n) ? n.GetString() ?? "" : "";
            if (!string.IsNullOrEmpty(acctnumber))
                titles[acctnumber] = name;
        }

        return titles;
    }

    /// <summary>
    /// Resolve subsidiary name to ID.
    /// Handles "(Consolidated)" suffix by stripping it and looking up base subsidiary.
    /// </summary>
    public async Task<string?> ResolveSubsidiaryIdAsync(string? subsidiaryNameOrId)
    {
        if (string.IsNullOrEmpty(subsidiaryNameOrId))
            return null;

        // If it's already a numeric ID, return it
        if (int.TryParse(subsidiaryNameOrId, out _))
            return subsidiaryNameOrId;

        // Strip "(Consolidated)" suffix - the ID is the same
        var lookupName = subsidiaryNameOrId.Trim();
        if (lookupName.EndsWith(" (Consolidated)", StringComparison.OrdinalIgnoreCase))
        {
            lookupName = lookupName[..^15].Trim(); // Remove " (Consolidated)"
            _logger.LogDebug("Stripped '(Consolidated)' suffix → looking up '{Name}'", lookupName);
        }

        // Get all subsidiaries and find match
        var subsidiaries = await GetSubsidiariesAsync();
        var match = subsidiaries.FirstOrDefault(s => 
            s.Name.Equals(lookupName, StringComparison.OrdinalIgnoreCase) ||
            (s.FullName?.Equals(lookupName, StringComparison.OrdinalIgnoreCase) ?? false));

        if (match != null)
        {
            _logger.LogDebug("Resolved subsidiary '{Name}' → ID {Id}", subsidiaryNameOrId, match.Id);
            return match.Id;
        }

        _logger.LogWarning("Could not resolve subsidiary: {Name}", subsidiaryNameOrId);
        return null;
    }

    /// <summary>
    /// Get all subsidiary IDs in the hierarchy (including children) for a given subsidiary.
    /// Used for consolidated queries where we need to include all child subsidiaries.
    /// </summary>
    public async Task<List<string>> GetSubsidiaryHierarchyAsync(string subsidiaryId)
    {
        var hierarchy = new List<string> { subsidiaryId };
        var subsidiaries = await GetSubsidiariesAsync();

        // Build a map of parent -> children
        var childrenMap = new Dictionary<string, List<string>>();
        foreach (var sub in subsidiaries)
        {
            if (!string.IsNullOrEmpty(sub.Parent))
            {
                if (!childrenMap.ContainsKey(sub.Parent))
                    childrenMap[sub.Parent] = new List<string>();
                childrenMap[sub.Parent].Add(sub.Id);
            }
        }

        // BFS to find all descendants
        var queue = new Queue<string>();
        queue.Enqueue(subsidiaryId);

        while (queue.Count > 0)
        {
            var current = queue.Dequeue();
            if (childrenMap.TryGetValue(current, out var children))
            {
                foreach (var child in children)
                {
                    if (!hierarchy.Contains(child))
                    {
                        hierarchy.Add(child);
                        queue.Enqueue(child);
                    }
                }
            }
        }

        _logger.LogDebug("Subsidiary {Id} hierarchy: {Hierarchy}", subsidiaryId, string.Join(", ", hierarchy));
        return hierarchy;
    }

    /// <summary>
    /// Resolve any dimension (subsidiary, department, class, location) name to ID.
    /// </summary>
    public async Task<string?> ResolveDimensionIdAsync(string dimensionType, string? nameOrId)
    {
        if (string.IsNullOrEmpty(nameOrId))
            return null;

        // If it's already a numeric ID, return it
        if (int.TryParse(nameOrId, out _))
            return nameOrId;

        var lookupName = nameOrId.Trim();
        
        // For subsidiaries, handle "(Consolidated)" suffix
        if (dimensionType == "subsidiary" && lookupName.EndsWith(" (Consolidated)", StringComparison.OrdinalIgnoreCase))
        {
            lookupName = lookupName[..^15].Trim();
        }

        List<LookupItem>? items = null;
        switch (dimensionType.ToLower())
        {
            case "subsidiary":
                var subsidiaries = await GetSubsidiariesAsync();
                var subMatch = subsidiaries.FirstOrDefault(s =>
                    s.Name.Equals(lookupName, StringComparison.OrdinalIgnoreCase) ||
                    (s.FullName?.Equals(lookupName, StringComparison.OrdinalIgnoreCase) ?? false));
                return subMatch?.Id;
            case "department":
                items = await GetDepartmentsAsync();
                break;
            case "class":
                items = await GetClassesAsync();
                break;
            case "location":
                items = await GetLocationsAsync();
                break;
        }

        if (items != null)
        {
            var match = items.FirstOrDefault(i =>
                i.Name.Equals(lookupName, StringComparison.OrdinalIgnoreCase) ||
                (i.FullName?.Equals(lookupName, StringComparison.OrdinalIgnoreCase) ?? false));
            return match?.Id;
        }

        return null;
    }

    /// <summary>
    /// Get all ancestor subsidiaries (parent chain upward) for a given subsidiary.
    /// Used to find valid consolidation roots.
    /// </summary>
    public async Task<List<string>> GetSubsidiaryAncestorsAsync(string subsidiaryId)
    {
        var ancestors = new List<string>();
        var subsidiaries = await GetSubsidiariesAsync();
        
        // Resolve subsidiary ID if it's a name (e.g., "Celigo Inc. (Consolidated)")
        var resolvedId = await ResolveSubsidiaryIdAsync(subsidiaryId);
        if (string.IsNullOrEmpty(resolvedId))
        {
            resolvedId = subsidiaryId; // Fallback to original if resolution fails
        }
        
        // Build a map for quick lookup
        // Handle duplicate IDs (consolidated versions have same ID) by taking first occurrence
        var subMap = subsidiaries
            .GroupBy(s => s.Id)
            .ToDictionary(g => g.Key, g => g.First());
        
        // Traverse parent chain upward
        var current = subMap.GetValueOrDefault(resolvedId);
        while (current != null && !string.IsNullOrEmpty(current.Parent))
        {
            if (subMap.TryGetValue(current.Parent, out var parent))
            {
                ancestors.Add(parent.Id);
                current = parent;
            }
            else
            {
                break; // Parent not found (shouldn't happen, but safe)
            }
        }
        
        _logger.LogDebug("Subsidiary {Id} (resolved: {ResolvedId}) ancestors: {Ancestors}", 
            subsidiaryId, resolvedId, string.Join(", ", ancestors));
        return ancestors;
    }

    /// <summary>
    /// Resolve currency code to a valid consolidation root subsidiary using ConsolidatedExchangeRate table.
    /// The ConsolidatedExchangeRate table is the source of truth for what consolidation paths NetSuite actually supports.
    /// This is more reliable than walking parent chains because:
    /// - Rates only exist for subsidiary pairs NetSuite has calculated
    /// - The table includes derived (multi-hop) rates that are pre-calculated
    /// - Self-referential entries exist (tosubsidiary = fromsubsidiary) for base currency scenarios
    /// - It automatically excludes invalid paths
    /// 
    /// Strategy:
    /// 1. First check if filtered subsidiary itself has the requested currency (self-referential)
    /// 2. Query ConsolidatedExchangeRate for direct paths from filtered subsidiary
    /// 3. If not found, check parent subsidiaries in hierarchy for matching currency
    /// </summary>
    public async Task<string?> ResolveCurrencyToConsolidationRootAsync(string currencyCode, string filteredSubsidiaryId)
    {
        // Resolve filtered subsidiary ID if it's a name
        var resolvedFilteredId = await ResolveSubsidiaryIdAsync(filteredSubsidiaryId);
        if (string.IsNullOrEmpty(resolvedFilteredId))
        {
            resolvedFilteredId = filteredSubsidiaryId;
        }
        
        var subsidiaries = await GetSubsidiariesAsync();
        var subMap = subsidiaries
            .GroupBy(s => s.Id)
            .ToDictionary(g => g.Key, g => g.First());
        
        // Step 1: Check if filtered subsidiary itself has the requested currency
        if (subMap.TryGetValue(resolvedFilteredId, out var filteredSub) &&
            !string.IsNullOrEmpty(filteredSub.Currency) &&
            filteredSub.Currency.Equals(currencyCode, StringComparison.OrdinalIgnoreCase) &&
            !filteredSub.IsElimination)
        {
            _logger.LogInformation("Resolved currency {Currency} to filtered subsidiary itself {SubId} ({SubName}) - base currency match",
                currencyCode, filteredSub.Id, filteredSub.Name);
            return filteredSub.Id;
        }
        
        // Step 2: Query ConsolidatedExchangeRate table for direct consolidation path
        var query = $@"
            SELECT 
                cer.tosubsidiary AS consolidationRootId,
                s.name AS consolidationRootName,
                c.symbol AS currency,
                c.id AS currencyId
            FROM ConsolidatedExchangeRate cer
            JOIN Subsidiary s ON s.id = cer.tosubsidiary
            JOIN Currency c ON c.id = s.currency
            WHERE cer.fromsubsidiary = {NetSuiteService.EscapeSql(resolvedFilteredId)}
              AND UPPER(c.symbol) = UPPER('{NetSuiteService.EscapeSql(currencyCode)}')
              AND s.iselimination = 'F'
            FETCH FIRST 1 ROWS ONLY";
        
        try
        {
            var result = await _netSuiteService.QueryRawAsync(query);
            
            if (result.Any())
            {
                var row = result.First();
                var consolidationRootId = row.TryGetProperty("consolidationRootId", out var rootIdProp) 
                    ? rootIdProp.GetString() ?? "" : "";
                var consolidationRootName = row.TryGetProperty("consolidationRootName", out var rootNameProp) 
                    ? rootNameProp.GetString() ?? "" : "";
                
                if (!string.IsNullOrEmpty(consolidationRootId))
                {
                    _logger.LogInformation("Resolved currency {Currency} to consolidation root {SubId} ({SubName}) for filtered subsidiary {FilteredSubId} via ConsolidatedExchangeRate",
                        currencyCode, consolidationRootId, consolidationRootName, resolvedFilteredId);
                    return consolidationRootId;
                }
            }
            
            // Step 3: If no direct path in ConsolidatedExchangeRate, check parent hierarchy
            // This handles cases where ConsolidatedExchangeRate might not have all paths
            var ancestors = await GetSubsidiaryAncestorsAsync(resolvedFilteredId);
            var validRoots = subsidiaries
                .Where(s => !string.IsNullOrEmpty(s.Currency) && 
                           s.Currency.Equals(currencyCode, StringComparison.OrdinalIgnoreCase) &&
                           ancestors.Contains(s.Id) &&
                           !s.IsElimination)
                .OrderBy(s => s.Depth) // Prefer higher-level subsidiaries (lower depth)
                .ToList();
            
            if (validRoots.Any())
            {
                var root = validRoots.First();
                _logger.LogInformation("Resolved currency {Currency} to ancestor {SubId} ({SubName}, depth={Depth}) for filtered subsidiary {FilteredSubId} via hierarchy (ConsolidatedExchangeRate had no direct path)",
                    currencyCode, root.Id, root.Name, root.Depth, resolvedFilteredId);
                return root.Id;
            }
            
            _logger.LogWarning("No valid consolidation path found for currency {Currency} from subsidiary {FilteredSubId}. Checked: (1) self, (2) ConsolidatedExchangeRate, (3) ancestor hierarchy",
                currencyCode, resolvedFilteredId);
            return null;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error querying ConsolidatedExchangeRate for currency {Currency} and subsidiary {FilteredSubId}",
                currencyCode, resolvedFilteredId);
            return null;
        }
    }

    /// <summary>
    /// Get available currencies for dropdown.
    /// If subsidiaryId provided, return only currencies valid for that subsidiary.
    /// Otherwise, return currencies valid for at least one subsidiary.
    /// </summary>
    public async Task<List<CurrencyItem>> GetCurrenciesAsync(string? subsidiaryId = null)
    {
        var cacheKey = subsidiaryId != null 
            ? $"lookups:currencies:sub:{subsidiaryId}"
            : "lookups:currencies:all";
        
        return await _netSuiteService.GetOrSetCacheAsync(cacheKey, async () =>
        {
            var subsidiaries = await GetSubsidiariesAsync();
            _logger.LogInformation("GetCurrenciesAsync: Found {Count} subsidiaries", subsidiaries.Count);
            
            if (subsidiaries.Count == 0)
            {
                _logger.LogWarning("No subsidiaries found - cannot determine valid currencies");
                return new List<CurrencyItem>();
            }
            
            var validCurrencies = new HashSet<string>();
            
            if (!string.IsNullOrEmpty(subsidiaryId))
            {
                // Get currencies valid for this specific subsidiary
                // Find the subsidiary and its ancestors, then get all currencies from those subsidiaries
                var ancestors = await GetSubsidiaryAncestorsAsync(subsidiaryId);
                
                // Include the subsidiary itself and all its ancestors
                var relevantSubIds = new HashSet<string> { subsidiaryId };
                foreach (var ancestorId in ancestors)
                {
                    relevantSubIds.Add(ancestorId);
                }
                
                // Get all currencies from relevant subsidiaries
                var validRoots = subsidiaries
                    .Where(s => relevantSubIds.Contains(s.Id) && 
                               !s.IsElimination && 
                               !string.IsNullOrEmpty(s.Currency))
                    .Select(s => s.Currency!)
                    .Distinct();
                
                foreach (var currency in validRoots)
                {
                    validCurrencies.Add(currency);
                }
                
                _logger.LogInformation("GetCurrenciesAsync for subsidiary {SubId}: Found {Count} valid currencies", 
                    subsidiaryId, validCurrencies.Count);
            }
            else
            {
                // Get all currencies that are valid consolidation roots for at least one subsidiary
                foreach (var sub in subsidiaries.Where(s => !s.IsElimination && !string.IsNullOrEmpty(s.Currency)))
                {
                    // Check if this currency is a valid consolidation root for any subsidiary
                    var ancestors = await GetSubsidiaryAncestorsAsync(sub.Id);
                    var hasValidRoot = subsidiaries.Any(s => 
                        ancestors.Contains(s.Id) && 
                        !s.IsElimination && 
                        s.Currency == sub.Currency);
                    
                    if (hasValidRoot)
                    {
                        validCurrencies.Add(sub.Currency!);
                    }
                }
            }
            
            // Query currency details
            if (!validCurrencies.Any())
            {
                return new List<CurrencyItem>();
            }
            
            var currencyCodes = string.Join(", ", validCurrencies.Select(c => $"'{NetSuiteService.EscapeSql(c)}'"));
            // Try to get displayname field - if it doesn't exist, it will be null
            var query = $@"
                SELECT id, name, symbol, displayname
                FROM currency
                WHERE name IN ({currencyCodes})
                ORDER BY name";
            
            var results = await _netSuiteService.QueryRawAsync(query);
            return results.Select(r => new CurrencyItem
            {
                Id = r.TryGetProperty("id", out var id) ? id.ToString() : "",
                Name = r.TryGetProperty("name", out var name) ? name.GetString() ?? "" : "",
                Symbol = r.TryGetProperty("symbol", out var symbol) ? symbol.GetString() ?? "" : "",
                DisplayName = r.TryGetProperty("displayname", out var displayName) ? displayName.GetString() : null
            }).ToList();
        }) ?? new List<CurrencyItem>();
    }
}

/// <summary>
/// Interface for lookup service (for DI and testing).
/// </summary>
public interface ILookupService
{
    Task<List<SubsidiaryItem>> GetSubsidiariesAsync();
    Task<List<LookupItem>> GetDepartmentsAsync();
    Task<List<LookupItem>> GetClassesAsync();
    Task<List<LookupItem>> GetLocationsAsync();
    Task<string?> GetSubsidiaryForAccountingBookAsync(string accountingBookId);
    Task<List<AccountingBookItem>> GetAccountingBooksAsync();
    Task<List<BudgetCategoryItem>> GetBudgetCategoriesAsync();
    Task<List<string>> GetSubsidiaryAncestorsAsync(string subsidiaryId);
    Task<string?> ResolveCurrencyToConsolidationRootAsync(string currencyCode, string filteredSubsidiaryId);
    Task<List<CurrencyItem>> GetCurrenciesAsync(string? subsidiaryId = null);
    Task<AllLookupsResponse> GetAllLookupsAsync();
    Task<string?> GetAccountNameAsync(string accountNumber);
    Task<string?> GetAccountTypeAsync(string accountNumber);
    Task<string?> GetAccountParentAsync(string accountNumber);
    Task<List<AccountItem>> SearchAccountsAsync(string? number = null, string? type = null);
    Task<Dictionary<string, string>> GetAllAccountTitlesAsync();
    Task<string?> ResolveSubsidiaryIdAsync(string? subsidiaryNameOrId);
    Task<List<string>> GetSubsidiaryHierarchyAsync(string subsidiaryId);
    Task<string?> ResolveDimensionIdAsync(string dimensionType, string? nameOrId);
    Task<List<string>?> GetSubsidiariesForAccountingBookAsync(string accountingBookId);
    Task<BookScopedSubsidiariesResponse> GetBookScopedSubsidiariesAsync(string accountingBookId);
    
    /// <summary>
    /// Get the default subsidiary for an accounting book based on NetSuite-compatible rules.
    /// </summary>
    Task<string?> GetDefaultSubsidiaryForAccountingBookAsync(string accountingBookId, string? currentSubsidiaryId = null);
}

