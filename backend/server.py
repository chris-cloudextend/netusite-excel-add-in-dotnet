"""
XAVI for NetSuite - Backend Server
Flask server that provides REST API for NetSuite SuiteQL queries

Copyright (c) 2025 Celigo, Inc.
All rights reserved.

This source code is proprietary and confidential. Unauthorized copying,
modification, distribution, or use of this software, via any medium,
is strictly prohibited without the express written permission of Celigo, Inc.

For licensing inquiries, contact: legal@celigo.com
"""

from flask import Flask, jsonify, request
from flask_cors import CORS
import json
import requests
from requests_oauthlib import OAuth1
import sys
import threading
import time
from datetime import datetime
from dateutil import parser as date_parser
from dateutil.relativedelta import relativedelta
from concurrent.futures import ThreadPoolExecutor, as_completed

# Rate limiting for NetSuite API calls
NETSUITE_CONCURRENCY_LIMIT = 4  # NetSuite allows 5, keep 1 buffer
netsuite_semaphore = threading.Semaphore(NETSUITE_CONCURRENCY_LIMIT)
netsuite_request_lock = threading.Lock()
last_netsuite_request_time = 0
MIN_REQUEST_INTERVAL = 0.05  # 50ms between requests

# Import account type constants to avoid magic strings
from constants import (
    AccountType, PL_TYPES_SQL, SIGN_FLIP_TYPES_SQL, INCOME_TYPES_SQL, EXPENSE_TYPES_SQL,
    BS_ASSET_TYPES_SQL, BS_LIABILITY_TYPES_SQL, BS_EQUITY_TYPES_SQL
)

app = Flask(__name__)
CORS(app)  # Enable CORS for Excel add-in

# In-memory cache for name-to-ID lookups (refreshes on server restart)
lookup_cache = {
    'subsidiaries': {},  # name → id
    'departments': {},   # name → id
    'classes': {},       # name → id
    'locations': {},     # name → id
    'periods': {},       # period name → id (for date range performance)
    'currencies': {},    # subsidiary_id → currency_symbol (for cell formatting)
    'budget_categories': {}  # name → id (prevents 429 errors on budget batches)
}
cache_loaded = False

# In-memory cache for balance data (from full year refresh)
# Structure: { 'account:period:filters_hash': balance_value }
# Expires after 5 minutes
balance_cache = {}
balance_cache_timestamp = None
BALANCE_CACHE_TTL = 300  # 5 minutes in seconds

# In-memory cache for fiscal year lookups (to avoid repeated API calls)
# Structure: { 'period_name': {fiscal_year_id, fy_start, fy_end, period_id, period_start, period_end} }
fiscal_year_cache = {}

# In-memory cache for BS ACTIVITY data (used to compute cumulative balances)
# Structure: { 'account:period:filters_hash': activity_value }
# Backend computes cumulative by summing activity from Jan through requested period
bs_activity_cache = {}
bs_activity_cache_timestamp = None

# Track which accounts are Balance Sheet (for cumulative calculation)
# Structure: { 'account_number': True }
bs_account_set = set()

# In-memory cache for account titles (permanent, rarely changes)
# Structure: { 'account_number': 'account_name' }
account_title_cache = {}

# Default subsidiary ID (top-level parent) - loaded at startup
# This is used when no subsidiary is specified by the user
default_subsidiary_id = None

# Default accounting book ID - Primary Book
# Multi-Book Accounting allows different books (GAAP, IFRS, Tax, etc.)
# Primary book is ID 1 in NetSuite
DEFAULT_ACCOUNTING_BOOK = 1

# Load NetSuite configuration
try:
    with open('netsuite_config.json', 'r') as f:
        config = json.load(f)
except FileNotFoundError:
    print("ERROR: netsuite_config.json not found!")
    print("Please create netsuite_config.json with your NetSuite credentials.")
    sys.exit(1)

account_id = config['account_id']
suiteql_url = f"https://{account_id}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql"

# Create OAuth1 authentication
auth = OAuth1(
    client_key=config['consumer_key'],
    client_secret=config['consumer_secret'],
    resource_owner_key=config['token_id'],
    resource_owner_secret=config['token_secret'],
    realm=account_id,
    signature_method='HMAC-SHA256'
)


def query_netsuite(sql_query, timeout=30):
    """Execute a SuiteQL query against NetSuite
    
    Args:
        sql_query: The SuiteQL query to execute
        timeout: Request timeout in seconds (default 30, increase for complex BS queries)
    """
    global last_netsuite_request_time
    
    # Rate limiting: acquire semaphore and enforce minimum interval
    with netsuite_semaphore:
        with netsuite_request_lock:
            elapsed = time.time() - last_netsuite_request_time
            if elapsed < MIN_REQUEST_INTERVAL:
                time.sleep(MIN_REQUEST_INTERVAL - elapsed)
            last_netsuite_request_time = time.time()
        
        try:
            response = requests.post(
                suiteql_url,
                auth=auth,
                headers={'Content-Type': 'application/json', 'Prefer': 'transient'},
                json={'q': sql_query},
                timeout=timeout
            )
            
            if response.status_code == 200:
                return response.json().get('items', [])
            else:
                error_msg = f"NetSuite error: {response.status_code}"
                print(f"=== NetSuite Error ===", file=sys.stderr)
                print(f"Query: {sql_query[:200]}...", file=sys.stderr)
                print(f"Status: {response.status_code}", file=sys.stderr)
                print(f"Response: {response.text}", file=sys.stderr)
                print(f"=====================", file=sys.stderr)
                return {'error': error_msg, 'details': response.text}
                
        except Exception as e:
            print(f"Exception querying NetSuite: {str(e)}", file=sys.stderr)
            return {'error': str(e)}


def query_netsuite_paginated(sql_query, timeout=30, page_size=1000, order_by="1"):
    """Execute a SuiteQL query with pagination to get ALL results.
    
    SuiteQL has a default limit of 1000 rows per query. This function
    automatically paginates through all results using OFFSET/FETCH.
    
    Args:
        sql_query: The SuiteQL query to execute (should NOT include ORDER BY/OFFSET/FETCH)
        timeout: Request timeout in seconds per page
        page_size: Number of rows per page (max 1000)
        order_by: ORDER BY clause content (default "1" = first column)
    
    Returns:
        List of all result rows, or error dict
    """
    all_results = []
    offset = 0
    
    # Ensure page_size doesn't exceed NetSuite's limit
    page_size = min(page_size, 1000)
    
    while True:
        # Add ORDER BY and pagination clauses
        paginated_query = f"{sql_query} ORDER BY {order_by} OFFSET {offset} ROWS FETCH NEXT {page_size} ROWS ONLY"
        
        print(f"DEBUG - Paginated query (offset={offset})...", file=sys.stderr)
        
        result = query_netsuite(paginated_query, timeout)
        
        if isinstance(result, dict) and 'error' in result:
            print(f"ERROR - Pagination failed at offset {offset}: {result}", file=sys.stderr)
            return result
        
        if not isinstance(result, list):
            print(f"ERROR - Unexpected result type: {type(result)}", file=sys.stderr)
            return {'error': f'Unexpected result type: {type(result)}'}
        
        rows_returned = len(result)
        all_results.extend(result)
        print(f"DEBUG - Page returned {rows_returned} rows (total so far: {len(all_results)})", file=sys.stderr)
        
        # If we got fewer rows than page_size, we've reached the end
        if rows_returned < page_size:
            break
        
        offset += page_size
        
        # Safety limit to prevent infinite loops
        if offset > 100000:
            print(f"WARNING - Pagination safety limit reached at {offset} rows", file=sys.stderr)
            break
    
    print(f"DEBUG - Pagination complete: {len(all_results)} total rows", file=sys.stderr)
    return all_results


def escape_sql(text):
    """Escape single quotes in SQL strings"""
    if text is None:
        return ""
    return str(text).replace("'", "''")


def build_account_filter(accounts, column='a.acctnumber'):
    """
    Build SQL filter clause for account numbers, supporting wildcards.
    
    If an account contains '*', it's treated as a wildcard pattern:
    - '4*' becomes LIKE '4%' (all accounts starting with 4)
    - '40*' becomes LIKE '40%' (all accounts starting with 40)
    - '4010' (no asterisk) uses exact match with IN clause
    
    Args:
        accounts: List of account numbers (may include wildcards with *)
        column: SQL column name to filter (default: 'a.acctnumber')
    
    Returns:
        SQL clause string like "(a.acctnumber IN ('4010','4020') OR a.acctnumber LIKE '5%')"
    
    Example:
        build_account_filter(['4010', '4020', '5*'])
        → "(a.acctnumber IN ('4010','4020') OR a.acctnumber LIKE '5%')"
    """
    if not accounts:
        return "1=0"  # No accounts = no results
    
    exact_matches = []
    wildcard_patterns = []
    
    for acc in accounts:
        acc_str = str(acc).strip()
        if '*' in acc_str:
            # Convert * to % for SQL LIKE
            pattern = escape_sql(acc_str.replace('*', '%'))
            wildcard_patterns.append(f"{column} LIKE '{pattern}'")
        else:
            # Exact match
            exact_matches.append(f"'{escape_sql(acc_str)}'")
    
    clauses = []
    
    if exact_matches:
        clauses.append(f"{column} IN ({','.join(exact_matches)})")
    
    if wildcard_patterns:
        clauses.extend(wildcard_patterns)
    
    if len(clauses) == 1:
        return clauses[0]
    else:
        return f"({' OR '.join(clauses)})"


def is_balance_sheet_account(accttype):
    """
    Determine if an account type is a Balance Sheet account.
    
    Balance Sheet accounts are cumulative (beginning of time through period end).
    P&L accounts are for a specific period only.
    
    Args:
        accttype: Account type from NetSuite (e.g., 'Bank', 'Income', 'Expense')
        
    Returns:
        True if Balance Sheet account, False if P&L account
    """
    # Use the centralized AccountType class for consistency
    return AccountType.is_balance_sheet(accttype)


def calculate_period_end_date(period_name):
    """Calculate the end date of a period from its name (e.g., 'Jan 2025' -> '01/31/2025')
    Used as a fallback when the period doesn't exist in NetSuite's AccountingPeriod table
    """
    import calendar
    
    month_map = {
        'jan': 1, 'feb': 2, 'mar': 3, 'apr': 4, 'may': 5, 'jun': 6,
        'jul': 7, 'aug': 8, 'sep': 9, 'oct': 10, 'nov': 11, 'dec': 12
    }
    
    try:
        parts = period_name.strip().split()
        if len(parts) != 2:
            return None
        
        month_str = parts[0].lower()[:3]
        year = int(parts[1])
        month = month_map.get(month_str)
        
        if not month:
            return None
        
        # Get last day of the month
        last_day = calendar.monthrange(year, month)[1]
        
        # Return in MM/DD/YYYY format (same as NetSuite returns)
        return f"{month:02d}/{last_day:02d}/{year}"
    except Exception as e:
        print(f"Error calculating period end date for '{period_name}': {e}", file=sys.stderr)
        return None


def is_year_only(period_str):
    """Check if the period string is just a 4-digit year (e.g., '2025')"""
    if period_str and len(period_str) == 4 and period_str.isdigit():
        year = int(period_str)
        return 1900 <= year <= 2100
    return False


def expand_year_to_periods(year_str):
    """Expand a year-only string to (from_period, to_period) tuple
    e.g., '2025' -> ('Jan 2025', 'Dec 2025')
    """
    return (f"Jan {year_str}", f"Dec {year_str}")


def get_period_dates_from_name(period_name):
    """Convert period name (e.g., 'Mar 2025') to start/end dates for proper date range queries
    Returns tuple: (startdate, enddate, id) or (None, None, None) if not found
    Uses cache for performance (avoids repeated NetSuite queries)
    
    Also handles year-only format (e.g., '2025') by returning Jan 1 - Dec 31 of that year
    """
    
    # Handle year-only format (e.g., "2025")
    if is_year_only(period_name):
        year = period_name
        # Return Jan 1 to Dec 31 of the year
        start_date = f"1/1/{year}"
        end_date = f"12/31/{year}"
        print(f"DEBUG: Year-only period '{period_name}' -> {start_date} to {end_date}", file=sys.stderr)
        return (start_date, end_date, None)
    
    # Check cache first
    cache_key = f"{period_name}_dates"
    if cache_key in lookup_cache['periods']:
        return lookup_cache['periods'][cache_key]
    
    try:
        query = f"""
            SELECT startdate, enddate, id
            FROM AccountingPeriod
            WHERE periodname = '{escape_sql(period_name)}'
            AND isquarter = 'F'
            AND isyear = 'F'
            AND ROWNUM = 1
        """
        result = query_netsuite(query)
        if isinstance(result, list) and len(result) > 0:
            dates = (result[0].get('startdate'), result[0].get('enddate'), result[0].get('id'))
            # Cache it
            lookup_cache['periods'][cache_key] = dates
            print(f"DEBUG: Found period '{period_name}' -> {dates}", file=sys.stderr)
            return dates
        print(f"DEBUG: Period '{period_name}' NOT found in NetSuite AccountingPeriod table", file=sys.stderr)
        return (None, None, None)
    except Exception as e:
        print(f"Error getting period dates for '{period_name}': {e}", file=sys.stderr)
        return (None, None, None)


def get_months_between_periods(from_period, to_period):
    """Calculate the number of months between two periods
    Returns number of months, or 0 if calculation fails"""
    try:
        from_dates = get_period_dates_from_name(from_period)
        to_dates = get_period_dates_from_name(to_period)
        from_start = from_dates[0] if from_dates else None
        to_end = to_dates[1] if to_dates else None
        
        if not from_start or not to_end:
            return 0
        
        # Parse dates (NetSuite returns dates like "1/1/2025")
        start = date_parser.parse(from_start)
        end = date_parser.parse(to_end)
        
        # Calculate months difference
        months = (end.year - start.year) * 12 + (end.month - start.month) + 1
        return months
    except Exception as e:
        print(f"Error calculating months between periods: {e}", file=sys.stderr)
        return 0


def generate_quarterly_chunks(from_period, to_period):
    """Break a large date range into quarterly chunks
    Returns list of (from_period, to_period) tuples"""
    
    # Map month names to numbers
    month_map = {
        'jan': 1, 'feb': 2, 'mar': 3, 'apr': 4, 'may': 5, 'jun': 6,
        'jul': 7, 'aug': 8, 'sep': 9, 'oct': 10, 'nov': 11, 'dec': 12
    }
    
    try:
        # Parse "Jan 2025" format
        from_parts = from_period.split()
        to_parts = to_period.split()
        
        if len(from_parts) != 2 or len(to_parts) != 2:
            return [(from_period, to_period)]  # Return original if parsing fails
        
        from_month = month_map.get(from_parts[0].lower()[:3])
        from_year = int(from_parts[1])
        to_month = month_map.get(to_parts[0].lower()[:3])
        to_year = int(to_parts[1])
        
        if not from_month or not to_month:
            return [(from_period, to_period)]
        
        # Generate quarters (3-month chunks)
        chunks = []
        current_month = from_month
        current_year = from_year
        
        while (current_year < to_year) or (current_year == to_year and current_month <= to_month):
            # Calculate chunk end (current + 2 months, or to_month if sooner)
            chunk_end_month = min(current_month + 2, 12)
            chunk_end_year = current_year
            
            # Don't exceed the target end date
            if chunk_end_year > to_year or (chunk_end_year == to_year and chunk_end_month > to_month):
                chunk_end_month = to_month
                chunk_end_year = to_year
            
            # Convert back to period names
            month_names = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                          'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
            chunk_from = f"{month_names[current_month]} {current_year}"
            chunk_to = f"{month_names[chunk_end_month]} {chunk_end_year}"
            
            chunks.append((chunk_from, chunk_to))
            
            # Move to next quarter
            current_month = chunk_end_month + 1
            if current_month > 12:
                current_month = 1
                current_year += 1
            
            # Safety: prevent infinite loops
            if len(chunks) > 20:
                break
        
        return chunks if chunks else [(from_period, to_period)]
        
    except Exception as e:
        print(f"Error generating chunks: {e}", file=sys.stderr)
        return [(from_period, to_period)]  # Return original on error


def load_lookup_cache():
    """Load all name-to-ID mappings into memory cache"""
    global cache_loaded
    
    if cache_loaded:
        return
    
    print("Loading name-to-ID lookup cache...")
    
    # Load Departments directly from Department table
    try:
        dept_query = """
            SELECT id, name, fullName, isinactive 
            FROM Department 
            ORDER BY fullName
        """
        dept_result = query_netsuite(dept_query)
        if isinstance(dept_result, list):
            for row in dept_result:
                dept_id = str(row['id'])
                # Use fullName for display, name for lookup key
                dept_fullname = row.get('fullname') or row['name']
                lookup_cache['departments'][dept_fullname.lower()] = dept_id
                # Also add just the short name for easier lookup
                if row['name'].lower() != dept_fullname.lower():
                    lookup_cache['departments'][row['name'].lower()] = dept_id
            print(f"✓ Loaded {len(dept_result)} departments")
    except Exception as e:
        print(f"✗ Department lookup error: {e}")
    
    # Load Classes directly from Classification table
    try:
        class_query = """
            SELECT id, name, fullName, isinactive 
            FROM Classification 
            ORDER BY fullName
        """
        class_result = query_netsuite(class_query)
        if isinstance(class_result, list):
            for row in class_result:
                class_id = str(row['id'])
                # Use fullName for display, name for lookup key
                class_fullname = row.get('fullname') or row['name']
                lookup_cache['classes'][class_fullname.lower()] = class_id
                # Also add just the short name for easier lookup
                if row['name'].lower() != class_fullname.lower():
                    lookup_cache['classes'][row['name'].lower()] = class_id
            print(f"✓ Loaded {len(class_result)} classes")
    except Exception as e:
        print(f"✗ Class lookup error: {e}")
    
    # Load Locations directly from Location table
    try:
        loc_query = """
            SELECT id, name, fullName, isinactive 
            FROM Location 
            ORDER BY fullName
        """
        loc_result = query_netsuite(loc_query)
        if isinstance(loc_result, list):
            for row in loc_result:
                loc_id = str(row['id'])
                # Use fullName for display, name for lookup key
                loc_fullname = row.get('fullname') or row['name']
                lookup_cache['locations'][loc_fullname.lower()] = loc_id
                # Also add just the short name for easier lookup
                if row['name'].lower() != loc_fullname.lower():
                    lookup_cache['locations'][row['name'].lower()] = loc_id
            print(f"✓ Loaded {len(loc_result)} locations")
    except Exception as e:
        print(f"✗ Location lookup error: {e}")
    
    # Subsidiaries - now we have access to the Subsidiary table!
    # Also load currency for each subsidiary for formatting
    try:
        sub_query = """
            SELECT 
                s.id,
                s.name,
                s.fullName AS hierarchy,
                s.currency,
                c.symbol AS currency_symbol
            FROM 
                Subsidiary s
                LEFT JOIN Currency c ON c.id = s.currency
            ORDER BY 
                s.fullName
        """
        sub_result = query_netsuite(sub_query)
        if isinstance(sub_result, list):
            for row in sub_result:
                sub_id = str(row['id'])
                short_name = row['name'].lower()
                hierarchy_name = row.get('hierarchy', row['name']).lower()
                currency_symbol = row.get('currency_symbol', '$')  # Default to $ if not found
                
                # Add BOTH the short name AND the full hierarchy path
                # This allows users to enter either:
                #   "Celigo Australia Pty Ltd" (short)
                #   "Celigo Inc. : Celigo Australia Pty Ltd" (hierarchy)
                lookup_cache['subsidiaries'][short_name] = sub_id
                if hierarchy_name != short_name:
                    lookup_cache['subsidiaries'][hierarchy_name] = sub_id
                
                # Also add version without trailing punctuation (. or ,)
                # This handles "Celigo Inc" vs "Celigo Inc."
                short_name_clean = short_name.rstrip('.,')
                if short_name_clean != short_name:
                    lookup_cache['subsidiaries'][short_name_clean] = sub_id
                
                # Store currency symbol for each subsidiary (by ID)
                lookup_cache['currencies'][sub_id] = currency_symbol or '$'
                
            print(f"✓ Loaded {len(lookup_cache['subsidiaries'])} subsidiaries with currencies")
    except Exception as e:
        print(f"✗ Subsidiary lookup error: {e}")
        # Fallback to known values
        lookup_cache['subsidiaries'] = {'parent company': '1'}
    
    # Load Budget Categories - critical for batch budget endpoint performance
    # Without this, every batch budget call queries NetSuite for category ID → 429 errors
    try:
        cat_query = """
            SELECT id, name
            FROM BudgetCategory
            WHERE isinactive = 'F'
            ORDER BY name
        """
        cat_result = query_netsuite(cat_query)
        if isinstance(cat_result, list):
            for row in cat_result:
                cat_id = str(row['id'])
                cat_name = row['name'].lower()
                lookup_cache['budget_categories'][cat_name] = cat_id
            print(f"✓ Loaded {len(cat_result)} budget categories")
    except Exception as e:
        print(f"✗ Budget category lookup error: {e}")
    
    # Find top-level parent subsidiary (where parent IS NULL)
    # This is used as default when no subsidiary is specified
    load_default_subsidiary()
    
    cache_loaded = True
    print("✓ Lookup cache loaded!")


def load_default_subsidiary():
    """
    Find the top-level parent subsidiary (where parent IS NULL)
    This subsidiary will be used as the default when no subsidiary is specified.
    For consolidated reporting, this gives the full company view.
    
    Important considerations:
    - Must exclude elimination subsidiaries (iselimination = 'F')
    - Must be active (isinactive = 'F')
    - For non-OneWorld accounts, subsidiary may be hidden but still exists
    - Root subsidiary has parent IS NULL
    """
    global default_subsidiary_id
    
    try:
        # Primary query: Find the root parent subsidiary
        # - parent IS NULL = top-level in hierarchy
        # - isinactive = 'F' = active
        # - iselimination = 'F' OR NULL = not an elimination subsidiary
        # FETCH FIRST is the proper way to limit in SuiteQL (not ROWNUM before ORDER BY)
        parent_query = """
            SELECT id, name
            FROM Subsidiary
            WHERE isinactive = 'F'
              AND (iselimination = 'F' OR iselimination IS NULL)
              AND parent IS NULL
            ORDER BY id
            FETCH FIRST 1 ROWS ONLY
        """
        result = query_netsuite(parent_query)
        
        if isinstance(result, list) and len(result) > 0:
            default_subsidiary_id = str(result[0]['id'])
            parent_name = result[0]['name']
            print(f"✓ Default subsidiary: {parent_name} (ID: {default_subsidiary_id})")
            return
        
        # Fallback: If no root parent found, get any active non-elimination subsidiary
        # This handles edge cases like non-OneWorld accounts or unusual configurations
        print(f"⚠ No root parent subsidiary found, trying fallback query...")
        fallback_query = """
            SELECT id, name
            FROM Subsidiary
            WHERE isinactive = 'F'
              AND (iselimination = 'F' OR iselimination IS NULL)
            ORDER BY id
            FETCH FIRST 1 ROWS ONLY
        """
        fallback = query_netsuite(fallback_query)
        
        if isinstance(fallback, list) and len(fallback) > 0:
            default_subsidiary_id = str(fallback[0]['id'])
            fallback_name = fallback[0]['name']
            print(f"✓ Default subsidiary (fallback): {fallback_name} (ID: {default_subsidiary_id})")
        else:
            # Last resort: use '1' if all queries fail
            default_subsidiary_id = '1'
            print(f"⚠ Could not determine subsidiary, defaulting to ID=1")
            
    except Exception as e:
        # Fallback: use '1' if query fails
        default_subsidiary_id = '1'
        print(f"⚠ Error finding parent subsidiary: {e}, defaulting to ID=1")


# Cache for subsidiary hierarchy (populated on first use)
subsidiary_hierarchy_cache = {}


def is_root_subsidiary(sub_id):
    """
    Check if a subsidiary is the root (top-level) subsidiary.
    Root subsidiaries have parent = NULL.
    
    Args:
        sub_id: Subsidiary ID (string or int)
        
    Returns:
        True if root subsidiary, False otherwise
    """
    sub_id = str(sub_id)
    
    try:
        query = f"""
            SELECT parent FROM Subsidiary WHERE id = {sub_id}
        """
        result = query_netsuite(query)
        
        if isinstance(result, list) and len(result) > 0:
            parent = result[0].get('parent')
            return parent is None
        return False
    except Exception as e:
        print(f"   ⚠️ Error checking if subsidiary is root: {e}")
        return False


# ================================================================================
# CONSOLIDATION DETECTION
# ================================================================================
# When enabled, if user queries the root subsidiary (parent IS NULL), 
# automatically treat as consolidated even without "(Consolidated)" suffix.
# 
# DISABLED: Root subsidiary can have its OWN direct transactions (like 
# intracompany accounts 59998, 59999) that differ from consolidated totals.
# Users need explicit control via "(Consolidated)" suffix.
# Example: "Celigo Inc." = just that sub's transactions
#          "Celigo Inc. (Consolidated)" = all children included
AUTO_CONSOLIDATE_ROOT = False

def should_use_consolidated(raw_subsidiary, subsidiary_id):
    """
    Determine if a query should use consolidated (hierarchy) logic.
    
    Returns True if:
    1. User explicitly included "(Consolidated)" in subsidiary name, OR
    2. AUTO_CONSOLIDATE_ROOT is True AND subsidiary is root (parent IS NULL)
    
    Args:
        raw_subsidiary: Original subsidiary string from user (before ID conversion)
        subsidiary_id: Converted subsidiary ID (string)
        
    Returns:
        bool: True if should use consolidated/hierarchy logic
    """
    # Check for explicit "(Consolidated)" suffix
    if raw_subsidiary and '(consolidated)' in raw_subsidiary.lower():
        return True
    
    # Check for auto-consolidation of root subsidiary
    if AUTO_CONSOLIDATE_ROOT and subsidiary_id:
        if is_root_subsidiary(subsidiary_id):
            print(f"   🔄 AUTO-CONSOLIDATION: Subsidiary {subsidiary_id} is root (parent=NULL), treating as consolidated", file=sys.stderr)
            return True
    
    return False


def get_subsidiaries_in_hierarchy(target_sub_id):
    """
    Get all subsidiary IDs that roll up to the target subsidiary (including the target itself).
    
    For consolidated reporting, we need to include transactions from:
    - The target subsidiary itself
    - All child subsidiaries (direct and indirect)
    - Elimination subsidiaries in the hierarchy (for intercompany eliminations)
    
    Args:
        target_sub_id: The target/parent subsidiary ID (string or int)
        
    Returns:
        List of subsidiary IDs (as strings) that should be included in consolidation
    """
    global subsidiary_hierarchy_cache
    
    target_id = str(target_sub_id)
    
    # Check cache first
    if target_id in subsidiary_hierarchy_cache:
        return subsidiary_hierarchy_cache[target_id]
    
    try:
        # Query all active subsidiaries with their parent relationships
        hierarchy_query = """
            SELECT id, parent, iselimination
            FROM Subsidiary
            WHERE isinactive = 'F'
        """
        result = query_netsuite(hierarchy_query)
        
        if not isinstance(result, list):
            print(f"   ⚠️ Could not load subsidiary hierarchy, using target only")
            return [target_id]
        
        # Build parent->children map
        children_map = {}  # parent_id -> [child_ids]
        all_subs = {}  # id -> {parent, iselimination}
        
        for row in result:
            sub_id = str(row.get('id', ''))
            parent_id = str(row.get('parent', '')) if row.get('parent') else None
            is_elim = row.get('iselimination', 'F') == 'T'
            
            all_subs[sub_id] = {'parent': parent_id, 'iselimination': is_elim}
            
            if parent_id:
                if parent_id not in children_map:
                    children_map[parent_id] = []
                children_map[parent_id].append(sub_id)
        
        # If target is the root (parent IS NULL), include ALL non-elimination subsidiaries
        # plus elimination subsidiaries (needed for intercompany eliminations)
        if target_id in all_subs and all_subs[target_id]['parent'] is None:
            # Root subsidiary - include all subsidiaries
            hierarchy_ids = list(all_subs.keys())
            print(f"   📊 Root subsidiary {target_id}: including ALL {len(hierarchy_ids)} subsidiaries")
        else:
            # Non-root: recursively find all children
            hierarchy_ids = [target_id]
            to_process = [target_id]
            
            while to_process:
                current = to_process.pop(0)
                if current in children_map:
                    for child_id in children_map[current]:
                        if child_id not in hierarchy_ids:
                            hierarchy_ids.append(child_id)
                            to_process.append(child_id)
            
            print(f"   📊 Subsidiary {target_id} hierarchy: {len(hierarchy_ids)} subsidiaries")
        
        # Cache the result
        subsidiary_hierarchy_cache[target_id] = hierarchy_ids
        return hierarchy_ids
        
    except Exception as e:
        print(f"   ⚠️ Error getting subsidiary hierarchy: {e}")
        return [target_id]  # Fallback to just the target


def convert_name_to_id(dimension_type, value):
    """
    Convert a dimension name to its ID
    Args:
        dimension_type: 'subsidiary', 'department', 'class', 'location'
        value: Name (string) or ID (string/number)
    Returns:
        ID as string, or EMPTY STRING if name not found (to prevent SQL errors)
    """
    if not value or value == '':
        return ''
    
    # Load cache if not loaded
    if not cache_loaded:
        load_lookup_cache()
    
    # If it's already a number (ID), return it
    if str(value).isdigit():
        return str(value)
    
    # Look up name in cache (case-insensitive)
    value_lower = str(value).lower().strip()
    
    # For subsidiaries, handle "(Consolidated)" suffix
    # The "(Consolidated)" version uses the SAME subsidiary ID - it just affects
    # how BUILTIN.CONSOLIDATE handles child transactions
    if dimension_type == 'subsidiary' and value_lower.endswith(' (consolidated)'):
        value_lower = value_lower.replace(' (consolidated)', '')
        print(f"   Stripped '(Consolidated)' suffix → looking up '{value_lower}'")
    
    # Map dimension type to cache key (handle 'class' → 'classes')
    cache_key_map = {
        'subsidiary': 'subsidiaries',
        'department': 'departments',
        'class': 'classes',  # NOT 'classs'!
        'location': 'locations'
    }
    cache_key = cache_key_map.get(dimension_type, dimension_type + 's')
    
    if cache_key in lookup_cache:
        if value_lower in lookup_cache[cache_key]:
            found_id = lookup_cache[cache_key][value_lower]
            print(f"✓ Converted {dimension_type} '{value}' → ID {found_id}")
            return found_id
    
    # Not found - return EMPTY to prevent SQL errors
    # (better to ignore the filter than break the query)
    print(f"⚠ {dimension_type} '{value}' not found in cache, ignoring filter")
    return ''


@app.route('/')
def home():
    """Health check endpoint"""
    return jsonify({
        'status': 'running',
        'service': 'NetSuite Excel Formulas API',
        'account': account_id,
        'version': '1.0',
        'endpoints': {
            '/account/{account_number}/name': 'Get account name (NSGLATITLE)',
            '/balance': 'Get GL balance (NSGLABAL)',
            '/budget': 'Get budget amount (NSGLABUD)',
            '/health': 'Health check'
        }
    })


@app.route('/health')
def health():
    """Health check"""
    return jsonify({'status': 'healthy', 'account': account_id})


@app.route('/debug/budget-schema')
def debug_budget_schema():
    """
    Debug endpoint to explore Budget table structure.
    Returns sample budget data with all available columns.
    """
    try:
        # Query to get budget table structure with sample data
        query = """
            SELECT TOP 10 
                b.*
            FROM Budget b
        """
        result = query_netsuite(query)
        
        if isinstance(result, dict) and 'error' in result:
            return jsonify({
                'error': result.get('error'),
                'message': 'Budget table query failed - feature may not be enabled'
            }), 400
        
        # Get column names from first result
        columns = list(result[0].keys()) if result and len(result) > 0 else []
        
        return jsonify({
            'columns': columns,
            'sample_data': result[:5] if result else [],
            'total_rows': len(result) if result else 0
        })
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/debug/budget-categories')
def debug_budget_categories():
    """
    Debug endpoint to list available budget categories.
    """
    try:
        # Try to find budget category table/field
        query = """
            SELECT DISTINCT 
                b.category,
                bc.name as category_name
            FROM Budget b
            LEFT JOIN BudgetCategory bc ON b.category = bc.id
            WHERE ROWNUM <= 100
        """
        result = query_netsuite(query)
        
        if isinstance(result, dict) and 'error' in result:
            # Try simpler query without join
            query2 = "SELECT DISTINCT category FROM Budget WHERE ROWNUM <= 50"
            result = query_netsuite(query2)
        
        return jsonify({
            'categories': result if result else [],
            'count': len(result) if result else 0
        })
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/run-query', methods=['POST'])
def run_query():
    """Run an arbitrary SuiteQL query for testing"""
    data = request.get_json() or {}
    query = data.get('query', '')
    if not query:
        return jsonify({'error': 'query required'}), 400
    
    result = query_netsuite(query)
    return jsonify({'query': query, 'result': result})


