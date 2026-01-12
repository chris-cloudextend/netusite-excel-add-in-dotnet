#!/usr/bin/env python3
"""Simple test to verify NetSuite connection"""

import json
import sys

# Load credentials
try:
    with open('backend-dotnet/appsettings.Development.json', 'r') as f:
        config = json.load(f)
        ns = config['NetSuite']
    print(f"✅ Loaded config for account: {ns['AccountId']}")
    print(f"   ConsumerKey: {ns['ConsumerKey'][:20]}...")
except Exception as e:
    print(f"❌ Error loading config: {e}")
    sys.exit(1)

# Try importing required library
try:
    import requests
    from requests_oauthlib import OAuth1
    print("✅ Required libraries available")
except ImportError as e:
    print(f"❌ Missing library: {e}")
    print("   Install with: pip3 install requests-oauthlib")
    sys.exit(1)

# Test connection
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

print(f"\n🔍 Testing connection to: {suiteql_url}")
try:
    response = requests.post(
        suiteql_url,
        json={'q': 'SELECT 1 AS test'},
        auth=auth,
        headers={'Prefer': 'transient'},
        timeout=30
    )
    response.raise_for_status()
    result = response.json()
    print(f"✅ Connection successful!")
    print(f"   Response: {result}")
except Exception as e:
    print(f"❌ Connection failed: {e}")
    if hasattr(e, 'response') and e.response is not None:
        print(f"   Status: {e.response.status_code}")
        print(f"   Body: {e.response.text[:500]}")

