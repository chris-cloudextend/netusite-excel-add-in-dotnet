using System;
using System.Collections.Generic;
using System.Linq;

/// <summary>
/// Test harness for SearchAccountsByPatternAsync logic validation.
/// This simulates the WHERE clause generation without requiring NetSuite.
/// </summary>
public class AccountSearchTestHarness
{
    public static string EscapeSql(string input)
    {
        if (string.IsNullOrEmpty(input)) return input;
        return input.Replace("'", "''");
    }

    public static (string searchType, List<string> conditions, string whereClause) GenerateWhereClause(string pattern, bool activeOnly = true)
    {
        // Normalize input once
        var normalizedInput = (pattern ?? "").Trim().ToLowerInvariant();
        
        var conditions = new List<string>();
        var matchedTypes = new List<string>();
        string searchType;

        // Explicit intent detection in exact order (case-insensitive)
        if (normalizedInput == "income")
        {
            // Income statement accounts
            searchType = "income_statement";
            var incomeTypes = new[] { "Income", "OthIncome", "Expense", "OthExpense", "COGS" };
            matchedTypes.AddRange(incomeTypes);
            var escapedTypes = incomeTypes.Select(t => $"'{EscapeSql(t)}'");
            conditions.Add($"a.accttype IN ({string.Join(",", escapedTypes)})");
        }
        else if (normalizedInput == "balance")
        {
            // Balance sheet accounts
            searchType = "balance_sheet";
            var balanceTypes = new[] { "Bank", "AcctRec", "OthCurrAsset", "FixedAsset", "OthAsset", "AcctPay", "CredCard", "OthCurrLiab", "LongTermLiab", "Equity" };
            matchedTypes.AddRange(balanceTypes);
            var escapedTypes = balanceTypes.Select(t => $"'{EscapeSql(t)}'");
            conditions.Add($"a.accttype IN ({string.Join(",", escapedTypes)})");
        }
        else if (normalizedInput == "bank")
        {
            // Bank accounts only
            searchType = "bank_accounts";
            matchedTypes.Add("Bank");
            conditions.Add("a.accttype = 'Bank'");
        }
        else if (normalizedInput == "" || normalizedInput == "*")
        {
            // All active accounts - no type filter
            searchType = "all_active";
        }
        else
        {
            // Name or account number search
            searchType = "name_or_number";
            
            // Escape the pattern for SQL LIKE
            var escapedPattern = EscapeSql(normalizedInput);
            var sqlPattern = $"%{escapedPattern}%";
            
            // Search both account name and account number
            conditions.Add($"(LOWER(a.accountsearchdisplaynamecopy) LIKE LOWER('{sqlPattern}') OR a.acctnumber LIKE '{sqlPattern}')");
        }

        // Base filter: always include active status
        if (activeOnly)
        {
            conditions.Add("a.isinactive = 'F'");
        }
        
        // Validate: must have at least one condition (active filter counts)
        if (conditions.Count == 0)
        {
            throw new InvalidOperationException($"ERROR: No WHERE conditions generated for pattern '{pattern}'");
        }
        
        // Build WHERE clause
        var whereClause = string.Join(" AND ", conditions);
        
        return (searchType, conditions, whereClause);
    }

