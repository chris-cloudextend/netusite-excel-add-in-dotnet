# Future Data Sources - XAVI Multi-ERP Expansion Analysis

## Executive Summary

XAVI's architecture is designed with a clean separation between the Excel formula layer and the backend data retrieval. This document analyzes the feasibility, effort, and technical considerations for extending XAVI to support:

1. **QuickBooks Online** (Intuit)
2. **Xero** (Xero Limited)
3. **Acumatica** (Acumatica Inc.)
4. **Sage Intacct** (Sage Group)

### Compatibility Matrix

| Feature | NetSuite | Sage Intacct | Acumatica | Xero | QuickBooks Online |
|---------|----------|--------------|-----------|------|-------------------|
| SQL/Query Language | ✅ SuiteQL | ✅ SQL-like | ✅ OData | ❌ REST only | ❌ REST only |
| Multi-Currency | ✅ Full | ✅ Full | ✅ Full | ⚠️ Limited | ⚠️ Basic |
| Multi-Book Accounting | ✅ Full | ✅ Full | ✅ Full | ❌ No | ❌ No |
| Subsidiaries/Entities | ✅ Yes | ✅ Yes | ✅ Yes | ⚠️ Orgs | ❌ No |
| Dimensions (Dept/Class/Loc) | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Tracking | ⚠️ Plus only |
| Consolidation | ✅ Native | ✅ Native | ✅ Native | ⚠️ Manual | ❌ No |
| API Rate Limits | Moderate | Generous | Generous | Strict | Moderate |
| **Implementation Effort** | ✅ Done | 🟡 Medium | 🟡 Medium | 🟠 Higher | 🟠 Higher |

---

## Current Architecture

```
┌─────────────────────┐     ┌─────────────────────────────────────────────┐
│   Excel Add-in      │     │              Backend API                     │
│   (formulas.js)     │────▶│                                             │
│                     │     │   ┌─────────────────────────────────────┐   │
│   XAVI.BALANCE()    │     │   │     Connection Router                │   │
│   XAVI.BUDGET()     │     │   │     (tenant/ERP selector)           │   │
│   XAVI.NAME()       │     │   └─────────────────────────────────────┘   │
│   XAVI.TYPE()       │     │         │         │         │         │     │
│   XAVI.PARENT()     │     │         ▼         ▼         ▼         ▼     │
│                     │     │   ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌───┐ │
│                     │     │   │NetSuite │ │ Intacct │ │Acumatica│ │...│ │
│                     │     │   │ Adapter │ │ Adapter │ │ Adapter │ │   │ │
│                     │     │   └─────────┘ └─────────┘ └─────────┘ └───┘ │
└─────────────────────┘     └─────────────────────────────────────────────┘
```

**Key Principle**: The Excel formulas remain identical across all ERPs. Only the backend adapters change.

---

## 1. Sage Intacct

### Overview
Sage Intacct is a cloud-native ERP focused on finance and accounting. It's the closest match to NetSuite in terms of capabilities and is AICPA's preferred financial management solution.

### API Capabilities

| Capability | Details |
|------------|---------|
| **API Type** | XML-based Web Services + REST (newer) |
| **Query Language** | `readByQuery` with SQL-like syntax |
| **Authentication** | Web Services credentials + Session-based |
| **Rate Limits** | Generous (based on subscription tier) |

### Query Example (Intacct Read by Query)
```xml
<readByQuery>
    <object>GLENTRY</object>
    <fields>RECORDNO,ACCOUNTNO,AMOUNT,CURRENCY,ENTRY_DATE</fields>
    <query>ACCOUNTNO = '4000' AND ENTRY_DATE >= '01/01/2025'</query>
</readByQuery>
```

### Account Types Mapping

| NetSuite | Sage Intacct |
|----------|--------------|
| Bank | balancesheet (subtype: checking/savings) |
| AcctRec | balancesheet (subtype: accounts receivable) |
| Income | incomestatement |
| Expense | incomestatement |
| Equity | balancesheet (subtype: equity) |
| FixedAsset | balancesheet (subtype: fixed asset) |

### Key Advantages
- ✅ **True SQL-like queries** via `readByQuery` - very similar to SuiteQL
- ✅ **Multi-entity (subsidiary)** support built-in
- ✅ **Multi-book accounting** (Statutory, GAAP, IFRS)
- ✅ **Dimensions** (Department, Location, Class, Project, Customer, Vendor, Item)
- ✅ **Multi-currency** with automatic consolidation
- ✅ **Statistical accounts** supported

