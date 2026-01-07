#!/usr/bin/env python3
"""
Test script to verify account search logic and show SQL queries
Tests: Income, Balance, and AcctRec keywords
"""

def escape_sql(text):
    """Escape single quotes in SQL strings"""
    if text is None:
        return ""
    return str(text).replace("'", "''")

def test_search_logic(pattern, description):
    """Test the search logic and show what SQL would be generated"""
    print(f"\n{'='*80}")
    print(f"TEST: {description}")
    print(f"Pattern: '{pattern}'")
    print(f"{'='*80}")
    
    # Simulate the backend logic
    pattern_without_wildcards = pattern.replace('*', '').strip()
    is_type_search = bool(pattern_without_wildcards) and any(c.isalpha() for c in pattern_without_wildcards)
    pattern_upper = pattern_without_wildcards.upper().strip()
    
    print(f"\n📋 Logic Flow:")
    print(f"   pattern_without_wildcards: '{pattern_without_wildcards}'")
    print(f"   is_type_search: {is_type_search}")
    print(f"   pattern_upper: '{pattern_upper}'")
    
    if not is_type_search:
        print(f"\n❌ This would be treated as an account NUMBER search, not type search")
        return
    
    # Type mappings from backend
    type_mappings = {
        'INCOME': ['Income', 'OthIncome', 'COGS', 'Cost of Goods Sold', 'Expense', 'OthExpense'],
        'BALANCE': ['Bank', 'AcctRec', 'OthCurrAsset', 'FixedAsset', 'OthAsset', 'DeferExpense', 'UnbilledRec', 
                   'AcctPay', 'CredCard', 'OthCurrLiab', 'LongTermLiab', 'DeferRevenue', 
                   'Equity', 'RetainedEarnings'],
        'BALANCESHEET': ['Bank', 'AcctRec', 'OthCurrAsset', 'FixedAsset', 'OthAsset', 'DeferExpense', 'UnbilledRec', 
                         'AcctPay', 'CredCard', 'OthCurrLiab', 'LongTermLiab', 'DeferRevenue', 
                         'Equity', 'RetainedEarnings'],
        'EXPENSE': ['Expense', 'OthExpense'],
        'COGS': ['COGS', 'Cost of Goods Sold'],
        'ASSET': ['Bank', 'AcctRec', 'OthCurrAsset', 'FixedAsset', 'OthAsset', 'DeferExpense', 'UnbilledRec'],
        'LIABILITY': ['AcctPay', 'CredCard', 'OthCurrLiab', 'LongTermLiab', 'DeferRevenue'],
        'EQUITY': ['Equity', 'RetainedEarnings']
    }
    
    # Collect all valid NetSuite account types
    all_valid_types = set()
    for types_list in type_mappings.values():
        all_valid_types.update(types_list)
    
    print(f"\n🔍 Matching Logic:")
    
    # Check for exact account type match
    exact_type_match = None
    for valid_type in all_valid_types:
        if valid_type.upper() == pattern_upper:
            exact_type_match = valid_type
            break
    
    matched_types = []
    where_clause = None
    
    if exact_type_match:
        print(f"   ✅ Exact account type match found: '{exact_type_match}'")
        matched_types = [exact_type_match]
        escaped_type = escape_sql(exact_type_match)
        where_clause = f"accttype = '{escaped_type}'"
        print(f"   Match Type: EXACT account type")
    elif pattern_upper in type_mappings:
        print(f"   ✅ Category keyword match found: '{pattern_upper}'")
        matched_types = type_mappings[pattern_upper]
        escaped_types = [escape_sql(t) for t in matched_types]
        type_list = "','".join(escaped_types)
        where_clause = f"accttype IN ('{type_list}')"
        print(f"   Match Type: CATEGORY keyword")
    else:
        # Check for partial matches
        for category, types in type_mappings.items():
            if category.startswith(pattern_upper) or pattern_upper in category:
                matched_types.extend(types)
        
        if matched_types:
            print(f"   ✅ Partial category match found")
            escaped_types = [escape_sql(t) for t in matched_types]
            type_list = "','".join(escaped_types)
            where_clause = f"accttype IN ('{type_list}')"
            print(f"   Match Type: PARTIAL category match")
        else:
            sql_pattern = pattern.replace('*', '%').upper()
            sql_pattern = escape_sql(sql_pattern)
            where_clause = f"UPPER(accttype) LIKE '{sql_pattern}'"
            print(f"   ⚠️  No category match - using LIKE pattern")
            print(f"   Match Type: LIKE pattern (may match unexpected types)")
    
    print(f"\n📊 Matched Account Types ({len(matched_types)}):")
    for i, acct_type in enumerate(matched_types, 1):
        print(f"   {i}. {acct_type}")
    
    print(f"\n💾 Generated SQL WHERE Clause:")
    print(f"   {where_clause}")
    
    print(f"\n🔬 Full SQL Query (example):")
    full_query = f"""
    SELECT 
        id,
        acctnumber,
        accountsearchdisplaynamecopy AS accountname,
        accttype,
        sspecacct
    FROM 
        Account
    WHERE 
        {where_clause}
        AND isinactive = 'F'
    ORDER BY 
        acctnumber
    """
    print(full_query)
    
    print(f"\n✅ Expected Result:")
    print(f"   Will return ONLY accounts with these types: {', '.join(matched_types)}")
    print(f"   Will NOT return any other account types")
    
    return matched_types, where_clause


