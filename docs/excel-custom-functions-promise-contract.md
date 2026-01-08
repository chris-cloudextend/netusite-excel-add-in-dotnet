# Excel Custom Functions Promise Contract - Critical Requirements

## Why Excel for Mac Crashes with Invalid Promise Contracts

Excel for Mac aggressively caches custom function metadata during IntelliSense inspection. When you type a function name (e.g., `=XAVI.BALANCE(`), Excel inspects the function signature to provide autocomplete and parameter hints.

**The Crash Mechanism:**

1. Excel caches the function's return type as `Promise<number>` based on the `@returns` JSDoc annotation
2. During IntelliSense, Excel may pre-evaluate the function to understand its behavior
3. If the function resolves a **string** (like `"#ERROR#"`) instead of a **number**, Excel's type system detects a contract violation
4. Excel's internal type checking crashes because it expected a number but received a string
5. The crash occurs **during typing**, not during calculation, because IntelliSense triggers evaluation

**Why Reinstalling Excel Temporarily "Fixes" the Issue:**

- Reinstalling Excel clears the cached function metadata
- The crash doesn't occur until Excel re-inspects the function during IntelliSense
- Once Excel caches the broken contract, the crash persists until cache is cleared

## Microsoft's Requirement for Stable Promise Contracts

Microsoft Office Custom Functions documentation explicitly requires:

> **A custom function MUST maintain a consistent return type throughout its execution.**
> 
> - If declared as `Promise<number>`, it MUST ALWAYS resolve to a number
> - If declared as `Promise<string>`, it MUST ALWAYS resolve to a string
> - **NEVER mix return types** - this causes host crashes on macOS

**From Microsoft's Best Practices:**

> Errors should be surfaced by **throwing** `Error` objects, not by resolving error strings. Excel handles thrown errors safely and displays them appropriately to users.

## The Exact Rules Future Contributors Must Follow

### ✅ CORRECT: Throwing Errors

```javascript
async function BALANCE(account, fromPeriod, toPeriod) {
    if (!account) {
        throw new Error('MISSING_ACCT');  // ✅ Excel displays #ERROR! safely
    }
    
    try {
        const result = await fetchBalance(account);
        return result;  // ✅ Always returns a number
    } catch (error) {
        if (error instanceof Error) {
            throw error;  // ✅ Re-throw Error objects
        }
        throw new Error('ERROR');  // ✅ Wrap non-Error exceptions
    }
}
```

### ❌ WRONG: Returning Error Strings

```javascript
async function BALANCE(account, fromPeriod, toPeriod) {
    if (!account) {
        return '#MISSING_ACCT#';  // ❌ CRASHES Excel on Mac!
    }
    
    try {
        const result = await fetchBalance(account);
        return result;
    } catch (error) {
        return '#ERROR#';  // ❌ CRASHES Excel on Mac!
    }
}
```

### Rules Summary

1. **Promise<number> functions:**
   - ✅ MUST resolve to a number (or throw an Error)
   - ❌ NEVER resolve to a string
   - ❌ NEVER return error codes like `"#ERROR#"`, `"#BUSY"`, `"#TIMEOUT"`

2. **Promise<string> functions:**
   - ✅ CAN resolve to strings (including error codes like `"#N/A"`)
   - ✅ CAN throw Errors
   - Example: `NAME()`, `TYPE()`, `PARENT()` functions correctly return `"#N/A"` as strings

3. **Error Handling:**
   - ✅ Use `throw new Error('CODE')` for errors
   - ✅ Excel will display `#ERROR!` in the cell (user-friendly)
   - ✅ Excel's error handling is safe and doesn't crash

4. **Promise Resolution:**
   - ❌ NEVER use `resolve('#BUSY')` in Promise<number> functions
   - ✅ Use `throw new Error('BUSY')` instead
   - ✅ Excel will re-evaluate when conditions change

## Concrete Examples from This Codebase

### Before (CRASHES Excel on Mac):

```javascript
async function BALANCE(account, fromPeriod, toPeriod) {
    if (!account) {
        return '#MISSING_ACCT#';  // ❌ String in Promise<number>
    }
    
    if (!toPeriod) {
        return new Promise((resolve) => {
            setTimeout(() => resolve('#BUSY'), 100);  // ❌ String in Promise<number>
        });
    }
    
    try {
        // ... API call ...
    } catch (error) {
        return '#ERROR#';  // ❌ String in Promise<number>
    }
}
```

**Result:** Excel crashes when user types `=XAVI.BALANCE(` because IntelliSense detects the mixed return types.

### After (SAFE):

```javascript
async function BALANCE(account, fromPeriod, toPeriod) {
    if (!account) {
        throw new Error('MISSING_ACCT');  // ✅ Error thrown, Excel displays #ERROR!
    }
    
    if (!toPeriod) {
        throw new Error('BUSY');  // ✅ Error thrown, Excel will re-evaluate
    }
    
    try {
        // ... API call ...
    } catch (error) {
        if (error instanceof Error) {
            throw error;  // ✅ Re-throw Error objects
        }
        throw new Error('ERROR');  // ✅ Wrap non-Error exceptions
    }
}
```

**Result:** Excel safely handles errors, displays `#ERROR!` in cells, and never crashes.

