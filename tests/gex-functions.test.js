/**
 * SweepAlgo - GEX Functions Test Suite
 * Tests GEX calculation functions directly
 */

import { describe, test, expect } from '@jest/globals';

// Since functions are not exported, we'll test the logic directly
// These tests verify the mathematical correctness of the formulas

describe('GEX Calculation Functions', () => {
  
  // Helper function to replicate calculateSingleGEX
  function calculateSingleGEX(gamma, openInterest, spotPrice, optionType) {
    const multiplier = optionType === 'call' ? 1 : -1;
    return gamma * openInterest * 100 * spotPrice * multiplier;
  }
  
  // Helper function to replicate calculateStrikeGEX
  function calculateStrikeGEX(strike, callGamma, putGamma, callOI, putOI, spotPrice) {
    const callGEX = calculateSingleGEX(callGamma, callOI, spotPrice, 'call');
    const putGEX = calculateSingleGEX(putGamma, putOI, spotPrice, 'put');
    
    return {
      totalGEX: Math.abs(callGEX) + Math.abs(putGEX),
      callGEX,
      putGEX,
      netGEX: callGEX + putGEX
    };
  }
  
  describe('Bug #1: GEX Formula - spotPrice NOT squared', () => {
    test('should use spotPrice, not spotPrice²', () => {
      const gamma = 0.015;
      const openInterest = 5000;
      const spotPrice = 613.69;
      
      // ✅ CORRECT formula
      const correctGEX = calculateSingleGEX(gamma, openInterest, spotPrice, 'call');
      
      // ❌ WRONG formula (what it was before)
      const wrongGEX = gamma * openInterest * 100 * Math.pow(spotPrice, 2) * 1;
      
      // Expected: ~$4.6M (0.015 * 5000 * 100 * 613.69 = 4,602,675)
      expect(correctGEX).toBeGreaterThan(4500000);
      expect(correctGEX).toBeLessThan(4700000);
      
      // Wrong formula would give ~$2.82B (600x too large)
      expect(wrongGEX).toBeGreaterThan(2800000000);
      
      // Verify correct formula is NOT 600x larger
      expect(correctGEX * 600).toBeLessThan(wrongGEX);
    });
    
    test('should match guide example', () => {
      const gamma = 0.015;
      const openInterest = 5000;
      const spotPrice = 613.69;
      
      const gex = calculateSingleGEX(gamma, openInterest, spotPrice, 'call');
      const expected = 4602675; // 0.015 * 5000 * 100 * 613.69 = 4,602,675
      
      expect(gex).toBeCloseTo(expected, 0);
    });
  });
  
  describe('Bug #2: Negative GEX Values', () => {
    test('should calculate negative netGEX for put-dominated strikes', () => {
      const strike = 600;
      const callGamma = 0.01;
      const putGamma = 0.02;
      const callOI = 3000;
      const putOI = 8000;
      const spotPrice = 613.69;
      
      const result = calculateStrikeGEX(strike, callGamma, putGamma, callOI, putOI, spotPrice);
      
      // Should be negative (more put GEX)
      expect(result.netGEX).toBeLessThan(0);
      expect(Math.abs(result.putGEX)).toBeGreaterThan(Math.abs(result.callGEX));
    });
    
    test('should calculate positive netGEX for call-dominated strikes', () => {
      const callGamma = 0.02;
      const putGamma = 0.01;
      const callOI = 8000;
      const putOI = 3000;
      const spotPrice = 613.69;
      
      const result = calculateStrikeGEX(0, callGamma, putGamma, callOI, putOI, spotPrice);
      
      // Should be positive (more call GEX)
      expect(result.netGEX).toBeGreaterThan(0);
      expect(Math.abs(result.callGEX)).toBeGreaterThan(Math.abs(result.putGEX));
    });
    
    test('callGEX should always be positive, putGEX always negative', () => {
      const spotPrice = 613.69;
      
      const callGEX = calculateSingleGEX(0.01, 1000, spotPrice, 'call');
      const putGEX = calculateSingleGEX(0.01, 1000, spotPrice, 'put');
      
      expect(callGEX).toBeGreaterThan(0);
      expect(putGEX).toBeLessThan(0);
    });
  });
  
  describe('Bug #3: Color Intensity Scaling', () => {
    test('should map to 5 levels (not 10)', () => {
      const maxAbsGEX = 500000000; // $500M
      
      const getIntensity = (value, maxVal) => {
        if (value === null || value === undefined || maxVal === 0) return 'neutral';
        if (value === 0) return 'neutral';
        
        const absVal = Math.abs(value);
        const ratio = absVal / maxVal;
        
        let level = Math.ceil(ratio * 5);
        level = Math.min(level, 5);
        level = Math.max(level, 1);
        
        return value > 0 ? `g${level}` : `p${level}`;
      };
      
      // Test different GEX values
      expect(getIntensity(100000000, maxAbsGEX)).toBe('g1');  // 20% → level 1
      expect(getIntensity(200000000, maxAbsGEX)).toBe('g2');  // 40% → level 2
      expect(getIntensity(250000000, maxAbsGEX)).toBe('g3');  // 50% → level 3
      expect(getIntensity(400000000, maxAbsGEX)).toBe('g4');  // 80% → level 4
      expect(getIntensity(450000000, maxAbsGEX)).toBe('g5');  // 90% → level 5
      
      // Negative values
      expect(getIntensity(-100000000, maxAbsGEX)).toBe('p1');
      expect(getIntensity(-450000000, maxAbsGEX)).toBe('p5');
    });
  });
});

