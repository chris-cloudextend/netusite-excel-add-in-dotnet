// ============================================================================
// EXTRACTED FROM: backend-dotnet/Controllers/BalanceController.cs lines 812-853
// Function: PreloadBalanceSheetAccounts() - BS Preload Query
// Purpose: Query all Balance Sheet accounts for specified periods
// KEY ISSUE: Query uses LEFT JOIN but may still not return zero balance accounts
// ============================================================================

// OPTIMIZATION: Start from account table with LEFT JOIN to include ALL BS accounts
// (including those with zero transactions). This ensures complete cache coverage
// and eliminates slow individual API calls for accounts like 10206.
// 
// Key changes:
// - Start from account table (not transactionaccountingline)
// - Use LEFT JOIN to include accounts with no transactions
// - COALESCE returns 0 for accounts with no transactions (not NULL)
// - Filter inactive accounts
// - Accounting book filter handles NULL (accounts with no transactions)
var query = $@"
    SELECT 
        a.acctnumber,
        a.accountsearchdisplaynamecopy AS account_name,
        a.accttype,
        COALESCE(SUM(
            TO_NUMBER(
                BUILTIN.CONSOLIDATE(
                    tal.amount,
                    'LEDGER',
                    'DEFAULT',
                    'DEFAULT',
                    {targetSub},
                    {periodId},
                    'DEFAULT'
                )
            ) * CASE WHEN a.accttype IN ({signFlipSql}) THEN -1 ELSE 1 END
        ), 0) AS balance
    FROM account a
    LEFT JOIN transactionaccountingline tal ON tal.account = a.id
        AND tal.posting = 'T'
    LEFT JOIN transaction t ON t.id = tal.transaction
        AND t.posting = 'T'
        AND t.trandate <= TO_DATE('{endDate}', 'YYYY-MM-DD')
    LEFT JOIN TransactionLine tl ON t.id = tl.transaction 
        AND tal.transactionline = tl.id
        AND ({segmentWhere})
    WHERE a.accttype IN ({bsTypesSql})
      AND a.isinactive = 'F'
      AND (tal.accountingbook = {accountingBook} OR tal.accountingbook IS NULL)
    GROUP BY a.acctnumber, a.accountsearchdisplaynamecopy, a.accttype
    ORDER BY a.acctnumber";

// Process and cache results for this period
foreach (var row in queryResult.Items)
{
    var accountNumber = row.TryGetProperty("acctnumber", out var numProp) ? numProp.GetString() ?? "" : "";
    var accountName = row.TryGetProperty("account_name", out var nameProp) ? nameProp.GetString() ?? "" : "";
    var accountType = row.TryGetProperty("accttype", out var typeProp) ? typeProp.GetString() ?? "" : "";

    if (string.IsNullOrEmpty(accountNumber))
        continue;

    decimal balance = 0;
    if (row.TryGetProperty("balance", out var balProp) && balProp.ValueKind != JsonValueKind.Null)
    {
        balance = ParseBalance(balProp);
    }

    // Store balance per period: { "10010": { "Dec 2024": 100, "Dec 2023": 90 } }
    if (!allBalances.ContainsKey(accountNumber))
        allBalances[accountNumber] = new Dictionary<string, decimal>();
    allBalances[accountNumber][periodName] = balance;
}

// POTENTIAL ISSUE: The WHERE clause filter on accountingbook might exclude accounts
// with no transactions. The LEFT JOIN ensures tal.accountingbook IS NULL for accounts
// with no transactions, but the WHERE clause might still filter them out.
//
// QUESTION: Should the accountingbook filter be in the JOIN condition instead of WHERE?

