# XAVI Custom Function Definitions for Excel Crash Debugging

## All Custom Functions Registered

### 1. NAME
**Function Signature:**
```javascript
async function NAME(accountNumber, invocation)
```

**Decorators/Annotations:**
- `@customfunction NAME`
- `@requiresAddress`
- `@cancelable`

**Return Type:** `Promise<string>`

**Is Async:** Yes

**Returns Arrays:** No

**Registration:** `CustomFunctions.associate('NAME', NAME);`

---

### 2. TYPE
**Function Signature:**
```javascript
async function TYPE(accountNumber, invocation)
```

**Decorators/Annotations:**
- `@customfunction TYPE`
- `@requiresAddress`
- `@cancelable`

**Return Type:** `Promise<string>`

**Is Async:** Yes

**Returns Arrays:** No

**Registration:** `CustomFunctions.associate('TYPE', TYPE);`

---

### 3. PARENT
**Function Signature:**
```javascript
async function PARENT(accountNumber, invocation)
```

**Decorators/Annotations:**
- `@customfunction PARENT`
- `@requiresAddress`
- `@cancelable`

**Return Type:** `Promise<string>`

**Is Async:** Yes

**Returns Arrays:** No

**Registration:** `CustomFunctions.associate('PARENT', PARENT);`

---

### 4. BALANCE
**Function Signature:**
```javascript
async function BALANCE(account, fromPeriod, toPeriod, subsidiary, department, location, classId, accountingBook)
```

**Decorators/Annotations:**
- `@customfunction BALANCE`
- `@requiresAddress`

**Return Type:** `Promise<number>` (can also return error strings like `'#ERROR#'`, `'#MISSING_ACCT#'`, etc.)

**Is Async:** Yes

**Returns Arrays:** No

**Registration:** `CustomFunctions.associate('BALANCE', BALANCE);`

**functions.json metadata:**
- Result type: `number`, dimensionality: `scalar`
- Options: `stream: false`, `cancelable: false`, `volatile: false`

---

### 5. BALANCECURRENCY
**Function Signature:**
```javascript
async function BALANCECURRENCY(account, fromPeriod, toPeriod, subsidiary, currency, department, location, classId, accountingBook)
```

**Decorators/Annotations:**
- `@customfunction BALANCECURRENCY`
- `@requiresAddress`

**Return Type:** `Promise<number|string>` (can return error codes)

**Is Async:** Yes

**Returns Arrays:** No

**Registration:** `CustomFunctions.associate('BALANCECURRENCY', BALANCECURRENCY);`

**functions.json metadata:**
- Result type: `number`, dimensionality: `scalar`
- Options: `stream: false`, `cancelable: false`, `volatile: false`

---

### 6. BALANCECHANGE
**Function Signature:**
```javascript
async function BALANCECHANGE(account, fromPeriod, toPeriod, subsidiary, department, location, classId, accountingBook)
```

**Decorators/Annotations:**
- `@customfunction BALANCECHANGE`
- `@requiresAddress`

**Return Type:** `Promise<number|string>` (can return error codes like `'#INVALIDACCT#'`)

**Is Async:** Yes

**Returns Arrays:** No

**Registration:** `CustomFunctions.associate('BALANCECHANGE', BALANCECHANGE);`

**functions.json metadata:**
- Result type: `number`, dimensionality: `scalar`
- Options: `stream: false`, `cancelable: false`, `volatile: false`

---

### 7. BUDGET
**Function Signature:**
```javascript
async function BUDGET(account, fromPeriod, toPeriod, subsidiary, department, location, classId, accountingBook, budgetCategory)
```

**Decorators/Annotations:**
- `@customfunction BUDGET`
- `@requiresAddress`

**Return Type:** `Promise<number>`

**Is Async:** Yes

**Returns Arrays:** No

**Registration:** `CustomFunctions.associate('BUDGET', BUDGET);`

**functions.json metadata:**
- Result type: `number`, dimensionality: `scalar`
- Options: `stream: false`, `cancelable: false`, `volatile: false`

---

### 8. RETAINEDEARNINGS
**Function Signature:**
```javascript
async function RETAINEDEARNINGS(period, subsidiary, accountingBook, classId, department, location)
```

**Decorators/Annotations:**
- `@customfunction RETAINEDEARNINGS`
- (No `@requiresAddress` decorator)

**Return Type:** `Promise<number>`

**Is Async:** Yes

**Returns Arrays:** No

**Registration:** `CustomFunctions.associate('RETAINEDEARNINGS', RETAINEDEARNINGS);`

