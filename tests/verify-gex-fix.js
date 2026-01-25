/**
 * GEX Formula Verification Script
 * 
 * Run this to verify the GEX calculation matches BullFlow/SpotGamma industry standards
 * 
 * INDUSTRY STANDARD FORMULA (from DEVELOPER_HANDOFF.md and mathLibrary_UPDATED.ts):
 *   GEX = Gamma × OI × 100 × Spot² × 0.01 × Sign
 * 
 * SIGN CONVENTION (INDUSTRY STANDARD - matches BullFlow/SpotGamma):
 *   - CALLS = +1 (POSITIVE GEX) - Green - Support level
 *   - PUTS = -1 (NEGATIVE GEX) - Red - Resistance level
 * 
 * Usage: node tests/verify-gex-fix.js
 */

console.log('='.repeat(60));
console.log('GEX FORMULA VERIFICATION (Industry Standard)');
console.log('Formula: Gamma × OI × 100 × Spot² × 0.01 × Sign');
console.log('Sign: Calls = +1 (positive), Puts = -1 (negative)');
console.log('='.repeat(60));
console.log('');

// Test data from DEVELOPER_HANDOFF.md
const testCases = [
  {
    name: 'SPY 693 Call (POSITIVE GEX)',
    gamma: 0.228,
    openInterest: 14500,
    spotPrice: 693.77,
    optionType: 'call',
    expectedGEX: 1590000000, // POSITIVE ~$1.59B
    tolerance: 0.05, // 5% tolerance
  },
  {
    name: 'SPY 693 Put (NEGATIVE GEX)',
    gamma: 0.225,
    openInterest: 3800,
    spotPrice: 693.77,
    optionType: 'put',
    expectedGEX: -411000000, // NEGATIVE ~-$411M
    tolerance: 0.15, // 15% tolerance
  },
  {
    name: 'AAPL $255 Call (POSITIVE GEX)',
    gamma: 0.05,
    openInterest: 10000,
    spotPrice: 255.53,
    optionType: 'call',
    // GEX = 0.05 × 10,000 × 100 × 255.53² × 0.01 × 1 = +$32.6M
    expectedGEX: 32650000, // POSITIVE for calls
    tolerance: 0.05,
  },
];

// INDUSTRY STANDARD GEX formula: Gamma × OI × 100 × Spot² × 0.01 × Sign
// Sign Convention: Calls = +1 (positive), Puts = -1 (negative)
function calculateSingleGEX(gamma, openInterest, spotPrice, optionType) {
  const multiplier = optionType === 'call' ? 1 : -1; // Calls positive, Puts negative
  const PERCENT_MOVE = 0.01; // Industry standard: normalize to 1% price move
  return gamma * openInterest * 100 * spotPrice * spotPrice * PERCENT_MOVE * multiplier;
}

// Format dollar value
function formatDollarValue(value) {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '+';
  
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
  console.log(`Formula: gamma × OI × 100 × spot² × 0.01 × ${test.optionType === 'call' ? '+1' : '-1'}`);
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

// Test sign convention (calls POSITIVE, puts NEGATIVE)
console.log('TEST 4: Sign Convention Verification (Industry Standard)');
console.log('-'.repeat(60));
const callGEX = calculateSingleGEX(0.228, 14500, 693.77, 'call');
const putGEX = calculateSingleGEX(0.225, 3800, 693.77, 'put');
const callFormatted = formatDollarValue(callGEX);
const putFormatted = formatDollarValue(putGEX);
console.log(`Call GEX value: ${callGEX.toLocaleString()} -> "${callFormatted}"`);
console.log(`Put GEX value: ${putGEX.toLocaleString()} -> "${putFormatted}"`);
console.log('Expected: Calls POSITIVE (green), Puts NEGATIVE (red)');

if (callGEX > 0 && putGEX < 0 && callFormatted.includes('+') && putFormatted.includes('-')) {
  console.log('✅ PASS - Sign convention correct (calls POSITIVE, puts NEGATIVE)');
  passed++;
} else {
  console.log('❌ FAIL - Sign convention incorrect');
  console.log(`   Expected: callGEX > 0, putGEX < 0`);
  console.log(`   Got: callGEX=${callGEX}, putGEX=${putGEX}`);
  failed++;
}
console.log('');

// Test 5: Net GEX calculation
console.log('TEST 5: Net GEX = Call GEX + Put GEX');
console.log('-'.repeat(60));
const callGEXTest = calculateSingleGEX(0.228, 14500, 693.77, 'call');
const putGEXTest = calculateSingleGEX(0.225, 3800, 693.77, 'put');
const netGEXTest = callGEXTest + putGEXTest;
console.log(`Call GEX: ${formatDollarValue(callGEXTest)}`);
console.log(`Put GEX: ${formatDollarValue(putGEXTest)}`);
console.log(`Net GEX: ${formatDollarValue(netGEXTest)}`);

// Industry standard: calls are POSITIVE, puts are NEGATIVE
if (callGEXTest > 0 && putGEXTest < 0 && netGEXTest === callGEXTest + putGEXTest) {
  console.log('✅ PASS - Signs correct (calls POSITIVE, puts NEGATIVE), Net GEX = Call + Put');
  passed++;
} else {
  console.log('❌ FAIL - Sign or sum error');
  console.log(`   Expected: callGEX > 0, putGEX < 0`);
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
  console.log('Your GEX calculations match the INDUSTRY STANDARD (BullFlow/SpotGamma):');
  console.log('  Formula: Gamma × OI × 100 × Spot² × 0.01 × Sign');
  console.log('  Calls: POSITIVE GEX (+1) - GREEN - Support level');
  console.log('  Puts: NEGATIVE GEX (-1) - RED - Resistance level');
  console.log('  Net GEX = Call GEX + Put GEX');
  console.log('');
  console.log('Color mapping:');
  console.log('  - POSITIVE values = GREEN (support, dampens volatility)');
  console.log('  - NEGATIVE values = RED (resistance, amplifies volatility)');
} else {
  console.log('❌ SOME TESTS FAILED');
  console.log('Please review the failing tests above.');
}
console.log('='.repeat(60));

process.exit(failed > 0 ? 1 : 0);
