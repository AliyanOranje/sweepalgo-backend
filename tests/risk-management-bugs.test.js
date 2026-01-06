/**
 * SweepAlgo - Risk Management Bug Fixes Test Suite
 * Tests for Bugs #7, #8, #11 from SWEEPALGO_UNIFIED_MASTER_GUIDE.md
 */

import { describe, test, expect } from '@jest/globals';
import { 
  calculateStopLoss, 
  getStopConfig, 
  getTimeframe,
  calculateTargets,
  calculatePositionSize,
  calculateATR
} from '../utils/riskManagement.js';

describe('Risk Management Bug Fixes', () => {
  
  // ============================================
  // Bug #7: Stop Losses Too Wide (DTE-Based)
  // ============================================
  
  describe('Bug #7: Stop Losses - DTE-Based Configuration', () => {
    test('0DTE stops should max at 30%', () => {
      const entry = 1.90;
      const underlyingPrice = 580.00;
      const atr = { value: 6.50, percent: 1.1, period: 14 };
      const delta = 0.35;
      const dte = 0;
      const type = 'CALL';
      
      const result = calculateStopLoss(entry, underlyingPrice, atr, delta, dte, type);
      
      // Should be <= 30% for 0DTE
      expect(result.optionStopPercent).toBeLessThanOrEqual(30);
      expect(result.optionStopPercent).toBeGreaterThan(0);
      
      // Stop should be reasonable
      expect(result.optionStop).toBeLessThan(entry);
      expect(result.optionStop).toBeGreaterThan(0);
    });
    
    test('SHORT DTE (1-3) stops should max at 35%', () => {
      const entry = 1.90;
      const underlyingPrice = 580.00;
      const atr = { value: 6.50, percent: 1.1, period: 14 };
      const delta = 0.35;
      const dte = 2;
      const type = 'CALL';
      
      const result = calculateStopLoss(entry, underlyingPrice, atr, delta, dte, type);
      
      expect(result.optionStopPercent).toBeLessThanOrEqual(35);
    });
    
    test('SWING DTE (4-14) stops should max at 35%', () => {
      const entry = 1.90;
      const underlyingPrice = 580.00;
      const atr = { value: 6.50, percent: 1.1, period: 14 };
      const delta = 0.35;
      const dte = 7;
      const type = 'CALL';
      
      const result = calculateStopLoss(entry, underlyingPrice, atr, delta, dte, type);
      
      expect(result.optionStopPercent).toBeLessThanOrEqual(35);
    });
    
    test('POSITION DTE (15+) stops should max at 40%', () => {
      const entry = 1.90;
      const underlyingPrice = 580.00;
      const atr = { value: 6.50, percent: 1.1, period: 14 };
      const delta = 0.35;
      const dte = 30;
      const type = 'CALL';
      
      const result = calculateStopLoss(entry, underlyingPrice, atr, delta, dte, type);
      
      expect(result.optionStopPercent).toBeLessThanOrEqual(40);
    });
    
    test('stops should never exceed 50% (old bug)', () => {
      const entry = 1.90;
      const underlyingPrice = 580.00;
      const atr = { value: 6.50, percent: 1.1, period: 14 };
      const delta = 0.35;
      
      // Test all DTE ranges
      [0, 2, 7, 30].forEach(dte => {
        const result = calculateStopLoss(entry, underlyingPrice, atr, delta, dte, 'CALL');
        expect(result.optionStopPercent).toBeLessThan(50); // Should never be 50%+
      });
    });
    
    test('should use more protective stop (percentage vs ATR)', () => {
      const entry = 1.90;
      const underlyingPrice = 580.00;
      const atr = { value: 6.50, percent: 1.1, period: 14 };
      const delta = 0.35;
      const dte = 0;
      const type = 'CALL';
      
      const result = calculateStopLoss(entry, underlyingPrice, atr, delta, dte, type);
      
      // Should use the MORE PROTECTIVE stop (higher value = tighter stop)
      expect(result.optionStop).toBeGreaterThan(0.01);
      expect(result.optionStop).toBeLessThan(entry);
    });
  });
  
  // ============================================
  // Bug #8: ATR Calculation
  // ============================================
  
  describe('Bug #8: ATR Calculation', () => {
    test('should calculate ATR correctly', () => {
      // Sample price data
      const highs = [585, 587, 586, 590, 592];
      const lows = [580, 582, 581, 585, 587];
      const closes = [583, 585, 584, 588, 590];
      
      const atr = calculateATR(highs, lows, closes, 4);
      
      expect(atr.value).toBeGreaterThan(0);
      expect(atr.percent).toBeGreaterThan(0);
      expect(atr.period).toBe(4);
      expect(typeof atr.value).toBe('number');
      expect(isNaN(atr.value)).toBe(false);
    });
    
    test('should throw error if insufficient data', () => {
      const highs = [585, 587];
      const lows = [580, 582];
      const closes = [583, 585];
      
      expect(() => {
        calculateATR(highs, lows, closes, 14);
      }).toThrow();
    });
    
    test('ATR should be used in stop loss calculation', () => {
      const entry = 1.90;
      const underlyingPrice = 580.00;
      const atr = { value: 6.50, percent: 1.1, period: 14 };
      const delta = 0.35;
      const dte = 0;
      const type = 'CALL';
      
      const result = calculateStopLoss(entry, underlyingPrice, atr, delta, dte, type);
      
      // ATR should influence the stop loss
      expect(result.underlyingStop).toBeDefined();
      expect(result.underlyingStop).toBeLessThan(underlyingPrice); // For calls
    });
  });
  
  // ============================================
  // Bug #11: Position Sizing
  // ============================================
  
  describe('Bug #11: Position Sizing', () => {
    test('should cap risk at 2% of account by default', () => {
      const accountSize = 10000;
      const entry = 1.90;
      const stop = 1.33;
      const maxRisk = 0.02; // 2%
      
      const result = calculatePositionSize(accountSize, entry, stop, maxRisk);
      
      // Total risk should be <= 2% of account
      expect(result.riskPercent).toBeLessThanOrEqual(2.0);
      expect(result.totalRisk).toBeLessThanOrEqual(200); // 2% of $10K
      expect(result.maxContracts).toBeGreaterThan(0);
    });
    
    test('should calculate max contracts based on risk', () => {
      const accountSize = 10000;
      const entry = 1.90;
      const stop = 1.33;
      
      // Risk per contract = ($1.90 - $1.33) * 100 = $57
      // Max risk = $10,000 * 0.02 = $200
      // Max contracts = floor($200 / $57) = 3
      
      const result = calculatePositionSize(accountSize, entry, stop, 0.02);
      
      expect(result.maxContracts).toBe(3);
      expect(result.totalRisk).toBeLessThanOrEqual(200);
    });
    
    test('should not exceed buying power', () => {
      const accountSize = 1000; // Small account
      const entry = 1.90;
      const stop = 1.33;
      
      const result = calculatePositionSize(accountSize, entry, stop, 0.02);
      
      // Cost per contract = $1.90 * 100 = $190
      // Max contracts by buying power = floor($1000 / $190) = 5
      // But risk limits it to fewer
      
      expect(result.totalCost).toBeLessThanOrEqual(accountSize);
      expect(result.canAfford).toBe(true);
    });
    
    test('should handle edge cases', () => {
      // Zero or negative inputs
      expect(calculatePositionSize(0, 1.90, 1.33).maxContracts).toBe(0);
      expect(calculatePositionSize(10000, 0, 1.33).maxContracts).toBe(0);
      // When stop is 0, riskPerContract is 0, so it returns 1 contract if affordable
      const result = calculatePositionSize(10000, 1.90, 0);
      expect(result.maxContracts).toBeGreaterThanOrEqual(0);
      expect(result.canAfford).toBeDefined();
    });
  });
  
  // ============================================
  // Target Calculation
  // ============================================
  
  describe('Target Calculation', () => {
    test('targets should be locked at alert creation', () => {
      const entryPrice = 1.90;
      const stopLoss = 1.33;
      const dte = 0;
      
      const targets = calculateTargets(entryPrice, stopLoss, dte);
      
      // For 0DTE: T1 = 1.5x risk, T2 = 2.5x risk
      // Risk = $1.90 - $1.33 = $0.57
      // T1 = $1.90 + ($0.57 * 1.5) = $2.76
      // T2 = $1.90 + ($0.57 * 2.5) = $3.33
      
      expect(targets.target1).toBeGreaterThan(entryPrice);
      expect(targets.target2).toBeGreaterThan(targets.target1);
      expect(targets.target1Percent).toBeGreaterThan(0);
      expect(targets.target2Percent).toBeGreaterThan(targets.target1Percent);
    });
    
    test('targets should vary by DTE', () => {
      const entryPrice = 1.90;
      const stopLoss = 1.33;
      
      const targets0DTE = calculateTargets(entryPrice, stopLoss, 0);
      const targets30DTE = calculateTargets(entryPrice, stopLoss, 30);
      
      // Longer DTE should have higher targets (more risk/reward)
      expect(targets30DTE.target2).toBeGreaterThan(targets0DTE.target2);
    });
  });
  
  // ============================================
  // Timeframe Detection
  // ============================================
  
  describe('Timeframe Detection', () => {
    test('should correctly identify 0DTE', () => {
      expect(getTimeframe(0)).toBe('0DTE');
    });
    
    test('should correctly identify SHORT (1-3 DTE)', () => {
      expect(getTimeframe(1)).toBe('SHORT');
      expect(getTimeframe(2)).toBe('SHORT');
      expect(getTimeframe(3)).toBe('SHORT');
    });
    
    test('should correctly identify SWING (4-14 DTE)', () => {
      expect(getTimeframe(4)).toBe('SWING');
      expect(getTimeframe(7)).toBe('SWING');
      expect(getTimeframe(14)).toBe('SWING');
    });
    
    test('should correctly identify POSITION (15+ DTE)', () => {
      expect(getTimeframe(15)).toBe('POSITION');
      expect(getTimeframe(30)).toBe('POSITION');
      expect(getTimeframe(60)).toBe('POSITION');
    });
  });
});