### Implementation Approach
```python
class SageIntacctAdapter(ERPAdapter):
    def get_balance(self, account, from_period, to_period, filters):
        # Use readByQuery on GLENTRY or GLACCOUNTBALANCE object
        # GLACCOUNTBALANCE provides period-end balances directly
        query = f"""
            ACCOUNTNO = '{account}' 
            AND REPORTINGPERIODNAME >= '{from_period}'
            AND REPORTINGPERIODNAME <= '{to_period}'
        """
        # Handle entity (subsidiary) filter via LOCATIONID or DEPTID
```

### Effort Estimate
| Task | Days |
|------|------|
| Intacct API Client (XML Web Services) | 3-4 |
| Session Management | 1-2 |
| GL Balance Query Adapter | 3-4 |
| Multi-Entity/Dimension Support | 2-3 |
| Multi-Book Support | 2-3 |
| Account Type Mapping | 1 |
| Testing | 3-4 |
| **Total** | **15-20 days** |

### Complexity: 🟡 Medium
Sage Intacct is the **easiest** expansion after NetSuite due to its SQL-like query capabilities and similar feature set.

---

## 2. Acumatica

### Overview
Acumatica is a cloud and on-premise ERP with a modern REST/OData API. It's developer-friendly and has strong financial management capabilities.

### API Capabilities

| Capability | Details |
|------------|---------|
| **API Type** | REST + OData + Contract-Based SOAP |
| **Query Language** | OData $filter, $select, $expand |
| **Authentication** | OAuth 2.0 or Basic Auth |
| **Rate Limits** | Very generous (license-based) |

### Query Example (Acumatica OData)
```
GET /entity/Default/23.200.001/GLTran
    ?$filter=Account eq '4000' and TranDate ge 2025-01-01
    &$select=Account,DebitAmt,CreditAmt,TranDate,Branch
```

Or using Generic Inquiry:
```
GET /entity/Default/23.200.001/GenericInquiry/GLTransactionDetails
    ?$filter=...
```

### Account Types Mapping

| NetSuite | Acumatica |
|----------|-----------|
| Bank | Asset |
| AcctRec | Asset |
| AcctPay | Liability |
| Income | Income |
| Expense | Expense |
| Equity | Liability (Type=Equity) |

### Key Advantages
- ✅ **OData queries** - flexible filtering and selection
- ✅ **Generic Inquiries** - pre-built reports accessible via API
- ✅ **Multi-branch** (subsidiary equivalent)
- ✅ **Subaccounts** (dimensions similar to NetSuite)
- ✅ **Multi-currency** with consolidation
- ✅ **Ledgers** (multi-book equivalent)
- ✅ **On-premise option** for customers who need it

### Implementation Approach
```python
class AcumaticaAdapter(ERPAdapter):
    def get_balance(self, account, from_period, to_period, filters):
        # Option 1: Query GLTran directly with OData
        # Option 2: Use a Generic Inquiry for GL balances
        # Option 3: Use Financial Period Summary endpoint
        
        endpoint = f"/entity/Default/23.200.001/GLTran"
        params = {
            "$filter": f"Account eq '{account}' and FinPeriodID ge '{period}'",
            "$select": "Account,DebitAmt,CreditAmt,FinPeriodID,Branch"
        }
```

### Effort Estimate
| Task | Days |
|------|------|
| Acumatica API Client (OData) | 2-3 |
| OAuth 2.0 Flow | 2-3 |
| GL Transaction Query Adapter | 3-4 |
| Multi-Branch Support | 2 |
| Subaccount/Dimension Support | 2-3 |
| Ledger (Multi-Book) Support | 2 |
| Account Type Mapping | 1 |
| Testing | 3-4 |
| **Total** | **17-22 days** |

### Complexity: 🟡 Medium
Acumatica's OData API is modern and flexible. The main challenge is mapping Acumatica's data model (Branches, Subaccounts, Ledgers) to our existing filter structure.

---

## 3. Xero

### Overview
Xero is a cloud accounting platform popular with small businesses and accounting firms, particularly in Australia, New Zealand, and the UK.

### API Capabilities

| Capability | Details |
|------------|---------|
| **API Type** | REST (JSON) |
| **Query Language** | No SQL - predefined endpoints only |
| **Authentication** | OAuth 2.0 (PKCE) |
| **Rate Limits** | **Strict** - 60 calls/min, 5000/day |

