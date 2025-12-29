-- Query to get ONLY February 2025 transactions for account 10010
-- This is period-only, not cumulative
SELECT SUM(x.cons_amt) AS balance
FROM (
    SELECT
        TO_NUMBER(
            BUILTIN.CONSOLIDATE(
                tal.amount,
                'LEDGER',
                'DEFAULT',
                'DEFAULT',
                1,
                t.postingperiod,
                'DEFAULT'
            )
        ) * CASE WHEN a.accttype IN ('AcctPay', 'CredCard', 'LongTermLiab', 'Equity', 'RetainedEarnings') THEN -1 ELSE 1 END AS cons_amt
    FROM transactionaccountingline tal
    JOIN transaction t ON t.id = tal.transaction
    JOIN account a ON a.id = tal.account
    JOIN accountingperiod ap ON ap.id = t.postingperiod
    JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
    WHERE t.posting = 'T'
      AND tal.posting = 'T'
      AND a.acctnumber = '10010'
      AND ap.periodname = 'Feb 2025'
      AND tal.accountingbook = 1
) x