@app.route('/check-permissions')
def check_permissions():
    """
    Check NetSuite account features and permissions for XAVI.
    Uses CompanyFeatureSetup for accurate feature detection.
    Returns detailed info about enabled features and subsidiaries.
    """
    results = {
        'suiteql_access': False,
        'account_id': account_id,
        'features': {},
        'subsidiaries': [],
        'checks': [],
        'summary': {
            'passed': 0,
            'failed': 0,
            'required_passed': 0,
            'required_failed': 0
        }
    }
    
    # =================================================================
    # 1. OneWorld Detection - Check for elimination subsidiaries
    # =================================================================
    oneworld_result = {
        'name': 'OneWorld (Multi-Subsidiary)',
        'table': 'Subsidiary',
        'required': False,
        'accessible': False,
        'enabled': False,
        'details': None
    }
    
    try:
        # Best OneWorld test: elimination subsidiaries only exist in OneWorld
        elim_query = "SELECT id, name, iselimination FROM Subsidiary WHERE iselimination = 'T'"
        elim_response = query_netsuite(elim_query)
        
        if isinstance(elim_response, list):
            results['suiteql_access'] = True
            oneworld_result['accessible'] = True
            
            if len(elim_response) > 0:
                # Has elimination subsidiaries = definitely OneWorld
                oneworld_result['enabled'] = True
                oneworld_result['details'] = f"Enabled ({len(elim_response)} elimination subsidiary)"
            else:
                # No elimination subs - try to count all subsidiaries
                count_query = "SELECT COUNT(*) as cnt FROM Subsidiary WHERE isinactive = 'F'"
                count_response = query_netsuite(count_query)
                if isinstance(count_response, list) and len(count_response) > 0:
                    sub_count = int(count_response[0].get('cnt', 0))
                    if sub_count > 1:
                        oneworld_result['enabled'] = True
                        oneworld_result['details'] = f"Enabled ({sub_count} subsidiaries)"
                    else:
                        oneworld_result['details'] = "Single subsidiary"
            
            results['summary']['passed'] += 1
        else:
            oneworld_result['error'] = 'Subsidiary table not accessible'
    except Exception as e:
        oneworld_result['error'] = str(e)
    
    results['checks'].append(oneworld_result)
    results['features']['oneworld'] = oneworld_result.get('enabled', False)
    
    # =================================================================
    # 2. Get All Subsidiaries (for display)
    # =================================================================
    try:
        sub_query = """
            SELECT id, name, iselimination 
            FROM Subsidiary 
            WHERE isinactive = 'F' 
            ORDER BY name
        """
        sub_response = query_netsuite(sub_query)
        if isinstance(sub_response, list):
            results['subsidiaries'] = [
                {'id': str(row['id']), 'name': row['name'], 'isElimination': row.get('iselimination') == 'T'}
                for row in sub_response
            ]
    except:
        pass  # Already handled in OneWorld check
    
    # =================================================================
    # 3. Multi-Book Accounting - Try to query accountingbook table directly
    # Note: accountingbook and CompanyFeatureSetup tables are often not accessible
    # via REST API (Token-Based Auth) even though they work in SuiteQL Workbook
    # =================================================================
    multibook_result = {
        'name': 'Multi-Book Accounting',
        'table': 'accountingbook',
        'required': False,
        'accessible': False,
        'enabled': False,
        'details': None,
        'query_result': None,
        'query_used': None
    }
    
    try:
        # Try to query accounting books directly
        mb_query = "SELECT id, name, isprimary FROM AccountingBook WHERE isinactive = 'F' ORDER BY isprimary DESC"
        multibook_result['query_used'] = mb_query
        mb_response = query_netsuite(mb_query)
        
        if isinstance(mb_response, list) and len(mb_response) > 0:
            results['suiteql_access'] = True
            multibook_result['accessible'] = True
            multibook_result['query_result'] = mb_response
            # Multi-Book is enabled if there's more than 1 book, or any non-primary book
            multibook_result['enabled'] = len(mb_response) > 1 or any(
                row.get('isprimary', 'T') == 'F' for row in mb_response
            )
            multibook_result['details'] = f"{len(mb_response)} accounting book(s) found"
            results['summary']['passed'] += 1
        else:
            # Table not accessible via API - this is common for TBA integrations
            multibook_result['accessible'] = False
            multibook_result['details'] = 'Using Primary Book as default'
            if isinstance(mb_response, dict):
                multibook_result['query_result'] = mb_response.get('error', 'Query failed')
            else:
                multibook_result['query_result'] = 'No data returned'
    except Exception as e:
        multibook_result['error'] = str(e)
    
    results['checks'].append(multibook_result)
    results['features']['multibook'] = multibook_result.get('enabled', False)
    
    # =================================================================
    # 4. Budgets - Check Budgets table directly
    # =================================================================
    budget_result = {
        'name': 'Budgets',
        'table': 'Budgets',
        'required': False,
        'accessible': False,
        'enabled': False,
        'details': None,
        'query_result': None
    }
    
    try:
        # Query Budgets table to check if budgets exist
        budget_query = "SELECT COUNT(*) as cnt FROM Budgets"
        budget_response = query_netsuite(budget_query)
        
        if isinstance(budget_response, list) and len(budget_response) > 0:
            results['suiteql_access'] = True
            budget_result['accessible'] = True
            budget_count = int(budget_response[0].get('cnt', 0))
            budget_result['enabled'] = budget_count > 0
            budget_result['query_result'] = {'count': budget_count}
            results['summary']['passed'] += 1
        else:
            budget_result['query_result'] = budget_response
    except Exception as e:
        budget_result['error'] = str(e)
    
    results['checks'].append(budget_result)
    results['features']['budgets'] = budget_result.get('enabled', False)
    
    # =================================================================
    # 5. Required Core Tables
    # =================================================================
    core_checks = [
        ('Account', 'Chart of Accounts', True, 
         "SELECT TOP 1 id, acctnumber FROM Account WHERE isinactive = 'F'"),
        
        ('TransactionAccountingLine', 'GL Transaction Lines', True,
         "SELECT tal.account FROM TransactionAccountingLine tal WHERE ROWNUM <= 1"),
        
        ('AccountingPeriod', 'Accounting Periods', True,
         "SELECT TOP 1 id, periodname FROM AccountingPeriod"),
        
        ('Department', 'Departments', False,
         "SELECT TOP 1 id, name FROM Department WHERE isinactive = 'F'"),
        
        ('Classification', 'Classes', False,
         "SELECT TOP 1 id, name FROM Classification WHERE isinactive = 'F'"),
        
        ('Location', 'Locations', False,
         "SELECT TOP 1 id, name FROM Location WHERE isinactive = 'F'"),
    ]
    
    for table_name, display_name, required, test_query in core_checks:
        check_result = {
            'table': table_name,
            'name': display_name,
            'required': required,
            'accessible': False,
            'error': None
        }
        
        try:
            response = query_netsuite(test_query)
            
            if isinstance(response, list):
                check_result['accessible'] = True
                check_result['row_count'] = len(response)
                results['suiteql_access'] = True
                results['summary']['passed'] += 1
                if required:
                    results['summary']['required_passed'] += 1
            elif isinstance(response, dict) and 'error' in response:
                error_detail = response.get('details', response.get('error', 'Unknown error'))
                if 'invalid' in str(error_detail).lower() or 'not found' in str(error_detail).lower():
                    check_result['error'] = 'Feature not enabled'
                    check_result['accessible'] = None  # N/A
                else:
                    check_result['error'] = str(error_detail)[:100]
                    results['summary']['failed'] += 1
                    if required:
                        results['summary']['required_failed'] += 1
                        
        except Exception as e:
            check_result['error'] = str(e)
            results['summary']['failed'] += 1
            if required:
                results['summary']['required_failed'] += 1
        
        results['checks'].append(check_result)
    
    # =================================================================
    # Generate Overall Status
    # =================================================================
    if not results['suiteql_access']:
        results['status'] = 'error'
        results['message'] = 'SuiteQL access denied. Check role permissions.'
    elif results['summary']['required_failed'] > 0:
        results['status'] = 'warning'
        results['message'] = f"{results['summary']['required_failed']} required permission(s) missing."
    else:
        results['status'] = 'success'
        results['message'] = f"All required permissions verified."
    
    return jsonify(results)


@app.route('/admin/restart', methods=['POST'])
def admin_restart():
    """
    Restart the server (called from add-in settings)
    Uses os.execv to replace the current process with a fresh one
    """
    print("=" * 60, file=sys.stderr)
    print("🔄 SERVER RESTART REQUESTED FROM ADD-IN", file=sys.stderr)
    print("=" * 60, file=sys.stderr)
    
    def do_restart():
        import time
        time.sleep(1)  # Give time for response to be sent
        os.execv(sys.executable, ['python3', '-u'] + sys.argv)
    
    import threading
    threading.Thread(target=do_restart).start()
    
    return jsonify({
        'status': 'restarting',
        'message': 'Server will restart in 1 second. Refresh the taskpane in a few seconds.'
    })


@app.route('/accounts/search', methods=['GET'])
def search_accounts():
    """
    Search for accounts by account number OR account type
    
    Query params:
        - pattern: Search pattern
          Examples:
            - "4*"        → Accounts starting with "4"
            - "*"         → All accounts
            - "*income"   → All accounts with type containing "income" (Income, Other Income)
            - "income*"   → All accounts with type starting with "income"
            - "expense"   → All accounts with type containing "expense"
            - "bank"      → All accounts with type containing "bank"
        - active_only: Filter to active accounts only (default: true)
    
    Returns: List of matching accounts with number, name, ID, and type
    """
    try:
        pattern = request.args.get('pattern', '')
        active_only = request.args.get('active_only', 'true').lower() == 'true'
        
        if not pattern:
            return jsonify({'error': 'Pattern parameter is required'}), 400
        
        # Determine if this is a TYPE search or ACCOUNT NUMBER search
        # Type search: contains letters (other than wildcards)
        # Account number search: only numbers and wildcards
        pattern_without_wildcards = pattern.replace('*', '').strip()
        is_type_search = bool(pattern_without_wildcards) and any(c.isalpha() for c in pattern_without_wildcards)
        
        # Build WHERE clause
        where_conditions = []
        
        if is_type_search:
            # ACCOUNT TYPE search
            # Convert pattern to SQL LIKE pattern
            sql_pattern = pattern.replace('*', '%').upper()
            sql_pattern = escape_sql(sql_pattern)
            
            # NetSuite account type mapping for better matching
            # Map common user inputs to actual NetSuite type values
            type_mappings = {
                'INCOME': ['Income', 'OthIncome'],
                'EXPENSE': ['Expense', 'OthExpense'],
                'COGS': ['COGS', 'Cost of Goods Sold'],
                'ASSET': ['Bank', 'AcctRec', 'OthCurrAsset', 'FixedAsset', 'OthAsset', 'DeferExpense', 'Unbilled'],
                'LIABILITY': ['AcctPay', 'CreditCard', 'OthCurrLiab', 'LongTermLiab', 'DeferRevenue'],
                'EQUITY': ['Equity']
            }
            
            # Check if pattern matches a category
            pattern_upper = pattern_without_wildcards.upper()
            matched_types = []
            
            for category, types in type_mappings.items():
                if category.startswith(pattern_upper) or pattern_upper in category:
                    matched_types.extend(types)
            
            if matched_types:
                # Use exact match for mapped types
                type_list = "','".join(matched_types)
                where_conditions.append(f"accttype IN ('{type_list}')")
            else:
                # Use LIKE for direct type matching
                where_conditions.append(f"UPPER(accttype) LIKE '{sql_pattern}'")
            
            print(f"DEBUG - Type search: pattern='{pattern}', sql_pattern='{sql_pattern}', mapped_types={matched_types}", file=sys.stderr)
            
        else:
            # ACCOUNT NUMBER search
            # Convert Excel wildcard (*) to SQL wildcard (%)
            sql_pattern = pattern.replace('*', '%')
            sql_pattern = escape_sql(sql_pattern)
            where_conditions.append(f"acctnumber LIKE '{sql_pattern}'")
            
            print(f"DEBUG - Account number search: pattern='{pattern}', sql_pattern='{sql_pattern}'", file=sys.stderr)
        
        # Filter by active status
        if active_only:
            where_conditions.append("isinactive = 'F'")
        
        where_clause = " AND ".join(where_conditions)
        
        # Build SuiteQL query
        # Use accountsearchdisplaynamecopy for clean name (without number prefix)
        # sspecacct = Special Account Type (e.g., Retained Earnings, Unbilled Receivable)
        query = f"""
            SELECT 
                id,
                acctnumber,
                accountsearchdisplaynamecopy AS accountname,
                accttype,
                sspecacct
            FROM 
                Account
            WHERE 
                {where_clause}
            ORDER BY 
                acctnumber
        """
        
        print(f"DEBUG - Account search query: {query}", file=sys.stderr)
        
        result = query_netsuite(query)
        
        if isinstance(result, dict) and 'error' in result:
            return jsonify(result), 500
        
        # Format response
        accounts = []
        for row in result:
            accounts.append({
                'id': row.get('id'),
                'accountnumber': row.get('acctnumber'),
                'accountname': row.get('accountname'),
                'accttype': row.get('accttype'),
                'sspecacct': row.get('sspecacct') or ''  # Special Account Type
            })
        
        return jsonify({
            'pattern': pattern,
            'search_type': 'account_type' if is_type_search else 'account_number',
            'count': len(accounts),
            'accounts': accounts
        })
        
    except Exception as e:
        print(f"Error in search_accounts: {str(e)}", file=sys.stderr)
        return jsonify({'error': str(e)}), 500


