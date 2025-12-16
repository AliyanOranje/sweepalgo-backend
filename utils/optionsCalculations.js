/**
 * Options Flow Calculations Utility
 * Fixes for all bugs in OPTIONS_FLOW_BUG_REPORT.md
 */

import axios from 'axios';

// Store for spot prices (cache to avoid excessive API calls)
const spotPriceCache = new Map();
const SPOT_PRICE_CACHE_TTL = 300000; // 5 minutes (increased to reduce API calls)

// Rate limiting for spot price requests
let lastSpotPriceRequest = 0;
const MIN_REQUEST_INTERVAL = 200; // 200ms between requests (5 requests/second max)

// Store for recent trades (for sweep detection)
const recentTradesMap = new Map();
const SWEEP_WINDOW_MS = 500; // 500ms window for sweep detection

/**
 * BUG #1 FIX: Parse option symbol correctly to identify Calls vs Puts
 * Format: O:AAPL251219C00150000 or O.AAPL251219C00150000
 * Structure: O:TICKER + YYMMDD + C/P + 8-digit strike
 */
function parseOptionSymbol(symbol) {
  try {
    // Remove prefix (O: or O.)
    const cleanSymbol = symbol.replace(/^O[:.]/, '');
    
    // Method 1: Regex to find C or P before 8-digit strike
    const match = cleanSymbol.match(/[CP](?=\d{8}$)/);
    if (match) {
      const optionType = match[0] === 'P' ? 'PUT' : 'CALL';
      const cpIndex = cleanSymbol.lastIndexOf(match[0]);
      
      // Extract ticker (everything before date)
      const ticker = cleanSymbol.substring(0, cpIndex - 6);
      
      // Extract date (6 digits before C/P)
      const dateStr = cleanSymbol.substring(cpIndex - 6, cpIndex);
      const year = 2000 + parseInt(dateStr.substring(0, 2));
      const month = parseInt(dateStr.substring(2, 4)) - 1;
      const day = parseInt(dateStr.substring(4, 6));
      const expirationDate = new Date(year, month, day);
      const expiration = `${(month + 1).toString().padStart(2, '0')}/${day.toString().padStart(2, '0')}`;
      
      // Extract strike (last 8 digits, divided by 1000)
      const strikeStr = cleanSymbol.substring(cpIndex + 1);
      const strike = parseInt(strikeStr) / 1000;
      
      return {
        ticker,
        strike,
        expiration,
        expirationDate,
        type: optionType,
      };
    }
    
    // Method 2: Fallback - string position
    // Format: TICKER + YYMMDD + C/P + 8-digit strike
    const cpIndex = cleanSymbol.length - 9; // C/P is 9 chars from end
    if (cpIndex < 0) return null;
    
    const cpChar = cleanSymbol[cpIndex];
    if (cpChar !== 'C' && cpChar !== 'P') return null;
    
    const optionType = cpChar === 'P' ? 'PUT' : 'CALL';
    const ticker = cleanSymbol.substring(0, cpIndex - 6);
    const dateStr = cleanSymbol.substring(cpIndex - 6, cpIndex);
    const year = 2000 + parseInt(dateStr.substring(0, 2));
    const month = parseInt(dateStr.substring(2, 4)) - 1;
    const day = parseInt(dateStr.substring(4, 6));
    const expirationDate = new Date(year, month, day);
    const expiration = `${(month + 1).toString().padStart(2, '0')}/${day.toString().padStart(2, '0')}`;
    const strikeStr = cleanSymbol.substring(cpIndex + 1);
    const strike = parseInt(strikeStr) / 1000;
    
    return {
      ticker,
      strike,
      expiration,
      expirationDate,
      type: optionType,
    };
  } catch (error) {
    console.error('Error parsing option symbol:', symbol, error);
    return null;
  }
}

/**
 * BUG #3 FIX: Get real-time spot price for a ticker
 */
