#!/usr/bin/env python3
import json
import sys
import os

# Change to script directory
os.chdir(os.path.dirname(os.path.abspath(__file__)))

try:
    import requests
    from requests_oauthlib import OAuth1
except ImportError:
    result = {"error": "Missing library: pip3 install requests-oauthlib"}
    with open("query_result.json", "w") as f:
        json.dump(result, f, indent=2)
    print(json.dumps(result, indent=2))
    sys.exit(1)

# Load credentials
try:
    with open('backend-dotnet/appsettings.Development.json', 'r') as f:
        config = json.load(f)
        ns = config['NetSuite']
except Exception as e:
    result = {"error": f"Failed to load config: {e}"}
    with open("query_result.json", "w") as f:
        json.dump(result, f, indent=2)
    print(json.dumps(result, indent=2))
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

account = "13000"
period = "May 2025"
subsidiary = "Celigo India Pvt Ltd"
book = 2

result = {
    "account": account,
    "period": period,
    "subsidiary": subsidiary,
    "book": book,
    "steps": []
}

try:
    # Step 1: Get period
    period_query = f"SELECT id, startdate, enddate, periodname FROM accountingperiod WHERE periodname = '{period}' FETCH FIRST 1 ROWS ONLY"
    result["steps"].append({"step": 1, "action": "Get period info", "query": period_query})
    
    period_resp = requests.post(suiteql_url, json={'q': period_query}, auth=auth, headers={'Prefer': 'transient'}, timeout=30)
    period_resp.raise_for_status()
    period_data = period_resp.json()['items'][0]
    period_id = period_data['id']
    end_date = period_data['enddate'].split('T')[0]
    result["steps"].append({"step": 1, "result": "success", "period_id": period_id, "end_date": end_date})

    # Step 2: Get subsidiary
    sub_query = f"SELECT id, name FROM subsidiary WHERE name = '{subsidiary}' FETCH FIRST 1 ROWS ONLY"
    result["steps"].append({"step": 2, "action": "Get subsidiary info", "query": sub_query})
    
    sub_resp = requests.post(suiteql_url, json={'q': sub_query}, auth=auth, headers={'Prefer': 'transient'}, timeout=30)
    sub_resp.raise_for_status()
    sub_data = sub_resp.json()['items'][0]
    sub_id = sub_data['id']
    result["steps"].append({"step": 2, "result": "success", "subsidiary_id": sub_id})

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
    result["steps"].append({"step": 3, "action": "Query balance", "query": balance_query.strip()})
    
    balance_resp = requests.post(suiteql_url, json={'q': balance_query}, auth=auth, headers={'Prefer': 'transient'}, timeout=180)
    balance_resp.raise_for_status()
    balance_result = balance_resp.json()

    if balance_result.get('items') and len(balance_result['items']) > 0:
        balance = balance_result['items'][0].get('balance', 0)
        result["netsuite_balance"] = float(balance)
        result["expected_balance"] = 8314265.34
        result["difference"] = float(balance) - 8314265.34
        result["success"] = True
        result["steps"].append({"step": 3, "result": "success", "balance": float(balance)})
    else:
        result["success"] = False
        result["error"] = "No balance returned"
        result["balance_result"] = balance_result
        result["steps"].append({"step": 3, "result": "no_data", "response": balance_result})

except Exception as e:
    result["success"] = False
    result["error"] = str(e)
    result["error_type"] = type(e).__name__
    import traceback
    result["traceback"] = traceback.format_exc()

# Write to file and print
with open("query_result.json", "w") as f:
    json.dump(result, f, indent=2)

print(json.dumps(result, indent=2))

