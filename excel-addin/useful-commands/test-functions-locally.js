/**
 * Local Testing Harness for functions.js
 * 
 * This script simulates the Excel add-in environment to test functions
 * without requiring Excel. Run with: node test-functions-locally.js
 * 
 * Usage:
 *   node excel-addin/useful-commands/test-functions-locally.js
 */

// Mock Office.js environment
global.Office = {
    context: {
        document: {
            settings: {
                get: (key) => null,
                set: (key, value) => {},
                saveAsync: (callback) => setTimeout(() => callback({ status: 'succeeded' }), 0)
            }
        }
    },
    onReady: (callback) => {
        // Simulate Office ready
        setTimeout(() => callback({ host: 'Excel', platform: 'Mac' }), 0);
    }
};

// Mock localStorage
const localStorage = {
    _data: {},
    getItem: function(key) {
        return this._data[key] || null;
    },
    setItem: function(key, value) {
        this._data[key] = value;
    },
    removeItem: function(key) {
        delete this._data[key];
    },
    clear: function() {
        this._data = {};
    }
};
global.localStorage = localStorage;

// Mock console for better output
const originalLog = console.log;
console.log = function(...args) {
    originalLog('[TEST]', ...args);
};

// Load functions.js (this will need to be adapted based on your module system)
// For now, we'll test specific functions

console.log('🧪 Local Testing Harness for functions.js');
console.log('==========================================\n');

// Test 1: getFilterKey function
console.log('Test 1: getFilterKey');
console.log('-------------------');

// This would need to be extracted or imported
function getFilterKey(params) {
    const sub = String(params.subsidiary || '').trim();
    const dept = String(params.department || '').trim();
    const loc = String(params.location || '').trim();
    const cls = String(params.classId || '').trim();
    let book = String(params.accountingBook || '').trim();
    if (book === '' || book === '1') {
        book = '1';
    }
    return `${sub}|${dept}|${loc}|${cls}|${book}`;
}

// Test cases
const testCases = [
    {
        name: 'Empty filters',
        input: { subsidiary: '', department: '', location: '', classId: '', accountingBook: '' },
        expected: '||||1'
    },
    {
        name: 'With subsidiary',
        input: { subsidiary: '1', department: '', location: '', classId: '', accountingBook: '1' },
        expected: '1||||1'
    },
    {
        name: 'Normalize empty book to 1',
        input: { subsidiary: '1', department: '', location: '', classId: '', accountingBook: '' },
        expected: '1||||1'
    }
];

let passed = 0;
let failed = 0;

testCases.forEach(test => {
    const result = getFilterKey(test.input);
    if (result === test.expected) {
        console.log(`✅ ${test.name}: PASS`);
        passed++;
    } else {
        console.log(`❌ ${test.name}: FAIL`);
        console.log(`   Expected: ${test.expected}`);
        console.log(`   Got: ${result}`);
        failed++;
    }
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);

// Test 2: normalizePeriodKey (if we can extract it)
console.log('\n\nTest 2: Period normalization');
console.log('----------------------------');
console.log('⚠️  This test requires extracting normalizePeriodKey from functions.js');
console.log('   Consider refactoring functions.js to export testable functions');

// Test 3: Manifest operations
console.log('\n\nTest 3: Manifest operations');
console.log('-------------------------');
console.log('⚠️  This test requires extracting manifest functions from functions.js');

console.log('\n✅ Test harness ready!');
console.log('\n💡 Suggestions:');
console.log('   1. Extract pure functions from functions.js into a separate module');
console.log('   2. Add unit tests for each extracted function');
console.log('   3. Use this harness to test functions without Excel');
console.log('   4. Consider using Jest or Mocha for more robust testing');
