#!/usr/bin/env python3
"""
Test script to verify account search returns correct account types
Tests: Income, Balance, and AcctRec keywords
"""

import requests
import json
import sys

# Configuration - adjust these for your environment
BASE_URL = "http://localhost:5000"  # Change if your backend runs on different port
# Or use: BASE_URL = "https://your-backend-url.com"

def test_account_search(pattern, expected_types, description):
    """Test account search and verify only expected account types are returned"""
    print(f"\n{'='*80}")
    print(f"TEST: {description}")
    print(f"Pattern: '{pattern}'")
    print(f"Expected Account Types: {expected_types}")
    print(f"{'='*80}")
    
    url = f"{BASE_URL}/accounts/search"
    params = {
        'pattern': pattern,
        'active_only': 'true'
    }
    
    try:
        response = requests.get(url, params=params, timeout=30)
        
        if response.status_code != 200:
            print(f"❌ ERROR: HTTP {response.status_code}")
            print(f"Response: {response.text}")
            return False
        
        data = response.json()
        
        if 'error' in data:
            print(f"❌ ERROR: {data['error']}")
            return False
        
        accounts = data.get('accounts', [])
        count = data.get('count', len(accounts))
        
        print(f"\n✅ Query successful")
        print(f"   Total accounts returned: {count}")
        
        # Group accounts by type
        accounts_by_type = {}
        for acc in accounts:
            acct_type = acc.get('accttype', 'Unknown')
            if acct_type not in accounts_by_type:
                accounts_by_type[acct_type] = []
            accounts_by_type[acct_type].append(acc)
        
        print(f"\n📊 Accounts by Type:")
        for acct_type, acc_list in sorted(accounts_by_type.items()):
            print(f"   {acct_type}: {len(acc_list)} accounts")
        
        # Verify all returned types are in expected list
        returned_types = set(accounts_by_type.keys())
        expected_types_set = set(expected_types)
        
        unexpected_types = returned_types - expected_types_set
        missing_types = expected_types_set - returned_types
        
        print(f"\n🔍 Verification:")
        if unexpected_types:
            print(f"   ❌ UNEXPECTED types found: {sorted(unexpected_types)}")
            print(f"   These should NOT appear for pattern '{pattern}'")
            return False
        else:
            print(f"   ✅ No unexpected account types found")
        
        if missing_types:
            print(f"   ⚠️  Expected types NOT found: {sorted(missing_types)}")
            print(f"   (This is OK if you don't have accounts of these types)")
        else:
            print(f"   ✅ All expected types present")
        
        # Show sample accounts (first 3 of each type)
        print(f"\n📋 Sample Accounts (first 3 of each type):")
        for acct_type in sorted(accounts_by_type.keys()):
            sample = accounts_by_type[acct_type][:3]
            for acc in sample:
                print(f"   [{acct_type}] {acc.get('accountnumber', 'N/A')} - {acc.get('accountname', 'N/A')}")
            if len(accounts_by_type[acct_type]) > 3:
                print(f"   ... and {len(accounts_by_type[acct_type]) - 3} more {acct_type} accounts")
        
        return True
        
    except requests.exceptions.ConnectionError:
        print(f"❌ ERROR: Could not connect to backend at {BASE_URL}")
        print(f"   Make sure the backend server is running")
        return False
    except Exception as e:
        print(f"❌ ERROR: {type(e).__name__}: {str(e)}")
        import traceback
        traceback.print_exc()
        return False


def main():
    print("="*80)
    print("NETSUITE ACCOUNT SEARCH VERIFICATION")
    print("="*80)
    
    # Test 1: Income keyword
    income_types = ['Income', 'OthIncome', 'COGS', 'Cost of Goods Sold', 'Expense', 'OthExpense']
    test1_passed = test_account_search('Income', income_types, 
                                      'Income Statement Accounts (Income keyword)')
    
    # Test 2: Balance keyword
    balance_types = ['Bank', 'AcctRec', 'OthCurrAsset', 'FixedAsset', 'OthAsset', 
                     'DeferExpense', 'UnbilledRec', 'AcctPay', 'CredCard', 
                     'OthCurrLiab', 'LongTermLiab', 'DeferRevenue', 'Equity', 'RetainedEarnings']
    test2_passed = test_account_search('Balance', balance_types,
                                      'Balance Sheet Accounts (Balance keyword)')
    
    # Test 3: AcctRec (exact account type)
    acctrec_types = ['AcctRec']
    test3_passed = test_account_search('AcctRec', acctrec_types,
                                      'Accounts Receivable (AcctRec exact type)')
    
    # Summary
    print(f"\n{'='*80}")
    print("TEST SUMMARY")
    print(f"{'='*80}")
    print(f"Income search:     {'✅ PASSED' if test1_passed else '❌ FAILED'}")
    print(f"Balance search:    {'✅ PASSED' if test2_passed else '❌ FAILED'}")
    print(f"AcctRec search:    {'✅ PASSED' if test3_passed else '❌ FAILED'}")
    
    all_passed = test1_passed and test2_passed and test3_passed
    print(f"\nOverall: {'✅ ALL TESTS PASSED' if all_passed else '❌ SOME TESTS FAILED'}")
    print(f"{'='*80}\n")
    
    return 0 if all_passed else 1


if __name__ == '__main__':
    sys.exit(main())

