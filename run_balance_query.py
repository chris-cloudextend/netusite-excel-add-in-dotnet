#!/usr/bin/env python3
"""Query NetSuite balance and save results to file"""

import json
import sys
import requests
from requests_oauthlib import OAuth1

# Load credentials
with open('backend-dotnet/appsettings.Development.json', 'r') as f:
    config = json.load(f)
    ns = config['NetSuite']

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

# Query parameters
account = "13000"
period = "May 2025"
subsidiary = "Celigo India Pvt Ltd"
book = 2

print(f"Querying balance for account {account}, period {period}, subsidiary {subsidiary}, book {book}")

# Step 1: Get period
period_query = f"SELECT id, startdate, enddate, periodname FROM accountingperiod WHERE periodname = '{period}' FETCH FIRST 1 ROWS ONLY"
print(f"\n1. Getting period info...")
period_resp = requests.post(suiteql_url, json={'q': period_query}, auth=auth, headers={'Prefer': 'transient'}, timeout=30)
period_data = period_resp.json()['items'][0]
period_id = period_data['id']
end_date = period_data['enddate'].split('T')[0]
print(f"   Period ID: {period_id}, End Date: {end_date}")

# Step 2: Get subsidiary
sub_query = f"SELECT id, name FROM subsidiary WHERE name = '{subsidiary}' FETCH FIRST 1 ROWS ONLY"
print(f"\n2. Getting subsidiary info...")
sub_resp = requests.post(suiteql_url, json={'q': sub_query}, auth=auth, headers={'Prefer': 'transient'}, timeout=30)
sub_data = sub_resp.json()['items'][0]
sub_id = sub_data['id']
print(f"   Subsidiary ID: {sub_id}")

# Step 3: Query balance
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
      AND t.trandate <= TO_DATE('{end_date}', 'YYYY-MM-DD')
      AND tal.accountingbook = {book}
) x
"""

print(f"\n3. Executing balance query...")
balance_resp = requests.post(suiteql_url, json={'q': balance_query}, auth=auth, headers={'Prefer': 'transient'}, timeout=180)
balance_result = balance_resp.json()

if balance_result.get('items') and len(balance_result['items']) > 0:
    balance = balance_result['items'][0].get('balance', 0)
    print(f"\n✅ NetSuite Balance: ${balance:,.2f}")
    
    # Save to file
    result = {
        'account': account,
        'period': period,
        'subsidiary': subsidiary,
        'book': book,
        'netsuite_balance': balance,
        'expected_balance': 8314265.34,
        'difference': balance - 8314265.34
    }
    
    with open('netsuite_balance_result.json', 'w') as f:
        json.dump(result, f, indent=2)
    
    print(f"   Expected: $8,314,265.34")
    print(f"   Difference: ${result['difference']:,.2f}")
    print(f"\n✅ Results saved to netsuite_balance_result.json")
else:
    print("❌ No balance returned")
    print(f"   Response: {json.dumps(balance_result, indent=2)}")

