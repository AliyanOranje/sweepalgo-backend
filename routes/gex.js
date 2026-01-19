import express from 'express';
import axios from 'axios';
import { recentTradesMap } from '../utils/optionsCalculations.js';

const router = express.Router();

// Risk-free rate (10-year Treasury yield approximation)
const RISK_FREE_RATE = 0.045; // 4.5%

// ============================================
// BLACK-SCHOLES CALCULATIONS (JavaScript)
// ============================================

/**
 * Standard Normal Cumulative Distribution Function (CDF)
 */
function normCDF(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const prob = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - prob : prob;
}

/**
 * Standard Normal Probability Density Function (PDF)
 */
function normPDF(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Calculate d1 and d2 for Black-Scholes
 */
function calculateD(S, K, T, r, sigma) {
  const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return { d1, d2 };
}

/**
 * Calculate Gamma for an option
 */
function calculateGamma(S, K, T, r, sigma) {
  const { d1 } = calculateD(S, K, T, r, sigma);
  return normPDF(d1) / (S * sigma * Math.sqrt(T));
}

/**
 * Calculate all Greeks for an option
 */
function calculateAllGreeks(S, K, T, r, sigma, isCall) {
  const { d1, d2 } = calculateD(S, K, T, r, sigma);
  const gamma = calculateGamma(S, K, T, r, sigma);
  const delta = isCall ? normCDF(d1) : normCDF(d1) - 1;
  
  return {
    delta,
    gamma,
    // Other Greeks can be added if needed
  };
}

/**
 * Convert days to years
 */
function daysToYears(days) {
  return days / 365.25;
}

// ============================================
// GEX CALCULATIONS
// ============================================

/**
 * Calculate Gamma Exposure for a single option
 * 
 * INDUSTRY STANDARD FORMULA (used by SpotGamma, BullFlow, SqueezeMetrics):
 *   GEX = Gamma × OI × 100 × Spot² × 0.01 × Direction
 * 
 * WHY spot² × 0.01?
 * - First spot: Converts gamma (per $1 move) to dollar delta
 * - Second spot × 0.01: Scales to "1% move in price"
 * - Result: "How much dealers hedge for 1% price move"
 * 
 * Example (SPY @ $693.77, gamma=0.228, OI=14,500):
 *   GEX = 0.228 × 14,500 × 100 × 693.77² × 0.01 = $1.59B
 * 
 * CRITICAL: Sign Convention (INDUSTRY STANDARD - matches BullFlow/SpotGamma):
 * - Calls: POSITIVE GEX (+1) - Green - Support level - Dampens volatility
 * - Puts: NEGATIVE GEX (-1) - Red - Resistance level - Amplifies volatility
 * 
 * This matches BullFlow's display where:
 * - Call-heavy strikes show POSITIVE GEX (green) 
 * - Put-heavy strikes show NEGATIVE GEX (red)
 */
function calculateSingleGEX(gamma, openInterest, spotPrice, optionType) {
  // INDUSTRY STANDARD: Calls = positive (+1), Puts = negative (-1)
  const multiplier = optionType === 'call' ? 1 : -1;
  const PERCENT_MOVE = 0.01; // Industry standard: normalize to 1% price move
  return gamma * openInterest * 100 * spotPrice * spotPrice * PERCENT_MOVE * multiplier;
}

/**
 * Calculate aggregate GEX at specific strike
 */
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

/**
 * Find gamma flip point (zero gamma point)
 * The price level where net gamma exposure crosses zero
 */
function findGammaFlip(optionsChain, spotPrice) {
  let prevNetGEX = 0;
  let flipPoint = null;
  
  // Sort by strike to ensure proper traversal
  const sortedChain = [...optionsChain].sort((a, b) => a.strike - b.strike);
  
  for (let i = 0; i < sortedChain.length; i++) {
    const option = sortedChain[i];
    const { netGEX } = calculateStrikeGEX(
      option.strike,
      option.callGamma,
      option.putGamma,
      option.callOI,
      option.putOI,
      spotPrice
    );
    
    // Look for sign change
    if (prevNetGEX !== 0 && Math.sign(netGEX) !== Math.sign(prevNetGEX)) {
      // Interpolate exact flip point
      const prevOption = sortedChain[i - 1];
      flipPoint = option.strike - 
        (netGEX / (netGEX - prevNetGEX)) * 
        (option.strike - prevOption.strike);
      break;
    }
    
    prevNetGEX = netGEX;
  }
  
  return flipPoint;
}

/**
 * Find key GEX levels (support/resistance)
 */
function findKeyGEXLevels(optionsChain, spotPrice) {
  const gexByStrike = [];
  
  optionsChain.forEach(option => {
    const { netGEX } = calculateStrikeGEX(
      option.strike,
      option.callGamma,
      option.putGamma,
      option.callOI,
      option.putOI,
      spotPrice
    );
    
    // ✅ CORRECT: Store both absolute value (for sorting) and netGEX (for filtering)
    gexByStrike.push({
      strike: option.strike,
      gex: Math.abs(netGEX),    // For sorting by magnitude
      netGEX: netGEX            // Keep sign for filtering
    });
  });
  
  if (gexByStrike.length === 0) {
    return {
      gammaWall: null,
      support: [],
      resistance: [],
      maxPain: null
    };
  }
  
  // ✅ CORRECT: Find gamma wall (highest ABSOLUTE GEX, regardless of sign)
  const gammaWallData = gexByStrike.reduce((max, current) => 
    current.gex > max.gex ? current : max
  );
  
  const gammaWall = {
    strike: gammaWallData.strike,
    gex: gammaWallData.gex,
    isPositive: gammaWallData.netGEX > 0
  };
  
  // ✅ CORRECT: Support = HIGH POSITIVE GEX BELOW spot price
  // (Market makers will buy dips, creating support)
  const support = gexByStrike
    .filter(item => item.strike < spotPrice && item.netGEX > 0)
    .sort((a, b) => b.gex - a.gex)
    .slice(0, 3)
    .map(item => ({ strike: item.strike, gex: item.gex }));
  
  // ✅ CORRECT: Resistance = HIGH POSITIVE GEX ABOVE spot price
  // (Market makers will sell rallies, creating resistance)
  const resistance = gexByStrike
    .filter(item => item.strike > spotPrice && item.netGEX > 0)
    .sort((a, b) => b.gex - a.gex)
    .slice(0, 3)
    .map(item => ({ strike: item.strike, gex: item.gex }));
  
  // Calculate max pain
  const maxPain = calculateMaxPain(optionsChain, spotPrice);
  
  return {
    gammaWall: gammaWall.gex > 0 ? gammaWall : null,
    support,
    resistance,
    maxPain
  };
}

/**
 * Calculate max pain strike
 */
function calculateMaxPain(optionsChain, spotPrice) {
  if (optionsChain.length === 0) return null;
  
  // ✅ CORRECT: Get unique strikes
  const strikes = [...new Set(optionsChain.map(o => o.strike))];
  
  let minPain = Infinity;
  let maxPainStrike = strikes[0];
  
  strikes.forEach(testStrike => {
    let totalPain = 0;
    
    optionsChain.forEach(option => {
      // Calculate pain for calls (ITM when strike < test)
      if (testStrike > option.strike) {
        totalPain += (testStrike - option.strike) * option.callOI;
      }
      
      // Calculate pain for puts (ITM when strike > test)
      if (testStrike < option.strike) {
        totalPain += (option.strike - testStrike) * option.putOI;
      }
    });
    
    if (totalPain < minPain) {
      minPain = totalPain;
      maxPainStrike = testStrike;
    }
  });
  
  return maxPainStrike;
}

// ============================================
// API ROUTES
// ============================================

// Test route to verify router is working
router.get('/test', (req, res) => {
  res.json({ success: true, message: 'GEX router is working!' });
});

/**
 * GET /api/gex/:ticker
 * Get Gamma Exposure analysis for a ticker
 */
router.get('/:ticker', async (req, res) => {
  try {
    const { ticker } = req.params;
    const { expiration } = req.query; // Optional: filter by expiration
    
    console.log(`📊 [GEX Route] Fetching GEX data for ${ticker}...`);
    console.log(`📊 [GEX Route] Request params:`, req.params);
    console.log(`📊 [GEX Route] Request query:`, req.query);
    
    // Fetch options chain from Polygon.io/Massive.com
    let optionsChain;
    try {
      optionsChain = await fetchOptionsChain(ticker);
    } catch (error) {
      console.error(`❌ Failed to fetch options chain for ${ticker}:`, error.message);
      
      // Try fallback: use internal options-chain endpoint
      console.log(`🔄 Trying fallback: internal options-chain endpoint...`);
      try {
        const fallbackResponse = await axios.get(`/api/options-chain/${ticker}`, {
          baseURL: `${req.protocol}://${req.get('host')}`,
        });
        
        if (fallbackResponse.data?.success && fallbackResponse.data?.data?.results) {
          optionsChain = fallbackResponse.data.data.results;
          console.log(`✅ Fallback successful: Got ${optionsChain.length} contracts`);
        }
      } catch (fallbackError) {
        console.error(`❌ Fallback also failed:`, fallbackError.message);
      }
      
      if (!optionsChain || optionsChain.length === 0) {
        return res.status(500).json({
          success: false,
          error: 'Failed to fetch options chain',
          message: error.message,
          ticker: ticker.toUpperCase(),
        });
      }
    }
    
    if (!optionsChain || optionsChain.length === 0) {
      console.warn(`⚠️ No options chain data available for ${ticker}`);
      console.warn(`⚠️ This could be due to:`);
      console.warn(`   - API rate limiting`);
      console.warn(`   - Invalid ticker symbol`);
      console.warn(`   - Market hours (if outside trading hours)`);
      console.warn(`   - API key issues`);
      return res.status(404).json({
        success: false,
        error: 'No options chain data available',
        ticker: ticker.toUpperCase(),
        message: 'The options chain API returned no results. This may be due to market hours, ticker symbol, or API limitations.',
      });
    }
    
    console.log(`✅ Successfully fetched ${optionsChain.length} contracts for ${ticker}`);
    
    // Get spot price
    const spotPrice = getSpotPrice(optionsChain);
    
    if (!spotPrice || spotPrice === 0) {
      return res.status(404).json({
        success: false,
        error: 'Unable to determine spot price',
        ticker: ticker.toUpperCase(),
      });
    }
    
    // Group contracts by expiration date (ALWAYS get ALL expirations for heatmap)
    // The expiration query param is ignored - we need all dates for the multi-column heatmap
    const contractsByExpiration = groupByExpiration(optionsChain, null);
    
    // Calculate GEX for each expiration
    const gexByExpiration = {};
    const allStrikes = new Set();
    
    for (const [expDate, contracts] of Object.entries(contractsByExpiration)) {
      // Group by strike
      const contractsByStrike = groupByStrike(contracts);
      
      const strikeGEX = [];
      
      for (const [strike, strikeContracts] of Object.entries(contractsByStrike)) {
        const strikeNum = parseFloat(strike);
        if (isNaN(strikeNum)) {
          console.warn(`⚠️ Skipping invalid strike: ${strike}`);
          continue;
        }
        allStrikes.add(strikeNum);
        
        // Separate calls and puts - Polygon.io uses details.contract_type
        const calls = strikeContracts.filter(c => {
          const type = (c.details?.contract_type || c.contract_type || c.type || c.option_type || '').toLowerCase();
          return type === 'call' || type === 'c' || type === 'call_option';
        });
        const puts = strikeContracts.filter(c => {
          const type = (c.details?.contract_type || c.contract_type || c.type || c.option_type || '').toLowerCase();
          return type === 'put' || type === 'p' || type === 'put_option';
        });
        
        if (calls.length === 0 && puts.length === 0) {
          console.warn(`⚠️ No calls or puts found for strike ${strikeNum}, skipping...`);
          continue;
        }
        
        // Calculate Greeks for calls and puts
        const expirationDate = new Date(expDate);
        const daysToExp = Math.max(1, Math.ceil((expirationDate - new Date()) / (1000 * 60 * 60 * 24)));
        const timeToExp = daysToYears(daysToExp);
        
        // Aggregate call gamma and OI
        // CRITICAL: Use gamma directly from API. Exclude contracts without gamma.
        let callGamma = 0;
        let callOI = 0;
        let callGEX = 0;
        
        for (const call of calls) {
          // Get gamma directly from API - DO NOT calculate from IV
          const gamma = call.greeks?.gamma;
          
          // CRITICAL: Exclude contracts without gamma (cannot use IV as fallback)
          if (!gamma || gamma === null || gamma === undefined || isNaN(gamma)) {
            continue; // Skip this contract
          }
          
          // Get open interest
          const oi = call.open_interest || call.openInterest || call.oi || 0;
          
          // Skip contracts with zero OI
          if (oi === 0 || oi === null || oi === undefined) {
            continue;
          }
          
          callGamma += gamma * oi;
          callOI += oi;
          
          // Calculate GEX for this call: gamma × OI × 100 × spot_price² × direction
          const singleGEX = calculateSingleGEX(
            gamma,
            oi,
            spotPrice,
            'call'
          );
          callGEX += singleGEX;
        }
        
        // Aggregate put gamma and OI
        // CRITICAL: Use gamma directly from API. Exclude contracts without gamma.
        let putGamma = 0;
        let putOI = 0;
        let putGEX = 0;
        
        for (const put of puts) {
          // Get gamma directly from API - DO NOT calculate from IV
          const gamma = put.greeks?.gamma;
          
          // CRITICAL: Exclude contracts without gamma (cannot use IV as fallback)
          if (!gamma || gamma === null || gamma === undefined || isNaN(gamma)) {
            continue; // Skip this contract
          }
          
          // Get open interest
          const oi = put.open_interest || put.openInterest || put.oi || 0;
          
          // Skip contracts with zero OI
          if (oi === 0 || oi === null || oi === undefined) {
            continue;
          }
          
          putGamma += gamma * oi;
          putOI += oi;
          
          // Calculate GEX for this put: gamma × OI × 100 × spot_price² × direction
          const singleGEX = calculateSingleGEX(
            gamma,
            oi,
            spotPrice,
            'put'
          );
          putGEX += singleGEX;
        }
        
        // CRITICAL: netGEX = callGEX + putGEX
        // INDUSTRY STANDARD sign convention (matches BullFlow/SpotGamma):
        // - callGEX is POSITIVE (green, support, dampens volatility)
        // - putGEX is NEGATIVE (red, resistance, amplifies volatility)
        // Net GEX = positive call exposure + negative put exposure
        const netGEX = callGEX + putGEX;
        
        // Debug logging for key strikes near spot price
        if (Math.abs(strikeNum - spotPrice) < 20) {
          console.log(`📊 [GEX Debug] ${ticker} Strike $${strikeNum} (${expDate}): callGEX=${(callGEX/1e6).toFixed(2)}M, putGEX=${(putGEX/1e6).toFixed(2)}M, netGEX=${(netGEX/1e6).toFixed(2)}M | callOI=${callOI}, putOI=${putOI}`);
        }
        
        strikeGEX.push({
          strike: strikeNum,
          callGEX: callGEX,   // Positive value
          putGEX: putGEX,     // Negative value (sign applied in calculateSingleGEX)
          netGEX: netGEX,     // callGEX + putGEX (consistent!)
          callOI,
          putOI,
          totalOI: callOI + putOI,
        });
      }
      
      // Sort by strike (descending for display)
      strikeGEX.sort((a, b) => b.strike - a.strike);
      
      // Calculate aggregate GEX for this expiration
      const expNetGEX = strikeGEX.reduce((sum, s) => sum + (s.netGEX || 0), 0);
      const expCallGEX = strikeGEX.reduce((sum, s) => sum + (s.callGEX || 0), 0);
      const expPutGEX = strikeGEX.reduce((sum, s) => sum + (s.putGEX || 0), 0);
      
      gexByExpiration[expDate] = {
        expiration: expDate,
        daysToExpiration: Math.max(1, Math.ceil((new Date(expDate) - new Date()) / (1000 * 60 * 60 * 24))),
        netGEX: expNetGEX,
        callGEX: expCallGEX,
        putGEX: expPutGEX,
        strikes: strikeGEX,
      };
    }
    
    // Calculate key levels using AGGREGATED GEX data (consistent with heatmap)
    // First, aggregate GEX across ALL expirations for each strike
    const allContracts = Object.values(contractsByExpiration).flat();
    const aggregatedGEXByStrike = {};
    
    Object.values(gexByExpiration).forEach(expData => {
      expData.strikes.forEach(s => {
        if (!aggregatedGEXByStrike[s.strike]) {
          aggregatedGEXByStrike[s.strike] = {
            strike: s.strike,
            netGEX: 0,
            callGEX: 0,
            putGEX: 0,
            totalOI: 0,
          };
        }
        aggregatedGEXByStrike[s.strike].netGEX += s.netGEX || 0;
        aggregatedGEXByStrike[s.strike].callGEX += s.callGEX || 0;
        aggregatedGEXByStrike[s.strike].putGEX += s.putGEX || 0;
        aggregatedGEXByStrike[s.strike].totalOI += s.totalOI || 0;
      });
    });
    
    const aggregatedStrikesList = Object.values(aggregatedGEXByStrike);
    
    // Find gamma wall (strike with highest ABSOLUTE netGEX across all expirations)
    const gammaWallData = aggregatedStrikesList.length > 0 
      ? aggregatedStrikesList.reduce((max, curr) => 
          Math.abs(curr.netGEX) > Math.abs(max.netGEX) ? curr : max
        )
      : null;
    
    // Find support levels: HIGH POSITIVE GEX strikes BELOW spot price
    // (Market makers buy dips here, creating support)
    const supportLevels = aggregatedStrikesList
      .filter(s => s.strike < spotPrice && s.netGEX > 0)
      .sort((a, b) => b.netGEX - a.netGEX) // Sort by netGEX descending
      .slice(0, 3)
      .map(s => ({ strike: s.strike, gex: s.netGEX }));
    
    // Find resistance levels: HIGH POSITIVE GEX strikes ABOVE spot price
    // (Market makers sell rallies here, creating resistance)  
    const resistanceLevels = aggregatedStrikesList
      .filter(s => s.strike > spotPrice && s.netGEX > 0)
      .sort((a, b) => b.netGEX - a.netGEX) // Sort by netGEX descending
      .slice(0, 3)
      .map(s => ({ strike: s.strike, gex: s.netGEX }));
    
    // Calculate max pain using raw contracts
    const maxPainStrike = calculateMaxPain(
      allContracts
        .filter(c => c.greeks?.gamma !== null && c.greeks?.gamma !== undefined)
        .map(c => {
          const strike = parseFloat(c.details?.strike_price || c.strike_price || c.strike);
          const contractType = (c.details?.contract_type || c.contract_type || c.type || '').toLowerCase();
          const isCall = contractType === 'call' || contractType === 'c';
          const oi = c.open_interest || c.openInterest || c.oi || 0;
          
          return {
            strike,
            callOI: isCall ? oi : 0,
            putOI: !isCall ? oi : 0,
          };
        }),
      spotPrice
    );
    
    const keyLevels = {
      gammaWall: gammaWallData ? { 
        strike: gammaWallData.strike, 
        gex: Math.abs(gammaWallData.netGEX),
        isPositive: gammaWallData.netGEX > 0
      } : null,
      support: supportLevels,
      resistance: resistanceLevels,
      maxPain: maxPainStrike
    };
    
    // Calculate total net GEX and aggregate Greeks
    let totalNetGEX = 0;
    let totalCallGEX = 0;
    let totalPutGEX = 0;
    let totalDelta = 0;
    let totalGamma = 0;
    
    Object.values(gexByExpiration).forEach(expData => {
      expData.strikes.forEach(strikeData => {
        totalCallGEX += strikeData.callGEX;
        totalPutGEX += strikeData.putGEX;
        totalNetGEX += strikeData.netGEX;
      });
    });
    
    // Calculate aggregate Delta and Gamma from all contracts
    // CRITICAL: Use gamma and delta directly from API
    allContracts.forEach(c => {
      const strike = parseFloat(c.details?.strike_price || c.strike_price || c.strike);
      if (isNaN(strike)) return;
      
      // Get gamma and delta directly from API - DO NOT calculate from IV
      const gamma = c.greeks?.gamma;
      const delta = c.greeks?.delta;
      
      // Skip contracts without gamma or delta
      if (!gamma || gamma === null || gamma === undefined || isNaN(gamma)) {
        return;
      }
      
      const oi = c.open_interest || c.openInterest || c.oi || 0;
      if (oi === 0 || oi === null || oi === undefined) {
        return;
      }
      
      const contractMultiplier = 100; // Standard options contract multiplier
      
      // Aggregate delta: delta * OI * multiplier (use API delta if available, else 0)
      if (delta !== null && delta !== undefined && !isNaN(delta)) {
        totalDelta += delta * oi * contractMultiplier;
      }
      
      // Aggregate gamma: gamma * OI * multiplier
      totalGamma += gamma * oi * contractMultiplier;
    });
    
    // Find gamma flip point using AGGREGATED GEX data
    // Gamma flip = price level where net GEX transitions from positive to negative
    // INDUSTRY STANDARD (matches BullFlow/SpotGamma):
    // - POSITIVE GEX (green): Call-heavy strikes = support = dampens volatility
    // - NEGATIVE GEX (red): Put-heavy strikes = resistance = amplifies volatility
    // Gamma flip point is where net GEX changes sign (transition between support/resistance zones)
    
    // Sort aggregated strikes by strike price (ascending)
    const sortedStrikes = aggregatedStrikesList.sort((a, b) => a.strike - b.strike);
    
    // Find all sign-change points (gamma flip candidates)
    let gammaFlip = null;
    const flipCandidates = [];
    
    for (let i = 1; i < sortedStrikes.length; i++) {
      const prev = sortedStrikes[i - 1];
      const curr = sortedStrikes[i];
      
      // Check for sign change in netGEX
      if (prev.netGEX !== 0 && curr.netGEX !== 0 && Math.sign(prev.netGEX) !== Math.sign(curr.netGEX)) {
        // Linear interpolation to find exact flip point
        const flipPoint = prev.strike + 
          (curr.strike - prev.strike) * 
          Math.abs(prev.netGEX) / (Math.abs(prev.netGEX) + Math.abs(curr.netGEX));
        
        flipCandidates.push({
          flipPoint,
          prevStrike: prev.strike,
          currStrike: curr.strike,
          prevGEX: prev.netGEX,
          currGEX: curr.netGEX,
          isPositiveToNegative: prev.netGEX > 0 && curr.netGEX < 0
        });
      }
    }
    
    // Select gamma flip: prefer positive-to-negative transition ABOVE spot price
    // This matches BullFlow's convention
    const flipAboveSpot = flipCandidates
      .filter(f => f.flipPoint > spotPrice && f.isPositiveToNegative)
      .sort((a, b) => a.flipPoint - b.flipPoint)[0];
    
    // Fallback: any flip above spot
    const anyFlipAboveSpot = flipCandidates
      .filter(f => f.flipPoint > spotPrice)
      .sort((a, b) => a.flipPoint - b.flipPoint)[0];
    
    // Fallback: closest flip to spot
    const closestFlip = flipCandidates
      .sort((a, b) => Math.abs(a.flipPoint - spotPrice) - Math.abs(b.flipPoint - spotPrice))[0];
    
    gammaFlip = flipAboveSpot?.flipPoint || anyFlipAboveSpot?.flipPoint || closestFlip?.flipPoint || null;
    
    // Debug logging for aggregated GEX near spot
    const nearSpotStrikes = sortedStrikes.filter(s => Math.abs(s.strike - spotPrice) < 25);
    console.log(`\n📊 [GEX SUMMARY] ${ticker} @ $${spotPrice.toFixed(2)}`);
    console.log(`📊 Aggregated GEX near spot (all expirations combined):`);
    nearSpotStrikes.forEach(s => {
      const sign = s.netGEX >= 0 ? '+' : '';
      console.log(`   $${s.strike}: ${sign}${(s.netGEX/1e6).toFixed(2)}M (call: +${(s.callGEX/1e6).toFixed(2)}M, put: ${(s.putGEX/1e6).toFixed(2)}M)`);
    });
    
    // Debug logging
    console.log(`\n📊 [GEX] Found ${flipCandidates.length} flip candidates`);
    if (flipCandidates.length > 0) {
      console.log(`📊 [GEX] Flip candidates:`, flipCandidates.map(f => 
        `$${f.flipPoint.toFixed(2)} (${f.isPositiveToNegative ? '+→-' : '-→+'})`
      ).join(', '));
    }
    console.log(`📊 [GEX] Selected gamma flip: $${gammaFlip?.toFixed(2) || 'null'}`);
    
    // Prepare heatmap data
    // Sort expirations chronologically (earliest first for proper flow delta calculation)
    const expirations = Object.keys(gexByExpiration).sort((a, b) => {
      return new Date(a).getTime() - new Date(b).getTime();
    });
    
    // Get all strikes and sort descending (highest first)
    const strikes = Array.from(allStrikes).sort((a, b) => b - a);
    
    // Expand strike range if needed to match reference (shows wide range like 550 to 15)
    // Find min and max strikes
    const minStrike = strikes.length > 0 ? Math.min(...strikes) : 0;
    const maxStrike = strikes.length > 0 ? Math.max(...strikes) : 0;
    const spotPriceNum = parseFloat(spotPrice) || 0;
    
    // Generate additional strikes around the current price if range is too narrow
    // This ensures we have a comprehensive view like the reference
    const expandedStrikes = new Set(strikes);
    
    // Add strikes below current price (down to ~20% below)
    if (spotPriceNum > 0) {
      const lowerBound = Math.max(minStrike, spotPriceNum * 0.2);
      const upperBound = Math.min(maxStrike, spotPriceNum * 2.0);
      
      // Generate strikes in $2.50 increments for wider range
      for (let s = Math.ceil(lowerBound / 2.5) * 2.5; s <= Math.floor(upperBound / 2.5) * 2.5; s += 2.5) {
        if (s > 0 && s <= upperBound) {
          expandedStrikes.add(s);
        }
      }
      
      // Also add $5 increments for very wide range
      for (let s = Math.ceil(lowerBound / 5) * 5; s <= Math.floor(upperBound / 5) * 5; s += 5) {
        if (s > 0 && s <= upperBound) {
          expandedStrikes.add(s);
        }
      }
    }
    
    // Convert back to sorted array (descending)
    const finalStrikes = Array.from(expandedStrikes).sort((a, b) => b - a);
    
    console.log(`📊 Preparing heatmap: ${finalStrikes.length} strikes (expanded from ${strikes.length}), ${expirations.length} expirations`);
    console.log(`📅 Expiration dates (raw):`, expirations);
    console.log(`🎯 Strike range: ${finalStrikes[finalStrikes.length - 1]} to ${finalStrikes[0]}`);
    
    const heatmapData = finalStrikes.map(strike => {
      const row = expirations.map(expDate => {
        const expData = gexByExpiration[expDate];
        if (!expData) return null;
        // Find closest strike match (within $0.50 tolerance for expanded strikes)
        const strikeData = expData.strikes.find(s => Math.abs(s.strike - strike) < 0.5);
        return strikeData ? strikeData.netGEX : null;
      });
      return {
        strike,
        values: row,
      };
    });
    
    // Calculate flow deltas from Options Flow data (actual trades)
    // Aggregate Options Flow trades by strike to show net buying/selling pressure
    const flowDeltas = finalStrikes.map((strike) => {
      try {
        // Get all trades for this ticker from Options Flow store
        const allTrades = Array.from(recentTradesMap.values());
        const tickerTrades = allTrades.filter(trade => 
          trade.ticker && trade.ticker.toUpperCase() === ticker.toUpperCase()
        );
        
        // Filter trades for this specific strike (within $0.50 tolerance)
        const strikeTrades = tickerTrades.filter(trade => {
          if (!trade.strike) return false;
          return Math.abs(trade.strike - strike) < 0.5;
        });
        
        if (strikeTrades.length === 0) {
          // Fallback: Calculate from GEX across expirations if no Options Flow data
          const strikeIdx = finalStrikes.indexOf(strike);
          const rowValues = heatmapData[strikeIdx]?.values || [];
          const nonNullValues = rowValues.filter(v => v !== null && v !== undefined);
          
          if (nonNullValues.length === 0) {
            return { val: 0, source: 'gex-fallback' };
          }
          
          if (nonNullValues.length === 1) {
            return { val: 0, source: 'gex-fallback' };
          }
          
          const firstVal = nonNullValues[0];
          const lastVal = nonNullValues[nonNullValues.length - 1];
          const delta = lastVal - firstVal;
          return { val: delta, source: 'gex-fallback' };
        }
        
        // Calculate net flow: positive = buying pressure, negative = selling pressure
        let netFlow = 0;
        let callFlow = 0;
        let putFlow = 0;
        
        strikeTrades.forEach(trade => {
          // Premium represents flow direction: positive = buying, negative = selling
          const premium = parseFloat(trade.premium) || 0;
          const size = parseInt(trade.size) || 0;
          
          // Calculate flow contribution: premium × size (normalized)
          // Calls contribute positive flow, puts contribute negative flow
          const flowContribution = premium * (trade.type === 'CALL' ? 1 : -1);
          
          if (trade.type === 'CALL') {
            callFlow += flowContribution;
          } else {
            putFlow += flowContribution;
          }
          
          netFlow += flowContribution;
        });
        
        // Normalize by number of trades to get average flow per strike
        // Convert to millions for display
        const normalizedFlow = netFlow / 1000000; // Convert to millions
        
        return { 
          val: normalizedFlow, 
          source: 'options-flow',
          callFlow: callFlow / 1000000,
          putFlow: putFlow / 1000000,
          tradeCount: strikeTrades.length
        };
      } catch (error) {
        console.warn(`⚠️ Error calculating flow delta for strike ${strike}:`, error.message);
        // Fallback to GEX-based calculation
        const strikeIdx = finalStrikes.indexOf(strike);
        const rowValues = heatmapData[strikeIdx]?.values || [];
        const nonNullValues = rowValues.filter(v => v !== null && v !== undefined);
        
        if (nonNullValues.length === 0) {
          return { val: 0, source: 'error-fallback' };
        }
        
        if (nonNullValues.length === 1) {
          return { val: 0, source: 'error-fallback' };
        }
        
        const firstVal = nonNullValues[0];
        const lastVal = nonNullValues[nonNullValues.length - 1];
        const delta = lastVal - firstVal;
        return { val: delta, source: 'error-fallback' };
      }
    });
    
    // Final verification of heatmap structure
    const formattedExpirations = expirations.map(exp => formatExpirationDate(exp));
    
    // CRITICAL: Verify expirations array matches data columns
    if (formattedExpirations.length !== heatmapData[0]?.values?.length) {
      console.error(`❌ CRITICAL ERROR: Expiration count (${formattedExpirations.length}) doesn't match data columns (${heatmapData[0]?.values?.length})!`);
    }
    
    const responseData = {
      success: true,
      ticker: ticker.toUpperCase(),
      spotPrice,
      timestamp: new Date().toISOString(),
      summary: {
        netGEX: totalNetGEX,
        callGEX: totalCallGEX,
        putGEX: totalPutGEX,
        totalDelta: totalDelta,
        totalGamma: totalGamma,
        gammaWall: keyLevels.gammaWall,
        gammaFlipPoint: gammaFlip,
        maxPain: keyLevels.maxPain,
        support: keyLevels.support,
        resistance: keyLevels.resistance,
      },
      heatmap: {
        strikes: finalStrikes,
        expirations: formattedExpirations, // Already formatted
        data: heatmapData.map(row => row.values),
        flowDeltas: flowDeltas,
      },
      byExpiration: gexByExpiration,
      keyLevels,
    };
    
    // Broadcast GEX update via WebSocket if available
    if (global.broadcastGEXUpdate) {
      try {
        global.broadcastGEXUpdate(ticker, responseData);
      } catch (error) {
        console.warn('⚠️ Error broadcasting GEX update:', error.message);
      }
    }
    
    res.json(responseData);
  } catch (error) {
    console.error(`❌ Error fetching GEX for ${req.params.ticker}:`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch GEX data',
      message: error.message,
    });
  }
});

