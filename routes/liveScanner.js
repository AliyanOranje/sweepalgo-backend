import express from 'express';
import axios from 'axios';
import * as optionsCalc from '../utils/optionsCalculations.js';
import { recentTradesMap } from '../utils/optionsCalculations.js';

const router = express.Router();

const {
  getSpotPrice,
  calculateSetupScore,
  getMarketStatus,
  parseOptionSymbol,
  calculateOTM,
  formatIV,
} = optionsCalc;

// Helper to check if filters are too restrictive
function areFiltersTooRestrictive(filters) {
  // If all numeric filters are 0 or very low, they're not restrictive
  // But if minVolume is 0 and minPremium is 0, we should still scan
  // The issue is more about whether there's actual data available
  return false; // Let the scan run and return what it finds
}

// Get API key from environment or use provided one
const apiKey = process.env.MASSIVE_API_KEY || process.env.POLYGON_API_KEY || '1lG8Vly2ATpCauQSeCNBc40kOWGJJENL';

// Log API key status (first 10 chars only for security)
if (!process.env.MASSIVE_API_KEY && !process.env.POLYGON_API_KEY) {
  console.log(`🔑 Live Scanner: Using hardcoded API key (first 10 chars): ${apiKey.substring(0, 10)}...`);
} else {
  console.log(`🔑 Live Scanner: Using API key from environment (first 10 chars): ${apiKey.substring(0, 10)}...`);
}

/**
 * Calculate GEX position relative to gamma wall
 */
async function getGEXPosition(ticker, strike, spotPrice) {
  try {
    // Fetch GEX data to find gamma wall
    const port = process.env.PORT || 5000;
    const gexResponse = await axios.get(`http://localhost:${port}/api/gex/${ticker}`, {
      timeout: 10000,
    }).catch(() => null);

    if (gexResponse?.data?.success && gexResponse.data.summary?.gammaWall) {
      // gammaWall can be a number or an object with strike property
      const gammaWall = typeof gexResponse.data.summary.gammaWall === 'object' 
        ? gexResponse.data.summary.gammaWall.strike 
        : gexResponse.data.summary.gammaWall;
      
      if (gammaWall && typeof gammaWall === 'number') {
        const distance = ((spotPrice - gammaWall) / gammaWall) * 100;
        
        if (Math.abs(distance) < 2) {
          return { position: 'at', distance: Math.abs(distance), gammaWall };
        } else if (spotPrice < gammaWall) {
          return { position: 'below', distance: Math.abs(distance), gammaWall };
        } else {
          return { position: 'above', distance: Math.abs(distance), gammaWall };
        }
      }
    }
  } catch (error) {
    // GEX endpoint might not be available, return neutral
    console.log(`GEX position check failed for ${ticker}:`, error.message);
  }
  
  return { position: 'unknown', distance: 0, gammaWall: null };
}

/**
 * Generate trade plan (Entry/Exit/Stop/Why)
 */
function generateTradePlan(contract, gexPosition, setupScore, spotPrice) {
  const isCall = contract.type === 'CALL';
  const strike = contract.strike;
  const currentPrice = contract.last || contract.mark || ((contract.bid || 0) + (contract.ask || 0)) / 2;
  const dte = contract.dte || 0;
  
  // Entry: Current price or slightly better
  const entry = currentPrice;
  
  // Stop loss: Based on option type and GEX position
  let stopLoss;
  let stopLossPercent;
  
  if (isCall) {
    if (gexPosition.position === 'below') {
      // Bullish setup - tighter stop
      stopLossPercent = 0.30; // 30% stop
    } else if (gexPosition.position === 'at') {
      stopLossPercent = 0.40; // 40% stop
    } else {
      stopLossPercent = 0.50; // 50% stop (more risk above wall)
    }
  } else {
    // Put
    if (gexPosition.position === 'above') {
      // Bearish setup - tighter stop
      stopLossPercent = 0.30;
    } else if (gexPosition.position === 'at') {
      stopLossPercent = 0.40;
    } else {
      stopLossPercent = 0.50;
    }
  }
  
  stopLoss = entry * (1 - stopLossPercent);
  
  // Target/Exit: Based on setup score and GEX
  let target1, target2;
  let target1Percent, target2Percent;
  
  if (setupScore >= 9) {
    // High confidence - multiple targets
    target1Percent = 0.50; // 50% gain
    target2Percent = 1.00; // 100% gain
  } else if (setupScore >= 7.5) {
    target1Percent = 0.40; // 40% gain
    target2Percent = 0.80; // 80% gain
  } else {
    target1Percent = 0.30; // 30% gain
    target2Percent = 0.60; // 60% gain
  }
  
  target1 = entry * (1 + target1Percent);
  target2 = entry * (1 + target2Percent);
  
  // Generate "Why" reasoning
  const whyReasons = [];
  
  if (gexPosition.position === 'below' && isCall) {
    whyReasons.push('Price below gamma wall creates bullish momentum as market makers hedge');
  } else if (gexPosition.position === 'above' && !isCall) {
    whyReasons.push('Price above gamma wall creates bearish momentum as market makers hedge');
  }
  
  if (contract.volume > 5000) {
    whyReasons.push(`High volume (${contract.volume.toLocaleString()}) indicates strong institutional interest`);
  }
  
  if (contract.openInterest > 1000) {
    whyReasons.push(`High open interest (${contract.openInterest.toLocaleString()}) provides liquidity`);
  }
  
  if (setupScore >= 9) {
    whyReasons.push('Exceptional setup score indicates high probability trade');
  }
  
  if (dte <= 7) {
    whyReasons.push('Short DTE provides rapid time decay advantage');
  }
  
  const why = whyReasons.length > 0 
    ? whyReasons.join('. ') + '.'
    : 'Setup meets minimum criteria for alert generation.';
  
  return {
    entry: entry.toFixed(2),
    stopLoss: stopLoss.toFixed(2),
    target1: target1.toFixed(2),
    target2: target2.toFixed(2),
    stopLossPercent: (stopLossPercent * 100).toFixed(0),
    target1Percent: (target1Percent * 100).toFixed(0),
    target2Percent: (target2Percent * 100).toFixed(0),
    why,
  };
}

