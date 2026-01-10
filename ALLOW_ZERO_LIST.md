# Explicit Allow-Zero List

**Date:** January 2, 2025  
**Last Updated:** January 2026  
**Purpose:** Document all cases where returning 0 is explicitly allowed (legitimate business results)

---

## Definition

A **legitimate zero** is returned when:
1. The query succeeded (no errors)
2. The result represents "no activity" or "no data" in NetSuite
3. The value is explicitly NULL or empty in the response

---

## Allow-Zero Cases

### 1. No Activity in Period

**Condition:** Query succeeded, result set is empty or SUM() returns NULL  
**Example:** Account 4220 has no transactions in Jan 2025  
**Backend Behavior:** Returns empty result set or `{balance: null}`  
**Frontend Behavior:** Returns 0  
**Status:** ✅ Allowed

**Code Location:**
- `ParseBalance`: Returns 0 if `JsonValueKind.Null`
- `ParseDecimalFromResult`: Returns 0 if empty result set or null field

---

### 2. Unopened Account

**Condition:** Account exists but has never had any transactions  
**Example:** New account created but not yet used  
**Backend Behavior:** Query succeeds, returns `{balance: null}` or empty result  
**Frontend Behavior:** Returns 0  
**Status:** ✅ Allowed

---

### 3. Budget Line with No Entries

**Condition:** Budget query succeeded, no budget entries for account/period  
**Example:** Account 4220 has no budget for Jan 2025  
**Backend Behavior:** Query succeeds, returns empty result set  
**Frontend Behavior:** Returns 0  
**Status:** ✅ Allowed

**Code Location:**
- `BudgetService.GetBudgetAsync`: Returns 0 if no budget entries found

---

### 4. Explicit NULL from NetSuite

**Condition:** Query succeeded, field value is explicitly NULL  
**Example:** `SELECT SUM(amount) AS balance FROM ...` returns `{balance: null}`  
**Backend Behavior:** Returns 0 (NULL converted to 0)  
**Frontend Behavior:** Returns 0  
**Status:** ✅ Allowed

**Code Location:**
- `ParseBalance`: `if (element.ValueKind == JsonValueKind.Null) return 0;`
- `ParseDecimalFromResult`: `if (prop.ValueKind == JsonValueKind.Null) return 0;`

---

### 5. Empty String from NetSuite

**Condition:** Query succeeded, field value is empty string  
**Example:** `{balance: ""}`  
**Backend Behavior:** Returns 0 (empty string converted to 0)  
**Frontend Behavior:** Returns 0  
**Status:** ✅ Allowed

**Code Location:**
- `ParseBalance`: `if (string.IsNullOrEmpty(strVal)) return 0;`
- `ParseDecimalFromResult`: `if (string.IsNullOrEmpty(strVal)) return 0;`

---

### 6. Zero Balance (Actual Zero)

**Condition:** Query succeeded, account has transactions but net balance is 0  
**Example:** Account has $100 debit and $100 credit = $0 balance  
**Backend Behavior:** Returns 0 (actual calculated zero)  
**Frontend Behavior:** Returns 0  
**Status:** ✅ Allowed

**Note:** This is different from "no activity" - the account has activity, but the net is zero.

---

## NOT Allowed (Must Error)

### 1. Query Failures

**Condition:** NetSuite query failed (auth error, syntax error, timeout, etc.)  
**Example:** `QueryResult.Success == false`  
**Backend Behavior:** Returns HTTP 500 with `errorCode` and `errorDetails`  
**Frontend Behavior:** Throws error (TIMEOUT, AUTHERR, ERROR, etc.)  
**Status:** ❌ Must error, never return 0

---

### 2. Parse Failures

**Condition:** Response contains unparseable data (invalid JSON shape, unparseable string)  
**Example:** `{balance: {object: "invalid"}}` or `{balance: "not-a-number"}`  
**Backend Behavior:** Throws `InvalidOperationException` → HTTP 500  
**Frontend Behavior:** Throws error  
**Status:** ❌ Must error, never return 0

---

### 3. Network Failures

**Condition:** Network request failed (connection error, DNS failure, etc.)  
**Example:** `fetch()` throws `TypeError`  
**Frontend Behavior:** Throws `OFFLINE` error  
**Status:** ❌ Must error, never return 0

---

### 4. Unexpected Response Shape

**Condition:** Response structure is unexpected (missing fields, wrong type)  
**Example:** `{value: {object: "invalid"}}` instead of `{value: 123.45}`  
**Backend Behavior:** Throws `InvalidOperationException` → HTTP 500  
**Frontend Behavior:** Throws error  
**Status:** ❌ Must error, never return 0

---

## Summary

**Total Allow-Zero Cases:** 6  
**Total Must-Error Cases:** 4

**Key Principle:** 0 is allowed only when the query succeeded and the value represents "no activity" or "actual zero balance". All errors must fail loudly.

---

## Code Verification

All allow-zero cases are implemented in:
- `ParseBalance` (BalanceService.cs)
- `ParseDecimalFromResult` (SpecialFormulaController.cs)
- `ParseAmount` (BudgetService.cs)

All must-error cases are implemented in:
- `QueryRawWithErrorAsync` (NetSuiteService.cs)
- Frontend error checking (functions.js)

