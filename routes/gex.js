import express from 'express';
import axios from 'axios';

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
 */
function calculateSingleGEX(gamma, openInterest, spotPrice, optionType) {
  // GEX = Gamma × OI × 100 × SpotPrice²
  // Calls are positive, puts are negative for market makers
  const multiplier = optionType === 'call' ? 1 : -1;
  return gamma * openInterest * 100 * Math.pow(spotPrice, 2) * multiplier;
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
 */
function findGammaFlip(optionsChain, spotPrice) {
  let prevNetGEX = 0;
  let flipPoint = null;
  
  for (let i = 0; i < optionsChain.length; i++) {
    const option = optionsChain[i];
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
      const prevOption = optionsChain[i - 1];
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
    
    gexByStrike.push({
      strike: option.strike,
      gex: Math.abs(netGEX)
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
  
  // Find gamma wall (highest absolute GEX)
  const gammaWall = gexByStrike.reduce((max, current) => 
    current.gex > max.gex ? current : max
  );
  
  // Find support levels (high GEX below spot)
  const support = gexByStrike
    .filter(item => item.strike < spotPrice)
    .sort((a, b) => b.gex - a.gex)
    .slice(0, 3);
  
  // Find resistance levels (high GEX above spot)
  const resistance = gexByStrike
    .filter(item => item.strike > spotPrice)
    .sort((a, b) => b.gex - a.gex)
    .slice(0, 3);
  
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
  
  let minPain = Infinity;
  let maxPainStrike = optionsChain[0].strike;
  
  optionsChain.forEach(testStrike => {
    let totalPain = 0;
    
    optionsChain.forEach(option => {
      // Calculate pain for calls
      if (testStrike.strike > option.strike) {
        totalPain += (testStrike.strike - option.strike) * option.callOI;
      }
      
      // Calculate pain for puts
      if (testStrike.strike < option.strike) {
        totalPain += (option.strike - testStrike.strike) * option.putOI;
      }
    });
    
    if (totalPain < minPain) {
      minPain = totalPain;
      maxPainStrike = testStrike.strike;
    }
  });
  
  return maxPainStrike;
}

// ============================================
// API ROUTES
// ============================================

/**
 * GET /api/gex/:ticker
 * Get Gamma Exposure analysis for a ticker
 */
router.get('/:ticker', async (req, res) => {
  try {
    const { ticker } = req.params;
    const { expiration } = req.query; // Optional: filter by expiration
    
    console.log(`📊 Fetching GEX data for ${ticker}...`);
    
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
      return res.status(404).json({
        success: false,
        error: 'No options chain data available',
        ticker: ticker.toUpperCase(),
        message: 'The options chain API returned no results. This may be due to market hours, ticker symbol, or API limitations.',
      });
    }
    
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
        let callGamma = 0;
        let callOI = 0;
        let callGEX = 0;
        
        for (const call of calls) {
          // Polygon.io uses greeks.mid_iv for implied volatility
          const iv = call.greeks?.mid_iv || 
                     call.greeks?.implied_volatility || 
                     call.implied_volatility || 
                     call.impliedVolatility || 
                     call.iv || 0.3;
          
          const greeks = calculateAllGreeks(
            spotPrice,
            strikeNum,
            timeToExp,
            RISK_FREE_RATE,
            iv,
            true // isCall
          );
          
          // Polygon.io uses open_interest directly
          const oi = call.open_interest || call.openInterest || call.oi || 0;
          
          callGamma += greeks.gamma * oi;
          callOI += oi;
          
          // Calculate GEX for this call
          const singleGEX = calculateSingleGEX(
            greeks.gamma,
            oi,
            spotPrice,
            'call'
          );
          callGEX += singleGEX;
        }
        
        // Aggregate put gamma and OI
        let putGamma = 0;
        let putOI = 0;
        let putGEX = 0;
        
        for (const put of puts) {
          // Polygon.io uses greeks.mid_iv for implied volatility
          const iv = put.greeks?.mid_iv || 
                     put.greeks?.implied_volatility || 
                     put.implied_volatility || 
                     put.impliedVolatility || 
                     put.iv || 0.3;
          
          const greeks = calculateAllGreeks(
            spotPrice,
            strikeNum,
            timeToExp,
            RISK_FREE_RATE,
            iv,
            false // isPut
          );
          
          // Polygon.io uses open_interest directly
          const oi = put.open_interest || put.openInterest || put.oi || 0;
          
          putGamma += greeks.gamma * oi;
          putOI += oi;
          
          // Calculate GEX for this put
          const singleGEX = calculateSingleGEX(
            greeks.gamma,
            oi,
            spotPrice,
            'put'
          );
          putGEX += singleGEX;
        }
        
        // Calculate aggregate GEX at this strike
        const avgCallGamma = callOI > 0 ? callGamma / callOI : 0;
        const avgPutGamma = putOI > 0 ? putGamma / putOI : 0;
        
        const strikeGEXData = calculateStrikeGEX(
          strikeNum,
          avgCallGamma,
          avgPutGamma,
          callOI,
          putOI,
          spotPrice
        );
        
        strikeGEX.push({
          strike: strikeNum,
          callGEX: callGEX,
          putGEX: putGEX,
          netGEX: strikeGEXData.netGEX,
          callOI,
          putOI,
          totalOI: callOI + putOI,
        });
      }
      
      // Sort by strike (descending for display)
      strikeGEX.sort((a, b) => b.strike - a.strike);
      
      gexByExpiration[expDate] = {
        expiration: expDate,
        daysToExpiration: Math.max(1, Math.ceil((new Date(expDate) - new Date()) / (1000 * 60 * 60 * 24))),
        strikes: strikeGEX,
      };
    }
    
    // Calculate key levels (gamma wall, support, resistance, max pain)
    const allContracts = Object.values(contractsByExpiration).flat();
    const keyLevels = findKeyGEXLevels(
      allContracts.map(c => {
        // Polygon.io uses details.strike_price and details.expiration_date
        const strike = parseFloat(c.details?.strike_price || c.strike_price || c.strike);
        const expirationDate = new Date(c.details?.expiration_date || c.expiration_date || c.expirationDate || c.expiry);
        const daysToExp = Math.max(1, Math.ceil((expirationDate - new Date()) / (1000 * 60 * 60 * 24)));
        const timeToExp = daysToYears(daysToExp);
        const iv = c.greeks?.mid_iv || c.implied_volatility || c.impliedVolatility || c.iv || 0.3;
        
        const contractType = (c.details?.contract_type || c.contract_type || c.type || '').toLowerCase();
        const isCall = contractType === 'call' || contractType === 'c';
        const greeks = calculateAllGreeks(spotPrice, strike, timeToExp, RISK_FREE_RATE, iv, isCall);
        
        return {
          strike,
          callGamma: isCall ? greeks.gamma : 0,
          putGamma: !isCall ? greeks.gamma : 0,
          callOI: isCall ? (c.open_interest || c.openInterest || c.oi || 0) : 0,
          putOI: !isCall ? (c.open_interest || c.openInterest || c.oi || 0) : 0,
        };
      }),
      spotPrice
    );
    
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
    allContracts.forEach(c => {
      const strike = parseFloat(c.details?.strike_price || c.strike_price || c.strike);
      if (isNaN(strike)) return;
      
      const expirationDate = new Date(c.details?.expiration_date || c.expiration_date || c.expirationDate || c.expiry);
      const daysToExp = Math.max(1, Math.ceil((expirationDate - new Date()) / (1000 * 60 * 60 * 24)));
      const timeToExp = daysToYears(daysToExp);
      const iv = c.greeks?.mid_iv || c.implied_volatility || c.impliedVolatility || c.iv || 0.3;
      
      const contractType = (c.details?.contract_type || c.contract_type || c.type || '').toLowerCase();
      const isCall = contractType === 'call' || contractType === 'c';
      const greeks = calculateAllGreeks(spotPrice, strike, timeToExp, RISK_FREE_RATE, iv, isCall);
      
      const oi = c.open_interest || c.openInterest || c.oi || 0;
      const contractMultiplier = 100; // Standard options contract multiplier
      
      // Aggregate delta: delta * OI * multiplier
      totalDelta += greeks.delta * oi * contractMultiplier;
      
      // Aggregate gamma: gamma * OI * multiplier
      totalGamma += greeks.gamma * oi * contractMultiplier;
    });
    
    // Find gamma flip point
    const gammaFlip = findGammaFlip(
      Object.values(gexByExpiration)
        .flatMap(expData => expData.strikes.map(s => ({
          strike: s.strike,
          callGamma: s.callGEX / (s.callOI * 100 * Math.pow(spotPrice, 2)) || 0,
          putGamma: s.putGEX / (s.putOI * 100 * Math.pow(spotPrice, 2)) || 0,
          callOI: s.callOI,
          putOI: s.putOI,
        }))),
      spotPrice
    );
    
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
    
    // Calculate flow deltas (change in GEX across expirations for each strike)
    // Flow Delta = net change from earliest to latest expiration (shows flow direction)
    const flowDeltas = finalStrikes.map((strike, strikeIdx) => {
      const rowValues = heatmapData[strikeIdx]?.values || [];
      const nonNullValues = rowValues.filter(v => v !== null && v !== undefined);
      
      if (nonNullValues.length === 0) {
        return { val: 0 };
      }
      
      if (nonNullValues.length === 1) {
        // Single expiration - no change to calculate
        return { val: 0 };
      }
      
      // Calculate change: latest expiration - earliest expiration
      // This shows the net flow direction across time
      const firstVal = nonNullValues[0];
      const lastVal = nonNullValues[nonNullValues.length - 1];
      const delta = lastVal - firstVal;
      
      // Return delta in original units (frontend will format it)
      return { val: delta };
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
 * Fetch options chain from Massive.com (same as options flow)
 * Uses the exact same endpoint and pagination pattern as options flow
 */
async function fetchOptionsChain(ticker) {
  try {
    const apiKey = process.env.POLYGON_API_KEY;
    if (!apiKey) {
      console.error('❌ POLYGON_API_KEY not set');
      throw new Error('POLYGON_API_KEY not set');
    }
    
    console.log(`📡 Fetching options chain for ${ticker} from Massive.com (same as options flow)...`);
    
    // Use Massive.com endpoint - IMPORTANT: Don't filter by expiration_date to get ALL expiration dates
    // The API will return contracts for all expiration dates if we don't specify expiration_date filter
    const url = `https://api.massive.com/v3/snapshot/options/${ticker.toUpperCase()}`;
    
    // Handle pagination - fetch ALL pages
    // CRITICAL: Parse next_url and remove expiration_date filters to get all expirations
    let allContracts = [];
    let currentUrl = url;
    let pageCount = 0;
    const maxPages = 200; // Same limit as options flow
    const seenExpirations = new Set();
    
    while (pageCount < maxPages) {
      try {
        // Build params - ensure we don't filter by expiration_date
        const params = pageCount === 0 
          ? { 
              apiKey: apiKey,
              limit: 1000, // Maximum per page
              // Explicitly don't include expiration_date filter
            } 
          : {};
        
        const response = await axios.get(currentUrl, {
          params: Object.keys(params).length > 0 ? params : undefined,
          timeout: 60000,
        });
        
        if (response.data?.results && response.data.results.length > 0) {
          // Track expiration dates on this page
          const currentPageExpirations = new Set();
          response.data.results.forEach(c => {
            const expDate = c.details?.expiration_date || c.expiration_date;
            if (expDate) {
              const dateStr = typeof expDate === 'string' ? expDate.split('T')[0] : new Date(expDate).toISOString().split('T')[0];
              currentPageExpirations.add(dateStr);
              seenExpirations.add(dateStr);
            }
          });
          
          allContracts = allContracts.concat(response.data.results);
          
          // Check for next page
          if (response.data.next_url && pageCount < maxPages - 1) {
            currentUrl = response.data.next_url;
            pageCount++;
            
            // If we're only seeing one expiration date repeatedly after several pages,
            // the API cursor is filtering by expiration_date. We need a different strategy.
            if (currentPageExpirations.size === 1 && seenExpirations.size === 1 && pageCount > 3) {
              // Break from this loop and fetch other expiration dates using contracts endpoint
              break;
            }
            
            await new Promise(resolve => setTimeout(resolve, 100)); // Small delay between pages
          } else {
            break; // No more pages
          }
        } else {
          break; // No results on this page
        }
      } catch (error) {
        console.error(`❌ Error fetching ${ticker} page ${pageCount + 1}:`, error.message);
        if (error.response?.status === 429) {
          // Rate limited - wait longer
          console.log(`⏳ Rate limited, waiting 2 seconds...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue; // Retry this page
        } else {
          throw error; // Re-throw other errors
        }
      }
    }
    
    console.log(`✅ Successfully fetched ${allContracts.length} total contracts across ${pageCount} page(s)`);
    console.log(`📅 Unique expiration dates found so far: ${seenExpirations.size}`);
    console.log(`📅 Expiration dates:`, Array.from(seenExpirations).sort());
    
    // ALWAYS try to fetch contracts for multiple expiration dates
    // The snapshot API might return contracts for multiple expirations, but we want to ensure we get ALL
    if (allContracts.length > 0) {
      // Count actual expiration dates in fetched contracts
      const actualExpirationsInContracts = new Set();
      allContracts.forEach(c => {
        const expDate = c.details?.expiration_date || c.expiration_date;
        if (expDate) {
          const dateStr = typeof expDate === 'string' ? expDate.split('T')[0] : new Date(expDate).toISOString().split('T')[0];
          actualExpirationsInContracts.add(dateStr);
        }
      });
      
      // ALWAYS try to fetch more expiration dates if we have fewer than 10
      // Most liquid stocks have 15-30+ expiration dates available
      if (actualExpirationsInContracts.size < 10) {
        try {
          // Use contracts endpoint to get ALL available expiration dates for this ticker
          // We need to paginate through contracts endpoint to get all expiration dates
          const contractsUrl = `https://api.massive.com/v3/reference/options/contracts`;
          let allAvailableExpirations = new Set();
          let contractsCurrentUrl = contractsUrl;
          let contractsPageCount = 0;
          const maxContractsPages = 50;
          
          while (contractsPageCount < maxContractsPages) {
            try {
              const contractsResponse = await axios.get(contractsCurrentUrl, {
                params: contractsPageCount === 0 ? {
                  underlying_ticker: ticker.toUpperCase(),
                  apiKey: apiKey,
                  limit: 1000,
                } : undefined,
                timeout: 60000,
              });
              
              if (contractsResponse.data?.results && contractsResponse.data.results.length > 0) {
                // Extract expiration dates from this page
                contractsResponse.data.results.forEach(c => {
                  const expDate = c.expiration_date || c.details?.expiration_date;
                  if (expDate) {
                    const dateStr = typeof expDate === 'string' ? expDate.split('T')[0] : new Date(expDate).toISOString().split('T')[0];
                    allAvailableExpirations.add(dateStr);
                  }
                });
                
                if (contractsResponse.data.next_url && contractsPageCount < maxContractsPages - 1) {
                  // next_url might not include API key, so we need to append it
                  let nextUrl = contractsResponse.data.next_url;
                  try {
                    const urlObj = new URL(nextUrl);
                    if (!urlObj.searchParams.has('apiKey')) {
                      urlObj.searchParams.set('apiKey', apiKey);
                      nextUrl = urlObj.toString();
                    }
                  } catch (e) {
                    // If URL parsing fails, try appending API key as query param
                    nextUrl = `${contractsResponse.data.next_url}${contractsResponse.data.next_url.includes('?') ? '&' : '?'}apiKey=${apiKey}`;
                  }
                  contractsCurrentUrl = nextUrl;
                  contractsPageCount++;
                  await new Promise(resolve => setTimeout(resolve, 100));
                } else {
                  break;
                }
              } else {
                break;
              }
            } catch (contractsPageError) {
              console.warn(`⚠️ Error fetching contracts page ${contractsPageCount + 1}:`, contractsPageError.message);
              break;
            }
          }
          
          const sortedExpirations = Array.from(allAvailableExpirations).sort();
          
          if (allAvailableExpirations.size > 0) {
            // For each expiration date we haven't fetched yet, make a snapshot API call
            const expirationDatesToFetch = sortedExpirations.filter(exp => !actualExpirationsInContracts.has(exp));
            
            // Fetch up to 25 expiration dates for comprehensive coverage
            for (const expDate of expirationDatesToFetch.slice(0, 25)) {
            try {
              // Make snapshot API call with expiration_date filter
              const expSnapshotUrl = `https://api.massive.com/v3/snapshot/options/${ticker.toUpperCase()}`;
              let expContracts = [];
              let expCurrentUrl = expSnapshotUrl;
              let expPageCount = 0;
              
              while (expPageCount < 50) { // Limit pages per expiration
                const expResponse = await axios.get(expCurrentUrl, {
                  params: expPageCount === 0 ? {
                    apiKey: apiKey,
                    'expiration_date': expDate, // Filter by specific expiration date
                    limit: 1000,
                  } : undefined,
                  timeout: 60000,
                });
                
                if (expResponse.data?.results && expResponse.data.results.length > 0) {
                  expContracts = expContracts.concat(expResponse.data.results);
                  
                  if (expResponse.data.next_url && expPageCount < 49) {
                    expCurrentUrl = expResponse.data.next_url;
                    expPageCount++;
                    await new Promise(resolve => setTimeout(resolve, 100));
                  } else {
                    break;
                  }
                } else {
                  break;
                }
              }
              
              if (expContracts.length > 0) {
                allContracts = allContracts.concat(expContracts);
                actualExpirationsInContracts.add(expDate);
                seenExpirations.add(expDate);
              }
              
              // Rate limiting delay between expiration date fetches
              await new Promise(resolve => setTimeout(resolve, 200));
            } catch (expError) {
              console.warn(`⚠️ Error fetching expiration ${expDate}:`, expError.message);
            }
            }
          }
        } catch (contractsError) {
          console.warn(`⚠️ Could not fetch additional expiration dates:`, contractsError.message);
          if (contractsError.response) {
            console.warn(`⚠️ Response status:`, contractsError.response.status);
            console.warn(`⚠️ Response data:`, JSON.stringify(contractsError.response.data, null, 2));
          }
        }
      }
    }
    
    if (allContracts.length > 0) {
      // Count unique expiration dates and strikes
      const uniqueExpirations = new Set();
      const uniqueStrikes = new Set();
      const expirationDateFields = new Set();
      const expirationSamples = {};
      
      allContracts.forEach((c, idx) => {
        // Try multiple field paths for expiration date
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
            
            // Track which field was used (sample first 5 contracts)
            if (idx < 5) {
              if (c.details?.expiration_date) expirationDateFields.add('details.expiration_date');
              else if (c.expiration_date) expirationDateFields.add('expiration_date');
              else if (c.expiry) expirationDateFields.add('expiry');
              
              if (!expirationSamples[dateStr]) {
                expirationSamples[dateStr] = [];
              }
              expirationSamples[dateStr].push({
                strike: c.details?.strike_price || c.strike_price,
                type: c.details?.contract_type || c.contract_type,
              });
            }
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
      
      // If we only found one expiration date, try to fetch more using contracts endpoint
      if (uniqueExpirations.size === 1) {
        console.warn(`⚠️ WARNING: Only found 1 expiration date (${sortedExpirations[0]})!`);
        console.warn(`⚠️ Snapshot API may only return nearest expiration. Trying contracts endpoint...`);
        
        try {
          // Use contracts endpoint to get all available expiration dates
          const contractsUrl = `https://api.massive.com/v3/reference/options/contracts`;
          let additionalContracts = [];
          let contractsPageCount = 0;
          let contractsCurrentUrl = contractsUrl;
          const maxContractsPages = 50;
          
          while (contractsPageCount < maxContractsPages) {
            const contractsResponse = await axios.get(contractsCurrentUrl, {
              params: contractsPageCount === 0 ? {
                underlying_ticker: ticker.toUpperCase(),
                apiKey: apiKey,
                limit: 1000,
              } : undefined,
              timeout: 60000,
            });
            
            if (contractsResponse.data?.results && contractsResponse.data.results.length > 0) {
              // Filter contracts that have expiration dates different from what we already have
              const newContracts = contractsResponse.data.results.filter(c => {
                const expDate = c.expiration_date || c.details?.expiration_date;
                if (!expDate) return false;
                const dateStr = typeof expDate === 'string' ? expDate.split('T')[0] : new Date(expDate).toISOString().split('T')[0];
                return !uniqueExpirations.has(dateStr);
              });
              
              if (newContracts.length > 0) {
                additionalContracts = additionalContracts.concat(newContracts);
                console.log(`📊 Found ${newContracts.length} additional contracts with different expiration dates`);
              }
              
              if (contractsResponse.data.next_url && contractsPageCount < maxContractsPages - 1) {
                contractsCurrentUrl = contractsResponse.data.next_url;
                contractsPageCount++;
                await new Promise(resolve => setTimeout(resolve, 100));
              } else {
                break;
              }
            } else {
              break;
            }
          }
          
          if (additionalContracts.length > 0) {
            allContracts = allContracts.concat(additionalContracts);
            
            // Re-count expiration dates
            additionalContracts.forEach(c => {
              const expDate = c.expiration_date || c.details?.expiration_date;
              if (expDate) {
                const dateStr = typeof expDate === 'string' ? expDate.split('T')[0] : new Date(expDate).toISOString().split('T')[0];
                uniqueExpirations.add(dateStr);
              }
            });
          }
        } catch (error) {
          console.warn(`⚠️ Failed to fetch additional contracts:`, error.message);
        }
      }
      
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
  
  // Try to get underlying price from first contract (try multiple field names)
  const firstContract = contracts[0];
  const underlyingPrice = firstContract.underlying_price || 
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
