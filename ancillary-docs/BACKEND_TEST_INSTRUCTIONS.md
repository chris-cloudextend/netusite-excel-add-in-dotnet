# Backend TYPEBALANCE Test Instructions

## Quick Test

Run the test script to query the backend and document all results:

```bash
# Make sure the backend server is running first
./test-typebalance-backend.sh http://localhost:5002 2025 "Celigo India Pvt Ltd" 2
```

**Note:** Adjust the port (5002) if your server runs on a different port.

## Manual Test via curl

If the script doesn't work, you can test manually:

```bash
curl -X POST http://localhost:5002/batch/typebalance_refresh \
  -H "Content-Type: application/json" \
  -d '{
    "year": 2025,
    "subsidiary": "Celigo India Pvt Ltd",
    "department": null,
    "location": null,
    "class": null,
    "book": "2"
  }' | jq '.'
```

## What to Look For

The test will generate:
1. **Console output** showing all account types and periods with values
2. **Markdown report** (`TYPEBALANCE_RESULTS_*.md`) with formatted tables
3. **JSON file** (`typebalance-results-*.json`) with full response

## Expected Findings

Based on the console logs:
- **Income:** All $0.00 (this is the bug)
- **COGS:** Should have values (check which months)
- **Expense:** Should have values (check which months)
- **OthIncome:** Should have values (check which months)
- **OthExpense:** Should have values (check which months)

## Backend Logs to Check

After running the test, check the backend logs for:
- `[REVENUE DEBUG]` messages showing Income row analysis
- Diagnostic query results showing if Income transactions exist
- Test query results comparing raw vs consolidated amounts

## Next Steps After Testing

1. Document the actual values returned for each account type
2. Compare batch query results with individual query results
3. Check if `BUILTIN.CONSOLIDATE` is returning NULL for Income
4. Verify the query structure matches individual queries exactly

