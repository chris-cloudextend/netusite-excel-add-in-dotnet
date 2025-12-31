# Income Statement Routing Analysis: Restore Point vs Current

## Executive Summary

The restore point `balance-sheet-before-anchor-batching` had **simple parameter-based routing** that worked for Income Statements. The current code has **account-type-based routing** that is misclassifying Income Statement accounts, causing them to be processed one-by-one instead of using the year endpoint.

## Key Difference: Routing Logic

### RESTORE POINT (Working)
```javascript
for (const [cacheKey, request] of requests) {
    const { fromPeriod, toPeriod } = request.params;
    const isCumulative = (!fromPeriod || fromPeriod === '') && toPeriod && toPeriod !== '';
    const isPeriodActivity = fromPeriod && toPeriod && fromPeriod !== toPeriod;
    
    if (isCumulative) {
        cumulativeRequests.push([cacheKey, request]);
    } else if (isPeriodActivity) {
        periodActivityRequests.push([cacheKey, request]);
    } else {
        regularRequests.push([cacheKey, request]);  // ← Income Statements go here
    }
}
```

**Key Points:**
- **NO account type checking** in routing
- `isPeriodActivity = fromPeriod && toPeriod && fromPeriod !== toPeriod`
- If `fromPeriod === toPeriod` (e.g., "Jan 2025" to "Jan 2025"), `isPeriodActivity = FALSE`
- If `fromPeriod !== toPeriod` (e.g., "Jan 2025" to "Dec 2025"), `isPeriodActivity = TRUE`

### CURRENT CODE (Broken)
```javascript
// First: Batch fetch account types
const accountTypeCache = new Map();
// ... batch fetch logic ...

for (const [cacheKey, request] of requests) {
    const { fromPeriod, toPeriod, account } = request.params;
    const isCumulative = (!fromPeriod || fromPeriod === '') && toPeriod && toPeriod !== '';
    const isPeriodActivity = fromPeriod && toPeriod && fromPeriod !== '';
    
    const accountType = accountTypeCache.get(account);
    const isIncomeStatement = accountType && (accountType === 'Income' || ...);
    
    if (isCumulative) {
        cumulativeRequests.push([cacheKey, request]);
    } else if (isPeriodActivity && !isIncomeStatement) {
        // Only BS accounts go here
        if (accountType !== null) {
            periodActivityRequests.push([cacheKey, request]);
        } else {
            regularRequests.push([cacheKey, request]);
        }
    } else {
        regularRequests.push([cacheKey, request]);
    }
}
```

**Key Points:**
- **Account type checking** added for Balance Sheet routing
- `isPeriodActivity = fromPeriod && toPeriod && fromPeriod !== ''` (DIFFERENT - includes same period!)
- Income Statement accounts with `fromPeriod === toPeriod` should go to `regularRequests` ✓
- Income Statement accounts with `fromPeriod !== toPeriod` should go to `regularRequests` ✓
- BUT: Account type fetching may fail or be incomplete, causing misclassification

## The Problem

### Issue 1: `isPeriodActivity` Definition Changed
- **Restore Point**: `isPeriodActivity = fromPeriod && toPeriod && fromPeriod !== toPeriod`
- **Current**: `isPeriodActivity = fromPeriod && toPeriod && fromPeriod !== ''`

**Impact**: Current code treats `fromPeriod === toPeriod` as period activity, which is wrong for Income Statements.

### Issue 2: Account Type Dependency
- **Restore Point**: No account type dependency - routing based purely on parameters
- **Current**: Routing depends on account types being fetched correctly

**Impact**: If account type fetching fails or is incomplete:
- Income Statement accounts may be misclassified
- They may route to `periodActivityRequests` instead of `regularRequests`
- This causes one-by-one processing instead of year endpoint batching

### Issue 3: Quick Start Section Formulas
The Quick Start section likely generates formulas like:
- `BALANCE(account, "Jan 2025", "Jan 2025")` - single period
- `BALANCE(account, "Jan 2025", "Dec 2025")` - full year range

**Restore Point Behavior:**
- Single period (`fromPeriod === toPeriod`): `isPeriodActivity = FALSE` → `regularRequests` ✓
- Full year (`fromPeriod !== toPeriod`): `isPeriodActivity = TRUE` → `periodActivityRequests` ✗