### Key Limitation: No Raw Query Access
Unlike NetSuite and Intacct, Xero does **not** provide SQL-like query access. You must use:
- **Reports API**: `/Reports/BalanceSheet`, `/Reports/ProfitAndLoss`
- **Journals API**: Individual journal entries
- **Bank Transactions API**: Bank-specific transactions

### Report API Example
```
GET https://api.xero.com/api.xro/2.0/Reports/BalanceSheet
    ?date=2025-01-31
    &trackingCategoryID=xxx
    &trackingOptionID=xxx
```

Response is a structured report (not raw data):
```json
{
  "Reports": [{
    "Rows": [
      { "Cells": [{"Value": "Assets"}, {"Value": "150000.00"}] },
      { "Cells": [{"Value": "Bank"}, {"Value": "50000.00"}] }
    ]
  }]
}
```

### Account Types Mapping

| NetSuite | Xero |
|----------|------|
| Bank | BANK |
| AcctRec | CURRENT (AccountType) |
| AcctPay | CURRLIAB |
| Income | REVENUE |
| Expense | EXPENSE, OVERHEADS, DIRECTCOSTS |
| Equity | EQUITY |
| FixedAsset | FIXED |

### Key Challenges

1. **No SQL**: Must parse pre-formatted reports
2. **Rate Limits**: 60/min is restrictive for batch operations
3. **No Multi-Book**: Xero has single-book accounting only
4. **No Subsidiaries**: Must use separate Xero organizations
5. **Limited Dimensions**: Only "Tracking Categories" (2 max in standard)
6. **Report-Only Balances**: Can't query arbitrary date ranges easily

### Implementation Approach
```python
class XeroAdapter(ERPAdapter):
    def get_balance(self, account, from_period, to_period, filters):
        # Must use Reports API and parse the structured response
        # Balance Sheet: GET /Reports/BalanceSheet?date={to_period}
        # P&L: GET /Reports/ProfitAndLoss?fromDate={from}&toDate={to}
        
        # Parse the Rows/Cells structure to find the account
        # This is significantly more complex than SQL-based ERPs
        
        report = self.client.get_balance_sheet(as_of_date=to_period)
        return self._find_account_in_report(report, account)
```

### Effort Estimate
| Task | Days |
|------|------|
| Xero API Client | 2-3 |
| OAuth 2.0 PKCE Flow | 3-4 |
| Report Parsing Logic | 5-7 |
| Rate Limit Handling | 2-3 |
| Tracking Category Support | 2-3 |
| Account Mapping | 2 |
| Caching (aggressive, due to rate limits) | 2-3 |
| Testing | 4-5 |
| **Total** | **22-30 days** |

### Complexity: 🟠 Higher
Xero's lack of query API makes it the **most challenging** integration. We'd need to:
- Fetch entire reports and parse them
- Implement aggressive caching to avoid rate limits
- Accept limitations on filtering capabilities

### Feature Limitations
| XAVI Feature | Xero Support |
|--------------|--------------|
| `XAVI.BALANCE` | ⚠️ Limited (report parsing) |
| `XAVI.BUDGET` | ❌ No budget API |
| `XAVI.NAME` | ✅ Yes |
| `XAVI.TYPE` | ✅ Yes |
| Multi-Book (accountingBook) | ❌ Not available |
| Subsidiary filter | ❌ Not available |
| Department/Class/Location | ⚠️ Tracking Categories only |

---

## 4. QuickBooks Online

### Overview
QuickBooks Online (QBO) is the most widely used small business accounting software in the US. It has a REST API with pre-built reports.

### API Capabilities

| Capability | Details |
|------------|---------|
| **API Type** | REST (JSON) |
| **Query Language** | Limited SQL subset for some entities |
| **Authentication** | OAuth 2.0 |
| **Rate Limits** | 500 requests/min (sandbox: 100/min) |

### Query Capabilities
QBO has a **limited SQL-like query** for some entities:
```
SELECT * FROM Account WHERE AccountType = 'Income'
SELECT * FROM JournalEntry WHERE TxnDate >= '2025-01-01'
```

But for **balances**, you must use Reports API:
```
GET /v3/company/{companyId}/reports/BalanceSheet
    ?start_date=2025-01-01
    &end_date=2025-01-31
    &accounting_method=Accrual
```

### Account Types Mapping

| NetSuite | QuickBooks Online |
|----------|-------------------|
| Bank | Bank |
| AcctRec | Accounts Receivable |
| AcctPay | Accounts Payable |
| Income | Income |
| Expense | Expense |
| Equity | Equity |
| COGS | Cost of Goods Sold |
| FixedAsset | Fixed Asset |