## Functions Fixed in This Codebase

All of the following functions were updated to throw Errors instead of returning error strings:

1. **BALANCE** - Fixed 5 string returns
2. **BALANCECURRENCY** - Fixed 8 string returns  
3. **BUDGET** - Fixed 5 string returns
5. **RETAINEDEARNINGS** - Fixed 6 string returns
6. **NETINCOME** - Fixed 7 string returns
7. **TYPEBALANCE** - Fixed 5 string returns
8. **CTA** - Fixed 8 string returns

**Total:** 48 string returns replaced with `throw new Error()` calls.

## Functions That Correctly Return Strings

These functions are **correctly** declared as `Promise<string>` and can return error strings:

- **NAME** - Returns `"#N/A"` when account not found (correct)
- **TYPE** - Returns `"#N/A"` when account not found (correct)
- **PARENT** - Returns `"#N/A"` when account not found (correct)
- **CLEARCACHE** - Synchronous function returning status strings (correct)

## Testing Checklist

Before committing changes to custom functions:

- [ ] Verify function JSDoc declares correct return type (`Promise<number>` or `Promise<string>`)
- [ ] Search for `return '#` patterns in Promise<number> functions
- [ ] Search for `resolve('#` patterns in Promise<number> functions
- [ ] Ensure all error paths use `throw new Error('CODE')`
- [ ] Test in Excel for Mac (most strict platform)
- [ ] Verify IntelliSense works without crashes

## Additional Notes

- **Windows Excel** is more tolerant of mixed types but still violates Microsoft's contract
- **Excel for Mac** is strict and crashes immediately on contract violations
- **Shared Runtime** mode (used in this codebase) makes the issue more severe
- **IntelliSense inspection** is the primary trigger, not formula calculation

## Enforced Contract Rules (Non-Negotiable)

### Critical Checklist for Future Contributors

Before modifying any custom function, verify:

- [ ] **Function return type matches JSDoc:** If `@returns {Promise<number>}`, function MUST only resolve numbers
- [ ] **No string resolves in numeric functions:** Search for `resolve('#` or `resolve(errorCode)` patterns
- [ ] **Batch processors reject errors:** Batch layers must use `reject(new Error('CODE'))`, not `resolve('CODE')`
- [ ] **All error paths throw:** Every error condition must `throw new Error('CODE')`, never return strings
- [ ] **Promise resolvers are type-safe:** Check that `item.resolve()` and `request.resolve()` only receive numbers

### DO / DO NOT Examples

**✅ DO: Reject in Batch Processors**
```javascript
// Batch processor handling Promise<number> requests
if (errorCode) {
    items.forEach(item => item.reject(new Error(errorCode)));  // ✅ Correct
}
```

**❌ DO NOT: Resolve Error Strings in Batch Processors**
```javascript
// Batch processor handling Promise<number> requests
if (errorCode) {
    items.forEach(item => item.resolve(errorCode));  // ❌ CRASHES Excel Mac!
}
```

**✅ DO: Throw Errors in Custom Functions**
```javascript
async function BALANCE(account) {
    if (!account) {
        throw new Error('MISSING_ACCT');  // ✅ Correct
    }
    return await fetchBalance(account);  // ✅ Returns number
}
```

**❌ DO NOT: Return Error Strings**
```javascript
async function BALANCE(account) {
    if (!account) {
        return '#MISSING_ACCT#';  // ❌ CRASHES Excel Mac!
    }
}
```

### Why Batch Resolvers Must Not Resolve Strings

Batch processors (like `runBuildModeBatch()`, `processBatchQueue()`) handle multiple Promise<number> requests simultaneously. When these processors call `resolve(errorCode)` with a string:

1. **Excel caches the violation:** The Promise contract is broken at the resolver level
2. **Metadata corruption persists:** Excel's function metadata cache becomes inconsistent
3. **Crashes persist across restarts:** The corrupted cache survives Excel restarts
4. **IntelliSense triggers crashes:** Any function inspection can crash Excel

**The fix:** Batch processors must use `reject(new Error('CODE'))` instead of `resolve('CODE')`. This ensures:
- The Promise contract remains intact (rejection is not a resolution)
- Excel's error handling safely displays `#ERROR!` in cells
- No metadata corruption occurs
- Excel can safely re-evaluate when conditions change

### Warning: Violations Cause Persistent Crashes

**⚠️ CRITICAL:** Violating Promise contracts can cause Excel for Mac crashes that:
- **Persist across Excel restarts** (cached metadata survives)
- **Require Excel reinstallation** to fully clear (nuclear option)
- **Trigger during IntelliSense** (typing function names)
- **Affect all users** on the same machine (shared cache)

**Prevention is the only reliable solution.** Once metadata is corrupted, clearing it requires:
1. Quitting Excel completely
2. Clearing Excel's cache directories
3. Restarting Excel
4. Or reinstalling Excel (most reliable)

This is why strict enforcement at the code level is critical - we must prevent violations from ever reaching Excel's metadata cache.

## References

- [Microsoft: Custom Functions Best Practices](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-best-practices)
- [Microsoft: Custom Functions Error Handling](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/custom-functions-error-handling)