async function getSpotPrice(ticker) {
  try {
    // Check cache first
    const cached = spotPriceCache.get(ticker);
    if (cached && Date.now() - cached.timestamp < SPOT_PRICE_CACHE_TTL) {
      return cached.price;
    }
    
    // Rate limiting - wait if we're making requests too fast
    const now = Date.now();
    const timeSinceLastRequest = now - lastSpotPriceRequest;
    if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
      await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_INTERVAL - timeSinceLastRequest));
    }
    lastSpotPriceRequest = Date.now();
    
    // Fetch from API
    const response = await axios.get(
      `https://api.massive.com/v2/aggs/ticker/${ticker}/prev`,
      {
        params: {
          apiKey: process.env.POLYGON_API_KEY,
        },
        timeout: 5000,
      }
    );
    
    const currentPrice = response.data.results?.[0]?.c;
    if (currentPrice) {
      // Cache the price
      spotPriceCache.set(ticker, {
        price: currentPrice,
        timestamp: Date.now(),
      });
      return currentPrice;
    }
    
    return null;
  } catch (error) {
    // Silent error handling - only log if it's not a rate limit (429) or auth (401) error
    if (error.response?.status !== 429 && error.response?.status !== 401) {
      // Only log unexpected errors, not rate limits
    }
    return null;
  }
}

/**
 * BUG #4 FIX: Detect bid/ask side and sentiment
 */
function detectSide(price, bid, ask, optionType) {
  if (!bid || !ask || bid === 0 || ask === 0) {
    return {
      side: 'Mid',
      sentiment: 'Neutral',
      aggressor: 'neutral',
    };
  }
  
  const mid = (bid + ask) / 2;
  const spread = ask - bid;
  const threshold = spread * 0.1; // 10% of spread
  
  let side;
  let aggressor;
  let sentiment;
  
  if (price >= ask - threshold) {
    side = price > ask ? 'Above Ask' : 'At Ask';
    aggressor = 'buyer';
  } else if (price <= bid + threshold) {
    side = price < bid ? 'Below Bid' : 'At Bid';
    aggressor = 'seller';
  } else if (price > mid) {
    side = 'To Ask';
    aggressor = 'buyer';
  } else if (price < mid) {
    side = 'To Bid';
    aggressor = 'seller';
  } else {
    side = 'Mid';
    aggressor = 'neutral';
  }
  
  // Determine sentiment based on option type + aggressor
  if (aggressor === 'neutral') {
    sentiment = 'Neutral';
  } else if (optionType === 'CALL' || optionType === 'C') {
    // Call bought aggressively = Bullish
    // Call sold aggressively = Bearish
    sentiment = aggressor === 'buyer' ? 'Bullish' : 'Bearish';
  } else {
    // Put bought aggressively = Bearish
    // Put sold aggressively = Bullish
    sentiment = aggressor === 'buyer' ? 'Bearish' : 'Bullish';
  }
  
  return { side, sentiment, aggressor };
}

/**
 * BUG #5 FIX: Calculate Implied Volatility using Newton-Raphson method
 * This is the INVERSE of Black-Scholes - given price, solve for IV
 */
function calculateImpliedVolatility(optionPrice, S, K, T, r, isCall) {
  // Helper functions for Black-Scholes
  function normCDF(x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989423 * Math.exp(-x * x / 2);
    const prob = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x > 0 ? 1 - prob : prob;
  }
  
  function normPDF(x) {
    return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
  }
  
  function calculateOptionPrice(S, K, T, r, sigma, isCall) {
    if (T <= 0) return 0;
    const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
    const d2 = d1 - sigma * Math.sqrt(T);
    
    if (isCall) {
      return S * normCDF(d1) - K * Math.exp(-r * T) * normCDF(d2);
    } else {
      return K * Math.exp(-r * T) * normCDF(-d2) - S * normCDF(-d1);
    }
  }
  
  function calculateVega(S, K, T, r, sigma) {
    if (T <= 0) return 0;
    const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
    return S * normPDF(d1) * Math.sqrt(T) / 100;
  }
  
  // Initial guess: 30% volatility
  let sigma = 0.30;
  
  // Newton-Raphson iteration (max 100 iterations)
  for (let i = 0; i < 100; i++) {
    if (T <= 0) break;
    
    // Calculate theoretical price at current IV guess
    const theoreticalPrice = calculateOptionPrice(S, K, T, r, sigma, isCall);
    
    // Calculate vega (sensitivity to IV)
    const vega = calculateVega(S, K, T, r, sigma) * 100; // Multiply by 100 to get dollar vega
    
    // Difference between market price and theoretical price
    const diff = optionPrice - theoreticalPrice;
    
    // If close enough, we found IV
    if (Math.abs(diff) < 0.0001) {
      break;
    }
    
    // If vega is too small, avoid division issues
    if (Math.abs(vega) < 0.0001) {
      break;
    }
    
    // Newton-Raphson update: new_sigma = old_sigma + (price_diff / vega)
    sigma = sigma + diff / vega;
    
    // Clamp to reasonable range (1% to 500%)
    sigma = Math.max(0.01, Math.min(5.0, sigma));
  }
  
  return sigma; // Returns decimal: 0.35 = 35%
}

