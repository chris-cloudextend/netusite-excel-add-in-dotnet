#!/usr/bin/env python3
"""
Live test of account search - actually queries the backend and shows results
"""

import requests
import json
import sys
from collections import Counter

BASE_URL = "https://netsuite-proxy.chris-corcoran.workers.dev"

def test_search(pattern, description):
    """Test account search and show detailed results"""
    print(f"\n{'='*80}")
    print(f"TEST: {description}")
    print(f"Pattern: '{pattern}'")
    print(f"{'='*80}")
    
    url = f"{BASE_URL}/accounts/search"
    params = {
        'pattern': pattern,
        'active_only': 'true'
    }
    
    try:
        print(f"\n📡 Request: GET {url}")
        print(f"   Params: {params}")
        
        response = requests.get(url, params=params, timeout=30)
        
        print(f"\n📥 Response Status: {response.status_code}")
        
        if response.status_code != 200:
            print(f"❌ ERROR: HTTP {response.status_code}")
            print(f"Response: {response.text}")
            return None
        
        data = response.json()
        
        if 'error' in data:
            print(f"❌ ERROR: {data['error']}")
            return None
        
        accounts = data.get('accounts', [])
        count = data.get('count', len(accounts))
        search_type = data.get('search_type', 'unknown')
        
        print(f"\n✅ Query successful")
        print(f"   Search Type: {search_type}")
        print(f"   Total accounts returned: {count}")
        
        if count == 0:
            print(f"\n⚠️  No accounts returned")
            return []
        
        # Count accounts by type
        type_counts = Counter()
        for acc in accounts:
            acct_type = acc.get('accttype', 'Unknown')
            type_counts[acct_type] += 1
        
        print(f"\n📊 Account Types Returned ({len(type_counts)} unique types):")
        for acct_type, count in sorted(type_counts.items()):
            print(f"   {acct_type}: {count} accounts")
        
        # Show first 10 accounts
        print(f"\n📋 First 10 Accounts:")
        for i, acc in enumerate(accounts[:10], 1):
            acct_num = acc.get('accountnumber', 'N/A')
            acct_name = acc.get('accountname', 'N/A')
            acct_type = acc.get('accttype', 'Unknown')
            print(f"   {i}. [{acct_type}] {acct_num} - {acct_name}")
        
        if len(accounts) > 10:
            print(f"   ... and {len(accounts) - 10} more accounts")
        
        return list(type_counts.keys())
        
    except Exception as e:
        print(f"❌ ERROR: {type(e).__name__}: {str(e)}")
        import traceback
        traceback.print_exc()
        return None


def main():
    print("="*80)
    print("LIVE ACCOUNT SEARCH TEST - Querying Actual Backend")
    print("="*80)
    
    # Test 1: Balance
    print("\n" + "="*80)
    print("TEST 1: Balance Search")
    print("="*80)
    balance_types = test_search('Balance', 'Balance Sheet Accounts (Balance keyword)')
    
    expected_balance_types = {'Bank', 'AcctRec', 'OthCurrAsset', 'FixedAsset', 'OthAsset', 
                              'DeferExpense', 'UnbilledRec', 'AcctPay', 'CredCard', 
                              'OthCurrLiab', 'LongTermLiab', 'DeferRevenue', 'Equity', 'RetainedEarnings'}
    
    if balance_types:
        returned_set = set(balance_types)
        unexpected = returned_set - expected_balance_types
        missing = expected_balance_types - returned_set
        
        print(f"\n🔍 Verification:")
        print(f"   Expected Balance Sheet types: {len(expected_balance_types)}")
        print(f"   Returned types: {len(returned_set)}")
        
        if unexpected:
            print(f"   ❌ UNEXPECTED types: {sorted(unexpected)}")
        else:
            print(f"   ✅ No unexpected types")
        
        if missing:
            print(f"   ⚠️  Missing types (OK if no accounts exist): {sorted(missing)}")
        else:
            print(f"   ✅ All expected types present")
    
    # Test 2: Bank
    print("\n" + "="*80)
    print("TEST 2: Bank Search")
    print("="*80)
    bank_types = test_search('Bank', 'Bank Accounts (Bank exact type)')
    
    if bank_types:
        returned_set = set(bank_types)
        expected_bank = {'Bank'}
        
        print(f"\n🔍 Verification:")
        print(f"   Expected types: {expected_bank}")
        print(f"   Returned types: {returned_set}")
        
        if returned_set == expected_bank:
            print(f"   ✅ CORRECT: Only Bank accounts returned")
        else:
            unexpected = returned_set - expected_bank
            print(f"   ❌ INCORRECT: Unexpected types found: {sorted(unexpected)}")
    
    print(f"\n{'='*80}")
    print("TEST COMPLETE")
    print(f"{'='*80}\n")


if __name__ == '__main__':
    main()

