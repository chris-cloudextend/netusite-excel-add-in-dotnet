/*
 * Quick test to query NetSuite balance directly
 * Run with: dotnet run --project XaviApi.csproj -- QueryBalanceTest
 */

using System;
using System.Threading.Tasks;
using XaviApi.Services;
using XaviApi.Configuration;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace XaviApi;

public class QueryBalanceTest
{
    public static async Task RunAsync(string[] args)
    {
        // Build configuration
        var configuration = new ConfigurationBuilder()
            .SetBasePath(Directory.GetCurrentDirectory())
            .AddJsonFile("appsettings.json", optional: false)
            .AddJsonFile("appsettings.Development.json", optional: true)
            .AddEnvironmentVariables()
            .Build();

        // Setup services
        var services = new ServiceCollection();
        services.AddSingleton<IConfiguration>(configuration);
        services.AddLogging(builder => builder.AddConsole().SetMinimumLevel(LogLevel.Information));
        
        // Register NetSuite config
        services.Configure<NetSuiteConfig>(configuration.GetSection(NetSuiteConfig.SectionName));
        var netSuiteConfig = configuration.GetSection(NetSuiteConfig.SectionName).Get<NetSuiteConfig>();
        
        if (netSuiteConfig == null || !netSuiteConfig.IsValid)
        {
            Console.WriteLine("❌ NetSuite configuration is invalid!");
            return;
        }

        // Register services
        services.AddHttpClient();
        services.AddSingleton<INetSuiteService, NetSuiteService>();
        services.AddSingleton<ILookupService, LookupService>();
        services.AddSingleton<IBalanceService, BalanceService>();
        services.AddMemoryCache();

        var serviceProvider = services.BuildServiceProvider();
        var netSuiteService = serviceProvider.GetRequiredService<INetSuiteService>();
        var lookupService = serviceProvider.GetRequiredService<ILookupService>();
        var logger = serviceProvider.GetRequiredService<ILogger<QueryBalanceTest>>();

        // Test parameters
        var account = "13000";
        var period = "May 2025";
        var subsidiary = "Celigo India Pvt Ltd";
        var book = 2;

        Console.WriteLine($"🔍 Querying NetSuite balance:");
        Console.WriteLine($"   Account: {account}");
        Console.WriteLine($"   Period: {period}");
        Console.WriteLine($"   Subsidiary: {subsidiary}");
        Console.WriteLine($"   Book: {book}");
        Console.WriteLine();

        try
        {
            // Get period
            Console.WriteLine("1️⃣  Getting period info...");
            var periodData = await netSuiteService.GetPeriodAsync(period);
            if (periodData == null)
            {
                Console.WriteLine($"❌ Could not find period: {period}");
                return;
            }
            Console.WriteLine($"   ✅ Period ID: {periodData.Id}, End Date: {periodData.EndDate}");

            // Get subsidiary
            Console.WriteLine("\n2️⃣  Getting subsidiary info...");
            var subId = await lookupService.ResolveSubsidiaryIdAsync(subsidiary);
            if (string.IsNullOrEmpty(subId))
            {
                Console.WriteLine($"❌ Could not find subsidiary: {subsidiary}");
                return;
            }
            Console.WriteLine($"   ✅ Subsidiary ID: {subId}");

            // Build query (same as BalanceService)
            var toEndDate = periodData.EndDate?.ToString("yyyy-MM-dd") ?? "";
            var accountingBook = book.ToString();
            
            var query = $@"
                SELECT SUM(x.cons_amt) AS balance
                FROM (
                    SELECT
                        TO_NUMBER(
                            BUILTIN.CONSOLIDATE(
                                tal.amount,
                                'LEDGER',
                                'DEFAULT',
                                'DEFAULT',
                                {subId},
                                {periodData.Id},
                                'DEFAULT'
                            )
                        ) * CASE 
                            WHEN a.accttype IN ('AcctPay', 'CredCard', 'OthCurrLiab', 'LongTermLiab', 'Equity') THEN -1
                            WHEN a.accttype IN ('OthIncome', 'Income') THEN -1
                            ELSE 1 
                        END AS cons_amt
                    FROM transactionaccountingline tal
                    JOIN transaction t ON t.id = tal.transaction
                    JOIN account a ON a.id = tal.account
                    WHERE t.posting = 'T'
                      AND tal.posting = 'T'
                      AND a.acctnumber = '{account}'
                      AND t.trandate <= TO_DATE('{toEndDate}', 'YYYY-MM-DD')
                      AND tal.accountingbook = {accountingBook}
                ) x
            ";

            Console.WriteLine("\n3️⃣  Executing balance query...");
            var result = await netSuiteService.QueryRawWithErrorAsync(query);
            
            if (!result.Success)
            {
                Console.WriteLine($"❌ Query failed: {result.ErrorCode}");
                Console.WriteLine($"   Details: {result.ErrorDetails}");
                return;
            }

            decimal balance = 0m;
            if (result.Items != null && result.Items.Count > 0)
            {
                var row = result.Items[0];
                if (row.TryGetProperty("balance", out var balProp))
                {
                    if (balProp.ValueKind == System.Text.Json.JsonValueKind.Number)
                        balance = balProp.GetDecimal();
                    else if (balProp.ValueKind == System.Text.Json.JsonValueKind.String)
                    {
                        if (decimal.TryParse(balProp.GetString(), out var parsed))
                            balance = parsed;
                    }
                }
            }

            var expected = 8314265.34m;
            var difference = balance - expected;

            Console.WriteLine($"\n✅ NetSuite Balance: ${balance:N2}");
            Console.WriteLine($"   Expected: ${expected:N2}");
            Console.WriteLine($"   Difference: ${difference:N2}");
            
            // Also test production BalanceService
            Console.WriteLine("\n4️⃣  Testing production BalanceService...");
            var balanceService = serviceProvider.GetRequiredService<IBalanceService>();
            var balanceRequest = new BalanceRequest
            {
                Account = account,
                FromPeriod = "",
                ToPeriod = period,
                Subsidiary = subsidiary,
                Department = "",
                Class = "",
                Location = "",
                Book = book
            };
            
            var productionResult = await balanceService.GetBalanceAsync(balanceRequest);
            Console.WriteLine($"   Production Balance: ${productionResult.Balance:N2}");
            Console.WriteLine($"   Production Difference: ${productionResult.Balance - expected:N2}");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"❌ Error: {ex.Message}");
            Console.WriteLine(ex.StackTrace);
        }
    }
}

