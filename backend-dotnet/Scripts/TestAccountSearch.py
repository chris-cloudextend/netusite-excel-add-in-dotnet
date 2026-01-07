#!/usr/bin/env python3
"""
Test harness for SearchAccountsByPatternAsync logic validation.
This simulates the WHERE clause generation without requiring NetSuite.
"""

def escape_sql(input_str):
    """Escape SQL string to prevent injection."""
    if not input_str:
        return input_str
    return input_str.replace("'", "''")

def generate_where_clause(pattern, active_only=True):
    """
    Simulate the WHERE clause generation logic from SearchAccountsByPatternAsync.
    Returns: (search_type, conditions, where_clause)
    """
    # Normalize input once
    normalized_input = (pattern or "").strip().lower()
    
    conditions = []
    matched_types = []
    search_type = None

    # Explicit intent detection in exact order (case-insensitive)
    if normalized_input == "income":
        # Income statement accounts
        search_type = "income_statement"
        income_types = ["Income", "OthIncome", "Expense", "OthExpense", "COGS"]
        matched_types.extend(income_types)
        escaped_types = [f"'{escape_sql(t)}'" for t in income_types]
        conditions.append(f"a.accttype IN ({','.join(escaped_types)})")
    elif normalized_input == "balance":
        # Balance sheet accounts
        search_type = "balance_sheet"
        balance_types = ["Bank", "AcctRec", "OthCurrAsset", "FixedAsset", "OthAsset", 
                        "AcctPay", "CredCard", "OthCurrLiab", "LongTermLiab", "Equity"]
        matched_types.extend(balance_types)
        escaped_types = [f"'{escape_sql(t)}'" for t in balance_types]
        conditions.append(f"a.accttype IN ({','.join(escaped_types)})")
    elif normalized_input == "bank":
        # Bank accounts only
        search_type = "bank_accounts"
        matched_types.append("Bank")
        conditions.append("a.accttype = 'Bank'")
    elif normalized_input == "" or normalized_input == "*":
        # All active accounts - no type filter
        search_type = "all_active"
    else:
        # Name or account number search
        search_type = "name_or_number"
        
        # Escape the pattern for SQL LIKE
        escaped_pattern = escape_sql(normalized_input)
        sql_pattern = f"%{escaped_pattern}%"
        
        # Search both account name and account number
        conditions.append(f"(LOWER(a.accountsearchdisplaynamecopy) LIKE LOWER('{sql_pattern}') OR a.acctnumber LIKE '{sql_pattern}')")

    # Base filter: always include active status
    if active_only:
        conditions.append("a.isinactive = 'F'")
    
    # Validate: must have at least one condition (active filter counts)
    if len(conditions) == 0:
        raise ValueError(f"ERROR: No WHERE conditions generated for pattern '{pattern}'")
    
    # Build WHERE clause
    where_clause = " AND ".join(conditions)
    
    return (search_type, conditions, where_clause)

def validate_where_clause(search_type, where_clause, conditions):
    """Validate the generated WHERE clause."""
    # Check for impossible predicates
    has_impossible = "= ''" in where_clause or "LIKE ''" in where_clause
    
    # Additional checks
    if has_impossible:
        return "❌ FAIL: Contains impossible predicate"
    elif len(conditions) == 0 and search_type != "all_active":
        return "❌ FAIL: No conditions generated"
    elif search_type == "all_active" and "isinactive = 'F'" not in where_clause:
        return "❌ FAIL: Missing active filter"
    elif search_type == "income_statement" and "accttype IN" not in where_clause:
        return "❌ FAIL: Missing income type filter"
    elif search_type == "balance_sheet" and "accttype IN" not in where_clause:
        return "❌ FAIL: Missing balance sheet type filter"
    elif search_type == "bank_accounts" and "accttype = 'Bank'" not in where_clause:
        return "❌ FAIL: Missing bank type filter"
    elif search_type == "name_or_number" and "LIKE" not in where_clause:
        return "❌ FAIL: Missing LIKE pattern"
    else:
        return "✅ PASS"

def run_tests():
    """Run all test cases."""
    test_cases = [
        "income",
        "Income",
        "balance",
        "Bank",
        "bank",
        "*",
        "",
        "100",
        "cash"
    ]

    print("=" * 100)
    print("ACCOUNT SEARCH QA TEST HARNESS")
    print("=" * 100)
    print()

    results = []

    for test_input in test_cases:
        try:
            search_type, conditions, where_clause = generate_where_clause(test_input)
            
            # Check for impossible predicates
            has_impossible = "= ''" in where_clause or "LIKE ''" in where_clause
            
            # Validate WHERE clause
            validation = validate_where_clause(search_type, where_clause, conditions)
            
            results.append({
                'input': test_input,
                'search_type': search_type,
                'where_clause': where_clause,
                'has_impossible': has_impossible,
                'validation': validation
            })
            
            print(f"Input: '{test_input}'")
            print(f"  Search Type: {search_type}")
            print(f"  WHERE Clause: {where_clause}")
            print(f"  Validation: {validation}")
            print()
        except Exception as ex:
            results.append({
                'input': test_input,
                'search_type': 'ERROR',
                'where_clause': str(ex),
                'has_impossible': True,
                'validation': f"❌ FAIL: Exception"
            })
            print(f"Input: '{test_input}'")
            print(f"  ERROR: {ex}")
            print()

    # QA Summary Table
    print("=" * 100)
    print("QA SUMMARY TABLE")
    print("=" * 100)
    print()
    print(f"{'Input':<15} {'Search Mode':<20} {'Has Impossible Predicate':<25} {'Validation':<15}")
    print("-" * 100)
    
    for r in results:
        print(f"{r['input']:<15} {r['search_type']:<20} {str(r['has_impossible']):<25} {r['validation']:<15}")
    
    print()
    print("=" * 100)
    
    # Verify failure modes
    print("FAILURE MODE VERIFICATION")
    print("=" * 100)
    
    empty_test = next((r for r in results if r['input'] == ""), None)
    wildcard_test = next((r for r in results if r['input'] == "*"), None)
    income_test = next((r for r in results if r['input'].lower() == "income"), None)
    balance_test = next((r for r in results if r['input'].lower() == "balance"), None)
    bank_test = next((r for r in results if r['input'].lower() == "bank"), None)
    
    print(f"Empty input generates name/number filter: {'❌ NO (correct)' if empty_test['search_type'] == 'all_active' else '✅ YES (wrong)'}")
    print(f"Wildcard input collapses to empty predicate: {'❌ NO (correct)' if wildcard_test['search_type'] == 'all_active' else '✅ YES (wrong)'}")
    print(f"Income search mode: {income_test['search_type']} (expected: income_statement)")
    print(f"Balance search mode: {balance_test['search_type']} (expected: balance_sheet)")
    print(f"Bank search mode: {bank_test['search_type']} (expected: bank_accounts)")
    
    all_pass = all(r['has_impossible'] == False and r['validation'] == "✅ PASS" for r in results)
    print()
    print(f"All tests pass: {'✅ YES' if all_pass else '❌ NO'}")
    
    # Detailed WHERE clause output
    print()
    print("=" * 100)
    print("DETAILED WHERE CLAUSE OUTPUT")
    print("=" * 100)
    for r in results:
        print(f"\nInput: '{r['input']}'")
        print(f"  WHERE Clause: {r['where_clause']}")

if __name__ == "__main__":
    run_tests()