def main():
    print("="*80)
    print("NETSUITE ACCOUNT SEARCH LOGIC VERIFICATION")
    print("="*80)
    
    # Test 1: Income
    income_types, income_where = test_search_logic('Income', 
                                                   'Income Statement Accounts (Income keyword)')
    
    # Test 2: Balance
    balance_types, balance_where = test_search_logic('Balance',
                                                     'Balance Sheet Accounts (Balance keyword)')
    
    # Test 3: AcctRec
    acctrec_types, acctrec_where = test_search_logic('AcctRec',
                                                      'Accounts Receivable (AcctRec exact type)')
    
    # Summary
    print(f"\n{'='*80}")
    print("VERIFICATION SUMMARY")
    print(f"{'='*80}")
    
    print(f"\n1. Income Search:")
    print(f"   Expected Types: Income, OthIncome, COGS, Cost of Goods Sold, Expense, OthExpense")
    print(f"   Actual Types:   {', '.join(income_types)}")
    print(f"   Match: {'✅ CORRECT' if set(income_types) == {'Income', 'OthIncome', 'COGS', 'Cost of Goods Sold', 'Expense', 'OthExpense'} else '❌ MISMATCH'}")
    
    print(f"\n2. Balance Search:")
    expected_balance = {'Bank', 'AcctRec', 'OthCurrAsset', 'FixedAsset', 'OthAsset', 
                        'DeferExpense', 'UnbilledRec', 'AcctPay', 'CredCard', 
                        'OthCurrLiab', 'LongTermLiab', 'DeferRevenue', 'Equity', 'RetainedEarnings'}
    print(f"   Expected Types: {len(expected_balance)} Balance Sheet types")
    print(f"   Actual Types:   {len(balance_types)} types")
    print(f"   Match: {'✅ CORRECT' if set(balance_types) == expected_balance else '❌ MISMATCH'}")
    
    print(f"\n3. AcctRec Search:")
    print(f"   Expected Types: AcctRec")
    print(f"   Actual Types:   {', '.join(acctrec_types)}")
    print(f"   Match: {'✅ CORRECT' if acctrec_types == ['AcctRec'] else '❌ MISMATCH'}")
    
    print(f"\n{'='*80}\n")
    
    # Show SQL queries
    print("="*80)
    print("GENERATED SQL QUERIES")
    print("="*80)
    print(f"\n1. Income Search SQL:")
    print(f"   {income_where}")
    print(f"\n2. Balance Search SQL:")
    print(f"   {balance_where}")
    print(f"\n3. AcctRec Search SQL:")
    print(f"   {acctrec_where}")
    print(f"\n{'='*80}\n")


if __name__ == '__main__':
    main()

