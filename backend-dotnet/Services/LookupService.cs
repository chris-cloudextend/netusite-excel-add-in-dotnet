/*
 * XAVI for NetSuite - Lookup Service
 *
 * Copyright (c) 2025 Celigo, Inc.
 * All rights reserved.
 *
 * This service handles lookup queries for subsidiaries, departments,
 * classes, locations, accounts, and other reference data.
 */

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

    public LookupService(INetSuiteService netSuiteService, ILogger<LookupService> logger)
    {
        _netSuiteService = netSuiteService;
        _logger = logger;
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
    /// Get all accounting books.
    /// </summary>
    public async Task<List<AccountingBookItem>> GetAccountingBooksAsync()
    {
        return await _netSuiteService.GetOrSetCacheAsync("lookups:accountingbooks", async () =>
        {
            var query = @"
                SELECT id, name, isprimary
                FROM accountingbook
                WHERE isinactive = 'F'
                ORDER BY isprimary DESC, name";

            var results = await _netSuiteService.QueryRawAsync(query);
            return results.Select(r => new AccountingBookItem
            {
                Id = r.TryGetProperty("id", out var id) ? id.ToString() : "",
                Name = r.TryGetProperty("name", out var name) ? name.GetString() ?? "" : "",
                IsPrimary = r.TryGetProperty("isprimary", out var ip) && ip.GetString() == "T"
            }).ToList();
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
            conditions.Add($"a.accttype = '{NetSuiteService.EscapeSql(type)}'");

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
    /// Resolve currency code to a valid consolidation root subsidiary.
    /// Consolidation root must: match currency, be ancestor of filtered subsidiary, not be elimination.
    /// </summary>
    public async Task<string?> ResolveCurrencyToConsolidationRootAsync(string currencyCode, string filteredSubsidiaryId)
    {
        var subsidiaries = await GetSubsidiariesAsync();
        var ancestors = await GetSubsidiaryAncestorsAsync(filteredSubsidiaryId);
        
        // Find subsidiaries with matching currency that are ancestors
        var validRoots = subsidiaries
            .Where(s => !string.IsNullOrEmpty(s.Currency) && 
                       s.Currency.Equals(currencyCode, StringComparison.OrdinalIgnoreCase) &&
                       ancestors.Contains(s.Id) &&
                       !s.IsElimination)
            .OrderBy(s => s.Depth) // Prefer closer ancestors (lower depth = higher in hierarchy)
            .ToList();
        
        if (validRoots.Any())
        {
            var root = validRoots.First();
            _logger.LogInformation("Resolved currency {Currency} to consolidation root {SubId} ({SubName}) for filtered subsidiary {FilteredSubId}",
                currencyCode, root.Id, root.Name, filteredSubsidiaryId);
            return root.Id;
        }
        
        _logger.LogWarning("Could not resolve currency {Currency} to valid consolidation root for subsidiary {SubId}",
            currencyCode, filteredSubsidiaryId);
        return null;
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
                var ancestors = await GetSubsidiaryAncestorsAsync(subsidiaryId);
                var validRoots = subsidiaries
                    .Where(s => ancestors.Contains(s.Id) && 
                               !s.IsElimination && 
                               !string.IsNullOrEmpty(s.Currency))
                    .Select(s => s.Currency!)
                    .Distinct();
                
                foreach (var currency in validRoots)
                {
                    validCurrencies.Add(currency);
                }
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
            var query = $@"
                SELECT id, name, symbol
                FROM currency
                WHERE name IN ({currencyCodes})
                ORDER BY name";
            
            var results = await _netSuiteService.QueryRawAsync(query);
            return results.Select(r => new CurrencyItem
            {
                Id = r.TryGetProperty("id", out var id) ? id.ToString() : "",
                Name = r.TryGetProperty("name", out var name) ? name.GetString() ?? "" : "",
                Symbol = r.TryGetProperty("symbol", out var symbol) ? symbol.GetString() ?? "" : ""
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
}

