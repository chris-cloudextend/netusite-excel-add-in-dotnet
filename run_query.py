#!/usr/bin/env python3
import json, sys, os
os.chdir(os.path.dirname(os.path.abspath(__file__)))

try:
    import requests
    from requests_oauthlib import OAuth1
except:
    print(json.dumps({"error": "Install: pip3 install requests-oauthlib"}))
    sys.exit(1)

with open('backend-dotnet/appsettings.Development.json') as f:
    ns = json.load(f)['NetSuite']

auth = OAuth1(ns['ConsumerKey'], ns['ConsumerSecret'], ns['TokenId'], ns['TokenSecret'], realm=ns['AccountId'], signature_method='HMAC-SHA256')
url = f"https://{ns['AccountId']}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql"

# Get period
p = requests.post(url, json={'q': "SELECT id, enddate FROM accountingperiod WHERE periodname = 'May 2025' FETCH FIRST 1 ROWS ONLY"}, auth=auth, headers={'Prefer': 'transient'}, timeout=30)
pid = p.json()['items'][0]['id']
edate = p.json()['items'][0]['enddate'].split('T')[0]

# Get subsidiary  
s = requests.post(url, json={'q': "SELECT id FROM subsidiary WHERE name = 'Celigo India Pvt Ltd' FETCH FIRST 1 ROWS ONLY"}, auth=auth, headers={'Prefer': 'transient'}, timeout=30)
sid = s.json()['items'][0]['id']

# Query balance
q = f"""SELECT SUM(x.cons_amt) AS balance FROM (SELECT TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', {sid}, {pid}, 'DEFAULT')) * CASE WHEN a.accttype IN ('AcctPay', 'CredCard', 'OthCurrLiab', 'LongTermLiab', 'Equity', 'OthIncome', 'Income') THEN -1 ELSE 1 END AS cons_amt FROM transactionaccountingline tal JOIN transaction t ON t.id = tal.transaction JOIN account a ON a.id = tal.account WHERE t.posting = 'T' AND tal.posting = 'T' AND a.acctnumber = '13000' AND t.trandate <= TO_DATE('{edate}', 'YYYY-MM-DD') AND tal.accountingbook = 2) x"""
b = requests.post(url, json={'q': q}, auth=auth, headers={'Prefer': 'transient'}, timeout=180)
bal = float(b.json()['items'][0]['balance']) if b.json().get('items') else 0

result = {"netsuite_balance": bal, "expected": 8314265.34, "difference": bal - 8314265.34}
with open('result.json', 'w') as f:
    json.dump(result, f, indent=2)
print(json.dumps(result, indent=2))