/**
 * GET /api/gex/:ticker/heatmap
 * Get GEX heatmap data optimized for visualization
 */
router.get('/:ticker/heatmap', async (req, res) => {
  try {
    const { ticker } = req.params;
    
    // Fetch full GEX data
    const response = await axios.get(`/api/gex/${ticker}`, {
      baseURL: `${req.protocol}://${req.get('host')}`,
    });
    
    if (!response.data.success) {
      return res.status(404).json(response.data);
    }
    
    res.json({
      success: true,
      ticker: ticker.toUpperCase(),
      ...response.data.heatmap,
      metadata: {
        currentPrice: response.data.spotPrice,
        gammaWall: response.data.summary.gammaWall?.strike || null,
        support: response.data.summary.support[0]?.strike || null,
        resistance: response.data.summary.resistance[0]?.strike || null,
        maxPain: response.data.summary.maxPain,
      },
    });
  } catch (error) {
    console.error(`❌ Error fetching GEX heatmap for ${req.params.ticker}:`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch GEX heatmap',
      message: error.message,
    });
  }
});

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Fetch options chain from Massive.com
 * CRITICAL: Fetches ALL expiration dates by:
 * 1. First getting all available expiration dates from contracts endpoint
 * 2. Then fetching snapshot data for each expiration date
 */
