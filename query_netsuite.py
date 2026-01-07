#!/usr/bin/env python3
"""
Standalone NetSuite Query Tool
Uses credentials from backend-dotnet/appsettings.Development.json to query NetSuite directly.
"""

import json
import sys
import requests
from requests_oauthlib import OAuth1
from datetime import datetime

# Load credentials from appsettings.Development.json
try:
    with open('backend-dotnet/appsettings.Development.json', 'r') as f:
        config = json.load(f)
        netsuite_config = config['NetSuite']
except FileNotFoundError:
    print("ERROR: backend-dotnet/appsettings.Development.json not found!")
    sys.exit(1)

account_id = netsuite_config['AccountId']
suiteql_url = f"https://{account_id}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql"

# Create OAuth1 authentication
auth = OAuth1(
    client_key=netsuite_config['ConsumerKey'],
    client_secret=netsuite_config['ConsumerSecret'],
    resource_owner_key=netsuite_config['TokenId'],
    resource_owner_secret=netsuite_config['TokenSecret'],
    realm=account_id,
    signature_method='HMAC-SHA256'
)

def query_netsuite(sql_query, timeout=30):
    """
    Execute a SuiteQL query against NetSuite.
    
    Args:
        sql_query: The SuiteQL query string
        timeout: Request timeout in seconds
        
    Returns:
        dict with 'items' (list of results) and 'hasMore' (bool)
    """
    try:
        response = requests.post(
            suiteql_url,
            json={'q': sql_query},
            auth=auth,
            headers={'Prefer': 'transient'},
            timeout=timeout
        )
        
        response.raise_for_status()
        return response.json()
    except requests.exceptions.RequestException as e:
        print(f"❌ Error querying NetSuite: {e}")
        if hasattr(e, 'response') and e.response is not None:
            print(f"   Response: {e.response.text}")
        return None

def test_connection():
    """Test the NetSuite connection with a simple query."""
    print("🔍 Testing NetSuite connection...")
    result = query_netsuite("SELECT 1 AS test")
    if result and 'items' in result:
        print("✅ Connection successful!")
        return True
    else:
        print("❌ Connection failed!")
        return False

def query_balance(account, period, subsidiary, accounting_book=2):
    """
    Query balance for a specific account, period, subsidiary, and accounting book.
    
    Args:
        account: Account number (e.g., "13000")
        period: Period name (e.g., "May 2025")
        subsidiary: Subsidiary name (e.g., "Celigo India Pvt Ltd")
        accounting_book: Accounting book ID (default: 2)
    """
    print(f"\n📊 Querying balance for:")
    print(f"   Account: {account}")
    print(f"   Period: {period}")
    print(f"   Subsidiary: {subsidiary}")
    print(f"   Accounting Book: {accounting_book}")
    
    # First, get the period ID and dates
    period_query = f"""
        SELECT id, startdate, enddate, periodname
        FROM accountingperiod
        WHERE periodname = '{period}'
        FETCH FIRST 1 ROWS ONLY
    """
    
    print(f"\n1️⃣  Getting period info for '{period}'...")
    period_result = query_netsuite(period_query)
    if not period_result or not period_result.get('items'):
        print(f"❌ Could not find period: {period}")
        return None
    
    period_data = period_result['items'][0]
    period_id = period_data['id']
    period_end_date = period_data['enddate']
    
    print(f"   ✅ Period ID: {period_id}")
    print(f"   ✅ End Date: {period_end_date}")
    
    # Get subsidiary ID
    subsidiary_query = f"""
        SELECT id, name
        FROM subsidiary
        WHERE name = '{subsidiary}'
        FETCH FIRST 1 ROWS ONLY
    """
    
    print(f"\n2️⃣  Getting subsidiary ID for '{subsidiary}'...")
    sub_result = query_netsuite(subsidiary_query)
    if not sub_result or not sub_result.get('items'):
        print(f"❌ Could not find subsidiary: {subsidiary}")
        return None
    
    sub_id = sub_result['items'][0]['id']
    print(f"   ✅ Subsidiary ID: {sub_id}")
    
    # Convert period end date to YYYY-MM-DD format
    # NetSuite returns dates in format like "2025-05-31T00:00:00.000Z"
    end_date_str = period_end_date.split('T')[0]
    
    # Build the balance query using transaction date (not posting period)
    # This matches what NetSuite's GL Balance report uses
    balance_query = f"""
        SELECT SUM(x.cons_amt) AS balance
        FROM (
            SELECT
                TO_NUMBER(
                    BUILTIN.CONSOLIDATE(
                        tal.amount,
                        'LEDGER',
                        'DEFAULT',
                        'DEFAULT',
                        {sub_id},
                        {period_id},
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
              AND t.trandate <= TO_DATE('{end_date_str}', 'YYYY-MM-DD')
              AND tal.accountingbook = {accounting_book}
        ) x
    """
    
    print(f"\n3️⃣  Executing balance query...")
    print(f"   Query (first 500 chars): {balance_query[:500]}...")
    
    balance_result = query_netsuite(balance_query, timeout=180)
    
    if not balance_result:
        print("❌ Query failed!")
        return None
    
    if balance_result.get('items') and len(balance_result['items']) > 0:
        balance = balance_result['items'][0].get('balance', 0)
        print(f"\n✅ Balance: ${balance:,.2f}")
        return balance
    else:
        print("⚠️  No results returned")
        return None

