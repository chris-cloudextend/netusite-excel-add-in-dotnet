#!/usr/bin/env python3
"""
Test script to compare performance of:
1. Querying ALL income accounts for January 2025
2. Querying just 35 specific accounts for January 2025
"""

import json
import sys
import time
import requests
from requests_oauthlib import OAuth1

# Load credentials
try:
    with open('backend-dotnet/appsettings.Development.json', 'r') as f:
        config = json.load(f)
        ns = config['NetSuite']
except FileNotFoundError:
    print("ERROR: backend-dotnet/appsettings.Development.json not found!")
    sys.exit(1)

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

def query_netsuite(sql_query, timeout=300):
    """Execute a SuiteQL query against NetSuite."""
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

# Test parameters
period = "Jan 2025"
subsidiary = "Celigo Inc. (Consolidated)"  # Will strip (Consolidated) suffix
accounting_book = 1  # Primary book

# Specific accounts from the image (deduplicated)
specific_accounts = ['4000', '40000', '40100', '40200', '40210', '40220', '40300', 
                     '40400', '40410', '40420', '40500', '4050', '4100']

print("=" * 80)
print("INCOME ACCOUNT PRELOAD PERFORMANCE TEST")
print("=" * 80)
print(f"Period: {period}")
print(f"Subsidiary: {subsidiary}")
print(f"Accounting Book: {accounting_book}")
print()

# Step 1: Get period ID
print("1️⃣  Getting period ID...")
period_query = f"""
    SELECT id, periodname
    FROM accountingperiod
    WHERE periodname = '{period}'
    FETCH FIRST 1 ROWS ONLY
"""
period_result = query_netsuite(period_query, timeout=30)
if not period_result or not period_result.get('items'):
    print(f"❌ Could not find period: {period}")
    sys.exit(1)

period_id = period_result['items'][0]['id']
print(f"   ✅ Period ID: {period_id}")
print()

# Step 2: Get subsidiary ID (strip Consolidated suffix)
print("2️⃣  Getting subsidiary ID...")
subsidiary_name = subsidiary.replace(' (Consolidated)', '').strip()
sub_query = f"""
    SELECT id, name
    FROM subsidiary
    WHERE name = '{subsidiary_name}'
    FETCH FIRST 1 ROWS ONLY
"""
sub_result = query_netsuite(sub_query, timeout=30)
if not sub_result or not sub_result.get('items'):
    print(f"❌ Could not find subsidiary: {subsidiary_name}")
    sys.exit(1)

sub_id = sub_result['items'][0]['id']
print(f"   ✅ Subsidiary ID: {sub_id}")
print()

# Step 3: Get ALL income accounts count
print("3️⃣  Getting count of ALL income accounts...")
all_accounts_query = """
    SELECT COUNT(*) AS account_count
    FROM account
    WHERE isinactive = 'F'
      AND accttype IN ('Income', 'OthIncome', 'COGS', 'Expense', 'OthExpense', 'Cost of Goods Sold')
"""
all_count_result = query_netsuite(all_accounts_query, timeout=30)
if not all_count_result or not all_count_result.get('items'):
    print("❌ Could not get account count")
    sys.exit(1)

total_accounts = all_count_result['items'][0].get('account_count', 0)
print(f"   ✅ Total income accounts: {total_accounts}")
print()

# Step 4: Test 1 - Query ALL income accounts for Jan 2025
print("=" * 80)
print("TEST 1: Querying ALL income accounts for Jan 2025")
print("=" * 80)

all_accounts_query_sql = f"""
    SELECT 
        a.acctnumber,
        ap.periodname,
        SUM(
            TO_NUMBER(
                BUILTIN.CONSOLIDATE(
                    tal.amount,
                    'LEDGER',
                    'DEFAULT',
                    'DEFAULT',
                    {sub_id},
                    t.postingperiod,
                    'DEFAULT'
                )
            ) * CASE WHEN a.accttype IN ('Income', 'OthIncome') THEN -1 ELSE 1 END
        ) AS balance
    FROM transactionaccountingline tal
    JOIN transaction t ON t.id = tal.transaction
    JOIN account a ON a.id = tal.account
    JOIN accountingperiod ap ON ap.id = t.postingperiod
    JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
    WHERE t.posting = 'T'
      AND tal.posting = 'T'
      AND a.accttype IN ('Income', 'OthIncome', 'COGS', 'Expense', 'OthExpense', 'Cost of Goods Sold')
      AND t.postingperiod = {period_id}
      AND tal.accountingbook = {accounting_book}
      AND a.isinactive = 'F'
    GROUP BY a.acctnumber, ap.periodname
    ORDER BY a.acctnumber
"""