/**
 * Scan options contracts for a ticker
 */
async function scanTicker(ticker, filters) {
  const alerts = [];
  
  try {
    // Get spot price - try from API first, then extract from first contract if available
    let spotPrice = await getSpotPrice(ticker);
    
    // If spot price fetch failed, we'll try to get it from the first contract's underlying_asset
    let contractsFetched = false;
    
    // Fetch options snapshot - use same method as Options Flow
    const snapshotUrl = `https://api.massive.com/v3/snapshot/options/${ticker.toUpperCase()}`;
    let allContracts = [];
    let pageCount = 0;
    // PERFORMANCE: Fetch only 2 pages (200 contracts max) per ticker for speed
    const maxPages = 2;
    const contractsPerPage = 100;
    let currentUrl = snapshotUrl;
    
    console.log(`🔍 Starting fetch for ${ticker} (max ${maxPages} pages, ${contractsPerPage} per page)`);
    
    while (currentUrl && pageCount < maxPages) {
      try {
        // Always pass apiKey in params (axios will handle it correctly even if URL has it)
        const params = {
          apiKey: apiKey,
        };
        
        // Only add other params if it's the first page (not a next_url)
        if (pageCount === 0) {
          params.order = 'asc';
          params.limit = contractsPerPage;
          params.sort = 'ticker';
        }
        
        const response = await axios.get(currentUrl, { 
          params: params,
          timeout: 10000 // Reduced to 10s for faster response
        });
        const data = response.data;
        
        if (data.results && Array.isArray(data.results)) {
          allContracts = allContracts.concat(data.results);
          if (pageCount === 0) {
            console.log(`✅ ${ticker} page 1: Got ${data.results.length} contracts (API working!)`);
          }
        } else {
          console.warn(`⚠️ ${ticker} page ${pageCount + 1}: No results array in response`);
          console.warn(`⚠️ Response keys:`, Object.keys(data || {}));
        }
        
        // Check for pagination - strip API key from next_url and use our own
        pageCount++;
        if (data.next_url && pageCount < maxPages) {
          try {
            // Parse next_url and replace any existing apiKey with ours
            const urlObj = new URL(data.next_url);
            urlObj.searchParams.set('apiKey', apiKey); // Always use our API key
            currentUrl = urlObj.toString();
          } catch (e) {
            // Fallback: append our API key if URL parsing fails
            const separator = data.next_url.includes('?') ? '&' : '?';
            currentUrl = `${data.next_url}${separator}apiKey=${apiKey}`;
          }
          // Small delay to avoid rate limiting (reduced to 20ms for speed)
          await new Promise(resolve => setTimeout(resolve, 20));
        } else {
          currentUrl = null;
        }
      } catch (error) {
        console.error(`❌ Error fetching page ${pageCount + 1} for ${ticker}:`, error.message);
        if (error.response) {
          console.error(`❌ Response status: ${error.response.status}`);
          console.error(`❌ Response data:`, JSON.stringify(error.response.data, null, 2).substring(0, 500));
          if (error.response.status === 401) {
            console.error(`❌ Authentication failed - check API key: ${apiKey ? 'Key exists' : 'Key missing'}`);
          }
        }
        break;
      }
    }
    
    // If spot price wasn't fetched, try to get it from first contract's underlying_asset
    if (!spotPrice && allContracts.length > 0) {
      const firstContract = allContracts[0];
      if (firstContract.underlying_asset?.price) {
        spotPrice = firstContract.underlying_asset.price;
        console.log(`✅ Extracted spot price ${spotPrice} from contract data for ${ticker}`);
      }
    }
    
    if (!spotPrice) {
      console.warn(`⚠️ Could not get spot price for ${ticker} - skipping scan`);
      return alerts;
    }
    
    console.log(`📊 Scanned ${allContracts.length} contracts for ${ticker}, spot price: $${spotPrice}`);
    console.log(`📊 Filters: minVolume=${filters.minVolume}, minPremium=${filters.minPremium}, maxDte=${filters.maxDte}, minScore=${filters.minScore}`);
    
    if (allContracts.length === 0) {
      console.warn(`⚠️ No contracts found for ${ticker} - API may have returned empty results`);
      console.warn(`⚠️ Check API response structure - expected data.results array`);
      console.warn(`⚠️ This could be due to: 401 auth error, rate limiting, or empty API response`);
      console.warn(`⚠️ API Key used: ${apiKey ? apiKey.substring(0, 10) + '...' : 'MISSING'}`);
      return alerts;
    }
    
    console.log(`✅ ${ticker}: Successfully fetched ${allContracts.length} contracts from API`);
    
    // Log sample contract structure for debugging
    if (allContracts.length > 0) {
      const sample = allContracts[0];
      console.log(`📋 Sample contract structure for ${ticker}:`, {
        hasTicker: !!sample.ticker,
        hasSymbol: !!sample.symbol,
        hasVolume: 'volume' in sample,
        hasOpenInterest: 'open_interest' in sample || 'openInterest' in sample,
        hasLast: 'last' in sample,
        hasMark: 'mark' in sample,
        hasBid: 'bid' in sample,
        hasAsk: 'ask' in sample,
        keys: Object.keys(sample).slice(0, 10),
      });
    }
    
    let processedCount = 0;
    let filteredCount = 0;
    let parseErrors = 0;
    let expiredCount = 0;
    let noPriceCount = 0;
    
    // Process each contract
    for (const contract of allContracts) {
      processedCount++;
      try {
        // Parse contract details - handle different API response structures
        const contractTicker = contract.ticker || contract.symbol || contract.details?.ticker;
        if (!contractTicker) {
          parseErrors++;
          continue;
        }
        
        const parsed = parseOptionSymbol(contractTicker);
        if (!parsed) {
          parseErrors++;
          continue;
        }
        
        // Get strike and expiration from parsed or direct fields
        const strike = parsed.strike || contract.details?.strike_price || contract.strike_price;
        const expirationDateStr = contract.details?.expiration_date || contract.expiration_date;
        
        // Parse expiration date - prefer details.expiration_date (YYYY-MM-DD format) over parsed date
        let expirationDate = null;
        if (expirationDateStr) {
          // Parse YYYY-MM-DD format and set to end of day to avoid timezone issues
          const dateParts = expirationDateStr.split('-');
          if (dateParts.length === 3) {
            expirationDate = new Date(parseInt(dateParts[0]), parseInt(dateParts[1]) - 1, parseInt(dateParts[2]), 23, 59, 59);
          } else {
            expirationDate = new Date(expirationDateStr);
          }
        } else if (parsed.expirationDate) {
          expirationDate = parsed.expirationDate;
        }
        
        if (!expirationDate || isNaN(expirationDate.getTime())) {
          parseErrors++;
          continue;
        }
        
        // Calculate DTE - use start of today to avoid timezone issues
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const expStart = new Date(expirationDate.getFullYear(), expirationDate.getMonth(), expirationDate.getDate());
        const dte = Math.ceil((expStart - todayStart) / (1000 * 60 * 60 * 24));
        
        if (dte < 0) {
          expiredCount++;
          continue; // Skip expired
        }
        
        // Apply filters (only skip if filter is set AND contract doesn't meet it)
        if (filters.maxDte && filters.maxDte > 0 && dte > filters.maxDte) {
          filteredCount++;
          continue;
        }
        
        // Use volume or OI (when market is closed, volume is 0 but OI shows interest)
        // Volume can be in different places: contract.volume, contract.day.volume, etc.
        const contractVolume = contract.day?.volume || contract.volume || 0;
        const contractOI = contract.open_interest || contract.openInterest || 0;
        
        // During market hours, prioritize volume; after hours, use OI
        // If volume is 0 but OI is high, use a percentage of OI as proxy
        let effectiveSize = contractVolume;
        if (contractVolume === 0 && contractOI > 0) {
          // Use 5% of OI as proxy (more conservative than before)
          effectiveSize = Math.floor(contractOI * 0.05);
        }
        
        // Only filter by volume if filter is set AND contract doesn't meet it
        // But be lenient: if volume is 0 but OI is high, still consider it
        if (filters.minVolume && filters.minVolume > 0) {
          if (effectiveSize < filters.minVolume) {
            // Special case: if volume is 0 but OI is very high, still include it
            if (contractVolume === 0 && contractOI >= filters.minVolume * 10) {
              effectiveSize = filters.minVolume; // Use filter value as minimum
            } else {
              filteredCount++;
              continue;
            }
          }
        }
        
        // Calculate premium - use mark price or mid price
        // Price can be in: last_trade.price, last_quote.midpoint, mark, last, or bid/ask average
        const price = contract.last_trade?.price || 
                     contract.last_quote?.midpoint ||
                     contract.mark || 
                     contract.last || 
                     ((contract.last_quote?.bid || contract.bid || 0) + (contract.last_quote?.ask || contract.ask || 0)) / 2;
        if (!price || price <= 0) {
          noPriceCount++;
          filteredCount++;
          continue; // Skip contracts with no valid price
        }
        
        // Use effective size for premium calculation
        const premium = price * effectiveSize * 100;
        
        // Only filter by premium if it's set and > 0
        if (filters.minPremium && filters.minPremium > 0 && premium < filters.minPremium) {
          filteredCount++;
          continue;
        }
        
        // PERFORMANCE: Skip GEX check entirely - calculate it client-side or use simple heuristic
        // GEX check is too slow (1-2s per contract). Use a simple position estimate instead.
        let gexPosition = { position: 'unknown', distance: 0, gammaWall: null };
        
        // Simple heuristic: if strike is close to spot, it's "at wall", otherwise estimate
        const strikeDistance = Math.abs((strike - spotPrice) / spotPrice) * 100;
        if (strikeDistance < 2) {
          gexPosition.position = 'at';
        } else if (strike < spotPrice) {
          gexPosition.position = 'below';
        } else {
          gexPosition.position = 'above';
        }
        
        // Only do actual GEX check if filter requires it AND we have time
        if (filters.gexPosition && filters.gexPosition !== 'all' && alerts.length < 50) {
          try {
            // Quick timeout - 500ms max
            const gexPromise = getGEXPosition(ticker, strike, spotPrice);
            const timeoutPromise = new Promise((resolve) => {
              setTimeout(() => resolve(gexPosition), 500);
            });
            gexPosition = await Promise.race([gexPromise, timeoutPromise]);
            
            // Filter by GEX position
            if (gexPosition.position !== filters.gexPosition) {
              filteredCount++;
              continue;
            }
          } catch (error) {
            // If GEX check fails, use heuristic
            if (gexPosition.position !== filters.gexPosition) {
              filteredCount++;
              continue;
            }
          }
        }
        
        // Get contract type from parsed or details
        const contractType = parsed.type || (contract.details?.contract_type === 'call' ? 'CALL' : 'PUT') || 'CALL';
        
        // Calculate Vol/OI ratio
        const volOiRatio = contractOI > 0 ? contractVolume / contractOI : contractVolume > 0 ? 999 : 0;
        
        // Calculate price change from day data
        const priceChange = contract.day?.change_percent || contract.price_change_percent || contract.price_change || 0;
        
        // Get GEX position (already calculated above, but ensure it's available)
        const gexPos = gexPosition.position || 'unknown';
        
        // Calculate setup score with all required parameters
        const tradeData = {
          ticker,
          strike: strike,
          type: contractType,
          volume: contractVolume, // Use actual volume
          openInterest: contractOI, // Use actual OI
          premium: premium >= 1000000 ? `$${(premium / 1000000).toFixed(2)}M` : `$${(premium / 1000).toFixed(0)}K`,
          premiumRaw: premium,
          tradeType: effectiveSize > 5000 ? 'Sweep' : 'Normal',
          dte: dte, // Pass as number
          spot: spotPrice,
          changePercent: priceChange, // Pass price change percentage
          gexPosition: gexPos, // Pass GEX position
        };
        
        const setupScoreResult = calculateSetupScore(tradeData);
        const setupScore = setupScoreResult.score || 5;
        
        // Apply min score filter (only if set and > 0)
        // But be lenient: if score is close (within 1 point), still include it
        if (filters.minScore && filters.minScore > 0) {
          if (setupScore < filters.minScore - 1) {
            filteredCount++;
            continue;
          }
        }
        
        // Generate trade plan
        const tradePlan = generateTradePlan(
          {
            ...contract,
            type: contractType,
            strike: strike,
            dte,
            last: price,
            mark: price,
            bid: contract.last_quote?.bid || contract.bid || 0,
            ask: contract.last_quote?.ask || contract.ask || 0,
          },
          gexPosition,
          setupScore,
          spotPrice
        );
        
        // Determine volume level and Vol/OI level for display
        const volumeLevel = contractVolume >= 10000 ? 'spike' : contractVolume >= 5000 ? 'high' : contractVolume >= 1000 ? 'medium' : 'low';
        const volOiLevel = volOiRatio >= 2.0 ? 'spike' : volOiRatio >= 1.0 ? 'high' : 'normal';
        
        // Determine score level
        const scoreLevel = setupScore >= 8.0 ? 'high' : setupScore >= 6.5 ? 'medium' : 'low';
        
        // Create alert - always include it, let frontend filter by hasAlert
        alerts.push({
          id: `${ticker}-${strike}-${contractType}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }),
          timestamp: new Date().toISOString(),
          symbol: ticker,
          strike: `$${strike.toFixed(2)}`,
          strikeRaw: strike,
          type: contractType,
          expiry: parsed.expiration || expirationDateStr || `${expirationDate.getMonth() + 1}/${expirationDate.getDate()}`,
          dte: `${dte}d`,
          dteRaw: dte,
          premium: premium >= 1000000 ? `$${(premium / 1000000).toFixed(2)}M` : `$${(premium / 1000).toFixed(0)}K`,
          premiumRaw: premium,
          price: price.toFixed(2),
          priceChange: priceChange ? priceChange.toFixed(1) : '0.0',
          volume: contractVolume,
          oi: contractOI,
          volOiRatio: parseFloat(volOiRatio.toFixed(2)),
          volumeLevel,
          volOiLevel,
          gexPosition: gexPosition.position,
          gammaWall: gexPosition.gammaWall ? `$${gexPosition.gammaWall.toFixed(2)}` : null,
          score: parseFloat(setupScore.toFixed(1)),
          scoreLevel,
          confidence: setupScore >= 9 ? 'high' : setupScore >= 7.5 ? 'medium' : 'low',
          hasAlert: setupScore >= (filters.minScore || 7.0),
          tradePlan,
          setupScoreReasons: setupScoreResult.reasons || [],
        });
      } catch (error) {
        console.error(`❌ Error processing contract for ${ticker}:`, error.message);
        console.error(`❌ Contract that failed:`, {
          ticker: contract.ticker || contract.symbol || contract.details?.ticker,
          keys: Object.keys(contract).slice(0, 10),
        });
        if (error.stack) {
          console.error(`❌ Stack:`, error.stack.split('\n').slice(0, 3).join('\n'));
        }
        continue;
      }
    }
    
    // PERFORMANCE: Sort by score (highest first) - limit to top 500 for speed
    alerts.sort((a, b) => b.score - a.score);
    if (alerts.length > 500) {
      alerts = alerts.slice(0, 500);
      console.log(`⚠️ ${ticker}: Limited to top 500 alerts for performance`);
    }
    
    console.log(`✅ ${ticker}: Processed ${processedCount} contracts`);
    console.log(`   - Total contracts fetched: ${allContracts.length}`);
    console.log(`   - Parse errors: ${parseErrors}`);
    console.log(`   - Expired: ${expiredCount}`);
    console.log(`   - No price: ${noPriceCount}`);
    console.log(`   - Filtered out: ${filteredCount}`);
    console.log(`   - Alerts found: ${alerts.length}`);
    
    // If we processed contracts but got no alerts, show why
    if (processedCount > 0 && alerts.length === 0 && allContracts.length > 0) {
      console.log(`⚠️ ${ticker}: No alerts despite processing ${processedCount} contracts`);
      console.log(`⚠️ Check filters: minVolume=${filters.minVolume}, minPremium=${filters.minPremium}, maxDte=${filters.maxDte}, minScore=${filters.minScore}`);
      if (allContracts.length > 0) {
        const sample = allContracts[0];
        console.log(`⚠️ Sample contract: ticker=${sample.ticker || sample.details?.ticker}, hasGreeks=${!!sample.greeks}, hasGamma=${!!sample.greeks?.gamma}, volume=${sample.day?.volume || 0}, oi=${sample.open_interest || 0}`);
      }
    }
    
    // If no alerts but we have contracts, log a sample contract for debugging
    if (alerts.length === 0 && allContracts.length > 0 && processedCount > 0) {
      const sampleContract = allContracts[0];
      const sampleTicker = sampleContract.ticker || sampleContract.symbol || sampleContract.details?.ticker;
      const sampleParsed = parseOptionSymbol(sampleTicker);
      console.log(`🔍 DEBUG: Why no alerts for ${ticker}? Sample contract analysis:`, {
        contractTicker: sampleTicker,
        parsed: sampleParsed,
        volume: sampleContract.day?.volume || sampleContract.volume || 0,
        open_interest: sampleContract.open_interest || sampleContract.openInterest || 0,
        price: sampleContract.last_trade?.price || sampleContract.last_quote?.midpoint || sampleContract.mark || sampleContract.last || 0,
        strike: sampleContract.details?.strike_price || sampleParsed?.strike,
        expiration: sampleContract.details?.expiration_date || sampleContract.expiration_date,
        contractType: sampleContract.details?.contract_type,
        filters: filters,
      });
      
      // Try to process the sample contract manually to see where it fails
      if (sampleParsed && sampleContract.details?.strike_price) {
        const testStrike = sampleParsed.strike || sampleContract.details.strike_price;
        const testVolume = sampleContract.day?.volume || sampleContract.volume || 0;
        const testPrice = sampleContract.last_trade?.price || sampleContract.last_quote?.midpoint || 0;
        const testPremium = testPrice * testVolume * 100;
        console.log(`🔍 Sample contract would have:`, {
          strike: testStrike,
          volume: testVolume,
          price: testPrice,
          premium: testPremium,
          meetsVolumeFilter: !filters.minVolume || filters.minVolume === 0 || testVolume >= filters.minVolume,
          meetsPremiumFilter: !filters.minPremium || filters.minPremium === 0 || testPremium >= filters.minPremium,
        });
      }
    }
    
  } catch (error) {
    console.error(`❌ Error scanning ${ticker}:`, error.message);
    console.error(`❌ Error stack:`, error.stack);
  }
  
  return alerts;
}

/**
 * GET /api/live-scanner/test
 * Test endpoint to verify scanner is working
 */
router.get('/test', async (req, res) => {
  try {
    const testTicker = 'SPY';
    console.log(`🧪 Testing scanner with ${testTicker}...`);
    
    // Test spot price
    let spotPrice = await getSpotPrice(testTicker);
    
    // Test API connection
    const apiKey = process.env.MASSIVE_API_KEY || process.env.POLYGON_API_KEY || '1lG8Vly2ATpCauQSeCNBc40kOWGJJENL';
    const testUrl = `https://api.massive.com/v3/snapshot/options/${testTicker}?order=asc&limit=10&sort=ticker&apiKey=${apiKey}`;
    
    try {
      const response = await axios.get(testUrl, { timeout: 10000 });
      const contracts = response.data?.results || [];
      console.log(`✅ API connection successful: ${contracts.length} contracts returned`);
      
      // Extract spot price from contract if not available
      if (!spotPrice && contracts.length > 0 && contracts[0].underlying_asset?.price) {
        spotPrice = contracts[0].underlying_asset.price;
        console.log(`✅ Extracted spot price from contract: $${spotPrice}`);
      }
      
      console.log(`✅ Spot price for ${testTicker}: $${spotPrice || 'N/A'}`);
      
      // Test parsing
      if (contracts.length > 0) {
        const sampleContract = contracts[0];
        const contractTicker = sampleContract.ticker || sampleContract.symbol || sampleContract.details?.ticker;
        const parsed = parseOptionSymbol(contractTicker);
        console.log(`✅ Sample contract parsed:`, parsed);
        
        // Get actual values from contract
        const contractVolume = sampleContract.day?.volume || sampleContract.volume || 0;
        const contractOI = sampleContract.open_interest || sampleContract.openInterest || 0;
        const contractPrice = sampleContract.last_trade?.price || sampleContract.last_quote?.midpoint || sampleContract.mark || 0;
        const strike = parsed?.strike || sampleContract.details?.strike_price || 0;
        const contractType = parsed?.type || (sampleContract.details?.contract_type === 'call' ? 'CALL' : 'PUT') || 'CALL';
        
        // Calculate DTE - use same logic as main scanner
        const expirationDateStr = sampleContract.details?.expiration_date || sampleContract.expiration_date;
        let expirationDate = null;
        if (expirationDateStr) {
          const dateParts = expirationDateStr.split('-');
          if (dateParts.length === 3) {
            expirationDate = new Date(parseInt(dateParts[0]), parseInt(dateParts[1]) - 1, parseInt(dateParts[2]), 23, 59, 59);
          } else {
            expirationDate = new Date(expirationDateStr);
          }
        } else if (parsed?.expirationDate) {
          expirationDate = parsed.expirationDate;
        }
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const expStart = expirationDate ? new Date(expirationDate.getFullYear(), expirationDate.getMonth(), expirationDate.getDate()) : null;
        const dte = expStart ? Math.ceil((expStart - todayStart) / (1000 * 60 * 60 * 24)) : 30;
        
        // Test score calculation with real data
        const premium = contractPrice * contractVolume * 100;
        const tradeData = {
          ticker: testTicker,
          strike: strike,
          type: contractType,
          volume: contractVolume,
          openInterest: contractOI,
          premium: premium >= 1000000 ? `$${(premium / 1000000).toFixed(2)}M` : `$${(premium / 1000).toFixed(0)}K`,
          premiumRaw: premium,
          tradeType: contractVolume > 5000 ? 'Sweep' : 'Normal',
          dte: `${dte}d`, // Must be string format like "30d"
          spot: spotPrice || 0,
        };
        
        const scoreResult = calculateSetupScore(tradeData);
        console.log(`✅ Score calculation: ${scoreResult.score}/10`);
        console.log(`✅ Contract details: Volume=${contractVolume}, OI=${contractOI}, Price=$${contractPrice}, Strike=$${strike}, DTE=${dte}d`);
      }
      
      res.json({
        success: true,
        message: 'Scanner test successful',
        results: {
          spotPrice,
          contractsReturned: contracts.length,
          sampleContract: contracts[0] || null,
          apiWorking: true,
        },
      });
    } catch (apiError) {
      console.error(`❌ API test failed:`, apiError.message);
      res.json({
        success: false,
        message: 'API test failed',
        error: apiError.message,
        results: {
          spotPrice,
          apiWorking: false,
        },
      });
    }
  } catch (error) {
    console.error('❌ Test endpoint error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/live-scanner/debug
 * Debug endpoint - process one contract and return it
 */
router.get('/debug', async (req, res) => {
  try {
    const testTicker = 'SPY';
    const apiKey = process.env.MASSIVE_API_KEY || process.env.POLYGON_API_KEY || '1lG8Vly2ATpCauQSeCNBc40kOWGJJENL';
    const testUrl = `https://api.massive.com/v3/snapshot/options/${testTicker}?order=asc&limit=1&sort=ticker&apiKey=${apiKey}`;
    
    const response = await axios.get(testUrl, { timeout: 10000 });
    const contracts = response.data?.results || [];
    
    if (contracts.length === 0) {
      return res.json({ success: false, error: 'No contracts returned from API' });
    }
    
    const contract = contracts[0];
    const spotPrice = contract.underlying_asset?.price || await getSpotPrice(testTicker) || 682.3;
    
    // Process the contract
    const contractTicker = contract.ticker || contract.symbol || contract.details?.ticker;
    const parsed = parseOptionSymbol(contractTicker);
    const strike = parsed?.strike || contract.details?.strike_price;
    // Parse expiration date correctly (same logic as main scanner)
    const expirationDateStr = contract.details?.expiration_date || contract.expiration_date;
    let expirationDate = null;
    if (expirationDateStr) {
      const dateParts = expirationDateStr.split('-');
      if (dateParts.length === 3) {
        expirationDate = new Date(parseInt(dateParts[0]), parseInt(dateParts[1]) - 1, parseInt(dateParts[2]), 23, 59, 59);
      } else {
        expirationDate = new Date(expirationDateStr);
      }
    } else if (parsed?.expirationDate) {
      expirationDate = parsed.expirationDate;
    }
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const expStart = expirationDate ? new Date(expirationDate.getFullYear(), expirationDate.getMonth(), expirationDate.getDate()) : null;
    const dte = expStart ? Math.ceil((expStart - todayStart) / (1000 * 60 * 60 * 24)) : 0;
    const contractVolume = contract.day?.volume || contract.volume || 0;
    const contractOI = contract.open_interest || contract.openInterest || 0;
    const price = contract.last_trade?.price || contract.last_quote?.midpoint || contract.mark || 0;
    const premium = price * contractVolume * 100;
    const contractType = parsed?.type || (contract.details?.contract_type === 'call' ? 'CALL' : 'PUT') || 'CALL';
    
    const tradeData = {
      ticker: testTicker,
      strike: strike,
      type: contractType,
      volume: contractVolume,
      openInterest: contractOI,
      premium: premium >= 1000000 ? `$${(premium / 1000000).toFixed(2)}M` : `$${(premium / 1000).toFixed(0)}K`,
      premiumRaw: premium,
      tradeType: contractVolume > 5000 ? 'Sweep' : 'Normal',
      dte: `${dte}d`,
      spot: spotPrice,
    };
    
    const scoreResult = calculateSetupScore(tradeData);
    
    res.json({
      success: true,
      contract: {
        raw: contract,
        parsed: {
          ticker: contractTicker,
          parsed,
          strike,
          expirationDate: expirationDateStr,
          dte,
          contractType,
        },
        metrics: {
          volume: contractVolume,
          oi: contractOI,
          price,
          premium,
          spotPrice,
        },
        score: {
          score: scoreResult.score,
          reasons: scoreResult.reasons,
        },
        filters: {
          minVolume: 0,
          minPremium: 0,
          maxDte: 365,
          minScore: 0,
        },
        wouldPass: {
          volume: true,
          premium: true,
          dte: dte <= 365,
          score: scoreResult.score >= 0,
        },
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack,
    });
  }
});

/**
 * GET /api/live-scanner
 * Scan watchlist and return alerts
 */
router.get('/', async (req, res) => {
  try {
    const {
      watchlist = 'SPY,QQQ,AAPL,NVDA,TSLA',
      minVolume = 50, // Lower default
      minPremium = 5000, // Lower default ($5K)
      maxDte = 60, // Increased default
      gexPosition = 'all',
      minScore = 6, // Lower default
      sortBy = 'score',
    } = req.query;
    
    // Parse watchlist
    const tickers = watchlist.split(',').map(t => t.trim().toUpperCase()).filter(t => t);
    
    if (tickers.length === 0) {
      return res.json({
        success: true,
        alerts: [],
        stats: {
          totalScanned: 0,
          alertsTriggered: 0,
          scanTime: 0,
        },
      });
    }
    
    console.log(`🔍 Starting live scanner for ${tickers.length} tickers:`, tickers);
    
    const startTime = Date.now();
    const allAlerts = [];
    
    // Scan each ticker (limit to 10 tickers to avoid timeout)
    const tickersToScan = tickers.slice(0, 10);
    
    console.log(`🔍 Scanning ${tickersToScan.length} tickers with filters:`, {
      minVolume: parseInt(minVolume),
      minPremium: parseFloat(minPremium),
      maxDte: parseInt(maxDte),
      gexPosition,
      minScore: parseFloat(minScore),
    });
    
    for (const ticker of tickersToScan) {
      try {
        const alerts = await scanTicker(ticker, {
          minVolume: parseInt(minVolume),
          minPremium: parseFloat(minPremium),
          maxDte: parseInt(maxDte),
          gexPosition,
          minScore: parseFloat(minScore),
        });
        allAlerts.push(...alerts);
        console.log(`✅ ${ticker}: Added ${alerts.length} alerts (total: ${allAlerts.length})`);
      } catch (tickerError) {
        console.error(`❌ Error scanning ${ticker}:`, tickerError.message);
        // Continue with other tickers
      }
    }
    
    // Sort alerts
    if (sortBy === 'score') {
      allAlerts.sort((a, b) => b.score - a.score);
    } else if (sortBy === 'volume') {
      allAlerts.sort((a, b) => b.volume - a.volume);
    } else if (sortBy === 'time') {
      allAlerts.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    }
    
    const scanTime = Date.now() - startTime;
    
    // Get market status
    const marketStatus = getMarketStatus();
    
    // Calculate stats
    const stats = {
      totalScanned: allAlerts.length,
      alertsTriggered: allAlerts.filter(a => a.hasAlert).length,
      scanTime,
      tickersScanned: tickersToScan.length,
    };
    
    console.log(`📊 Scanner complete: ${allAlerts.length} total alerts, ${stats.alertsTriggered} triggered, ${scanTime}ms`);
    
    // If no alerts, include debug info
    const response = {
      success: true,
      alerts: allAlerts,
      stats,
      marketStatus: {
        isOpen: marketStatus.isOpen,
        message: marketStatus.message || (marketStatus.isOpen ? 'Market is OPEN' : 'Market is CLOSED'),
      },
      debug: {
        tickersScanned: tickersToScan,
        filters: {
          minVolume: parseInt(minVolume),
          minPremium: parseFloat(minPremium),
          maxDte: parseInt(maxDte),
          minScore: parseFloat(minScore),
        },
      },
    };
    
    // Add warning if no alerts found
    if (allAlerts.length === 0) {
      response.warning = 'No alerts found. Check backend console logs for detailed filtering information.';
      response.debug.message = 'All contracts may have been filtered out. Check console logs for: parse errors, expired contracts, no price, or filter rejections.';
    }
    
    res.json(response);
    
  } catch (error) {
    console.error('Error in live scanner:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      alerts: [],
      stats: {
        totalScanned: 0,
        alertsTriggered: 0,
        scanTime: 0,
      },
    });
  }
});

export default router;

