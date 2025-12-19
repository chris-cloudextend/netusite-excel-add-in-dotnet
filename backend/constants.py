"""
XAVI for NetSuite - Account Types and Constants

Copyright (c) 2025 Celigo, Inc.
All rights reserved.

This source code is proprietary and confidential. Unauthorized copying,
modification, distribution, or use of this software, via any medium,
is strictly prohibited without the express written permission of Celigo, Inc.

For licensing inquiries, contact: legal@celigo.com

---

This module defines all account type constants used throughout the application.
Using constants instead of "magic strings" provides:
- IDE autocomplete and error detection
- Single source of truth
- Easier maintenance when NetSuite changes

IMPORTANT: NetSuite uses BOTH 'COGS' and 'Cost of Goods Sold' in different contexts.
Always include both when filtering for Cost of Goods Sold accounts.

================================================================================
CRITICAL: EXACT SPELLING REQUIRED FOR ACCOUNT TYPES
================================================================================
NetSuite SuiteQL requires EXACT spellings. Common mistakes that cause silent
failures (accounts are excluded from queries with no error):

  WRONG              CORRECT
  ---------------    ---------------
  DeferExpens    →   DeferExpense     (Deferred Expense)
  DeferRevenu    →   DeferRevenue     (Deferred Revenue)
  CreditCard     →   CredCard         (Credit Card)
  
These typos caused a $60M+ discrepancy in CTA calculations (Dec 2024 bug).
Always use the constants defined below, never hardcode strings.
================================================================================
"""


class AccountType:
    """
    NetSuite account type values as returned by SuiteQL.
    These are the exact string values from account.accttype field.
    """
    
    # =========================================================================
    # BALANCE SHEET - ASSETS (Debit balance, stored positive, NO sign flip)
    # =========================================================================
    BANK = 'Bank'                    # Bank/Cash accounts
    ACCT_REC = 'AcctRec'             # Accounts Receivable
    OTHER_CURR_ASSET = 'OthCurrAsset'  # Other Current Asset
    FIXED_ASSET = 'FixedAsset'       # Fixed Asset
    OTHER_ASSET = 'OthAsset'         # Other Asset
    DEFERRED_EXPENSE = 'DeferExpense'  # Deferred Expense (prepaid)
    UNBILLED_REC = 'UnbilledRec'     # Unbilled Receivable
    
    # =========================================================================
    # BALANCE SHEET - LIABILITIES (Credit balance, stored negative, FLIP × -1)
    # =========================================================================
    ACCT_PAY = 'AcctPay'             # Accounts Payable
    CRED_CARD = 'CredCard'           # Credit Card (NOT 'CreditCard')
    OTHER_CURR_LIAB = 'OthCurrLiab'  # Other Current Liability
    LONG_TERM_LIAB = 'LongTermLiab'  # Long Term Liability
    DEFERRED_REVENUE = 'DeferRevenue'  # Deferred Revenue (unearned)
    
    # =========================================================================
    # BALANCE SHEET - EQUITY (Credit balance, stored negative, FLIP × -1)
    # =========================================================================
    EQUITY = 'Equity'                # Equity accounts
    RETAINED_EARNINGS = 'RetainedEarnings'  # Retained Earnings
    
    # =========================================================================
    # P&L - INCOME (Credit balance, stored negative, FLIP × -1 for reporting)
    # =========================================================================
    INCOME = 'Income'                # Revenue/Sales
    OTHER_INCOME = 'OthIncome'       # Other Income
    
    # =========================================================================
    # P&L - EXPENSES (Debit balance, stored positive, NO sign flip)
    # =========================================================================
    # IMPORTANT: NetSuite uses BOTH 'COGS' and 'Cost of Goods Sold'
    COGS = 'COGS'                    # Cost of Goods Sold (modern)
    COST_OF_GOODS_SOLD = 'Cost of Goods Sold'  # Cost of Goods Sold (legacy)
    EXPENSE = 'Expense'              # Operating Expense
    OTHER_EXPENSE = 'OthExpense'     # Other Expense
    
    # =========================================================================
    # OTHER (Excluded from financial queries)
    # =========================================================================
    NON_POSTING = 'NonPosting'       # Statistical/Non-posting (no transactions)
    STAT = 'Stat'                    # Statistical accounts (non-financial KPIs)
    
    # =========================================================================
    # GROUPED SETS - For query filtering
    # =========================================================================
    
    # All P&L account types (Income Statement)
    # Used in: WHERE a.accttype IN (...)
    PL_TYPES = frozenset({
        INCOME, 
        OTHER_INCOME,
        COGS, 
        COST_OF_GOODS_SOLD,  # Include both COGS variants!
        EXPENSE, 
        OTHER_EXPENSE
    })
    
    # All Balance Sheet asset types
    BS_ASSET_TYPES = frozenset({
        BANK, 
        ACCT_REC, 
        OTHER_CURR_ASSET, 
        FIXED_ASSET, 
        OTHER_ASSET, 
        DEFERRED_EXPENSE, 
        UNBILLED_REC
    })
    
    # All Balance Sheet liability types
    BS_LIABILITY_TYPES = frozenset({
        ACCT_PAY, 
        CRED_CARD, 
        OTHER_CURR_LIAB, 
        LONG_TERM_LIAB, 
        DEFERRED_REVENUE
    })
    
    # All Balance Sheet equity types
    BS_EQUITY_TYPES = frozenset({
        EQUITY, 
        RETAINED_EARNINGS
    })
    
    # All Balance Sheet types combined
    BS_TYPES = BS_ASSET_TYPES | BS_LIABILITY_TYPES | BS_EQUITY_TYPES
    
    # Types that need sign flip for Balance Sheet display
    # (Liabilities and Equity are stored as negative credits)
    SIGN_FLIP_TYPES = frozenset({
        ACCT_PAY, 
        CRED_CARD, 
        OTHER_CURR_LIAB, 
        LONG_TERM_LIAB, 
        DEFERRED_REVENUE,
        EQUITY, 
        RETAINED_EARNINGS
    })
    
    # Types excluded from financial queries (no transaction amounts)
    NON_FINANCIAL_TYPES = frozenset({
        NON_POSTING, 
        STAT
    })
    
    @classmethod
    def is_balance_sheet(cls, accttype):
        """Check if account type is Balance Sheet (not P&L)"""
        return accttype not in cls.PL_TYPES and accttype not in cls.NON_FINANCIAL_TYPES
    
    @classmethod
    def is_pl(cls, accttype):
        """Check if account type is P&L (Income Statement)"""
        return accttype in cls.PL_TYPES
    
    @classmethod
    def needs_sign_flip(cls, accttype):
        """Check if account type needs sign flip for reporting"""
        return accttype in cls.SIGN_FLIP_TYPES
    
    @classmethod
    def pl_types_sql(cls):
        """Get P&L types as SQL IN clause string with quotes"""
        return "'" + "', '".join(sorted(cls.PL_TYPES)) + "'"
    
    @classmethod
    def sign_flip_types_sql(cls):
        """Get sign flip types as SQL IN clause string with quotes"""
        return "'" + "', '".join(sorted(cls.SIGN_FLIP_TYPES)) + "'"
    
    @classmethod
    def income_types_sql(cls):
        """Get income types for sign flip (Income, OthIncome)"""
        return "'Income', 'OthIncome'"