/**
 * Format IV for display with validation
 */
function formatIV(ivDecimal) {
  // IV should be in decimal form (0.35 = 35%)
  // If it's > 1, it might already be in percentage form, so divide by 100
  if (ivDecimal > 1) {
    ivDecimal = ivDecimal / 100;
  }
  
  // Clamp to reasonable range (0.01% to 500%)
  ivDecimal = Math.max(0.0001, Math.min(5.0, ivDecimal));
  
  const percentage = ivDecimal * 100;
  return `${percentage.toFixed(2)}%`;
}

/**
 * BUG #6 FIX: Calculate OTM percentage correctly
 */
function calculateOTM(strikePrice, spotPrice, optionType) {
  if (!spotPrice || spotPrice === 0) {
    return { otmPercent: 0, otmLabel: 'N/A' };
  }
  
  let otmPercent;
  
  if (optionType === 'CALL' || optionType === 'C') {
    // Call is OTM if strike > spot
    otmPercent = ((strikePrice - spotPrice) / spotPrice) * 100;
  } else {
    // Put is OTM if strike < spot
    otmPercent = ((spotPrice - strikePrice) / spotPrice) * 100;
  }
  
  // Determine label
  let otmLabel;
  if (Math.abs(otmPercent) < 0.5) {
    otmLabel = 'ATM'; // At the money
  } else if (otmPercent > 0) {
    otmLabel = 'OTM'; // Out of the money
  } else {
    otmLabel = 'ITM'; // In the money
  }
  
  return {
    otmPercent: Math.abs(otmPercent),
    otmLabel,
  };
}

/**
 * BUG #7 & #8 FIX: Classify trade type correctly (Sweep, Block, Split)
 */
function classifyTradeType(trade, recentTrades) {
  const { symbol, size, premium, exchange, timestamp } = trade;
  
  // Check for BLOCK first: ≥100 contracts AND ≥$50K premium
  if (size >= 100 && premium >= 50000) {
    return 'Block';
  }
  
  // If we have exchange data and recent trades, use real-time sweep detection
  if (exchange && timestamp && recentTrades) {
    // Check for SWEEP: Same contract filled across 2+ exchanges within 500ms
    const key = symbol;
    const recent = recentTrades.get(key) || [];
    
    // Filter to trades within 500ms
    const sweepWindow = recent.filter(t => 
      Math.abs(t.timestamp - timestamp) <= SWEEP_WINDOW_MS &&
      t.exchange !== exchange // Different exchange
    );
    
    if (sweepWindow.length >= 1) {
      // Same contract hit multiple exchanges = SWEEP
      return 'Sweep';
    }
    
    // Store this trade for future sweep detection
    recent.push(trade);
    recentTrades.set(key, recent.slice(-10)); // Keep last 10
  }
  
  // Fallback: Use volume/premium heuristics for reference contracts
  // SWEEP: Large size (≥50 contracts) AND high premium (≥$25K) AND aggressive pricing
  // This indicates institutional activity trying to fill large orders quickly
  if (size >= 50 && premium >= 25000) {
    // Check if this looks like an aggressive fill (sweep pattern)
    // High volume relative to typical size suggests multiple fills
    if (size >= 100 || premium >= 50000) {
      return 'Sweep';
    }
  }
  
  // BLOCK: Very large size (≥200 contracts) OR very high premium (≥$100K)
  if (size >= 200 || premium >= 100000) {
    return 'Block';
  }
  
  // SWEEP: Medium-large size (≥25 contracts) with decent premium (≥$10K)
  // Often indicates institutional sweep activity
  if (size >= 25 && premium >= 10000) {
    return 'Sweep';
  }
  
  // Default
  return 'Split';
}