### Key Challenges

1. **No Multi-Currency Consolidation**: Basic multi-currency only in Plus/Advanced
2. **No Multi-Book**: Single book only
3. **No Subsidiaries**: Separate QBO companies required
4. **Limited Dimensions**: Class and Location only in Plus/Advanced
5. **Token Expiration**: Access tokens expire hourly (refresh required)
6. **Report Parsing**: Similar to Xero - structured reports, not raw data

### Implementation Approach
```python
class QuickBooksAdapter(ERPAdapter):
    def get_balance(self, account, from_period, to_period, filters):
        # For P&L: GET /reports/ProfitAndLoss
        # For BS: GET /reports/BalanceSheet
        
        # Must parse the Rows/Columns structure
        # Account names in QBO may not match account numbers
        
        if self._is_balance_sheet_account(account):
            report = self.client.get_balance_sheet(as_of=to_period)
        else:
            report = self.client.get_profit_and_loss(
                start_date=from_period, 
                end_date=to_period
            )
        return self._extract_account_balance(report, account)
```

### Effort Estimate
| Task | Days |
|------|------|
| QBO API Client | 2-3 |
| OAuth 2.0 Flow + Token Refresh | 3-4 |
| Report Parsing Logic | 4-5 |
| Account Query Support | 2-3 |
| Class/Location Support | 2 |
| Account Type Mapping | 1-2 |
| Token Storage/Management | 2 |
| Testing | 3-4 |
| **Total** | **19-25 days** |

### Complexity: 🟠 Higher
Similar challenges to Xero. The main advantage over Xero is higher rate limits and slightly better query support for non-report entities.

### Feature Limitations
| XAVI Feature | QBO Support |
|--------------|-------------|
| `XAVI.BALANCE` | ⚠️ Limited (report parsing) |
| `XAVI.BUDGET` | ⚠️ Budget vs Actuals report only |
| `XAVI.NAME` | ✅ Yes |
| `XAVI.TYPE` | ✅ Yes |
| Multi-Book (accountingBook) | ❌ Not available |
| Subsidiary filter | ❌ Not available |
| Department filter | ⚠️ Plus/Advanced only |
| Class filter | ⚠️ Plus/Advanced only |

---

## Comparison Summary

### Implementation Effort

| ERP | Effort | Complexity | Notes |
|-----|--------|------------|-------|
| NetSuite | ✅ Done | - | Current implementation |
| Sage Intacct | 15-20 days | 🟡 Medium | SQL-like queries, closest to NetSuite |
| Acumatica | 17-22 days | 🟡 Medium | Modern OData API, flexible |
| QuickBooks Online | 19-25 days | 🟠 Higher | Report parsing, token management |
| Xero | 22-30 days | 🟠 Higher | Strict rate limits, report parsing |

### Feature Parity

| Feature | NetSuite | Intacct | Acumatica | QBO | Xero |
|---------|----------|---------|-----------|-----|------|
| Balance queries | ✅ Full | ✅ Full | ✅ Full | ⚠️ Reports | ⚠️ Reports |
| Budget queries | ✅ Full | ✅ Full | ✅ Full | ⚠️ Limited | ❌ No |
| Multi-currency | ✅ Full | ✅ Full | ✅ Full | ⚠️ Basic | ⚠️ Limited |
| Multi-book | ✅ Full | ✅ Full | ✅ Full | ❌ No | ❌ No |
| Subsidiaries | ✅ Yes | ✅ Entities | ✅ Branches | ❌ No | ⚠️ Orgs |
| Dimensions | ✅ 4+ | ✅ Many | ✅ Many | ⚠️ 2 | ⚠️ 2 |
| Consolidation | ✅ Native | ✅ Native | ✅ Native | ❌ No | ❌ No |

### Recommended Priority

1. **Sage Intacct** (Highest ROI)
   - Most similar to NetSuite
   - Strong query capabilities
   - Enterprise customer base
   - Multi-book, multi-entity support

2. **Acumatica** (Strong Second)
   - Modern API
   - Growing market share
   - Good feature parity
   - Flexible deployment (cloud/on-prem)

3. **QuickBooks Online** (Market Size)
   - Largest market (SMB)
   - Limited features but huge user base
   - Good for simple use cases

4. **Xero** (Regional)
   - Strong in AU/NZ/UK
   - Rate limits are challenging
   - Limited enterprise features

---

## Technical Architecture for Multi-ERP