async function fetchOptionsChain(ticker) {
  try {
    const apiKey = process.env.POLYGON_API_KEY;
    if (!apiKey) {
      console.error('❌ POLYGON_API_KEY not set');
      throw new Error('POLYGON_API_KEY not set');
    }
    
    console.log(`📡 Fetching options chain for ${ticker} from Massive.com...`);
    
    // STEP 1: OPTIMIZED - Fetch expiration dates from contracts endpoint (limited pages for speed)
    // We only need expiration dates for UI, not all contracts
    console.log(`📅 Step 1: Fetching expiration dates from contracts endpoint (limited pages for speed)...`);
    const contractsUrl = `https://api.massive.com/v3/reference/options/contracts`;
    let allAvailableExpirations = new Set();
    let contractsCurrentUrl = contractsUrl;
    let contractsPageCount = 0;
    const maxContractsPages = 10; // Reduced from 50 - we only need expiration dates, not all contracts
    
    while (contractsPageCount < maxContractsPages) {
      try {
        const contractsResponse = await axios.get(contractsCurrentUrl, {
          params: contractsPageCount === 0 ? {
            underlying_ticker: ticker.toUpperCase(),
            apiKey: apiKey,
            limit: 100, // API maximum per page (not 1000!)
          } : undefined,
          timeout: 60000,
        });
        
        if (contractsResponse.data?.results && contractsResponse.data.results.length > 0) {
          contractsResponse.data.results.forEach(c => {
            const expDate = c.expiration_date || c.details?.expiration_date;
            if (expDate) {
              const dateStr = typeof expDate === 'string' ? expDate.split('T')[0] : new Date(expDate).toISOString().split('T')[0];
              allAvailableExpirations.add(dateStr);
            }
          });
          
          if (contractsResponse.data.next_url && contractsPageCount < maxContractsPages - 1) {
            let nextUrl = contractsResponse.data.next_url;
            try {
              const urlObj = new URL(nextUrl);
              if (!urlObj.searchParams.has('apiKey')) {
                urlObj.searchParams.set('apiKey', apiKey);
                nextUrl = urlObj.toString();
              }
            } catch (e) {
              nextUrl = `${contractsResponse.data.next_url}${contractsResponse.data.next_url.includes('?') ? '&' : '?'}apiKey=${apiKey}`;
            }
            contractsCurrentUrl = nextUrl;
            contractsPageCount++;
            // Reduced delay for faster fetching
            await new Promise(resolve => setTimeout(resolve, 50));
          } else {
            break;
          }
        } else {
          break;
        }
      } catch (contractsError) {
        console.warn(`⚠️ Error fetching contracts page ${contractsPageCount + 1}:`, contractsError.message);
        break;
      }
    }
    
    const sortedExpirations = Array.from(allAvailableExpirations).sort();
    console.log(`✅ Found ${allAvailableExpirations.size} expiration dates from contracts endpoint:`, sortedExpirations.slice(0, 20));
    
    // STEP 2: Fetch ALL snapshot data (single call, paginated)
    // CRITICAL: Snapshot endpoint does NOT paginate by expiry - it returns mixed expirations
    // We fetch all pages once, then group locally by expiration_date + strike_price
    console.log(`📡 Step 2: Fetching ALL snapshot data (paginated, mixed expirations - will group locally)...`);
    let allContracts = [];
    const url = `https://api.massive.com/v3/snapshot/options/${ticker.toUpperCase()}`;
    let currentUrl = url;
    let pageCount = 0;
    const maxPages = 100; // Reduced from 200 to speed up - most tickers don't need 200 pages
      
    while (pageCount < maxPages) {
      try {
        // Use same parameters as optionsFlow.js for consistency
        // CRITICAL: limit must be 100 (API max per page), not 1000
        // CRITICAL: For page 0, pass params. For subsequent pages (next_url), don't pass params - URL already has everything
        const response = await axios.get(currentUrl, {
          params: pageCount === 0 ? {
            apiKey: apiKey,
            order: 'asc',
            limit: 100, // API maximum per page (not 1000!)
            sort: 'ticker',
          } : undefined, // Don't pass params for next_url pages - URL already contains cursor and params
          timeout: 60000,
        });
        
        console.log(`📡 API Response status: ${response.status}, results count: ${response.data?.results?.length || 0}`);
        
        // Check if results is an array (like optionsFlow.js does)
        if (response.data?.results && Array.isArray(response.data.results) && response.data.results.length > 0) {
          allContracts = allContracts.concat(response.data.results);
          console.log(`📄 Page ${pageCount + 1}: Fetched ${response.data.results.length} contracts (total: ${allContracts.length})`);
          
          if (response.data.next_url && pageCount < maxPages - 1) {
            // CRITICAL: next_url doesn't include apiKey, we must append it
            let nextUrl = response.data.next_url;
            try {
              const urlObj = new URL(nextUrl);
              // Remove existing apiKey if present (to avoid duplicates)
              urlObj.searchParams.delete('apiKey');
              // Add our API key
              urlObj.searchParams.set('apiKey', apiKey);
              nextUrl = urlObj.toString();
            } catch (e) {
              // If URL parsing fails, append API key as query param
              nextUrl = `${response.data.next_url}${response.data.next_url.includes('?') ? '&' : '?'}apiKey=${apiKey}`;
            }
            currentUrl = nextUrl;
            pageCount++;
            console.log(`📄 Moving to page ${pageCount + 1}...`);
            // Reduced delay from 100ms to 50ms for faster fetching
            await new Promise(resolve => setTimeout(resolve, 50));
          } else {
            console.log(`✅ No more pages (next_url: ${response.data.next_url ? 'exists' : 'null'})`);
            break;
          }
        } else {
          console.log(`⚠️ Page ${pageCount + 1}: No results`);
          console.log(`⚠️ Response structure:`, {
            hasResults: !!response.data?.results,
            isArray: Array.isArray(response.data?.results),
            resultsLength: response.data?.results?.length || 0,
            status: response.data?.status,
            requestId: response.data?.request_id,
          });
          if (pageCount === 0) {
            // First page has no results - log the full response for debugging
            console.log(`⚠️ First page full response:`, JSON.stringify(response.data, null, 2).substring(0, 1000));
          }
          break;
        }
      } catch (error) {
        console.error(`❌ Error fetching snapshot page ${pageCount + 1}:`, error.message);
        if (error.response) {
          console.error(`❌ Response status: ${error.response.status}`);
          console.error(`❌ Response data:`, JSON.stringify(error.response.data, null, 2).substring(0, 500));
        }
        if (error.response?.status === 429) {
          // Rate limited - wait longer
          console.log(`⏳ Rate limited, waiting 2 seconds...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue; // Retry this page
        } else if (error.response?.status === 404) {
          console.error(`❌ 404 - Ticker ${ticker} not found or has no options`);
          break;
        } else {
          break;
        }
      }
    }
    
    console.log(`✅ Successfully fetched ${allContracts.length} total contracts across ${pageCount} page(s)`);
    
    if (allContracts.length === 0) {
      console.warn(`⚠️ No contracts fetched from snapshot API for ${ticker}`);
      console.warn(`⚠️ This could mean:`);
      console.warn(`   - The ticker has no options contracts`);
      console.warn(`   - API rate limiting`);
      console.warn(`   - API key issues`);
      return [];
    }
    
    // Count expiration dates in snapshot data first
    const snapshotExpirations = new Set();
    allContracts.forEach(c => {
      const expDate = c.details?.expiration_date || c.expiration_date;
      if (expDate) {
        const dateStr = typeof expDate === 'string' ? expDate.split('T')[0] : new Date(expDate).toISOString().split('T')[0];
        snapshotExpirations.add(dateStr);
      }
    });
    
    console.log(`📅 Found ${snapshotExpirations.size} expiration dates in snapshot data`);
    
    // OPTIMIZATION: Skip filtering step - use all snapshot contracts directly
    // The snapshot API already returns contracts for all expirations, filtering is unnecessary overhead
    console.log(`📊 Using all ${allContracts.length} contracts from snapshot (no filtering needed)`);
    
    // Count unique expiration dates in final contracts
    const seenExpirations = new Set();
    allContracts.forEach(c => {
      const expDate = c.details?.expiration_date || c.expiration_date;
      if (expDate) {
        const dateStr = typeof expDate === 'string' ? expDate.split('T')[0] : new Date(expDate).toISOString().split('T')[0];
        seenExpirations.add(dateStr);
      }
    });
    
    console.log(`📅 Final expiration dates with data: ${seenExpirations.size}`, Array.from(seenExpirations).sort().slice(0, 10));
    
    if (allContracts.length > 0) {
      // Count unique expiration dates and strikes
      const uniqueExpirations = new Set();
      const uniqueStrikes = new Set();
      
      allContracts.forEach((c) => {
        const expDate = c.details?.expiration_date || 
                       c.expiration_date || 
                       c.expirationDate ||
                       c.expiry ||
                       c.expiry_date ||
                       c.details?.expiry ||
                       c.details?.expiry_date;
        
        if (expDate) {
          let dateStr;
          try {
            if (typeof expDate === 'string') {
              dateStr = expDate.split('T')[0];
            } else if (expDate instanceof Date) {
              dateStr = expDate.toISOString().split('T')[0];
            } else {
              dateStr = new Date(expDate).toISOString().split('T')[0];
            }
            uniqueExpirations.add(dateStr);
          } catch (e) {
            console.warn(`⚠️ Failed to parse expiration date:`, expDate, e.message);
          }
        }
        
        const strike = c.details?.strike_price || c.strike_price || c.strike || c.details?.strike;
        if (strike !== undefined && strike !== null) {
          uniqueStrikes.add(parseFloat(strike));
        }
      });
      
      const sortedExpirations = Array.from(uniqueExpirations).sort();
      const sortedStrikes = Array.from(uniqueStrikes).sort((a, b) => b - a);
      
      console.log(`📊 Final summary: ${allContracts.length} contracts, ${uniqueExpirations.size} expiration dates, ${uniqueStrikes.size} strikes`);
      console.log(`📅 Final expiration dates:`, sortedExpirations);
      
      return allContracts;
    } else {
      console.warn(`⚠️ No results in response for ${ticker}`);
      return [];
    }
  } catch (error) {
    console.error(`❌ Error fetching options chain for ${ticker}:`, error.message);
    if (error.response) {
      console.error('❌ Response status:', error.response.status);
      console.error('❌ Response data:', JSON.stringify(error.response.data, null, 2));
    } else if (error.request) {
      console.error('❌ No response received. Request:', error.request);
    } else {
      console.error('❌ Error setting up request:', error.message);
    }
    throw error; // Re-throw to let caller handle it
  }
}

/**
 * Get spot price from options chain
 */
function getSpotPrice(contracts) {
  if (contracts.length === 0) return 0;
  
  // Try to get underlying price from contracts (API uses underlying_asset.price)
  // Check multiple contracts to find one with price data
  for (const contract of contracts) {
    const underlyingPrice = contract.underlying_asset?.price ||
                            contract.underlying_price || 
                            contract.underlyingPrice || 
                            contract.underlying?.price ||
                            contract.details?.underlying_price ||
                            contract.details?.underlyingPrice;
    
    if (underlyingPrice && !isNaN(parseFloat(underlyingPrice)) && parseFloat(underlyingPrice) > 0) {
      return parseFloat(underlyingPrice);
    }
  }
  
  // Fallback: try first contract again
  const firstContract = contracts[0];
  const underlyingPrice = firstContract.underlying_asset?.price ||
                          firstContract.underlying_price || 
                          firstContract.underlyingPrice || 
                          firstContract.underlying?.price ||
                          firstContract.details?.underlying_price ||
                          firstContract.details?.underlyingPrice;
  
  if (underlyingPrice && !isNaN(parseFloat(underlyingPrice))) {
    return parseFloat(underlyingPrice);
  }
  
  // Calculate from ATM strike (closest to current price)
  const strikes = contracts
    .map(c => parseFloat(c.strike_price || c.strike || c.details?.strike_price || c.details?.strike))
    .filter(s => !isNaN(s) && s > 0);
  
  if (strikes.length === 0) {
    console.warn('⚠️ No valid strikes found, cannot determine spot price');
    return 0;
  }
  
  // Use median strike as approximation
  strikes.sort((a, b) => a - b);
  const medianStrike = strikes[Math.floor(strikes.length / 2)];
  return medianStrike;
}

/**
 * Group contracts by expiration date
 */
function groupByExpiration(contracts, filterExpiration = null) {
  const grouped = {};
  let skippedCount = 0;
  
  for (const contract of contracts) {
    // Polygon.io uses details.expiration_date
    const expDate = contract.details?.expiration_date ||
                    contract.expiration_date || 
                    contract.expirationDate || 
                    contract.expiry ||
                    contract.expiry_date;
    
    if (!expDate) {
      skippedCount++;
      continue;
    }
    
    // Format expiration date
    let dateStr;
    try {
      if (typeof expDate === 'string') {
        dateStr = expDate.split('T')[0];
      } else if (expDate instanceof Date) {
        dateStr = expDate.toISOString().split('T')[0];
      } else {
        dateStr = new Date(expDate).toISOString().split('T')[0];
      }
    } catch (e) {
      skippedCount++;
      continue;
    }
    
    // Filter by expiration if specified
    if (filterExpiration && dateStr !== filterExpiration) {
      continue;
    }
    
    if (!grouped[dateStr]) {
      grouped[dateStr] = [];
    }
    grouped[dateStr].push(contract);
  }
  
  if (skippedCount > 0) {
    console.warn(`⚠️ Skipped ${skippedCount} contracts without expiration date`);
  }
  
  const expirationDates = Object.keys(grouped).sort();
  console.log(`📊 Grouped contracts into ${expirationDates.length} expiration dates:`, expirationDates);
  console.log(`📊 Contracts per expiration:`, expirationDates.map(exp => `${exp}: ${grouped[exp].length}`).join(', '));
  
  return grouped;
}

/**
 * Group contracts by strike price
 */
function groupByStrike(contracts) {
  const grouped = {};
  let skippedCount = 0;
  
  for (const contract of contracts) {
    // Polygon.io uses details.strike_price
    const strike = contract.details?.strike_price ||
                   contract.strike_price || 
                   contract.strike || 
                   contract.strikePrice;
    
    if (!strike || isNaN(parseFloat(strike))) {
      skippedCount++;
      continue;
    }
    
    const strikeKey = parseFloat(strike).toFixed(2);
    if (!grouped[strikeKey]) {
      grouped[strikeKey] = [];
    }
    grouped[strikeKey].push(contract);
  }
  
  if (skippedCount > 0) {
    console.warn(`⚠️ Skipped ${skippedCount} contracts without valid strike price`);
  }
  
  return grouped;
}

/**
 * Format expiration date for display
 */
function formatExpirationDate(dateStr) {
  const date = new Date(dateStr);
  const month = date.toLocaleString('en-US', { month: 'short' }).toUpperCase();
  const day = date.getDate();
  return `${month} ${day}`;
}

export default router;