def query_transactions(account, period, subsidiary, accounting_book=2):
    """
    Query transactions for a specific account, period, subsidiary, and accounting book.
    """
    print(f"\n📋 Querying transactions for:")
    print(f"   Account: {account}")
    print(f"   Period: {period}")
    print(f"   Subsidiary: {subsidiary}")
    print(f"   Accounting Book: {accounting_book}")
    
    # Get period end date
    period_query = f"""
        SELECT id, startdate, enddate, periodname
        FROM accountingperiod
        WHERE periodname = '{period}'
        FETCH FIRST 1 ROWS ONLY
    """
    
    period_result = query_netsuite(period_query)
    if not period_result or not period_result.get('items'):
        print(f"❌ Could not find period: {period}")
        return None
    
    period_data = period_result['items'][0]
    period_end_date = period_data['enddate']
    end_date_str = period_end_date.split('T')[0]
    
    # Get subsidiary ID
    subsidiary_query = f"""
        SELECT id, name
        FROM subsidiary
        WHERE name = '{subsidiary}'
        FETCH FIRST 1 ROWS ONLY
    """
    
    sub_result = query_netsuite(subsidiary_query)
    if not sub_result or not sub_result.get('items'):
        print(f"❌ Could not find subsidiary: {subsidiary}")
        return None
    
    sub_id = sub_result['items'][0]['id']
    
    # Query transactions
    transactions_query = f"""
        SELECT 
            t.id AS transaction_id,
            t.tranid AS transaction_number,
            t.trandate,
            t.type AS transaction_type,
            CASE 
                WHEN t.type = 'VendBill' THEN 'Bill'
                WHEN t.type = 'Journal' THEN 'Journal'
                ELSE t.type
            END AS type_display,
            t.memo,
            tl.entity AS entity_name,
            tal.debit,
            tal.credit,
            tal.debit - tal.credit AS net_amount,
            tal.memo AS line_memo
        FROM transactionaccountingline tal
        JOIN transaction t ON t.id = tal.transaction
        JOIN account a ON a.id = tal.account
        LEFT JOIN transactionline tl ON t.id = tl.transaction AND tal.transactionline = tl.id
        WHERE t.posting = 'T'
          AND tal.posting = 'T'
          AND a.acctnumber = '{account}'
          AND t.trandate <= TO_DATE('{end_date_str}', 'YYYY-MM-DD')
          AND tal.accountingbook = {accounting_book}
          AND tl.subsidiary = {sub_id}
        ORDER BY t.trandate DESC, t.id DESC
        FETCH FIRST 100 ROWS ONLY
    """
    
    print(f"\n🔍 Executing transactions query...")
    result = query_netsuite(transactions_query, timeout=180)
    
    if not result:
        print("❌ Query failed!")
        return None
    
    items = result.get('items', [])
    print(f"\n✅ Found {len(items)} transactions")
    
    if items:
        print("\n📋 Transaction Details:")
        print("-" * 120)
        print(f"{'Type':<15} {'Number':<20} {'Date':<12} {'Debit':>15} {'Credit':>15} {'Net':>15} {'Memo':<30}")
        print("-" * 120)
        
        total_debit = 0
        total_credit = 0
        total_net = 0
        
        for item in items:
            tran_type = item.get('type_display', '')
            tran_num = item.get('transaction_number', '')
            tran_date = item.get('trandate', '')[:10] if item.get('trandate') else ''
            debit = float(item.get('debit', 0) or 0)
            credit = float(item.get('credit', 0) or 0)
            net = float(item.get('net_amount', 0) or 0)
            memo = (item.get('memo') or item.get('line_memo') or '')[:30]
            
            total_debit += debit
            total_credit += credit
            total_net += net
            
            print(f"{tran_type:<15} {tran_num:<20} {tran_date:<12} {debit:>15,.2f} {credit:>15,.2f} {net:>15,.2f} {memo:<30}")
        
        print("-" * 120)
        print(f"{'TOTALS':<47} {total_debit:>15,.2f} {total_credit:>15,.2f} {total_net:>15,.2f}")
    
    return items

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage:")
        print("  python query_netsuite.py test                                    # Test connection")
        print("  python query_netsuite.py balance <account> <period> <sub> [book] # Query balance")
        print("  python query_netsuite.py transactions <account> <period> <sub> [book] # Query transactions")
        print("\nExample:")
        print("  python query_netsuite.py balance 13000 'May 2025' 'Celigo India Pvt Ltd' 2")
        sys.exit(1)
    
    command = sys.argv[1].lower()
    
    if command == "test":
        test_connection()
    elif command == "balance":
        if len(sys.argv) < 5:
            print("❌ Usage: python query_netsuite.py balance <account> <period> <subsidiary> [book]")
            sys.exit(1)
        account = sys.argv[2]
        period = sys.argv[3]
        subsidiary = sys.argv[4]
        book = int(sys.argv[5]) if len(sys.argv) > 5 else 2
        query_balance(account, period, subsidiary, book)
    elif command == "transactions":
        if len(sys.argv) < 5:
            print("❌ Usage: python query_netsuite.py transactions <account> <period> <subsidiary> [book]")
            sys.exit(1)
        account = sys.argv[2]
        period = sys.argv[3]
        subsidiary = sys.argv[4]
        book = int(sys.argv[5]) if len(sys.argv) > 5 else 2
        query_transactions(account, period, subsidiary, book)
    else:
        print(f"❌ Unknown command: {command}")
        sys.exit(1)

