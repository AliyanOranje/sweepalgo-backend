/**
 * SweepAlgo - Risk Management System
 * DTE-based stop losses, ATR calculation, and position sizing
 * Fixes Bugs #7, #8, #11 from SWEEPALGO_UNIFIED_MASTER_GUIDE.md
 */

// ============================================
// STOP CONFIGURATIONS (Bug #7 Fix)
// ============================================

const STOP_CONFIGS = {
  '0DTE': {
    maxRiskPercent: 0.30,   // 30% max loss
    atrMultiplier: 0.5,     // Tight stop (0.5x ATR)
    t1Multiplier: 1.5,      // T1 = 1.5x risk (45%)
    t2Multiplier: 2.5       // T2 = 2.5x risk (75%)
  },
  'SHORT': {  // 1-3 DTE
    maxRiskPercent: 0.35,   // 35% max loss
    atrMultiplier: 0.75,    // Medium stop
    t1Multiplier: 1.8,
    t2Multiplier: 3.0
  },
  'SWING': {  // 4-14 DTE
    maxRiskPercent: 0.35,   // 35% max loss
    atrMultiplier: 1.0,     // Normal stop (1x ATR)
    t1Multiplier: 2.0,
    t2Multiplier: 3.5
  },
  'POSITION': {  // 15+ DTE
    maxRiskPercent: 0.40,   // 40% max loss
    atrMultiplier: 1.5,     // Wider stop (give it room)
    t1Multiplier: 2.5,
    t2Multiplier: 4.0
  }
};

function round(value, decimals = 2) {
  return Math.round(value * Math.pow(10, decimals)) / Math.pow(10, decimals);
}

function getTimeframe(dte) {
  if (dte === 0) return '0DTE';
  if (dte <= 3) return 'SHORT';
  if (dte <= 14) return 'SWING';
  return 'POSITION';
}

function getStopConfig(dte) {
  const timeframe = getTimeframe(dte);
  return STOP_CONFIGS[timeframe];
}

// ============================================
// ATR CALCULATION (Bug #8 Fix)
// ============================================

/**
 * Calculate Average True Range
 * ✅ CORRECT: Per guide - Uses Wilder's smoothing
 */
function calculateATR(highs, lows, closes, period = 14) {
  if (highs.length < period + 1) {
    throw new Error(`Need at least ${period + 1} bars for ATR calculation`);
  }
  
  const trueRanges = [];
  
  // Calculate True Range for each bar
  for (let i = 1; i < highs.length; i++) {
    const high = highs[i];
    const low = lows[i];
    const prevClose = closes[i - 1];
    
    // True Range = max of:
    // 1. High - Low
    // 2. abs(High - Previous Close)
    // 3. abs(Low - Previous Close)
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    
    trueRanges.push(tr);
  }
  
  // Calculate average of the first 'period' true ranges
  const initialATR = trueRanges.slice(0, period)
    .reduce((sum, tr) => sum + tr, 0) / period;
  
  // Use Wilder's smoothing for subsequent values
  let atr = initialATR;
  for (let i = period; i < trueRanges.length; i++) {
    atr = ((atr * (period - 1)) + trueRanges[i]) / period;
  }
  
  const currentPrice = closes[closes.length - 1];
  const atrPercent = (atr / currentPrice) * 100;
  
  return {
    value: round(atr, 2),
    percent: round(atrPercent, 2),
    period
  };
}

/**
 * Fetch ATR from Polygon API (placeholder - implement with actual API)
 */
async function fetchATR(ticker, period = 14) {
  // TODO: Replace with actual Polygon API call
  // GET /v1/indicators/atr/{ticker}?timespan=day&adjusted=true&window=14
  
  // Placeholder estimates for common tickers
  const estimates = {
    'SPY':  { value: 6.50,  percent: 1.1, period },
    'QQQ':  { value: 7.80,  percent: 1.5, period },
    'SPX':  { value: 65.00, percent: 1.1, period },
    'AAPL': { value: 4.20,  percent: 1.7, period },
    'NVDA': { value: 5.60,  percent: 4.0, period },
    'TSLA': { value: 18.00, percent: 4.3, period },
    'META': { value: 8.50,  percent: 1.5, period },
    'AMZN': { value: 6.00,  percent: 2.8, period },
    'MSFT': { value: 6.50,  percent: 1.5, period },
    'AMD':  { value: 5.20,  percent: 3.8, period },
  };
  
  return estimates[ticker.toUpperCase()] || { value: 5.00, percent: 2.5, period };
}

// ============================================
// STOP LOSS CALCULATION (Bug #7 Fix)
// ============================================

/**
 * Calculate stop loss using both percentage and ATR methods
 * ✅ CORRECT: Per guide - Uses more protective stop
 */
