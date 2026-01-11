# NetSuite Non-OneWorld Accounts Research

## Research Summary

Based on NetSuite documentation and common behavior patterns:

### Accounting Books Feature

**Key Finding**: Accounting Books is a feature that is **available in both OneWorld and non-OneWorld accounts**, but with different capabilities:

1. **OneWorld Accounts**:
   - Can have multiple accounting books
   - Each book can be associated with specific subsidiaries
   - Books are used for multi-currency consolidation and reporting
   - Books can have different base currencies

2. **Non-OneWorld Accounts**:
   - Can still have accounting books (typically just one, called "Primary Book" or "Book 1")
   - Even without OneWorld, NetSuite still maintains a "subsidiary" structure internally
   - The default subsidiary is typically the root/parent subsidiary (ID: 1)
   - All transactions are associated with this default subsidiary, even if the account doesn't explicitly use subsidiaries

### Subsidiaries in Non-OneWorld Accounts

**Critical Finding**: Even in non-OneWorld accounts, NetSuite **always has at least one subsidiary**:

1. **Default Subsidiary**: Every NetSuite account has a root/parent subsidiary (typically ID: 1, name: "Root" or the company name)
2. **Hidden Subsidiary**: This subsidiary exists in the background even if the account doesn't have OneWorld enabled
3. **Transaction Association**: All transactions are associated with this default subsidiary, even if the user never explicitly selects one

### Impact on Your Code

**Good News**: Your code should work correctly in non-OneWorld accounts because:

1. **Default Book**: The code defaults to book "1" (Primary Book), which exists in all accounts
2. **Default Subsidiary**: The code can use subsidiary ID "1" or the root subsidiary name, which exists in all accounts
3. **Query Behavior**: SuiteQL queries that filter by subsidiary will still work - they'll just return data for the single default subsidiary
4. **No Breaking Changes**: The book-subsidiary relationship cache will still work, it will just show:
   - Book 1 → [Subsidiary 1] (or the root subsidiary name)

### Potential Issues to Watch For

1. **Subsidiary Selection**: In non-OneWorld accounts, users shouldn't see a subsidiary selection modal because there's only one option. However, your code should handle this gracefully.

2. **Book Selection**: Non-OneWorld accounts typically only have Book 1, so users changing to Book 2+ might see errors or empty results.

3. **Cache Behavior**: The book-subsidiary cache will be very simple (1 book, 1 subsidiary), but the caching mechanism should still work.

### Recommendations

1. **Test in Non-OneWorld Account**: If possible, test the add-in in a non-OneWorld NetSuite account to verify:
   - Default book (1) works correctly
   - Default subsidiary (1 or root) is used automatically
   - No errors when trying to access book-subsidiary relationships
   - Cache builds successfully (even if it's just 1 book → 1 subsidiary)

2. **Graceful Degradation**: Consider adding logic to:
   - Hide subsidiary selection if only one subsidiary exists
   - Show a message if user tries to select a book that doesn't exist
   - Handle empty cache results gracefully

3. **Default Behavior**: Ensure that when book is "1" and no subsidiary is specified, the code defaults to subsidiary "1" or the root subsidiary name.

### Conclusion

**Your code should work in non-OneWorld accounts** because:
- NetSuite always has at least one book (Primary Book/Book 1)
- NetSuite always has at least one subsidiary (root/parent, typically ID: 1)
- Your queries will work, they'll just return data for the single default subsidiary
- The cache will work, it will just be simpler (1 book → 1 subsidiary)

**No code changes are required**, but testing in a non-OneWorld account would be valuable to confirm behavior.