@app.route('/accounts/with-activity', methods=['GET'])
def get_accounts_with_activity():
    """
    Get accounts that have actual transaction activity for a given period.
    Only returns accounts with parent (not top-level) to ensure detail accounts.
    
    Query params:
        - period: Period name (e.g., "Jan 2025")
        - limit: Max accounts to return (default: 10)
        - types: Account types to include, comma-separated (default: Income,Expense,COGS)
    
    Returns: List of accounts with their balances for the period
    """
    try:
        period = request.args.get('period', 'Jan 2025')
        limit = int(request.args.get('limit', '10'))
        types_param = request.args.get('types', 'Income,Expense,COGS')
        
        # Parse the period to get date range
        start_date_str, end_date_str, period_id = get_period_dates_from_name(period)
        if not end_date_str:
            return jsonify({'error': f'Invalid period: {period}'}), 400
        
        from datetime import datetime
        try:
            start_date = datetime.strptime(start_date_str, '%m/%d/%Y')
            end_date = datetime.strptime(end_date_str, '%m/%d/%Y')
            start_sql = start_date.strftime('%Y-%m-%d')
            end_sql = end_date.strftime('%Y-%m-%d')
        except ValueError:
            start_sql = start_date_str
            end_sql = end_date_str
        
        # Build type filter
        types_list = [t.strip() for t in types_param.split(',')]
        types_sql = ','.join([f"'{t}'" for t in types_list])
        
        # Query for accounts with activity in the period
        # Only include accounts that have a parent (not top-level)
        # Order by absolute amount to get accounts with most activity
        query = f"""
            SELECT 
                a.id,
                a.acctnumber,
                a.accountsearchdisplaynamecopy AS accountname,
                a.accttype,
                a.parent,
                SUM(ABS(tal.amount)) AS activity_amount,
                SUM(tal.amount) AS balance
            FROM 
                Transaction t
                JOIN TransactionAccountingLine tal ON t.id = tal.transaction
                JOIN Account a ON tal.account = a.id
            WHERE 
                t.posting = 'T'
                AND t.trandate >= TO_DATE('{start_sql}', 'YYYY-MM-DD')
                AND t.trandate <= TO_DATE('{end_sql}', 'YYYY-MM-DD')
                AND a.accttype IN ({types_sql})
                AND a.parent IS NOT NULL
                AND a.isinactive = 'F'
            GROUP BY 
                a.id, a.acctnumber, a.accountsearchdisplaynamecopy, a.accttype, a.parent
            HAVING 
                SUM(ABS(tal.amount)) > 0
            ORDER BY 
                CASE a.accttype 
                    WHEN 'Income' THEN 1 
                    WHEN 'OthIncome' THEN 2 
                    WHEN 'COGS' THEN 3 
                    WHEN 'Expense' THEN 4 
                    WHEN 'OthExpense' THEN 5 
                    ELSE 6 
                END,
                SUM(ABS(tal.amount)) DESC
            FETCH FIRST {limit * 2} ROWS ONLY
        """
        
        print(f"DEBUG - Accounts with activity query for {period}", file=sys.stderr)
        
        result = query_netsuite(query, timeout=30)
        
        if isinstance(result, dict) and 'error' in result:
            return jsonify(result), 500
        
        # Format response - take top accounts by activity
        accounts = []
        for row in result[:limit]:
            balance = row.get('balance') or 0
            # Convert to float if string
            try:
                balance = float(balance)
            except (TypeError, ValueError):
                balance = 0
            
            # Apply sign convention for Income
            if row.get('accttype') in ['Income', 'OthIncome']:
                balance = -balance  # Income is credit (negative) but we show positive
            
            accounts.append({
                'id': row.get('id'),
                'accountnumber': row.get('acctnumber'),
                'accountname': row.get('accountname'),
                'accttype': row.get('accttype'),
                'balance': round(balance, 2)
            })
        
        return jsonify({
            'period': period,
            'count': len(accounts),
            'accounts': accounts
        })
        
    except Exception as e:
        print(f"Error in get_accounts_with_activity: {str(e)}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/accounts/by-type', methods=['GET'])
def get_accounts_by_type():
    """
    Get all accounts of a specific type with their balances.
    Used for TYPEBALANCE drill-down (Step 1: show accounts).
    
    Query params:
        - account_type: Account type (e.g., "Expense", "AcctRec")
        - to_period: Period through which to calculate balance (e.g., "Dec 2025")
        - subsidiary: Optional subsidiary filter
        - use_special: "1" to filter by sspecacct instead of accttype
    
    Returns: List of accounts with balances
    """
    try:
        account_type = request.args.get('account_type', '')
        to_period = request.args.get('to_period', '')
        subsidiary = request.args.get('subsidiary', '')
        use_special = request.args.get('use_special', '0') == '1'
        
        if not account_type:
            return jsonify({'error': 'account_type parameter is required'}), 400
        
        # Convert subsidiary name to ID if needed
        subsidiary = convert_name_to_id('subsidiary', subsidiary)
        
        # Determine filter field
        type_field = 'sspecacct' if use_special else 'accttype'
        escaped_type = escape_sql(account_type)
        
        print(f"DEBUG - Accounts by type: {type_field}='{account_type}', to_period='{to_period}', subsidiary='{subsidiary}'", file=sys.stderr)
        
        # First, get all accounts of this type
        accounts_query = f"""
            SELECT 
                id,
                acctnumber,
                accountsearchdisplaynamecopy AS accountname,
                accttype
            FROM 
                Account
            WHERE 
                {type_field} = '{escaped_type}'
                AND isinactive = 'F'
            ORDER BY 
                acctnumber
        """
        
        accounts_result = query_netsuite(accounts_query)
        
        if isinstance(accounts_result, dict) and 'error' in accounts_result:
            return jsonify(accounts_result), 500
        
        if not accounts_result:
            return jsonify({'accounts': [], 'count': 0})
        
        # Determine if these are BS or P&L accounts
        first_acct_type = accounts_result[0].get('accttype', '')
        is_bs = is_balance_sheet_account(first_acct_type)
        
        # Get balances for each account
        accounts_with_balances = []
        
        # If no period specified, just return accounts without balances
        if not to_period:
            for acc in accounts_result:
                accounts_with_balances.append({
                    'account_number': acc.get('acctnumber'),
                    'account_name': acc.get('accountname'),
                    'balance': 0
                })
            return jsonify({
                'accounts': accounts_with_balances,
                'count': len(accounts_with_balances),
                'account_type': account_type,
                'is_balance_sheet': is_bs
            })
        
        # Parse period to get date for balance calculation
        start_date_str, end_date_str, period_id = get_period_dates_from_name(to_period)
        
        if not end_date_str:
            # If period parsing fails, return accounts without balances
            for acc in accounts_result:
                accounts_with_balances.append({
                    'account_number': acc.get('acctnumber'),
                    'account_name': acc.get('accountname'),
                    'balance': 0
                })
            return jsonify({
                'accounts': accounts_with_balances,
                'count': len(accounts_with_balances),
                'account_type': account_type,
                'is_balance_sheet': is_bs,
                'period': to_period
            })
        
        # Convert date format
        from datetime import datetime
        try:
            end_date = datetime.strptime(end_date_str, '%m/%d/%Y')
            to_date_str = end_date.strftime('%Y-%m-%d')
        except ValueError:
            to_date_str = end_date_str
        
        # Get ALL balances in a SINGLE efficient query using the account type filter
        # This is much faster than N separate queries
        print(f"DEBUG - Batch balance query for {type_field}='{account_type}' through {to_date_str}", file=sys.stderr)
        
        # For non-consolidated queries, use simple SUM (much faster)
        # For consolidated, we still need CONSOLIDATE but it's one query for all accounts
        target_sub = subsidiary or 1
        
        if is_bs:
            # Balance Sheet: cumulative from inception through period
            balance_query = f"""
                SELECT 
                    a.acctnumber,
                    SUM(
                        BUILTIN.CONSOLIDATE(
                            tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT',
                            {target_sub}, t.postingperiod, 'DEFAULT'
                        )
                    ) as balance
                FROM 
                    Transaction t
                    JOIN TransactionAccountingLine tal ON t.id = tal.transaction
                    JOIN Account a ON tal.account = a.id
                WHERE 
                    t.posting = 'T'
                    AND t.trandate <= TO_DATE('{to_date_str}', 'YYYY-MM-DD')
                    AND a.{type_field} = '{escaped_type}'
                    AND a.isinactive = 'F'
                GROUP BY a.acctnumber
            """
        else:
            # P&L: activity within the period (year)
            # Get fiscal year start
            year = to_period.split()[-1] if ' ' in to_period else to_period
            fy_start = f"01/01/{year}"
            try:
                fy_start_date = datetime.strptime(fy_start, '%m/%d/%Y')
                from_date_str = fy_start_date.strftime('%Y-%m-%d')
            except ValueError:
                from_date_str = f"{year}-01-01"
            
            balance_query = f"""
                SELECT 
                    a.acctnumber,
                    SUM(
                        BUILTIN.CONSOLIDATE(
                            tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT',
                            {target_sub}, t.postingperiod, 'DEFAULT'
                        )
                    ) * CASE WHEN a.accttype IN ('Income', 'OthIncome') THEN -1 ELSE 1 END as balance
                FROM 
                    Transaction t
                    JOIN TransactionAccountingLine tal ON t.id = tal.transaction
                    JOIN Account a ON tal.account = a.id
                WHERE 
                    t.posting = 'T'
                    AND t.trandate >= TO_DATE('{from_date_str}', 'YYYY-MM-DD')
                    AND t.trandate <= TO_DATE('{to_date_str}', 'YYYY-MM-DD')
                    AND a.{type_field} = '{escaped_type}'
                    AND a.isinactive = 'F'
                GROUP BY a.acctnumber, a.accttype
            """
        
        try:
            print(f"DEBUG - Executing batch balance query...", file=sys.stderr)
            balance_result = query_netsuite(balance_query, timeout=90)
            
            # Build lookup dict
            balance_lookup = {}
            if isinstance(balance_result, list):
                for row in balance_result:
                    acc_num = row.get('acctnumber')
                    raw_balance = row.get('balance') or 0
                    balance_lookup[acc_num] = float(raw_balance)
            
            print(f"DEBUG - Got {len(balance_lookup)} balances from batch query", file=sys.stderr)
            
        except Exception as e:
            print(f"Error in batch balance query: {e}", file=sys.stderr)
            balance_lookup = {}
        
        # Build response with balances
        for acc in accounts_result:
            acc_number = acc.get('acctnumber')
            accounts_with_balances.append({
                'account_number': acc_number,
                'account_name': acc.get('accountname'),
                'balance': balance_lookup.get(acc_number, 0)
            })
        
        return jsonify({
            'accounts': accounts_with_balances,
            'count': len(accounts_with_balances),
            'account_type': account_type,
            'is_balance_sheet': is_bs,
            'period': to_period
        })
        
    except Exception as e:
        print(f"Error in get_accounts_by_type: {str(e)}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


def build_pl_query(accounts, periods, base_where, target_sub, needs_line_join, accountingbook=None, 
                   subsidiary_id=None, use_hierarchy=False):
    """
    Build query for P&L accounts (Income Statement)
    P&L accounts show activity within the specific period only
    
    BUILTIN.CONSOLIDATE is always used - it works universally:
    - OneWorld: Performs currency consolidation to parent subsidiary
    - Non-OneWorld: Passes through amount unchanged
    
    Args:
        accountingbook: Accounting book ID (default: Primary Book / ID 1)
        subsidiary_id: Subsidiary ID for foreign currency check
        use_hierarchy: True if consolidated view (skip OthExpense flip)
    
    SIGN CONVENTIONS:
    - Income/OthIncome: Always flip (credit amounts to positive revenue)
    - OthExpense on FOREIGN subsidiaries (non-consolidated): Flip to match NetSuite IS display
    - All other expenses: No flip
    """
    if accountingbook is None:
        accountingbook = DEFAULT_ACCOUNTING_BOOK
    
    # Build account filter (supports wildcards like '4*' for all revenue accounts)
    account_filter = build_account_filter(accounts)
    periods_in = ','.join([f"'{escape_sql(p)}'" for p in periods])
    
    # Add account and period filters
    where_clause = f"{base_where} AND {account_filter} AND apf.periodname IN ({periods_in})"
    
    # Only include P&L account types (using constants)
    where_clause += f" AND a.accttype IN ({PL_TYPES_SQL})"
    
    # Add accountingbook filter (Multi-Book Accounting support)
    where_clause += f" AND tal.accountingbook = {accountingbook}"
    
    # Sign multiplier: flip Income/OthIncome from credits (negative) to positive display
    sign_sql = f"* CASE WHEN a.accttype IN ({INCOME_TYPES_SQL}) THEN -1 ELSE 1 END"
    
    # Always use BUILTIN.CONSOLIDATE - works for both OneWorld and non-OneWorld
    # For non-OneWorld, it simply returns the original amount unchanged
    amount_calc = f"""TO_NUMBER(
                                BUILTIN.CONSOLIDATE(
                                    tal.amount,
                                    'LEDGER',
                                    'DEFAULT',
                                    'DEFAULT',
                            {target_sub or 1},
                                    t.postingperiod,
                                    'DEFAULT'
                                )
                    )"""
    
    if needs_line_join:
        return f"""
            SELECT 
                a.acctnumber,
                ap.periodname,
                SUM(cons_amt) AS balance
            FROM (
                SELECT
                    tal.account,
                    t.postingperiod,
                    {amount_calc}
                    {sign_sql}
 AS cons_amt
                FROM TransactionAccountingLine tal
                    JOIN Transaction t ON t.id = tal.transaction
                    JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
                    JOIN Account a ON a.id = tal.account
                    JOIN AccountingPeriod apf ON apf.id = t.postingperiod
                WHERE {where_clause}
            ) x
            JOIN Account a ON a.id = x.account
            JOIN AccountingPeriod ap ON ap.id = x.postingperiod
            GROUP BY a.acctnumber, ap.periodname
        """
    else:
        return f"""
            SELECT 
                a.acctnumber,
                ap.periodname,
                SUM(cons_amt) AS balance
            FROM (
                SELECT
                    tal.account,
                    t.postingperiod,
                    {amount_calc}
                    {sign_sql}
 AS cons_amt
                FROM TransactionAccountingLine tal
                    JOIN Transaction t ON t.id = tal.transaction
                    JOIN Account a ON a.id = tal.account
                    JOIN AccountingPeriod apf ON apf.id = t.postingperiod
                WHERE {where_clause}
            ) x
            JOIN Account a ON a.id = x.account
            JOIN AccountingPeriod ap ON ap.id = x.postingperiod
            GROUP BY a.acctnumber, ap.periodname
        """


def build_bs_query_single_period(accounts, period_name, period_info, base_where, target_sub, needs_line_join, accountingbook=None):
    """
    Build query for Balance Sheet accounts for a SINGLE period
    Balance Sheet = CUMULATIVE balance from inception through period end
    
    Returns one row per account with the cumulative balance as of period end
    
    BUILTIN.CONSOLIDATE is always used - it works universally:
    - OneWorld: Performs currency consolidation to parent subsidiary
    - Non-OneWorld: Passes through amount unchanged
    
    Args:
        accountingbook: Accounting book ID (default: Primary Book / ID 1)
    """
    from datetime import datetime
    
    if accountingbook is None:
        accountingbook = DEFAULT_ACCOUNTING_BOOK
    
    # Build account filter (supports wildcards like '4*')
    account_filter = build_account_filter(accounts)
    
    enddate = period_info['enddate']
    period_id = period_info['id']
    
    # Parse enddate
    try:
        end_date_obj = datetime.strptime(enddate, '%m/%d/%Y')
        end_date_str = end_date_obj.strftime('%Y-%m-%d')
    except:
        end_date_str = enddate
    
    # Build WHERE clause (account_filter supports wildcards like '4*')
    where_clause = f"{base_where} AND {account_filter}"
    # Exclude P&L types - Balance Sheet only (using constants)
    where_clause += f" AND a.accttype NOT IN ({PL_TYPES_SQL})"
    # CUMULATIVE: All transactions through period end (no lower bound)
    where_clause += f" AND t.trandate <= TO_DATE('{end_date_str}', 'YYYY-MM-DD')"
    where_clause += f" AND tal.accountingbook = {accountingbook}"
    
    # Always use BUILTIN.CONSOLIDATE - works for both OneWorld and non-OneWorld
    # For BS, we use the target period_id for exchange rate (not posting period)
    if period_id:
        amount_calc = f"""TO_NUMBER(
                                    BUILTIN.CONSOLIDATE(
                                        tal.amount,
                                        'LEDGER',
                                        'DEFAULT',
                                        'DEFAULT',
                                {target_sub or 1},
                                        {period_id},
                                        'DEFAULT'
                                    )
                        )"""
    else:
        # Fallback for periods not in NetSuite's AccountingPeriod table
        print(f"WARNING: Using non-consolidated amounts for BS query (period_id={period_id})", file=sys.stderr)
        amount_calc = "tal.amount"
    
    if needs_line_join:
        return f"""
            SELECT 
                a.acctnumber,
                SUM({amount_calc}) AS balance
            FROM TransactionAccountingLine tal
                JOIN Transaction t ON t.id = tal.transaction
                JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
                JOIN Account a ON a.id = tal.account
            WHERE {where_clause}
            GROUP BY a.acctnumber
        """
    else:
        return f"""
            SELECT 
                a.acctnumber,
                SUM({amount_calc}) AS balance
            FROM TransactionAccountingLine tal
                JOIN Transaction t ON t.id = tal.transaction
                JOIN Account a ON a.id = tal.account
            WHERE {where_clause}
            GROUP BY a.acctnumber
        """


def build_bs_query(accounts, period_info, base_where, target_sub, needs_line_join, accountingbook=None):
    """
    Build query for Balance Sheet accounts (Assets/Liabilities/Equity)
    Balance Sheet accounts show CUMULATIVE balance from inception through period end
    
    Key difference: For each period, use t.trandate <= period.enddate
    Returns row-based output (like P&L) - one row per account per period
    
    BUILTIN.CONSOLIDATE is always used - it works universally:
    - OneWorld: Performs currency consolidation to parent subsidiary
    - Non-OneWorld: Passes through amount unchanged
    
    Performance optimization: 
    1. Query ONE period at a time (UNION ALL)
    2. Limit to fiscal year scope (not ALL history) to avoid timeouts
    
    Args:
        accountingbook: Accounting book ID (default: Primary Book / ID 1)
    """
    from datetime import datetime
    from dateutil.relativedelta import relativedelta
    
    if accountingbook is None:
        accountingbook = DEFAULT_ACCOUNTING_BOOK
    
    # Build account filter (supports wildcards like '4*')
    account_filter = build_account_filter(accounts)
    
    # Find the earliest period to determine fiscal year start
    earliest_enddate = min([info['enddate'] for info in period_info.values()])
    try:
        earliest_date = datetime.strptime(earliest_enddate, '%m/%d/%Y')
        # Get fiscal year start (January 1 of that year)
        fiscal_year_start = datetime(earliest_date.year, 1, 1)
        min_date_str = fiscal_year_start.strftime('%Y-%m-%d')
        print(f"DEBUG - BS query using fiscal year start: {min_date_str}", file=sys.stderr)
    except Exception as e:
        # Fallback: 1 year back
        min_date_str = '2024-01-01'
        print(f"DEBUG - BS query using fallback date: {min_date_str} (error: {e})", file=sys.stderr)
    
    union_queries = []
    
    for period, info in period_info.items():
        enddate = info['enddate']
        period_id = info['id']
        
        # Parse enddate
        try:
            end_date_obj = datetime.strptime(enddate, '%m/%d/%Y')
            end_date_str = end_date_obj.strftime('%Y-%m-%d')
        except:
            end_date_str = enddate
        
        # Build WHERE clause for this period (account_filter supports wildcards)
        period_where = f"{base_where} AND {account_filter}"
        # Exclude P&L types - Balance Sheet only (using constants)
        period_where += f" AND a.accttype NOT IN ({PL_TYPES_SQL})"
        # CRITICAL: Balance Sheet is CUMULATIVE - ALL transactions through period end (like user's reference)
        # No lower bound to get true cumulative balance
        period_where += f" AND t.trandate <= TO_DATE('{end_date_str}', 'YYYY-MM-DD')"
        # Add accountingbook filter (supports Multi-Book Accounting)
        period_where += f" AND tal.accountingbook = {accountingbook}"
        
        # Always use BUILTIN.CONSOLIDATE - works for both OneWorld and non-OneWorld
        # For BS, we use the period_id for exchange rate (not posting period)
        amount_calc = f"""TO_NUMBER(
                                    BUILTIN.CONSOLIDATE(
                                        tal.amount,
                                        'LEDGER',
                                        'DEFAULT',
                                        'DEFAULT',
                                {target_sub or 1},
                                        {period_id},
                                        'DEFAULT'
                                    )
                        )"""
        
        # Query for THIS period only
        if needs_line_join:
            period_query = f"""
                SELECT 
                    a.acctnumber,
                    '{escape_sql(period)}' AS periodname,
                    SUM({amount_calc}) AS balance
                FROM TransactionAccountingLine tal
                    JOIN Transaction t ON t.id = tal.transaction
                    JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
                    JOIN Account a ON a.id = tal.account
                WHERE {period_where}
                GROUP BY a.acctnumber
            """
        else:
            period_query = f"""
                SELECT 
                    a.acctnumber,
                    '{escape_sql(period)}' AS periodname,
                    SUM({amount_calc}) AS balance
                FROM TransactionAccountingLine tal
                    JOIN Transaction t ON t.id = tal.transaction
                    JOIN Account a ON a.id = tal.account
                WHERE {period_where}
                GROUP BY a.acctnumber
            """
        
        union_queries.append(period_query)
    
    # UNION all period queries
    full_query = " UNION ALL ".join(union_queries)
    full_query += " ORDER BY acctnumber, periodname"
    
    return full_query


def build_bs_cumulative_balance_query(target_period_name, target_sub, filters, accountingbook=None):
    """
    CORRECTED Balance Sheet Query - uses FIXED target period for CONSOLIDATE.
    
    This matches NetSuite's GL Balance report behavior:
    - ALL historical transactions are consolidated using the TARGET period's exchange rate
    - NOT each transaction's own posting period rate
    
    Key insight from working reference code:
      BUILTIN.CONSOLIDATE(..., target_period.id, ...)  ← Fixed period ID
    vs our old incorrect approach:
      BUILTIN.CONSOLIDATE(..., t.postingperiod, ...)   ← Variable period ID
    
    Args:
        accountingbook: Accounting book ID (default: Primary Book / ID 1)
    """
    if accountingbook is None:
        accountingbook = DEFAULT_ACCOUNTING_BOOK
    
    # Build filter clauses - class/department/location are on TransactionLine
    filter_clauses = []
    needs_line_join = False
    
    # CRITICAL: For subsidiary filtering, use tl.subsidiary (TransactionLine) NOT t.subsidiary
    # This is because intercompany journal entries have header on one subsidiary but 
    # lines that post to different subsidiaries. GL reports should filter by where
    # the accounting line posts, not the transaction header.
    if filters.get('subsidiary'):
        # ONLY use hierarchy when explicitly requested via filters
        use_hierarchy = filters.get('use_hierarchy', False)
        if use_hierarchy:
            hierarchy_subs = get_subsidiaries_in_hierarchy(filters['subsidiary'])
            sub_filter = ', '.join(hierarchy_subs)
            filter_clauses.append(f"tl.subsidiary IN ({sub_filter})")
        else:
            filter_clauses.append(f"tl.subsidiary = {filters['subsidiary']}")
        needs_line_join = True  # Must join TransactionLine for subsidiary filtering
    if filters.get('department'):
        filter_clauses.append(f"tl.department = {filters['department']}")
        needs_line_join = True
    if filters.get('location'):
        filter_clauses.append(f"tl.location = {filters['location']}")
        needs_line_join = True
    if filters.get('class'):
        filter_clauses.append(f"tl.class = {filters['class']}")
        needs_line_join = True
    
    filter_sql = (" AND " + " AND ".join(filter_clauses)) if filter_clauses else ""
    line_join = "INNER JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id" if needs_line_join else ""
    
    # Use CROSS JOIN to get the target period ID, then use it for CONSOLIDATE
    query = f"""
    SELECT 
      a.acctnumber AS account_number,
      SUM(
        TO_NUMBER(
          BUILTIN.CONSOLIDATE(
            tal.amount,
            'LEDGER',
            'DEFAULT',
            'DEFAULT',
            {target_sub},
            target_period.id,
            'DEFAULT'
          )
        )
      ) AS balance
    FROM TransactionAccountingLine tal
    INNER JOIN Transaction t ON t.id = tal.transaction
    {line_join}
    INNER JOIN Account a ON a.id = tal.account
    INNER JOIN AccountingPeriod ap ON ap.id = t.postingperiod
    CROSS JOIN (
      SELECT id, enddate 
      FROM AccountingPeriod 
      WHERE periodname = '{target_period_name}'
        AND isquarter = 'F' 
        AND isyear = 'F'
      FETCH FIRST 1 ROWS ONLY
    ) target_period
    WHERE 
      t.posting = 'T'
      AND tal.posting = 'T'
      AND tal.accountingbook = {accountingbook}
      AND a.accttype NOT IN ({PL_TYPES_SQL})
      AND ap.startdate <= target_period.enddate
      AND ap.isyear = 'F'
      AND ap.isquarter = 'F'
      {filter_sql}
    GROUP BY a.acctnumber
    HAVING SUM(
      TO_NUMBER(
        BUILTIN.CONSOLIDATE(
          tal.amount,
          'LEDGER',
          'DEFAULT',
          'DEFAULT',
          {target_sub},
          target_period.id,
          'DEFAULT'
        )
      )
    ) <> 0
    ORDER BY a.acctnumber
    """
    
    return query


def build_bs_multi_period_query(periods, target_sub, filters, accountingbook=None):
    """
    EFFICIENT Balance Sheet query - gets ALL periods in ONE query!
    
    Instead of running 4 separate queries for 4 periods (~280 sec),
    this runs 1 query with CASE statements (~36 sec).
    
    Args:
        periods: List of period names, e.g., ['Dec 2024', 'Jan 2025', 'Feb 2025', 'Mar 2025']
        target_sub: Target subsidiary ID for consolidation
        filters: Dict with optional subsidiary, department, location, class filters
        accountingbook: Accounting book ID (default: Primary Book / ID 1)
    
    Returns:
        SQL query string that returns account_number and one column per period (bal_YYYY_MM)
    """
    if not periods:
        return None
    
    if accountingbook is None:
        accountingbook = DEFAULT_ACCOUNTING_BOOK
    
    # Build filter clauses - class/department/location are on TransactionLine
    filter_clauses = []
    needs_line_join = False
    
    # CRITICAL: Use tl.subsidiary for GL line-level filtering (intercompany JEs have header on different sub)
    if filters.get('subsidiary'):
        # ONLY use hierarchy when explicitly requested via filters
        use_hierarchy = filters.get('use_hierarchy', False)
        if use_hierarchy:
            hierarchy_subs = get_subsidiaries_in_hierarchy(filters['subsidiary'])
            sub_filter = ', '.join(hierarchy_subs)
            filter_clauses.append(f"tl.subsidiary IN ({sub_filter})")
        else:
            filter_clauses.append(f"tl.subsidiary = {filters['subsidiary']}")
        needs_line_join = True  # Must join TransactionLine for subsidiary filtering
    if filters.get('department'):
        filter_clauses.append(f"tl.department = {filters['department']}")
        needs_line_join = True
    if filters.get('location'):
        filter_clauses.append(f"tl.location = {filters['location']}")
        needs_line_join = True
    if filters.get('class'):
        filter_clauses.append(f"tl.class = {filters['class']}")
        needs_line_join = True
    
    filter_sql = (" AND " + " AND ".join(filter_clauses)) if filter_clauses else ""
    line_join_sql = "INNER JOIN transactionline tl ON t.id = tl.transaction AND tal.transactionline = tl.id" if needs_line_join else ""
    
    # Parse periods and build components
    # Period format: "Mon YYYY" e.g., "Jan 2025"
    month_map = {
        'Jan': '01', 'Feb': '02', 'Mar': '03', 'Apr': '04',
        'May': '05', 'Jun': '06', 'Jul': '07', 'Aug': '08',
        'Sep': '09', 'Oct': '10', 'Nov': '11', 'Dec': '12'
    }
    
    period_aliases = []  # e.g., ['p_2024_12', 'p_2025_01', ...]
    inner_joins = []
    select_columns = []
    
    # Find the CHRONOLOGICALLY latest period for the WHERE clause
    # CRITICAL: Must compare dates, not just use the last item in the list!
    latest_period_alias = None
    latest_period_date = None  # (year, month) tuple for comparison
    
    for period in periods:
        parts = period.split(' ')
        if len(parts) != 2:
            continue
        
        month_name = parts[0]
        year = parts[1]
        month_num = month_map.get(month_name)
        
        if not month_num:
            continue
        
        # Create alias like p_2024_12
        alias = f"p_{year}_{month_num}"
        period_aliases.append(alias)
        
        # Track the CHRONOLOGICALLY latest period
        period_date = (int(year), int(month_num))
        if latest_period_date is None or period_date > latest_period_date:
            latest_period_alias = alias
            latest_period_date = period_date
        
        # Build INNER JOIN
        # INNER JOIN accountingperiod p_2024_12 ON TO_CHAR(p_2024_12.startdate, 'YYYY-MM') = '2024-12' AND p_2024_12.isquarter = 'F' AND p_2024_12.isyear = 'F'
        inner_joins.append(f"""
  INNER JOIN accountingperiod {alias} 
    ON TO_CHAR({alias}.startdate, 'YYYY-MM') = '{year}-{month_num}' 
    AND {alias}.isquarter = 'F' 
    AND {alias}.isyear = 'F'""")
        
        # Build SELECT column with CASE WHEN
        # SUM(CASE WHEN ap.startdate <= p_2024_12.enddate
        #     THEN TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', 1, p_2024_12.id, 'DEFAULT'))
        #          * sign_multiplier  -- Flip sign for liabilities/equity
        #     ELSE 0 END) AS bal_2024_12
        #
        # ACCOUNTING SIGN CONVENTION:
        # - Assets (Bank, AcctRec, FixedAsset, OthAsset, OthCurrAsset, UnbilledRec, DeferExpense) 
        #   → Natural debit balance → stored positive → NO FLIP
        # - Liabilities (AcctPay, CredCard, OthCurrLiab, LongTermLiab, DeferRevenue)
        #   → Natural credit balance → stored negative → FLIP TO POSITIVE
        # - Equity (Equity, RetainedEarnings)
        #   → Natural credit balance → stored negative → FLIP TO POSITIVE
        #
        col_name = f"bal_{year}_{month_num}"
        # Use SIGN_FLIP_TYPES_SQL constant for liability/equity sign flip
        select_columns.append(f"""
  SUM(CASE WHEN ap.startdate <= {alias}.enddate
    THEN TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', {target_sub}, {alias}.id, 'DEFAULT'))
         * CASE WHEN a.accttype IN ({SIGN_FLIP_TYPES_SQL}) 
                THEN -1 ELSE 1 END
    ELSE 0 END) AS {col_name}""")
    
    if not period_aliases:
        return None
    
    # Build full query
    joins_sql = "".join(inner_joins)
    columns_sql = ",".join(select_columns)
    
    query = f"""
SELECT 
  a.acctnumber AS account_number,
  a.accttype AS account_type,
  {columns_sql}

FROM transactionaccountingline tal
  INNER JOIN transaction t ON t.id = tal.transaction
  {line_join_sql}
  INNER JOIN account a ON a.id = tal.account
  INNER JOIN accountingperiod ap ON ap.id = t.postingperiod
  {joins_sql}

WHERE 
  t.posting = 'T'
  AND tal.posting = 'T'
  AND tal.accountingbook = {accountingbook}
  AND a.accttype NOT IN ({PL_TYPES_SQL})
  AND ap.startdate <= {latest_period_alias}.enddate
  AND ap.isyear = 'F'
  AND ap.isquarter = 'F'
  {filter_sql}

GROUP BY a.acctnumber, a.accttype
ORDER BY a.acctnumber
"""
    
    return query


def build_exchange_rates_query_DEPRECATED(period_name, target_sub):
    """
    DEPRECATED - No longer needed with corrected CONSOLIDATE approach.
    Get exchange rates from ConsolidatedExchangeRate table for a specific period.
    Returns rates from each subsidiary to the target (parent) subsidiary.
    """
    query = f"""
    SELECT 
      cer.fromsubsidiary,
      s.currency AS from_currency,
      cer.currentrate
    FROM ConsolidatedExchangeRate cer
    JOIN AccountingPeriod ap ON ap.id = cer.postingperiod
    JOIN Subsidiary s ON s.id = cer.fromsubsidiary
    WHERE ap.periodname = '{period_name}'
      AND ap.isyear = 'F'
      AND cer.tosubsidiary = {target_sub}
      AND cer.accountingbook = 1
    """
    return query


def build_full_year_bs_opening_balance_query(fiscal_year, target_sub, filters, accountingbook=None):
    """
    LEGACY - kept for backward compatibility but not accurate for foreign currency.
    Use the new local currency approach instead.
    
    Args:
        accountingbook: Accounting book ID (default: Primary Book / ID 1)
    """
    if accountingbook is None:
        accountingbook = DEFAULT_ACCOUNTING_BOOK
    
    filter_clauses = []
    needs_line_join = False
    
    # CRITICAL: Use tl.subsidiary for GL line-level filtering (intercompany JEs have header on different sub)
    if filters.get('subsidiary'):
        use_hierarchy = filters.get('use_hierarchy', False)
        if use_hierarchy:
            hierarchy_subs = get_subsidiaries_in_hierarchy(filters['subsidiary'])
            sub_filter = ', '.join(hierarchy_subs)
            filter_clauses.append(f"tl.subsidiary IN ({sub_filter})")
        else:
            filter_clauses.append(f"tl.subsidiary = {filters['subsidiary']}")
        needs_line_join = True
    if filters.get('department'):
        filter_clauses.append(f"tl.department = {filters['department']}")
        needs_line_join = True
    if filters.get('location'):
        filter_clauses.append(f"tl.location = {filters['location']}")
        needs_line_join = True
    if filters.get('class'):
        filter_clauses.append(f"tl.class = {filters['class']}")
        needs_line_join = True
    
    filter_sql = (" AND " + " AND ".join(filter_clauses)) if filter_clauses else ""
    line_join = "JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id" if needs_line_join else ""
    prior_year = int(fiscal_year) - 1
    
    query = f"""
      SELECT
      a.acctnumber AS account_number,
      SUM(
            TO_NUMBER(
              BUILTIN.CONSOLIDATE(
                tal.amount,
                'LEDGER',
                'DEFAULT',
                'DEFAULT',
                {target_sub},
                t.postingperiod,
                'DEFAULT'
              )
            )
      ) AS opening_balance
      FROM TransactionAccountingLine tal
      JOIN Transaction t ON t.id = tal.transaction
      {line_join}
      JOIN Account a ON a.id = tal.account
      JOIN AccountingPeriod ap ON ap.id = t.postingperiod
      WHERE t.posting = 'T'
        AND tal.posting = 'T'
        AND tal.accountingbook = {accountingbook}
        AND ap.isyear = 'F'
        AND ap.isquarter = 'F'
      AND EXTRACT(YEAR FROM ap.enddate) <= {prior_year}
        AND a.accttype NOT IN ({PL_TYPES_SQL})
        {filter_sql}
    GROUP BY a.acctnumber
    ORDER BY a.acctnumber
    """
    
    return query


def build_full_year_bs_activity_query(fiscal_year, target_sub, filters, accountingbook=None):
    """
    LEGACY - kept for backward compatibility but not accurate for foreign currency.
    
    Args:
        accountingbook: Accounting book ID (default: Primary Book / ID 1)
    """
    if accountingbook is None:
        accountingbook = DEFAULT_ACCOUNTING_BOOK
    
    filter_clauses = []
    needs_line_join = False
    
    # CRITICAL: Use tl.subsidiary for GL line-level filtering
    if filters.get('subsidiary'):
        use_hierarchy = filters.get('use_hierarchy', False)
        if use_hierarchy:
            hierarchy_subs = get_subsidiaries_in_hierarchy(filters['subsidiary'])
            sub_filter = ', '.join(hierarchy_subs)
            filter_clauses.append(f"tl.subsidiary IN ({sub_filter})")
        else:
            filter_clauses.append(f"tl.subsidiary = {filters['subsidiary']}")
        needs_line_join = True
    if filters.get('department'):
        filter_clauses.append(f"tl.department = {filters['department']}")
        needs_line_join = True
    if filters.get('location'):
        filter_clauses.append(f"tl.location = {filters['location']}")
        needs_line_join = True
    if filters.get('class'):
        filter_clauses.append(f"tl.class = {filters['class']}")
        needs_line_join = True
    
    filter_sql = (" AND " + " AND ".join(filter_clauses)) if filter_clauses else ""
    line_join = "JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id" if needs_line_join else ""
    
    query = f"""
    SELECT
      a.acctnumber AS account_number,
      TO_CHAR(ap.startdate,'YYYY-MM') AS month,
      SUM(
        TO_NUMBER(
          BUILTIN.CONSOLIDATE(
            tal.amount,
            'LEDGER',
            'DEFAULT',
            'DEFAULT',
            {target_sub},
            t.postingperiod,
            'DEFAULT'
          )
        )
      ) AS amount
    FROM TransactionAccountingLine tal
    JOIN Transaction t ON t.id = tal.transaction
    {line_join}
    JOIN Account a ON a.id = tal.account
    JOIN AccountingPeriod ap ON ap.id = t.postingperiod
    WHERE t.posting = 'T'
      AND tal.posting = 'T'
      AND tal.accountingbook = {accountingbook}
      AND ap.isyear = 'F'
      AND ap.isquarter = 'F'
      AND EXTRACT(YEAR FROM ap.startdate) = {fiscal_year}
      AND a.accttype NOT IN ({PL_TYPES_SQL})
      {filter_sql}
    GROUP BY a.acctnumber, ap.startdate
    ORDER BY a.acctnumber, ap.startdate
    """
    
    return query


def build_full_year_pl_query(fiscal_year, target_sub, filters, accountingbook=None):
    """
    DEPRECATED - kept for compatibility.
    Use build_full_year_pl_query_pivoted instead for ~5x faster performance.
    """
    return build_full_year_pl_query_pivoted(fiscal_year, target_sub, filters, accountingbook)


def build_full_year_pl_query_pivoted(fiscal_year, target_sub, filters, accountingbook=None):
    """
    OPTIMIZED full-year P&L query using PIVOTED columns for all 12 months.
    
    Key optimizations:
    1. Uses CROSS JOIN subquery instead of CTE (better SuiteQL compatibility)
    2. Pivots all 12 months into columns with SUM(CASE WHEN...) 
    3. Returns one row per account (not per account/month)
    4. Single query, no pagination needed
    
    Expected performance: ~6 seconds for ALL P&L accounts × 12 months
    (vs ~15-30 seconds with the old CTE/long-format approach)
    
    Args:
        accountingbook: Accounting book ID (default: Primary Book / ID 1)
    
    SIGN CONVENTIONS:
    - Income/OthIncome: Always flip (credit amounts to positive revenue)
    - OthExpense on FOREIGN subsidiaries (non-consolidated): Flip to match NetSuite IS display
    - All other expenses: No flip (debit amounts remain as positive expenses)
    
    See DOCUMENTATION.md for full explanation of OthExpense sign handling.
    """
    if accountingbook is None:
        accountingbook = DEFAULT_ACCOUNTING_BOOK
    
    # Build optional filter clauses
    # Note: class, department, location, and subsidiary are on TransactionLine
    filter_clauses = []
    needs_line_join = False
    use_hierarchy = filters.get('use_hierarchy', False)
    
    # CRITICAL: Use tl.subsidiary for GL line-level filtering (intercompany JEs have header on different sub)
    if filters.get('subsidiary'):
        if use_hierarchy:
            hierarchy_subs = get_subsidiaries_in_hierarchy(filters['subsidiary'])
            sub_filter = ', '.join(hierarchy_subs)
            filter_clauses.append(f"tl.subsidiary IN ({sub_filter})")
        else:
            filter_clauses.append(f"tl.subsidiary = {filters['subsidiary']}")
        needs_line_join = True  # Must join TransactionLine for subsidiary filtering
    if filters.get('department'):
        filter_clauses.append(f"tl.department = {filters['department']}")
        needs_line_join = True
    if filters.get('location'):
        filter_clauses.append(f"tl.location = {filters['location']}")
        needs_line_join = True
    if filters.get('class'):
        filter_clauses.append(f"tl.class = {filters['class']}")
        needs_line_join = True
    
    filter_sql = (" AND " + " AND ".join(filter_clauses)) if filter_clauses else ""
    
    # Add TransactionLine join if filtering by class/department/location/subsidiary
    line_join = "JOIN transactionline tl ON t.id = tl.transaction AND tal.transactionline = tl.id" if needs_line_join else ""
    
    # Sign multiplier: flip Income/OthIncome from credits (negative) to positive display
    sign_sql = f"* CASE WHEN a.accttype IN ({INCOME_TYPES_SQL}) THEN -1 ELSE 1 END"
    
    # Build the pivoted query with all 12 months as columns
    # Always use BUILTIN.CONSOLIDATE - works for both OneWorld and non-OneWorld
    query = f"""
    SELECT
      a.acctnumber AS account_number,
      a.accttype AS account_type,
      SUM(CASE WHEN TO_CHAR(ap.startdate,'YYYY-MM')='{fiscal_year}-01' THEN cons_amt ELSE 0 END) AS jan,
      SUM(CASE WHEN TO_CHAR(ap.startdate,'YYYY-MM')='{fiscal_year}-02' THEN cons_amt ELSE 0 END) AS feb,
      SUM(CASE WHEN TO_CHAR(ap.startdate,'YYYY-MM')='{fiscal_year}-03' THEN cons_amt ELSE 0 END) AS mar,
      SUM(CASE WHEN TO_CHAR(ap.startdate,'YYYY-MM')='{fiscal_year}-04' THEN cons_amt ELSE 0 END) AS apr,
      SUM(CASE WHEN TO_CHAR(ap.startdate,'YYYY-MM')='{fiscal_year}-05' THEN cons_amt ELSE 0 END) AS may,
      SUM(CASE WHEN TO_CHAR(ap.startdate,'YYYY-MM')='{fiscal_year}-06' THEN cons_amt ELSE 0 END) AS jun,
      SUM(CASE WHEN TO_CHAR(ap.startdate,'YYYY-MM')='{fiscal_year}-07' THEN cons_amt ELSE 0 END) AS jul,
      SUM(CASE WHEN TO_CHAR(ap.startdate,'YYYY-MM')='{fiscal_year}-08' THEN cons_amt ELSE 0 END) AS aug,
      SUM(CASE WHEN TO_CHAR(ap.startdate,'YYYY-MM')='{fiscal_year}-09' THEN cons_amt ELSE 0 END) AS sep,
      SUM(CASE WHEN TO_CHAR(ap.startdate,'YYYY-MM')='{fiscal_year}-10' THEN cons_amt ELSE 0 END) AS oct,
      SUM(CASE WHEN TO_CHAR(ap.startdate,'YYYY-MM')='{fiscal_year}-11' THEN cons_amt ELSE 0 END) AS nov,
      SUM(CASE WHEN TO_CHAR(ap.startdate,'YYYY-MM')='{fiscal_year}-12' THEN cons_amt ELSE 0 END) AS dec_month
    FROM (
      SELECT
        tal.account,
        t.postingperiod,
            TO_NUMBER(
              BUILTIN.CONSOLIDATE(
                tal.amount,
                'LEDGER',
                'DEFAULT',
                'DEFAULT',
            {target_sub or 1},
                t.postingperiod,
                'DEFAULT'
              )
            )
        {sign_sql}
        AS cons_amt
      FROM transactionaccountingline tal
        JOIN transaction t ON t.id = tal.transaction
        {line_join}
        JOIN account a ON a.id = tal.account
        JOIN accountingperiod apf ON apf.id = t.postingperiod
      WHERE t.posting = 'T'
        AND tal.posting = 'T'
        AND tal.accountingbook = {accountingbook}
        AND apf.isyear = 'F' 
        AND apf.isquarter = 'F'
        AND TO_CHAR(apf.startdate,'YYYY') = '{fiscal_year}'
        AND a.accttype IN ({PL_TYPES_SQL})
        {filter_sql}
    ) x
    JOIN accountingperiod ap ON ap.id = x.postingperiod
    JOIN account a ON a.id = x.account
    GROUP BY a.acctnumber, a.accttype
    ORDER BY a.acctnumber
    """
    
    return query


def run_paginated_suiteql(base_query, page_size=1000, max_pages=20, timeout=120):
    """
    Execute a SuiteQL query with pagination to overcome NetSuite's 1000-row limit.
    
    NetSuite SuiteQL uses API-level pagination via URL parameters, NOT SQL OFFSET/LIMIT.
    The 'offset' parameter is added to the API URL.
    
    Args:
        base_query: SQL query (the API handles pagination)
        page_size: Rows per page (max 1000 for NetSuite)
        max_pages: Safety limit to prevent infinite loops
        timeout: Request timeout in seconds
    
    Returns:
        List of all rows from all pages
    """
    all_rows = []
    offset = 0
    page_num = 0
    
    while page_num < max_pages:
        page_num += 1
        
        # NetSuite pagination is done via URL parameters, not SQL syntax!
        # Add offset to the URL: /query/v1/suiteql?offset=X&limit=Y
        paginated_url = f"{suiteql_url}?limit={page_size}&offset={offset}"
        
        response = requests.post(
            paginated_url,
            auth=auth,
            headers={'Content-Type': 'application/json', 'Prefer': 'transient'},
            json={'q': base_query},
            timeout=timeout
        )
        
        if response.status_code != 200:
            print(f"❌ NetSuite error on page {page_num}: {response.status_code}", flush=True)
            print(f"   Response: {response.text[:500]}", flush=True)
            raise Exception(f"NetSuite API error: {response.status_code}")
        
        result = response.json()
        rows = result.get('items', [])
        
        print(f"   Page {page_num}: {len(rows)} rows (total: {len(all_rows) + len(rows)})", flush=True)
        
        all_rows.extend(rows)
        
        # If we got fewer rows than page_size, we've reached the end
        if len(rows) < page_size:
            break
        
        offset += page_size
    
    if page_num >= max_pages:
        print(f"⚠️ Reached max page limit ({max_pages})", flush=True)
    
    return all_rows


def convert_month_to_period_name(month_str):
    """Convert 'YYYY-MM' to 'Mon YYYY' format"""
    try:
        dt = datetime.strptime(month_str, '%Y-%m')
        return dt.strftime('%b %Y')
    except:
        return month_str


def extract_year_from_period(period_name):
    """Extract year from 'Jan 2024' format"""
    try:
        parts = period_name.split()
        if len(parts) == 2:
            return int(parts[1])
    except:
        pass
    return datetime.now().year


@app.route('/batch/full_year_refresh', methods=['POST'])
def batch_full_year_refresh():
    """
    OPTIMIZED FULL-YEAR REFRESH - Get ALL P&L accounts for an entire fiscal year in ONE query.
    Uses optimized CTE pattern that consolidates FIRST, then groups (much faster).
    
    Expected performance: < 30 seconds for ALL accounts × 12 months
    
    POST JSON:
    {
        "year": 2025,  // Optional - defaults to current year
        "subsidiary": "",
        "class": "",
        "department": "",
        "location": ""
    }
    
    Returns:
    {
        "balances": {
            "4010": {
                "Jan 2025": 12400000,
                "Feb 2025": 13200000,
                ...
            },
            "5000": {
                "Jan 2025": 5000000,
                ...
            }
        }
    }
    """
    data = request.get_json() or {}
    
    # Extract year - default to current year if not provided
    fiscal_year = data.get('year')
    if not fiscal_year:
        # Try to extract from first period if provided
        periods = data.get('periods', [])
        if periods:
            fiscal_year = extract_year_from_period(periods[0])
        else:
            fiscal_year = datetime.now().year
    
    # Get filters - IMPORTANT: Save raw subsidiary BEFORE converting to ID
    raw_subsidiary = data.get('subsidiary', '')
    class_id = data.get('class', '')
    department = data.get('department', '')
    location = data.get('location', '')
    
    # PERFORMANCE: Skip Balance Sheet accounts for fast preloading
    # BS accounts require cumulative calculation from beginning of time (slow)
    # Set skip_bs=true for fast P&L-only preload
    skip_bs = data.get('skip_bs', False)
    
    # Multi-Book Accounting support - default to Primary Book (ID 1)
    accountingbook = data.get('accountingbook', DEFAULT_ACCOUNTING_BOOK)
    if isinstance(accountingbook, str) and accountingbook.strip():
        try:
            accountingbook = int(accountingbook)
        except ValueError:
            accountingbook = DEFAULT_ACCOUNTING_BOOK
    elif not accountingbook:
        accountingbook = DEFAULT_ACCOUNTING_BOOK
    
    # Convert names to IDs
    subsidiary = convert_name_to_id('subsidiary', raw_subsidiary)
    class_id = convert_name_to_id('class', class_id)
    department = convert_name_to_id('department', department)
    location = convert_name_to_id('location', location)
    
    # Determine consolidated status (explicit OR auto from root)
    wants_consolidated = should_use_consolidated(raw_subsidiary, subsidiary)
    
    # Determine target subsidiary for consolidation
    if subsidiary and subsidiary != '':
        target_sub = subsidiary
    else:
        target_sub = default_subsidiary_id or '1'
    
    # Build filters dict - include use_hierarchy flag for consolidated requests
    filters = {}
    if subsidiary and subsidiary != '':
        filters['subsidiary'] = subsidiary
        # Use hierarchy if explicitly consolidated OR if root subsidiary
        # ONLY use hierarchy when "(Consolidated)" is explicitly requested
        # Per NetSuite behavior: "Celigo Inc." = just that subsidiary
        #                        "Celigo Inc. (Consolidated)" = includes children
        filters['use_hierarchy'] = wants_consolidated
    if class_id and class_id != '':
        filters['class'] = class_id
    if department and department != '':
        filters['department'] = department
    if location and location != '':
        filters['location'] = location
    
    print(f"🔍 FULL YEAR REFRESH: raw_subsidiary='{raw_subsidiary}', wants_consolidated={wants_consolidated}", file=sys.stderr)
    if subsidiary:
        print(f"   use_hierarchy={filters.get('use_hierarchy', False)}", file=sys.stderr)
    
    # DEBUG: Query sspecacct values for 80xxx and 89xxx accounts
    try:
        debug_query = """
        SELECT acctnumber, accttype, sspecacct 
        FROM account 
        WHERE acctnumber LIKE '80%' OR acctnumber LIKE '89%'
        ORDER BY acctnumber
        """
        debug_result = query_netsuite(debug_query)
        if isinstance(debug_result, list):
            print(f"   DEBUG sspecacct values for 80xxx/89xxx accounts:", file=sys.stderr)
            for item in debug_result:
                acct = item.get('acctnumber', '')
                atype = item.get('accttype', '')
                sspec = item.get('sspecacct', '')
                is_matching = 'YES' if sspec and str(sspec).startswith('Matching') else 'NO'
                print(f"     {acct}: type={atype}, sspecacct='{sspec}', isMatching={is_matching}", file=sys.stderr)
        else:
            print(f"   DEBUG query returned: {debug_result}", file=sys.stderr)
    except Exception as e:
        print(f"   DEBUG query failed: {e}", file=sys.stderr)
    
    try:
        print(f"\n{'='*80}", flush=True)
        print(f"🚀 FULL YEAR REFRESH (OPTIMIZED PIVOTED QUERY): {fiscal_year}", flush=True)
        print(f"   Target subsidiary: {target_sub}", flush=True)
        print(f"   Filters: {filters}", flush=True)
        print(f"{'='*80}\n", flush=True)
        
        # Build the OPTIMIZED PIVOTED query (one row per account, 12 month columns)
        base_query = build_full_year_pl_query_pivoted(fiscal_year, target_sub, filters, accountingbook)
        
        # Execute query - no pagination needed since one row per account!
        start_time = datetime.now()
        
        try:
            # The pivoted query returns ~100-300 rows (one per account) so pagination is optional
            items = run_paginated_suiteql(base_query, page_size=1000, max_pages=5, timeout=30)
        except Exception as e:
            print(f"❌ Query error: {e}", flush=True)
            return jsonify({'error': f'NetSuite query failed: {str(e)}'}), 500
        
        elapsed = (datetime.now() - start_time).total_seconds()
        print(f"⏱️  Total query time: {elapsed:.2f} seconds", flush=True)
        print(f"✅ Received {len(items)} rows (one per account)")
        
        # Transform PIVOTED results to nested dict: { account: { period: value } }
        # New format: each row has jan, feb, mar, ..., dec_month columns
        balances = {}
        account_types = {}  # { account_number: "Income" | "Expense" | etc. }
        
        # Month column mapping: column name -> period name
        month_mapping = {
            'jan': f'Jan {fiscal_year}',
            'feb': f'Feb {fiscal_year}',
            'mar': f'Mar {fiscal_year}',
            'apr': f'Apr {fiscal_year}',
            'may': f'May {fiscal_year}',
            'jun': f'Jun {fiscal_year}',
            'jul': f'Jul {fiscal_year}',
            'aug': f'Aug {fiscal_year}',
            'sep': f'Sep {fiscal_year}',
            'oct': f'Oct {fiscal_year}',
            'nov': f'Nov {fiscal_year}',
            'dec_month': f'Dec {fiscal_year}'  # 'dec' might be reserved, so using dec_month
        }
        
        for row in items:
            account = row.get('account_number')
            acct_type = row.get('account_type', '')
            
            if not account:
                continue
                
            balances[account] = {}
            account_types[account] = acct_type
            
            # Extract each month's value from the pivoted columns
            for col_name, period_name in month_mapping.items():
                amount = row.get(col_name)
                if amount is not None:
                    balances[account][period_name] = float(amount)
                else:
                    # SuiteQL may not return column if all values are 0
                    balances[account][period_name] = 0.0
            
            # DEBUG: Log 80xxx and 89xxx accounts to diagnose sign issues
            if account.startswith('80') or account.startswith('89'):
                feb_val = balances[account].get(f'Feb {fiscal_year}', 0)
                if feb_val != 0:
                    print(f"   DEBUG SIGN: acct={account}, type={acct_type}, Feb={feb_val}", file=sys.stderr)
        
        print(f"📊 Returning {len(balances)} accounts × 12 months (P&L)")
        
        # CRITICAL: Cache all results in backend for fast lookups
        # This allows individual formula requests to be instant after full refresh
        global balance_cache, balance_cache_timestamp
        balance_cache = {}
        balance_cache_timestamp = datetime.now()
        
        filters_hash = f"{subsidiary}:{department}:{location}:{class_id}"
        cached_count = 0
        
        print(f"🔑 Cache key format:")
        print(f"   subsidiary='{subsidiary}', department='{department}', location='{location}', class='{class_id}'")
        print(f"   filters_hash='{filters_hash}' (length: {len(filters_hash)}, colons: {filters_hash.count(':')})")
        
        for account, periods_data in balances.items():
            for period, amount in periods_data.items():
                cache_key = f"{account}:{period}:{filters_hash}"
                balance_cache[cache_key] = amount
                cached_count += 1
                
                # Show first 3 keys as examples
                if cached_count <= 3:
                    print(f"   Example key #{cached_count}: '{cache_key}' (length: {len(cache_key)}, colons: {cache_key.count(':')})")
        
        print(f"💾 Cached {cached_count} values on backend for instant formula lookups")
        print(f"{'='*80}\n")
        
        # PERFORMANCE: Skip BS accounts if skip_bs=true (for fast preloading)
        if skip_bs:
            print(f"⏭️  Skipping Balance Sheet accounts (skip_bs=true for fast preload)")
            print(f"   BS accounts will be loaded on-demand when formulas are entered")
            print(f"   P&L accounts loaded: {len(balances)}")
            print(f"{'='*80}\n")
            
            # Use global account_title_cache for account names
            account_names_dict = {acct: account_title_cache.get(acct, '') for acct in balances.keys()}
            
            return jsonify({
                'balances': balances,
                'account_types': account_types,
                'account_names': account_names_dict,
                'pl_only': True,
                'accounts_loaded': len(balances)
            })
        
        # ALSO fetch Balance Sheet accounts for the same year
        # OPTIMIZED: Query returns ACTIVITY per month, backend computes cumulative
        print(f"\n📊 Now fetching Balance Sheet accounts (OPTIMIZED - activity query)...", flush=True)
        
        # Clear BS activity cache
        global bs_activity_cache, bs_activity_cache_timestamp, bs_account_set
        bs_activity_cache = {}
        bs_activity_cache_timestamp = datetime.now()
        bs_account_set = set()
        
        try:
            bs_query = build_full_year_bs_query(fiscal_year, target_sub, filters)
            print(f"   BS Query (first 500 chars):\n{bs_query[:500]}...", flush=True)
            bs_start = datetime.now()
            # OPTIMIZED: Activity query is much faster than old cumulative query
            # Timeout reduced from 240s to 120s
            bs_items = run_paginated_suiteql(bs_query, page_size=1000, max_pages=20, timeout=120)
            bs_elapsed = (datetime.now() - bs_start).total_seconds()
            print(f"⏱️  BS query time: {bs_elapsed:.2f} seconds", flush=True)
            print(f"✅ BS returned {len(bs_items)} rows (account × month)", flush=True)
            
            # Process BS results - same format as P&L now (account, month, amount)
            # Store ACTIVITY in bs_activity_cache
            bs_account_count = 0
            bs_activity_data = {}  # { account: { period: activity } }
            
            for row in bs_items:
                account = row.get('account_number')
                acct_type = row.get('account_type', '')
                month_str = row.get('month')  # 'YYYY-MM' format
                amount = float(row.get('amount', 0))
                
                if not account or not month_str:
                    continue
                
                # Convert 'YYYY-MM' to 'Mon YYYY' format
                period_name = convert_month_to_period_name(month_str)
                
                # Track this as a BS account
                bs_account_set.add(account)
                
                if account not in bs_activity_data:
                    bs_activity_data[account] = {}
                    account_types[account] = acct_type
                    bs_account_count += 1
                
                # Store ACTIVITY (not cumulative)
                bs_activity_data[account][period_name] = amount
                
                # Cache activity for later cumulative calculations
                activity_cache_key = f"activity:{account}:{period_name}:{filters_hash}"
                bs_activity_cache[activity_cache_key] = amount
            
            print(f"📊 Loaded activity for {bs_account_count} Balance Sheet accounts", flush=True)
            
            # Now compute CUMULATIVE balances from activity
            # CRITICAL: Balance Sheet cumulative must include PRIOR YEAR ending balance!
            # Activity in 2025 alone doesn't give cumulative - we need Dec 2024 balance first
            
            month_order = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 
                          'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
            cumulative_count = 0
            
            # Step 1: Query prior year ending balance for ALL BS accounts (ONE query)
            # This is much faster than 12 cumulative queries per account
            prior_year = fiscal_year - 1
            prior_year_balances = {}
            
            try:
                bs_account_list = "', '".join([escape_sql(str(a)) for a in bs_activity_data.keys()])
                if bs_account_list:
                    prior_year_query = f"""
                        SELECT a.acctnumber, SUM(
                            BUILTIN.CONSOLIDATE(
                                tal.amount,
                                'LEDGER', 'DEFAULT', 'DEFAULT',
                                {target_sub},
                                t.postingperiod,
                                'DEFAULT'
                            )
                        ) AS balance
                        FROM TransactionAccountingLine tal
                        JOIN Transaction t ON t.id = tal.transaction
                        JOIN Account a ON a.id = tal.account
                        WHERE t.posting = 'T'
                            AND tal.posting = 'T'
                            AND tal.accountingbook = {accountingbook}
                            AND a.acctnumber IN ('{bs_account_list}')
                            AND t.trandate <= TO_DATE('{prior_year}-12-31', 'YYYY-MM-DD')
                        GROUP BY a.acctnumber
                    """
                    print(f"📊 Fetching prior year ({prior_year}) ending balances for {len(bs_activity_data)} BS accounts...", flush=True)
                    prior_result = query_netsuite(prior_year_query, timeout=120)
                    if isinstance(prior_result, list):
                        for row in prior_result:
                            acc = str(row.get('acctnumber', ''))
                            bal = float(row.get('balance', 0))
                            prior_year_balances[acc] = bal
                        print(f"✅ Got prior year balances for {len(prior_year_balances)} accounts", flush=True)
            except Exception as prior_err:
                print(f"⚠️  Prior year balance query failed (using 0 as starting point): {prior_err}", flush=True)
            
            # Step 2: Compute cumulative by adding activity to prior year balance
            for account, activity_by_period in bs_activity_data.items():
                if account not in balances:
                    balances[account] = {}
                
                # Start with prior year ending balance (or 0 if not found)
                cumulative = prior_year_balances.get(account, 0)
                
                for month_abbrev in month_order:
                    period_name = f"{month_abbrev} {fiscal_year}"
                    
                    # Add this month's activity to running cumulative
                    activity = activity_by_period.get(period_name, 0)
                    cumulative += activity
                    
                    # Fix floating-point precision: round tiny values to 0
                    # (e.g., 2.3e-10 should be $0, not exponential notation)
                    if abs(cumulative) < 0.01:
                        cumulative = 0
                    
                    # Store CUMULATIVE balance (what formulas expect)
                    balances[account][period_name] = cumulative
                    
                    # Cache cumulative for formula lookups
                    cache_key = f"{account}:{period_name}:{filters_hash}"
                    balance_cache[cache_key] = cumulative
                    cached_count += 1
                    cumulative_count += 1
            
            print(f"📊 Computed {cumulative_count} cumulative BS balances (prior year + activity)", flush=True)
            print(f"⚡ Method: 1 query for prior year balance + activity from optimized query", flush=True)
            
        except Exception as bs_error:
            print(f"⚠️  BS query error (P&L still succeeded): {bs_error}", flush=True)
            import traceback
            traceback.print_exc()
            # Don't fail the whole request - P&L data is still valid
        
        total_elapsed = elapsed + bs_elapsed if 'bs_elapsed' in dir() else elapsed
        print(f"💾 Total cached: {cached_count} values (P&L + BS)")
        print(f"📊 Total accounts: {len(balances)} (P&L + BS)")
        print(f"⏱️  Total time: {total_elapsed:.2f} seconds")
        
        # Fetch account names in ONE query to avoid 429 concurrency errors
        # This prevents 35+ parallel requests when Guide Me writes formulas
        account_names = {}
        try:
            account_numbers = list(balances.keys())
            if account_numbers:
                # Batch query for account names - IN clause with all account numbers
                account_list = "', '".join([escape_sql(str(a)) for a in account_numbers])
                names_query = f"""
                    SELECT acctnumber AS number, accountsearchdisplaynamecopy AS name
                    FROM Account
                    WHERE acctnumber IN ('{account_list}')
                """
                names_result = query_netsuite(names_query)
                if isinstance(names_result, list):
                    for row in names_result:
                        account_names[str(row.get('number', ''))] = row.get('name', '')
                print(f"📛 Fetched {len(account_names)} account names in ONE query")
        except Exception as names_error:
            print(f"⚠️  Account names fetch error (non-fatal): {names_error}")
        
        print(f"{'='*80}\n")
        
        return jsonify({
            'balances': balances,
            'account_types': account_types,  # { account_number: "Income" | "Expense" | etc. }
            'account_names': account_names,  # { account_number: "Account Name" }
            'query_time': total_elapsed, 
            'cached_count': cached_count,
            'pl_time': elapsed,
            'bs_time': bs_elapsed if 'bs_elapsed' in dir() else 0
        })
    
    except requests.exceptions.Timeout:
        print("❌ Query timeout (> 5 minutes)")
        return jsonify({'error': 'Query timeout - this should not happen with optimized query!'}), 504
    
    except Exception as e:
        print(f"❌ Error in full_year_refresh: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/batch/periods_refresh', methods=['POST'])
def batch_periods_refresh():
    """
    TRULY OPTIMIZED: Pre-load data for ONLY the specific periods requested.
    
    Unlike full_year_refresh which loads 12 months per year, this queries
    ONLY the exact periods needed - much faster for partial year requests.
    
    Example: 4 periods (Dec 2024, Jan-Mar 2025) = ~45-60s instead of ~220s
    
    POST JSON:
    {
        "periods": ["Dec 2024", "Jan 2025", "Feb 2025", "Mar 2025"],
        "subsidiary": "",
        "department": "",
        "location": "",
        "class": ""
    }
    """
    data = request.get_json() or {}
    periods = data.get('periods', [])
    
    # Multi-Book Accounting support - default to Primary Book (ID 1)
    accountingbook = data.get('accountingbook', DEFAULT_ACCOUNTING_BOOK)
    if isinstance(accountingbook, str) and accountingbook.strip():
        try:
            accountingbook = int(accountingbook)
        except ValueError:
            accountingbook = DEFAULT_ACCOUNTING_BOOK
    elif not accountingbook:
        accountingbook = DEFAULT_ACCOUNTING_BOOK
    
    if not periods:
        return jsonify({'error': 'No periods specified'}), 400
    
    print(f"\n{'='*80}")
    print(f"⚡ PERIODS REFRESH (OPTIMIZED): {len(periods)} specific periods ONLY")
    print(f"   Periods: {periods}")
    print(f"   Accounting Book: {accountingbook}")
    print(f"{'='*80}")
    
    start_time = datetime.now()
    
    # Parse periods to get structured data
    month_order = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    parsed_periods = []  # [(year, month_idx, period_name), ...]
    
    for period in periods:
        parts = period.split()
        if len(parts) == 2:
            try:
                month_abbrev = parts[0][:3]
                year = int(parts[1])
                month_idx = month_order.index(month_abbrev) if month_abbrev in month_order else -1
                if month_idx >= 0:
                    parsed_periods.append((year, month_idx, period))
            except (ValueError, IndexError):
                pass
    
    if not parsed_periods:
        return jsonify({'error': 'Could not parse periods'}), 400
    
    # Sort periods chronologically
    parsed_periods.sort(key=lambda x: (x[0], x[1]))
    
    # Get date range
    earliest = parsed_periods[0]  # (year, month_idx, name)
    latest = parsed_periods[-1]
    
    # Calculate date bounds for queries
    # Start date: 1st of earliest month
    start_date = f"{earliest[0]}-{earliest[1]+1:02d}-01"
    # End date: last day of latest month
    latest_month = latest[1] + 1
    latest_year = latest[0]
    if latest_month == 12:
        end_date = f"{latest_year}-12-31"
    else:
        # Use first day of next month minus 1
        end_date = f"{latest_year}-{latest_month+1:02d}-01"
    
    requested_periods_set = set(periods)
    
    print(f"📅 Date range: {start_date} to end of {month_order[latest[1]]} {latest[0]}")
    print(f"📅 Only loading {len(parsed_periods)} periods (not full years!)")
    
    # Get filter parameters - check for "(Consolidated)" before converting
    raw_subsidiary = data.get('subsidiary', '')
    
    subsidiary = convert_name_to_id('subsidiary', raw_subsidiary)
    department = convert_name_to_id('department', data.get('department', ''))
    location = convert_name_to_id('location', data.get('location', ''))
    class_id = convert_name_to_id('class', data.get('class', ''))
    
    # Determine consolidated status (explicit OR auto from root)
    wants_consolidated = should_use_consolidated(raw_subsidiary, subsidiary)
    
    filters = {
        'subsidiary': subsidiary,
        'department': department,
        'location': location,
        'class': class_id
    }
    # IMPORTANT: Use same format as batch_balance for cache key compatibility
    filters_hash = f"{subsidiary}:{department}:{location}:{class_id}"
    
    # Build filter clauses
    # CRITICAL: Use tl.subsidiary for GL line-level filtering (intercompany JEs have header on different sub)
    filter_clauses = []
    needs_line_join = False
    
    if subsidiary:
        use_hierarchy = wants_consolidated
        
        if use_hierarchy:
            hierarchy_subs = get_subsidiaries_in_hierarchy(subsidiary)
            sub_filter = ', '.join(hierarchy_subs)
            filter_clauses.append(f"tl.subsidiary IN ({sub_filter})")
            print(f"   Consolidated: {len(hierarchy_subs)} subsidiaries in hierarchy")
        else:
            filter_clauses.append(f"tl.subsidiary = {subsidiary}")
            print(f"   Single subsidiary: {subsidiary}")
        needs_line_join = True
    if department:
        filter_clauses.append(f"tl.department = {department}")
        needs_line_join = True
    if location:
        filter_clauses.append(f"tl.location = {location}")
        needs_line_join = True
    if class_id:
        filter_clauses.append(f"tl.class = {class_id}")
        needs_line_join = True
    filter_sql = (" AND " + " AND ".join(filter_clauses)) if filter_clauses else ""
    line_join = "JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id" if needs_line_join else ""
    
    target_sub = subsidiary if subsidiary else (default_subsidiary_id or '1')
    
    balances = {}
    account_types = {}
    account_names = {}
    cached_count = 0
    
    try:
        # ========================================
        # STEP 1: P&L - Query ONLY the specific periods
        # ========================================
        print(f"\n📊 Step 1: P&L accounts (ONLY {len(parsed_periods)} periods)")
        
        # Build period names for IN clause
        period_names_sql = "', '".join([escape_sql(p[2]) for p in parsed_periods])
        
        use_hierarchy = wants_consolidated
        
        # Sign multiplier: flip Income/OthIncome from credits (negative) to positive display
        sign_sql = f"* CASE WHEN a.accttype IN ({INCOME_TYPES_SQL}) THEN -1 ELSE 1 END"
        
        # Always use BUILTIN.CONSOLIDATE - works for both OneWorld and non-OneWorld
        pl_query = f"""
        WITH base AS (
          SELECT
            tal.account AS account_id,
            t.postingperiod AS period_id,
                TO_NUMBER(
                  BUILTIN.CONSOLIDATE(
                    tal.amount,
                    'LEDGER',
                    'DEFAULT',
                    'DEFAULT',
                    {target_sub},
                    t.postingperiod,
                    'DEFAULT'
                  )
                )
            {sign_sql}
            AS cons_amt
          FROM TransactionAccountingLine tal
          JOIN Transaction t ON t.id = tal.transaction
          {line_join}
          JOIN Account a ON a.id = tal.account
          JOIN AccountingPeriod ap ON ap.id = t.postingperiod
          WHERE t.posting = 'T'
            AND tal.posting = 'T'
            AND tal.accountingbook = {accountingbook}
            AND ap.isyear = 'F'
            AND ap.isquarter = 'F'
            AND ap.periodname IN ('{period_names_sql}')
            AND a.accttype IN ({PL_TYPES_SQL})
            {filter_sql}
        )
        SELECT
          a.acctnumber AS account_number,
          a.accttype AS account_type,
          ap.periodname AS period_name,
          SUM(b.cons_amt) AS amount
        FROM base b
        JOIN AccountingPeriod ap ON ap.id = b.period_id
        JOIN Account a ON a.id = b.account_id
        GROUP BY a.acctnumber, a.accttype, ap.periodname
        ORDER BY a.acctnumber, ap.periodname
        """
        
        pl_start = datetime.now()
        pl_result = run_paginated_suiteql(pl_query, page_size=1000, max_pages=20, timeout=120)
        pl_elapsed = (datetime.now() - pl_start).total_seconds()
        print(f"⏱️  P&L query: {pl_elapsed:.1f}s ({len(pl_result)} rows)")
        
        # Process P&L results - period_name is already in correct format
        for row in pl_result:
            account = str(row.get('account_number', ''))
            acct_type = row.get('account_type', '')
            period_name = row.get('period_name', '')  # Already "Jan 2025" format
            amount = float(row.get('amount', 0) or 0)
            
            
            if not period_name or period_name not in requested_periods_set:
                continue
            
            if account not in balances:
                balances[account] = {}
            if account not in account_types:
                account_types[account] = acct_type
            
            if period_name not in balances[account]:
                balances[account][period_name] = 0
            balances[account][period_name] += amount
            
            # Cache
            cache_key = f"{account}:{period_name}:{filters_hash}"
            balance_cache[cache_key] = balances[account][period_name]
            cached_count += 1
        
        # ========================================
        # STEP 2: BS - Query ONLY from earliest period through latest
        # ========================================
        print(f"\n📊 Step 2: BS accounts (activity from {earliest[2]} through {latest[2]})")
        
        # For BS we need to get prior balance, then activity from earliest to latest
        # Prior balance = cumulative through end of month BEFORE earliest requested
        
        # Calculate prior month end date
        earliest_year = earliest[0]
        earliest_month = earliest[1]  # 0-indexed
        
        if earliest_month == 0:
            # January - prior is previous December
            prior_year = earliest_year - 1
            prior_end_date = f"{prior_year}-12-31"
        else:
            # Prior month is same year
            prior_end_date = f"{earliest_year}-{earliest_month:02d}-01"  # 1st of current month = end of prior
        
        # Query BS activity for the period range
        # Always use BUILTIN.CONSOLIDATE - works for both OneWorld and non-OneWorld
        bs_query = f"""
        WITH base AS (
          SELECT
            tal.account AS account_id,
            t.postingperiod AS period_id,
                TO_NUMBER(
                  BUILTIN.CONSOLIDATE(
                    tal.amount,
                    'LEDGER',
                    'DEFAULT',
                    'DEFAULT',
                    {target_sub},
                    t.postingperiod,
                    'DEFAULT'
                  )
            ) AS cons_amt
          FROM TransactionAccountingLine tal
          JOIN Transaction t ON t.id = tal.transaction
          JOIN Account a ON a.id = tal.account
          JOIN AccountingPeriod ap ON ap.id = t.postingperiod
          WHERE t.posting = 'T'
            AND tal.posting = 'T'
            AND tal.accountingbook = {accountingbook}
            AND ap.isyear = 'F'
            AND ap.isquarter = 'F'
            AND a.accttype NOT IN ({PL_TYPES_SQL})
            AND ap.startdate >= TO_DATE('{start_date}', 'YYYY-MM-DD')
            AND ap.enddate <= TO_DATE('{end_date}', 'YYYY-MM-DD')
            {filter_sql}
        )
        SELECT
          a.acctnumber AS account_number,
          a.accttype AS account_type,
          ap.periodname AS period_name,
          ap.startdate AS startdate,
          SUM(b.cons_amt) AS amount
        FROM base b
        JOIN AccountingPeriod ap ON ap.id = b.period_id
        JOIN Account a ON a.id = b.account_id
        GROUP BY a.acctnumber, a.accttype, ap.periodname, ap.startdate
        ORDER BY a.acctnumber, ap.startdate
        """
        
        bs_start = datetime.now()
        bs_result = run_paginated_suiteql(bs_query, page_size=1000, max_pages=20, timeout=120)
        bs_elapsed = (datetime.now() - bs_start).total_seconds()
        print(f"⏱️  BS activity query: {bs_elapsed:.1f}s ({len(bs_result)} rows)")
        
        # Organize BS activity by account
        bs_activity = {}
        for row in bs_result:
            account = str(row.get('account_number', ''))
            acct_type = row.get('account_type', '')
            period_name = row.get('period_name', '')  # Already "Jan 2025" format
            amount = float(row.get('amount', 0) or 0)
            
            if not period_name:
                continue
            
            if account not in bs_activity:
                bs_activity[account] = {}
            if account not in account_types:
                account_types[account] = acct_type
            
            if period_name not in bs_activity[account]:
                bs_activity[account][period_name] = 0
            bs_activity[account][period_name] += amount
        
        # Get prior period balance for BS accounts (everything before earliest period)
        prior_balances = {}
        
        if bs_activity:
            print(f"\n📊 Step 3: BS prior balances (through end of period before {start_date})")
            
            # Get list of BS accounts - batch if too many to avoid query size limits
            bs_accounts = list(bs_activity.keys())
            
            prior_start = datetime.now()
            
            # Batch accounts in groups of 50 to avoid query size limits
            batch_size = 50
            for i in range(0, len(bs_accounts), batch_size):
                batch = bs_accounts[i:i+batch_size]
                bs_account_list = "', '".join([escape_sql(str(a)) for a in batch])
                
                # Always use BUILTIN.CONSOLIDATE - works for both OneWorld and non-OneWorld
                prior_query = f"""
                SELECT 
                    a.acctnumber AS acctnumber,
                    SUM(
                                TO_NUMBER(
                                    BUILTIN.CONSOLIDATE(
                                        tal.amount,
                                        'LEDGER',
                                        'DEFAULT',
                                        'DEFAULT',
                                        {target_sub},
                                        t.postingperiod,
                                        'DEFAULT'
                                    )
                                )
                    ) AS balance
                FROM TransactionAccountingLine tal
                JOIN Transaction t ON t.id = tal.transaction
                JOIN Account a ON a.id = tal.account
                JOIN AccountingPeriod ap ON ap.id = t.postingperiod
                WHERE t.posting = 'T' 
                    AND tal.posting = 'T' 
                    AND tal.accountingbook = {accountingbook}
                    AND ap.isyear = 'F' 
                    AND ap.isquarter = 'F'
                    AND ap.enddate < TO_DATE('{start_date}', 'YYYY-MM-DD')
                    AND a.acctnumber IN ('{bs_account_list}')
                    {filter_sql}
                GROUP BY a.acctnumber
                """
                
                try:
                    batch_result = query_netsuite(prior_query, timeout=120)
                    
                    if isinstance(batch_result, list):
                        for row in batch_result:
                            acc = str(row.get('acctnumber', ''))
                            bal = float(row.get('balance', 0) or 0)
                            if abs(bal) < 0.01:
                                bal = 0
                            prior_balances[acc] = bal
                    elif isinstance(batch_result, dict) and 'error' in batch_result:
                        print(f"⚠️  Prior balance query batch {i//batch_size + 1} error: {batch_result.get('error', 'unknown')}", file=sys.stderr)
                except Exception as e:
                    print(f"⚠️  Prior balance query batch {i//batch_size + 1} exception: {str(e)}", file=sys.stderr)
            
            prior_elapsed = (datetime.now() - prior_start).total_seconds()
            print(f"⏱️  BS prior query: {prior_elapsed:.1f}s ({len(prior_balances)} accounts with prior balances)")
        
        # Compute cumulative for BS accounts, walking through periods in order
        print(f"\n📊 Step 4: Computing BS cumulative balances")
        
        for account, activity_by_period in bs_activity.items():
            if account not in balances:
                balances[account] = {}
            
            cumulative = prior_balances.get(account, 0)
            
            # Walk through periods in chronological order
            for period_tuple in parsed_periods:
                period_name = period_tuple[2]
                activity = activity_by_period.get(period_name, 0)
                cumulative += activity
                
                # Round to avoid floating point errors
                cumulative = round(cumulative, 2)
                if abs(cumulative) < 0.01:
                    cumulative = 0
                
                balances[account][period_name] = cumulative
                cache_key = f"{account}:{period_name}:{filters_hash}"
                balance_cache[cache_key] = cumulative
                cached_count += 1
        
        # ========================================
        # STEP 5: Fetch account names
        # ========================================
        all_accounts = list(balances.keys())
        if all_accounts:
            account_list = "', '".join([escape_sql(str(a)) for a in all_accounts])
            names_query = f"""
                SELECT acctnumber AS number, accountsearchdisplaynamecopy AS name
                FROM Account WHERE acctnumber IN ('{account_list}')
            """
            names_result = query_netsuite(names_query)
            if isinstance(names_result, list):
                for row in names_result:
                    account_names[str(row.get('number', ''))] = row.get('name', '')
        
        total_elapsed = (datetime.now() - start_time).total_seconds()
        print(f"\n✅ PERIODS REFRESH COMPLETE")
        print(f"   Accounts: {len(balances)}")
        print(f"   Periods loaded: {len(periods)}")
        print(f"   Cache entries: {cached_count}")
        print(f"   Total time: {total_elapsed:.2f} seconds")
        print(f"{'='*80}\n")
        
        return jsonify({
            'balances': balances,
            'account_types': account_types,
            'account_names': account_names,
            'query_time': total_elapsed,
            'cached_count': cached_count,
            'periods_loaded': periods
        })
        
    except Exception as e:
        print(f"❌ Error in periods_refresh: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/batch/full_year_refresh_bs', methods=['POST'])
def batch_full_year_refresh_bs():
    """
    BALANCE SHEET ONLY full-year refresh.
    
    CORRECTED APPROACH: Uses fixed target period for CONSOLIDATE.
    This matches NetSuite's GL Balance report exactly:
    - ALL historical transactions are consolidated using TARGET period's exchange rate
    - NOT each transaction's own posting period rate
    
    POST JSON:
    {
        "year": 2025,
        "subsidiary": "",
        ...
    }
    
    Returns same structure as full_year_refresh but only BS accounts.
    """
    data = request.get_json() or {}
    
    fiscal_year = data.get('year')
    if not fiscal_year:
        periods = data.get('periods', [])
        if periods:
            fiscal_year = extract_year_from_period(periods[0])
        else:
            fiscal_year = datetime.now().year
    
    # Get subsidiary and convert to ID
    raw_subsidiary = data.get('subsidiary', '')
    subsidiary = convert_name_to_id('subsidiary', raw_subsidiary)
    class_id = convert_name_to_id('class', data.get('class', ''))
    department = convert_name_to_id('department', data.get('department', ''))
    location = convert_name_to_id('location', data.get('location', ''))
    
    # Determine consolidated status (explicit OR auto from root)
    wants_consolidated = should_use_consolidated(raw_subsidiary, subsidiary)
    
    # Multi-Book Accounting support - default to Primary Book (ID 1)
    accountingbook = data.get('accountingbook', DEFAULT_ACCOUNTING_BOOK)
    if isinstance(accountingbook, str) and accountingbook.strip():
        try:
            accountingbook = int(accountingbook)
        except ValueError:
            accountingbook = DEFAULT_ACCOUNTING_BOOK
    elif not accountingbook:
        accountingbook = DEFAULT_ACCOUNTING_BOOK
    
    target_sub = subsidiary if subsidiary else (default_subsidiary_id or '1')
    
    filters = {}
    if subsidiary:
        filters['subsidiary'] = subsidiary
        # ONLY use hierarchy when "(Consolidated)" is explicitly requested
        # Per NetSuite behavior: "Celigo Inc." = just that subsidiary
        #                        "Celigo Inc. (Consolidated)" = includes children
        filters['use_hierarchy'] = wants_consolidated
    if class_id: filters['class'] = class_id
    if department: filters['department'] = department
    if location: filters['location'] = location
    
    print(f"🔍 BS FULL YEAR REFRESH: raw_subsidiary='{raw_subsidiary}', wants_consolidated={wants_consolidated}", file=sys.stderr)
    
    try:
        print(f"\n{'='*80}", flush=True)
        print(f"📊 BALANCE SHEET FULL YEAR REFRESH (CORRECTED): {fiscal_year}", flush=True)
        print(f"   Target subsidiary: {target_sub}", flush=True)
        print(f"   Filters: {filters}", flush=True)
        print(f"   Accounting Book: {accountingbook}", flush=True)
        print(f"   Using FIXED target period for CONSOLIDATE (matches NetSuite GL Balance)", flush=True)
        print(f"{'='*80}\n", flush=True)
        
        start_time = datetime.now()
        global balance_cache, balance_cache_timestamp
        filters_hash = f"{subsidiary}:{department}:{location}:{class_id}"
        
        months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
        
        balances = {}  # { account: { "Jan 2025": amount, ... } }
        cached_count = 0
        
        # Process each month with a cumulative query using FIXED target period
        for month_name in months:
            period_name = f"{month_name} {fiscal_year}"
            
            print(f"   📥 Querying {period_name}...", flush=True)
            
            # Build the corrected query with CROSS JOIN for target period
            query = build_bs_cumulative_balance_query(period_name, target_sub, filters, accountingbook)
            
            try:
                # Run the query
                items = run_paginated_suiteql(query, page_size=1000, max_pages=20, timeout=120)
                
                if isinstance(items, list):
                    for row in items:
                        account = row.get('account_number')
                        balance = float(row.get('balance') or 0)
                        
                        if not account:
                            continue
                        
                        if account not in balances:
                            balances[account] = {}
                        balances[account][period_name] = balance
                        
                        # Cache
                        cache_key = f"{account}:{period_name}:{filters_hash}"
                        balance_cache[cache_key] = balance
                        cached_count += 1
                    
                    print(f"      ✅ {period_name}: {len(items)} accounts", flush=True)
                else:
                    print(f"      ⚠️ {period_name}: No data or error", flush=True)
                    
            except Exception as e:
                print(f"      ❌ {period_name} error: {e}", flush=True)
                # Continue with other months even if one fails
        
        elapsed = (datetime.now() - start_time).total_seconds()
        balance_cache_timestamp = datetime.now()
        
        print(f"\n⏱️  Total query time: {elapsed:.2f} seconds", flush=True)
        print(f"📊 Returning {len(balances)} BS accounts")
        print(f"💾 Cached {cached_count} BS values")
        print(f"{'='*80}\n")
        
        return jsonify({'balances': balances, 'query_time': elapsed, 'cached_count': cached_count})
        
    except Exception as e:
        print(f"❌ Error in full_year_refresh_bs: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/batch/bs_periods', methods=['POST'])
def batch_bs_periods():
    """
    EFFICIENT Balance Sheet endpoint - gets ALL requested periods in ONE query!
    
    Instead of running N separate queries for N periods (~70 sec each),
    this runs 1 query with CASE statements (~36 sec total).
    
    POST JSON:
    {
        "periods": ["Dec 2024", "Jan 2025", "Feb 2025", "Mar 2025"],
        "subsidiary": "",
        "department": "",
        "location": "",
        "class": ""
    }
    
    Returns:
    {
        "balances": {
            "10010": {
                "Dec 2024": 1189252.33,
                "Jan 2025": 2064705.84,
                "Feb 2025": 381646.48,
                "Mar 2025": 1021294.93
            },
            ...
        },
        "query_time": 36.2
    }
    """
    data = request.get_json() or {}
    
    periods = data.get('periods', [])
    if not periods:
        return jsonify({'error': 'periods list required'}), 400
    
    # Get subsidiary and convert to ID
    raw_subsidiary = data.get('subsidiary', '')
    subsidiary = convert_name_to_id('subsidiary', raw_subsidiary)
    class_id = convert_name_to_id('class', data.get('class', ''))
    department = convert_name_to_id('department', data.get('department', ''))
    location = convert_name_to_id('location', data.get('location', ''))
    
    # Determine consolidated status (explicit OR auto from root)
    wants_consolidated = should_use_consolidated(raw_subsidiary, subsidiary)
    
    # Multi-Book Accounting support - default to Primary Book (ID 1)
    accountingbook = data.get('accountingbook', DEFAULT_ACCOUNTING_BOOK)
    if isinstance(accountingbook, str) and accountingbook.strip():
        try:
            accountingbook = int(accountingbook)
        except ValueError:
            accountingbook = DEFAULT_ACCOUNTING_BOOK
    elif not accountingbook:
        accountingbook = DEFAULT_ACCOUNTING_BOOK
    
    target_sub = subsidiary if subsidiary else (default_subsidiary_id or '1')
    
    filters = {}
    if subsidiary:
        filters['subsidiary'] = subsidiary
        # ONLY use hierarchy when "(Consolidated)" is explicitly requested
        # Per NetSuite behavior: "Celigo Inc." = just that subsidiary
        #                        "Celigo Inc. (Consolidated)" = includes children
        filters['use_hierarchy'] = wants_consolidated
    if class_id: filters['class'] = class_id
    if department: filters['department'] = department
    if location: filters['location'] = location
    
    print(f"🔍 BS PERIODS: raw_subsidiary='{raw_subsidiary}', wants_consolidated={wants_consolidated}", file=sys.stderr)
    
    try:
        print(f"\n{'='*80}", flush=True)
        print(f"📊 EFFICIENT BS MULTI-PERIOD QUERY", flush=True)
        print(f"   Periods ({len(periods)}): {', '.join(periods)}", flush=True)
        print(f"   Target subsidiary: {target_sub}", flush=True)
        print(f"   Filters: {filters}", flush=True)
        print(f"   Accounting Book: {accountingbook}", flush=True)
        print(f"   ONE query for ALL periods (much faster!)", flush=True)
        print(f"{'='*80}\n", flush=True)
        
        start_time = datetime.now()
        global balance_cache, balance_cache_timestamp
        filters_hash = f"{subsidiary}:{department}:{location}:{class_id}"
        
        # Build the efficient multi-period query
        query = build_bs_multi_period_query(periods, target_sub, filters, accountingbook)
        
        if not query:
            return jsonify({'error': 'Could not build query for provided periods'}), 400
        
        print(f"   📥 Running multi-period query...", flush=True)
        print(f"   Query (first 500 chars):\n{query[:500]}...", flush=True)
        
        # Run the query with pagination support
        items = run_paginated_suiteql(query, page_size=1000, max_pages=20, timeout=180)
        
        elapsed = (datetime.now() - start_time).total_seconds()
        print(f"   ⏱️ Query completed in {elapsed:.1f} seconds", flush=True)
        print(f"   ✅ Got {len(items)} accounts", flush=True)
        
        # Parse results
        # Column names are like bal_2024_12, bal_2025_01, etc.
        # Need to map back to "Dec 2024", "Jan 2025", etc.
        month_names = {
            '01': 'Jan', '02': 'Feb', '03': 'Mar', '04': 'Apr',
            '05': 'May', '06': 'Jun', '07': 'Jul', '08': 'Aug',
            '09': 'Sep', '10': 'Oct', '11': 'Nov', '12': 'Dec'
        }
        
        balances = {}
        cached_count = 0
        
        for row in items:
            account = row.get('account_number')
            if not account:
                continue
            
            # Collect all balances for this account
            account_balances = {}
            has_non_zero = False
            
            # Process each period column
            for key, value in row.items():
                if key.startswith('bal_'):
                    # Parse bal_2024_12 -> "Dec 2024"
                    parts = key.split('_')
                    if len(parts) == 3:
                        year = parts[1]
                        month_num = parts[2]
                        month_name = month_names.get(month_num)
                        if month_name:
                            period_name = f"{month_name} {year}"
                            balance = float(value) if value else 0
                            account_balances[period_name] = balance
                            if abs(balance) >= 0.01:  # Non-zero check
                                has_non_zero = True
            
            # Only include accounts with at least one non-zero balance
            if has_non_zero:
                balances[account] = account_balances
                
                # Cache all periods for this account
                for period_name, balance in account_balances.items():
                    cache_key = f"{account}:{period_name}:{filters_hash}"
                    balance_cache[cache_key] = balance
                    cached_count += 1
        
        balance_cache_timestamp = datetime.now()
        
        print(f"\n⏱️  Total time: {elapsed:.2f} seconds", flush=True)
        print(f"📊 Returning {len(balances)} BS accounts × {len(periods)} periods")
        print(f"💾 Cached {cached_count} BS values")
        print(f"{'='*80}\n")
        
        return jsonify({
            'balances': balances, 
            'query_time': elapsed, 
            'cached_count': cached_count,
            'periods': periods
        })
        
    except Exception as e:
        print(f"❌ Error in batch_bs_periods: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/batch/balance/year', methods=['POST'])
def batch_balance_year():
    """
    OPTIMIZED YEAR ENDPOINT - Get annual P&L totals using NetSuite's year periods
    
    This is faster than querying 12 months because NetSuite pre-calculates year totals.
    
    POST JSON:
    {
        "accounts": ["60010", "60020", "60030"],
        "year": 2025,
        "subsidiary": "",
        "accountingbook": ""
    }
    
    Returns:
    {
        "balances": {
            "60010": {"FY 2025": 43983641.42},
            "60020": {"FY 2025": 1234567.89}
        }
    }
    """
    data = request.get_json()
    
    if not data or 'accounts' not in data or 'year' not in data:
        return jsonify({'error': 'accounts and year required'}), 400
    
    accounts = data.get('accounts', [])
    year = data.get('year')
    raw_subsidiary = data.get('subsidiary', '')
    accountingbook = data.get('accountingbook', DEFAULT_ACCOUNTING_BOOK)
    
    # Convert subsidiary name to ID if needed
    subsidiary = convert_name_to_id('subsidiary', raw_subsidiary)
    
    # Determine consolidated status (explicit OR auto from root)
    wants_consolidated = should_use_consolidated(raw_subsidiary, subsidiary)
    
    # Handle accountingbook
    if isinstance(accountingbook, str) and accountingbook.strip():
        try:
            accountingbook = int(accountingbook)
        except ValueError:
            accountingbook = DEFAULT_ACCOUNTING_BOOK
    elif not accountingbook:
        accountingbook = DEFAULT_ACCOUNTING_BOOK
    
    # Determine if we should use hierarchy (include children)
    # CRITICAL: Use tl.subsidiary for GL line-level filtering
    use_hierarchy = False
    sub_filter_clause = ""
    needs_line_join = False
    if subsidiary:
        use_hierarchy = wants_consolidated
        if use_hierarchy:
            hierarchy_subs = get_subsidiaries_in_hierarchy(subsidiary)
            sub_filter_clause = f"AND tl.subsidiary IN ({', '.join(hierarchy_subs)})"
        else:
            sub_filter_clause = f"AND tl.subsidiary = {subsidiary}"
        needs_line_join = True
    
    line_join = "JOIN transactionline tl ON t.id = tl.transaction AND tal.transactionline = tl.id" if needs_line_join else ""
    
    print(f"\n{'='*80}")
    print(f"🗓️  YEAR PERIOD QUERY: {year}")
    print(f"   Accounts: {len(accounts)}")
    print(f"   Raw Subsidiary: '{raw_subsidiary}'")
    print(f"   Subsidiary ID: {subsidiary or 'consolidated'}")
    print(f"   wants_consolidated: {wants_consolidated}, use_hierarchy: {use_hierarchy}")
    print(f"   Accounting Book: {accountingbook}")
    print(f"{'='*80}\n")
    
    # Determine target subsidiary for CONSOLIDATE
    if subsidiary:
        target_sub = int(subsidiary)
    else:
        target_sub = 1  # Parent/consolidated
    
    # Build account filter
    account_filter = ", ".join([f"'{escape_sql(str(a))}'" for a in accounts])
    
    # Sign multiplier: flip Income/OthIncome from credits (negative) to positive display
    sign_sql = f"* CASE WHEN a.accttype IN ({INCOME_TYPES_SQL}) THEN -1 ELSE 1 END"
    
    # Query all 12 monthly periods for the year and SUM to get annual total
    # (Year periods don't have transactions posted to them - only monthly periods do)
    # This is more efficient than 12 separate queries because we GROUP BY account only
    query = f"""
        SELECT 
            a.acctnumber,
            SUM(
                TO_NUMBER(
                    BUILTIN.CONSOLIDATE(
                        tal.amount,
                        'LEDGER',
                        'DEFAULT',
                        'DEFAULT',
                        {target_sub},
                        t.postingperiod,
                        'DEFAULT'
                    )
                )
                {sign_sql}
            ) AS balance
        FROM transactionaccountingline tal
        JOIN transaction t ON t.id = tal.transaction
        {line_join}
        JOIN account a ON tal.account = a.id
        JOIN accountingperiod ap ON t.postingperiod = ap.id
        WHERE a.acctnumber IN ({account_filter})
          AND tal.posting = 'T'
          AND tal.accountingbook = {accountingbook}
          AND ap.isyear = 'F'
          AND ap.isquarter = 'F'
          AND EXTRACT(YEAR FROM ap.startdate) = {year}
          {sub_filter_clause}
        GROUP BY a.acctnumber
    """
    
    try:
        result = query_netsuite(query)
        
        if isinstance(result, dict) and 'error' in result:
            print(f"❌ Year query error: {result}")
            return jsonify({'error': result.get('details', 'Query failed')}), 500
        
        # Build response - annual total per account
        balances = {}
        period_name = f"FY {year}"
        
        for row in result:
            acct = row.get('acctnumber', '')
            balance = float(row.get('balance', 0) or 0)
            balances[acct] = {period_name: balance}
        
        # Fill in zeros for accounts not returned
        for acct in accounts:
            acct_str = str(acct)
            if acct_str not in balances:
                balances[acct_str] = {period_name: 0}
        
        print(f"✅ Year query: {len(result)} accounts with data, {len(accounts) - len(result)} zeros")
        
        return jsonify({
            'balances': balances,
            'year': year,
            'period': period_name
        })
        
    except Exception as e:
        print(f"❌ Year query exception: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/batch/balance', methods=['POST'])
def batch_balance():
    """
    BATCH ENDPOINT - Get balances for MULTIPLE accounts and periods in ONE call
    This is much faster than individual requests!
    
    POST JSON:
    {
        "accounts": ["4010", "5000", "6000"],
        "periods": ["Jan 2025", "Feb 2025", "Mar 2025"],
        "subsidiary": "",
        "class": "",
        "department": "13",
        "location": ""
    }
    
    Returns:
    {
        "balances": {
            "4010": {
                "Jan 2025": 12400000,
                "Feb 2025": 13200000
            },
            "5000": {
                "Jan 2025": 5000000,
                "Feb 2025": 5200000
            }
        }
    }
    """
    data = request.get_json()
    
    if not data or 'accounts' not in data or 'periods' not in data:
        return jsonify({'error': 'accounts and periods required'}), 400
    
    accounts = data.get('accounts', [])
    periods = data.get('periods', [])
    raw_subsidiary = data.get('subsidiary', '')
    class_id = data.get('class', '')
    department = data.get('department', '')
    location = data.get('location', '')
    
    # Multi-Book Accounting support - default to Primary Book (ID 1)
    accountingbook = data.get('accountingbook', DEFAULT_ACCOUNTING_BOOK)
    if isinstance(accountingbook, str) and accountingbook.strip():
        try:
            accountingbook = int(accountingbook)
        except ValueError:
            accountingbook = DEFAULT_ACCOUNTING_BOOK
    elif not accountingbook:
        accountingbook = DEFAULT_ACCOUNTING_BOOK
    
    # Convert names to IDs (accepts names OR IDs)
    subsidiary = convert_name_to_id('subsidiary', raw_subsidiary)
    class_id = convert_name_to_id('class', class_id)
    department = convert_name_to_id('department', department)
    location = convert_name_to_id('location', location)
    
    # Determine consolidated status (explicit OR auto from root)
    wants_consolidated = should_use_consolidated(raw_subsidiary, subsidiary)
    
    # DEBUG: Log consolidated detection
    if raw_subsidiary:
        print(f"🔍 CONSOLIDATED DEBUG: raw_subsidiary='{raw_subsidiary}'", file=sys.stderr)
        print(f"   wants_consolidated={wants_consolidated}", file=sys.stderr)
    
    if not accounts or not periods:
        return jsonify({'error': 'accounts and periods must be non-empty'}), 400
    
    # Check if we can serve this request from the backend balance cache
    # (populated by full year refresh)
    global balance_cache, balance_cache_timestamp
    
    if balance_cache and balance_cache_timestamp:
        from datetime import timedelta
        cache_age = (datetime.now() - balance_cache_timestamp).total_seconds()
        
        if cache_age < BALANCE_CACHE_TTL:
            # Cache is fresh! Try to serve from cache
            filters_hash = f"{subsidiary}:{department}:{location}:{class_id}"
            
            print(f"🔍 Cache lookup:")
            print(f"   subsidiary='{subsidiary}', department='{department}', location='{location}', class='{class_id}'")
            print(f"   Filters hash: '{filters_hash}' (length: {len(filters_hash)}, colons: {filters_hash.count(':')})")
            print(f"   Sample accounts: {accounts[:3]}")
            print(f"   Sample periods: {periods[:3]}")
            print(f"   Total cached keys: {len(balance_cache)}")
            print(f"   Sample cached keys: {list(balance_cache.keys())[:3]}")
            
            # Try building a sample key to compare
            if accounts and periods:
                sample_key = f"{accounts[0]}:{periods[0]}:{filters_hash}"
                print(f"   Sample lookup key: '{sample_key}' (length: {len(sample_key)}, colons: {sample_key.count(':')})")
                print(f"   Key exists in cache: {sample_key in balance_cache}")
            
            # Check if ALL requested data is in cache
            all_in_cache = True
            missing_keys = []
            for account in accounts:
                for period in periods:
                    cache_key = f"{account}:{period}:{filters_hash}"
                    if cache_key not in balance_cache:
                        all_in_cache = False
                        if len(missing_keys) < 5:  # Only collect first 5 for debugging
                            missing_keys.append(cache_key)
            
            if all_in_cache:
                # Serve entirely from cache!
                print(f"⚡ BACKEND CACHE HIT: {len(accounts)} accounts × {len(periods)} periods (age: {cache_age:.1f}s)")
                
                result_balances = {}
                for account in accounts:
                    result_balances[account] = {}
                    for period in periods:
                        cache_key = f"{account}:{period}:{filters_hash}"
                        result_balances[account][period] = balance_cache.get(cache_key, 0)
                
                return jsonify({'balances': result_balances, 'from_cache': True})
            else:
                print(f"⚠️  Partial cache miss - missing keys (showing first 5):")
                for key in missing_keys:
                    print(f"     Missing: '{key}'")
        else:
            print(f"⚠️  Backend cache expired ({cache_age:.1f}s old) - falling back to full query")
    
    try:
        print(f"\n{'='*60}", file=sys.stderr)
        print(f"BATCH BALANCE REQUEST", file=sys.stderr)
        print(f"  Accounts ({len(accounts)}): {accounts[:5]}{'...' if len(accounts) > 5 else ''}", file=sys.stderr)
        print(f"  Periods ({len(periods)}): {periods}", file=sys.stderr)
        print(f"  Subsidiary: {subsidiary}, Department: {department}, Location: {location}, Class: {class_id}", file=sys.stderr)
        print(f"{'='*60}", file=sys.stderr)
        
        # Build WHERE clause with optional filters
        where_clauses = [
            "t.posting = 'T'",
            "tal.posting = 'T'"
        ]
        
        # Add account filter (supports wildcards like '4*' for all revenue accounts)
        account_filter = build_account_filter(accounts)
        where_clauses.append(account_filter)
        
        # ========================================================================
        # SUBSIDIARY FILTERING - Critical for correct subsidiary-level reporting
        # ========================================================================
        # CRITICAL: Use tl.subsidiary (TransactionLine) NOT t.subsidiary!
        # Intercompany JEs have header on one subsidiary but lines post to different ones.
        # GL reports should filter by where the line posts, not the transaction header.
        # ========================================================================
        needs_line_join = False
        if subsidiary and subsidiary != '':
            use_hierarchy = wants_consolidated  # ONLY when "(Consolidated)" is explicitly requested
            
            print(f"🔍 HIERARCHY DEBUG: subsidiary_id={subsidiary}, wants_consolidated={wants_consolidated}, use_hierarchy={use_hierarchy}", file=sys.stderr)
            
            if use_hierarchy:
                hierarchy_subs = get_subsidiaries_in_hierarchy(subsidiary)
                sub_filter = ', '.join(hierarchy_subs)
                where_clauses.append(f"tl.subsidiary IN ({sub_filter})")
                print(f"✅ CONSOLIDATED: Including {len(hierarchy_subs)} subsidiaries: {hierarchy_subs}", file=sys.stderr)
            else:
                where_clauses.append(f"tl.subsidiary = {subsidiary}")
                print(f"📍 SINGLE: Only subsidiary {subsidiary}", file=sys.stderr)
            needs_line_join = True  # Must join TransactionLine for subsidiary filtering
        else:
            # No subsidiary specified - use default (parent) and include all subsidiaries
            hierarchy_subs = get_subsidiaries_in_hierarchy(default_subsidiary_id or '1')
            sub_filter = ', '.join(hierarchy_subs)
            where_clauses.append(f"tl.subsidiary IN ({sub_filter})")
            print(f"🌍 NO SUBSIDIARY: Using root hierarchy with {len(hierarchy_subs)} subsidiaries", file=sys.stderr)
            needs_line_join = True
        
        # Also need TransactionLine join if filtering by department, class, or location
        if (department and department != '') or (class_id and class_id != '') or (location and location != ''):
            needs_line_join = True
        
        if class_id and class_id != '':
            where_clauses.append(f"tl.class = {class_id}")
        
        if department and department != '':
            where_clauses.append(f"tl.department = {department}")
        
        if location and location != '':
            where_clauses.append(f"tl.location = {location}")
        
        # Get period enddates for Balance Sheet calculation
        # Balance Sheet accounts need cumulative balance (inception through period end)
        period_info = {}
        for period in periods:
            start, end, period_id = get_period_dates_from_name(period)
            if end and period_id:
                period_info[period] = {'enddate': end, 'id': period_id}
            else:
                # FALLBACK: Period not in NetSuite's AccountingPeriod table
                # Calculate the end date from the period name (e.g., "Jan 2025" -> 1/31/2025)
                print(f"WARNING: Period '{period}' not found in NetSuite, calculating date...", file=sys.stderr)
                calc_end = calculate_period_end_date(period)
                if calc_end:
                    # Use period_id=None - BS query will need to handle this
                    period_info[period] = {'enddate': calc_end, 'id': None}
                    print(f"   Calculated end date: {calc_end}", file=sys.stderr)
        
        # Determine target subsidiary for consolidation
        # If subsidiary filter is applied, consolidate to that subsidiary (for Consolidated view)
        # If no subsidiary, default to top-level parent (dynamically determined at startup)
        if subsidiary and subsidiary != '':
            target_sub = subsidiary
        else:
            target_sub = default_subsidiary_id or '1'
        
        # Build base WHERE clause (without period filter yet)
        base_where = " AND ".join(where_clauses)
        
        # ============================================================================
        # OPTIMIZATION: First detect account types, then ONLY query the relevant type
        # This avoids running 3 BS queries for a P&L account (or vice versa)
        # ============================================================================
        
        all_balances = {}
        
        # Step 1: Get account types for all requested accounts (single quick query)
        # NOTE: This supports wildcards - if user passed '4*', this finds all accounts starting with 4
        # NOTE: Use 'acctnumber' not 'a.acctnumber' because Account table has no alias here
        account_type_filter = build_account_filter(accounts, column='acctnumber')
        type_query = f"SELECT acctnumber, accttype FROM Account WHERE {account_type_filter}"
        type_result = query_netsuite(type_query, timeout=30)
        
        # Classify accounts into P&L vs BS
        pl_accounts = []
        bs_accounts = []
        account_types = {}  # For debugging
        
        if isinstance(type_result, list):
            for row in type_result:
                acct_num = row.get('acctnumber')
                acct_type = row.get('accttype', '')
                account_types[acct_num] = acct_type
                
                if is_balance_sheet_account(acct_type):
                    bs_accounts.append(acct_num)
                else:
                    pl_accounts.append(acct_num)
        else:
            # Fallback: assume all accounts are P&L if type query fails
            print(f"WARNING - Account type query failed, assuming all P&L", file=sys.stderr)
            pl_accounts = accounts
        
        print(f"DEBUG - Account type classification:", file=sys.stderr)
        print(f"   P&L accounts ({len(pl_accounts)}): {pl_accounts}", file=sys.stderr)
        print(f"   BS accounts ({len(bs_accounts)}): {bs_accounts}", file=sys.stderr)
        print(f"   Types: {account_types}", file=sys.stderr)
        
        # Step 2: ONLY run P&L query if there are P&L accounts
        if pl_accounts:
            # Build WHERE clause specifically for P&L accounts (exact matches only - wildcards already expanded)
            pl_account_filter = build_account_filter(pl_accounts)
            pl_where_clauses = where_clauses.copy()
            # Replace the account filter clause with just P&L accounts
            pl_where_clauses = [c for c in pl_where_clauses if 'a.acctnumber' not in c]
            pl_where_clauses.append(pl_account_filter)
            pl_base_where = " AND ".join(pl_where_clauses)
            
            # OPTIMIZATION: Split by year to avoid SuiteQL's 1000 row limit
            # Instead of pagination (slow), run separate queries per year (faster)
            expected_rows = len(pl_accounts) * len(periods)
            if expected_rows > 800:
                # Group periods by year
                periods_by_year = {}
                for p in periods:
                    # Extract year from "Mon YYYY" format
                    parts = p.split()
                    if len(parts) == 2:
                        year = parts[1]
                        if year not in periods_by_year:
                            periods_by_year[year] = []
                        periods_by_year[year].append(p)
                
                print(f"DEBUG - Splitting P&L query by year ({len(periods_by_year)} years) to avoid 1000 row limit", file=sys.stderr)
                
                # Run separate query for each year
                for year, year_periods in periods_by_year.items():
                    year_query = build_pl_query(pl_accounts, year_periods, pl_base_where, target_sub, needs_line_join, accountingbook,
                                              subsidiary_id=subsidiary, use_hierarchy=wants_consolidated)
                    
                    print(f"DEBUG - P&L Query for {year} ({len(year_periods)} periods, {len(pl_accounts)} accounts)...", file=sys.stderr)
                    
                    year_result = query_netsuite(year_query)
                    
                    if isinstance(year_result, list):
                        print(f"DEBUG - P&L {year} returned {len(year_result)} rows", file=sys.stderr)
                        for row in year_result:
                            account_num = row['acctnumber']
                            period_name = row['periodname']
                            balance = float(row['balance']) if row['balance'] else 0
                            
                            if account_num not in all_balances:
                                all_balances[account_num] = {}
                            all_balances[account_num][period_name] = balance
                    elif isinstance(year_result, dict) and 'error' in year_result:
                        print(f"ERROR - P&L {year} query failed: {year_result['error']}", file=sys.stderr)
            else:
                # Small query - run as single request
                pl_query = build_pl_query(pl_accounts, periods, pl_base_where, target_sub, needs_line_join, accountingbook,
                                          subsidiary_id=subsidiary, use_hierarchy=wants_consolidated)
                
                print(f"DEBUG - P&L Query (for {len(pl_accounts)} accounts, book={accountingbook}):\n{pl_query[:500]}...", file=sys.stderr)
                
                pl_result = query_netsuite(pl_query)
                
                if isinstance(pl_result, list):
                    print(f"DEBUG - P&L returned {len(pl_result)} rows", file=sys.stderr)
                    for row in pl_result:
                        account_num = row['acctnumber']
                        period_name = row['periodname']
                        balance = float(row['balance']) if row['balance'] else 0
                        
                        if account_num not in all_balances:
                            all_balances[account_num] = {}
                        all_balances[account_num][period_name] = balance
        else:
            print(f"DEBUG - Skipping P&L query (no P&L accounts requested)", file=sys.stderr)
        
        # Step 3: ONLY run BS queries if there are BS accounts
        if bs_accounts and period_info:
            print(f"DEBUG - Querying {len(period_info)} periods for {len(bs_accounts)} Balance Sheet accounts...", file=sys.stderr)
            
            # Build WHERE clause specifically for BS accounts (exact matches only - wildcards already expanded)
            bs_account_filter = build_account_filter(bs_accounts)
            bs_where_clauses = where_clauses.copy()
            # Replace the account filter clause with just BS accounts
            bs_where_clauses = [c for c in bs_where_clauses if 'a.acctnumber' not in c]
            bs_where_clauses.append(bs_account_filter)
            bs_base_where = " AND ".join(bs_where_clauses)
            
            for period, info in period_info.items():
                try:
                    # Build query for THIS period only, with BS accounts only
                    period_query = build_bs_query_single_period(
                        bs_accounts, period, info, bs_base_where, target_sub, needs_line_join, accountingbook
                    )
                    
                    print(f"DEBUG - BS Query for {period} (book={accountingbook}):\n{period_query[:300]}...", file=sys.stderr)
                    
                    # Balance Sheet queries can be slower - use 90 second timeout
                    bs_result = query_netsuite(period_query, timeout=90)
                    
                    if isinstance(bs_result, list):
                        print(f"DEBUG - BS returned {len(bs_result)} rows for {period}", file=sys.stderr)
                        # Process results for this period
                        for row in bs_result:
                            account_num = row['acctnumber']
                            balance = float(row['balance']) if row['balance'] else 0
                            
                            if account_num not in all_balances:
                                all_balances[account_num] = {}
                            all_balances[account_num][period] = balance
                    elif isinstance(bs_result, dict) and 'error' in bs_result:
                        print(f"ERROR - BS query failed for {period}: {bs_result['error']}", file=sys.stderr)
                    else:
                        print(f"ERROR - BS query unexpected result type for {period}: {type(bs_result)}", file=sys.stderr)
                except Exception as e:
                    print(f"ERROR - BS query exception for {period}: {str(e)}", file=sys.stderr)
        else:
            print(f"DEBUG - Skipping BS queries (no BS accounts requested)", file=sys.stderr)
        
        print(f"DEBUG - Final merged balances: {list(all_balances.keys())}", file=sys.stderr)
        
        # WILDCARD SUPPORT: Sum results for wildcard patterns
        # The query expands "4*" to all 4xxx accounts, but we need to return a single sum
        for original_account in accounts:
            if '*' in str(original_account):
                # This is a wildcard - sum all matching account balances
                pattern = str(original_account).replace('*', '')  # "4*" -> "4"
                wildcard_totals = {}
                
                for account_num, period_balances in all_balances.items():
                    if str(account_num).startswith(pattern):
                        for period, balance in period_balances.items():
                            if period not in wildcard_totals:
                                wildcard_totals[period] = 0
                            wildcard_totals[period] += balance
                
                # Store the sum under the wildcard key
                all_balances[original_account] = wildcard_totals
                print(f"DEBUG - Wildcard '{original_account}' summed: {wildcard_totals}", file=sys.stderr)
        
        # Fill in zeros for missing account/period combinations
        for account_num in accounts:
            if account_num not in all_balances:
                all_balances[account_num] = {}
            for period in periods:
                if period not in all_balances[account_num]:
                    all_balances[account_num][period] = 0
        
        # Return merged results
        return jsonify({'balances': all_balances})
        
    except Exception as e:
        print(f"Error in batch_balance: {str(e)}", file=sys.stderr)
        return jsonify({'error': str(e)}), 500


@app.route('/department/<department_name>')
def get_department_id(department_name):
    """
    Get department ID from department name
    Used to lookup department IDs for filtering
    
    Returns: Department ID (number) or error
    """
    try:
        query = f"""
            SELECT id, name
            FROM Department
            WHERE LOWER(name) LIKE LOWER('%{escape_sql(department_name)}%')
        """
        
        result = query_netsuite(query)
        
        if isinstance(result, dict) and 'error' in result:
            return jsonify({'error': result['error']}), 500
        
        if result and len(result) > 0:
            return jsonify(result)
        else:
            return jsonify({'error': 'Department not found'}), 404
            
    except Exception as e:
        print(f"Error in get_department_id: {str(e)}", file=sys.stderr)
        return jsonify({'error': str(e)}), 500


@app.route('/account/<account_number>/type')
def get_account_type_deprecated(account_number):
    """
    DEPRECATED: Use POST /account/type instead.
    This GET endpoint exposes account numbers in URLs/logs.
    Kept for backward compatibility.
    """
    return _get_account_type_impl(account_number)


@app.route('/account/type', methods=['POST'])
def get_account_type():
    """
    Get account type from account number (SECURE - POST method)
    Used by: NS.GLACCTTYPE(accountNumber)
    
    Request body: { "account": "60100" }
    Returns: Account type (Income, Expense, Bank, etc.)
    """
    try:
        data = request.get_json() or {}
        account_number = data.get('account', '')
        
        if not account_number:
            return jsonify({'error': 'Missing account parameter'}), 400
            
        return _get_account_type_impl(account_number)
        
    except Exception as e:
        print(f"Error in get_account_type (POST): {str(e)}", file=sys.stderr)
        return jsonify({'error': str(e)}), 500


def _get_account_type_impl(account_number):
    """Internal implementation for getting account type"""
    try:
        query = f"""
            SELECT accttype AS account_type
            FROM Account
            WHERE acctnumber = '{escape_sql(account_number)}'
        """
        
        result = query_netsuite(query)
        
        if isinstance(result, dict) and 'error' in result:
            return jsonify({'error': result['error']}), 500
            
        if not result or len(result) == 0:
            return 'Not Found', 404
            
        account_type = result[0].get('account_type', '')
        return account_type, 200, {'Content-Type': 'text/plain'}
        
    except Exception as e:
        print(f"Error in _get_account_type_impl: {str(e)}", file=sys.stderr)
        return jsonify({'error': str(e)}), 500


@app.route('/batch/account_types', methods=['POST'])
def batch_get_account_types():
    """
    Get account types for multiple accounts at once.
    Used by: Refresh All to classify P&L vs Balance Sheet accounts.
    
    POST body: { "accounts": ["10010", "40100", "60032", ...] }
    Returns: { "types": { "10010": "Bank", "40100": "Income", "60032": "Expense", ... } }
    """
    try:
        data = request.get_json() or {}
        accounts = data.get('accounts', [])
        
        if not accounts:
            return jsonify({'types': {}})
        
        # Build account filter (supports wildcards like '4*')
        # NOTE: Use 'acctnumber' not 'a.acctnumber' because Account table has no alias here
        account_filter = build_account_filter(accounts, column='acctnumber')
        
        query = f"""
            SELECT acctnumber, accttype
            FROM Account
            WHERE {account_filter}
        """
        
        result = query_netsuite(query)
        
        if isinstance(result, dict) and 'error' in result:
            return jsonify({'error': result['error']}), 500
        
        types = {}
        if isinstance(result, list):
            for row in result:
                acct = row.get('acctnumber')
                acct_type = row.get('accttype', '')
                if acct:
                    types[acct] = acct_type
        
        # WILDCARD SUPPORT: For wildcard patterns, determine a type based on matched accounts
        # If all matched accounts have the same type, use that; otherwise use the most common
        for original_account in accounts:
            if '*' in str(original_account):
                pattern = str(original_account).replace('*', '')
                matched_types = [types[acct] for acct in types if str(acct).startswith(pattern)]
                
                if matched_types:
                    # Use the most common type among matched accounts
                    from collections import Counter
                    most_common_type = Counter(matched_types).most_common(1)[0][0]
                    types[original_account] = most_common_type
                    print(f"   📊 Wildcard '{original_account}' → type '{most_common_type}' (from {len(matched_types)} accounts)", file=sys.stderr)
        
        print(f"📊 Batch account types: {len(types)} accounts classified", file=sys.stderr)
        return jsonify({'types': types})
        
    except Exception as e:
        print(f"Error in batch_get_account_types: {str(e)}", file=sys.stderr)
        return jsonify({'error': str(e)}), 500


@app.route('/account/<account_number>/parent')
def get_account_parent_deprecated(account_number):
    """
    DEPRECATED: Use POST /account/parent instead.
    This GET endpoint exposes account numbers in URLs/logs.
    Kept for backward compatibility.
    """
    return _get_account_parent_impl(account_number)


@app.route('/account/parent', methods=['POST'])
def get_account_parent():
    """
    Get parent account number from account number (SECURE - POST method)
    Used by: NS.GLAPARENT(accountNumber)
    
    Request body: { "account": "60100" }
    Returns: Parent account number (or empty string if no parent)
    """
    try:
        data = request.get_json() or {}
        account_number = data.get('account', '')
        
        if not account_number:
            return jsonify({'error': 'Missing account parameter'}), 400
            
        return _get_account_parent_impl(account_number)
        
    except Exception as e:
        print(f"Error in get_account_parent (POST): {str(e)}", file=sys.stderr)
        return jsonify({'error': str(e)}), 500


def _get_account_parent_impl(account_number):
    """Internal implementation for getting parent account"""
    try:
        query = f"""
            SELECT 
                a.acctnumber,
                p.acctnumber AS parent_number
            FROM Account a
            LEFT JOIN Account p ON a.parent = p.id
            WHERE a.acctnumber = '{escape_sql(account_number)}'
        """
        
        result = query_netsuite(query)
        
        if isinstance(result, dict) and 'error' in result:
            return jsonify({'error': result['error']}), 500
            
        if not result or len(result) == 0:
            return 'Not Found', 404
            
        parent_number = result[0].get('parent_number', '')
        return parent_number or '', 200, {'Content-Type': 'text/plain'}
        
    except Exception as e:
        print(f"Error in _get_account_parent_impl: {str(e)}", file=sys.stderr)
        return jsonify({'error': str(e)}), 500


@app.route('/account/preload_titles')
def preload_account_titles():
    """
    Preload ALL account titles into cache with a single query
    This prevents 429 rate limit errors from concurrent individual requests
    
    Returns: Count of titles loaded
    """
    global account_title_cache
    
    try:
        print("🔄 Preloading ALL account titles...")
        
        # Query ALL active accounts in one go
        query = """
            SELECT acctnumber, accountsearchdisplaynamecopy AS account_name
            FROM Account
            WHERE isinactive = 'F'
            ORDER BY acctnumber
        """
        
        result = query_netsuite(query)
        
        if isinstance(result, dict) and 'error' in result:
            return jsonify({'error': result['error']}), 500
        
        # Populate cache
        loaded_count = 0
        if isinstance(result, list):
            for row in result:
                account_num = str(row.get('acctnumber', ''))
                account_name = row.get('account_name', 'Unknown')
                if account_num:
                    account_title_cache[account_num] = account_name
                    loaded_count += 1
        
        print(f"✅ Preloaded {loaded_count} account titles into cache")
        return jsonify({'loaded': loaded_count, 'status': 'success'})
            
    except Exception as e:
        print(f"Error preloading account titles: {str(e)}", file=sys.stderr)
        return jsonify({'error': str(e)}), 500


@app.route('/account/<account_number>/name')
def get_account_name_deprecated(account_number):
    """
    DEPRECATED: Use POST /account/name instead.
    This GET endpoint exposes account numbers in URLs/logs.
    Kept for backward compatibility.
    """
    return _get_account_name_impl(account_number)


@app.route('/account/name', methods=['POST'])
def get_account_name():
    """
    Get account name from account number (SECURE - POST method)
    Used by: NS.GLATITLE(accountNumber)
    
    Request body: { "account": "60100" }
    Returns: Account display name (string)
    """
    try:
        data = request.get_json() or {}
        account_number = data.get('account', '')
        
        if not account_number:
            return jsonify({'error': 'Missing account parameter'}), 400
            
        return _get_account_name_impl(account_number)
        
    except Exception as e:
        print(f"Error in get_account_name (POST): {str(e)}", file=sys.stderr)
        return jsonify({'error': str(e)}), 500


@app.route('/account/names', methods=['POST'])
def get_account_names_batch():
    """
    Get multiple account names in a single request (BATCH)
    
    Request body: { "accounts": ["60010", "60020", "60030"] }
    Returns: { "60010": "Revenue", "60020": "Cost of Goods", "60030": "Expenses" }
    
    Efficiently handles cache hits and batches cache misses into a single SuiteQL query.
    """
    global account_title_cache
    
    try:
        data = request.get_json() or {}
        accounts = data.get('accounts', [])
        
        if not accounts:
            return jsonify({'error': 'Missing accounts parameter'}), 400
        
        # Deduplicate and normalize
        accounts = list(set(str(a).strip() for a in accounts if a))
        
        print(f"📦 Batch account names request: {len(accounts)} accounts")
        
        results = {}
        cache_misses = []
        
        # Check cache first
        for account in accounts:
            if account in account_title_cache:
                results[account] = account_title_cache[account]
            else:
                cache_misses.append(account)
        
        print(f"   ✅ Cache hits: {len(results)}, ❓ Cache misses: {len(cache_misses)}")
        
        # Batch query for cache misses
        if cache_misses:
            # Build IN clause for efficiency
            escaped_accounts = [f"'{escape_sql(a)}'" for a in cache_misses]
            in_clause = ', '.join(escaped_accounts)
            
            query = f"""
                SELECT acctnumber, accountsearchdisplaynamecopy AS account_name
                FROM Account
                WHERE acctnumber IN ({in_clause})
            """
            
            result = query_netsuite(query)
            
            if isinstance(result, dict) and 'error' in result:
                print(f"   ⚠️ NetSuite query error: {result['error']}", file=sys.stderr)
                # Still return what we have from cache
                for miss in cache_misses:
                    results[miss] = 'Error'
            elif isinstance(result, list):
                # Process results and cache them
                found_accounts = set()
                for row in result:
                    acct_num = str(row.get('acctnumber', ''))
                    acct_name = row.get('account_name', 'Unknown')
                    if acct_num:
                        results[acct_num] = acct_name
                        account_title_cache[acct_num] = acct_name
                        found_accounts.add(acct_num)
                
                # Mark not found accounts
                for miss in cache_misses:
                    if miss not in found_accounts:
                        results[miss] = 'Not Found'
                        account_title_cache[miss] = 'Not Found'  # Cache to avoid repeated queries
                
                print(f"   📝 Cached {len(found_accounts)} new titles")
        
        return jsonify(results)
        
    except Exception as e:
        print(f"Error in get_account_names_batch: {str(e)}", file=sys.stderr)
        return jsonify({'error': str(e)}), 500


def _get_account_name_impl(account_number):
    """Internal implementation for getting account name"""
    global account_title_cache
    
    try:
        # Check cache first
        if account_number in account_title_cache:
            # print(f"⚡ Title cache HIT: {account_number}")  # Uncomment for debugging
            return account_title_cache[account_number]
        
        # Cache miss - query NetSuite (ONLY if not preloaded)
        # This should rarely happen if preload_titles was called
        print(f"⚠️  Title cache MISS for account {account_number} - querying NetSuite")
        
        # Build SuiteQL query
        # Use accountsearchdisplaynamecopy to get name WITHOUT account number prefix
        query = f"""
            SELECT accountsearchdisplaynamecopy AS account_name
            FROM Account
            WHERE acctnumber = '{escape_sql(account_number)}'
        """
        
        result = query_netsuite(query)
        
        # Check for errors
        if isinstance(result, dict) and 'error' in result:
            return jsonify({'error': result['error']}), 500
        
        # Return account name or "Not Found"
        if result and len(result) > 0:
            account_name = result[0].get('account_name', 'Not Found')
        else:
            account_name = 'Not Found'
        
        # Cache the result (even if Not Found, to avoid repeated queries)
        account_title_cache[account_number] = account_name
        print(f"📝 Cached title for account {account_number}: {account_name}")
        
        return account_name
            
    except Exception as e:
        print(f"Error in _get_account_name_impl: {str(e)}", file=sys.stderr)
        return jsonify({'error': str(e)}), 500


@app.route('/balance')
def get_balance():
    """
    Get GL account balance with filters
    Used by: NS.GLABAL(subsidiary, account, fromPeriod, toPeriod, class, dept, location)
    
    Query params:
        - account: Account number (required)
        - subsidiary: Subsidiary ID (optional)
        - from_period: Starting period name (optional)
        - to_period: Ending period name (optional)
        - class: Class ID (optional)
        - department: Department ID (optional)
        - location: Location ID (optional)
    
    Returns: Balance amount (number)
    """
    try:
        # Get parameters (accept both 'from'/'to' and 'from_period'/'to_period')
        account = request.args.get('account', '')
        raw_subsidiary = request.args.get('subsidiary', '')
        from_period = request.args.get('from_period', '') or request.args.get('from', '')
        to_period = request.args.get('to_period', '') or request.args.get('to', '')
        class_id = request.args.get('class', '')
        department = request.args.get('department', '')
        location = request.args.get('location', '')
        
        # Handle year-only format (e.g., "2025" -> "Jan 2025" to "Dec 2025")
        if is_year_only(from_period):
            from_period, _ = expand_year_to_periods(from_period)
        if is_year_only(to_period):
            _, to_period = expand_year_to_periods(to_period)
        
        # Convert names to IDs (accepts names OR IDs)
        subsidiary = convert_name_to_id('subsidiary', raw_subsidiary)
        class_id = convert_name_to_id('class', class_id)
        department = convert_name_to_id('department', department)
        location = convert_name_to_id('location', location)
        
        # Determine consolidated status (explicit OR auto from root)
        wants_consolidated = should_use_consolidated(raw_subsidiary, subsidiary)
        
        if not account:
            return jsonify({'error': 'Account number required'}), 400
        
        # Get accounting book parameter (default to Primary Book = 1)
        accounting_book = request.args.get('accountingBook', '') or request.args.get('accountingbook', '') or '1'
        
        # ========================================================================
        # AUTO-DETECT BALANCE SHEET ACCOUNTS
        # BS accounts need CUMULATIVE balance (inception through to_period)
        # P&L accounts need PERIOD RANGE balance (from_period through to_period)
        # ========================================================================
        is_bs_account = False
        if account and not '*' in account:  # Can't auto-detect for wildcards
            try:
                type_query = f"SELECT accttype FROM Account WHERE acctnumber = '{escape_sql(account)}'"
                type_result = query_netsuite(type_query)
                if isinstance(type_result, list) and len(type_result) > 0:
                    acct_type = type_result[0].get('accttype', '')
                    is_bs_account = is_balance_sheet_account(acct_type)
                    print(f"DEBUG - Account {account} type: {acct_type}, is_bs: {is_bs_account}", file=sys.stderr)
            except Exception as e:
                print(f"DEBUG - Could not determine account type for {account}: {e}", file=sys.stderr)
        
        # For wildcards, query NetSuite to determine account types (don't assume based on prefix!)
        # Different NetSuite accounts use different numbering schemes
        if '*' in account:
            try:
                # Query all matching accounts and their types
                # Use 'acctnumber' (no alias) since we're querying Account table directly
                wildcard_filter = build_account_filter([account], column='acctnumber')
                type_query = f"SELECT DISTINCT accttype FROM Account WHERE {wildcard_filter}"
                type_result = query_netsuite(type_query, timeout=15)
                
                if isinstance(type_result, list) and len(type_result) > 0:
                    # Check if ALL matching accounts are the same type (BS or P&L)
                    account_types = [r.get('accttype', '') for r in type_result]
                    bs_types = [t for t in account_types if is_balance_sheet_account(t)]
                    pl_types = [t for t in account_types if not is_balance_sheet_account(t)]
                    
                    if len(bs_types) > 0 and len(pl_types) == 0:
                        is_bs_account = True
                        print(f"DEBUG - Wildcard {account}: ALL matching accounts are BS ({account_types})", file=sys.stderr)
                    elif len(pl_types) > 0 and len(bs_types) == 0:
                        is_bs_account = False
                        print(f"DEBUG - Wildcard {account}: ALL matching accounts are P&L ({account_types})", file=sys.stderr)
                    else:
                        # Mixed types - default to P&L behavior (safer)
                        is_bs_account = False
                        print(f"DEBUG - Wildcard {account}: MIXED account types ({account_types}) - using P&L behavior", file=sys.stderr)
                else:
                    print(f"DEBUG - Wildcard {account}: Could not determine types, using P&L behavior", file=sys.stderr)
            except Exception as e:
                print(f"DEBUG - Wildcard {account}: Error querying types ({e}), using P&L behavior", file=sys.stderr)
        
        # For BS accounts, ignore from_period (use cumulative from inception)
        if is_bs_account and from_period and to_period:
            print(f"DEBUG - BS account detected: using cumulative through {to_period} (ignoring from_period={from_period})", file=sys.stderr)
            from_period = ''  # Clear from_period for cumulative calculation
        
        # Build WHERE clause
        # Use build_account_filter to support wildcards like '4*' for all revenue accounts
        account_filter = build_account_filter([account])
        where_clauses = [
            "t.posting = 'T'",
            "tal.posting = 'T'",
            account_filter,
            f"tal.accountingbook = {accounting_book}"  # Always filter to specific accounting book
        ]
        
        # Add subsidiary filter
        # CRITICAL: Use tl.subsidiary for GL line-level filtering (intercompany JEs)
        needs_line_join_for_subsidiary = False
        if subsidiary and subsidiary != '':
            use_hierarchy = wants_consolidated
            
            # OPTIMIZATION: For root consolidated subsidiary, skip the filter entirely
            # (includes all subs anyway - avoids expensive TransactionLine join for BS queries)
            print(f"DEBUG - subsidiary={subsidiary}, default_subsidiary_id={default_subsidiary_id}, wants_consolidated={wants_consolidated}", file=sys.stderr)
            is_root_consolidated = (subsidiary == str(default_subsidiary_id)) and use_hierarchy
            print(f"DEBUG - is_root_consolidated={is_root_consolidated}", file=sys.stderr)
            
            if is_root_consolidated:
                print(f"DEBUG - Root consolidated subsidiary (ID={subsidiary}) - skipping filter (includes all subs)", file=sys.stderr)
                # Don't add filter, don't need TransactionLine join
            elif use_hierarchy:
                hierarchy_subs = get_subsidiaries_in_hierarchy(subsidiary)
                sub_filter = ', '.join(hierarchy_subs)
                where_clauses.append(f"tl.subsidiary IN ({sub_filter})")
                print(f"DEBUG - Consolidated subsidiary filter: {len(hierarchy_subs)} subsidiaries in hierarchy")
                needs_line_join_for_subsidiary = True
            else:
                where_clauses.append(f"tl.subsidiary = {subsidiary}")
                print(f"DEBUG - Single subsidiary filter: {subsidiary}")
                needs_line_join_for_subsidiary = True
        
        # Handle period filters - support both period IDs and names
        if from_period and to_period:
            # Check if it's a number (period ID) or text (period name)
            if from_period.isdigit() and to_period.isdigit():
                where_clauses.append(f"t.postingperiod >= {from_period}")
                where_clauses.append(f"t.postingperiod <= {to_period}")
            else:
                # Convert period names to DATE ranges
                # Period IDs don't work because they include quarterly/fiscal periods
                from_start, from_end, _ = get_period_dates_from_name(from_period)
                to_start, to_end, _ = get_period_dates_from_name(to_period)
                if from_start and to_end:
                    # Use date strings directly (NetSuite returns dates as strings)
                    where_clauses.append(f"ap.startdate >= '{from_start}'")
                    where_clauses.append(f"ap.enddate <= '{to_end}'")
                else:
                    # Fallback to period name if conversion fails
                    where_clauses.append(f"ap.periodname = '{escape_sql(from_period)}'")
        elif from_period:
            if from_period.isdigit():
                where_clauses.append(f"t.postingperiod = {from_period}")
            else:
                where_clauses.append(f"ap.periodname = '{escape_sql(from_period)}'")
        elif to_period:
            # BALANCE SHEET CASE: Empty from_period, only to_period provided
            # This means "cumulative from beginning of time through to_period"
            # Use t.trandate (transaction date) for better performance - no need to join AccountingPeriod
            if to_period.isdigit():
                where_clauses.append(f"t.postingperiod <= {to_period}")
            else:
                _, to_end, _ = get_period_dates_from_name(to_period)
                if to_end:
                    # Convert MM/DD/YYYY to YYYY-MM-DD for TO_DATE function
                    try:
                        from datetime import datetime
                        end_date_obj = datetime.strptime(to_end, '%m/%d/%Y')
                        end_date_str = end_date_obj.strftime('%Y-%m-%d')
                    except:
                        end_date_str = to_end
                    # Use t.trandate for cumulative BS - more efficient than ap.enddate
                    where_clauses.append(f"t.trandate <= TO_DATE('{end_date_str}', 'YYYY-MM-DD')")
                else:
                    where_clauses.append(f"ap.periodname = '{escape_sql(to_period)}'")
        
        if class_id and class_id != '':
            where_clauses.append(f"tl.class = {class_id}")
        
        if department and department != '':
            # Department is on TransactionLine table for journal entries
            where_clauses.append(f"tl.department = {department}")
        
        if location and location != '':
            where_clauses.append(f"tl.location = {location}")
        
        where_clause = " AND ".join(where_clauses)
        
        # Build SuiteQL query - use CASE for correct balance by account type
        # Only join AccountingPeriod if we're using period names
        # Note: Department filtering requires TransactionLine join for journal entries
        print(f"DEBUG - WHERE clause: {where_clause}", file=sys.stderr)
        print(f"DEBUG - Department param: {department}", file=sys.stderr)
        
        # Determine target subsidiary for consolidation
        # Must use valid subsidiary ID (not NULL) for BUILTIN.CONSOLIDATE
        target_sub = subsidiary if subsidiary and subsidiary != '' else (default_subsidiary_id or '1')
        
        # Need TransactionLine join if filtering by department, class, location, or subsidiary
        needs_line_join = needs_line_join_for_subsidiary or (department and department != '') or (class_id and class_id != '') or (location and location != '')
        
        use_hierarchy = wants_consolidated
        
        # Sign multiplier: flip Income/OthIncome from credits (negative) to positive display
        sign_sql = f"* CASE WHEN a.accttype IN ({INCOME_TYPES_SQL}) THEN -1 ELSE 1 END"
        
        # Check if this is a cumulative BS query (no from_period, only to_period with t.trandate)
        is_cumulative_bs = is_bs_account and not from_period and to_period and not to_period.isdigit()
        
        # Always use BUILTIN.CONSOLIDATE - works for both OneWorld and non-OneWorld
        if is_cumulative_bs:
            # OPTIMIZED BS QUERY: No AccountingPeriod join needed - use t.trandate directly
            print(f"DEBUG - Using optimized cumulative BS query (no AP join)", file=sys.stderr)
            if needs_line_join:
                query = f"""
                    SELECT SUM(x.cons_amt) AS balance
                    FROM (
                        SELECT
                                    TO_NUMBER(
                                        BUILTIN.CONSOLIDATE(
                                            tal.amount,
                                            'LEDGER',
                                            'DEFAULT',
                                            'DEFAULT',
                                            {target_sub},
                                            t.postingperiod,
                                            'DEFAULT'
                                        )
                                    )
                            {sign_sql}
 AS cons_amt
                        FROM TransactionAccountingLine tal
                            JOIN Transaction t ON t.id = tal.transaction
                            JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
                            JOIN Account a ON a.id = tal.account
                        WHERE {where_clause}
                    ) x
                """
            else:
                query = f"""
                    SELECT SUM(x.cons_amt) AS balance
                    FROM (
                        SELECT
                                    TO_NUMBER(
                                        BUILTIN.CONSOLIDATE(
                                            tal.amount,
                                            'LEDGER',
                                            'DEFAULT',
                                            'DEFAULT',
                                            {target_sub},
                                            t.postingperiod,
                                            'DEFAULT'
                                        )
                                    )
                            {sign_sql}
 AS cons_amt
                        FROM TransactionAccountingLine tal
                            JOIN Transaction t ON t.id = tal.transaction
                            JOIN Account a ON a.id = tal.account
                        WHERE {where_clause}
                    ) x
                """
        elif (from_period and not from_period.isdigit()) or (to_period and not to_period.isdigit()):
            if needs_line_join:
                query = f"""
                    SELECT SUM(x.cons_amt) AS balance
                    FROM (
                        SELECT
                                    TO_NUMBER(
                                        BUILTIN.CONSOLIDATE(
                                            tal.amount,
                                            'LEDGER',
                                            'DEFAULT',
                                            'DEFAULT',
                                            {target_sub},
                                            t.postingperiod,
                                            'DEFAULT'
                                        )
                                    )
                            {sign_sql}
 AS cons_amt
                        FROM TransactionAccountingLine tal
                            JOIN Transaction t ON t.id = tal.transaction
                            JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
                            JOIN Account a ON a.id = tal.account
                            JOIN AccountingPeriod ap ON ap.id = t.postingperiod
                        WHERE {where_clause}
                    ) x
                """
            else:
                query = f"""
                    SELECT SUM(x.cons_amt) AS balance
                    FROM (
                        SELECT
                                    TO_NUMBER(
                                        BUILTIN.CONSOLIDATE(
                                            tal.amount,
                                            'LEDGER',
                                            'DEFAULT',
                                            'DEFAULT',
                                            {target_sub},
                                            t.postingperiod,
                                            'DEFAULT'
                                        )
                                    )
                            {sign_sql}
 AS cons_amt
                        FROM TransactionAccountingLine tal
                            JOIN Transaction t ON t.id = tal.transaction
                            JOIN Account a ON a.id = tal.account
                            JOIN AccountingPeriod ap ON ap.id = t.postingperiod
                        WHERE {where_clause}
                    ) x
                """
        else:
            if needs_line_join:
                query = f"""
                    SELECT SUM(x.cons_amt) AS balance
                    FROM (
                        SELECT
                                    TO_NUMBER(
                                        BUILTIN.CONSOLIDATE(
                                            tal.amount,
                                            'LEDGER',
                                            'DEFAULT',
                                            'DEFAULT',
                                            {target_sub},
                                            t.postingperiod,
                                            'DEFAULT'
                                        )
                                    )
                            {sign_sql}
 AS cons_amt
                        FROM TransactionAccountingLine tal
                            JOIN Transaction t ON t.id = tal.transaction
                            JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
                            JOIN Account a ON a.id = tal.account
                        WHERE {where_clause}
                    ) x
                """
            else:
                query = f"""
                    SELECT SUM(x.cons_amt) AS balance
                    FROM (
                        SELECT
                                    TO_NUMBER(
                                        BUILTIN.CONSOLIDATE(
                                            tal.amount,
                                            'LEDGER',
                                            'DEFAULT',
                                            'DEFAULT',
                                            {target_sub},
                                            t.postingperiod,
                                            'DEFAULT'
                                        )
                                    )
                            {sign_sql}
 AS cons_amt
                        FROM TransactionAccountingLine tal
                            JOIN Transaction t ON t.id = tal.transaction
                            JOIN Account a ON a.id = tal.account
                        WHERE {where_clause}
                    ) x
                """
        
        print(f"DEBUG - Full query:\n{query}", file=sys.stderr)
        
        # Use longer timeout for cumulative BS queries (they scan all historical data)
        query_timeout = 90 if is_cumulative_bs else 30
        print(f"DEBUG - Query timeout: {query_timeout}s (is_cumulative_bs={is_cumulative_bs})", file=sys.stderr)
        
        result = query_netsuite(query, timeout=query_timeout)
        
        # Check for errors
        if isinstance(result, dict) and 'error' in result:
            return jsonify({'error': result['error']}), 500
        
        # Get total balance
        total_balance = 0.0
        if result and len(result) > 0:
            balance = result[0].get('balance')
            if balance is not None:
                total_balance = float(balance)
        
        # ================================================================
        # WILDCARD BREAKDOWN: For patterns like "100*", also return
        # individual account balances so frontend can cache them
        # This enables instant resolution of subsequent wildcards from cache
        # ================================================================
        include_breakdown = request.args.get('include_breakdown', 'false').lower() == 'true'
        
        if '*' in account and include_breakdown:
            print(f"DEBUG - Wildcard with breakdown requested: {account}", file=sys.stderr)
            
            # Query individual account balances
            # Modify query to GROUP BY account number
            breakdown_sign_sql = f"* CASE WHEN a.accttype IN ({INCOME_TYPES_SQL}) THEN -1 ELSE 1 END"
            
            if is_cumulative_bs:
                if needs_line_join:
                    breakdown_query = f"""
                        SELECT a.acctnumber, SUM(x.cons_amt) AS balance
                        FROM (
                            SELECT
                                tal.account,
                                TO_NUMBER(
                                    BUILTIN.CONSOLIDATE(
                                        tal.amount,
                                        'LEDGER',
                                        'DEFAULT',
                                        'DEFAULT',
                                        {target_sub},
                                        t.postingperiod,
                                        'DEFAULT'
                                    )
                                )
                                {breakdown_sign_sql}
                                AS cons_amt
                            FROM TransactionAccountingLine tal
                                JOIN Transaction t ON t.id = tal.transaction
                                JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
                                JOIN Account a ON a.id = tal.account
                            WHERE {where_clause}
                        ) x
                        JOIN Account a ON a.id = x.account
                        GROUP BY a.acctnumber
                    """
                else:
                    breakdown_query = f"""
                        SELECT a.acctnumber, SUM(x.cons_amt) AS balance
                        FROM (
                            SELECT
                                tal.account,
                                TO_NUMBER(
                                    BUILTIN.CONSOLIDATE(
                                        tal.amount,
                                        'LEDGER',
                                        'DEFAULT',
                                        'DEFAULT',
                                        {target_sub},
                                        t.postingperiod,
                                        'DEFAULT'
                                    )
                                )
                                {breakdown_sign_sql}
                                AS cons_amt
                            FROM TransactionAccountingLine tal
                                JOIN Transaction t ON t.id = tal.transaction
                                JOIN Account a ON a.id = tal.account
                            WHERE {where_clause}
                        ) x
                        JOIN Account a ON a.id = x.account
                        GROUP BY a.acctnumber
                    """
            else:
                # Non-cumulative (P&L) query with breakdown
                if needs_line_join:
                    breakdown_query = f"""
                        SELECT a.acctnumber, SUM(x.cons_amt) AS balance
                        FROM (
                            SELECT
                                tal.account,
                                TO_NUMBER(
                                    BUILTIN.CONSOLIDATE(
                                        tal.amount,
                                        'LEDGER',
                                        'DEFAULT',
                                        'DEFAULT',
                                        {target_sub},
                                        t.postingperiod,
                                        'DEFAULT'
                                    )
                                )
                                {breakdown_sign_sql}
                                AS cons_amt
                            FROM TransactionAccountingLine tal
                                JOIN Transaction t ON t.id = tal.transaction
                                JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
                                JOIN Account a ON a.id = tal.account
                                JOIN AccountingPeriod ap ON ap.id = t.postingperiod
                            WHERE {where_clause}
                        ) x
                        JOIN Account a ON a.id = x.account
                        GROUP BY a.acctnumber
                    """
                else:
                    breakdown_query = f"""
                        SELECT a.acctnumber, SUM(x.cons_amt) AS balance
                        FROM (
                            SELECT
                                tal.account,
                                TO_NUMBER(
                                    BUILTIN.CONSOLIDATE(
                                        tal.amount,
                                        'LEDGER',
                                        'DEFAULT',
                                        'DEFAULT',
                                        {target_sub},
                                        t.postingperiod,
                                        'DEFAULT'
                                    )
                                )
                                {breakdown_sign_sql}
                                AS cons_amt
                            FROM TransactionAccountingLine tal
                                JOIN Transaction t ON t.id = tal.transaction
                                JOIN Account a ON a.id = tal.account
                                JOIN AccountingPeriod ap ON ap.id = t.postingperiod
                            WHERE {where_clause}
                        ) x
                        JOIN Account a ON a.id = x.account
                        GROUP BY a.acctnumber
                    """
            
            print(f"DEBUG - Breakdown query:\n{breakdown_query}", file=sys.stderr)
            
            try:
                breakdown_result = query_netsuite(breakdown_query, timeout=query_timeout)
                
                if isinstance(breakdown_result, list):
                    accounts = {}
                    for row in breakdown_result:
                        acct_num = row.get('acctnumber', '')
                        acct_bal = row.get('balance', 0)
                        if acct_num:
                            accounts[acct_num] = float(acct_bal) if acct_bal else 0.0
                    
                    print(f"DEBUG - Breakdown: {len(accounts)} individual accounts", file=sys.stderr)
                    
                    return jsonify({
                        'total': total_balance,
                        'accounts': accounts,
                        'pattern': account,
                        'period': to_period or from_period
                    })
            except Exception as e:
                print(f"DEBUG - Breakdown query failed: {e}", file=sys.stderr)
                # Fall through to return just the total
        
        # Return balance as plain string (default format for backward compatibility)
        return str(total_balance)
            
    except Exception as e:
        print(f"Error in get_balance: {str(e)}", file=sys.stderr)
        return jsonify({'error': str(e)}), 500


@app.route('/budget')
def get_budget():
    """
    Get budget amount from NetSuite using BudgetsMachine table for period-level data.
    
    Uses BudgetsMachine table which contains period-by-period budget amounts,
    joined with Budgets (header) and Account tables.
    
    Query params:
        - account: Account number (required)
        - from_period: Starting period name like "Jan 2011" (required for period query)
        - to_period: Ending period name (optional, defaults to from_period for single month)
        - subsidiary: Subsidiary name or ID (optional)
        - budget_category: Budget category name or ID (optional)
        - department: Department name or ID (optional)
        - class: Class name or ID (optional)
        - location: Location name or ID (optional)
        - accountingbook: Accounting book ID (optional, defaults to 1)
    
    Returns: Budget amount for the specified period(s)
    """
    try:
        # Get parameters (accept both 'from'/'to' and 'from_period'/'to_period')
        account = request.args.get('account', '')
        subsidiary = request.args.get('subsidiary', '')
        budget_category = request.args.get('budget_category', '')
        from_period = request.args.get('from_period', '') or request.args.get('from', '')
        to_period = request.args.get('to_period', '') or request.args.get('to', '') or from_period
        department = request.args.get('department', '')
        class_id = request.args.get('class', '')
        location = request.args.get('location', '')
        
        # Handle year-only format (e.g., "2025" -> "Jan 2025" to "Dec 2025")
        if is_year_only(from_period):
            from_period, _ = expand_year_to_periods(from_period)
        if is_year_only(to_period):
            _, to_period = expand_year_to_periods(to_period)
        
        # Multi-Book Accounting support
        accountingbook = request.args.get('accountingbook', str(DEFAULT_ACCOUNTING_BOOK))
        try:
            accountingbook = int(accountingbook) if accountingbook else DEFAULT_ACCOUNTING_BOOK
        except ValueError:
            accountingbook = DEFAULT_ACCOUNTING_BOOK
        
        # Convert names to IDs
        subsidiary = convert_name_to_id('subsidiary', subsidiary)
        department = convert_name_to_id('department', department)
        class_id = convert_name_to_id('class', class_id)
        location = convert_name_to_id('location', location)
        
        if not account:
            return jsonify({'error': 'Account number required'}), 400
        
        # Build WHERE clauses
        where_clauses = [
            f"a.acctnumber = '{escape_sql(account)}'"
        ]
        
        # Period filter - use AccountingPeriod table for date range
        if from_period and to_period:
            # Get period date ranges
            from_dates = get_period_dates_from_name(from_period)
            to_dates = get_period_dates_from_name(to_period)
            from_start = from_dates[0] if from_dates else None
            to_end = to_dates[1] if to_dates else None
            
            if from_start and to_end:
                where_clauses.append(f"ap.startdate >= '{from_start}'")
                where_clauses.append(f"ap.enddate <= '{to_end}'")
            else:
                # Fallback to period name match
                if from_period == to_period:
                    where_clauses.append(f"ap.periodname = '{escape_sql(from_period)}'")
                else:
                    where_clauses.append(f"ap.periodname >= '{escape_sql(from_period)}'")
                    where_clauses.append(f"ap.periodname <= '{escape_sql(to_period)}'")
        
        # Subsidiary filter
        if subsidiary and subsidiary != '':
            where_clauses.append(f"b.subsidiary = {subsidiary}")
        
        # Budget category filter - USE CACHE to avoid 429 errors!
        if budget_category and budget_category != '':
            if budget_category.isdigit():
                where_clauses.append(f"b.category = {budget_category}")
            else:
                cat_id = lookup_cache['budget_categories'].get(budget_category.lower())
                if cat_id:
                    where_clauses.append(f"b.category = {cat_id}")
        
        # Department filter
        if department and department != '':
            where_clauses.append(f"b.department = {department}")
        
        # Class filter
        if class_id and class_id != '':
            where_clauses.append(f"b.class = {class_id}")
        
        # Location filter
        if location and location != '':
            where_clauses.append(f"b.location = {location}")
        
        # Accounting book filter
        where_clauses.append(f"b.accountingbook = {accountingbook}")
        
        where_clause = " AND ".join(where_clauses)
        
        # Determine target subsidiary for consolidation
        target_sub = subsidiary if subsidiary and subsidiary != '' else (default_subsidiary_id or '1')
        
        # Query BudgetsMachine for period-level amounts with currency consolidation
        query = f"""
            SELECT 
                SUM(
                    TO_NUMBER(BUILTIN.CONSOLIDATE(
                        bm.amount, 'LEDGER', 'DEFAULT', 'DEFAULT',
                        {target_sub}, bm.period, 'DEFAULT'
                    ))
                ) AS budget_amount
            FROM BudgetsMachine bm
            INNER JOIN Budgets b ON bm.budget = b.id
            INNER JOIN Account a ON b.account = a.id
            INNER JOIN AccountingPeriod ap ON bm.period = ap.id
            WHERE {where_clause}
        """
        
        print(f"Budget query (BudgetsMachine): {query[:500]}...", file=sys.stderr)
        result = query_netsuite(query)
        
        # Check for errors
        if isinstance(result, dict) and 'error' in result:
            print(f"Budget query failed: {result.get('error')}", file=sys.stderr)
            return '0'
        
        # Return budget amount
        if result and len(result) > 0:
            amount = result[0].get('budget_amount')
            if amount is None:
                return '0'
            return str(float(amount))
        else:
            return '0'
            
    except Exception as e:
        error_msg = str(e) if str(e) else f"{type(e).__name__}: (no message)"
        print(f"Error in get_budget: {error_msg}", file=sys.stderr)
        print(f"   Exception type: {type(e).__name__}", file=sys.stderr)
        print(f"   Exception args: {e.args}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        return jsonify({'error': error_msg, 'type': type(e).__name__}), 500


@app.route('/batch/budget', methods=['POST'])
def batch_budget():
    """
    BATCH ENDPOINT - Get budget amounts for MULTIPLE accounts and periods in ONE query.
    Much more efficient than individual /budget calls!
    
    POST JSON:
    {
        "accounts": ["60010", "60020", "60030"],
        "periods": ["Jan 2024", "Feb 2024", "Mar 2024"],
        "subsidiary": "Celigo Inc.",
        "budget_category": "FY 2024 Budget",
        "department": "",
        "class": "",
        "location": ""
    }
    
    Returns:
    {
        "budgets": {
            "60010": {
                "Jan 2024": 50000,
                "Feb 2024": 52000,
                "Mar 2024": 54000
            },
            "60020": {
                "Jan 2024": 75000,
                ...
            }
        },
        "query_time": 1.2
    }
    """
    from datetime import datetime
    start_time = datetime.now()
    
    try:
        data = request.get_json() or {}
        
        accounts = data.get('accounts', [])
        periods = data.get('periods', [])
        subsidiary = data.get('subsidiary', '')
        budget_category = data.get('budget_category', '')
        department = data.get('department', '')
        class_id = data.get('class', '')
        location = data.get('location', '')
        accountingbook = data.get('accountingbook', DEFAULT_ACCOUNTING_BOOK)
        
        if not accounts or not periods:
            return jsonify({'error': 'accounts and periods arrays are required'}), 400
        
        print(f"\n{'='*80}", flush=True)
        print(f"📊 BATCH BUDGET REQUEST", flush=True)
        print(f"   Accounts ({len(accounts)}): {accounts[:5]}{'...' if len(accounts) > 5 else ''}", flush=True)
        print(f"   Periods ({len(periods)}): {periods[:5]}{'...' if len(periods) > 5 else ''}", flush=True)
        print(f"   Subsidiary: {subsidiary}", flush=True)
        print(f"   Budget Category: {budget_category}", flush=True)
        print(f"{'='*80}\n", flush=True)
        
        # Convert names to IDs
        subsidiary = convert_name_to_id('subsidiary', subsidiary)
        department = convert_name_to_id('department', department)
        class_id = convert_name_to_id('class', class_id)
        location = convert_name_to_id('location', location)
        
        # Handle accounting book
        if isinstance(accountingbook, str) and accountingbook.strip():
            try:
                accountingbook = int(accountingbook)
            except ValueError:
                accountingbook = DEFAULT_ACCOUNTING_BOOK
        elif not accountingbook:
            accountingbook = DEFAULT_ACCOUNTING_BOOK
        
        # Build WHERE clauses for filters
        where_clauses = []
        
        # Account filter (supports wildcards like '4*' for all revenue accounts)
        account_filter = build_account_filter(accounts)
        where_clauses.append(account_filter)
        
        # Period filter - use IN clause
        escaped_periods = [escape_sql(p) for p in periods]
        periods_in = ", ".join([f"'{p}'" for p in escaped_periods])
        where_clauses.append(f"ap.periodname IN ({periods_in})")
        
        # Subsidiary filter
        if subsidiary and subsidiary != '':
            where_clauses.append(f"b.subsidiary = {subsidiary}")
        
        # Budget category filter - USE CACHE to avoid 429 errors!
        if budget_category and budget_category != '':
            if str(budget_category).isdigit():
                where_clauses.append(f"b.category = {budget_category}")
            else:
                # Use cached lookup (loaded at server startup)
                cat_id = lookup_cache['budget_categories'].get(budget_category.lower())
                if cat_id:
                    where_clauses.append(f"b.category = {cat_id}")
                    print(f"   Budget category '{budget_category}' → ID {cat_id} (from cache)", flush=True)
                else:
                    # Cache miss - fall back to query (shouldn't happen if cache loaded properly)
                    print(f"   ⚠️ Budget category '{budget_category}' not in cache, querying...", flush=True)
                    cat_query = f"SELECT id FROM BudgetCategory WHERE name = '{escape_sql(budget_category)}'"
                    cat_result = query_netsuite(cat_query)
                    if isinstance(cat_result, list) and len(cat_result) > 0:
                        where_clauses.append(f"b.category = {cat_result[0].get('id')}")
                    elif isinstance(cat_result, dict) and 'error' in cat_result:
                        print(f"Budget category lookup failed: {cat_result.get('error')}", flush=True)
                        return jsonify({'error': 'Rate limited by NetSuite', 'details': cat_result.get('details', '')}), 429
        
        # Department filter
        if department and department != '':
            where_clauses.append(f"b.department = {department}")
        
        # Class filter
        if class_id and class_id != '':
            where_clauses.append(f"b.class = {class_id}")
        
        # Location filter
        if location and location != '':
            where_clauses.append(f"b.location = {location}")
        
        # Accounting book filter
        where_clauses.append(f"b.accountingbook = {accountingbook}")
        
        where_clause = " AND ".join(where_clauses)
        
        # Determine target subsidiary for consolidation
        target_sub = subsidiary if subsidiary and subsidiary != '' else (default_subsidiary_id or '1')
        
        # Build the efficient batch query - one query fetches ALL account/period combinations
        query = f"""
            SELECT 
                a.acctnumber,
                ap.periodname,
                SUM(
                    TO_NUMBER(BUILTIN.CONSOLIDATE(
                        bm.amount, 'LEDGER', 'DEFAULT', 'DEFAULT',
                        {target_sub}, bm.period, 'DEFAULT'
                    ))
                ) AS budget_amount
            FROM BudgetsMachine bm
            INNER JOIN Budgets b ON bm.budget = b.id
            INNER JOIN Account a ON b.account = a.id
            INNER JOIN AccountingPeriod ap ON bm.period = ap.id
            WHERE {where_clause}
            GROUP BY a.acctnumber, ap.periodname
        """
        
        print(f"   Running batch budget query...", flush=True)
        result = query_netsuite(query, timeout=60)
        
        # Check for errors
        if isinstance(result, dict) and 'error' in result:
            print(f"❌ Batch budget query failed: {result.get('error')}", flush=True)
            error_details = result.get('details', '')
            if 'CONCURRENCY_LIMIT_EXCEEDED' in str(error_details) or '429' in str(error_details):
                return jsonify({'error': 'Rate limited by NetSuite', 'details': error_details}), 429
            return jsonify({'error': result.get('error'), 'details': error_details}), 500
        
        # Parse results into nested structure
        budgets = {}
        for row in result:
            account = row.get('acctnumber')
            period = row.get('periodname')
            amount = row.get('budget_amount')
            
            if account not in budgets:
                budgets[account] = {}
            
            # Convert to float, default to 0 if null
            budgets[account][period] = float(amount) if amount is not None else 0
        
        # Fill in zeros for any missing account/period combinations
        for account in accounts:
            if account not in budgets:
                budgets[account] = {}
            for period in periods:
                if period not in budgets[account]:
                    budgets[account][period] = 0
        
        elapsed = (datetime.now() - start_time).total_seconds()
        print(f"   ✅ Batch budget complete: {len(result)} results in {elapsed:.2f}s", flush=True)
        print(f"   📊 Accounts with data: {len([a for a in budgets if any(v != 0 for v in budgets[a].values())])}", flush=True)
        
        return jsonify({
            'budgets': budgets,
            'query_time': elapsed,
            'accounts_requested': len(accounts),
            'periods_requested': len(periods)
        })
        
    except Exception as e:
        error_msg = str(e) if str(e) else f"{type(e).__name__}: (no message)"
        print(f"❌ Error in batch_budget: {error_msg}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        return jsonify({'error': error_msg}), 500


@app.route('/budget/all', methods=['GET'])
def get_all_budgets():
    """
    Get all budget data for a given year and optional category.
    Returns all accounts with budget amounts for each month.
    
    Query params:
        - year: Budget year (required, e.g., "2011")
        - category: Budget category name or ID (optional)
        - subsidiary: Subsidiary ID (optional)
    
    Returns: JSON with accounts, monthly amounts, and metadata
    """
    try:
        year = request.args.get('year')
        category = request.args.get('category', '')
        subsidiary = request.args.get('subsidiary', '')
        
        if not year:
            return jsonify({'error': 'year parameter is required'}), 400
        
        # Convert subsidiary name to ID if needed
        subsidiary = convert_name_to_id('subsidiary', subsidiary)
        print(f"Budget/all: year={year}, category={category}, subsidiary={subsidiary}", file=sys.stderr)
        
        # Get period IDs for the year
        period_query = f"""
            SELECT id, periodname, startdate
            FROM AccountingPeriod
            WHERE EXTRACT(YEAR FROM startdate) = {year}
              AND isquarter = 'F'
              AND isyear = 'F'
              AND isadjust = 'F'
            ORDER BY startdate
        """
        period_result = query_netsuite(period_query)
        
        if isinstance(period_result, dict) and 'error' in period_result:
            return jsonify({'error': f"Failed to get periods: {period_result.get('error')}"}), 500
        
        if not period_result or len(period_result) == 0:
            return jsonify({'error': f'No accounting periods found for year {year}'}), 404
        
        # Build period ID to month mapping
        period_map = {}  # period_id -> month name (e.g., "Jan")
        month_names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 
                       'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
        for row in period_result:
            period_id = str(row.get('id'))
            # Extract month from startdate
            startdate = row.get('startdate', '')
            if startdate:
                try:
                    # startdate format: "1/1/2011" or "2011-01-01"
                    if '/' in startdate:
                        month_num = int(startdate.split('/')[0])
                    else:
                        month_num = int(startdate.split('-')[1])
                    if 1 <= month_num <= 12:
                        period_map[period_id] = month_names[month_num - 1]
                except:
                    pass
        
        period_ids = list(period_map.keys())
        if not period_ids:
            return jsonify({'error': f'Could not parse periods for year {year}'}), 500
        
        period_ids_str = ','.join(period_ids)
        
        # Build WHERE clauses
        where_clauses = [f"bm.period IN ({period_ids_str})"]
        
        # Category filter
        if category and category != '':
            if category.isdigit():
                where_clauses.append(f"b.category = {category}")
            else:
                cat_query = f"SELECT id FROM BudgetCategory WHERE name = '{escape_sql(category)}'"
                cat_result = query_netsuite(cat_query)
                if isinstance(cat_result, list) and len(cat_result) > 0:
                    cat_id = cat_result[0].get('id')
                    where_clauses.append(f"b.category = {cat_id}")
        
        # Subsidiary filter
        if subsidiary and subsidiary != '':
            where_clauses.append(f"b.subsidiary = {subsidiary}")
        
        where_clause = " AND ".join(where_clauses)
        
        # Determine target subsidiary for consolidation
        target_sub = subsidiary if subsidiary and subsidiary != '' else (default_subsidiary_id or '1')
        
        # Query all budget data grouped by account and period
        query = f"""
            SELECT 
                a.acctnumber AS account_number,
                a.accountsearchdisplaynamecopy AS account_name,
                a.accttype AS account_type,
                bm.period AS period_id,
                SUM(
                    TO_NUMBER(BUILTIN.CONSOLIDATE(
                        bm.amount, 'LEDGER', 'DEFAULT', 'DEFAULT',
                        {target_sub}, bm.period, 'DEFAULT'
                    ))
                ) AS amount
            FROM BudgetsMachine bm
            INNER JOIN Budgets b ON bm.budget = b.id
            INNER JOIN Account a ON b.account = a.id
            WHERE {where_clause}
            GROUP BY a.acctnumber, a.accountsearchdisplaynamecopy, a.accttype, bm.period
            ORDER BY a.acctnumber, bm.period
        """
        
        print(f"Budget/all query: {query[:500]}...", file=sys.stderr)
        result = query_netsuite(query)
        
        if isinstance(result, dict) and 'error' in result:
            return jsonify({'error': f"Query failed: {result.get('error')}"}), 500
        
        # Process results into account-based structure
        accounts = {}
        account_names = {}
        account_types = {}
        
        if isinstance(result, list):
            for row in result:
                acct_num = str(row.get('account_number', ''))
                acct_name = row.get('account_name', '')
                acct_type = row.get('account_type', '')
                period_id = str(row.get('period_id', ''))
                amount = row.get('amount', 0) or 0
                
                if acct_num not in accounts:
                    accounts[acct_num] = {}
                    account_names[acct_num] = acct_name
                    account_types[acct_num] = acct_type
                
                # Map period ID to month name
                month_name = period_map.get(period_id, '')
                if month_name:
                    key = f"{month_name} {year}"
                    accounts[acct_num][key] = float(amount)
        
        # Get available budget categories for the year
        cat_query = f"""
            SELECT DISTINCT bc.id, bc.name
            FROM Budgets b
            INNER JOIN BudgetCategory bc ON b.category = bc.id
            WHERE b.year IN (
                SELECT id FROM AccountingPeriod 
                WHERE isyear = 'T' AND EXTRACT(YEAR FROM startdate) = {year}
            )
            ORDER BY bc.name
        """
        cat_result = query_netsuite(cat_query)
        categories = []
        if isinstance(cat_result, list):
            categories = [{'id': str(r.get('id')), 'name': r.get('name')} for r in cat_result]
        
        return jsonify({
            'year': year,
            'category': category,
            'accounts': accounts,
            'account_names': account_names,
            'account_types': account_types,
            'categories': categories,
            'period_map': period_map,
            'account_count': len(accounts)
        })
        
    except Exception as e:
        print(f"Error in get_all_budgets: {str(e)}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/transactions', methods=['GET'])
def get_transactions():
    """
    Get transaction-level details for drill-down
    Used for: Drill-down from balance cells to see underlying transactions
    
    Query params:
        - account: Account number (required)
        - period: Period name (required)
        - subsidiary: Subsidiary ID (optional)
        - class: Class ID (optional)
        - department: Department ID (optional)
        - location: Location ID (optional)
    
    Returns: JSON with transaction details including NetSuite URLs
    """
    try:
        account = request.args.get('account')
        period = request.args.get('period')
        raw_subsidiary = request.args.get('subsidiary', '')
        class_id = request.args.get('class', '')
        department = request.args.get('department', '')
        location = request.args.get('location', '')
        
        # Convert names to IDs (accepts names OR IDs)
        subsidiary = convert_name_to_id('subsidiary', raw_subsidiary)
        class_id = convert_name_to_id('class', class_id)
        department = convert_name_to_id('department', department)
        location = convert_name_to_id('location', location)
        
        # Determine consolidated status (explicit OR auto from root)
        wants_consolidated = should_use_consolidated(raw_subsidiary, subsidiary)
        
        if not account or not period:
            return jsonify({'error': 'Missing required parameters: account and period'}), 400
        
        is_wildcard = '*' in str(account)
        print(f"DEBUG - Transaction drill-down request:", file=sys.stderr)
        print(f"  Account: {account} {'(WILDCARD)' if is_wildcard else ''}", file=sys.stderr)
        print(f"  Period: {period}", file=sys.stderr)
        print(f"  Subsidiary: {subsidiary}", file=sys.stderr)
        print(f"  Department: {department}", file=sys.stderr)
        print(f"  Class: {class_id}", file=sys.stderr)
        print(f"  Location: {location}", file=sys.stderr)
        
        # Build WHERE clause with filters
        # Use build_account_filter to support wildcards like '4*'
        account_filter = build_account_filter([account])
        
        where_conditions = [
            "t.posting = 'T'",
            "tal.posting = 'T'",
            account_filter  # Supports wildcards like '4*' → LIKE '4%'
        ]
        
        # Handle period - could be year-only ("2025") or month ("Dec 2025")
        if is_year_only(period):
            # Year-only: get all transactions in that year
            year = period.strip()
            where_conditions.append(f"t.trandate >= TO_DATE('{year}-01-01', 'YYYY-MM-DD')")
            where_conditions.append(f"t.trandate <= TO_DATE('{year}-12-31', 'YYYY-MM-DD')")
            print(f"DEBUG - Year-only period '{period}' → full year date range", file=sys.stderr)
        else:
            # Specific month period
            where_conditions.append(f"ap.periodname = '{escape_sql(period)}'")
        
        # CRITICAL: Use tl.subsidiary for GL line-level filtering (intercompany JEs)
        needs_line_join = False
        if subsidiary:
            use_hierarchy = wants_consolidated
            
            if use_hierarchy:
                hierarchy_subs = get_subsidiaries_in_hierarchy(subsidiary)
                sub_filter = ', '.join(hierarchy_subs)
                where_conditions.append(f"tl.subsidiary IN ({sub_filter})")
            else:
                where_conditions.append(f"tl.subsidiary = {subsidiary}")
            needs_line_join = True
        
        # Also need TransactionLine join if filtering by department, class, or location
        if (department and department != '') or (class_id and class_id != '') or (location and location != ''):
            needs_line_join = True
        
        if class_id:
            where_conditions.append(f"tl.class = {class_id}")
        if department:
            where_conditions.append(f"tl.department = {department}")
        if location:
            where_conditions.append(f"tl.location = {location}")
        
        where_clause = " AND ".join(where_conditions)
        
        # SuiteQL query for transaction details
        # For drill-down, we show RAW transaction amounts (no consolidation)
        # This gives users the actual transaction detail, not consolidated view
        # NOTE: No ORDER BY here - pagination function adds it
        if needs_line_join:
            query = f"""
                SELECT 
                    t.id AS transaction_id,
                    t.tranid AS transaction_number,
                    t.trandisplayname AS transaction_type,
                    t.recordtype AS record_type,
                    TO_CHAR(t.trandate, 'YYYY-MM-DD') AS transaction_date,
                    e.entityid AS entity_name,
                    e.id AS entity_id,
                    t.memo,
                    SUM(COALESCE(tal.debit, 0)) AS debit,
                    SUM(COALESCE(tal.credit, 0)) AS credit,
                    a.acctnumber AS account_number,
                    a.accountsearchdisplayname AS account_name
                FROM 
                    Transaction t
                INNER JOIN 
                    TransactionLine tl ON t.id = tl.transaction
                INNER JOIN 
                    TransactionAccountingLine tal ON t.id = tal.transaction AND tl.id = tal.transactionline
                INNER JOIN 
                    Account a ON tal.account = a.id
                INNER JOIN
                    AccountingPeriod ap ON t.postingperiod = ap.id
                LEFT JOIN
                    Entity e ON t.entity = e.id
                WHERE 
                    {where_clause}
                GROUP BY
                    t.id, t.tranid, t.trandisplayname, t.recordtype, t.trandate,
                    e.entityid, e.id, t.memo, a.acctnumber, a.accountsearchdisplayname
            """
        else:
            query = f"""
                SELECT 
                    t.id AS transaction_id,
                    t.tranid AS transaction_number,
                    t.trandisplayname AS transaction_type,
                    t.recordtype AS record_type,
                    TO_CHAR(t.trandate, 'YYYY-MM-DD') AS transaction_date,
                    e.entityid AS entity_name,
                    e.id AS entity_id,
                    t.memo,
                    SUM(COALESCE(tal.debit, 0)) AS debit,
                    SUM(COALESCE(tal.credit, 0)) AS credit,
                    a.acctnumber AS account_number,
                    a.accountsearchdisplayname AS account_name
                FROM 
                    Transaction t
                INNER JOIN 
                    TransactionAccountingLine tal ON t.id = tal.transaction
                INNER JOIN 
                    Account a ON tal.account = a.id
                INNER JOIN
                    AccountingPeriod ap ON t.postingperiod = ap.id
                LEFT JOIN
                    Entity e ON t.entity = e.id
                WHERE 
                    {where_clause}
                GROUP BY
                    t.id, t.tranid, t.trandisplayname, t.recordtype, t.trandate,
                    e.entityid, e.id, t.memo, a.acctnumber, a.accountsearchdisplayname
            """
        
        print(f"DEBUG - Transaction drill-down query (paginated):\n{query[:500]}...", file=sys.stderr)
        # Use paginated query to handle > 1000 transactions
        result = query_netsuite_paginated(query, timeout=60, order_by="t.trandate, t.tranid")
        
        print(f"DEBUG - Query result type: {type(result)}", file=sys.stderr)
        if isinstance(result, list):
            print(f"DEBUG - Found {len(result)} transactions", file=sys.stderr)
            if len(result) > 0:
                # Log first transaction to see column names and values
                print(f"DEBUG - First transaction raw data: {result[0]}", file=sys.stderr)
                print(f"DEBUG - Column names: {list(result[0].keys())}", file=sys.stderr)
        
        if isinstance(result, dict) and 'error' in result:
            print(f"DEBUG - Query error: {result}", file=sys.stderr)
            return jsonify(result), 500
        
        # Add NetSuite URL to each transaction
        for row in result:
            transaction_id = row.get('transaction_id')
            record_type = row.get('record_type', '').lower()
            
            # Map record types to NetSuite URL paths
            type_map = {
                'invoice': 'custinvc',
                'bill': 'vendorbill',
                'journalentry': 'journal',
                'journal': 'journal',
                'payment': 'custpymt',
                'vendorpayment': 'vendpymt',
                'creditmemo': 'custcred',
                'vendorcredit': 'vendcred',
                'check': 'check',
                'deposit': 'deposit',
                'cashsale': 'cashsale',
                'cashrefund': 'cashrfnd',
                'expensereport': 'exprept'
            }
            
            url_type = type_map.get(record_type, record_type)
            row['netsuite_url'] = f"https://{account_id}.app.netsuite.com/app/accounting/transactions/{url_type}.nl?id={transaction_id}"
            
            # Calculate net amount for this account
            debit = float(row.get('debit', 0)) if row.get('debit') else 0
            credit = float(row.get('credit', 0)) if row.get('credit') else 0
            row['net_amount'] = debit - credit
        
        return jsonify({
            'transactions': result,
            'count': len(result),
            'filters': {
                'account': account,
                'period': period,
                'subsidiary': subsidiary,
                'class': class_id,
                'department': department,
                'location': location
            }
        })
        
    except Exception as e:
        print(f"Error in get_transactions: {str(e)}", file=sys.stderr)
        return jsonify({'error': str(e)}), 500


@app.route('/test')
def test_connection():
    """Test NetSuite connection"""
    try:
        # Simple query to test connection
        query = "SELECT COUNT(*) as count FROM Account WHERE isinactive = 'F'"
        result = query_netsuite(query)
        
        if isinstance(result, dict) and 'error' in result:
            return jsonify({
                'status': 'error',
                'error': result['error'],
                'details': result.get('details', '')
            }), 500
        
        return jsonify({
            'status': 'success',
            'message': 'NetSuite connection successful',
            'account': account_id,
            'active_accounts': result[0].get('count', 0) if result else 0
        })
        
    except Exception as e:
        return jsonify({
            'status': 'error',
            'error': str(e)
        }), 500


# ============================================================================
# LOOKUP ENDPOINTS - For Excel dropdowns/data validation
# ============================================================================

@app.route('/lookups/accounts')
def get_all_accounts():
    """
    Get Income accounts for the Guide Me wizard.
    Returns account type, number, and name (clean display name).
    Filters to Income accounts only for a cleaner starter report.
    """
    try:
        # Filter to Income accounts for a focused starter report
        # Use accountsearchdisplaynamecopy for clean name (without hierarchy prefix)
        query = """
            SELECT 
                acctnumber AS number,
                accountsearchdisplaynamecopy AS name,
                accttype AS type
            FROM Account
            WHERE isinactive = 'F'
              AND accttype = 'Income'
            ORDER BY acctnumber
        """
        
        result = query_netsuite(query)
        
        if isinstance(result, dict) and 'error' in result:
            return jsonify({'error': result['error']}), 500
            
        accounts = []
        if isinstance(result, list):
            for row in result:
                accounts.append({
                    'type': row.get('type', ''),
                    'number': str(row.get('number', '')),
                    'name': row.get('name', '')
                })
        
        print(f"✓ Returning {len(accounts)} Income accounts")
        return jsonify(accounts)
        
    except Exception as e:
        print(f"❌ Account lookup error: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/lookups/accountingbooks')
def get_accounting_books():
    """
    Get list of accounting books for Multi-Book Accounting.
    Returns all active accounting books (Primary and Secondary).
    
    NetSuite Multi-Book Accounting allows maintaining multiple sets of books
    for different accounting standards (GAAP, IFRS, Tax, etc.)
    """
    try:
        query = """
            SELECT 
                id,
                name,
                isprimary
            FROM AccountingBook
            WHERE isinactive = 'F'
            ORDER BY isprimary DESC, name
        """
        
        result = query_netsuite(query)
        
        if isinstance(result, dict) and 'error' in result:
            return jsonify({'error': result['error']}), 500
        
        books = []
        if isinstance(result, list):
            for row in result:
                book_name = row.get('name', '')
                is_primary = row.get('isprimary', 'F') == 'T'
                # Mark primary book for clarity
                if is_primary:
                    book_name = f"{book_name} (Primary)"
                books.append({
                    'id': str(row.get('id', '')),
                    'name': book_name,
                    'isPrimary': is_primary
                })
        
        print(f"✓ Returning {len(books)} accounting books")
        return jsonify(books)
        
    except Exception as e:
        print(f"❌ Accounting books lookup error: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/lookups/all')
def get_all_lookups():
    """
    Get all lookups at once - Subsidiary, Department, Location, Class, Accounting Books
    Returns data from the in-memory cache (already loaded at startup)
    
    For subsidiaries that are parents (have children), we also add a "(Consolidated)" option
    which uses BUILTIN.CONSOLIDATE to include parent + all children transactions
    """
    try:
        # Load cache if not already loaded
        if not cache_loaded:
            load_lookup_cache()
        
        # Convert cache format (name→id) to list format (id, name) for frontend
        lookups = {
            'subsidiaries': [],
            'departments': [],
            'classes': [],
            'locations': [],
            'accountingBooks': []
        }
        
        # Get subsidiary hierarchy to identify parents
        try:
            hierarchy_query = """
                SELECT id, name, parent
                FROM Subsidiary
                WHERE isinactive = 'F'
                ORDER BY name
            """
            hierarchy_result = query_netsuite(hierarchy_query)
            
            # Identify parent subsidiaries (those with children)
            parent_ids = set()
            all_subs = {}
            
            if isinstance(hierarchy_result, list):
                # First pass: collect all subsidiaries and their parents
                for row in hierarchy_result:
                    sub_id = str(row['id'])
                    parent_id = str(row['parent']) if row.get('parent') else None
                    all_subs[sub_id] = {
                        'name': row['name'],
                        'parent': parent_id
                    }
                    if parent_id:
                        parent_ids.add(parent_id)
                
                # Second pass: calculate depth for each subsidiary
                def get_depth(sub_id):
                    depth = 0
                    current = sub_id
                    while current and current in all_subs and all_subs[current]['parent']:
                        depth += 1
                        current = all_subs[current]['parent']
                    return depth
                
                # Add all subsidiaries with hierarchy info
                for sub_id, sub_info in all_subs.items():
                    depth = get_depth(sub_id)
                    lookups['subsidiaries'].append({
                        'id': sub_id,
                        'name': sub_info['name'],
                        'parent': sub_info['parent'],
                        'depth': depth
                    })
                    
                    # If this is a parent, also add "(Consolidated)" version
                    if sub_id in parent_ids:
                        lookups['subsidiaries'].append({
                            'id': sub_id,  # Same ID, BUILTIN.CONSOLIDATE handles consolidation
                            'name': f"{sub_info['name']} (Consolidated)",
                            'parent': sub_info['parent'],
                            'depth': depth,
                            'isConsolidated': True
                        })
        except Exception as e:
            print(f"Error loading subsidiary hierarchy: {e}", file=sys.stderr)
            # Fallback to cache
            for name, id_val in lookup_cache['subsidiaries'].items():
                lookups['subsidiaries'].append({
                    'id': id_val,
                    'name': name.title()
                })
        
        # Load Departments directly from table for proper display names
        try:
            dept_query = """
                SELECT id, name, fullName, isinactive 
                FROM Department 
                WHERE isinactive = 'F'
                ORDER BY fullName
            """
            dept_result = query_netsuite(dept_query)
            if isinstance(dept_result, list):
                for row in dept_result:
                    lookups['departments'].append({
                        'id': str(row['id']),
                        'name': row.get('fullname') or row['name']  # Use fullName for hierarchy display
                    })
        except Exception as e:
            print(f"Error loading departments for lookup: {e}", file=sys.stderr)
            # Fallback to cache
            for name, id_val in lookup_cache['departments'].items():
                lookups['departments'].append({'id': id_val, 'name': name.title()})
        
        # Load Classes directly from table for proper display names
        try:
            class_query = """
                SELECT id, name, fullName, isinactive 
                FROM Classification 
                WHERE isinactive = 'F'
                ORDER BY fullName
            """
            class_result = query_netsuite(class_query)
            if isinstance(class_result, list):
                for row in class_result:
                    lookups['classes'].append({
                        'id': str(row['id']),
                        'name': row.get('fullname') or row['name']  # Use fullName for hierarchy display
                    })
        except Exception as e:
            print(f"Error loading classes for lookup: {e}", file=sys.stderr)
            # Fallback to cache
            for name, id_val in lookup_cache['classes'].items():
                lookups['classes'].append({'id': id_val, 'name': name.title()})
        
        # Load Locations directly from table for proper display names
        try:
            loc_query = """
                SELECT id, name, fullName, isinactive 
                FROM Location 
                WHERE isinactive = 'F'
                ORDER BY fullName
            """
            loc_result = query_netsuite(loc_query)
            if isinstance(loc_result, list):
                for row in loc_result:
                    lookups['locations'].append({
                        'id': str(row['id']),
                        'name': row.get('fullname') or row['name']  # Use fullName for hierarchy display
                    })
        except Exception as e:
            print(f"Error loading locations for lookup: {e}", file=sys.stderr)
            # Fallback to cache
            for name, id_val in lookup_cache['locations'].items():
                lookups['locations'].append({'id': id_val, 'name': name})
        
        # Fetch accounting books (Multi-Book Accounting)
        # Try multiple approaches since different NetSuite versions/permissions may vary
        books_loaded = False
        try:
            # Approach 1: Try to get distinct accounting books from transactions
            # This works even without direct AccountingBook table access
            books_query = """
                SELECT DISTINCT tal.accountingbook AS id
                FROM TransactionAccountingLine tal
                WHERE tal.accountingbook IS NOT NULL
            """
            books_result = query_netsuite(books_query, timeout=15)
            
            if isinstance(books_result, list) and len(books_result) > 0:
                print(f"✓ Found {len(books_result)} accounting books from transactions", file=sys.stderr)
                for row in books_result:
                    book_id = str(row.get('id', ''))
                    # ID 1 is always Primary Book in NetSuite
                    is_primary = book_id == '1'
                    book_name = f"Book {book_id}" if book_id != '1' else "Primary Book"
                    lookups['accountingBooks'].append({
                        'id': book_id,
                        'name': book_name,
                        'isPrimary': is_primary
                    })
                books_loaded = True
        except Exception as e:
            print(f"Approach 1 (distinct from TAL) failed: {e}", file=sys.stderr)
        
        if not books_loaded:
            # Approach 2: Default to Primary Book (always exists)
            print(f"Using default Primary Book (ID 1)", file=sys.stderr)
            lookups['accountingBooks'].append({
                'id': '1',
                'name': 'Primary Book',
                'isPrimary': True
            })
        
        # Fetch budget categories
        lookups['budgetCategories'] = []
        try:
            cat_query = """
                SELECT id, name
                FROM BudgetCategory
                ORDER BY name
            """
            cat_result = query_netsuite(cat_query)
            
            if isinstance(cat_result, list):
                for row in cat_result:
                    lookups['budgetCategories'].append({
                        'id': str(row.get('id', '')),
                        'name': row.get('name', '')
                    })
        except Exception as e:
            print(f"Error loading budget categories: {e}", file=sys.stderr)
            # Budget categories may not exist in all accounts
        
        return jsonify(lookups)
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/lookups/budget-categories')
def get_budget_categories():
    """
    Get available budget categories from NetSuite.
    Budget categories are used to organize different budget versions
    (e.g., "FY 2024 Budget", "FY 2024 Forecast", "Legacy").
    
    Returns: {
        "categories": [
            {"id": "2", "name": "FY 2024 Budget"},
            {"id": "1", "name": "Legacy"}
        ]
    }
    """
    try:
        query = """
            SELECT id, name
            FROM BudgetCategory
            ORDER BY name
        """
        result = query_netsuite(query)
        
        if isinstance(result, dict) and 'error' in result:
            return jsonify({
                'categories': [],
                'error': 'Budget categories not available (feature may not be enabled)'
            })
        
        categories = []
        if isinstance(result, list):
            for row in result:
                categories.append({
                    'id': str(row.get('id', '')),
                    'name': row.get('name', '')
                })
        
        return jsonify({
            'categories': categories,
            'count': len(categories)
        })
        
    except Exception as e:
        return jsonify({
            'categories': [],
            'error': str(e)
        }), 500


@app.route('/lookups/currencies')
def get_currencies():
    """
    Get currency symbols for each subsidiary.
    Used by Excel frontend to format cells with the correct currency symbol.
    
    Returns: {
        "currencies": {
            "1": "$",      // Subsidiary ID 1 uses USD
            "2": "₹",      // Subsidiary ID 2 uses INR
            "3": "A$",     // Subsidiary ID 3 uses AUD
            ...
        },
        "default_subsidiary": "1",
        "formats": {
            "$": "$#,##0.00",
            "€": "€#,##0.00",
            "£": "£#,##0.00",
            ...
        }
    }
    """
    try:
        # Load cache if not already loaded
        if not cache_loaded:
            load_lookup_cache()
        
        # Map ISO currency codes to display symbols
        # NetSuite returns codes like "USD", we want symbols like "$"
        code_to_symbol = {
            'USD': '$',
            'EUR': '€',
            'GBP': '£',
            'JPY': '¥',
            'CNY': '¥',
            'INR': '₹',
            'AUD': 'A$',
            'CAD': 'C$',
            'HKD': 'HK$',
            'SGD': 'S$',
            'NZD': 'NZ$',
            'CHF': 'CHF',
            'SEK': 'kr',
            'NOK': 'kr',
            'DKK': 'kr',
            'BRL': 'R$',
            'ZAR': 'R',
            'KRW': '₩',
            'MXN': '$',
            'PLN': 'zł',
            'CZK': 'Kč',
            'HUF': 'Ft',
            'RON': 'lei',
            'THB': '฿',
            'PHP': '₱',
            'MYR': 'RM',
            'IDR': 'Rp',
            'VND': '₫',
            'TWD': 'NT$',
            'ILS': '₪',
            'TRY': '₺',
            'RUB': '₽',
            'AED': 'د.إ',
            'SAR': '﷼',
        }
        
        # Excel number formats for currency symbols
        symbol_formats = {
            '$': '$#,##0.00',
            '€': '€#,##0.00',
            '£': '£#,##0.00',
            '¥': '¥#,##0',
            '₹': '[$₹-en-IN]#,##0.00',
            'A$': '[$A$-en-AU]#,##0.00',
            'C$': '[$C$-en-CA]#,##0.00',
            'HK$': '[$HK$-zh-HK]#,##0.00',
            'S$': '[$S$-en-SG]#,##0.00',
            'NZ$': '[$NZ$-en-NZ]#,##0.00',
            'CHF': '[$CHF-de-CH] #,##0.00',
            'kr': '[$kr-sv-SE] #,##0.00',
            'R$': '[$R$-pt-BR] #,##0.00',
            'R': '[$R-en-ZA] #,##0.00',
            '₩': '[$₩-ko-KR]#,##0',
            'zł': '#,##0.00 [$zł-pl-PL]',
            'Kč': '#,##0.00 [$Kč-cs-CZ]',
            'Ft': '#,##0 [$Ft-hu-HU]',
            'lei': '#,##0.00 [$lei-ro-RO]',
            '฿': '[$฿-th-TH]#,##0.00',
            '₱': '[$₱-en-PH]#,##0.00',
            'RM': '[$RM-ms-MY] #,##0.00',
            'Rp': '[$Rp-id-ID] #,##0',
            '₫': '#,##0 [$₫-vi-VN]',
            'NT$': '[$NT$-zh-TW]#,##0',
            '₪': '[$₪-he-IL]#,##0.00',
            '₺': '[$₺-tr-TR]#,##0.00',
            '₽': '#,##0.00 [$₽-ru-RU]',
            'د.إ': '[$د.إ-ar-AE] #,##0.00',
            '﷼': '[$﷼-ar-SA] #,##0.00',
        }
        
        def get_symbol(code):
            """Convert currency code to symbol"""
            return code_to_symbol.get(code, code)  # Return code if no mapping
        
        def get_format_for_symbol(symbol):
            """Get Excel format for currency symbol"""
            if symbol in symbol_formats:
                return symbol_formats[symbol]
            # Default format: symbol prefix with quotes
            return f'[${symbol}] #,##0.00'
        
        # Convert currency codes to symbols in the response
        currencies_with_symbols = {}
        for sub_id, code in lookup_cache.get('currencies', {}).items():
            currencies_with_symbols[sub_id] = get_symbol(code)
        
        # Build response with currencies and their formats
        response = {
            'currencies': currencies_with_symbols,
            'default_subsidiary': default_subsidiary_id or '1',
            'formats': {}
        }
        
        # Add format for each unique currency symbol
        for sub_id, symbol in currencies_with_symbols.items():
            if symbol not in response['formats']:
                response['formats'][symbol] = get_format_for_symbol(symbol)
        
        return jsonify(response)
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ============================================================================
# RETAINED EARNINGS, NET INCOME, and CTA CALCULATIONS
# These equity line items are calculated by NetSuite at runtime - no account to query
# ============================================================================

def get_fiscal_year_for_period(period_name, accountingbook=None):
    """
    Get the fiscal year containing the specified period.
    Works for any fiscal calendar (calendar year, Apr-Mar, etc.)
    CACHED to avoid repeated API calls for same period.
    
    Args:
        period_name: Period name like "Mar 2025"
        accountingbook: Accounting book ID (optional)
        
    Returns:
        dict with: fiscal_year_id, fy_start, fy_end, period_id, period_start, period_end
        or None if not found
    """
    global fiscal_year_cache
    
    # Check cache first
    cache_key = f"{period_name}:{accountingbook or ''}"
    if cache_key in fiscal_year_cache:
        print(f"   [FY CACHE HIT] {period_name}")
        return fiscal_year_cache[cache_key]
    
    print(f"   [FY CACHE MISS] {period_name} - querying NetSuite...")
    
    # Use period's parent hierarchy to find the correct fiscal year
    # This ensures we use the fiscal year the period actually belongs to,
    # not just any fiscal year that overlaps with the period dates
    query = f"""
        SELECT 
            fy.id AS fiscal_year_id,
            fy.startdate AS fy_start,
            fy.enddate AS fy_end,
            tp.id AS period_id,
            tp.startdate AS period_start,
            tp.enddate AS period_end
        FROM accountingperiod tp
        LEFT JOIN accountingperiod q ON q.id = tp.parent AND q.isquarter = 'T'
        LEFT JOIN accountingperiod fy ON (
            (q.parent IS NOT NULL AND fy.id = q.parent) OR  -- Month → Quarter → Year
            (q.parent IS NULL AND tp.parent IS NOT NULL AND fy.id = tp.parent)  -- Month → Year (no quarters)
        )
        WHERE LOWER(tp.periodname) = LOWER('{escape_sql(period_name)}')
          AND tp.isquarter = 'F'
          AND tp.isyear = 'F'
          AND fy.isyear = 'T'
        FETCH FIRST 1 ROWS ONLY
    """
    
    result = query_netsuite(query)
    if isinstance(result, list) and len(result) > 0:
        row = result[0]
        fy_info = {
            'fiscal_year_id': row.get('fiscal_year_id'),
            'fy_start': row.get('fy_start'),
            'fy_end': row.get('fy_end'),
            'period_id': row.get('period_id'),
            'period_start': row.get('period_start'),
            'period_end': row.get('period_end')
        }
        # Cache the result
        fiscal_year_cache[cache_key] = fy_info
        print(f"   [FY CACHED] {period_name} → FY {fy_info['fy_start']} - {fy_info['fy_end']}")
        return fy_info
    
    print(f"   [FY NOT FOUND] {period_name}")
    return None


def build_segment_filter(filters, prefix='tal'):
    """Build WHERE clause additions for segment filters (class, dept, location)"""
    clauses = []
    if filters.get('subsidiary'):
        clauses.append(f"{prefix}.subsidiary = {filters['subsidiary']}")
    if filters.get('department'):
        clauses.append(f"{prefix}.department = {filters['department']}")
    if filters.get('location'):
        clauses.append(f"{prefix}.location = {filters['location']}")
    if filters.get('classId'):
        clauses.append(f"{prefix}.class = {filters['classId']}")
    return ' AND '.join(clauses) if clauses else ''


def resolve_subsidiary_id(subsidiary_param):
    """
    Resolve subsidiary parameter to a numeric ID.
    Accepts: numeric ID as string/int, or subsidiary name.
    Returns: numeric ID as string, or None if not found.
    """
    if not subsidiary_param:
        return None
    
    sub_str = str(subsidiary_param).strip()
    
    # If it's already numeric, return it
    if sub_str.isdigit():
        return sub_str
    
    # Look up by name in cache
    sub_lower = sub_str.lower()
    # Handle "(Consolidated)" suffix
    if sub_lower.endswith(' (consolidated)'):
        sub_lower = sub_lower.replace(' (consolidated)', '')
    
    for name, id_val in lookup_cache.get('subsidiaries', {}).items():
        if name.lower() == sub_lower:
            return str(id_val)
    
    # Not found in cache - try direct lookup
    query = f"""
        SELECT id FROM subsidiary 
        WHERE LOWER(name) = '{escape_sql(sub_lower)}'
        AND isinactive = 'F'
        FETCH FIRST 1 ROWS ONLY
    """
    result = query_netsuite(query, timeout=10)
    if isinstance(result, list) and len(result) > 0:
        return str(result[0].get('id'))
    
    return None


def build_consolidate_amount(target_sub, period_ref='t.postingperiod'):
    """
    Build the BUILTIN.CONSOLIDATE SQL fragment for multi-currency consolidation.
    
    BUILTIN.CONSOLIDATE works universally:
    - OneWorld: Performs currency consolidation to parent subsidiary
    - Non-OneWorld: Passes through amount unchanged
    
    Parameters for BUILTIN.CONSOLIDATE (NetSuite SuiteQL):
    - 'LEDGER' - Consolidation type
    - 'DEFAULT' - Rate type  
    - 'DEFAULT' - Adjustment option
    - target_sub - Target subsidiary ID (defaults to 1 if not provided)
    - period_ref - Period reference
    - 'DEFAULT' - Elimination option (handles intercompany)
    
    Args:
        target_sub: Target subsidiary ID for consolidation
        period_ref: SQL reference to the period (default: t.postingperiod)
    
    Returns:
        SQL fragment that calculates consolidated amount
    """
    # Always use BUILTIN.CONSOLIDATE - it works for both OneWorld and non-OneWorld
    return f"""
        TO_NUMBER(
            BUILTIN.CONSOLIDATE(
                tal.amount,
                'LEDGER',
                'DEFAULT',
                'DEFAULT',
                {target_sub or 1},
                {period_ref},
                'DEFAULT'
            )
        )
    """


@app.route('/retained-earnings', methods=['POST'])
def calculate_retained_earnings():
    """
    Calculate Retained Earnings (prior years' cumulative P&L)
    
    RE = Sum of all P&L transactions from inception through prior fiscal year end
       + Any manual journal entries posted directly to RetainedEarnings accounts
    
    Request body: {
        period: "Mar 2025",
        subsidiary: "1" or "Celigo Inc." (optional),
        accountingBook: "1" (optional),
        classId: "1" (optional),
        department: "1" (optional),
        location: "1" (optional)
    }
    """
    try:
        params = request.json or {}
        period_name = params.get('period', '')
        subsidiary_param = params.get('subsidiary', '')
        accountingbook = params.get('accountingBook') or DEFAULT_ACCOUNTING_BOOK
        classId = params.get('classId', '')
        department = params.get('department', '')
        location = params.get('location', '')
        
        print(f"📊 Calculating Retained Earnings for {period_name}")
        
        # Resolve subsidiary name to ID if needed
        subsidiary = resolve_subsidiary_id(subsidiary_param) if subsidiary_param else None
        if subsidiary_param and not subsidiary:
            print(f"   ⚠️ Could not resolve subsidiary: {subsidiary_param}")
        else:
            print(f"   Subsidiary: {subsidiary_param} → ID {subsidiary}")
        
        # Step 1: Get fiscal year boundaries for this period
        fy_info = get_fiscal_year_for_period(period_name, accountingbook)
        if not fy_info:
            return jsonify({'error': f'Could not find fiscal year for period {period_name}'}), 400
        
        fy_start = fy_info['fy_start']
        print(f"   Fiscal year starts: {fy_start}")
        
        # Use default subsidiary if none specified (for consolidation)
        target_sub = subsidiary if subsidiary else (default_subsidiary_id or '1')
        
        # ═══════════════════════════════════════════════════════════════════════
        # CRITICAL: Get all subsidiaries in the target's hierarchy for consolidated view
        # For Retained Earnings, we need transactions from ALL subsidiaries that roll up
        # to the target subsidiary, not just the target itself
        # ═══════════════════════════════════════════════════════════════════════
        hierarchy_subs = get_subsidiaries_in_hierarchy(target_sub)
        sub_filter = ', '.join(hierarchy_subs)
        print(f"   Subsidiary hierarchy: {len(hierarchy_subs)} subsidiaries")
        
        # Build segment filters - use tl.subsidiary for GL line-level filtering (intercompany JEs)
        segment_filters = []
        segment_filters.append(f"tl.subsidiary IN ({sub_filter})")  # Always filter by hierarchy at line level
        if department:
            segment_filters.append(f"tl.department = {department}")
        if location:
            segment_filters.append(f"tl.location = {location}")
        if classId:
            segment_filters.append(f"tl.class = {classId}")
        
        segment_where = ' AND ' + ' AND '.join(segment_filters) if segment_filters else ''
        
        # Always need TransactionLine join for tl.subsidiary filter
        needs_tl_join = True  # Required for tl.subsidiary filter
        tl_join = "JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id" if needs_tl_join else ""
        
        # Parse fy_start date for comparison
        from datetime import datetime
        try:
            fy_start_date = datetime.strptime(fy_start, '%m/%d/%Y').strftime('%Y-%m-%d')
        except:
            fy_start_date = fy_start
        
        # Step 2: Sum prior years' P&L with consolidation
        # Query all Income/Expense transactions from inception through the day before FY started
        # Use BUILTIN.CONSOLIDATE with 'ELIMINATE' for proper intercompany elimination
        # Sign convention: ALL P&L amounts flip Income, plus OthExpense for foreign subs
        # Result: Positive = accumulated profit, Negative = accumulated loss
        
        # CRITICAL: Get target period ID for BUILTIN.CONSOLIDATE
        # ALL Balance Sheet amounts must be translated at the report period-end rate
        target_period_id = fy_info['period_id']
        print(f"   Target period ID: {target_period_id} (for period-end exchange rates)")
        
        # Build simpler consolidation SQL without CROSS JOIN (faster execution)
        if target_sub:
            cons_amount = f"""TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', {target_sub}, {target_period_id}, 'DEFAULT'))"""
        else:
            cons_amount = "tal.amount"
        
        # Sign multiplier: flip Income/OthIncome from credits (negative) to positive display
        re_sign_sql = f"* CASE WHEN a.accttype IN ({INCOME_TYPES_SQL}) THEN -1 ELSE 1 END"
        
        # Get period_end_date for posted RE query
        period_end = fy_info['period_end']
        try:
            period_end_date = datetime.strptime(period_end, '%m/%d/%Y').strftime('%Y-%m-%d')
        except:
            period_end_date = period_end
        
        # ═══════════════════════════════════════════════════════════════════════
        # PARALLEL QUERY EXECUTION - Run queries concurrently to reduce time
        # ═══════════════════════════════════════════════════════════════════════
        print(f"   Running queries in PARALLEL...")
        
        # Define queries
        prior_pl_query = f"""
            SELECT SUM({cons_amount} {re_sign_sql} ) AS value
            FROM transactionaccountingline tal
            JOIN transaction t ON t.id = tal.transaction
            JOIN account a ON a.id = tal.account
            JOIN accountingperiod ap ON ap.id = t.postingperiod
            {tl_join}
            WHERE t.posting = 'T'
              AND tal.posting = 'T'
              AND a.accttype IN ({PL_TYPES_SQL})
              AND ap.enddate < TO_DATE('{fy_start_date}', 'YYYY-MM-DD')
              AND tal.accountingbook = {accountingbook}
              {segment_where}
        """
        
        # Posted RE query - query directly by account type/name pattern instead of 2-step
        # Note: This queries RetainedEarnings accounts (BS type), not Income types, so no flip needed
        posted_re_query = f"""
            SELECT SUM({cons_amount}) AS value
            FROM transactionaccountingline tal
            JOIN transaction t ON t.id = tal.transaction
            JOIN account a ON a.id = tal.account
            JOIN accountingperiod ap ON ap.id = t.postingperiod
            {tl_join}
            WHERE t.posting = 'T'
              AND tal.posting = 'T'
              AND (a.accttype = 'RetainedEarnings' OR LOWER(a.fullname) LIKE '%retained earnings%')
              AND ap.enddate <= TO_DATE('{period_end_date}', 'YYYY-MM-DD')
              AND tal.accountingbook = {accountingbook}
              {segment_where}
        """
        
        # Execute both queries in parallel with retry logic for rate limiting
        import time
        prior_pl = 0.0
        posted_re = 0.0
        
        def query_with_retry_re(name, sql, max_retries=3):
            """Execute query with retry logic for rate limiting"""
            for attempt in range(max_retries):
                result = query_netsuite(sql, 120)
                if isinstance(result, dict) and 'error' in result:
                    error_str = str(result.get('details', ''))
                    if 'CONCURRENCY_LIMIT_EXCEEDED' in error_str or '429' in error_str:
                        wait_time = (attempt + 1) * 2
                        print(f"      ⏳ {name}: Rate limited, retrying in {wait_time}s...")
                        time.sleep(wait_time)
                        continue
                return result
            return result
        
        query_errors = []
        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = {
                executor.submit(query_with_retry_re, 'prior_pl', prior_pl_query): 'prior_pl',
                executor.submit(query_with_retry_re, 'posted_re', posted_re_query): 'posted_re'
            }
            for future in as_completed(futures):
                name = futures[future]
                try:
                    result = future.result()
                    value = 0.0
                    if isinstance(result, dict) and 'error' in result:
                        # Query returned an error
                        error_msg = result.get('details', result.get('error', 'Unknown error'))
                        print(f"      ✗ {name} QUERY ERROR: {error_msg}")
                        query_errors.append(f"{name}: {error_msg}")
                    elif isinstance(result, list) and len(result) > 0:
                        raw_value = result[0].get('value')
                        value = float(raw_value) if raw_value is not None else 0.0
                        print(f"      ✓ {name}: raw={raw_value}, parsed={value:,.2f}")
                    else:
                        print(f"      ⚠️ {name}: No results (empty query result)")
                    
                    if name == 'prior_pl':
                        prior_pl = value
                        print(f"      ✓ Prior years P&L: {prior_pl:,.2f}")
                    else:
                        posted_re = value
                        print(f"      ✓ Posted RE adjustments: {posted_re:,.2f}")
                except Exception as e:
                    print(f"      ✗ {name} EXCEPTION: {e}")
                    query_errors.append(f"{name}: {str(e)}")
        
        # Final RE = prior years P&L + posted RE adjustments
        retained_earnings = prior_pl + posted_re
        print(f"   ✅ Retained Earnings: {retained_earnings:,.2f}")
        
        return jsonify({
            'value': retained_earnings,
            'period': period_name,
            'components': {
                'prior_years_pl': prior_pl,
                'posted_re_adjustments': posted_re
            }
        })
        
    except Exception as e:
        print(f"❌ Error calculating retained earnings: {str(e)}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/net-income', methods=['POST'])
def calculate_net_income():
    """
    Calculate Net Income for a period or range of periods.
    
    Modes:
    1. YTD (default): Sum from FY start through target period
    2. Custom range: Sum from fromPeriod through toPeriod (period param)
    
    Request body: {
        period: "Mar 2025",            # End period (required)
        fromPeriod: "Jan 2025",        # Start period (optional - defaults to FY start)
        subsidiary: "1" or "Celigo Inc." (optional),
        accountingBook: "1" (optional),
        classId: "1" (optional),
        department: "1" (optional),
        location: "1" (optional)
    }
    """
    try:
        params = request.json or {}
        period_name = params.get('period', '')
        from_period_name = params.get('fromPeriod', '')  # NEW: Optional start period
        subsidiary_param = params.get('subsidiary', '')
        accountingbook = params.get('accountingBook') or DEFAULT_ACCOUNTING_BOOK
        classId = params.get('classId', '')
        department = params.get('department', '')
        location = params.get('location', '')
        
        # DEBUG: Log all incoming parameters
        print(f"=" * 60)
        print(f"📊 NET INCOME REQUEST:")
        print(f"   period (to):    '{period_name}'")
        print(f"   fromPeriod:     '{from_period_name}'")
        print(f"   subsidiary:     '{subsidiary_param}'")
        print(f"   accountingBook: '{accountingbook}'")
        print(f"   classId:        '{classId}'")
        print(f"   department:     '{department}'")
        print(f"   location:       '{location}'")
        
        # Resolve subsidiary name to ID if needed
        subsidiary = resolve_subsidiary_id(subsidiary_param) if subsidiary_param else None
        if subsidiary_param and not subsidiary:
            print(f"   ⚠️ Could not resolve subsidiary: {subsidiary_param}")
        else:
            print(f"   Subsidiary: {subsidiary_param} → ID {subsidiary}")
        
        # Step 1: Get fiscal year boundaries for the target period
        fy_info = get_fiscal_year_for_period(period_name, accountingbook)
        if not fy_info:
            return jsonify({'error': f'Could not find fiscal year for period {period_name}'}), 400
        
        period_end = fy_info['period_end']
        
        # Determine start date - use fromPeriod if specified, otherwise FY start
        if from_period_name:
            # Get the start date of the from period
            from_period_info = get_fiscal_year_for_period(from_period_name, accountingbook)
            if not from_period_info:
                return jsonify({'error': f'Could not find period: {from_period_name}'}), 400
            range_start = from_period_info['period_start']  # Start of the from period
            print(f"   Custom range: {from_period_name} ({range_start}) → {period_name} ({period_end})")
        else:
            # Default to FY start
            range_start = fy_info['fy_start']
            print(f"   YTD range: FY start ({range_start}) → {period_name} ({period_end})")
        
        # Use default subsidiary if none specified (for consolidation)
        target_sub = subsidiary if subsidiary else (default_subsidiary_id or '1')
        
        # ═══════════════════════════════════════════════════════════════════════
        # CRITICAL: Get all subsidiaries in the target's hierarchy for consolidated view
        # For Net Income, we need transactions from ALL subsidiaries that roll up
        # to the target subsidiary, not just the target itself
        # ═══════════════════════════════════════════════════════════════════════
        hierarchy_subs = get_subsidiaries_in_hierarchy(target_sub)
        sub_filter = ', '.join(hierarchy_subs)
        print(f"   Subsidiary hierarchy: {len(hierarchy_subs)} subsidiaries")
        
        # Build segment filters - use tl.subsidiary for GL line-level filtering (intercompany JEs)
        segment_filters = []
        segment_filters.append(f"tl.subsidiary IN ({sub_filter})")  # Always filter by hierarchy at line level
        if department:
            segment_filters.append(f"tl.department = {department}")
        if location:
            segment_filters.append(f"tl.location = {location}")
        if classId:
            segment_filters.append(f"tl.class = {classId}")
        
        segment_where = ' AND ' + ' AND '.join(segment_filters) if segment_filters else ''
        
        # Always need TransactionLine join for tl.subsidiary filter
        needs_tl_join = True  # Required for tl.subsidiary filter
        tl_join = "JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id" if needs_tl_join else ""
        
        # Parse dates - use range_start (either FY start or custom fromPeriod start)
        from datetime import datetime
        try:
            range_start_date = datetime.strptime(range_start, '%m/%d/%Y').strftime('%Y-%m-%d')
        except:
            range_start_date = range_start
        try:
            period_end_date = datetime.strptime(period_end, '%m/%d/%Y').strftime('%Y-%m-%d')
        except:
            period_end_date = period_end
        
        # DEBUG: Show exact date range being queried
        print(f"   📅 DATE RANGE: {range_start_date} to {period_end_date}")
        print(f"   🏢 Target subsidiary ID: {target_sub} (default: {default_subsidiary_id})")
        print(f"   🔗 Hierarchy includes: {len(hierarchy_subs)} subsidiaries")
        
        # Step 2: Sum current FY P&L with consolidation
        # From FY start through target period end
        # Use BUILTIN.CONSOLIDATE with 'ELIMINATE' for proper intercompany elimination
        # Sign convention: Standard Income flip only (this is a consolidated view via hierarchy)
        # NOTE: No OthExpense flip because this endpoint always uses consolidated hierarchy
        # Result: Positive = profit, Negative = loss
        
        # CRITICAL: Get target period ID for BUILTIN.CONSOLIDATE
        # ALL amounts for Balance Sheet components must be translated at report period-end rate
        target_period_id = fy_info['period_id']
        print(f"   Target period ID: {target_period_id} (for period-end exchange rates)")
        
        # Build simpler consolidation SQL without CROSS JOIN (faster execution)
        if target_sub:
            cons_amount = f"""TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', {target_sub}, {target_period_id}, 'DEFAULT'))"""
        else:
            cons_amount = "tal.amount"
        
        # Sign SQL - flip ALL P&L amounts by -1
        # NetSuite stores: Income/OthIncome as NEGATIVE (credit), Expenses as POSITIVE (debit)
        # For Net Income calculation: Revenue - COGS - OpEx + OthIncome - OthExpense
        # Flipping all by -1: Income becomes positive, Expenses become negative (subtracted)
        ni_sign_sql = "* -1"
        
        # Simplified Net Income query - no CROSS JOIN, directly uses BUILTIN.CONSOLIDATE
        # Uses range_start_date which is either FY start (YTD) or custom fromPeriod start
        net_income_query = f"""
            SELECT SUM({cons_amount} {ni_sign_sql} ) AS net_income
            FROM transactionaccountingline tal
            JOIN transaction t ON t.id = tal.transaction
            JOIN account a ON a.id = tal.account
            JOIN accountingperiod ap ON ap.id = t.postingperiod
            {tl_join}
            WHERE t.posting = 'T'
              AND tal.posting = 'T'
              AND a.accttype IN ({PL_TYPES_SQL})
              AND ap.startdate >= TO_DATE('{range_start_date}', 'YYYY-MM-DD')
              AND ap.enddate <= TO_DATE('{period_end_date}', 'YYYY-MM-DD')
              AND tal.accountingbook = {accountingbook}
              {segment_where}
        """
        
        ni_result = query_netsuite(net_income_query, timeout=120)
        net_income = 0.0
        
        if isinstance(ni_result, dict) and 'error' in ni_result:
            # Query returned an error
            error_msg = ni_result.get('details', ni_result.get('error', 'Unknown error'))
            print(f"   ❌ Net Income QUERY ERROR: {error_msg}")
            return jsonify({'error': f'Query failed: {error_msg}', 'value': None}), 500
        elif isinstance(ni_result, list) and len(ni_result) > 0:
            raw_value = ni_result[0].get('net_income')
            print(f"   📊 Net Income raw value from DB: {raw_value}")
            net_income = float(raw_value) if raw_value is not None else 0.0
        else:
            print(f"   ⚠️ Net Income: No results (empty query result)")
        
        print(f"   ✅ Net Income: {net_income:,.2f}")
        
        return jsonify({
            'value': net_income,
            'period': period_name,
            'fromPeriod': from_period_name if from_period_name else None,
            'range': {
                'start': range_start,
                'end': period_end
            },
            'fiscal_year': {
                'start': fy_info['fy_start'],
                'end': fy_info['fy_end']
            }
        })
        
    except Exception as e:
        print(f"❌ Error calculating net income: {str(e)}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/type-balance', methods=['POST'])
def calculate_type_balance():
    """
    Calculate balance for a specific Account Type OR Special Account Type.
    
    This is like XAVI.BALANCE but filters by account TYPE instead of account NUMBER.
    
    For Balance Sheet types: Returns cumulative balance from inception through toPeriod
    For P&L types: Returns sum for the period range (fromPeriod to toPeriod)
    
    Request body: {
        accountType: "OthAsset",           # Required - NetSuite account type or special account type
        fromPeriod: "Jan 2025",            # Optional for BS, required for P&L
        toPeriod: "Dec 2025",              # Required - end period
        subsidiary: "1" or "Celigo Inc.",  # Optional
        accountingBook: "1",               # Optional
        classId: "1",                      # Optional
        department: "1",                   # Optional
        location: "1",                     # Optional
        useSpecialAccount: false           # Optional - if true, filter by sspecacct instead of accttype
    }
    
    Valid account types (accttype):
    - BS Assets: Bank, AcctRec, OthCurrAsset, FixedAsset, OthAsset, DeferExpense, UnbilledRec
    - BS Liabilities: AcctPay, CredCard, OthCurrLiab, LongTermLiab, DeferRevenue
    - BS Equity: Equity, RetainedEarnings
    - P&L: Income, OthIncome, COGS, Expense, OthExpense
    
    Valid special account types (sspecacct):
    - BS: AcctRec, AcctPay, InvtAsset, UndepFunds, DeferRevenue, DeferExpense, RetEarnings, etc.
    - P&L: COGS, RealizedERV, UnrERV, PayrollExp, etc.
    """
    # Special Account Types that are Balance Sheet (cumulative from inception)
    BS_SPECIAL_TYPES = {
        'AcctRec', 'UnbilledRec', 'CustDep', 'CustAuth', 'RefundPay',
        'AcctPay', 'AdvPaid', 'RecvNotBill',
        'InvtAsset', 'InvInTransit', 'InvInTransitExt', 'RtnNotCredit',
        'DeferRevenue', 'DeferExpense', 'DeferRevClearing',
        'OpeningBalEquity', 'RetEarnings', 'CumulTransAdj', 'CTA-E',
        'SalesTaxPay', 'Tax', 'TaxLiability', 'PSTPay',
        'CommPay', 'PayrollLiab', 'PayrollFloat', 'PayAdjst',
        'UndepFunds', 'Tegata',
        'DirectLabor', 'IndirectLabor'
    }
    
    # Special Account Types that are P&L (period range)
    PL_SPECIAL_TYPES = {
        'COGS', 'FxRateVariance', 'RealizedERV', 'UnrERV', 'MatchingUnrERV', 'RndERV',
        'PSTExp', 'PayrollExp', 'PayWage', 'JobCostVariance'
    }
    
    try:
        params = request.json or {}
        account_type = params.get('accountType', '').strip()
        from_period = params.get('fromPeriod', '')
        to_period = params.get('toPeriod', '')
        subsidiary_param = params.get('subsidiary', '')
        accountingbook = params.get('accountingBook') or DEFAULT_ACCOUNTING_BOOK
        classId = params.get('classId', '')
        department = params.get('department', '')
        location = params.get('location', '')
        use_special_account = params.get('useSpecialAccount', False)
        
        # Validate account type
        if not account_type:
            return jsonify({'error': 'accountType is required'}), 400
        
        if not to_period:
            return jsonify({'error': 'toPeriod is required'}), 400
        
        # DEBUG: Log all incoming parameters
        print(f"=" * 60, file=sys.stderr)
        print(f"📊 TYPE BALANCE REQUEST:", file=sys.stderr)
        print(f"   accountType:       '{account_type}'", file=sys.stderr)
        print(f"   useSpecialAcct:    {use_special_account}", file=sys.stderr)
        print(f"   fromPeriod:        '{from_period}'", file=sys.stderr)
        print(f"   toPeriod:          '{to_period}'", file=sys.stderr)
        print(f"   subsidiary:        '{subsidiary_param}'", file=sys.stderr)
        print(f"   accountingBook:    '{accountingbook}'", file=sys.stderr)
        
        # Determine if this is a BS or P&L account type
        if use_special_account:
            # Using special account type (sspecacct field)
            is_bs = account_type in BS_SPECIAL_TYPES
            is_pl = account_type in PL_SPECIAL_TYPES
            if not is_bs and not is_pl:
                # Unknown special type - assume BS if not in P&L list
                is_bs = True
                print(f"   ⚠️ Unknown special type '{account_type}' - assuming BS", file=sys.stderr)
            print(f"   Special account type '{account_type}' is BS: {is_bs}", file=sys.stderr)
        else:
            # Using regular account type (accttype field)
            is_bs = is_balance_sheet_account(account_type)
            print(f"   Account type '{account_type}' is BS: {is_bs}", file=sys.stderr)
        
        # Determine which field to filter on
        account_field = 'a.sspecacct' if use_special_account else 'a.accttype'
        print(f"   Filtering on: {account_field} = '{account_type}'", file=sys.stderr)
        
        # For BS types, ignore fromPeriod (cumulative from inception)
        if is_bs:
            if from_period:
                print(f"   ⚠️ BS account type - ignoring fromPeriod '{from_period}'", file=sys.stderr)
            from_period = ''
        elif not from_period:
            # P&L requires fromPeriod - default to same as toPeriod for single month
            from_period = to_period
            print(f"   P&L account - defaulting fromPeriod to '{to_period}'", file=sys.stderr)
        
        # Resolve subsidiary name to ID if needed
        subsidiary = resolve_subsidiary_id(subsidiary_param) if subsidiary_param else None
        if subsidiary_param and not subsidiary:
            print(f"   ⚠️ Could not resolve subsidiary: {subsidiary_param}", file=sys.stderr)
        else:
            print(f"   Subsidiary: {subsidiary_param} → ID {subsidiary}", file=sys.stderr)
        
        # CRITICAL: Convert filter names to IDs - they come in as names like "CloudExtend"
        # but SQL requires numeric IDs
        department_id = convert_name_to_id('department', department) if department else ''
        location_id = convert_name_to_id('location', location) if location else ''
        class_id = convert_name_to_id('class', classId) if classId else ''
        
        print(f"   Department: '{department}' → ID '{department_id}'", file=sys.stderr)
        print(f"   Location: '{location}' → ID '{location_id}'", file=sys.stderr)
        print(f"   Class: '{classId}' → ID '{class_id}'", file=sys.stderr)
        
        # Use default subsidiary if none specified (for consolidation)
        target_sub = subsidiary if subsidiary else (default_subsidiary_id or '1')
        
        # Get subsidiary hierarchy for consolidated view
        hierarchy_subs = get_subsidiaries_in_hierarchy(target_sub)
        sub_filter = ', '.join(hierarchy_subs)
        print(f"   Subsidiary hierarchy: {len(hierarchy_subs)} subsidiaries", file=sys.stderr)
        
        # Build segment filters - use tl.subsidiary for GL line-level filtering
        segment_filters = []
        segment_filters.append(f"tl.subsidiary IN ({sub_filter})")
        if department_id:
            segment_filters.append(f"tl.department = {department_id}")
        if location_id:
            segment_filters.append(f"tl.location = {location_id}")
        if class_id:
            segment_filters.append(f"tl.class = {class_id}")
        
        segment_where = ' AND '.join(segment_filters)
        
        # Get period dates
        to_period_info = get_fiscal_year_for_period(to_period, accountingbook)
        if not to_period_info:
            return jsonify({'error': f'Could not find period: {to_period}'}), 400
        
        to_end = to_period_info['period_end']
        target_period_id = to_period_info['period_id']
        
        # Parse end date
        from datetime import datetime
        try:
            to_end_date = datetime.strptime(to_end, '%m/%d/%Y').strftime('%Y-%m-%d')
        except:
            to_end_date = to_end
        
        if is_bs:
            # BALANCE SHEET: Cumulative from inception through toPeriod
            print(f"   📅 BS CUMULATIVE: inception → {to_end_date}", file=sys.stderr)
            
            # Sign flip for liabilities and equity
            sign_sql = f"* CASE WHEN a.accttype IN ({SIGN_FLIP_TYPES_SQL}) THEN -1 ELSE 1 END"
            
            # Use BUILTIN.CONSOLIDATE with target period for exchange rates
            cons_amount = f"""TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', {target_sub}, {target_period_id}, 'DEFAULT'))"""
            
            query = f"""
                SELECT SUM({cons_amount} {sign_sql}) AS balance
                FROM transactionaccountingline tal
                JOIN transaction t ON t.id = tal.transaction
                JOIN account a ON a.id = tal.account
                JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
                WHERE t.posting = 'T'
                  AND tal.posting = 'T'
                  AND {account_field} = '{escape_sql(account_type)}'
                  AND t.trandate <= TO_DATE('{to_end_date}', 'YYYY-MM-DD')
                  AND tal.accountingbook = {accountingbook}
                  AND {segment_where}
            """
        else:
            # P&L: Period range from fromPeriod to toPeriod
            from_period_info = get_fiscal_year_for_period(from_period, accountingbook)
            if not from_period_info:
                return jsonify({'error': f'Could not find period: {from_period}'}), 400
            
            from_start = from_period_info['period_start']
            try:
                from_start_date = datetime.strptime(from_start, '%m/%d/%Y').strftime('%Y-%m-%d')
            except:
                from_start_date = from_start
            
            print(f"   📅 P&L RANGE: {from_start_date} → {to_end_date}", file=sys.stderr)
            
            # Sign flip for Income/OthIncome (credits stored negative)
            sign_sql = f"* CASE WHEN a.accttype IN ({INCOME_TYPES_SQL}) THEN -1 ELSE 1 END"
            
            # Use BUILTIN.CONSOLIDATE
            cons_amount = f"""TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', {target_sub}, t.postingperiod, 'DEFAULT'))"""
            
            query = f"""
                SELECT SUM({cons_amount} {sign_sql}) AS balance
                FROM transactionaccountingline tal
                JOIN transaction t ON t.id = tal.transaction
                JOIN account a ON a.id = tal.account
                JOIN accountingperiod ap ON ap.id = t.postingperiod
                JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
                WHERE t.posting = 'T'
                  AND tal.posting = 'T'
                  AND {account_field} = '{escape_sql(account_type)}'
                  AND ap.startdate >= TO_DATE('{from_start_date}', 'YYYY-MM-DD')
                  AND ap.enddate <= TO_DATE('{to_end_date}', 'YYYY-MM-DD')
                  AND tal.accountingbook = {accountingbook}
                  AND {segment_where}
            """
        
        print(f"   Query:\n{query}", file=sys.stderr)
        
        # Execute query with appropriate timeout
        query_timeout = 90 if is_bs else 60
        result = query_netsuite(query, timeout=query_timeout)
        
        balance = 0.0
        if isinstance(result, dict) and 'error' in result:
            error_msg = result.get('details', result.get('error', 'Unknown error'))
            print(f"   ❌ Query ERROR: {error_msg}", file=sys.stderr)
            return jsonify({'error': f'Query failed: {error_msg}'}), 500
        elif isinstance(result, list) and len(result) > 0:
            raw_value = result[0].get('balance')
            balance = float(raw_value) if raw_value is not None else 0.0
        
        print(f"   ✅ Balance: {balance:,.2f}", file=sys.stderr)
        
        return jsonify({
            'value': balance,
            'accountType': account_type,
            'isBalanceSheet': is_bs,
            'useSpecialAccount': use_special_account,
            'fromPeriod': from_period if not is_bs else None,
            'toPeriod': to_period
        })
        
    except Exception as e:
        print(f"❌ Error calculating type balance: {str(e)}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/batch/typebalance_refresh', methods=['POST'])
def batch_typebalance_refresh():
    """
    BATCH TYPE BALANCE REFRESH - Get ALL P&L account type balances for a fiscal year in ONE optimized query.
    
    This endpoint fetches balances for ALL P&L account types (Income, COGS, Expense, OthIncome, OthExpense)
    for each month of the specified fiscal year, returning them all in one response.
    
    This dramatically reduces NetSuite API calls when loading reports with many TYPEBALANCE formulas.
    Instead of 5 types × 12 months = 60 API calls, we make just 1 query.
    
    POST JSON:
    {
        "year": 2025,
        "subsidiary": "",
        "department": "",
        "location": "",
        "classId": "",
        "accountingBook": "1"
    }
    
    Returns:
    {
        "balances": {
            "Income": {
                "Jan 2025": 8289880.01,
                "Feb 2025": 7654321.00,
                ...
            },
            "COGS": { ... },
            "Expense": { ... },
            "OthIncome": { ... },
            "OthExpense": { ... }
        },
        "elapsed_seconds": 12.5,
        "types_loaded": 5
    }
    """
    try:
        data = request.get_json() or {}
        
        # Extract year
        fiscal_year = data.get('year')
        if not fiscal_year:
            fiscal_year = datetime.now().year
        
        # Get filters
        raw_subsidiary = data.get('subsidiary', '')
        department = data.get('department', '')
        location = data.get('location', '')
        classId = data.get('classId', '')
        accountingbook = data.get('accountingBook') or DEFAULT_ACCOUNTING_BOOK
        
        # Convert names to IDs
        subsidiary = convert_name_to_id('subsidiary', raw_subsidiary)
        department = convert_name_to_id('department', department)
        location = convert_name_to_id('location', location)
        classId = convert_name_to_id('class', classId)
        
        print(f"\n{'='*80}", file=sys.stderr)
        print(f"🚀 BATCH TYPEBALANCE REFRESH: Year {fiscal_year}", file=sys.stderr)
        print(f"   subsidiary: '{raw_subsidiary}' → ID {subsidiary}", file=sys.stderr)
        print(f"   department: '{department}', location: '{location}', class: '{classId}'", file=sys.stderr)
        print(f"{'='*80}\n", file=sys.stderr)
        
        # P&L account types to query
        PL_TYPES = ['Income', 'COGS', 'Expense', 'OthIncome', 'OthExpense']
        
        # Determine target subsidiary for consolidation
        target_sub = subsidiary if subsidiary else (default_subsidiary_id or '1')
        
        # Get subsidiary hierarchy
        hierarchy_subs = get_subsidiaries_in_hierarchy(target_sub)
        sub_filter = ', '.join(hierarchy_subs)
        
        # Build segment filters
        segment_filters = [f"tl.subsidiary IN ({sub_filter})"]
        if department:
            segment_filters.append(f"tl.department = {department}")
        if location:
            segment_filters.append(f"tl.location = {location}")
        if classId:
            segment_filters.append(f"tl.class = {classId}")
        segment_where = ' AND '.join(segment_filters)
        
        # Get fiscal year periods
        periods_query = f"""
            SELECT id, periodname, startdate, enddate
            FROM accountingperiod
            WHERE isyear = 'F' AND isquarter = 'F'
              AND EXTRACT(YEAR FROM startdate) = {fiscal_year}
              AND isadjust = 'F'
            ORDER BY startdate
        """
        periods_result = query_netsuite(periods_query)
        
        if not isinstance(periods_result, list) or len(periods_result) == 0:
            return jsonify({'error': f'No periods found for fiscal year {fiscal_year}'}), 400
        
        print(f"📅 Found {len(periods_result)} periods for FY {fiscal_year}", file=sys.stderr)
        
        # Build the optimized batch query - one query gets ALL types × ALL months
        # Using CASE WHEN to pivot account types and months
        start_time = datetime.now()
        
        # Sign flip SQL for income types (they're stored as credits/negative)
        income_types_sql = "'Income', 'OthIncome'"
        
        # Build month columns dynamically based on actual periods
        month_cases = []
        for period in periods_result:
            period_id = period.get('id')
            period_name = period.get('periodname', '')
            # Extract month abbreviation from period name (e.g., "Jan 2025" -> "jan")
            month_abbr = period_name[:3].lower() if period_name else ''
            if month_abbr:
                # Handle Dec specially since 'dec' might be reserved
                col_name = 'dec_month' if month_abbr == 'dec' else month_abbr
                month_cases.append(f"""
                    SUM(CASE WHEN t.postingperiod = {period_id} THEN 
                        TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', {target_sub}, t.postingperiod, 'DEFAULT'))
                        * CASE WHEN a.accttype IN ({income_types_sql}) THEN -1 ELSE 1 END
                    ELSE 0 END) AS {col_name}
                """)
        
        if not month_cases:
            return jsonify({'error': 'No valid periods found'}), 400
        
        month_columns = ',\n'.join(month_cases)
        
        # Get all period IDs for the date range filter
        period_ids = [str(p.get('id')) for p in periods_result]
        period_filter = ', '.join(period_ids)
        
        # Build the main query - pivots by account type
        query = f"""
            SELECT 
                a.accttype AS account_type,
                {month_columns}
            FROM transactionaccountingline tal
            JOIN transaction t ON t.id = tal.transaction
            JOIN account a ON a.id = tal.account
            JOIN TransactionLine tl ON t.id = tl.transaction AND tal.transactionline = tl.id
            WHERE t.posting = 'T'
              AND tal.posting = 'T'
              AND a.accttype IN ('Income', 'COGS', 'Expense', 'OthIncome', 'OthExpense')
              AND t.postingperiod IN ({period_filter})
              AND tal.accountingbook = {accountingbook}
              AND {segment_where}
            GROUP BY a.accttype
            ORDER BY a.accttype
        """
        
        print(f"📝 Executing batch query...", file=sys.stderr)
        
        try:
            items = run_paginated_suiteql(query, page_size=100, max_pages=1, timeout=120)
        except Exception as e:
            print(f"❌ Query error: {e}", file=sys.stderr)
            return jsonify({'error': f'NetSuite query failed: {str(e)}'}), 500
        
        elapsed = (datetime.now() - start_time).total_seconds()
        print(f"⏱️  Query time: {elapsed:.2f} seconds", file=sys.stderr)
        print(f"✅ Received {len(items)} account type rows", file=sys.stderr)
        
        # Transform results to nested dict: { accountType: { period: value } }
        balances = {}
        
        # Month column mapping
        month_mapping = {
            'jan': f'Jan {fiscal_year}',
            'feb': f'Feb {fiscal_year}',
            'mar': f'Mar {fiscal_year}',
            'apr': f'Apr {fiscal_year}',
            'may': f'May {fiscal_year}',
            'jun': f'Jun {fiscal_year}',
            'jul': f'Jul {fiscal_year}',
            'aug': f'Aug {fiscal_year}',
            'sep': f'Sep {fiscal_year}',
            'oct': f'Oct {fiscal_year}',
            'nov': f'Nov {fiscal_year}',
            'dec_month': f'Dec {fiscal_year}'
        }
        
        for row in items:
            acct_type = row.get('account_type', '')
            if not acct_type:
                continue
            
            balances[acct_type] = {}
            
            for col_name, period_name in month_mapping.items():
                amount = row.get(col_name)
                if amount is not None:
                    balances[acct_type][period_name] = float(amount)
                else:
                    balances[acct_type][period_name] = 0.0
            
            # Log first few for debugging
            if len(balances) <= 3:
                sample_month = f'Jan {fiscal_year}'
                sample_val = balances[acct_type].get(sample_month, 0)
                print(f"   {acct_type}: {sample_month} = ${sample_val:,.2f}", file=sys.stderr)
        
        # For any P&L types not in results (no activity), add zeros
        for ptype in PL_TYPES:
            if ptype not in balances:
                balances[ptype] = {period_name: 0.0 for period_name in month_mapping.values()}
        
        print(f"📊 Returning {len(balances)} account types × 12 months", file=sys.stderr)
        print(f"{'='*80}\n", file=sys.stderr)
        
        return jsonify({
            'balances': balances,
            'year': fiscal_year,
            'elapsed_seconds': elapsed,
            'types_loaded': len(balances),
            'subsidiary': raw_subsidiary
        })
        
    except Exception as e:
        print(f"❌ Error in batch typebalance refresh: {str(e)}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/cta', methods=['POST'])
def calculate_cta():
    """
    Calculate Cumulative Translation Adjustment (CTA) using the PLUG METHOD
    
    CTA = (Total Assets - Total Liabilities) - Posted Equity - RE - NI
    
    This is the only way to get 100% accuracy because NetSuite calculates
    additional translation adjustments at runtime that are never posted to accounts.
    The plug method guarantees the Balance Sheet balances.
    
    Request body: {
        period: "Mar 2025",
        subsidiary: "1" or "Celigo Inc." (optional),
        accountingBook: "1" (optional)
    }
    """
    try:
        params = request.json or {}
        period_name = params.get('period', '')
        subsidiary_param = params.get('subsidiary', '')
        accountingbook = params.get('accountingBook') or DEFAULT_ACCOUNTING_BOOK
        
        print(f"📊 Calculating CTA (PLUG METHOD) for {period_name}")
        
        # Resolve subsidiary name to ID if needed
        subsidiary = resolve_subsidiary_id(subsidiary_param) if subsidiary_param else None
        if subsidiary_param and not subsidiary:
            print(f"   ⚠️ Could not resolve subsidiary: {subsidiary_param}")
        else:
            print(f"   Subsidiary: {subsidiary_param} → ID {subsidiary}")
        
        # Get period info
        fy_info = get_fiscal_year_for_period(period_name, accountingbook)
        if not fy_info:
            return jsonify({'error': f'Could not find period {period_name}'}), 400
        
        period_end = fy_info['period_end']
        fy_start = fy_info['fy_start']
        
        from datetime import datetime
        try:
            period_end_date = datetime.strptime(period_end, '%m/%d/%Y').strftime('%Y-%m-%d')
        except:
            period_end_date = period_end
        try:
            fy_start_date = datetime.strptime(fy_start, '%m/%d/%Y').strftime('%Y-%m-%d')
        except:
            fy_start_date = fy_start
        
        # Use default subsidiary if none specified
        target_sub = subsidiary if subsidiary else (default_subsidiary_id or '1')
        
        # Get the target period ID for BUILTIN.CONSOLIDATE
        # CRITICAL: Must use target period ID, NOT t.postingperiod!
        # This ensures all foreign currency transactions are translated at period-end rate
        target_period_id = fy_info['period_id']
        print(f"   Target period ID: {target_period_id} (for period-end exchange rates)")
        
        # ═══════════════════════════════════════════════════════════════════════
        # CRITICAL: Get all subsidiaries in the target's hierarchy
        # Without this filter, we'd be consolidating ALL subsidiaries (including
        # those outside the hierarchy), leading to incorrect CTA calculations
        # ═══════════════════════════════════════════════════════════════════════
        hierarchy_subs = get_subsidiaries_in_hierarchy(target_sub)
        sub_filter = ', '.join(hierarchy_subs)
        print(f"   Subsidiary filter: {len(hierarchy_subs)} subsidiaries in hierarchy")
        
        # Use constants for account types - single source of truth
        # Asset types: debit balance positive (no flip)
        asset_types = BS_ASSET_TYPES_SQL
        # Liability types: credit balance (flip to positive for display)
        liability_types = BS_LIABILITY_TYPES_SQL
        
        # Sign multiplier for P&L: flip Income/OthIncome from credits (negative) to positive display
        cta_pl_sign_sql = f"* CASE WHEN a.accttype IN ({INCOME_TYPES_SQL}) THEN -1 ELSE 1 END"
        
        # Build consolidation SQL - Use TARGET PERIOD ID for proper exchange rate translation
        # OLD (WRONG): t.postingperiod - translated at each transaction's posting period rate
        # NEW (CORRECT): target_period_id - translated at report period-end rate
        # 
        # IMPORTANT: Do NOT use COALESCE with tal.amount fallback!
        # BUILTIN.CONSOLIDATE returns NULL for transactions that shouldn't consolidate to target_sub
        # Using COALESCE would mix currencies (USD + INR + EUR = garbage)
        # Trust CONSOLIDATE to handle subsidiary hierarchy and currency translation
        if target_sub:
            cons_amount = f"""TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', {target_sub}, {target_period_id}, 'DEFAULT'))"""
        else:
            cons_amount = "tal.amount"
        
        # ═══════════════════════════════════════════════════════════════════════
        # PARALLEL QUERY EXECUTION - Run all 6 queries concurrently to reduce time
        # Sequential: ~4 minutes → Parallel: ~1.5 minutes
        # NOTE: All queries now filter by subsidiary hierarchy to ensure correct consolidation
        # ═══════════════════════════════════════════════════════════════════════
        print(f"   Running 6 queries in PARALLEL for faster results...")
        
        # IMPORTANT: Do NOT filter by t.subsidiary when using BUILTIN.CONSOLIDATE!
        # BUILTIN.CONSOLIDATE handles subsidiary filtering internally based on target_sub parameter
        # 
        # CRITICAL: Must include ap.isyear = 'F' AND ap.isquarter = 'F' to exclude
        # summary periods (quarterly/yearly roll-ups) which would cause duplication
        queries = {
            'total_assets': f"""
                SELECT SUM({cons_amount}) AS value
                FROM transactionaccountingline tal
                JOIN transaction t ON t.id = tal.transaction
                JOIN account a ON a.id = tal.account
                JOIN accountingperiod ap ON ap.id = t.postingperiod
                WHERE t.posting = 'T'
                  AND tal.posting = 'T'
                  AND a.accttype IN ({asset_types})
                  AND ap.enddate <= TO_DATE('{period_end_date}', 'YYYY-MM-DD')
                  AND ap.isyear = 'F'
                  AND ap.isquarter = 'F'
                  AND tal.accountingbook = {accountingbook}
            """,
            'total_liabilities': f"""
                SELECT SUM({cons_amount} * CASE WHEN a.accttype IN ({INCOME_TYPES_SQL}) THEN -1 ELSE 1 END ) AS value
                FROM transactionaccountingline tal
                JOIN transaction t ON t.id = tal.transaction
                JOIN account a ON a.id = tal.account
                JOIN accountingperiod ap ON ap.id = t.postingperiod
                WHERE t.posting = 'T'
                  AND tal.posting = 'T'
                  AND a.accttype IN ({liability_types})
                  AND ap.enddate <= TO_DATE('{period_end_date}', 'YYYY-MM-DD')
                  AND ap.isyear = 'F'
                  AND ap.isquarter = 'F'
                  AND tal.accountingbook = {accountingbook}
            """,
            'posted_equity': f"""
                SELECT SUM({cons_amount} * CASE WHEN a.accttype IN ({INCOME_TYPES_SQL}) THEN -1 ELSE 1 END ) AS value
                FROM transactionaccountingline tal
                JOIN transaction t ON t.id = tal.transaction
                JOIN account a ON a.id = tal.account
                JOIN accountingperiod ap ON ap.id = t.postingperiod
                WHERE t.posting = 'T'
                  AND tal.posting = 'T'
                  AND a.accttype = 'Equity'
                  AND LOWER(a.fullname) NOT LIKE '%retained earnings%'
                  AND ap.enddate <= TO_DATE('{period_end_date}', 'YYYY-MM-DD')
                  AND ap.isyear = 'F'
                  AND ap.isquarter = 'F'
                  AND tal.accountingbook = {accountingbook}
            """,
            'prior_pl': f"""
                SELECT SUM({cons_amount} {cta_pl_sign_sql} ) AS value
                FROM transactionaccountingline tal
                JOIN transaction t ON t.id = tal.transaction
                JOIN account a ON a.id = tal.account
                JOIN accountingperiod ap ON ap.id = t.postingperiod
                WHERE t.posting = 'T'
                  AND tal.posting = 'T'
                  AND a.accttype IN ({PL_TYPES_SQL})
                  AND ap.enddate < TO_DATE('{fy_start_date}', 'YYYY-MM-DD')
                  AND ap.isyear = 'F'
                  AND ap.isquarter = 'F'
                  AND tal.accountingbook = {accountingbook}
            """,
            'posted_re': f"""
                SELECT SUM({cons_amount}) AS value
                FROM transactionaccountingline tal
                JOIN transaction t ON t.id = tal.transaction
                JOIN account a ON a.id = tal.account
                JOIN accountingperiod ap ON ap.id = t.postingperiod
                WHERE t.posting = 'T'
                  AND tal.posting = 'T'
                  AND (a.accttype = 'RetainedEarnings' OR LOWER(a.fullname) LIKE '%retained earnings%')
                  AND ap.enddate <= TO_DATE('{period_end_date}', 'YYYY-MM-DD')
                  AND ap.isyear = 'F'
                  AND ap.isquarter = 'F'
                  AND tal.accountingbook = {accountingbook}
            """,
            'net_income': f"""
                SELECT SUM({cons_amount} {cta_pl_sign_sql} ) AS value
                FROM transactionaccountingline tal
                JOIN transaction t ON t.id = tal.transaction
                JOIN account a ON a.id = tal.account
                JOIN accountingperiod ap ON ap.id = t.postingperiod
                WHERE t.posting = 'T'
                  AND tal.posting = 'T'
                  AND a.accttype IN ({PL_TYPES_SQL})
                  AND ap.startdate >= TO_DATE('{fy_start_date}', 'YYYY-MM-DD')
                  AND ap.enddate <= TO_DATE('{period_end_date}', 'YYYY-MM-DD')
                  AND ap.isyear = 'F'
                  AND ap.isquarter = 'F'
                  AND tal.accountingbook = {accountingbook}
            """
        }
        
        # Execute queries in parallel using ThreadPoolExecutor
        # IMPORTANT: NetSuite has a concurrency limit (typically 5)
        # Using max_workers=3 to leave room for other concurrent requests
        results = {}
        import time
        
        def query_with_retry(name, sql, max_retries=3):
            """Execute query with retry logic for rate limiting"""
            # DEBUG: Log the FULL SQL being sent
            print(f"\n   📜 {name} FULL SQL:")
            print(f"   {sql.strip()}")
            for attempt in range(max_retries):
                result = query_netsuite(sql, 120)
                if isinstance(result, dict) and 'error' in result:
                    error_str = str(result.get('details', ''))
                    if 'CONCURRENCY_LIMIT_EXCEEDED' in error_str or '429' in error_str:
                        wait_time = (attempt + 1) * 2  # 2s, 4s, 6s
                        print(f"      ⏳ {name}: Rate limited, retrying in {wait_time}s...")
                        time.sleep(wait_time)
                        continue
                return result
            return result  # Return last result even if failed
        
        query_errors = []
        with ThreadPoolExecutor(max_workers=3) as executor:
            futures = {
                executor.submit(query_with_retry, name, sql): name 
                for name, sql in queries.items()
            }
            for future in as_completed(futures):
                name = futures[future]
                try:
                    result = future.result()
                    value = 0.0
                    if isinstance(result, dict) and 'error' in result:
                        # Query returned an error
                        error_msg = result.get('details', result.get('error', 'Unknown error'))
                        print(f"      ✗ {name} QUERY ERROR: {error_msg}")
                        query_errors.append(f"{name}: {error_msg}")
                    elif isinstance(result, list) and len(result) > 0:
                        raw_value = result[0].get('value')
                        value = float(raw_value) if raw_value is not None else 0.0
                        print(f"      ✓ {name}: raw={raw_value}, parsed={value:,.2f}")
                    else:
                        print(f"      ⚠️ {name}: No results (empty query result)")
                    results[name] = value
                except Exception as e:
                    print(f"      ✗ {name} EXCEPTION: {e}")
                    query_errors.append(f"{name}: {str(e)}")
                    results[name] = 0.0
        
        if query_errors:
            print(f"   ⚠️ CTA: {len(query_errors)} query errors occurred: {query_errors}")
        
        # Extract results
        total_assets = results.get('total_assets', 0.0)
        total_liabilities = results.get('total_liabilities', 0.0)
        posted_equity = results.get('posted_equity', 0.0)
        prior_pl = results.get('prior_pl', 0.0)
        posted_re = results.get('posted_re', 0.0)
        net_income = results.get('net_income', 0.0)
        
        # Calculate derived values
        total_equity = total_assets - total_liabilities
        retained_earnings = prior_pl + posted_re
        
        print(f"   Summary:")
        print(f"      Total Assets:      {total_assets:,.2f}")
        print(f"      Total Liabilities: {total_liabilities:,.2f}")
        print(f"      Total Equity:      {total_equity:,.2f}")
        print(f"      Posted Equity:     {posted_equity:,.2f}")
        print(f"      Retained Earnings: {retained_earnings:,.2f} (prior={prior_pl:,.2f} + posted={posted_re:,.2f})")
        print(f"      Net Income:        {net_income:,.2f}")
        
        # ═══════════════════════════════════════════════════════════════════════
        # FINAL: Calculate CTA as PLUG
        # CTA = Total Equity - Posted Equity - RE - NI
        # ═══════════════════════════════════════════════════════════════════════
        cta = total_equity - posted_equity - retained_earnings - net_income
        
        print(f"\n   ╔═══════════════════════════════════════════════════════════╗")
        print(f"   ║  CTA PLUG CALCULATION                                     ║")
        print(f"   ╠═══════════════════════════════════════════════════════════╣")
        print(f"   ║  Total Equity (A-L):     {total_equity:>20,.2f}        ║")
        print(f"   ║  - Posted Equity:        {posted_equity:>20,.2f}        ║")
        print(f"   ║  - Retained Earnings:    {retained_earnings:>20,.2f}        ║")
        print(f"   ║  - Net Income:           {net_income:>20,.2f}        ║")
        print(f"   ║  ─────────────────────────────────────────────────────    ║")
        print(f"   ║  = CTA (plug):           {cta:>20,.2f}        ║")
        print(f"   ╚═══════════════════════════════════════════════════════════╝")
        
        return jsonify({
            'value': cta,
            'period': period_name,
            'components': {
                'total_assets': total_assets,
                'total_liabilities': total_liabilities,
                'total_equity': total_equity,
                'posted_equity': posted_equity,
                'retained_earnings': retained_earnings,
                'net_income': net_income
            }
        })
        
    except Exception as e:
        print(f"❌ Error calculating CTA: {str(e)}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    print("=" * 80)
    print("NetSuite Excel Formulas - Backend Server")
    print("=" * 80)
    print()
    print(f"NetSuite Account: {account_id}")
    print(f"Server starting on: http://localhost:5002")
    print()
    print("Endpoints:")
    print("  GET  /                              - Service info")
    print("  GET  /health                        - Health check")
    print("  GET  /test                          - Test NetSuite connection")
    print("  GET  /account/<number>/name         - Get account name")
    print("  GET  /balance?account=...           - Get GL balance")
    print("  GET  /budget?account=...            - Get budget amount")
    print("  POST /batch/balance                 - Batch balance queries")
    print("  GET  /transactions?account=...      - Transaction drill-down")
    print("  GET  /lookups/subsidiaries          - Get subsidiaries list")
    print("  GET  /lookups/departments           - Get departments list")
    print("  GET  /lookups/classes               - Get classes list")
    print("  GET  /lookups/locations             - Get locations list")
    print()
    print("Loading name-to-ID lookup cache...")
    load_lookup_cache()
    print()
    print("Press Ctrl+C to stop")
    print("=" * 80)
    print()
    
    # Run server
    app.run(host='127.0.0.1', port=5002, debug=False)

