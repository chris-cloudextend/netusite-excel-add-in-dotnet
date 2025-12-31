# Batch Period Activity Test Results

## Test Request
- **Accounts**: 21 accounts (10010, 10011, 10012, 10030, 10031, 10032, 10033, 10034, 10200, 10201, 10202, 10206, 10400, 10401, 10403, 10411, 10413, 10502, 10804, 10898, 10899)
- **Period Range**: Feb 2025 → Mar 2025
- **Endpoint**: `/balance?account=<comma-separated>&from_period=Feb%202025&to_period=Mar%202025&batch_mode=true&include_period_breakdown=true`

## Results

### Response
```json
{
    "balance": 0,
    "account": "10010,10011,10012,10030,10031,10032,10033,10034,10200,10201,10202,10206,10400,10401,10403,10411,10413,10502,10804,10898,10899",
    "account_name": null,
    "account_type": null,
    "from_period": "Feb 2025",
    "to_period": "Mar 2025",
    "currency": null,
    "cached": false,
    "debug_query": null,
    "error": "SERVERERR"
}
```

## Issue Analysis

1. **Response Type**: The response is a `BalanceResponse` with `error: "SERVERERR"`, not a `BatchPeriodActivityResponse` with `period_activity` dictionary.

2. **Exception Handling**: The exception is being caught somewhere and transformed to a `BalanceResponse` instead of returning a proper `BatchPeriodActivityResponse` or a 500 error.

3. **Possible Causes**:
   - Exception in `GetPeriodsInRangeAsync()` when checking period count limits (line 134)
   - Exception in `GetPeriodActivityBatchAsync()` during execution
   - Exception in period resolution or query execution
   - Global error handling middleware transforming exceptions

4. **Expected Response Shape**:
```json
{
    "period_activity": {
        "10010": {
            "Feb 2025": <activity>,
            "Mar 2025": <activity>
        },
        "10011": {
            "Feb 2025": <activity>,
            "Mar 2025": <activity>
        },
        ...
    }
}
```

## Next Steps

1. **Check Backend Logs**: Review server logs to identify the exact exception being thrown
2. **Test Period Resolution**: Verify that "Feb 2025" and "Mar 2025" can be resolved correctly
3. **Test Single Account**: Verify that single-account batch mode works (falls through to `GetPeriodActivityBreakdownAsync`)
4. **Add Error Logging**: Add more detailed error logging in `GetPeriodActivityBatchAsync` to identify the failure point

## Workaround

Until the backend issue is resolved, the frontend should:
- Fall back to per-cell logic when batch mode returns an error
- Log the error for debugging
- Continue using the old row-based batching path for now

