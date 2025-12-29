# BALANCE Function Parameter-Driven Refactor

## Summary

Refactored `BALANCE` function to be **parameter-driven** instead of **account-type-driven**. The function now determines behavior based on which parameters are provided, not by detecting account type.

## Restore Point

**Git Tag**: `before-balance-param-refactor`
**Commit**: `ae1b04f`

To restore previous behavior:
```bash
git checkout before-balance-param-refactor
```

## Changes Made

### Backend (`backend-dotnet/Services/BalanceService.cs`)

**Removed**:
- Account type detection logic (BS vs P&L)
- Account-type-based branching
- Logic that ignored `fromPeriod` for BS accounts

**Added**:
- Parameter-driven behavior based on `fromPeriod` and `toPeriod` presence
- Validation for invalid parameter combinations
- Universal sign flip logic (handles both BS and P&L accounts)

### Frontend (`docs/functions.js`)

**Updated**:
- Comments to reflect parameter-driven approach
- Variable names: `isBSAccount` → `isCumulativeQuery`
- Function documentation for `isCumulativeRequest()`

## New Behavior

### 1. Point-in-Time Balance (Cumulative)

**When**: `fromPeriod` is null/empty AND `toPeriod` is provided

**Formula**:
```excel
=XAVI.BALANCE("10010",, "Apr 2025")
```

**Behavior**:
- Returns consolidated balance as of end of `toPeriod`
- Always uses `BUILTIN.CONSOLIDATE(..., targetPeriodId = toPeriod)`
- Query: `t.trandate <= toEndDate` (cumulative from inception)
- Applies to all account types (BS and P&L)

**Use Case**: "What was the balance as of April 2025?"

### 2. Period Activity (Range)

**When**: Both `fromPeriod` AND `toPeriod` are provided

**Formula**:
```excel
=XAVI.BALANCE("10010", "Jan 2025", "Apr 2025")
```

**Behavior**:
- Returns net activity between `fromPeriod` and `toPeriod`
- Always uses `BUILTIN.CONSOLIDATE(..., targetPeriodId = toPeriod)`
- Query: `ap.startdate >= fromStartDate AND ap.enddate <= toEndDate`
- Applies to all account types (BS and P&L)

**Use Case**: "What was the activity from January through April 2025?"

### 3. Invalid Parameter Shape

**When**: `fromPeriod` is provided but `toPeriod` is empty

**Behavior**:
- Returns user-facing error
- Does not infer or auto-correct intent

**Error Message**: "Invalid parameters: fromPeriod provided but toPeriod is required. For point-in-time balance, leave fromPeriod empty."

## Key Differences from Previous Behavior

### Before (Account-Type-Driven)

- BS accounts: Always cumulative, `fromPeriod` ignored
- P&L accounts: Always period range, `fromPeriod` required
- Behavior inferred from account type

### After (Parameter-Driven)

- Point-in-time: `fromPeriod` null/empty → cumulative query
- Period activity: Both `fromPeriod` and `toPeriod` provided → range query
- Behavior determined by parameters, not account type

## Financial Correctness

**Always uses `targetPeriodId` (toPeriod's rate)** for `BUILTIN.CONSOLIDATE`:
- Ensures all amounts convert at the same exchange rate
- Required for Balance Sheet to balance correctly
- Maintains financial integrity

## User Education

**Important**: Users must now understand:
- **Point-in-time balance**: Leave `fromPeriod` empty/null
- **Period activity**: Provide both `fromPeriod` and `toPeriod`
- **Invalid**: Providing `fromPeriod` without `toPeriod` returns error

## Testing Checklist

- [x] Point-in-time queries (fromPeriod null/empty)
- [ ] Period activity queries (both fromPeriod and toPeriod provided)
- [ ] Error case (fromPeriod provided, toPeriod empty)
- [ ] BS accounts with period activity
- [ ] P&L accounts with point-in-time
- [ ] Currency conversion correctness

## Files Modified

1. `backend-dotnet/Services/BalanceService.cs` - Core logic refactor
2. `docs/functions.js` - Frontend comments and variable names
3. No changes needed to `BalanceController.cs` (delegates to service)

## Backward Compatibility

**Breaking Change**: Yes
- Previous formulas with `fromPeriod` for BS accounts will now use period activity instead of cumulative
- Users must update formulas: Remove `fromPeriod` for point-in-time queries

**Migration Path**:
- Old: `BALANCE("10010", "Jan 2025", "Apr 2025")` on BS account → cumulative (fromPeriod ignored)
- New: `BALANCE("10010", "Jan 2025", "Apr 2025")` → period activity (Jan through Apr)
- Fix: `BALANCE("10010",, "Apr 2025")` → point-in-time (as of Apr)

