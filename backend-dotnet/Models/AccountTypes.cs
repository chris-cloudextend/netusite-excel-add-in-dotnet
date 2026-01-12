/*
 * XAVI for NetSuite - Account Types and Constants
 *
 * Copyright (c) 2025 Celigo, Inc.
 * All rights reserved.
 *
 * This module defines all account type constants used throughout the application.
 * Using constants instead of "magic strings" provides:
 * - IDE autocomplete and error detection
 * - Single source of truth
 * - Easier maintenance when NetSuite changes
 *
 * IMPORTANT: NetSuite uses BOTH 'COGS' and 'Cost of Goods Sold' in different contexts.
 * Always include both when filtering for Cost of Goods Sold accounts.
 *
 * ================================================================================
 * CRITICAL: EXACT SPELLING REQUIRED FOR ACCOUNT TYPES
 * ================================================================================
 * NetSuite SuiteQL requires EXACT spellings. Common mistakes that cause silent
 * failures (accounts are excluded from queries with no error):
 *
 *   WRONG              CORRECT
 *   ---------------    ---------------
 *   DeferExpens    →   DeferExpense     (Deferred Expense)
 *   DeferRevenu    →   DeferRevenue     (Deferred Revenue)
 *   CreditCard     →   CredCard         (Credit Card)
 *
 * These typos caused a $60M+ discrepancy in CTA calculations (Dec 2024 bug).
 * Always use the constants defined below, never hardcode strings.
 * ================================================================================
 */

namespace XaviApi.Models;

/// <summary>
/// NetSuite account type values as returned by SuiteQL.
/// These are the exact string values from account.accttype field.
/// </summary>
public static class AccountType
{
    // =========================================================================
    // BALANCE SHEET - ASSETS (Debit balance, stored positive, NO sign flip)
    // =========================================================================
    public const string Bank = "Bank";                      // Bank/Cash accounts
    public const string AcctRec = "AcctRec";                // Accounts Receivable
    public const string OthCurrAsset = "OthCurrAsset";      // Other Current Asset
    public const string FixedAsset = "FixedAsset";          // Fixed Asset
    public const string OthAsset = "OthAsset";              // Other Asset
    public const string DeferExpense = "DeferExpense";      // Deferred Expense (prepaid)
    public const string UnbilledRec = "UnbilledRec";        // Unbilled Receivable

    // =========================================================================
    // BALANCE SHEET - LIABILITIES (Credit balance, stored negative, FLIP × -1)
    // =========================================================================
    public const string AcctPay = "AcctPay";                // Accounts Payable
    public const string CredCard = "CredCard";              // Credit Card (NOT 'CreditCard')
    public const string OthCurrLiab = "OthCurrLiab";        // Other Current Liability
    public const string LongTermLiab = "LongTermLiab";      // Long Term Liability
    public const string DeferRevenue = "DeferRevenue";      // Deferred Revenue (unearned)

    // =========================================================================
    // BALANCE SHEET - EQUITY (Credit balance, stored negative, FLIP × -1)
    // =========================================================================
    public const string Equity = "Equity";                  // Equity accounts
    public const string RetainedEarnings = "RetainedEarnings";  // Retained Earnings

    // =========================================================================
    // P&L - INCOME (Credit balance, stored negative, FLIP × -1 for reporting)
    // =========================================================================
    public const string Income = "Income";                  // Revenue/Sales
    public const string OthIncome = "OthIncome";            // Other Income

    // =========================================================================
    // P&L - EXPENSES (Debit balance, stored positive, NO sign flip)
    // =========================================================================
    public const string COGS = "COGS";                      // Cost of Goods Sold (modern)
    public const string CostOfGoodsSold = "Cost of Goods Sold";  // Cost of Goods Sold (legacy)
    public const string Expense = "Expense";                // Operating Expense
    public const string OthExpense = "OthExpense";          // Other Expense

    // =========================================================================
    // OTHER (Excluded from financial queries)
    // =========================================================================
    public const string NonPosting = "NonPosting";          // Statistical/Non-posting
    public const string Stat = "Stat";                      // Statistical accounts

    // =========================================================================
    // GROUPED SETS - For query filtering
    // =========================================================================

    /// <summary>All P&L account types (Income Statement)</summary>
    public static readonly HashSet<string> PlTypes = new()
    {
        Income, OthIncome, COGS, CostOfGoodsSold, Expense, OthExpense
    };

    /// <summary>All Balance Sheet asset types</summary>
    public static readonly HashSet<string> BsAssetTypes = new()
    {
        Bank, AcctRec, OthCurrAsset, FixedAsset, OthAsset, DeferExpense, UnbilledRec
    };

    /// <summary>All Balance Sheet liability types</summary>
    public static readonly HashSet<string> BsLiabilityTypes = new()
    {
        AcctPay, CredCard, OthCurrLiab, LongTermLiab, DeferRevenue
    };

