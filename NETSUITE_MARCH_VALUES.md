# NetSuite March 2025 Values (Reference)

## Balance Sheet Accounts - March 2025

| Account | Account Name | NetSuite Value (March) | Excel Value (from logs) | Status |
|---------|--------------|------------------------|------------------------|--------|
| 10010 | SVB Cash Sweep MMA | $1,021,295.03 | $1,021,295.03 | ✅ MATCH |
| 10012 | SVB Operating | $999,831.00 | $999,831.00 | ✅ MATCH |
| 10030 | JPMC Operating | $1,147,358.00 | $1,147,358.00 | ✅ MATCH |
| 10031 | JPMC Accounts Receivable | $102,779.49 | $102,779.49 | ✅ MATCH |
| 10034 | JP Morgan Money Market Fund | $14,683,853.14 | $14,683,853.14 | ✅ MATCH |
| 10200 | HDFC (INR) | $3,074,570.97 | $3,146,062.34 | ❌ MISMATCH (-$71,491.37) |
| 10201 | HDFC Savings (INR) | $843,761.11 | $865,262.26 | ❌ MISMATCH (-$21,501.15) |
| 10202 | Citibank (INR) | $101,635.68 | $111,801.63 | ❌ MISMATCH (-$10,165.95) |
| 10400 | HSBC Operating - Netherlands (EUR) | $11,825.69 | $4,200.93 | ❌ MISMATCH (+$7,624.76) |
| 10401 | HSBC Operating - UK (GBP) | $1,992.17 | -$2,408.22 | ❌ MISMATCH (+$4,400.39) |
| 10403 | HSBC Operating - Germany (EUR) | $2,065.72 | $2,006.78 | ❌ MISMATCH (+$58.94) |
| 10411 | JPMC Netherlands (EUR) | $65,143.33 | $65,143.33 | ✅ MATCH |
| 10413 | JPMC UK (GBP) | $9,417.42 | $9,417.42 | ✅ MATCH |
| 10502 | JPMC Celigo Australia (AUD) | $138,347.72 | $142,022.80 | ❌ MISMATCH (-$3,675.08) |
| 10898 | Petty Cash (INR) | $423.47 | $440.42 | ❌ MISMATCH (-$16.95) |

## Accounts with Mismatches (Yellow Highlighted)

1. **10200 - HDFC (INR)**: Excel shows $71,491.37 MORE than NetSuite
2. **10201 - HDFC Savings (INR)**: Excel shows $21,501.15 MORE than NetSuite
3. **10202 - Citibank (INR)**: Excel shows $10,165.95 MORE than NetSuite
4. **10400 - HSBC Operating - Netherlands (EUR)**: Excel shows $7,624.76 LESS than NetSuite
5. **10401 - HSBC Operating - UK (GBP)**: Excel shows $4,400.39 LESS than NetSuite (negative value)
6. **10403 - HSBC Operating - Germany (EUR)**: Excel shows $58.94 LESS than NetSuite
7. **10502 - JPMC Celigo Australia (AUD)**: Excel shows $3,675.08 MORE than NetSuite
8. **10898 - Petty Cash (INR)**: Excel shows $16.95 MORE than NetSuite

## Pattern Analysis

- **INR accounts (10200, 10201, 10202)**: All showing higher values in Excel
- **EUR/GBP accounts (10400, 10401, 10403)**: Mixed - some higher, some lower
- **AUD account (10502)**: Higher in Excel
- **USD accounts**: Mostly matching correctly

## Next Steps

1. Wait for user's debugging output
2. Compare opening balances and period activity from logs
3. Check if currency conversion or exchange rate issues
4. Verify backend period activity queries for mismatched accounts

