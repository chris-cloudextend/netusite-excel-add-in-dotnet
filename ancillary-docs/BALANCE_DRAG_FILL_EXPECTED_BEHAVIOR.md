# XAVI.BALANCE Drag-Fill: Expected Behavior (SuiteQL & Batching)

## Scenario

- **Setup:** 30–40 P&L accounts in a column (Income, Expense, Other Expense). 15 month columns: Jan‑25 through Mar‑26.
- **Step 1:** Enter `XAVI.BALANCE` for Jan‑25 on the first account, then **drag the formula across** all 15 months (same row).
- **Step 2:** After those cells resolve, **drag the entire row down** to auto-fill the next 30–40 rows (so 30–40 accounts × 15 months).

---

## Are we sending a single query when we drag, and writing to cells?

**No.** Behavior is:

1. **No “single query then write”**  
   We do **not** send one SuiteQL request and then write values into cells. Each cell contains a **formula**. When you drag:
   - Excel evaluates each new formula (each `XAVI.BALANCE(...)` call).
   - Each evaluation runs in the add-in (custom function runtime) and either gets a value from cache or queues a request.

2. **One account vs all accounts**  
   - **Step 1 (first row only):** After drag across 15 months, we have **1 account** and **15 periods** in the queue (same filters). When the batch runs, the frontend sends **one batch request** (e.g. `POST /batch/balance`) with that **single account** and **all 15 periods**. So it’s one account, many periods — not “all accounts” in the grid yet.
   - **Step 2 (after row drag down):** We then have **30–40 accounts** and **15 periods** in the queue. The batch request includes **all of those accounts** and **all 15 periods** (still one filter group). So at that point we send batch(es) for “all accounts in the grid” (for that filter set).

3. **Who “writes” the cells?**  
   The server does **not** write to the sheet. Each cell already has a formula. When the batch completes, the frontend **resolves the promises** for each `BALANCE(...)` call; Excel then displays the returned values in those cells. So “writing” is the formula returning a value, not a separate write from the server.

---

## Step 1: First account, Jan‑25 then drag across 15 months

| What happens | Expected behavior |
|--------------|-------------------|
| **Per cell** | Each of the 15 cells runs `BALANCE(account, , period, ...)`. Cache is empty, so each adds an entry to `pendingEvaluation.balance` and then to the **batch queue** (`pendingRequests.balance`). |
| **Grid detection** | With only **1 account** and 15 periods, we do **not** meet “grid mode” (needed: 3+ periods **and** 2+ accounts). So we’re in “normal” mode: income preload may be triggered for the requested periods; formulas may wait for preload or go to the queue. |
| **Batch timer** | A **500 ms** batch timer is started (if not already running). When it fires, `processBatchQueue()` runs. |
| **API / SuiteQL** | Queue is drained; one **filter group**: 1 account, 15 periods. Frontend sends **one** `POST /batch/balance` with `accounts: [that one account]`, `periods: [Jan 2025 … Mar 2026]`. Backend runs `GetBatchBalanceAsync` (one or more SuiteQL queries for that account × those periods). We do **not** send 15 separate requests. |
| **Result** | When the batch response returns, each of the 15 formula promises is resolved with the right balance; Excel shows the values. So: **one batch request for one account and 15 periods**, not 15 separate queries. |

So for “just the one in the row”: we batch **that one account** with **all 15 periods** into a single batch call (and possibly use preload for the same filter/periods). We do **not** send one query per cell.

---

## Step 2: After all resolve, drag the entire row down 30–40 rows

| What happens | Expected behavior |
|--------------|-------------------|
| **Per cell** | Now **30–40 × 15** new formulas evaluate (450–600 cells). Each misses cache (new account/period pairs), so each is added to the batch queue (same filter group). |
| **Grid detection** | We have **3+ periods** and **2+ accounts** → **grid mode** is detected. We do **not** wait for income preload; we let the batch queue handle everything (and may still trigger background preload for cache). |
| **Batch timer** | Again **500 ms**; then `processBatchQueue()` runs with all queued requests. |
| **API / SuiteQL** | One filter group: **30–40 accounts**, **15 periods**. Frontend may use: |
| | - **`/batch/full_year_refresh`** when we have **5+ P&L accounts** and **10+ months of a single year** (e.g. Jan–Dec 2025). That endpoint returns **all** P&L accounts for that year in **one** pivoted SuiteQL query — so we get 2025 in one go even though the grid only has 30–40 accounts. |
| | - **`/batch/balance`** for the same accounts and periods (e.g. for 2026 months or when full_year_refresh isn’t used). Backend batches account×period and runs one or more SuiteQL queries. |
| **Deduplication** | Backend **NetSuiteGovernor** deduplicates identical requests. So if the same (account, period, filters) appears many times, we still only hit NetSuite once per unique request. |
| **Result** | We expect **on the order of 1–2 batch API calls** (e.g. one `full_year_refresh` for 2025 + one `batch/balance` for 2026 months), **not** 450+ per-cell queries. All cells get values when their promises resolve. |

So after the row drag: **one or a few batch requests** for **all accounts in the grid** and **all 15 periods**; SuiteQL is batched and deduplicated, and formulas resolve when those batch responses return.

---

## Summary

| Question | Answer |
|----------|--------|
| Single query when we drag and then write to cells? | No. Each cell is a formula. We **batch** evaluations and send **one (or few) batch request(s)**; formulas **return** values when the batch completes — no server “write” to cells. |
| One account or all accounts in the batch? | **Step 1:** One account, 15 periods → one batch for **that account** and all periods. **Step 2:** After row drag, 30–40 accounts and 15 periods → batch(es) for **all those accounts** and all periods. |
| SuiteQL: one per cell or batched? | **Batched.** Frontend sends `POST /batch/balance` (and possibly `POST /batch/full_year_refresh`). Backend runs one or more SuiteQL queries to satisfy the whole batch, not one query per cell. |
| Expected after row drag down? | ~700 ms after the new formulas are queued, `processBatchQueue()` runs; we send 1–2 batch API calls (e.g. full_year_refresh for 2025 + batch/balance for remaining periods). All 30–40 × 15 cells resolve when those responses return. |

**If you see one-by-one resolution or long waits:** The code now treats 1 account + 3+ periods as a "column-drag" pattern (skip 120s preload wait) and stops resetting the batch timer once the queue has 3+ items (so drag-fill batches instead of many small batches). See `docs/functions.js`: `isColumnDragPattern`, `QUEUE_SIZE_THRESHOLD` (3), `BATCH_DELAY` (700).

See also: **docs/PERFORMANCE-INVARIANTS.md** (e.g. “Drag-Fill and Refresh All Never Trigger Per-Cell Queries”) and **functions.js** `processBatchQueue()`, income path in `BALANCE()`, and backend `BalanceController` batch endpoints.