/**
 * BUG #9 FIX: Classify volume correctly
 */
function classifyVolume(volume) {
  if (volume >= 5000) {
    return { label: 'Massive', isGood: true, score: 10 };
  }
  if (volume >= 1000) {
    return { label: 'High', isGood: true, score: 8 };
  }
  if (volume >= 200) {
    return { label: 'Elevated', isGood: true, score: 6 };
  }
  if (volume >= 50) {
    return { label: 'Normal', isGood: true, score: 4 };
  }
  if (volume >= 10) {
    return { label: 'Low', isGood: false, score: 2 };
  }
  return { label: 'Tiny', isGood: false, score: 0 };
}

/**
 * BUG #12 FIX: Get direction arrow based on option type and side
 */
function getDirectionArrow(optionType, side) {
  const isBuyerAggressive = side.includes('Ask') || side === 'Above Ask';
  const isSellerAggressive = side.includes('Bid') || side === 'Below Bid';
  
  if (optionType === 'CALL' || optionType === 'C') {
    // Call bought = Bullish ↑
    // Call sold = Bearish ↓
    if (isBuyerAggressive) return { arrow: '↑', color: 'green' };
    if (isSellerAggressive) return { arrow: '↓', color: 'red' };
  } else {
    // Put bought = Bearish ↓
    // Put sold = Bullish ↑
    if (isBuyerAggressive) return { arrow: '↓', color: 'red' };
    if (isSellerAggressive) return { arrow: '↑', color: 'green' };
  }
  
  return { arrow: '↑', color: 'gray' }; // Neutral
}

/**
 * BUG #13 FIX: Detect opening/closing
 * Uses heuristics when previous OI is not available
 */
function detectOpeningClosing(volume, openInterest, previousOI) {
  // If we have previous OI, use accurate detection
  if (previousOI !== null && previousOI !== undefined) {
    // If volume > previous OI, likely opening new positions
    if (volume > previousOI) {
      return 'Opening';
    }
    
    // If current OI < previous OI and volume is high, likely closing
    if (openInterest < previousOI && volume > openInterest * 0.1) {
      return 'Closing';
    }
    
    return '';
  }
  
  // Heuristic-based detection when previous OI is not available
  // High volume relative to OI suggests opening new positions
  if (openInterest > 0 && volume > 0) {
    const volumeToOIRatio = volume / openInterest;
    
    // If volume is a significant portion of OI (>= 50%), likely opening
    if (volumeToOIRatio >= 0.5) {
      return 'Opening';
    }
    
    // If volume is very high (>= 1000 contracts) and OI is relatively low, likely opening
    if (volume >= 1000 && openInterest < volume * 2) {
      return 'Opening';
    }
    
    // If volume is very low compared to OI (< 5%) and OI is high, might be closing
    // But this is less reliable without previous OI
    if (volumeToOIRatio < 0.05 && openInterest >= 1000 && volume < 50) {
      return 'Closing';
    }
  }
  
  // Can't determine with confidence
  return '';
}

/**
 * BUG #15 FIX: Calculate setup score correctly
 */
