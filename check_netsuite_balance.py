#!/usr/bin/env python3
"""
Query NetSuite balance for account 13000, May 2025, book 2, subsidiary Celigo India Pvt Ltd
"""

import json
import sys
import os

# Ensure we're in the right directory
script_dir = os.path.dirname(os.path.abspath(__file__))
os.chdir(script_dir)

# Check for required library
try:
    import requests
    from requests_oauthlib import OAuth1
except ImportError:
    print("ERROR: Missing required library 'requests-oauthlib'")
    print("Install with: pip3 install requests-oauthlib")
    sys.exit(1)

# Load credentials
config_path = os.path.join(script_dir, 'backend-dotnet', 'appsettings.Development.json')
if not os.path.exists(config_path):
    print(f"ERROR: Config file not found at: {config_path}")
    sys.exit(1)

try:
    with open(config_path, 'r') as f:
        config = json.load(f)
        ns = config['NetSuite']
except Exception as e:
    print(f"ERROR: Failed to load config: {e}")
    sys.exit(1)

# Setup OAuth
account_id = ns['AccountId']
suiteql_url = f"https://{account_id}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql"

auth = OAuth1(
    client_key=ns['ConsumerKey'],
    client_secret=ns['ConsumerSecret'],
    resource_owner_key=ns['TokenId'],
    resource_owner_secret=ns['TokenSecret'],
    realm=account_id,
    signature_method='HMAC-SHA256'
)

# Parameters
account = "13000"
period = "May 2025"
subsidiary = "Celigo India Pvt Ltd"
book = 2

print(f"Querying NetSuite balance:")
print(f"  Account: {account}")
print(f"  Period: {period}")
print(f"  Subsidiary: {subsidiary}")
print(f"  Book: {book}")
print()

try:
    # Step 1: Get period
    print("Step 1: Getting period info...")
    period_query = f"SELECT id, startdate, enddate, periodname FROM accountingperiod WHERE periodname = '{period}' FETCH FIRST 1 ROWS ONLY"
    period_resp = requests.post(suiteql_url, json={'q': period_query}, auth=auth, headers={'Prefer': 'transient'}, timeout=30)
    period_resp.raise_for_status()
    period_data = period_resp.json()['items'][0]
    period_id = period_data['id']
    
    # Parse end date - NetSuite returns it in various formats
    end_date_raw = period_data['enddate']
    if 'T' in end_date_raw:
        # ISO format: "2025-05-31T00:00:00.000Z"
        end_date = end_date_raw.split('T')[0]
    else:
        # Date format: "5/31/2025" - need to convert to YYYY-MM-DD
        from datetime import datetime
        try:
            # Try parsing as M/D/YYYY
            dt = datetime.strptime(end_date_raw, '%m/%d/%Y')
            end_date = dt.strftime('%Y-%m-%d')
        except:
            # Fallback: assume it's already in correct format
            end_date = end_date_raw
    
    print(f"  ✓ Period ID: {period_id}, End Date: {end_date} (raw: {end_date_raw})")

    # Step 2: Get subsidiary
    print("\nStep 2: Getting subsidiary info...")
    sub_query = f"SELECT id, name FROM subsidiary WHERE name = '{subsidiary}' FETCH FIRST 1 ROWS ONLY"
    sub_resp = requests.post(suiteql_url, json={'q': sub_query}, auth=auth, headers={'Prefer': 'transient'}, timeout=30)
    sub_resp.raise_for_status()
    sub_data = sub_resp.json()['items'][0]
    sub_id = sub_data['id']
    print(f"  ✓ Subsidiary ID: {sub_id}")

    # Step 3: Query balance
    print("\nStep 3: Executing balance query (this may take a minute)...")
    # Escape account number to prevent SQL injection
    account_escaped = account.replace("'", "''")
    
    # Build query matching BalanceService format exactly
    # Note: For subsidiary filtering, we need TransactionLine join
    balance_query = f"""SELECT SUM(x.cons_amt) AS balance
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
    JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
    WHERE t.posting = 'T'
      AND tal.posting = 'T'
      AND a.acctnumber = '{account_escaped}'
      AND t.trandate <= TO_DATE('{end_date}', 'YYYY-MM-DD')
      AND tal.accountingbook = {book}
      AND tl.subsidiary = {sub_id}
) x"""
    balance_resp = requests.post(suiteql_url, json={'q': balance_query}, auth=auth, headers={'Prefer': 'transient'}, timeout=180)
    balance_resp.raise_for_status()
    balance_result = balance_resp.json()

    if balance_result.get('items') and len(balance_result['items']) > 0:
        balance = float(balance_result['items'][0].get('balance', 0))
        expected = 8314265.34
        difference = balance - expected
        
        print(f"\n{'='*60}")
        print(f"RESULTS:")
        print(f"{'='*60}")
        print(f"NetSuite Balance:    ${balance:,.2f}")
        print(f"Expected Balance:   ${expected:,.2f}")
        print(f"Difference:         ${difference:,.2f}")
        print(f"{'='*60}")
        
        # Save to file
        result = {
            "account": account,
            "period": period,
            "subsidiary": subsidiary,
            "book": book,
            "netsuite_balance": balance,
            "expected_balance": expected,
            "difference": difference
        }
        
        result_file = os.path.join(script_dir, 'netsuite_balance_result.json')
        with open(result_file, 'w') as f:
            json.dump(result, f, indent=2)
        print(f"\nResults saved to: {result_file}")
    else:
        print("ERROR: No balance returned from NetSuite")
        print(f"Response: {json.dumps(balance_result, indent=2)}")
        sys.exit(1)

except requests.exceptions.RequestException as e:
    print(f"ERROR: NetSuite API request failed: {e}")
    if hasattr(e, 'response') and e.response is not None:
        print(f"Status Code: {e.response.status_code}")
        print(f"Response: {e.response.text[:500]}")
    sys.exit(1)
except Exception as e:
    print(f"ERROR: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)

