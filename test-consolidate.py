#!/usr/bin/env python3
"""
Test script to compare BUILTIN.CONSOLIDATE vs raw tal.amount for book 2, Celigo India Pvt Ltd
"""
import json
import requests
import sys

SERVER_URL = "http://localhost:5002"
SUBSIDIARY_NAME = "Celigo India Pvt Ltd"
ACCOUNTING_BOOK = "2"

print("=" * 70)
print("Testing CONSOLIDATE vs Raw Amount for Book 2, India Subsidiary")
print("=" * 70)
print()

# Step 1: Get subsidiary ID
print("Step 1: Getting subsidiary ID...")
try:
    response = requests.get(f"{SERVER_URL}/lookups/all", timeout=10)
    if response.status_code == 200:
        data = response.json()
        subsidiaries = data.get("subsidiaries", [])
        sub_id = None
        for sub in subsidiaries:
            if sub.get("name") == SUBSIDIARY_NAME:
                sub_id = sub.get("id")
                break
        
        if not sub_id:
            # Try from book-subsidiary endpoint
            response2 = requests.get(f"{SERVER_URL}/lookups/accountingbook/{ACCOUNTING_BOOK}/subsidiaries", timeout=10)
            if response2.status_code == 200:
                data2 = response2.json()
                subs = data2.get("subsidiaries", [])
                if subs:
                    sub_id = subs[0].get("id")
        
        if not sub_id:
            print(f"   ⚠️  Could not find subsidiary ID, using default 2")
            sub_id = "2"
        else:
            print(f"   ✅ Subsidiary ID: {sub_id}")
    else:
        print(f"   ⚠️  Server returned {response.status_code}, using default ID 2")
        sub_id = "2"
except Exception as e:
    print(f"   ⚠️  Error: {e}, using default ID 2")
    sub_id = "2"

print()

# Test queries - simplified for March 2025 only
print("=" * 70)
print("TEST 1: Query WITHOUT BUILTIN.CONSOLIDATE (Raw tal.amount)")
print("=" * 70)

query1 = f"""
SELECT 
    a.accttype AS account_type,
    SUM(CASE WHEN a.accttype IN ('Income', 'OthIncome') THEN -tal.amount ELSE tal.amount END) AS total_amount,
    COUNT(*) AS transaction_count
FROM transactionaccountingline tal
JOIN transaction t ON t.id = tal.transaction
JOIN account a ON a.id = tal.account
JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
WHERE t.posting = 'T'
  AND tal.posting = 'T'
  AND a.accttype = 'Income'
  AND a.isinactive = 'F'
  AND tal.accountingbook = {ACCOUNTING_BOOK}
  AND tl.subsidiary = {sub_id}
  AND t.postingperiod IN (SELECT id FROM accountingperiod WHERE periodname LIKE 'Mar 2025')
GROUP BY a.accttype
"""

print("Query:")
print(query1.strip())
print()

try:
    response1 = requests.post(
        f"{SERVER_URL}/test/query",
        json={"q": query1.strip(), "timeout": 60},
        timeout=70
    )
    if response1.status_code == 200:
        data1 = response1.json()
        print("Response:")
        print(json.dumps(data1, indent=2))
        amount1 = None
        if data1.get("results") and len(data1["results"]) > 0:
            result = data1["results"][0]
            amount1 = result.get("total_amount") or result.get("amount")
            count1 = result.get("transaction_count")
            print(f"\n   Income Amount (raw): {amount1}")
            print(f"   Transaction Count: {count1}")
        else:
            print("\n   ⚠️  No results returned")
            amount1 = None
    else:
        print(f"   ❌ Error: {response1.status_code}")
        print(response1.text)
        amount1 = None
except Exception as e:
    print(f"   ❌ Error: {e}")
    amount1 = None

print()
print("=" * 70)
print("TEST 2: Query WITH BUILTIN.CONSOLIDATE (Current Approach)")
print("=" * 70)

query2 = f"""
SELECT 
    a.accttype AS account_type,
    SUM(
        CASE WHEN a.accttype IN ('Income', 'OthIncome') THEN 
            -TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', {sub_id}, t.postingperiod, 'DEFAULT'))
        ELSE 
            TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', {sub_id}, t.postingperiod, 'DEFAULT'))
        END
    ) AS total_amount,
    COUNT(*) AS transaction_count
FROM transactionaccountingline tal
JOIN transaction t ON t.id = tal.transaction
JOIN account a ON a.id = tal.account
JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
WHERE t.posting = 'T'
  AND tal.posting = 'T'
  AND a.accttype = 'Income'
  AND a.isinactive = 'F'
  AND tal.accountingbook = {ACCOUNTING_BOOK}
  AND tl.subsidiary = {sub_id}
  AND t.postingperiod IN (SELECT id FROM accountingperiod WHERE periodname LIKE 'Mar 2025')
GROUP BY a.accttype
"""

print("Query:")
print(query2.strip())
print()

