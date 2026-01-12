ENGINEERING_RULES.md

Purpose
This project integrates NetSuite financial data into Excel using Microsoft Office add-ins, SuiteQL, and accounting logic.
Correctness of financial numbers is the highest priority. Performance and convenience are secondary.

⸻

1. Accounting correctness (highest priority)
	•	Never return 0 unless the value is proven by NetSuite data to be zero.
	•	Never substitute missing, unknown, loading, or error states with 0.
	•	Phantom numbers are unacceptable.
	•	If data is incomplete or uncertain, prefer:
	•	BUSY state
	•	explicit error
	•	blank result
over returning a numeric value.

⸻

2. Zero vs missing data
	•	Zero is a valid accounting result and must be cached.
	•	Missing data must be explicitly distinguishable from zero.
	•	Cache lookups must differentiate:
	•	cache miss
	•	cache hit with value 0
	•	cache hit with non-zero value
	•	Cache logic must never fabricate values.

⸻

3. NetSuite financial semantics
	•	All balances must respect:
	•	accounting book
	•	subsidiary
	•	accounting period semantics (Mon YYYY)
	•	segment filters (department, class, location, etc.)
	•	LEFT JOINs must not be invalidated by WHERE clauses.
	•	Segment filters must affect aggregation logic, not merely joins.
	•	“Zero after filters” must still return 0, not be excluded.

⸻

4. Excel add-in execution model
	•	Custom functions may execute:
	•	multiple times
	•	out of order
	•	concurrently
	•	while the sheet is mutating
	•	Code must be safe under:
	•	drag-fill
	•	recalc storms
	•	build/batch mode
	•	Never assume a single execution path or timing order.

⸻

5. Caching invariants
	•	Cache keys must be canonical and identical across:
	•	backend
	•	taskpane
	•	custom functions
	•	All cache keys must use normalized "Mon YYYY" periods.
	•	Cache misses must not produce numeric output.
	•	Preload is an optimization only and must never affect correctness.

⸻

6. Preload behavior
	•	Preload failure must never change results.
	•	Formulas must re-check cache after preload completes.
	•	Multiple preload triggers must not overwrite or lose periods.
	•	New periods must be detected even during ongoing preload.

⸻

7. Error handling philosophy
	•	Silent failures are unacceptable.
	•	If correctness cannot be guaranteed:
	•	log explicitly
	•	surface an error or BUSY state
	•	Performance optimizations must never mask correctness issues.

⸻

8. When uncertain
	•	Stop.
	•	Explain uncertainty.
	•	Ask for clarification.
	•	Do not guess.

⸻