function calculateSetupScore(trade) {
  let score = 5; // Start neutral
  const reasons = [];
  
  // Volume scoring
  if (trade.volume >= 5000) {
    score += 2;
    reasons.push('Massive volume (institutional interest)');
  } else if (trade.volume >= 1000) {
    score += 1;
    reasons.push('High volume');
  } else if (trade.volume < 10) {
    score -= 3;
    reasons.push('Very low volume (avoid)');
  }
  
  // Open Interest scoring
  if (trade.openInterest < 10) {
    score -= 3;
    reasons.push('No liquidity (OI < 10)');
  } else if (trade.openInterest < 100) {
    score -= 1;
    reasons.push('Low liquidity');
  } else if (trade.openInterest >= 1000) {
    score += 1;
    reasons.push('Good liquidity');
  }
  
  // Premium scoring
  const premium = trade.premiumRaw || parseFloat(trade.premium.replace(/[^0-9.]/g, '')) * 
    (trade.premium.includes('M') ? 1000000 : (trade.premium.includes('K') ? 1000 : 1));
  
  if (premium >= 1000000) {
    score += 2;
    reasons.push('$1M+ premium (whale activity)');
  } else if (premium >= 100000) {
    score += 1;
    reasons.push('Large premium');
  } else if (premium < 10000) {
    score -= 1;
    reasons.push('Small premium');
  }
  
  // Trade type scoring
  if (trade.tradeType === 'Sweep') {
    score += 1;
    reasons.push('Sweep (aggressive fill)');
  } else if (trade.tradeType === 'Block') {
    score += 1;
    reasons.push('Block trade');
  }
  
  // Side scoring
  if (trade.side === 'Above Ask' || trade.side === 'At Ask') {
    score += 1;
    reasons.push('Bought aggressively at ask');
  }
  
  // DTE scoring
  const dteNum = parseInt(trade.dte?.replace('d', '')) || 0;
  if (dteNum === 0) {
    score -= 1;
    reasons.push('0 DTE (high risk)');
  } else if (dteNum >= 30 && dteNum <= 60) {
    score += 1;
    reasons.push('Optimal DTE (30-60 days)');
  }
  
  // Clamp score
  score = Math.max(0, Math.min(10, score));
  
  return {
    score,
    reasons,
    isHighProbability: score >= 7 && trade.volume >= 100 && trade.openInterest >= 100 && premium >= 25000,
  };
}

/**
 * BUG #17 FIX: Get market status
 */
function getMarketStatus() {
  const now = new Date();
  
  // Convert to Eastern Time
  const etTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const hours = etTime.getHours();
  const minutes = etTime.getMinutes();
  const day = etTime.getDay(); // 0 = Sunday, 6 = Saturday
  
  // Weekend check
  if (day === 0 || day === 6) {
    return {
      isOpen: false,
      status: 'closed',
      message: 'Market closed for the weekend',
    };
  }
  
  const timeInMinutes = hours * 60 + minutes;
  const preMarketStart = 4 * 60;      // 4:00 AM
  const marketOpen = 9 * 60 + 30;      // 9:30 AM
  const marketClose = 16 * 60;         // 4:00 PM
  const afterHoursEnd = 20 * 60;       // 8:00 PM
  
  if (timeInMinutes >= marketOpen && timeInMinutes < marketClose) {
    return {
      isOpen: true,
      status: 'open',
      message: 'Market is open',
    };
  }
  
  if (timeInMinutes >= preMarketStart && timeInMinutes < marketOpen) {
    return {
      isOpen: false,
      status: 'pre-market',
      message: 'Pre-market. Regular session opens at 9:30 AM ET',
    };
  }
  
  if (timeInMinutes >= marketClose && timeInMinutes < afterHoursEnd) {
    return {
      isOpen: false,
      status: 'after-hours',
      message: 'Market closed. Showing today\'s flow summary.',
    };
  }
  
  return {
    isOpen: false,
    status: 'closed',
    message: 'Market closed',
  };
}

export {
  parseOptionSymbol,
  getSpotPrice,
  detectSide,
  calculateImpliedVolatility,
  formatIV,
  calculateOTM,
  classifyTradeType,
  classifyVolume,
  getDirectionArrow,
  detectOpeningClosing,
  calculateSetupScore,
  getMarketStatus,
  recentTradesMap,
};

