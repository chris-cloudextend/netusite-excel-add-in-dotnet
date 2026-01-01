#!/usr/bin/env node

// Simulate frontend processing of period range optimization response

const SERVER_URL = 'https://netsuite-proxy.chris-corcoran.workers.dev';

// Simulate the exact request the frontend sends
const requestBody = {
    accounts: ['4220'],
    from_period: 'Jan 2012',
    to_period: 'Dec 2025',
    periods: []
};

console.log('🧪 Frontend Simulation Test');
console.log('========================================');
console.log('');
console.log('📤 Request:');
console.log(JSON.stringify(requestBody, null, 2));
console.log('');

// Make the request
fetch(`${SERVER_URL}/batch/balance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody)
})
.then(response => {
    console.log(`📥 Response Status: ${response.status}`);
    return response.json();
})
.then(data => {
    console.log('');
    console.log('📋 Response Data:');
    console.log(JSON.stringify(data, null, 2));
    console.log('');
    
    // Simulate frontend processing
    console.log('🔄 Frontend Processing:');
    console.log('');
    
    const balances = data.balances || {};
    const account = '4220';
    const commonFromPeriod = 'Jan 2012';
    const commonToPeriod = 'Dec 2025';
    const rangeKey = `${commonFromPeriod} to ${commonToPeriod}`;
    
    console.log(`   Range Key: "${rangeKey}"`);
    console.log(`   Account Data:`, balances[account] || '{}');
    
    const accountData = balances[account] || {};
    const total = accountData[rangeKey] || 0;
    
    console.log(`   Extracted Total: ${total}`);
    console.log('');
    
    if (data.error) {
        console.log(`   ⚠️  Backend Error: ${data.error}`);
        console.log(`   ⚠️  This would cause frontend to return 0 or error`);
    } else if (total === 0 && Object.keys(accountData).length === 0) {
        console.log(`   ⚠️  No balance data found - accountData is empty`);
        console.log(`   ⚠️  This would cause frontend to return 0`);
    } else if (total > 0) {
        console.log(`   ✅ Balance found: ${total}`);
    }
    
    console.log('');
    console.log('========================================');
    console.log('Analysis:');
    console.log('');
    
    if (data.error === 'TIMEOUT') {
        console.log('❌ ISSUE: Query timed out (30s limit)');
        console.log('   The query is too large for a 14-year range');
        console.log('   Frontend receives error and may return 0');
    } else if (!balances[account] || Object.keys(balances[account] || {}).length === 0) {
        console.log('❌ ISSUE: No balance data in response');
        console.log('   Backend returned empty balances object');
        console.log('   Frontend would return 0');
    } else if (!accountData[rangeKey]) {
        console.log('❌ ISSUE: Range key mismatch');
        console.log(`   Frontend expects: "${rangeKey}"`);
        console.log(`   Backend returned keys:`, Object.keys(accountData));
        console.log('   Frontend would return 0');
    } else {
        console.log('✅ Response format is correct');
        console.log(`   Balance: ${total}`);
    }
})
.catch(error => {
    console.error('❌ Request failed:', error);
});