# =========================================================================
# SQL-READY STRINGS - Use these directly in query building
# =========================================================================

# P&L types for WHERE a.accttype IN (...)
# Result: 'COGS', 'Cost of Goods Sold', 'Expense', 'Income', 'OthExpense', 'OthIncome'
PL_TYPES_SQL = "'" + "', '".join(sorted(AccountType.PL_TYPES)) + "'"

# Sign flip types for CASE WHEN a.accttype IN (...)
# Result: 'AcctPay', 'CredCard', 'DeferRevenue', 'Equity', 'LongTermLiab', 'OthCurrLiab', 'RetainedEarnings'
SIGN_FLIP_TYPES_SQL = "'" + "', '".join(sorted(AccountType.SIGN_FLIP_TYPES)) + "'"

# Income types for P&L sign flip (revenue is stored negative, flip to positive)
# Result: 'Income', 'OthIncome'
INCOME_TYPES_SQL = "'Income', 'OthIncome'"

# Expense types for P&L (used when we need to flip expense signs)
# Per NetSuite docs, expense accounts may need sign flip: 'Expense', 'OthExpense', 'COGS', 'Cost of Goods Sold'
EXPENSE_TYPES_SQL = "'Expense', 'OthExpense', 'COGS', 'Cost of Goods Sold'"

# ================================================================================
# SPECIAL ACCOUNT (sspecacct) SIGN HANDLING
# ================================================================================
# NetSuite uses "Matching" special accounts as contra/offset entries for currency
# revaluation. These accounts require additional sign inversion when displaying
# amounts on financial statements.
#
# Example:
#   - UnrERV (Unrealized Exchange Rate Variance) = normal sign logic
#   - MatchingUnrERV = inverted sign for proper display
#
# Both have the same accttype (e.g., OthExpense), so we cannot rely on accttype alone.
#
# Solution: Apply additional sign inversion for accounts where sspecacct LIKE 'Matching%'
#
# SQL Pattern:
#   * CASE WHEN a.accttype IN ({INCOME_TYPES_SQL}) THEN -1 ELSE 1 END
#   * CASE WHEN a.sspecacct LIKE 'Matching%' THEN -1 ELSE 1 END
#
# This approach is universal and will automatically handle any future "Matching"
# special accounts NetSuite may add. No hardcoded account numbers required.
# ================================================================================

# Asset types for Balance Sheet (debit balance, no sign flip)
# Result: 'AcctRec', 'Bank', 'DeferExpense', 'FixedAsset', 'OthAsset', 'OthCurrAsset', 'UnbilledRec'
BS_ASSET_TYPES_SQL = "'" + "', '".join(sorted(AccountType.BS_ASSET_TYPES)) + "'"

# Liability types for Balance Sheet (credit balance, needs sign flip)
# Result: 'AcctPay', 'CredCard', 'DeferRevenue', 'LongTermLiab', 'OthCurrLiab'
BS_LIABILITY_TYPES_SQL = "'" + "', '".join(sorted(AccountType.BS_LIABILITY_TYPES)) + "'"

# Equity types for Balance Sheet (credit balance, needs sign flip)
# Result: 'Equity', 'RetainedEarnings'
BS_EQUITY_TYPES_SQL = "'" + "', '".join(sorted(AccountType.BS_EQUITY_TYPES)) + "'"

