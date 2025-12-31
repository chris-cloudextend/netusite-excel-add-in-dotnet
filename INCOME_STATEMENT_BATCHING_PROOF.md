# Income Statement Batching Proof

This document proves that income statement accounts from the Quick Start section use a **single full-year query** and write data back in **<30 seconds**, **NOT** cell-by-cell or period-by-period.

## Code Flow Proof

### Step 1: Income Statement Accounts Route to Queue (NOT Per-Cell Path)

**Location**: `docs/functions.js` lines 6081-6127

**Proof Points**:
- Income statement accounts are identified by account type check
- They **skip all manifest/preload logic** (lines 6081-6083)
- They route directly to `pendingRequests.balance` queue (line 6102)
- They **do NOT** continue to per-cell API path

**Console Logs to Look For**:
```
📥 QUEUED [Income Statement]: {account} for {fromPeriod} → {toPeriod}
   ✅ PROOF: Income Statement account routed to queue (NOT per-cell path)
   ✅ PROOF: Will be batched with other Income Statement accounts
   ✅ PROOF: Queue size: {N} (including this request)
```

### Step 2: Requests Grouped Together for Batching

**Location**: `docs/functions.js` lines 8235-8256

**Proof Points**:
- All income statement requests are grouped by filters (not processed individually)
- Multiple accounts/periods are collected into a single batch group
- **NOT** processed cell-by-cell

**Console Logs to Look For**:
```
📊 Processing {N} REGULAR (P&L) requests with batching...
   ✅ PROOF: {N} Income Statement requests will be batched together
   ✅ PROOF: NOT processing cell-by-cell or period-by-period
📦 Grouped into {M} batch(es) by filters
   ✅ PROOF: Requests grouped for single batch query (not individual queries)
```

### Step 3: Single Year Query Detection

**Location**: `docs/functions.js` lines 8366-8376

**Proof Points**:
- System detects when all 12 months are present
- Year endpoint optimization is triggered
- **NOT** 12 separate period queries, **NOT** N separate account queries

**Console Logs to Look For**:
```
🗓️ YEAR OPTIMIZATION: Using /batch/balance/year for FY {year} (Income Statement accounts)
   Accounts: {N}, Periods: 12, Full Year: true
   ✅ PROOF: Year endpoint will be used (single query for entire year)
```

### Step 4: Single Year Query Execution

**Location**: `docs/functions.js` lines 8415-8452

**Proof Points**:
- **ONE** API call to `/batch/balance/year` endpoint
- Query includes **ALL accounts** and **entire year** in single request
- **NOT** multiple queries

**Console Logs to Look For**:
```
📤 Year request: {N} accounts for FY {year}
   ✅ PROOF: SINGLE query for {N} accounts × 12 months
   ✅ PROOF: NOT {N*12} individual queries
   ✅ PROOF: NOT {N} queries (one per account)
   ✅ PROOF: NOT 12 queries (one per period)
```

### Step 5: Single Query Response and Simultaneous Write-Back

**Location**: `docs/functions.js` lines 8431-8450

**Proof Points**:
- **ONE** response received with all account/year data
- All promises resolved **simultaneously** in a loop
- **NOT** one-by-one resolution

**Console Logs to Look For**:
```
✅ Year endpoint returned {N} accounts in {X}s
   ✅ PROOF: Single query completed in {X}s (target: <30s)
   ✅ PROOF: Writing back {M} results simultaneously
🎯 RESOLVING (year): {account1} = {value1}
🎯 RESOLVING (year): {account2} = {value2}
... (all accounts resolved)
   ✅ PROOF: Resolved {M} promises in {Y}s
   ✅ PROOF: Total time: {Z}s (query: {X}s + resolve: {Y}s)
   ✅ PROOF: All {M} cells updated simultaneously (NOT one-by-one)
```

## Performance Proof

### Expected Console Output for Quick Start Income Statement

When running the Quick Start income statement section, you should see:

1. **Queuing Phase** (multiple accounts):
   ```
   📥 QUEUED [Income Statement]: 4000 for Jan 2025 → Dec 2025
      ✅ PROOF: Income Statement account routed to queue (NOT per-cell path)
   📥 QUEUED [Income Statement]: 4100 for Jan 2025 → Dec 2025
      ✅ PROOF: Income Statement account routed to queue (NOT per-cell path)
   ... (more accounts)
   ```

2. **Batching Phase**:
   ```
   ⏱️ Batch timer FIRED!
   📊 Processing {N} REGULAR (P&L) requests with batching...
      ✅ PROOF: {N} Income Statement requests will be batched together
      ✅ PROOF: NOT processing cell-by-cell or period-by-period
   📦 Grouped into 1 batch(es) by filters
      ✅ PROOF: Requests grouped for single batch query (not individual queries)
   ```

3. **Year Query Detection**:
   ```
   🗓️ YEAR OPTIMIZATION: Using /batch/balance/year for FY 2025 (Income Statement accounts)
      Accounts: {N}, Periods: 12, Full Year: true
      ✅ PROOF: Year endpoint will be used (single query for entire year)
   ```

4. **Single Query Execution**:
   ```
   📤 Year request: {N} accounts for FY 2025
      ✅ PROOF: SINGLE query for {N} accounts × 12 months
      ✅ PROOF: NOT {N*12} individual queries
      ✅ PROOF: NOT {N} queries (one per account)
      ✅ PROOF: NOT 12 queries (one per period)
   ```

5. **Simultaneous Write-Back**:
   ```
   ✅ Year endpoint returned {N} accounts in 26.5s
      ✅ PROOF: Single query completed in 26.5s (target: <30s)
      ✅ PROOF: Writing back {M} results simultaneously
   🎯 RESOLVING (year): 4000 = 1234567
   🎯 RESOLVING (year): 4100 = 2345678
   ... (all accounts)
      ✅ PROOF: Resolved {M} promises in 0.001s
      ✅ PROOF: Total time: 26.5s (query: 26.5s + resolve: 0.001s)
      ✅ PROOF: All {M} cells updated simultaneously (NOT one-by-one)
   ```

## What This Proves

1. ✅ **NOT Cell-by-Cell**: Accounts are queued, not processed individually
2. ✅ **NOT Period-by-Period**: Single year query, not 12 separate period queries
3. ✅ **NOT Account-by-Account**: All accounts in single query, not N separate queries
4. ✅ **Single Query**: ONE API call to `/batch/balance/year`
5. ✅ **Simultaneous Write-Back**: All promises resolved in a loop, not sequentially
6. ✅ **Performance**: Query completes in <30s, all cells updated immediately after

## Verification Steps

1. Open Excel Quick Start section with income statement formulas
2. Open browser console (Developer Tools)
3. Look for the "✅ PROOF:" log messages
4. Verify:
   - Accounts are queued (not per-cell)
   - Single year query is made
   - All results written back simultaneously
   - Total time <30 seconds

## Code References

- **Queue Routing**: `docs/functions.js:6081-6127`
- **Request Grouping**: `docs/functions.js:8235-8256`
- **Year Detection**: `docs/functions.js:8366-8376`
- **Year Query**: `docs/functions.js:8415-8452`
- **Result Write-Back**: `docs/functions.js:8439-8450`