print("   Executing query...")
start_time = time.time()
all_result = query_netsuite(all_accounts_query_sql, timeout=600)  # 10 minute timeout
all_elapsed = time.time() - start_time

if not all_result:
    print("   ❌ Query failed!")
    sys.exit(1)

all_items = all_result.get('items', [])
all_accounts_returned = len(all_items)
print(f"   ✅ Query completed in {all_elapsed:.2f} seconds")
print(f"   ✅ Accounts returned: {all_accounts_returned}")
print()

# Step 5: Test 2 - Query specific 35 accounts for Jan 2025
print("=" * 80)
print("TEST 2: Querying 35 specific accounts for Jan 2025")
print("=" * 80)

# Build account filter
account_filter = "', '".join(specific_accounts)

specific_accounts_query_sql = f"""
    SELECT 
        a.acctnumber,
        ap.periodname,
        SUM(
            TO_NUMBER(
                BUILTIN.CONSOLIDATE(
                    tal.amount,
                    'LEDGER',
                    'DEFAULT',
                    'DEFAULT',
                    {sub_id},
                    t.postingperiod,
                    'DEFAULT'
                )
            ) * CASE WHEN a.accttype IN ('Income', 'OthIncome') THEN -1 ELSE 1 END
        ) AS balance
    FROM transactionaccountingline tal
    JOIN transaction t ON t.id = tal.transaction
    JOIN account a ON a.id = tal.account
    JOIN accountingperiod ap ON ap.id = t.postingperiod
    JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
    WHERE t.posting = 'T'
      AND tal.posting = 'T'
      AND a.acctnumber IN ('{account_filter}')
      AND t.postingperiod = {period_id}
      AND tal.accountingbook = {accounting_book}
    GROUP BY a.acctnumber, ap.periodname
    ORDER BY a.acctnumber
"""

print(f"   Accounts: {', '.join(specific_accounts)}")
print("   Executing query...")
start_time = time.time()
specific_result = query_netsuite(specific_accounts_query_sql, timeout=600)  # 10 minute timeout
specific_elapsed = time.time() - start_time

if not specific_result:
    print("   ❌ Query failed!")
    sys.exit(1)

specific_items = specific_result.get('items', [])
specific_accounts_returned = len(specific_items)
print(f"   ✅ Query completed in {specific_elapsed:.2f} seconds")
print(f"   ✅ Accounts returned: {specific_accounts_returned}")
print()

# Step 6: Results comparison
print("=" * 80)
print("RESULTS COMPARISON")
print("=" * 80)
print(f"All Income Accounts Query:")
print(f"   Time: {all_elapsed:.2f} seconds")
print(f"   Accounts: {all_accounts_returned}")
print(f"   Time per account: {all_elapsed / max(all_accounts_returned, 1):.4f} seconds")
print()
print(f"35 Specific Accounts Query:")
print(f"   Time: {specific_elapsed:.2f} seconds")
print(f"   Accounts: {specific_accounts_returned}")
print(f"   Time per account: {specific_elapsed / max(specific_accounts_returned, 1):.4f} seconds")
print()
print(f"Performance Ratio:")
if specific_elapsed > 0:
    ratio = all_elapsed / specific_elapsed
    print(f"   All accounts query is {ratio:.2f}x slower than specific accounts query")
    print(f"   (or {((ratio - 1) * 100):.1f}% slower)")
else:
    print("   Cannot calculate ratio (specific query was too fast)")
print()

# Calculate efficiency
if all_accounts_returned > 0 and specific_accounts_returned > 0:
    accounts_ratio = all_accounts_returned / specific_accounts_returned
    time_ratio = all_elapsed / specific_elapsed
    efficiency = accounts_ratio / time_ratio if time_ratio > 0 else 0
    print(f"Efficiency Analysis:")
    print(f"   All query returns {accounts_ratio:.1f}x more accounts")
    print(f"   All query takes {time_ratio:.1f}x longer")
    print(f"   Efficiency: {efficiency:.2f} (higher is better - means getting more accounts per unit time)")
    print()

print("=" * 80)
print("CONCLUSION")
print("=" * 80)
if all_elapsed < specific_elapsed * 2:
    print("✅ Pre-caching ALL income accounts is EFFICIENT")
    print("   The overhead of querying all accounts is reasonable compared to")
    print("   querying a subset. Pre-caching would benefit users building full")
    print("   income statements.")
else:
    print("⚠️  Pre-caching ALL income accounts has SIGNIFICANT OVERHEAD")
    print("   The query time increases substantially. Consider:")
    print("   - Limiting to top N accounts by activity")
    print("   - Using smart pre-caching (only if user uses >X accounts)")
    print("   - Keeping current batching approach for small subsets")
print()
