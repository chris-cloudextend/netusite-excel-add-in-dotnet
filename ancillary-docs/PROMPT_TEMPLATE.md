# Code Change Request Template

Use this template when requesting code changes to ensure thorough review and consistency.

## Template

```
I need to [DESCRIBE THE CHANGE/ISSUE].

**Working Reference:**
- Similar working code: [FUNCTION/FILE that works correctly]
- Pattern to follow: [SPECIFIC PATTERN or approach]

**Requirements:**
- [ ] Don't change [WORKING CODE] - it works correctly
- [ ] Make [TARGET CODE] match [WORKING CODE]'s approach
- [ ] Review and compare before implementing
- [ ] Check for impact on: [LIST RELATED FUNCTIONS/FILES]

**Before Making Changes:**
1. Show me a side-by-side comparison of [WORKING CODE] vs [TARGET CODE]
2. Explain the differences and why they exist
3. Identify all places that use similar patterns
4. List potential edge cases or breaking changes

**After Changes:**
- Verify consistency across all similar functions
- Ensure no regressions in working code
- Test with: [SPECIFIC TEST SCENARIOS]
```

## Example Usage

```
I need to fix date parameter handling in BALANCECURRENCY.

**Working Reference:**
- Similar working code: BALANCE function (handles fromPeriod/toPeriod correctly)
- Pattern to follow: How BALANCE converts date parameters using convertToMonthYear

**Requirements:**
- [ ] Don't change BALANCE function - it works correctly
- [ ] Make BALANCECURRENCY match BALANCE's date handling approach
- [ ] Review and compare before implementing
- [ ] Check for impact on: TYPEBALANCE, BUDGET (all use date parameters)

**Before Making Changes:**
1. Show me a side-by-side comparison of BALANCE vs BALANCECURRENCY date handling
2. Explain the differences and why they exist
3. Identify all places that use convertToMonthYear
4. List potential edge cases (Range objects, date serials, period strings)

**After Changes:**
- Verify consistency across all date-handling functions
- Ensure no regressions in BALANCE
- Test with: single periods, period ranges, cell references, hardcoded dates
```

## Quick Version (For Simple Changes)

```
Fix [ISSUE] in [TARGET].

**Reference:** [WORKING CODE that does this correctly]

**Before implementing:**
- Compare [TARGET] to [WORKING CODE]
- Show differences
- Don't change [WORKING CODE]

**After:**
- Verify consistency
- Test: [SCENARIOS]
```

