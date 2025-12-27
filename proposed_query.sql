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
                1,
                345,
                'DEFAULT'
            )
        ) * CASE WHEN a.accttype IN ('AcctPay', 'CredCard', 'OthCurrLiab', 'LongTermLiab', 'DeferRevenue', 'Equity', 'RetainedEarnings') THEN -1 ELSE 1 END
    ), 0) AS balance
FROM account a
LEFT JOIN transactionaccountingline tal ON tal.account = a.id
    AND tal.posting = 'T'
LEFT JOIN transaction t ON t.id = tal.transaction
    AND t.posting = 'T'
    AND t.trandate <= TO_DATE('2025-02-28', 'YYYY-MM-DD')
LEFT JOIN TransactionLine tl ON t.id = tl.transaction 
    AND tal.transactionline = tl.id
    AND tl.subsidiary IN (1)
WHERE a.accttype IN ('Bank', 'AcctRec', 'OthCurrAsset', 'FixedAsset', 'OthAsset', 'DeferExpense', 'UnbilledRec', 'AcctPay', 'CredCard', 'OthCurrLiab', 'LongTermLiab', 'DeferRevenue', 'Equity', 'RetainedEarnings')
  AND a.isinactive = 'F'
  AND (tal.accountingbook = 1 OR tal.accountingbook IS NULL)
GROUP BY a.acctnumber, a.accountsearchdisplaynamecopy, a.accttype
ORDER BY a.acctnumber
