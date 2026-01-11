# Silent Zero Elimination - Verification Checklist

**Date:** January 2, 2025  
**Purpose:** Test cases to verify that silent zeros are eliminated

---

## Test Environment Setup

1. ✅ Restore branch created: `restore/working-period-dates`
2. ✅ Backend server running
3. ✅ Excel Add-in loaded
4. ✅ NetSuite connection active

---

## Test Cases

### TC-1: Forced NetSuite Auth Failure

**Objective:** Verify that auth failures return errors, not 0

**Steps:**
1. Temporarily break NetSuite credentials (invalid token/secret)
2. Run formula: `=XAVI.BALANCE("4220", "Jan 2025", "Jan 2025")`
3. Run formula: `=XAVI.RETAINEDEARNINGS("Jan 2025")`
4. Run formula: `=XAVI.NETINCOME("Jan 2025", "Dec 2025")`
5. Run formula: `=XAVI.CTA("Jan 2025")`
6. Run formula: `=XAVI.TYPEBALANCE("Income", "Jan 2025", "Dec 2025")`

**Expected Results:**
- All formulas return `#AUTHERR!` or `#ERROR!` error
- **NOT** 0
- Backend logs show `AUTH_ERROR` error code

**Status:** ⏳ Pending

---

### TC-2: Forced SuiteQL Syntax Error

**Objective:** Verify that SQL syntax errors return errors, not 0

**Steps:**
1. Inject invalid SQL into backend query (e.g., `SELECT * FROM invalid_table`)
2. Run formula: `=XAVI.BALANCE("4220", "Jan 2025", "Jan 2025")`

**Expected Results:**
- Formula returns `#ERROR!` error
- **NOT** 0
- Backend logs show `QUERY_ERROR` error code

**Status:** ⏳ Pending

---

### TC-3: Forced Parse Failure

**Objective:** Verify that parse failures return errors, not 0

**Steps:**
1. Mock backend to return invalid JSON shape: `{value: {object: "invalid"}}`
2. Run formula: `=XAVI.RETAINEDEARNINGS("Jan 2025")`

**Expected Results:**
- Formula returns `#ERROR!` error
- **NOT** 0
- Backend logs show `InvalidOperationException` with parse error message

**Status:** ⏳ Pending

---

### TC-4: Legitimate No-Data Case

**Objective:** Verify that legitimate zeros still return 0

**Steps:**
1. Query account with no transactions in period: `=XAVI.BALANCE("99999", "Jan 2025", "Jan 2025")`
2. Query budget with no entries: `=XAVI.BUDGET("99999", "Jan 2025", "Jan 2025")`

**Expected Results:**
- Formulas return 0 (legitimate zero)
- Backend logs show successful query with empty result set
- No errors thrown

**Status:** ⏳ Pending

---

### TC-5: Network Timeout

**Objective:** Verify that timeouts return errors, not 0

**Steps:**
1. Simulate network timeout (disconnect network or block backend)
2. Run formula: `=XAVI.BALANCE("4220", "Jan 2025", "Jan 2025")`

**Expected Results:**
- Formula returns `#TIMEOUT!` or `#ERROR!` error
- **NOT** 0
- Frontend logs show timeout error

**Status:** ⏳ Pending

---

### TC-6: Backend Error Response Format

**Objective:** Verify that backend error responses are properly handled

**Steps:**
1. Mock backend to return: `{error: "Test error", errorCode: "SERVER_ERROR", errorDetails: "Test details"}`
2. Run formula: `=XAVI.RETAINEDEARNINGS("Jan 2025")`

**Expected Results:**
- Formula returns `#ERROR!` error
- **NOT** 0
- Frontend logs show error code and details

**Status:** ⏳ Pending

---

### TC-7: Full Year Refresh Error Handling

**Objective:** Verify that Income Statement handles query failures correctly

**Steps:**
1. Break NetSuite connection
2. Run Income Statement from Quick Start
3. Observe behavior

**Expected Results:**
- Income Statement shows error message
- **NOT** all zeros
- Backend logs show query failure

**Status:** ⏳ Pending

---

### TC-8: CFO Flash Report Error Handling

**Objective:** Verify that CFO Flash Report handles query failures correctly

**Steps:**
1. Break NetSuite connection
2. Run CFO Flash Report from Quick Start
3. Observe behavior

**Expected Results:**
- CFO Flash Report shows error message
- **NOT** all zeros
- Backend logs show query failure

**Status:** ⏳ Pending

---

### TC-9: Balance Sheet Report Error Handling

**Objective:** Verify that Balance Sheet Report handles special formula failures correctly

**Steps:**
1. Break NetSuite connection
2. Run Balance Sheet Report
3. Observe NETINCOME, RETAINEDEARNINGS, CTA rows

**Expected Results:**
- Special formula rows show error
- **NOT** 0
- Backend logs show query failures for each special formula

**Status:** ⏳ Pending

---

### TC-10: Actual Zero Balance

**Objective:** Verify that actual zero balances still return 0

**Steps:**
1. Find account with transactions but net balance of 0
2. Run formula: `=XAVI.BALANCE("account", "Jan 2025", "Jan 2025")`

**Expected Results:**
- Formula returns 0 (legitimate zero)
- Backend logs show successful query with calculated 0
- No errors thrown

**Status:** ⏳ Pending

---

## Verification Summary

**Total Test Cases:** 10  
**Passed:** ⏳ Pending  
**Failed:** ⏳ Pending  
**Not Run:** 10

---

## Manual Code Review Checklist

### Backend

- [x] All finance-critical endpoints use `QueryRawWithErrorAsync`
- [x] All query results checked for `result.Success` before parsing
- [x] Parse methods throw exceptions on parse failures
- [x] Error responses include `errorCode` and `errorDetails`

### Frontend

- [x] All finance-critical formulas check for `data.error` or `data.errorCode`
- [x] Removed `|| 0` fallbacks in finance-critical formulas
- [x] Error codes mapped to Excel errors (TIMEOUT, AUTHERR, ERROR)
- [x] Null/undefined values throw errors instead of returning 0

---

## Notes

- All test cases should be run in a test environment first
- Do not run destructive tests (auth failures) in production
- Verify legitimate zeros still work after fixes
- Check backend logs for error codes and details

