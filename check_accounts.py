#!/usr/bin/env python3
"""Check if specific accounts exist"""

import json
import requests
from requests_oauthlib import OAuth1

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

# Check if accounts exist
accounts = ['4000', '40000', '40100', '40200', '40210', '40220', '40300', '40400', '40410', '40420', '40500', '4050', '4100']
account_filter = "', '".join(accounts)

query = f"""
    SELECT acctnumber, accttype, accountsearchdisplaynamecopy AS name
    FROM account
    WHERE acctnumber IN ('{account_filter}')
    ORDER BY acctnumber
"""

response = requests.post(suiteql_url, json={'q': query}, auth=auth, headers={'Prefer': 'transient'}, timeout=30)
result = response.json()
items = result.get('items', [])

print(f'Found {len(items)} accounts:')
for item in items:
    print(f"  {item.get('acctnumber')}: {item.get('name')} ({item.get('accttype')})")