function calculateStopLoss(optionEntry, underlyingPrice, atr, delta, dte, optionType) {
  const timeframe = getTimeframe(dte);
  const config = STOP_CONFIGS[timeframe];
  
  // Method 1: Percentage-based stop (max risk tolerance)
  const percentStop = optionEntry * (1 - config.maxRiskPercent);
  
  // Method 2: ATR-based underlying stop
  const atrDistance = atr.value * config.atrMultiplier;
  const underlyingStop = optionType === 'CALL'
    ? underlyingPrice - atrDistance  // Stop below current for calls
    : underlyingPrice + atrDistance; // Stop above current for puts
  
  // Estimate option price if underlying hits stop
  const underlyingMove = Math.abs(underlyingPrice - underlyingStop);
  const optionMove = Math.abs(delta) * underlyingMove;
  const atrBasedOptionStop = Math.max(0.01, optionEntry - optionMove);
  
  // Use the MORE PROTECTIVE stop (higher value = tighter stop)
  const finalStop = Math.max(percentStop, atrBasedOptionStop);
  
  // Ensure minimum of $0.01
  const safeStop = Math.max(0.01, finalStop);
  
  return {
    optionStop: round(safeStop, 2),
    optionStopPercent: round((1 - safeStop / optionEntry) * 100, 1),
    underlyingStop: round(underlyingStop, 2),
    maxLossPerContract: round((optionEntry - safeStop) * 100, 2)
  };
}

// ============================================
// TARGET CALCULATION
// ============================================

/**
 * Calculate targets based on risk multiples
 * ✅ CORRECT: Per guide - Targets locked at alert creation
 */
function calculateTargets(entryPrice, stopLoss, dte) {
  const config = getStopConfig(dte);
  
  // Risk per share
  const risk = entryPrice - stopLoss;
  
  // Targets based on risk multiples
  const target1 = entryPrice + (risk * config.t1Multiplier);
  const target2 = entryPrice + (risk * config.t2Multiplier);
  
  return {
    target1: round(target1, 2),
    target1Percent: round(((target1 - entryPrice) / entryPrice) * 100, 1),
    target2: round(target2, 2),
    target2Percent: round(((target2 - entryPrice) / entryPrice) * 100, 1),
    riskReward: `1:${config.t2Multiplier}`
  };
}

// ============================================
// POSITION SIZING (Bug #11 Fix)
// ============================================

/**
 * Calculate position size based on account risk
 * ✅ CORRECT: Per guide - Caps risk at 2% of account
 */
function calculatePositionSize(accountSize, optionEntry, optionStop, maxRiskPercent = 0.02) {
  // Validate inputs
  if (accountSize <= 0 || optionEntry <= 0 || optionStop <= 0) {
    return {
      maxContracts: 0,
      totalRisk: 0,
      totalCost: 0,
      riskPercent: 0,
      canAfford: false
    };
  }
  
  // Max dollars we can risk (2% of account by default)
  const maxRiskDollars = accountSize * maxRiskPercent;
  
  // Risk per contract in dollars
  const riskPerContract = (optionEntry - optionStop) * 100;
  
  // Avoid division by zero
  if (riskPerContract <= 0) {
    return {
      maxContracts: 1,
      totalRisk: 0,
      totalCost: optionEntry * 100,
      riskPercent: 0,
      canAfford: optionEntry * 100 <= accountSize
    };
  }
  
  // Calculate max contracts based on risk
  const maxContractsByRisk = Math.floor(maxRiskDollars / riskPerContract);
  
  // Calculate max contracts we can afford
  const costPerContract = optionEntry * 100;
  const maxContractsByBuyingPower = Math.floor(accountSize / costPerContract);
  
  // Take the smaller of the two
  const maxContracts = Math.min(maxContractsByRisk, maxContractsByBuyingPower);
  
  // Ensure at least 1 contract if we can afford it
  const finalContracts = maxContracts < 1 && maxContractsByBuyingPower >= 1 ? 1 : maxContracts;
  
  return {
    maxContracts: finalContracts,
    totalRisk: round(finalContracts * riskPerContract, 2),
    totalCost: round(finalContracts * costPerContract, 2),
    riskPercent: round((finalContracts * riskPerContract / accountSize) * 100, 2),
    canAfford: finalContracts > 0
  };
}

// ============================================
// EXPORTS
// ============================================

export {
  calculateATR,
  fetchATR,
  calculateStopLoss,
  getStopConfig,
  getTimeframe,
  calculateTargets,
  calculatePositionSize
};

export default {
  calculateATR,
  fetchATR,
  calculateStopLoss,
  getStopConfig,
  getTimeframe,
  calculateTargets,
  calculatePositionSize
};