### Proposed Adapter Pattern

```python
# backend/adapters/base.py
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Optional, Dict, List

@dataclass
class BalanceResult:
    account: str
    period: str
    balance: float
    currency: str = "USD"

@dataclass
class AccountInfo:
    number: str
    name: str
    type: str
    parent: Optional[str] = None

class ERPAdapter(ABC):
    """Base class for all ERP adapters"""
    
    @abstractmethod
    def get_balance(
        self, 
        account: str, 
        from_period: str, 
        to_period: str,
        subsidiary: Optional[str] = None,
        department: Optional[str] = None,
        location: Optional[str] = None,
        class_id: Optional[str] = None,
        accounting_book: Optional[int] = None
    ) -> float:
        """Get account balance for a period"""
        pass
    
    @abstractmethod
    def get_batch_balances(
        self,
        accounts: List[str],
        periods: List[str],
        filters: Dict
    ) -> Dict[str, Dict[str, float]]:
        """Get balances for multiple accounts/periods"""
        pass
    
    @abstractmethod
    def get_account_info(self, account: str) -> AccountInfo:
        """Get account metadata"""
        pass
    
    @abstractmethod
    def get_budget(
        self,
        account: str,
        from_period: str,
        to_period: str,
        filters: Dict
    ) -> float:
        """Get budget amount"""
        pass
    
    def supports_feature(self, feature: str) -> bool:
        """Check if this ERP supports a feature"""
        return feature in self.supported_features
    
    @property
    @abstractmethod
    def supported_features(self) -> set:
        """Return set of supported features"""
        pass


# Feature constants
class Features:
    MULTI_BOOK = "multi_book"
    MULTI_CURRENCY = "multi_currency"
    SUBSIDIARIES = "subsidiaries"
    DEPARTMENTS = "departments"
    CLASSES = "classes"
    LOCATIONS = "locations"
    BUDGETS = "budgets"
    CONSOLIDATION = "consolidation"
```

### Connection Management

```python
# backend/connections.py
from typing import Dict
from adapters.netsuite import NetSuiteAdapter
from adapters.intacct import SageIntacctAdapter
from adapters.acumatica import AcumaticaAdapter
from adapters.qbo import QuickBooksAdapter
from adapters.xero import XeroAdapter

class ConnectionManager:
    """Manages ERP connections and routes requests to correct adapter"""
    
    ADAPTERS = {
        'netsuite': NetSuiteAdapter,
        'intacct': SageIntacctAdapter,
        'acumatica': AcumaticaAdapter,
        'quickbooks': QuickBooksAdapter,
        'xero': XeroAdapter
    }
    
    def __init__(self):
        self._connections: Dict[str, ERPAdapter] = {}
    
    def get_adapter(self, connection_id: str) -> ERPAdapter:
        """Get adapter for a connection"""
        if connection_id not in self._connections:
            config = self._load_config(connection_id)
            adapter_class = self.ADAPTERS[config['erp_type']]
            self._connections[connection_id] = adapter_class(config)
        return self._connections[connection_id]
```

---

## Next Steps

### Phase 1: Foundation (2-3 weeks)
1. Refactor current NetSuite code into adapter pattern
2. Create base adapter interface
3. Add connection management
4. Update frontend to support ERP selection

### Phase 2: Sage Intacct (3-4 weeks)
1. Implement Intacct adapter
2. Handle XML Web Services
3. Map account types and dimensions
4. Test with real Intacct instance

### Phase 3: Acumatica (3-4 weeks)
1. Implement Acumatica adapter
2. Handle OData queries
3. Map branches and subaccounts
4. Test with real Acumatica instance

### Phase 4: QuickBooks/Xero (4-6 weeks)
1. Implement report parsing logic
2. Handle OAuth 2.0 flows
3. Implement aggressive caching
4. Document feature limitations

---

## Appendix: API Documentation Links

| ERP | API Documentation |
|-----|-------------------|
| NetSuite | https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/chapter_157108952762.html |
| Sage Intacct | https://developer.intacct.com/web-services/ |
| Acumatica | https://help.acumatica.com/Help?ScreenId=ShowWiki&pageid=a9f32f7a-8a99-4e95-8596-b4e2e4d86c3e |
| QuickBooks Online | https://developer.intuit.com/app/developer/qbo/docs/develop |
| Xero | https://developer.xero.com/documentation/api/accounting/overview |

---

*Document Version: 1.0*
*Last Updated: December 2025*
*Author: XAVI Development Team*