**functions.json metadata:**
- Result type: `number`, dimensionality: `scalar`
- Options: `stream: false`, `cancelable: false`, `volatile: false`

---

### 9. NETINCOME
**Function Signature:**
```javascript
async function NETINCOME(fromPeriod, toPeriod, subsidiary, accountingBook, classId, department, location)
```

**Decorators/Annotations:**
- `@customfunction NETINCOME`
- (No `@requiresAddress` decorator)

**Return Type:** `Promise<number>`

**Is Async:** Yes

**Returns Arrays:** No

**Registration:** `CustomFunctions.associate('NETINCOME', NETINCOME);`

**functions.json metadata:**
- Result type: `number`, dimensionality: `scalar`
- Options: `stream: false`, `cancelable: false`, `volatile: false`

---

### 10. TYPEBALANCE
**Function Signature:**
```javascript
async function TYPEBALANCE(accountType, fromPeriod, toPeriod, subsidiary, department, location, classId, accountingBook, useSpecialAccount)
```

**Decorators/Annotations:**
- `@customfunction TYPEBALANCE`
- (No `@requiresAddress` decorator)

**Return Type:** `Promise<number>`

**Is Async:** Yes

**Returns Arrays:** No

**Registration:** `CustomFunctions.associate('TYPEBALANCE', TYPEBALANCE);`

**functions.json metadata:**
- Result type: `number`, dimensionality: `scalar`
- Options: `stream: false`, `cancelable: false`, `volatile: false`

---

### 11. CTA
**Function Signature:**
```javascript
async function CTA(period, subsidiary, accountingBook)
```

**Decorators/Annotations:**
- `@customfunction CTA`
- (No `@requiresAddress` decorator)

**Return Type:** `Promise<number>`

**Is Async:** Yes

**Returns Arrays:** No

**Registration:** `CustomFunctions.associate('CTA', CTA);`

**functions.json metadata:**
- Result type: `number`, dimensionality: `scalar`
- Options: `stream: false`, `cancelable: false`, `volatile: false`

---

### 12. CLEARCACHE
**Function Signature:**
```javascript
function CLEARCACHE(itemsJson)
```

**Decorators/Annotations:**
- `@customfunction CLEARCACHE`
- (No `@requiresAddress` decorator)
- (No `@cancelable` decorator)

**Return Type:** `string` (synchronous, not async)

**Is Async:** No (synchronous function)

**Returns Arrays:** No

**Registration:** `CustomFunctions.associate('CLEARCACHE', CLEARCACHE);`

**functions.json metadata:**
- Result type: `string`, dimensionality: `scalar`
- Options: `stream: false`, `cancelable: false`, `volatile: true`

---

## Key Observations

1. **Functions with `@requiresAddress`:** NAME, TYPE, PARENT, BALANCE, BALANCECURRENCY, BALANCECHANGE, BUDGET
2. **Functions with `@cancelable`:** NAME, TYPE, PARENT (only these three)
3. **Synchronous function:** CLEARCACHE (all others are async)
4. **All functions return scalars** (no arrays)
5. **All async functions return Promises** (Promise<string> or Promise<number>)
6. **Registration happens in:** `registerCustomFunctions()` function, called after `Office.onReady()`

## Registration Code Location

```javascript
CustomFunctions.associate('NAME', NAME);
CustomFunctions.associate('TYPE', TYPE);
CustomFunctions.associate('PARENT', PARENT);
CustomFunctions.associate('BALANCE', BALANCE);
CustomFunctions.associate('BALANCECURRENCY', BALANCECURRENCY);
CustomFunctions.associate('BALANCECHANGE', BALANCECHANGE);
CustomFunctions.associate('BUDGET', BUDGET);
CustomFunctions.associate('RETAINEDEARNINGS', RETAINEDEARNINGS);
CustomFunctions.associate('NETINCOME', NETINCOME);
CustomFunctions.associate('TYPEBALANCE', TYPEBALANCE);
CustomFunctions.associate('CTA', CTA);
CustomFunctions.associate('CLEARCACHE', CLEARCACHE);
```

## Potential Crash Triggers to Check

1. **Mismatch between functions.json and actual function signatures** - parameter count/order
2. **@requiresAddress on functions that don't need it** - may cause issues when typing
3. **@cancelable on only some functions** - inconsistent cancellation support
4. **CLEARCACHE is volatile but synchronous** - may cause issues during autocomplete
5. **All functions are async except CLEARCACHE** - mixed sync/async might cause issues
6. **Functions that return error strings** (BALANCE, BALANCECURRENCY, BALANCECHANGE) - type mismatch with Promise<number>