try:
    response2 = requests.post(
        f"{SERVER_URL}/test/query",
        json={"q": query2.strip(), "timeout": 60},
        timeout=70
    )
    if response2.status_code == 200:
        data2 = response2.json()
        print("Response:")
        print(json.dumps(data2, indent=2))
        amount2 = None
        if data2.get("results") and len(data2["results"]) > 0:
            result = data2["results"][0]
            amount2 = result.get("total_amount") or result.get("amount")
            count2 = result.get("transaction_count")
            print(f"\n   Income Amount (consolidate): {amount2}")
            print(f"   Transaction Count: {count2}")
        else:
            print("\n   ⚠️  No results returned")
            amount2 = None
    else:
        print(f"   ❌ Error: {response2.status_code}")
        print(response2.text)
        amount2 = None
except Exception as e:
    print(f"   ❌ Error: {e}")
    amount2 = None

print()
print("=" * 70)
print("TEST 3: Query WITH COALESCE (New Approach)")
print("=" * 70)

query3 = f"""
SELECT 
    a.accttype AS account_type,
    SUM(
        CASE WHEN a.accttype IN ('Income', 'OthIncome') THEN 
            -COALESCE(
                TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', {sub_id}, t.postingperiod, 'DEFAULT')),
                tal.amount
            )
        ELSE 
            COALESCE(
                TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', {sub_id}, t.postingperiod, 'DEFAULT')),
                tal.amount
            )
        END
    ) AS total_amount,
    COUNT(*) AS transaction_count
FROM transactionaccountingline tal
JOIN transaction t ON t.id = tal.transaction
JOIN account a ON a.id = tal.account
JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
WHERE t.posting = 'T'
  AND tal.posting = 'T'
  AND a.accttype = 'Income'
  AND a.isinactive = 'F'
  AND tal.accountingbook = {ACCOUNTING_BOOK}
  AND tl.subsidiary = {sub_id}
  AND t.postingperiod IN (SELECT id FROM accountingperiod WHERE periodname LIKE 'Mar 2025')
GROUP BY a.accttype
"""

print("Query:")
print(query3.strip())
print()

try:
    response3 = requests.post(
        f"{SERVER_URL}/test/query",
        json={"q": query3.strip(), "timeout": 60},
        timeout=70
    )
    if response3.status_code == 200:
        data3 = response3.json()
        print("Response:")
        print(json.dumps(data3, indent=2))
        amount3 = None
        if data3.get("results") and len(data3["results"]) > 0:
            result = data3["results"][0]
            amount3 = result.get("total_amount") or result.get("amount")
            count3 = result.get("transaction_count")
            print(f"\n   Income Amount (coalesce): {amount3}")
            print(f"   Transaction Count: {count3}")
        else:
            print("\n   ⚠️  No results returned")
            amount3 = None
    else:
        print(f"   ❌ Error: {response3.status_code}")
        print(response3.text)
        amount3 = None
except Exception as e:
    print(f"   ❌ Error: {e}")
    amount3 = None

print()
print("=" * 70)
print("COMPARISON SUMMARY")
print("=" * 70)
print()
print(f"Query 1 (NO CONSOLIDATE):     Amount={amount1}, Count={count1 if 'count1' in locals() else 'N/A'}")
print(f"Query 2 (WITH CONSOLIDATE):   Amount={amount2}, Count={count2 if 'count2' in locals() else 'N/A'}")
print(f"Query 3 (WITH COALESCE):      Amount={amount3}, Count={count3 if 'count3' in locals() else 'N/A'}")
print()

if amount1 is not None and amount1 != 0:
    if amount1 == amount3:
        print("✅ SUCCESS: Query 1 (raw) and Query 3 (coalesce) MATCH")
        print("   Recommendation: Use COALESCE approach (single CONSOLIDATE call, handles NULL)")
    elif amount2 == amount3:
        print("✅ SUCCESS: Query 2 (consolidate) and Query 3 (coalesce) MATCH")
        print("   Recommendation: Use COALESCE approach (CONSOLIDATE works, COALESCE is safe fallback)")
    elif amount2 is None or amount2 == 0:
        print("⚠️  WARNING: Query 2 (consolidate) returned NULL/0, but Query 3 (coalesce) has data")
        print("   This confirms BUILTIN.CONSOLIDATE returns NULL for single subsidiary")
        print("   Recommendation: Use COALESCE approach (required for single subsidiary)")
    else:
        print("⚠️  WARNING: All three queries returned different results")
        print("   Need further investigation")
        print(f"   Difference 1-2: {abs(amount1 - amount2) if amount1 and amount2 else 'N/A'}")
        print(f"   Difference 1-3: {abs(amount1 - amount3) if amount1 and amount3 else 'N/A'}")
        print(f"   Difference 2-3: {abs(amount2 - amount3) if amount2 and amount3 else 'N/A'}")
else:
    print("❌ ERROR: Query 1 (raw) returned no data - no transactions found")
    print(f"   Cannot compare - check if transactions exist for book {ACCOUNTING_BOOK}, sub {sub_id}")

