# SuiteQL vs NetSuite Best Practices — Findings

Last Updated: 2026-01-15  
Scope: NetSuite Help Center guidance provided in the request + alignment notes for our codebase usage.

---

## Source Summary (NetSuite Help Center)

### Syntax Requirements
- Use `||` for string concatenation; `+` is not supported.
- No more than **1000 arguments** in a single `IN` clause.
- **WITH clauses are not supported**.
- **No date literals**. Use `TO_DATE()` for date comparisons.
- Oracle right outer join syntax is not supported; use ANSI joins instead.
- Do not mix ANSI and non-ANSI join styles in the same query.
- Do not use quoted field aliases in subselects (e.g., `select a.externalid AccountId`, not `select a.externalid "AccountId"`).

### Performance Best Practices
- Avoid complex queries with nested `SELECT` clauses.
- Avoid `SELECT *`; select only required fields.
- Avoid **calculated fields** (as identified in `oa_columns` with `C` at position 6 of `oa_userdata`).
- Avoid `WLONGVARCHAR` fields when possible (example fields include `item.featureddescription`, `item.storedetaileddescription`, `item.metataghtml`).
- Use filters to reduce result sets; prefer indexed fields like `id` and `lastmodifieddate`.
- For incremental loads, filter by `lastmodifieddate` with `TO_DATE()`.
- Keep filter expression types consistent (e.g., `TO_DATE` vs `TO_TIMESTAMP`) to avoid implicit casts.
- Use batching for large result sets instead of single massive queries.
- Avoid too many joins, or re-joining the same table multiple times.
- Avoid `OR` predicates; split into separate queries when possible.
- Avoid unnecessary sorting; use simpler queries and consider inner joins.
- Use filters rather than `TOP` for limiting results (TOP can be slower in the virtual schema).
- Always evaluate query performance and simplify if needed.

---

## Implications for Our SuiteQL Usage

### 1) Date Handling
We should always use `TO_DATE()` when comparing date fields (e.g., `startdate`, `enddate`, `trandate`).
Example:
```
WHERE ap.startdate >= TO_DATE('2025-01-01', 'YYYY-MM-DD')
```
This matches the guidance to avoid date literals.

### 2) Avoid `WITH` Clauses
NetSuite does **not** support `WITH`. Any query logic that benefits from CTEs should be refactored into:
- Inline subqueries, or
- Multiple sequential queries with small intermediate lookups.

### 3) `IN` Clause Size
We must avoid passing more than **1000 items** in a single `IN (...)`.
If we need large lists (e.g., period IDs or accounts):
- Split into multiple batches of <= 1000 items.
- Execute multiple queries and aggregate results.

### 4) Avoid `SELECT *`
Always fetch only required columns to reduce overhead and avoid pulling large fields.

### 5) Minimize Calculated + WLONGVARCHAR Fields
Avoid fields tagged as calculated in `oa_columns` when possible.  
Avoid large description fields unless required by UI/drill-down.

### 6) Join Strategy
Prefer ANSI joins and keep them minimal.  
Avoid repeated joins to the same table unless necessary.

### 7) Filtering and Type Consistency
Always use typed comparisons (`TO_DATE` vs `TO_DATE`, `TO_TIMESTAMP` vs `TO_TIMESTAMP`).

### 8) OR Predicates
Avoid large `OR` chains; split into multiple queries and combine results in code.

### 9) Batching for Large Result Sets
If a query is expected to return large results, split into smaller ID ranges or period ranges.

---

## Direct Alignment With Our Code Patterns

### ✅ Already Aligned
- We primarily use explicit column lists (not `SELECT *`).
- Date comparisons are typically done via `TO_DATE(...)`.
- Queries use ANSI join syntax.
- We already batch accounts/periods in multiple endpoints.

### ⚠️ Needs Ongoing Attention
- Watch `IN (...)` lists for large account/period batches.
- Avoid introducing `WITH` or quoted aliases in subselects.
- Keep filter types consistent (avoid mixing `TO_DATE` and `TO_TIMESTAMP` in the same predicate set).
- Avoid `OR`-heavy predicates; split where feasible.
- Avoid `TOP` and prefer filtering by `id` ranges.

---

## Recommendations Checklist (For Future Queries)

- Use `TO_DATE()` for any date value.
- Keep `IN` lists <= 1000 items.
- Avoid `WITH` clauses entirely.
- Use ANSI joins only; no mixed join syntax.
- Do not quote aliases in subselects.
- Avoid `SELECT *`.
- Avoid WLONGVARCHAR fields unless required.
- Prefer indexed filters (`id`, `lastmodifieddate`).
- Avoid `OR` predicates where possible; split into separate queries.
- Batch large queries (ID ranges or period ranges).
- Test performance and simplify if slow.

---

## Notes
This document is derived from the NetSuite Help Center guidance supplied in the user request and is intended to be used as an internal checklist for SuiteQL query authoring and review.

---

## Nonconforming Instances Found in Our Codebase

### 1) `WITH` clauses in SuiteQL (not supported)
**Files:**
- `backend/server.py` (P&L and BS queries in the legacy Python backend)

**Examples:**
- `pl_query` uses `WITH base AS (...)`
- `bs_query` uses `WITH base AS (...)`

**Why this conflicts:** NetSuite SuiteQL does **not** support `WITH` clauses. These queries should be refactored into inline subqueries or split into multiple steps.

**Suggested refactor:**
- Replace the CTE with a derived table:
  - `SELECT ... FROM (SELECT ... ) base JOIN ...`
- If the derived table is still heavy, split into two queries:
  - Query base rows first (period/account IDs + amounts)
  - Aggregate in a follow-up query or in application code

---

### 2) `SELECT *` usage
**Files:**
- `backend/server.py` — debug endpoint `/debug/budget-schema`

**Example:**
```
SELECT TOP 10
    b.*
FROM Budget b
```

**Why this conflicts:** Best practice is to avoid `SELECT *` and select only required columns. Also uses `TOP` (see below).

**Suggested refactor:**
- Replace `b.*` with a minimal field list needed for the debug output, e.g.:
  - `SELECT b.id, b.category, b.period, b.amount ...`
- If the purpose is schema discovery only, document that this endpoint is for internal use and keep result set minimal.

---

### 3) `TOP` usage (performance guidance recommends filters instead)
**Files:**
- `backend/server.py` — `/debug/budget-schema`
- `backend/server.py` — `core_checks` in `/check-permissions`

**Examples:**
```
SELECT TOP 10 ...
SELECT TOP 1 id, acctnumber FROM Account WHERE isinactive = 'F'
SELECT TOP 1 id, periodname FROM AccountingPeriod
```

**Why this conflicts:** NetSuite guidance notes `TOP` can be slower in the virtual schema; prefer filtering by indexed fields (e.g., `id` ranges).

**Suggested refactor:**
- Replace `TOP` with an indexed filter such as `WHERE id <= <threshold>` or `ORDER BY id FETCH FIRST 1 ROWS ONLY` (if supported in your account).
- For existence checks, prefer small filters:
  - `WHERE isinactive = 'F' AND id IS NOT NULL`

---

### 4) Potential `IN` list size risk (not enforced)
**Files:**
- `backend-dotnet/Controllers/BalanceController.cs` and other query builders

**Example pattern:**
```
AND t.postingperiod IN ({periodIdList})
AND tl.subsidiary IN ({subFilter})
```

**Why this may conflict:** SuiteQL has a **1000 item limit** per `IN` clause, but our current usage is expected to remain well under this threshold.

**Suggested refactor (deferred):**
- No change required now. If future requirements expand the lists, add batching logic or split queries per chunk.
