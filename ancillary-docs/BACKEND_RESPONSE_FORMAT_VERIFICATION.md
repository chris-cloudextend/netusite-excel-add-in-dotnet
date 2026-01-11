# Backend Response Format Verification

## Summary
Verified the actual response format from `/batch/bs_preload` endpoint to ensure Claude's transformation logic is correct.

## Backend Response Structure

### Endpoint: `POST /batch/bs_preload`

**Request Body:**
```json
{
  "periods": ["Feb 2025"],
  "subsidiary": "Celigo Inc. (Consolidated)",
  "department": "",
  "location": "",
  "class": "",
  "accountingBook": "1"
}
```

**Response Structure:**
```json
{
  "balances": {
    "10010": {
      "Feb 2025": 12345.67
    },
    "10011": {
      "Feb 2025": 0
    },
    "10012": {
      "Feb 2025": 98765.43
    }
    // ... all 232 BS accounts
  },
  "account_types": {
    "10010": "Bank",
    "10011": "Bank",
    "10012": "Bank"
  },
  "account_names": {
    "10010": "Cash",
    "10011": "Petty Cash",
    "10012": "Operating Account"
  },
  "periods": ["Feb 2025"],
  "elapsed_seconds": 76.9,
  "account_count": 232,
  "period_count": 1,
  "cached_count": 232,
  "filters_hash": "1::::1",
  "request_id": "...",
  "period_results": [
    {
      "period": "Feb 2025",
      "status": "completed",
      "error": null,
      "account_count": 232,
      "elapsed_seconds": 76.9
    }
  ],
  "message": "Loaded 232 Balance Sheet accounts × 1/1 period(s) completed in 76.9s. Individual formulas will now be instant."
}
```

### Key Points

1. **`balances` structure**: `Dictionary<string, Dictionary<string, decimal>>`
   - Outer key: Account number (e.g., "10010")
   - Inner key: Period name (e.g., "Feb 2025")
   - Value: Balance (decimal)

2. **Multi-period support**: If multiple periods are requested:
   ```json
   {
     "balances": {
       "10010": {
         "Jan 2025": 10000.00,
         "Feb 2025": 12345.67,
         "Mar 2025": 15000.00
       }
     }
   }
   ```

3. **Backend code location**: `backend-dotnet/Controllers/BalanceController.cs`
   - Line 804: `var allBalances = new Dictionary<string, Dictionary<string, decimal>>();`
   - Lines 1008-1010: `allBalances[accountNumber][periodName] = balance;`
   - Lines 1104-1118: Response structure

## Frontend Processing (Current)

**Location**: `docs/taskpane.html`, lines 9528-9570

**Current processing**:
```javascript
if (result.balances) {
    for (const [account, periodBalances] of Object.entries(result.balances)) {
        if (typeof periodBalances === 'object') {
            for (const [pName, balance] of Object.entries(periodBalances)) {
                const cacheKey = `balance:${account}:${filtersHash}:${pName}`;
                cacheEntries[cacheKey] = { value: balance, timestamp: Date.now() };
            }
        }
    }
}
```

## Transformation for Claude's Single-Promise Approach

### Required Transformation

For a single period (e.g., "Feb 2025"), transform from:
```json
{
  "balances": {
    "10010": { "Feb 2025": 12345.67 },
    "10011": { "Feb 2025": 0 }
  }
}
```

To:
```json
{
  "10010": 12345.67,
  "10011": 0
}
```

### Implementation

```javascript
async function executeFullPreload(periodKey) {
    const periodQuery = activePeriodQueries.get(periodKey);
    if (!periodQuery) return;
    
    // Parse periodKey: "Feb 2025:1::::1" -> period="Feb 2025", filtersHash="1::::1"
    const [period, filtersHash] = periodKey.split(':');
    
    periodQuery.status = 'executing';
    console.log(`🚀 EXECUTING PRELOAD: ${periodKey}, accounts=${periodQuery.accounts.size}`);
    
    try {
        // Call FULL preload endpoint
        const response = await fetch(`${SERVER_URL}/batch/bs_preload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                periods: [period], // Single period
                subsidiary: extractSubsidiary(filtersHash),
                department: extractDepartment(filtersHash),
                location: extractLocation(filtersHash),
                class: extractClass(filtersHash),
                accountingBook: extractBook(filtersHash)
            })
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        }
        
        const result = await response.json();
        
        // TRANSFORM: Extract balances for the specific period
        // Backend returns: { "10010": { "Feb 2025": 12345.67 }, ... }
        // We need: { "10010": 12345.67, ... }
        const balancesByAccount = {};
        if (result.balances) {
            for (const [account, periodBalances] of Object.entries(result.balances)) {
                // periodBalances is { "Feb 2025": 12345.67 }
                if (periodBalances && typeof periodBalances === 'object') {
                    const balance = periodBalances[period];
                    if (balance !== undefined) {
                        balancesByAccount[account] = balance;
                    }
                }
            }
        }
        
        // Write to localStorage cache (for future lookups)
        writeToLocalStorageCache(balancesByAccount, period, filtersHash);
        
        // Set preload marker
        localStorage.setItem(`preload_complete:${period}:${filtersHash}`, Date.now().toString());
        
        console.log(`✅ PRELOAD COMPLETE: ${period}, accounts=${Object.keys(balancesByAccount).length}`);
        
        // RESOLVE THE PROMISE WITH THE TRANSFORMED DATA
        // This makes ALL awaiting cells get results SIMULTANEOUSLY
        periodQuery._resolve(balancesByAccount);
        
    } catch (error) {
        console.error(`❌ PRELOAD FAILED: ${periodKey}`, error);
        periodQuery._reject(error);
    } finally {
        activePeriodQueries.delete(periodKey);
    }
}
```

### Helper Functions Needed

```javascript
function extractSubsidiary(filtersHash) {
    // filtersHash format: "subsidiary|department|location|class|book"
    const parts = filtersHash.split('|');
    return parts[0] || '';
}

function extractDepartment(filtersHash) {
    const parts = filtersHash.split('|');
    return parts[1] || '';
}

function extractLocation(filtersHash) {
    const parts = filtersHash.split('|');
    return parts[2] || '';
}

function extractClass(filtersHash) {
    const parts = filtersHash.split('|');
    return parts[3] || '';
}

function extractBook(filtersHash) {
    const parts = filtersHash.split('|');
    return parts[4] || '1';
}
```

## Verification

✅ **Backend response format confirmed**:
- Structure: `{ balances: { account: { period: balance } } }`
- Multi-period support: Each account can have multiple periods
- Single period: When one period is requested, each account has one period key

✅ **Transformation is straightforward**:
- Extract `result.balances[account][period]` for each account
- Create flat object: `{ account: balance }`

✅ **No backend changes needed**:
- Backend already returns the correct structure
- Client-side transformation is simple and efficient

## Notes

1. **Multi-period requests**: If multiple periods are requested in one call, the transformation needs to handle that. For Claude's single-promise approach, we should only request one period at a time to keep the promise simple.

2. **Error handling**: If a period is missing from `periodBalances`, the account will be `undefined` in the resolved data. Cells should handle this gracefully (return 0 or trigger individual lookup).

3. **Cache key format**: The cache key format is `balance:${account}:${filtersHash}:${period}`. The transformation should write to cache using this format for consistency.
