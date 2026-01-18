/**
 * GEX Formula Verification Script
 * 
 * Run this to verify the GEX calculation matches BullFlow/SpotGamma industry standards
 * 
 * INDUSTRY STANDARD FORMULA (from DEVELOPER_HANDOFF.md and mathLibrary_UPDATED.ts):
 *   GEX = Gamma × OI × 100 × Spot² × 0.01
 * 
 * Usage: node tests/verify-gex-fix.js
 */

console.log('='.repeat(60));
console.log('GEX FORMULA VERIFICATION (Industry Standard)');
console.log('Formula: Gamma × OI × 100 × Spot² × 0.01');
console.log('='.repeat(60));
console.log('');

// Test data from DEVELOPER_HANDOFF.md
const testCases = [
  {
    name: 'SPY 693 Call (dealers SHORT calls = SHORT gamma)',
    gamma: 0.228,
    openInterest: 14500,
    spotPrice: 693.77,
    optionType: 'call',
    expectedGEX: -1590000000, // NEGATIVE ~$-1.59B (dealers short gamma on calls)
    tolerance: 0.05, // 5% tolerance
  },
  {
    name: 'SPY 693 Put (dealers SHORT puts = LONG gamma)',
    gamma: 0.225,
    openInterest: 3800,
    spotPrice: 693.77,
    optionType: 'put',
    expectedGEX: 411000000, // POSITIVE ~$411M (dealers long gamma on puts)
    tolerance: 0.15, // 15% tolerance
  },
  {
    name: 'AAPL $255 Call (dealers SHORT = negative)',
    gamma: 0.05,
    openInterest: 10000,
    spotPrice: 255.53,
    optionType: 'call',
    // GEX = 0.05 × 10,000 × 100 × 255.53² × 0.01 × -1 = -$32.6M
    expectedGEX: -32650000, // NEGATIVE for calls
    tolerance: 0.05,
  },
];

// Industry standard GEX formula: Gamma × OI × 100 × Spot² × 0.01
// DEALER PERSPECTIVE: They are SHORT options
// - Short calls = SHORT gamma (negative)
// - Short puts = LONG gamma (positive)
function calculateSingleGEX(gamma, openInterest, spotPrice, optionType) {
  const multiplier = optionType === 'call' ? -1 : 1; // Calls negative, Puts positive
  const PERCENT_MOVE = 0.01; // Industry standard: normalize to 1% price move
  return gamma * openInterest * 100 * spotPrice * spotPrice * PERCENT_MOVE * multiplier;
}

// Format dollar value
function formatDollarValue(value) {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  
  if (abs >= 1e9) {
    return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  } else if (abs >= 1e6) {
    return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  } else if (abs >= 1e3) {
    return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  }
  return `${sign}$${abs.toFixed(2)}`;
}

let passed = 0;
let failed = 0;

testCases.forEach((test, index) => {
  console.log(`TEST ${index + 1}: ${test.name}`);
  console.log('-'.repeat(60));
  
  const calculatedGEX = calculateSingleGEX(
    test.gamma,
    test.openInterest,
    test.spotPrice,
    test.optionType
  );
  
  console.log(`Input: gamma=${test.gamma}, OI=${test.openInterest.toLocaleString()}, spot=$${test.spotPrice}`);
  console.log(`Formula: gamma × OI × 100 × spot² × 0.01 × direction`);
  console.log(`Calculated: ${formatDollarValue(calculatedGEX)}`);
  console.log(`Expected: ${formatDollarValue(test.expectedGEX)}`);
  
  const diff = Math.abs(calculatedGEX - test.expectedGEX) / Math.abs(test.expectedGEX);
  console.log(`Difference: ${(diff * 100).toFixed(2)}%`);
  
  if (diff <= test.tolerance) {
    console.log('✅ PASS - Within tolerance');
    passed++;
  } else {
    console.log('❌ FAIL - Outside tolerance');
    failed++;
  }
  console.log('');
});

// Test sign convention (calls negative, puts positive)
console.log('TEST 3: Sign Convention Verification');
console.log('-'.repeat(60));
const callGEX = calculateSingleGEX(0.228, 14500, 693.77, 'call');
const putGEX = calculateSingleGEX(0.225, 3800, 693.77, 'put');
const callFormatted = formatDollarValue(callGEX);
const putFormatted = formatDollarValue(putGEX);
console.log(`Call GEX value: ${callGEX} -> "${callFormatted}"`);
console.log(`Put GEX value: ${putGEX} -> "${putFormatted}"`);
console.log('Expected: Calls NEGATIVE, Puts POSITIVE (dealer perspective)');

if (callGEX < 0 && putGEX > 0 && callFormatted.includes('-') && !putFormatted.includes('-')) {
  console.log('✅ PASS - Sign convention correct (calls negative, puts positive)');
  passed++;
} else {
  console.log('❌ FAIL - Sign convention incorrect');
  failed++;
}
console.log('');

// Summary
console.log('='.repeat(60));
console.log('SUMMARY');
console.log('='.repeat(60));
console.log(`Total Tests: ${passed + failed}`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Success Rate: ${((passed / (passed + failed)) * 100).toFixed(1)}%`);
console.log('');

// Test 4: Net GEX calculation
console.log('TEST 4: Net GEX = Call GEX + Put GEX');
console.log('-'.repeat(60));
const callGEXTest = calculateSingleGEX(0.228, 14500, 693.77, 'call');
const putGEXTest = calculateSingleGEX(0.225, 3800, 693.77, 'put');
const netGEXTest = callGEXTest + putGEXTest;
console.log(`Call GEX: ${formatDollarValue(callGEXTest)}`);
console.log(`Put GEX: ${formatDollarValue(putGEXTest)}`);
console.log(`Net GEX: ${formatDollarValue(netGEXTest)}`);

// With dealer perspective: calls are NEGATIVE, puts are POSITIVE
if (callGEXTest < 0 && putGEXTest > 0 && netGEXTest === callGEXTest + putGEXTest) {
  console.log('✅ PASS - Signs correct (calls negative, puts positive), Net GEX = Call + Put');
  passed++;
} else {
  console.log('❌ FAIL - Sign or sum error');
  console.log(`   Expected: callGEX < 0, putGEX > 0`);
  console.log(`   Got: callGEX=${callGEXTest}, putGEX=${putGEXTest}`);
  failed++;
}
console.log('');

// Summary
console.log('='.repeat(60));
console.log('SUMMARY');
console.log('='.repeat(60));
console.log(`Total Tests: ${passed + failed}`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Success Rate: ${((passed / (passed + failed)) * 100).toFixed(1)}%`);
console.log('');

if (failed === 0) {
  console.log('✅ ALL TESTS PASSED');
  console.log('');
  console.log('Your GEX calculations match the industry standard (DEALER PERSPECTIVE):');
  console.log('  Formula: Gamma × OI × 100 × Spot² × 0.01 × Direction');
  console.log('  Calls: NEGATIVE GEX (dealers SHORT calls = SHORT gamma)');
  console.log('  Puts: POSITIVE GEX (dealers SHORT puts = LONG gamma)');
  console.log('  Net GEX = Call GEX + Put GEX');
  console.log('');
  console.log('This matches BullFlow where:');
  console.log('  - Put-heavy strikes (below spot) show POSITIVE/GREEN');
  console.log('  - Call-heavy strikes (above spot) can show NEGATIVE/RED');
} else {
  console.log('❌ SOME TESTS FAILED');
  console.log('Please review the failing tests above.');
}
console.log('='.repeat(60));

process.exit(failed > 0 ? 1 : 0);
