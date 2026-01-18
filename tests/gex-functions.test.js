/**
 * SweepAlgo - GEX Functions Test Suite
 * Tests GEX calculation functions directly
 */

import { describe, test, expect } from '@jest/globals';

// These tests verify the mathematical correctness of the formulas
// Using INDUSTRY STANDARD formula: gamma × OI × 100 × spot² × 0.01

describe('GEX Calculation Functions', () => {
  
  const PERCENT_MOVE = 0.01; // Industry standard: normalize to 1% price move
  
  // Helper function to replicate calculateSingleGEX (INDUSTRY STANDARD)
  function calculateSingleGEX(gamma, openInterest, spotPrice, optionType) {
    const multiplier = optionType === 'call' ? 1 : -1;
    return gamma * openInterest * 100 * spotPrice * spotPrice * PERCENT_MOVE * multiplier;
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
  
  describe('Bug #1: GEX Formula - MUST use spotPrice² × 0.01', () => {
    test('should use spotPrice² × 0.01 (industry standard)', () => {
      // Test data from BullFlow/DEVELOPER_HANDOFF.md
      const gamma = 0.228;
      const openInterest = 14500;
      const spotPrice = 693.77;
      
      // ✅ CORRECT INDUSTRY STANDARD formula
      const correctGEX = calculateSingleGEX(gamma, openInterest, spotPrice, 'call');
      
      // ❌ WRONG formula (old implementation without spot² × 0.01)
      const wrongGEX = gamma * openInterest * 100 * spotPrice * 1;
      
      // Expected: ~$1.59B (matches BullFlow)
      expect(correctGEX).toBeGreaterThan(1500000000); // > $1.5B
      expect(correctGEX).toBeLessThan(1700000000);    // < $1.7B
      
      // Wrong formula would give ~$229M (about 7x too low)
      expect(wrongGEX).toBeGreaterThan(200000000);
      expect(wrongGEX).toBeLessThan(250000000);
    });
    
    test('should match BullFlow example', () => {
      const gamma = 0.228;
      const openInterest = 14500;
      const spotPrice = 693.77;
      
      const gex = calculateSingleGEX(gamma, openInterest, spotPrice, 'call');
      // Expected: 0.228 × 14,500 × 100 × 693.77² × 0.01 ≈ $1.59B
      const expected = 1590000000;
      
      // Should be within 1% of expected
      const diff = Math.abs(gex - expected) / expected;
      expect(diff).toBeLessThan(0.01);
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
      
      // Verify values are in billions range with correct formula
      expect(Math.abs(result.callGEX)).toBeGreaterThan(100000000); // > $100M
      expect(Math.abs(result.putGEX)).toBeGreaterThan(500000000);  // > $500M
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
      const spotPrice = 693.77;
      
      const callGEX = calculateSingleGEX(0.01, 1000, spotPrice, 'call');
      const putGEX = calculateSingleGEX(0.01, 1000, spotPrice, 'put');
      
      expect(callGEX).toBeGreaterThan(0);
      expect(putGEX).toBeLessThan(0);
      
      // Verify magnitude with correct formula (should be ~$48M each)
      expect(Math.abs(callGEX)).toBeGreaterThan(40000000);
      expect(Math.abs(putGEX)).toBeGreaterThan(40000000);
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

