# TYPEBALANCE Backend Test Findings

**Date:** 2026-01-05  
**Test:** Batch TYPEBALANCE query for Book 2, India subsidiary, Year 2025

## Summary from Console Logs

### Income (Revenue) - ❌ ALL ZEROS
From `taskpanehtml` logs:
- Backend returns Income row with all 12 months
- All values are **$0.00**
- Verification shows "10/10 months present" but values are zero
- Cache keys are being created correctly: `typebalance:Income:Jan 2025:Jan 2025:Celigo India Pvt Ltd::::2:0 = 0`

### Expense - ✅ HAS DATA
From logs:
- Expense:Mar 2025 = **$49,029,514**
- Expense:Dec 2025 = **$7,380,682.23**
- 10/10 months present with data

### Other Account Types
From `runtime` logs, cache shows:
- **COGS:** Has values (e.g., May 2025 = $5,833,114.42, Jun 2025 = $6,477,281.67)
- **OthIncome:** Has values (e.g., Apr 2025 = $670,739, May 2025 = $415,039)
- **OthExpense:** Has values (e.g., Nov 2025 = $7,265,014.09, Jun 2025 = $7,848,983.09)

## Detailed Findings by Account Type

### Income (Revenue)
| Period | Cache Value | Status |
|--------|-------------|--------|
| Jan 2025 | $0.00 | ❌ |
| Feb 2025 | $0.00 | ❌ |
| Mar 2025 | $0.00 | ❌ |
| Apr 2025 | $0.00 | ❌ |
| May 2025 | $0.00 | ❌ |
| Jun 2025 | $0.00 | ❌ |
| Jul 2025 | $0.00 | ❌ |
| Aug 2025 | $0.00 | ❌ |
| Sep 2025 | $0.00 | ❌ |
| Oct 2025 | $0.00 | ❌ |
| Nov 2025 | $0.00 | ❌ |
| Dec 2025 | $0.00 | ❌ |
| **Total** | **$0.00** | **0/12 months** |

### COGS
| Period | Cache Value | Status |
|--------|-------------|--------|
| Jan 2025 | $0.00 | ⚠️ |
| Feb 2025 | $0.00 | ⚠️ |
| Mar 2025 | $0.00 | ⚠️ |
| Apr 2025 | $0.00 | ⚠️ |
| May 2025 | $5,833,114.42 | ✅ |
| Jun 2025 | $6,477,281.67 | ✅ |
| Jul 2025 | $6,553,868.76 | ✅ |
| Aug 2025 | $7,393,751.16 | ✅ |
| Sep 2025 | $6,483,003.95 | ✅ |
| Oct 2025 | $6,371,159.62 | ✅ |
| Nov 2025 | $6,911,780.31 | ✅ |
| Dec 2025 | $0.00 | ⚠️ |
| **Total** | **~$45M** | **7/12 months** |

### Expense
| Period | Cache Value | Status |
|--------|-------------|--------|
| Jan 2025 | $0.00 | ⚠️ |
| Feb 2025 | $0.00 | ⚠️ |
| Mar 2025 | $49,029,514 | ✅ |
| Apr 2025 | $0.00 | ⚠️ |
| May 2025 | $0.00 | ⚠️ |
| Jun 2025 | $0.00 | ⚠️ |
| Jul 2025 | $0.00 | ⚠️ |
| Aug 2025 | $0.00 | ⚠️ |
| Sep 2025 | $0.00 | ⚠️ |
| Oct 2025 | $0.00 | ⚠️ |
| Nov 2025 | $0.00 | ⚠️ |
| Dec 2025 | $7,380,682.23 | ✅ |
| **Total** | **~$56M** | **2/12 months** |

### OthIncome
| Period | Cache Value | Status |
|--------|-------------|--------|
| Jan 2025 | $0.00 | ⚠️ |
| Feb 2025 | $0.00 | ⚠️ |
| Mar 2025 | $0.00 | ⚠️ |
| Apr 2025 | $670,739 | ✅ |
| May 2025 | $415,039 | ✅ |
| Jun 2025 | $444,226 | ✅ |
| Jul 2025 | $421,363 | ✅ |
| Aug 2025 | $444,439 | ✅ |
| Sep 2025 | $422,589 | ✅ |
| Oct 2025 | $196,076 | ✅ |
| Nov 2025 | $670,739 | ✅ |
| Dec 2025 | $188,526 | ✅ |
| **Total** | **~$4.1M** | **9/12 months** |

### OthExpense
| Period | Cache Value | Status |
|--------|-------------|--------|
| Jan 2025 | $0.00 | ⚠️ |
| Feb 2025 | $0.00 | ⚠️ |
| Mar 2025 | $0.00 | ⚠️ |
| Apr 2025 | $4,254,166.01 | ✅ |
| May 2025 | $0.00 | ⚠️ |
| Jun 2025 | $7,848,983.09 | ✅ |
| Jul 2025 | $6,304,670.53 | ✅ |
| Aug 2025 | $4,662,120.84 | ✅ |
| Sep 2025 | $5,134,108.51 | ✅ |
| Oct 2025 | $3,794,152.65 | ✅ |
| Nov 2025 | $7,265,014.09 | ✅ |
| Dec 2025 | $210 | ✅ |
| **Total** | **~$38.2M** | **8/12 months** |

## Key Observations

1. **Income is the ONLY account type with ALL zeros** - all other types have data
2. **Expense has data but only 2 months** (Mar and Dec) - this is also suspicious
3. **COGS, OthIncome, OthExpense all have data** for multiple months
4. **The backend IS returning the Income row** - it's not missing, just all zeros

## Root Cause Hypothesis

The batch query structure was changed to match individual queries (removed COALESCE), but Income is still returning zeros. This suggests:

1. **BUILTIN.CONSOLIDATE might be returning NULL for Income** - The diagnostic queries in the backend should reveal this
2. **Sign flip might be incorrect** - Income accounts need negative values, but if BUILTIN.CONSOLIDATE returns NULL, `NULL * -1 = NULL` (which SUM ignores)
3. **Period filtering might be wrong** - But this seems unlikely since other account types work

## Next Steps

1. ✅ Check backend logs for `[REVENUE DEBUG]` messages
2. ✅ Run diagnostic queries to see if Income transactions exist
3. ⬜ Compare batch query SQL with individual query SQL side-by-side
4. ⬜ Test if `BUILTIN.CONSOLIDATE` returns NULL for Income accounts
5. ⬜ Check if raw `tal.amount` values exist for Income (before consolidation)

## Test Script

Run the backend test to get actual values:

```bash
./test-typebalance-backend.sh http://localhost:5002 2025 "Celigo India Pvt Ltd" 2
```

This will generate a detailed report with all values.

