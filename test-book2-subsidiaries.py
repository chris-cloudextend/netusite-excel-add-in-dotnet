#!/usr/bin/env python3
"""
Simple test script to check Accounting Book 2 subsidiaries.
Just run: python3 test-book2-subsidiaries.py
"""

import requests
import json

print("=" * 70)
print("TESTING: Accounting Book 2 Subsidiaries")
print("=" * 70)
print()

try:
    # Test the endpoint
    print("Making request to: http://localhost:5002/lookups/accountingbook/2/subsidiaries")
    print()
    
    response = requests.get('http://localhost:5002/lookups/accountingbook/2/subsidiaries', timeout=30)
    
    print(f"HTTP Status Code: {response.status_code}")
    print()
    
    if response.status_code == 200:
        data = response.json()
        subsidiaries = data.get('subsidiaries', [])
        
        print(f"✅ RESULT: Found {len(subsidiaries)} subsidiary(ies) for Accounting Book 2")
        print()
        
        if len(subsidiaries) > 0:
            print("Subsidiaries found:")
            print("-" * 70)
            for i, sub in enumerate(subsidiaries, 1):
                print(f"{i}. Name: {sub.get('name', 'N/A')}")
                print(f"   ID: {sub.get('id', 'N/A')}")
                print(f"   Full Name: {sub.get('fullName', 'N/A')}")
                print()
        else:
            print("⚠️  WARNING: No subsidiaries found!")
            print()
            print("This could mean:")
            print("  1. The AccountingBookSubsidiaries sublist query failed")
            print("  2. Book 2 has no subsidiaries configured in NetSuite")
            print("  3. The table name might be different")
            print()
            print("Full API response:")
            print("-" * 70)
            print(json.dumps(data, indent=2))
    else:
        print(f"❌ ERROR: Server returned status {response.status_code}")
        print()
        print("Response:")
        print(response.text)
        
except requests.exceptions.ConnectionError:
    print("❌ ERROR: Could not connect to server at http://localhost:5002")
    print()
    print("Make sure the server is running!")
    
except Exception as e:
    print(f"❌ ERROR: {e}")
    import traceback
    traceback.print_exc()

print()
print("=" * 70)