    public static void RunTests()
    {
        var testCases = new[]
        {
            "income",
            "Income",
            "balance",
            "Bank",
            "bank",
            "*",
            "",
            "100",
            "cash"
        };

        Console.WriteLine("=".PadRight(100, '='));
        Console.WriteLine("ACCOUNT SEARCH QA TEST HARNESS");
        Console.WriteLine("=".PadRight(100, '='));
        Console.WriteLine();

        var results = new List<(string input, string searchType, string whereClause, bool hasImpossiblePredicate, string validation)>();

        foreach (var testInput in testCases)
        {
            try
            {
                var (searchType, conditions, whereClause) = GenerateWhereClause(testInput);
                
                // Check for impossible predicates
                bool hasImpossiblePredicate = whereClause.Contains("= ''") || 
                                             whereClause.Contains("LIKE ''") ||
                                             whereClause.Contains("LIKE '%'") && !whereClause.Contains("LIKE '%cash%") && !whereClause.Contains("LIKE '%100%");
                
                // Validate WHERE clause
                string validation = "✅ PASS";
                if (hasImpossiblePredicate)
                    validation = "❌ FAIL: Contains impossible predicate";
                else if (conditions.Count == 0 && searchType != "all_active")
                    validation = "❌ FAIL: No conditions generated";
                else if (searchType == "all_active" && !whereClause.Contains("isinactive = 'F'"))
                    validation = "❌ FAIL: Missing active filter";
                else if (searchType == "income_statement" && !whereClause.Contains("accttype IN"))
                    validation = "❌ FAIL: Missing income type filter";
                else if (searchType == "balance_sheet" && !whereClause.Contains("accttype IN"))
                    validation = "❌ FAIL: Missing balance sheet type filter";
                else if (searchType == "bank_accounts" && !whereClause.Contains("accttype = 'Bank'"))
                    validation = "❌ FAIL: Missing bank type filter";
                else if (searchType == "name_or_number" && !whereClause.Contains("LIKE"))
                    validation = "❌ FAIL: Missing LIKE pattern";

                results.Add((testInput, searchType, whereClause, hasImpossiblePredicate, validation));
                
                Console.WriteLine($"Input: '{testInput}'");
                Console.WriteLine($"  Search Type: {searchType}");
                Console.WriteLine($"  WHERE Clause: {whereClause}");
                Console.WriteLine($"  Validation: {validation}");
                Console.WriteLine();
            }
            catch (Exception ex)
            {
                results.Add((testInput, "ERROR", ex.Message, true, "❌ FAIL: Exception"));
                Console.WriteLine($"Input: '{testInput}'");
                Console.WriteLine($"  ERROR: {ex.Message}");
                Console.WriteLine();
            }
        }

        // QA Summary Table
        Console.WriteLine("=".PadRight(100, '='));
        Console.WriteLine("QA SUMMARY TABLE");
        Console.WriteLine("=".PadRight(100, '='));
        Console.WriteLine();
        Console.WriteLine($"{"Input",-15} {"Search Mode",-20} {"Has Impossible Predicate",-25} {"Validation",-15}");
        Console.WriteLine("-".PadRight(100, '-'));
        
        foreach (var (input, searchType, whereClause, hasImpossible, validation) in results)
        {
            Console.WriteLine($"{input,-15} {searchType,-20} {hasImpossible.ToString(),-25} {validation,-15}");
        }
        
        Console.WriteLine();
        Console.WriteLine("=".PadRight(100, '='));
        
        // Verify failure modes
        Console.WriteLine("FAILURE MODE VERIFICATION");
        Console.WriteLine("=".PadRight(100, '='));
        
        var emptyTest = results.FirstOrDefault(r => r.input == "");
        var wildcardTest = results.FirstOrDefault(r => r.input == "*");
        var incomeTest = results.FirstOrDefault(r => r.input.ToLower() == "income");
        var balanceTest = results.FirstOrDefault(r => r.input.ToLower() == "balance");
        var bankTest = results.FirstOrDefault(r => r.input.ToLower() == "bank");
        
        Console.WriteLine($"Empty input generates name/number filter: {(emptyTest.searchType == "all_active" ? "❌ NO (correct)" : "✅ YES (wrong)")}");
        Console.WriteLine($"Wildcard input collapses to empty predicate: {(wildcardTest.searchType == "all_active" ? "❌ NO (correct)" : "✅ YES (wrong)")}");
        Console.WriteLine($"Income search mode: {incomeTest.searchType} (expected: income_statement)");
        Console.WriteLine($"Balance search mode: {balanceTest.searchType} (expected: balance_sheet)");
        Console.WriteLine($"Bank search mode: {bankTest.searchType} (expected: bank_accounts)");
        
        var allPass = results.All(r => !r.hasImpossiblePredicate && r.validation == "✅ PASS");
        Console.WriteLine();
        Console.WriteLine($"All tests pass: {(allPass ? "✅ YES" : "❌ NO")}");
    }

    public static void Main()
    {
        RunTests();
    }
}