    /// <summary>All Balance Sheet equity types</summary>
    public static readonly HashSet<string> BsEquityTypes = new()
    {
        Equity, RetainedEarnings
    };

    /// <summary>All Balance Sheet types combined</summary>
    public static readonly HashSet<string> BsTypes;

    /// <summary>Types that need sign flip for Balance Sheet display</summary>
    public static readonly HashSet<string> SignFlipTypes = new()
    {
        AcctPay, CredCard, OthCurrLiab, LongTermLiab, DeferRevenue, Equity, RetainedEarnings
    };

    /// <summary>Types excluded from financial queries</summary>
    public static readonly HashSet<string> NonFinancialTypes = new()
    {
        NonPosting, Stat
    };

    /// <summary>Income types for P&L sign flip</summary>
    public static readonly HashSet<string> IncomeTypes = new()
    {
        Income, OthIncome
    };

    /// <summary>Expense types for P&L</summary>
    public static readonly HashSet<string> ExpenseTypes = new()
    {
        Expense, OthExpense, COGS, CostOfGoodsSold
    };

    static AccountType()
    {
        // Initialize BsTypes as union of all BS types
        BsTypes = new HashSet<string>(BsAssetTypes);
        BsTypes.UnionWith(BsLiabilityTypes);
        BsTypes.UnionWith(BsEquityTypes);
    }

    // =========================================================================
    // SQL-READY STRINGS - Use these directly in query building
    // =========================================================================

    /// <summary>P&L types for WHERE a.accttype IN (...)</summary>
    public static string PlTypesSql => FormatForSql(PlTypes);

    /// <summary>Sign flip types for CASE WHEN a.accttype IN (...)</summary>
    public static string SignFlipTypesSql => FormatForSql(SignFlipTypes);

    /// <summary>Income types for P&L sign flip</summary>
    public static string IncomeTypesSql => "'Income', 'OthIncome'";

    /// <summary>Expense types for P&L</summary>
    public static string ExpenseTypesSql => "'Expense', 'OthExpense', 'COGS', 'Cost of Goods Sold'";

    /// <summary>Asset types for Balance Sheet</summary>
    public static string BsAssetTypesSql => FormatForSql(BsAssetTypes);

    /// <summary>Liability types for Balance Sheet</summary>
    public static string BsLiabilityTypesSql => FormatForSql(BsLiabilityTypes);

    /// <summary>Equity types for Balance Sheet</summary>
    public static string BsEquityTypesSql => FormatForSql(BsEquityTypes);
    
    /// <summary>ALL Balance Sheet types for WHERE a.accttype IN (...)</summary>
    public static string BsTypesSql => FormatForSql(BsTypes);

    // =========================================================================
    // HELPER METHODS
    // =========================================================================

    /// <summary>Check if account type is Balance Sheet (not P&L)</summary>
    public static bool IsBalanceSheet(string accttype) =>
        !PlTypes.Contains(accttype) && !NonFinancialTypes.Contains(accttype);

    /// <summary>Check if account type is P&L (Income Statement)</summary>
    public static bool IsPl(string accttype) => PlTypes.Contains(accttype);

    /// <summary>Check if account type needs sign flip for reporting</summary>
    public static bool NeedsSignFlip(string accttype) => SignFlipTypes.Contains(accttype);

    /// <summary>Check if account type is an income type</summary>
    public static bool IsIncome(string accttype) => IncomeTypes.Contains(accttype);

    /// <summary>Check if account type is an expense type</summary>
    public static bool IsExpense(string accttype) => ExpenseTypes.Contains(accttype);

    /// <summary>Format a set of types for SQL IN clause</summary>
    private static string FormatForSql(HashSet<string> types) =>
        string.Join(", ", types.OrderBy(t => t).Select(t => $"'{t}'"));

    /// <summary>
    /// Get the display name for an account type.
    /// Maps internal NetSuite type codes to human-readable names.
    /// </summary>
    public static string GetDisplayName(string accttype) => accttype switch
    {
        Bank => "Bank",
        AcctRec => "Accounts Receivable",
        OthCurrAsset => "Other Current Asset",
        FixedAsset => "Fixed Asset",
        OthAsset => "Other Asset",
        DeferExpense => "Deferred Expense",
        UnbilledRec => "Unbilled Receivable",
        AcctPay => "Accounts Payable",
        CredCard => "Credit Card",
        OthCurrLiab => "Other Current Liability",
        LongTermLiab => "Long Term Liability",
        DeferRevenue => "Deferred Revenue",
        Equity => "Equity",
        RetainedEarnings => "Retained Earnings",
        Income => "Income",
        OthIncome => "Other Income",
        COGS => "Cost of Goods Sold",
        CostOfGoodsSold => "Cost of Goods Sold",
        Expense => "Expense",
        OthExpense => "Other Expense",
        NonPosting => "Non-Posting",
        Stat => "Statistical",
        _ => accttype
    };
}