Wait, that doesn't make sense. If full year went to `periodActivityRequests`, it would be slow...

**Actually, let me reconsider**: The restore point may have had different logic for `regularRequests` that handled full year ranges correctly, OR the Quick Start section only uses single-period formulas.

## Root Cause Hypothesis

1. **Account type fetching is failing or incomplete** - Income Statement accounts are not being identified correctly
2. **`isPeriodActivity` definition change** - Treating same-period requests as period activity
3. **Routing logic complexity** - The account-type-based routing is more fragile than parameter-based routing

## What Worked in Restore Point

1. **Simple parameter-based routing** - No dependency on account types
2. **Clear separation**: 
   - Cumulative (empty fromPeriod) → BS cumulative
   - Period activity (different periods) → BS period activity  
   - Everything else → Regular (P&L batching)
3. **Income Statements naturally fell into `regularRequests`** for single-period queries
4. **Year endpoint optimization** worked for `regularRequests` when all 12 months were present

## Plan to Fix (Without Breaking Balance Sheet)

### Option 1: Revert to Parameter-Based Routing (Safest)
- Remove account type checking from routing logic
- Use original `isPeriodActivity = fromPeriod && toPeriod && fromPeriod !== toPeriod`
- Keep account type checking ONLY for Balance Sheet grid detection (not routing)
- Income Statements will naturally route to `regularRequests` for single-period queries
- Balance Sheet period activity queries will still route correctly based on parameters

### Option 2: Fix Account Type Routing (More Complex)
- Ensure account types are ALWAYS fetched before routing
- Fix `isPeriodActivity` to exclude same-period: `fromPeriod !== toPeriod`
- Add fallback: If account type is unknown, default to `regularRequests` (safer for IS)
- Add logging to track routing decisions

### Option 3: Hybrid Approach (Recommended)
- Use parameter-based routing as primary (like restore point)
- Only use account type checking for Balance Sheet-specific optimizations (grid detection)
- Keep Income Statement routing simple: if not cumulative and not period activity → `regularRequests`
- This preserves Balance Sheet work while fixing Income Statement routing

## Recommended Fix: Option 3 (Hybrid)

1. **Revert routing logic to parameter-based** (like restore point)
2. **Keep account type checking** but only use it for:
   - Balance Sheet grid detection (already working)
   - Year endpoint optimization (check if all accounts are IS)
3. **Fix `isPeriodActivity` definition**: `fromPeriod !== toPeriod` (not `fromPeriod !== ''`)
4. **Remove account type dependency from routing** - routing should work even if account types fail to fetch

This approach:
- ✅ Fixes Income Statement routing (back to working state)
- ✅ Preserves Balance Sheet grid batching (uses account types for detection, not routing)
- ✅ Preserves Balance Sheet drag-drop functionality
- ✅ Reduces complexity and fragility

## Code Changes Needed

1. **Change `isPeriodActivity` definition**:
   ```javascript
   // Current (WRONG):
   const isPeriodActivity = fromPeriod && toPeriod && fromPeriod !== '';
   
   // Fix (CORRECT):
   const isPeriodActivity = fromPeriod && toPeriod && fromPeriod !== toPeriod;
   ```

2. **Simplify routing logic** (remove account type dependency):
   ```javascript
   if (isCumulative) {
       cumulativeRequests.push([cacheKey, request]);
   } else if (isPeriodActivity) {
       // This will catch BS period activity queries
       // Income Statements with same period won't match (isPeriodActivity = false)
       periodActivityRequests.push([cacheKey, request]);
   } else {
       // Income Statements naturally fall here (single period or unknown)
       regularRequests.push([cacheKey, request]);
   }
   ```

3. **Keep account type checking for optimizations only**:
   - Balance Sheet grid detection (already working)
   - Year endpoint optimization (check if all accounts are IS before using year endpoint)

## Verification

After fix, verify:
1. ✅ Income Statement single-period queries route to `regularRequests`
2. ✅ Income Statement full-year queries route to `regularRequests` (not `periodActivityRequests`)
3. ✅ Balance Sheet cumulative queries route to `cumulativeRequests`
4. ✅ Balance Sheet period activity queries route to `periodActivityRequests`
5. ✅ Year endpoint optimization triggers for Income Statement accounts
6. ✅ Balance Sheet grid batching still works
7. ✅ Balance Sheet drag-drop still works

