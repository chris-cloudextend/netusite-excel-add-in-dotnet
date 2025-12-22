# Balance Sheet Hierarchy Design

## Target Structure (NetSuite Standard)

```
Assets
  Current Assets
    Bank (type header)
      Parent Account (if exists)
        10000 - Chase Checking
        10001 - Chase Money Market
        Total Parent Account (subtotal)
      Total Bank (type subtotal)
    Accounts Receivable (type header)
      11000 - Accounts Receivable
      Total Accounts Receivable (type subtotal)
    Other Current Asset (type header)
      ...
  Fixed Assets
    Fixed Asset (type header)
      ...
```

## Current Implementation

- ✅ Section (Assets, Liabilities, Equity)
- ✅ Subsection (Current Assets, Fixed Assets, etc.)
- ✅ Parent Account Headers (is_parent_header)
- ✅ Individual Accounts
- ✅ Subtotals for parent accounts
- ❌ **Missing: Account Type Category Headers**

## Proposed Solution

### Hierarchy Levels

1. **Section** (Assets, Liabilities, Equity)
2. **Subsection** (Current Assets, Fixed Assets, etc.)
3. **Account Type Category** (Bank, Accounts Receivable, etc.) - **NEW**
4. **Parent Account Header** (if account has parent)
5. **Individual Accounts**
6. **Subtotals** (for parent accounts, then for type category)

### Implementation Strategy

#### Backend Changes

1. **Add new fields to BalanceSheetRow:**
   - `is_type_header: bool` - true if this is an account type category header
   - `type_category: string?` - the account type display name (e.g., "Bank", "Accounts Receivable")

2. **Modify ordering algorithm:**
   - Group accounts by: Section → Subsection → Account Type → Parent Hierarchy
   - Create type header rows before each account type group
   - Create type subtotal rows after each account type group

3. **Type header logic:**
   - For each unique account type in a subsection, create a header row
   - Header row has: `is_type_header = true`, `type_category = AccountType.GetDisplayName(acctType)`
   - Only create header if there are accounts of that type

4. **Type subtotal logic:**
   - After all accounts of a type (including parent hierarchies), add a subtotal
   - Subtotal row has: `is_subtotal = true`, `source = "TypeSubtotal"`

#### Frontend Changes

1. **Render type headers:**
   - If `row.is_type_header === true`:
     - Render as bold header with account type name (e.g., "Bank")
     - Use different styling (background color, font size)
     - No formula, just label

2. **Render type subtotals:**
   - If `row.is_subtotal === true && row.source === "TypeSubtotal"`:
     - Render as "Total [Type Name]" (e.g., "Total Bank")
     - Use SUBTOTAL formula to sum all accounts of that type

### Account Type Ordering (within subsection)

For Current Assets:
1. Bank
2. Accounts Receivable
3. Other Current Asset
4. Deferred Expense
5. Unbilled Receivable

For Fixed Assets:
1. Fixed Asset

For Current Liabilities:
1. Accounts Payable
2. Credit Card
3. Other Current Liability
4. Deferred Revenue

For Long Term Liabilities:
1. Long Term Liability

For Equity:
1. Equity
2. Retained Earnings

### Example Output Structure

```
Assets
  Current Assets
    Bank (type header)
      [Parent accounts with children, if any]
        [Child accounts]
        Total [Parent Name] (parent subtotal)
      [Top-level bank accounts]
      Total Bank (type subtotal)
    Accounts Receivable (type header)
      [Accounts Receivable accounts]
      Total Accounts Receivable (type subtotal)
    ...
```

## Benefits

1. **Matches NetSuite structure** - Users see familiar grouping
2. **Clear organization** - Accounts grouped by type, then by parent
3. **Easy to read** - Type headers make it clear what category accounts belong to
4. **Flexible** - Works with or without parent accounts
5. **Maintainable** - Uses existing account type system

## Implementation Notes

- Type headers are created dynamically based on which account types exist in the data
- If an account type has no accounts, no header is created
- Parent account hierarchies are preserved within each type group
- Type subtotals sum all accounts of that type (including parent account balances if they have balances)

