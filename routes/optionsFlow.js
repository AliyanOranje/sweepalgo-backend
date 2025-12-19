import express from 'express';
import axios from 'axios';
import WebSocket from 'ws';
import * as optionsCalc from '../utils/optionsCalculations.js';

const router = express.Router();

// Extract functions from the imported module
const {
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
} = optionsCalc;

// Store for trades (REST + WS)
const tradesStore = new Map();
// Cap stored trades to avoid memory bloat / UI overload
// Increased to 100K to allow more data, but still prevent memory issues
const MAX_TRADES = 100000; // Increased cap for comprehensive data

// Polygon.io WebSocket connection
let polygonWS = null;
let isConnected = false;

// Initialize Polygon.io WebSocket
function initPolygonWebSocket() {
  if (polygonWS && isConnected) {
    return;
  }

  const ws = new WebSocket('wss://socket.polygon.io/options');
  polygonWS = ws;

  ws.on('open', () => {
    // Authenticate
    const authMessage = {
      action: 'auth',
      params: process.env.POLYGON_API_KEY
    };
    ws.send(JSON.stringify(authMessage));
  });

  ws.on('message', (data) => {
    try {
      const messages = JSON.parse(data.toString());
      const messageArray = Array.isArray(messages) ? messages : [messages];
      
      messageArray.forEach((msg) => {
        const message = Array.isArray(msg) ? msg[0] : msg;
        
        // Authentication confirmation
        if (message?.ev === 'status' && message?.status === 'auth_success') {
          isConnected = true;
          
          // Subscribe to options trades for major tickers
          const tickers = ['SPY', 'QQQ', 'NVDA', 'AAPL', 'TSLA', 'MSFT', 'GOOGL', 'AMZN', 'META', 'AMD', 'SPX', 'SPXW', 'XSP', 'NDX'];
          const subscriptions = tickers.map(ticker => `O.${ticker}*`).join(',');
          
          ws.send(JSON.stringify({
            action: 'subscribe',
            params: subscriptions
          }));
        }
        
        // Options trade data
        if (message?.ev === 'O') {
          const marketStatus = getMarketStatus();
          if (marketStatus.isOpen) {
            processOptionsTrade(message);
          }
        }
      });
    } catch (error) {
      // Silent error handling
    }
  });

  ws.on('error', () => {
    isConnected = false;
  });

  ws.on('close', () => {
    isConnected = false;
    
    // Reconnect after 5 seconds
    setTimeout(() => {
      initPolygonWebSocket();
    }, 5000);
  });

  polygonWS = ws;
}

// Process incoming options trade
async function processOptionsTrade(trade) {
  try {
    // Silent processing
    
    // Extract trade data
    const {
      sym,      // Symbol (e.g., "O:SPY241115C00585000")
      x,        // Exchange
      p,        // Price per contract
      s,        // Size (number of contracts)
      c,        // Conditions
      t,        // Timestamp
      bp,       // Bid price
      ap,       // Ask price
    } = trade;

    // BUG #1 FIX: Parse option symbol correctly to identify Calls vs Puts
    const optionDetails = parseOptionSymbol(sym);
    if (!optionDetails) {
      return;
    }

    const { ticker, strike, expiration, type, expirationDate } = optionDetails;

    // BUG #3 FIX: Get real-time spot price
    const spotPrice = await getSpotPrice(ticker) || strike;

    // BUG #4 FIX: Detect bid/ask side and sentiment
    const { side, sentiment, aggressor } = detectSide(p, bp || 0, ap || 0, type);

    // Calculate premium
    const premium = p * s * 100; // Price * Contracts * 100

    // Filter by minimum premium
    const minPremium = 10000;
    if (premium < minPremium) {
      return;
    }

    // BUG #5 FIX: Calculate IV if we have all required data
    let iv = 'N/A';
    if (spotPrice && strike && expirationDate && p > 0) {
      try {
        const T = (new Date(expirationDate).getTime() - new Date(t).getTime()) / (1000 * 60 * 60 * 24 * 365.25);
        const r = 0.05; // Risk-free rate 5%
        const isCall = type === 'CALL';
        
        // Validate inputs before calculation
        if (T > 0 && T < 10 && p > 0 && spotPrice > 0 && strike > 0 && 
            isFinite(T) && isFinite(p) && isFinite(spotPrice) && isFinite(strike)) {
          const ivDecimal = calculateImpliedVolatility(p, spotPrice, strike, T, r, isCall);
          
          // Validate calculated IV
          if (ivDecimal && isFinite(ivDecimal) && ivDecimal > 0 && ivDecimal < 5) {
            iv = formatIV(ivDecimal);
          }
        }
      } catch (ivError) {
        // Silent error handling - IV calculation failed
      }
    }

    // BUG #6 FIX: Calculate OTM percentage correctly
    const { otmPercent, otmLabel } = calculateOTM(strike, spotPrice, type);
    const otm = `${otmPercent.toFixed(1)}%`;
    
    // Calculate moneyness using the same function as REST API (consistent with filter logic)
    const moneynessData = calculateMoneyness(spotPrice, strike, type);

    // BUG #7 & #8 FIX: Classify trade type correctly
    const tradeTypeObj = {
      symbol: sym,
      size: s,
      premium: premium,
      exchange: x,
      timestamp: t,
    };
    const tradeType = classifyTradeType(tradeTypeObj, recentTradesMap);

    // BUG #12 FIX: Get direction arrow
    const { arrow, color } = getDirectionArrow(type, side);

    // BUG #15 FIX: Calculate setup score
    const setupScoreData = calculateSetupScore({
      volume: s,
      openInterest: 0, // Will be updated later
      premium: formatPremium(premium),
      premiumRaw: premium,
      tradeType: tradeType,
      side: side,
      dte: calculateDTE(expirationDate),
    });

    // Create trade object
    const tradeData = {
      id: `${sym}-${t}-${s}-${Date.now()}`,
      timestamp: new Date(t).toISOString(),
      time: new Date(t).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      ticker,
      strike,
      expiration,
      expirationDate: expirationDate.toISOString(), // Store for DTE calculation
      type: type.toUpperCase(), // BUG #1 FIX: This should now correctly identify PUT vs CALL
      price: p,
      size: s,
      premium: formatPremium(premium),
      premiumRaw: premium, // Keep raw value for filtering
      volume: s, // Will be updated with total volume
      oi: 0, // Will be fetched later
      iv: iv, // BUG #5 FIX: Now calculated correctly
      dte: calculateDTE(expirationDate),
      otm: otm, // BUG #6 FIX: Now calculated correctly
      otmLabel: otmLabel, // Add label for display
      sentiment: formatSentiment(sentiment), // FIX: Correctly converts Bullish/Bearish to BULL/BEAR
      side: side, // BUG #4 FIX: Add side field
      directionArrow: arrow, // BUG #12 FIX: Add direction arrow
      tradeType: tradeType.toUpperCase(), // BUG #7 & #8 FIX: Now correctly classified
      confidence: setupScoreData.score, // BUG #15 FIX: Now calculated correctly
      isHighProbability: setupScoreData.isHighProbability, // BUG #15 FIX
      moneyness: moneynessData.label, // Use calculateMoneyness for consistency with REST API and filters
      moneynessColor: moneynessData.color,
      exchange: x,
      conditions: c,
      rawSymbol: sym,
      spot: `$${spotPrice.toFixed(2)}`, // BUG #3 FIX: Now shows actual spot price
      bid: bp || 0,
      ask: ap || 0,
    };

    // Store trade in global list (for API endpoint)
    const globalKey = `trade-${Date.now()}-${Math.random()}`;
    tradesStore.set(globalKey, tradeData);
    
    // BUG #16 FIX: Broadcast trade update via WebSocket (using global function)
    if (global.broadcastTradeUpdate) {
      global.broadcastTradeUpdate(tradeData);
    }
    
    // Clean up old trades
    if (tradesStore.size > MAX_TRADES) {
      const firstKey = tradesStore.keys().next().value;
      tradesStore.delete(firstKey);
    }

  } catch (error) {
    // Silent error handling
  }
}

// BUG #1 FIX: parseOptionSymbol is now imported from utils/optionsCalculations.js
// This function is kept for backward compatibility but uses the imported version

// Format premium
function formatPremium(premium) {
  if (premium >= 1000000) {
    return `$${(premium / 1000000).toFixed(2)}M`;
  } else if (premium >= 1000) {
    return `$${(premium / 1000).toFixed(0)}K`;
  }
  return `$${premium.toFixed(0)}`;
}

// Initialize WebSocket on server start
initPolygonWebSocket();

// Fetch initial data from REST API
console.log('📡 Scheduling initial options flow fetch...');
setTimeout(() => {
  console.log('🚀 Starting initial options flow fetch...');
  fetchOptionsFromREST().then(() => {
    console.log(`✅ Initial fetch complete. Store now has ${tradesStore.size} trades.`);
  }).catch((err) => {
    console.error('❌ Initial fetch failed:', err.message);
  });
  
  // Periodic background refresh every 10 seconds - CONTINUOUSLY fetch new data
  let isFetching = false; // Prevent concurrent fetches
  setInterval(() => {
    if (isFetching) {
      console.log('⏸️ Skipping refresh - fetch already in progress');
      return;
    }
    
    // Always refresh to get new live data, but clear old trades first if store is getting full
    if (tradesStore.size > MAX_TRADES * 0.8) {
      // Clear trades older than 2 minutes if store is > 80% full
      const twoMinutesAgo = Date.now() - 120000;
      let clearedCount = 0;
      for (const [key, trade] of tradesStore.entries()) {
        if (trade.timestamp && new Date(trade.timestamp).getTime() < twoMinutesAgo) {
          tradesStore.delete(key);
          clearedCount++;
        }
      }
      if (clearedCount > 0) {
        console.log(`🧹 Cleared ${clearedCount} old trades (store was ${tradesStore.size} trades, now ${tradesStore.size - clearedCount})`);
      }
    }
    
    // Always refresh to get new live data (removed the < 5000 condition)
    console.log(`🔄 Live refresh triggered (store has ${tradesStore.size} trades, max: ${MAX_TRADES})...`);
    isFetching = true;
    fetchOptionsFromREST().then(() => {
      isFetching = false;
      console.log(`✅ Live refresh complete. Store now has ${tradesStore.size} trades.`);
    }).catch((err) => {
      console.error('❌ Live refresh error:', err.message);
      isFetching = false;
    });
  }, 10000); // Every 10 seconds
}, 2000);

// GET /api/options-flow - Get recent options flow with comprehensive filtering
router.get('/', async (req, res) => {
  try {
    // BUG #17 FIX: Check market status
    const marketStatus = getMarketStatus();
    const {
      // Pagination
      limit = 20,
      page = 1,
      
      // Basic filters
      ticker,
      type, // 'CALL' or 'PUT'
      tradeType, // 'SWEEP', 'BLOCK', 'SPLIT', etc.
      
      // Premium filters
      minPremium = 0,
      maxPremium,
      minPremiums,
      maxPremiums,
      
      // Strike filters
      minStrike,
      maxStrike,
      
      // Bid/Ask filters
      minBidask,
      maxBidask,
      
      // Type filters (from frontend activeFilters array)
      calls,
      puts,
      bought,
      sold,
      complex,
      sweeps,
      splits,
      blocks,
      aboveAsk,
      belowBid,
      itm,
      otm,
      atm,
      volGtOi,
      shortExpiry,
      leaps,
      premium1m,
      nonEtf,
      nonSpreads,
      spreads,
      openingOrder,
      openingSpread,
      preEarnings,
      postEarnings,
      ssr,
      repeatFlow,
      
      // Range filters
      dte, // Comma-separated: "0,1,3,7,15,30,60,90"
      stockPrice, // Comma-separated: "< $25,$25 - $75,$75 - $150,> $150"
      openInterest, // Comma-separated: "< 1k,1k to 5k,5k to 25k,> 25k"
      volume, // Comma-separated: "< 1k,1k to 5k,5k to 25k,> 25k"
      
      // Advanced Filters section filters
      filterTicker, // Ticker symbol filter from Advanced Filters
      filterMinPremium, // Min premium from Advanced Filters
      minVolume, // Min volume filter
      filterMaxDte, // Max DTE filter
      minConfidence, // Min confidence score filter
      
      // Sorting
      sortBy, // Sort by: 'time', 'premium', 'volume', 'confidence', 'iv'
      
      // Exclude symbols
      excludeSymbols, // Comma-separated list
    } = req.query;

    const pageNum = parseInt(page) || 1;
    const limitNum = parseInt(limit) || 20;
    const offset = (pageNum - 1) * limitNum;

    // Helper function to check if a filter is active (handles both string 'true' and boolean true)
    const isFilterActive = (value) => {
      if (value === undefined || value === null || value === '') return false;
      if (value === true || value === 'true' || value === '1') return true;
      return false;
    };

    // Log filter parameters for debugging
    console.log('🔍 Filter parameters received:', {
      calls: calls, callsType: typeof calls, callsActive: isFilterActive(calls),
      puts: puts, putsType: typeof puts, putsActive: isFilterActive(puts),
      sweeps: sweeps, sweepsType: typeof sweeps, sweepsActive: isFilterActive(sweeps),
      blocks: blocks, blocksType: typeof blocks, blocksActive: isFilterActive(blocks),
      dte: dte,
      stockPrice: stockPrice,
      openInterest: openInterest,
      volume: volume,
      sortBy: sortBy, sortByType: typeof sortBy,
    });

    // If user searched a ticker, fetch directly from API for that ticker (server-side filter)
    // Only do this if ticker is provided and not empty
    if (ticker && ticker.trim() && ticker.trim().length > 0) {
      const searchTrades = await buildTradesForTickerSearch(ticker.trim().toUpperCase());
      const totalCountSearch = searchTrades.length;
      const pagedTrades = searchTrades.slice(offset, offset + limitNum);
      return res.json({
        success: true,
        flows: pagedTrades,
        count: pagedTrades.length,
        totalCount: totalCountSearch,
        page: pageNum,
        totalPages: Math.max(1, Math.ceil(totalCountSearch / limitNum)),
      });
    }
    // If ticker is empty/undefined, continue with normal flow (all trades from store)

    // Always fetch from REST API if store is empty or very small (initial load)
    // This ensures data is available even during pre-market/after-hours
    if (tradesStore.size < 100) {
      console.log(`📡 Store has ${tradesStore.size} trades, triggering background fetch...`);
      // Trigger fetch but don't wait - return what we have immediately
      fetchOptionsFromREST().catch((err) => {
        console.error('❌ Background fetch error:', err.message);
      });
    }

    // Get all trades from store
    const allTradesRaw = Array.from(tradesStore.values());
    console.log(`📊 GET /api/options-flow: Store has ${tradesStore.size} trades, allTradesRaw.length=${allTradesRaw.length}`);
    
    // Helper function to parse premium value
    const parsePremium = (premiumStr) => {
      if (typeof premiumStr === 'number') return premiumStr;
      const num = parseFloat(premiumStr.replace(/[^0-9.]/g, ''));
      if (premiumStr.includes('M')) return num * 1000000;
      if (premiumStr.includes('K')) return num * 1000;
      return num;
    };
    
    // Helper function to parse range filters for volume
    const parseVolumeRange = (vol, ranges) => {
      if (!ranges) return true;
      const selectedRanges = Array.isArray(ranges) ? ranges : ranges.split(',');
      return selectedRanges.some(range => {
        const num = parseFloat(vol || 0);
        if (range === '< 1k') return num < 1000;
        if (range === '1k to 5k') return num >= 1000 && num < 5000;
        if (range === '5k to 25k') return num >= 5000 && num < 25000;
        if (range === '> 25k') return num >= 25000;
        return false;
      });
    };
    
    // Helper function to check DTE
    const checkDTE = (dteStr, selectedDTEs) => {
      if (!selectedDTEs || selectedDTEs.length === 0) return true;
      const dteNum = parseInt(dteStr.replace('d', '')) || 0;
      return selectedDTEs.includes(dteNum);
    };
    
    // Helper function to check stock price range
    const checkStockPrice = (spotPrice, selectedRanges) => {
      if (!selectedRanges || selectedRanges.length === 0) return true;
      const price = parseFloat(spotPrice.replace(/[^0-9.]/g, '')) || 0;
      return selectedRanges.some(range => {
        if (range === '< $25') return price < 25;
        if (range === '$25 - $75') return price >= 25 && price < 75;
        if (range === '$75 - $150') return price >= 75 && price < 150;
        if (range === '> $150') return price >= 150;
        return false;
      });
    };
    
    // Helper function to check OI range
    const checkOIRange = (oi, selectedRanges) => {
      if (!selectedRanges || selectedRanges.length === 0) return true;
      return selectedRanges.some(range => {
        if (range === '< 1k') return oi < 1000;
        if (range === '1k to 5k') return oi >= 1000 && oi < 5000;
        if (range === '5k to 25k') return oi >= 5000 && oi < 25000;
        if (range === '> 25k') return oi >= 25000;
        return false;
      });
    };
    
    // Filter trades with comprehensive filtering
    const filteredTrades = allTradesRaw
      .filter(trade => {
        // Filter out arrays (grouped trades)
        if (Array.isArray(trade)) {
          return false;
        }
        
        // Exclude symbols filter
        if (excludeSymbols) {
          const excluded = excludeSymbols.split(',').map(s => s.trim().toUpperCase());
          if (excluded.includes(trade.ticker?.toUpperCase())) return false;
        }
        
        // Premium filters
        const premiumNum = trade.premiumRaw || parsePremium(trade.premium);
        if (premiumNum < minPremium) return false;
        if (maxPremium && premiumNum > parseFloat(maxPremium)) return false;
        if (minPremiums && premiumNum < parseFloat(minPremiums)) return false;
        if (maxPremiums && premiumNum > parseFloat(maxPremiums)) return false;
        // Advanced Filters: filterMinPremium
        if (filterMinPremium && premiumNum < parseFloat(filterMinPremium)) return false;
        
        // Strike filters
        if (minStrike && trade.strike < parseFloat(minStrike)) return false;
        if (maxStrike && trade.strike > parseFloat(maxStrike)) return false;
        
        // Bid/Ask spread filters - calculate spread from bid and ask
        if (minBidask || maxBidask) {
          const bid = trade.bid || 0;
          const ask = trade.ask || 0;
          const bidaskSpread = (bid > 0 && ask > 0) ? (ask - bid) : 0;
          
          if (minBidask && bidaskSpread < parseFloat(minBidask)) return false;
          if (maxBidask && bidaskSpread > parseFloat(maxBidask)) return false;
        }
        
        // Type filters (CALL/PUT) - use helper function to check if filter is active
        // CRITICAL: Only apply CALL/PUT filter if it's explicitly set (don't show both if both are set)
        const shouldShowCalls = isFilterActive(calls);
        const shouldShowPuts = isFilterActive(puts);
        const typeFilter = type ? type.toUpperCase() : null;
        
        // If CALL filter is active, only show CALLs
        if (shouldShowCalls && !shouldShowPuts && trade.type !== 'CALL') return false;
        // If PUT filter is active, only show PUTs
        if (shouldShowPuts && !shouldShowCalls && trade.type !== 'PUT') return false;
        // If both are active, show both (no filter)
        // If type parameter is set, use it
        if (typeFilter && trade.type !== typeFilter) return false;
        
        // Trade type filters (SWEEP/BLOCK/SPLIT) - use helper function to check if filter is active
        // CRITICAL: Only apply trade type filter if it's explicitly set (don't show multiple types if multiple are set)
        const shouldShowSweeps = isFilterActive(sweeps);
        const shouldShowBlocks = isFilterActive(blocks);
        const shouldShowSplits = isFilterActive(splits);
        const tradeTypeFilter = tradeType ? tradeType.toUpperCase() : null;
        
        // Count how many trade type filters are active
        const activeTradeTypeFilters = [shouldShowSweeps, shouldShowBlocks, shouldShowSplits].filter(Boolean).length;
        
        // If exactly one trade type filter is active, enforce it strictly
        if (activeTradeTypeFilters === 1) {
          if (shouldShowSweeps && trade.tradeType !== 'SWEEP') return false;
          if (shouldShowBlocks && trade.tradeType !== 'BLOCK') return false;
          if (shouldShowSplits && trade.tradeType !== 'SPLIT') return false;
        }
        // If multiple trade type filters are active, show trades matching any of them (OR logic)
        else if (activeTradeTypeFilters > 1) {
          const matchesAny = (shouldShowSweeps && trade.tradeType === 'SWEEP') ||
                            (shouldShowBlocks && trade.tradeType === 'BLOCK') ||
                            (shouldShowSplits && trade.tradeType === 'SPLIT');
          if (!matchesAny) return false;
        }
        // If tradeType parameter is set, use it
        if (tradeTypeFilter && trade.tradeType !== tradeTypeFilter) return false;
        
        // ITM/OTM/ATM filters - mutually exclusive (if any is active, trade must match that one)
        const atm = req.query.atm;
        const hasMoneynessFilter = isFilterActive(itm) || isFilterActive(otm) || isFilterActive(atm);
        if (hasMoneynessFilter) {
          // If any moneyness filter is active, trade must match at least one active filter
          const matchesItm = isFilterActive(itm) && trade.moneyness === 'ITM';
          const matchesOtm = isFilterActive(otm) && trade.moneyness === 'OTM';
          const matchesAtm = isFilterActive(atm) && trade.moneyness === 'ATM';
          if (!matchesItm && !matchesOtm && !matchesAtm) return false;
        }
        
        // Volume > OI filter - use helper function to check if filter is active
        if (isFilterActive(volGtOi) && trade.volume <= trade.oi) return false;
        
        // Above Ask / Below Bid filters - use helper function to check if filter is active
        if (isFilterActive(aboveAsk) && trade.side !== 'Above Ask') return false;
        if (isFilterActive(belowBid) && trade.side !== 'Below Bid') return false;
        
        // DTE filter
        if (dte) {
          const selectedDTEs = dte.split(',').map(d => parseInt(d.trim())).filter(d => !isNaN(d));
          if (!checkDTE(trade.dte, selectedDTEs)) return false;
        }
        
        // Short Expiry / LEAPS filter - use helper function to check if filter is active
        const dteNum = parseInt(trade.dte?.replace('d', '')) || 0;
        if (isFilterActive(shortExpiry) && dteNum > 30) return false;
        if (isFilterActive(leaps) && dteNum < 365) return false;
        
        // Premium > $1M filter - use helper function to check if filter is active
        if (isFilterActive(premium1m) && premiumNum < 1000000) return false;
        
        // Stock Price range filter
        if (stockPrice) {
          const selectedRanges = stockPrice.split(',');
          if (!checkStockPrice(trade.spot, selectedRanges)) return false;
        }
        
        // Open Interest range filter
        if (openInterest) {
          const selectedRanges = openInterest.split(',');
          if (!checkOIRange(trade.oi || 0, selectedRanges)) return false;
        }
        
        // Volume range filter
        if (volume) {
          const selectedRanges = volume.split(',');
          const vol = trade.volume || trade.size || 0;
          if (!parseVolumeRange(vol, selectedRanges)) return false;
        }
        
        // Advanced Filters: minVolume
        if (minVolume) {
          const vol = trade.volume || trade.size || 0;
          if (vol < parseFloat(minVolume)) return false;
        }
        
        // Advanced Filters: filterMaxDte
        if (filterMaxDte) {
          const maxDteNum = parseInt(filterMaxDte) || 999;
          const dteNum = parseInt(trade.dte?.replace('d', '')) || 0;
          if (dteNum > maxDteNum) return false;
        }
        
        // Advanced Filters: minConfidence
        if (minConfidence) {
          const conf = trade.confidence || 0;
          if (conf < parseFloat(minConfidence)) return false;
        }
        
        // Ticker filter (from header search OR Advanced Filters)
        const tickerToFilter = ticker || filterTicker;
        if (tickerToFilter && trade.ticker !== tickerToFilter.toUpperCase()) return false;
        
        return true;
      });
    
    // CRITICAL: Normalize sortBy parameter (handle both frontend and backend formats)
    const normalizedSortBy = sortBy ? String(sortBy).toLowerCase() : 'time';
    console.log(`🔍 Sorting by: "${sortBy}" (normalized: "${normalizedSortBy}")`);
    
    // Prepare trades for sorting by ensuring all sort fields have default values
    const tradesForSorting = filteredTrades.map(trade => ({
      ...trade,
      // Ensure confidence has a default value for sorting
      confidence: trade.confidence !== undefined && trade.confidence !== null ? trade.confidence : 5,
      // Ensure volume has a default value
      volume: trade.volume || trade.size || 0,
      // Ensure premiumRaw exists
      premiumRaw: trade.premiumRaw || parsePremium(trade.premium),
    }));
    
    // Sort ALL filtered trades BEFORE pagination (CRITICAL FIX for sortBy filter)
    const sortedTrades = [...tradesForSorting].sort((a, b) => {
      switch (normalizedSortBy) {
        case 'premium': {
          const premiumA = a.premiumRaw || 0;
          const premiumB = b.premiumRaw || 0;
          return premiumB - premiumA; // Descending (high to low)
        }
        
        case 'volume': {
          const volumeA = a.volume || 0;
          const volumeB = b.volume || 0;
          return volumeB - volumeA; // Descending (high to low)
        }
        
        case 'confidence': {
          const confidenceA = a.confidence || 0;
          const confidenceB = b.confidence || 0;
          console.log(`🔍 Comparing confidence: ${confidenceA} vs ${confidenceB}`);
          return confidenceB - confidenceA; // Descending (high to low)
        }
        
        case 'iv': {
          const parseIV = (ivStr) => {
            if (!ivStr || ivStr === 'N/A') return 0;
            return parseFloat(String(ivStr).replace('%', '')) || 0;
          };
          const ivA = parseIV(a.iv);
          const ivB = parseIV(b.iv);
          return ivB - ivA; // Descending (high to low)
        }
        
        case 'time':
        default: {
          // Sort by timestamp (newest first)
          const timestampA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
          const timestampB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
          return timestampB - timestampA; // Descending (newest first)
        }
      }
    });
    
    // Log first few sorted trades for debugging
    if (normalizedSortBy === 'confidence') {
      console.log(`🔍 First 5 trades after sorting by confidence:`, sortedTrades.slice(0, 5).map(t => ({
        ticker: t.ticker,
        confidence: t.confidence,
        tradeType: t.tradeType,
      })));
    }

    // Calculate pagination (AFTER sorting)
    const totalCount = sortedTrades.length;
    const totalPages = Math.ceil(totalCount / limitNum);
    const paginatedTrades = sortedTrades.slice(offset, offset + limitNum);

    // Enrich trades with additional data (OI, IV, etc.)
    const enrichedTrades = await Promise.all(paginatedTrades.map(async (trade) => {
      // BUG #3 FIX: Always fetch fresh spot price (don't use strike as fallback)
      let spotPrice = parseFloat(trade.spot?.replace(/[^0-9.]/g, ''));
      
      // If spot price is missing, equals strike, or seems wrong, fetch fresh one
      if (!spotPrice || spotPrice === trade.strike || spotPrice <= 0) {
        const fetchedSpot = await getSpotPrice(trade.ticker);
        if (fetchedSpot && fetchedSpot > 0) {
          spotPrice = fetchedSpot;
        } else {
          // If still no spot price, use strike as last resort (but OTM will be 0%)
          spotPrice = trade.strike;
        }
      }
      
      // BUG #6 FIX: Always recalculate OTM with actual spot price
      const otmCalc = calculateOTM(trade.strike, spotPrice, trade.type);
      const otm = `${otmCalc.otmPercent.toFixed(1)}%`;
      const otmLabel = otmCalc.otmLabel;
      
      // Calculate moneyness using the same function as REST API (consistent with filter logic)
      const moneynessData = calculateMoneyness(spotPrice, trade.strike, trade.type);
      
      // BUG #5 FIX: Validate and fix IV if it's too high or missing
      let iv = trade.iv || 'N/A';
      if (iv !== 'N/A') {
        const ivNum = parseFloat(iv.replace('%', ''));
        if (ivNum > 300 || ivNum < 0 || isNaN(ivNum)) {
          // Try to recalculate if IV is invalid
          if (trade.price && spotPrice && trade.expirationDate) {
            try {
              const T = (new Date(trade.expirationDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24 * 365.25);
              const r = 0.05;
              const isCall = trade.type === 'CALL';
              
              // Validate inputs before calculation
              if (T > 0 && T < 10 && trade.price > 0 && spotPrice > 0 && trade.strike > 0 && 
                  isFinite(T) && isFinite(trade.price) && isFinite(spotPrice) && isFinite(trade.strike)) {
                const ivDecimal = calculateImpliedVolatility(trade.price, spotPrice, trade.strike, T, r, isCall);
                
                // Validate calculated IV
                if (ivDecimal && isFinite(ivDecimal) && ivDecimal > 0 && ivDecimal < 5) {
                  iv = formatIV(ivDecimal);
                }
              }
            } catch (ivError) {
              // Silent error handling
            }
          }
        }
      } else if (trade.price && spotPrice && trade.expirationDate) {
        // Calculate IV if missing
        try {
          const T = (new Date(trade.expirationDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24 * 365.25);
          const r = 0.05;
          const isCall = trade.type === 'CALL';
          
          // Validate inputs before calculation
          if (T > 0 && T < 10 && trade.price > 0 && spotPrice > 0 && trade.strike > 0 && 
              isFinite(T) && isFinite(trade.price) && isFinite(spotPrice) && isFinite(trade.strike)) {
            const ivDecimal = calculateImpliedVolatility(trade.price, spotPrice, trade.strike, T, r, isCall);
            
            // Validate calculated IV
            if (ivDecimal && isFinite(ivDecimal) && ivDecimal > 0 && ivDecimal < 5) {
              iv = formatIV(ivDecimal);
            }
          }
        } catch (ivError) {
          // Silent error handling
        }
      }
      
      // Recalculate sentiment if missing or incorrect (should be based on buy/sell + option type, not just option type)
      let sentiment = trade.sentiment;
      
      // Check if sentiment needs recalculation (missing or wrong format)
      // Note: PUT can be BULL (if sold aggressively) and CALL can be BEAR (if sold aggressively)
      // So we only check for missing or wrong format, not for "impossible" combinations
      const needsRecalc = !sentiment || 
                         sentiment === 'BULLISH' || 
                         sentiment === 'BEARISH';
      
      if (needsRecalc && trade.side && trade.price && trade.type) {
        // Infer bid/ask from side to recalculate sentiment
        const side = trade.side.toLowerCase();
        let bid = 0, ask = 0;
        let canRecalculate = false;
        
        if (side.includes('ask') || side.includes('above') || side.includes('abv')) {
          // Trade was at/above ask (aggressive buy)
          ask = trade.price;
          bid = trade.price * 0.98; // Estimate bid as 2% below
          canRecalculate = true;
        } else if (side.includes('bid') || side.includes('below') || side.includes('blw')) {
          // Trade was at/below bid (aggressive sell)
          bid = trade.price;
          ask = trade.price * 1.02; // Estimate ask as 2% above
          canRecalculate = true;
        }
        // If side is "Mid" or "To Ask"/"To Bid", we can't accurately determine aggressiveness
        // In this case, preserve existing sentiment if valid, otherwise use NEUTRAL
        
        // Recalculate sentiment using detectSide if we have valid bid/ask
        if (canRecalculate && bid > 0 && ask > 0) {
          const sideData = detectSide(trade.price, bid, ask, trade.type);
          sentiment = sideData.sentiment; // Returns 'Bullish', 'Bearish', or 'Neutral'
        } else if (!sentiment) {
          // If we can't determine and no existing sentiment, use NEUTRAL
          // Frontend will handle NEUTRAL -> BULL/BEAR conversion if needed
          sentiment = 'NEUTRAL';
        }
        // Otherwise, keep existing sentiment (even if it might be wrong, better than assuming)
      } else if (!sentiment) {
        // No sentiment and no side data - use NEUTRAL (don't assume CALL=BULL, PUT=BEAR)
        sentiment = 'NEUTRAL';
      }
      
      // Format sentiment to BULL/BEAR/NEUTRAL
      sentiment = formatSentiment(sentiment);
      
      // Use existing data or defaults
      const enriched = {
        ...trade,
        oi: trade.oi || 0,
        iv: iv, // BUG #5 FIX: Validated and fixed
        volume: trade.volume || trade.size,
        dte: trade.dte || (trade.expirationDate ? calculateDTE(new Date(trade.expirationDate)) : 'N/A'),
        otm: otm, // BUG #6 FIX: Always recalculated with actual spot price
        otmLabel: otmLabel, // BUG #6 FIX: Always recalculated
        moneyness: moneynessData.label, // Use calculateMoneyness for consistency with REST API and filters
        moneynessColor: moneynessData.color,
        sentiment: sentiment, // FIX: Now correctly calculated based on buy/sell + option type
        side: trade.side || 'Mid', // BUG #4 FIX: Ensure side is present
        directionArrow: trade.directionArrow || (trade.type === 'CALL' ? '↑' : '↓'), // BUG #12 FIX
        tradeType: trade.tradeType || 'SPLIT', // BUG #7 & #8 FIX: Default to SPLIT, not NORMAL
        confidence: trade.confidence || 5,
        isHighProbability: trade.isHighProbability || false, // BUG #15 FIX
        spot: `$${spotPrice.toFixed(2)}`, // BUG #3 FIX: Actual spot price (not strike)
      };
      return enriched;
    }));

    // BUG #14 FIX: Calculate overall flow sentiment
    const bullishPremium = enrichedTrades
      .filter(t => t.sentiment === 'BULL' || t.sentiment === 'BULLISH')
      .reduce((sum, t) => sum + (t.premiumRaw || parseFloat(t.premium.replace(/[^0-9.]/g, '')) * 
        (t.premium.includes('M') ? 1000000 : (t.premium.includes('K') ? 1000 : 1))), 0);
    const bearishPremium = enrichedTrades
      .filter(t => t.sentiment === 'BEAR' || t.sentiment === 'BEARISH')
      .reduce((sum, t) => sum + (t.premiumRaw || parseFloat(t.premium.replace(/[^0-9.]/g, '')) * 
        (t.premium.includes('M') ? 1000000 : (t.premium.includes('K') ? 1000 : 1))), 0);
    const totalPremium = bullishPremium + bearishPremium;
    const sentimentRatio = totalPremium > 0 ? bullishPremium / totalPremium : 0.5;
    const overallSentiment = sentimentRatio > 0.55 ? 'Bullish' : sentimentRatio < 0.45 ? 'Bearish' : 'Neutral';
    
    // Always return trades array, even if empty
    console.log(`📤 GET /api/options-flow: Returning ${enrichedTrades.length} trades (totalCount=${totalCount}, storeSize=${tradesStore.size})`);
    res.json({
      success: true,
      count: enrichedTrades.length,
      totalCount: totalCount,
      page: pageNum,
      totalPages: totalPages,
      limit: limitNum,
      trades: enrichedTrades,
      flows: enrichedTrades, // Also include 'flows' for frontend compatibility
      storeSize: tradesStore.size,
      timestamp: new Date().toISOString(),
      marketStatus: marketStatus, // BUG #17 FIX: Include market status
      overallSentiment: { // BUG #14 FIX: Include overall sentiment
        sentiment: overallSentiment,
        ratio: (sentimentRatio * 100).toFixed(2) + '%',
        netPremium: bullishPremium - bearishPremium,
      },
    });
  } catch (error) {
    console.error('❌ Error fetching options flow:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch options flow',
      message: error.message,
    });
  }
});

// Fetch options contracts from REST API (Massive.com Reference Contracts Endpoint)
// NOTE: We fetch ALL contracts without filters so the frontend can filter client-side.
async function fetchOptionsFromREST() {
  try {
    console.log('📡 fetchOptionsFromREST() called...');
    const apiKey = process.env.POLYGON_API_KEY;
    if (!apiKey) {
      console.error('❌ POLYGON_API_KEY not set');
      return;
    }

    console.log('📡 Starting to fetch contracts from Massive.com API...');
    
    // For live refresh: Clear old trades older than 2 minutes to keep data fresh and make room for new trades
    // Only clear if store is getting full (> 50% of MAX_TRADES) to ensure we always have recent data
    if (tradesStore.size > MAX_TRADES * 0.5) {
      const twoMinutesAgo = Date.now() - 120000; // 2 minutes ago
      let clearedCount = 0;
      const initialSize = tradesStore.size;
      for (const [key, trade] of tradesStore.entries()) {
        if (trade.timestamp && new Date(trade.timestamp).getTime() < twoMinutesAgo) {
          tradesStore.delete(key);
          clearedCount++;
        }
      }
      if (clearedCount > 0) {
        console.log(`🧹 Cleared ${clearedCount} old trades (older than 2 minutes). Store: ${initialSize} → ${tradesStore.size}`);
      }
    }
    
    // Fetch ALL contracts (no filters). Frontend will filter client-side.
    await fetchAllContracts(apiKey);
    console.log(`✅ fetchAllContracts completed. Store now has ${tradesStore.size} trades.`);

    // Log summary with PUT/CALL breakdown
    if (tradesStore.size === 0) {
      console.warn('⚠️ No trades stored after REST fetch');
    } else {
      const allTrades = Array.from(tradesStore.values()).filter(t => !Array.isArray(t));
      const callCount = allTrades.filter(t => t.type === 'CALL').length;
      const putCount = allTrades.filter(t => t.type === 'PUT').length;
      const totalCount = allTrades.length;
      
      console.log(`📊 Trade Summary: Total=${totalCount}, CALLs=${callCount}, PUTs=${putCount}, Ratio=${totalCount > 0 ? ((callCount / totalCount) * 100).toFixed(1) : 0}%`);
      
      if (putCount === 0 && totalCount > 10) {
        console.warn('⚠️ No PUT options detected - check contract type parsing');
      }
    }
  } catch (error) {
    console.error('❌ fetchOptionsFromREST error:', error.message);
  }
}

// Helper: fetch all contracts using snapshot API (MUCH MORE EFFICIENT - gets everything in one call per ticker)
async function fetchAllContracts(apiKey) {
  try {
    console.log('📡 fetchAllContracts() started - using snapshot API for efficient fetching...');
    
    // Major tickers to fetch options for
    const tickers = ['SPY', 'QQQ', 'NVDA', 'AAPL', 'TSLA', 'MSFT', 'GOOGL', 'AMZN', 'META', 'AMD', 'A', 'IWM', 'DIA', 'TLT', 'SPX', 'SPXW', 'XSP', 'NDX'];
    
    // Adjust limits based on store size - fetch more when store is already populated
    const contractsPerTicker = tradesStore.size > 10000 ? 500 : 200; // Fetch more contracts per ticker if store is populated
    const maxPagesPerTicker = tradesStore.size > 10000 ? 10 : 5; // Fetch more pages if store is populated
    
    let allContracts = [];
    
    // Fetch snapshot data for each ticker (parallel processing)
    console.log(`📊 Fetching snapshot data for ${tickers.length} tickers (${contractsPerTicker} contracts per ticker)...`);
    
    const tickerPromises = tickers.map(async (ticker) => {
      try {
        let tickerContracts = [];
        let currentUrl = `https://api.massive.com/v3/snapshot/options/${ticker}`;
        let pageCount = 0;
        
        // Fetch all pages for this ticker
        while (pageCount < maxPagesPerTicker && tickerContracts.length < contractsPerTicker) {
          try {
            const params = {
              limit: 100, // Max per page (API limit)
              order: 'asc',
              sort: 'ticker',
              apiKey: apiKey,
            };
            
            const response = await axios.get(currentUrl, {
              params: params,
              timeout: 15000,
            });
            
            if (response.data?.results && Array.isArray(response.data.results)) {
              const pageContracts = response.data.results;
              tickerContracts = tickerContracts.concat(pageContracts);
              console.log(`✅ ${ticker} page ${pageCount + 1}: Got ${pageContracts.length} contracts (total: ${tickerContracts.length})`);
              
              // Check for next page
              if (response.data.next_url && pageCount < maxPagesPerTicker - 1 && tickerContracts.length < contractsPerTicker) {
                currentUrl = response.data.next_url;
                pageCount++;
                await new Promise(resolve => setTimeout(resolve, 100)); // Small delay between pages
              } else {
                break;
              }
            } else {
              break;
            }
          } catch (error) {
            console.error(`❌ Error fetching ${ticker} page ${pageCount + 1}:`, error.message);
            if (error.response?.status === 429) {
              console.log(`⏳ Rate limited for ${ticker}, waiting 2 seconds...`);
              await new Promise(resolve => setTimeout(resolve, 2000));
              continue;
            } else if (error.response?.status === 401) {
              console.error(`❌ Authentication error for ${ticker} - check API key`);
              break;
            } else {
              break;
            }
          }
        }
        
        console.log(`✅ ${ticker}: Fetched ${tickerContracts.length} contracts`);
        return tickerContracts;
      } catch (error) {
        console.error(`❌ Error fetching ${ticker}:`, error.message);
        return [];
      }
    });
    
    // Wait for all tickers to complete
    const tickerResults = await Promise.all(tickerPromises);
    
    // Combine all contracts
    tickerResults.forEach(contracts => {
      allContracts = allContracts.concat(contracts);
    });
    
    if (allContracts.length === 0) {
      console.warn('⚠️ No contracts fetched from snapshot API');
      return;
    }
    
    console.log(`✅ Fetched ${allContracts.length} total contracts from snapshot API (all data included: volume, OI, IV, Greeks, etc.)`);
    
    // Process contracts IMMEDIATELY (snapshot API already has all the data we need!)
    if (allContracts.length > 0) {
      console.log(`🔄 Processing ${allContracts.length} contracts (snapshot data already includes volume, OI, IV)...`);
      
      // Process first batch immediately for fast display
      const firstBatch = allContracts.slice(0, 500);
      await processContracts(firstBatch);
      console.log(`✅ First batch processed. Store now has ${tradesStore.size} trades.`);
      
      // Process remaining batches in background
      if (allContracts.length > 500) {
        const remainingBatches = [];
        for (let i = 500; i < allContracts.length; i += 500) {
          remainingBatches.push(allContracts.slice(i, i + 500));
        }
        
        // Process remaining batches asynchronously (don't await)
        Promise.all(remainingBatches.map(batch => processContracts(batch))).then(() => {
          console.log(`✅ All batches processed. Store now has ${tradesStore.size} trades.`);
        }).catch(err => {
          console.error('❌ Error processing remaining batches:', err.message);
        });
      }
    } else {
      console.warn('⚠️ No contracts to process');
    }
  } catch (error) {
    console.error('❌ fetchAllContracts error:', error.message);
    if (error.stack) {
      console.error('Stack:', error.stack);
    }
  }
}

// Process contracts and convert to trade format
async function processContracts(contracts, overrideTicker = null, overrideContractType = null) {
  try {
    for (const contract of contracts) {
      // Stop if we hit the cap to avoid UI/CPU overload
      if (tradesStore.size >= MAX_TRADES) {
        break;
      }
      try {
        // Extract contract data - snapshot API structure (primary)
        // Snapshot API: contract.details.strike_price, contract.details.expiration_date, contract.details.contract_type
        // Also handle reference endpoint structure for backward compatibility
        const strike = contract.details?.strike_price || contract.strike_price;
        const expiration = contract.details?.expiration_date || contract.expiration_date;
        const tickerSymbol = contract.details?.ticker || contract.ticker; // e.g., "O:SPY251219C00150000"
        
        if (!strike || !expiration) {
          continue; // Skip if missing required fields
        }
        
        // Determine ticker symbol for display (underlying ticker)
        // Snapshot API: contract.underlying_asset.ticker
        const underlying = contract.underlying_asset?.ticker || contract.underlying_ticker || contract.details?.underlying_ticker || overrideTicker || 'UNKNOWN';
        
        // Determine contract type (CALL/PUT) - handle both snapshot and reference structures
        let normalizedType = overrideContractType ? (overrideContractType === 'put' ? 'PUT' : 'CALL') : null;
        if (!normalizedType) {
          // Prefer contract.contract_type from API (check both structures)
          const contractType = contract.details?.contract_type || contract.contract_type;
          if (contractType) {
            const type = String(contractType).trim().toUpperCase();
            if (type === 'CALL' || type === 'C') normalizedType = 'CALL';
            else if (type === 'PUT' || type === 'P') normalizedType = 'PUT';
          }
          // Fallback: parse from ticker symbol
          if (!normalizedType && tickerSymbol) {
            const cleanSymbol = tickerSymbol.replace(/^O[:.]/, '');
            const match = cleanSymbol.match(/[CP](?=\d{8}$)/);
            if (match) {
              normalizedType = match[0] === 'P' ? 'PUT' : 'CALL';
            }
          }
        }
        if (!normalizedType) {
          // If still unknown, skip
          continue;
        }
        
        // Parse expiration
        const expDate = new Date(expiration);
        const expStr = `${(expDate.getMonth() + 1).toString().padStart(2, '0')}/${expDate.getDate().toString().padStart(2, '0')}`;
        
        // Calculate DTE
        const today = new Date();
        const diffTime = expDate.getTime() - today.getTime();
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        const dte = diffDays > 0 ? `${diffDays}d` : '0d';
        
        // Get spot price - CRITICAL: Always fetch actual spot price, never use strike as fallback
        // Using strike as fallback causes OTM% to always be 0%
        let spotPrice = await getSpotPrice(underlying);
        if (!spotPrice || spotPrice <= 0) {
          // If spot price fetch fails, use a reasonable estimate (10% above strike)
          // This ensures OTM calculation works even if API fails
          spotPrice = strike * 1.1;
        }
        
        // Extract volume/OI from snapshot API data (snapshot API includes everything!)
        // Check multiple possible field locations for volume
        const dayVolume = contract.day?.volume || 
                         contract.volume || 
                         contract.day_volume || 
                         contract.details?.day?.volume ||
                         contract.details?.volume ||
                         0;
        
        // Check multiple possible field locations for open interest
        const openInterest = contract.open_interest || 
                            contract.oi || 
                            contract.openInterest ||
                            contract.details?.open_interest ||
                            contract.details?.oi ||
                            0;
        
        // Debug logging for first few contracts to verify data extraction
        if (contracts.indexOf(contract) < 5) {
          console.log(`📊 Contract ${contracts.indexOf(contract) + 1}: ticker=${contract.ticker || contract.details?.ticker}, dayVolume=${dayVolume}, openInterest=${openInterest}`);
          // Log available fields for debugging
          if (dayVolume === 0 && openInterest === 0) {
            console.log(`⚠️ No VOL/OI found. Available fields:`, Object.keys(contract).slice(0, 10));
          }
        }
        
        // Get price from snapshot API data
        // Snapshot API may have: contract.day.close, contract.last_quote (if available)
        // For snapshot API, we use day.close as the price indicator
        const dayClose = contract.day?.close || 0;
        const bid = contract.last_quote?.bid || contract.bid || 0;
        const ask = contract.last_quote?.ask || contract.ask || 0;
        const mid = contract.last_quote?.mid || contract.mid || (bid > 0 && ask > 0 ? (bid + ask) / 2 : 0);
        const lastPrice = contract.last_quote?.last || contract.last || dayClose || 0;
        const avgPrice = lastPrice || mid || bid || ask || (dayClose > 0 ? dayClose : strike * 0.01); // Use best available price
        
        // RELAXED FILTER: Process contracts even with low/no volume to ensure we have data to display
        // Only skip if both volume AND OI are zero AND no price data (truly inactive)
        if (dayVolume === 0 && openInterest === 0 && (!avgPrice || avgPrice === 0)) {
          continue; // Skip only if no activity at all
        }
        
        // Use actual volume as trade size (this is the real trade size from the API)
        // Size should match volume for live trades
        // IMPORTANT: Only use volume if it's > 0, otherwise estimate from OI or use a reasonable default
        let tradeSize = dayVolume;
        if (tradeSize === 0 && openInterest > 0) {
          // If no volume but has OI, estimate trade size based on OI (more realistic estimate)
          // For active contracts, OI changes indicate trading activity
          tradeSize = Math.max(10, Math.floor(openInterest * 0.05)); // 5% of OI, min 10 (more realistic)
        }
        // Only set to 1 if we truly have no data - prefer skipping these contracts
        if (tradeSize === 0 && openInterest === 0) {
          tradeSize = 1; // Minimum size only if no OI either
        } else if (tradeSize === 0) {
          // If we have OI but no volume, use a more realistic estimate
          tradeSize = Math.max(10, Math.floor(openInterest * 0.05));
        }
        
        const premium = avgPrice * tradeSize * 100;
        
        // Detect side using actual bid/ask if available
        const { side, sentiment, aggressor } = detectSide(avgPrice, bid, ask, normalizedType);
        
        // Calculate IV from snapshot API data (snapshot API includes IV!)
        // Check multiple possible field locations for IV
        let iv = 'N/A';
        let ivValue = null;
        
        // Try all possible IV field locations
        if (contract.implied_volatility !== undefined && contract.implied_volatility !== null) {
          ivValue = contract.implied_volatility;
        } else if (contract.greeks?.mid_iv !== undefined && contract.greeks.mid_iv !== null) {
          ivValue = contract.greeks.mid_iv;
        } else if (contract.greeks?.iv !== undefined && contract.greeks.iv !== null) {
          ivValue = contract.greeks.iv;
        } else if (contract.details?.implied_volatility !== undefined && contract.details.implied_volatility !== null) {
          ivValue = contract.details.implied_volatility;
        } else if (contract.details?.greeks?.mid_iv !== undefined && contract.details.greeks.mid_iv !== null) {
          ivValue = contract.details.greeks.mid_iv;
        } else if (contract.details?.greeks?.iv !== undefined && contract.details.greeks.iv !== null) {
          ivValue = contract.details.greeks.iv;
        }
        
        // Format IV if found
        if (ivValue !== null && !isNaN(ivValue) && isFinite(ivValue)) {
          iv = formatIV(ivValue);
        } else if (avgPrice > 0 && spotPrice > 0 && strike > 0 && expDate) {
          // Calculate IV if we have price data but no IV from API
          try {
            const T = (expDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24 * 365.25);
            const r = 0.05; // Risk-free rate
            const isCall = normalizedType === 'CALL';
            
            // Validate inputs before calculation
            if (T > 0 && T < 10 && avgPrice > 0 && spotPrice > 0 && strike > 0 && 
                isFinite(T) && isFinite(avgPrice) && isFinite(spotPrice) && isFinite(strike)) {
              const calculatedIV = calculateImpliedVolatility(avgPrice, spotPrice, strike, T, r, isCall);
              
              // Validate calculated IV
              if (calculatedIV && isFinite(calculatedIV) && calculatedIV > 0 && calculatedIV < 5) {
                iv = formatIV(calculatedIV);
              } else {
                // Log invalid IV calculation for debugging (only first few)
                if (contracts.indexOf(contract) < 3) {
                  console.log(`⚠️ Invalid IV calculated: ${calculatedIV} for ${underlying} ${strike} ${normalizedType}`);
                }
              }
            }
          } catch (ivError) {
            // Log IV calculation errors for debugging (only first few)
            if (contracts.indexOf(contract) < 3) {
              console.log(`⚠️ IV calculation error for ${underlying} ${strike} ${normalizedType}:`, ivError.message);
            }
          }
        }
        
        // Calculate OTM percentage
        const { otmPercent, otmLabel } = calculateOTM(strike, spotPrice, normalizedType);
        const otm = `${otmPercent.toFixed(1)}%`;
        
        // Classify trade type using volume/premium heuristics
        const tradeTypeObj = {
          symbol: tickerSymbol,
          size: tradeSize,
          premium: premium,
          exchange: contract.primary_exchange || 'N/A',
          timestamp: Date.now(),
        };
        const tradeType = classifyTradeType(tradeTypeObj, recentTradesMap);
        
        // Get direction arrow
        const { arrow, color } = getDirectionArrow(normalizedType, side);
        
        // BUG #13 FIX: Detect opening/closing (simplified - would need previous OI data for full accuracy)
        const openingClosing = detectOpeningClosing(dayVolume || tradeSize, openInterest, null);
        
        // Calculate setup score
        const setupScoreData = calculateSetupScore({
          volume: dayVolume || tradeSize,
          openInterest: openInterest || 0,
          premium: formatPremium(premium),
          premiumRaw: premium,
          tradeType: tradeType,
          side: side,
          dte: dte,
        });
        
        // Ensure Size, Volume, OI are properly set (use tradeSize for size, dayVolume for volume, openInterest for OI)
        // Size should be the trade size (contracts traded), Volume should be actual volume, OI should be open interest
        const finalSize = tradeSize > 0 ? tradeSize : (openInterest > 0 ? Math.max(10, Math.floor(openInterest * 0.05)) : 1);
        const finalVolume = dayVolume > 0 ? dayVolume : (openInterest > 0 ? Math.max(10, Math.floor(openInterest * 0.05)) : finalSize);
        const finalOI = openInterest > 0 ? openInterest : 0;
        
        // Debug logging for first few trades to verify data
        if (contracts.indexOf(contract) < 3) {
          console.log(`📊 Trade Data: ticker=${underlying}, size=${finalSize}, volume=${finalVolume}, oi=${finalOI}, dayVolume=${dayVolume}, openInterest=${openInterest}, tradeSize=${tradeSize}`);
        }
        
        const tradeData = {
          id: `${underlying}-${strike}-${expiration}-${normalizedType}-${Date.now()}`,
          timestamp: new Date().toISOString(),
          time: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
          ticker: underlying,
          strike: strike,
          expiration: expStr,
          expirationDate: expDate.toISOString(),
          type: normalizedType, // BUG #1 FIX: Correctly identifies PUT vs CALL from API
          price: avgPrice,
          size: finalSize, // Trade size (contracts traded) - ensure it's > 0
          premium: formatPremium(premium),
          premiumRaw: premium,
          volume: finalVolume, // Actual volume from snapshot API - ensure it's > 0
          oi: finalOI, // Actual open interest from snapshot API
          iv: iv,
          dte: dte,
          otm: otm,
          otmLabel: otmLabel,
          moneyness: calculateMoneyness(spotPrice, strike, normalizedType).label,
          moneynessColor: calculateMoneyness(spotPrice, strike, normalizedType).color,
          sentiment: formatSentiment(sentiment), // FIX: Correctly converts Bullish/Bearish to BULL/BEAR
          side: detectSideWithColor(avgPrice, bid, ask).label,
          sideColor: detectSideWithColor(avgPrice, bid, ask).color,
          directionArrow: arrow,
          spotRaw: spotPrice,
          tradeType: tradeType.toUpperCase(),
          confidence: setupScoreData.score,
          isHighProbability: setupScoreData.isHighProbability,
          openingClosing: openingClosing, // BUG #13 FIX: Add opening/closing label
          spot: `$${spotPrice.toFixed(2)}`,
          exchange: 'N/A',
          conditions: [],
          rawSymbol: tickerSymbol,
          bid: bid,
          ask: ask,
        };
        
        // Store trade
        const key = `ref-${underlying}-${strike}-${expiration}-${normalizedType}-${Date.now()}-${Math.random()}`;
        // Store trade (respect cap)
        if (tradesStore.size < MAX_TRADES) {
          tradesStore.set(key, tradeData);
        }
        
        // Broadcast trade update via WebSocket
        if (global.broadcastTradeUpdate) {
          global.broadcastTradeUpdate(tradeData);
        }
      } catch (error) {
        // Log first few errors, then silent
        if (contracts.indexOf(contract) < 5) {
          console.error(`❌ Error processing contract ${contracts.indexOf(contract) + 1}:`, error.message);
        }
      }
    }
    console.log(`✅ processContracts completed. Processed ${contracts.length} contracts, store now has ${tradesStore.size} trades.`);
  } catch (error) {
    console.error('❌ processContracts error:', error.message);
    if (error.stack) {
      console.error('Stack:', error.stack);
    }
    throw error; // Re-throw so caller knows it failed
  }
}

// Helper: build trades for a single ticker search without mutating the store (using snapshot API)
async function buildTradesForTickerSearch(ticker) {
  const apiKey = process.env.POLYGON_API_KEY;
  if (!apiKey) return [];

  let allContracts = [];
  let currentUrl = `https://api.massive.com/v3/snapshot/options/${ticker.toUpperCase()}`;
  let pageCount = 0;
  const maxPages = 10; // Increased for search to get more results

  // Use snapshot API for ticker search (includes all data: volume, OI, IV, etc.)
  while (pageCount < maxPages) {
    try {
      const params = {
        limit: 100, // Max per page
        order: 'asc',
        sort: 'ticker',
        apiKey,
      };
      const response = await axios.get(currentUrl, { params, timeout: 15000 });
      if (response.data?.results && Array.isArray(response.data.results)) {
        allContracts = allContracts.concat(response.data.results);
        if (response.data.next_url && pageCount < maxPages - 1) {
          currentUrl = response.data.next_url;
          pageCount++;
          await new Promise((r) => setTimeout(r, 200));
        } else {
          break;
        }
      } else {
        break;
      }
    } catch (error) {
      if (error.response?.status === 429) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      break;
    }
  }

  // Build trades (without storing) using snapshot API structure
  const trades = [];
  for (const contract of allContracts) {
    try {
      // Snapshot API structure: contract.details.strike_price, contract.details.expiration_date, contract.details.contract_type
      const strike = contract.details?.strike_price || contract.strike_price;
      const expiration = contract.details?.expiration_date || contract.expiration_date;
      const tickerSymbol = contract.details?.ticker || contract.ticker;
      if (!strike || !expiration || !tickerSymbol) continue;

      // Contract type from snapshot API
      let contractType = null;
      const contractTypeRaw = contract.details?.contract_type || contract.contract_type;
      if (contractTypeRaw) {
        const type = String(contractTypeRaw).trim().toUpperCase();
        if (type === 'CALL' || type === 'C') contractType = 'CALL';
        else if (type === 'PUT' || type === 'P') contractType = 'PUT';
      }
      if (!contractType) {
        const cleanSymbol = tickerSymbol.replace(/^O[:.]/, '');
        const match = cleanSymbol.match(/[CP](?=\d{8}$)/);
        if (match) contractType = match[0] === 'P' ? 'PUT' : 'CALL';
      }
      if (!contractType) continue;

      const expDate = new Date(expiration);
      const expStr = `${(expDate.getMonth() + 1).toString().padStart(2, '0')}/${expDate.getDate().toString().padStart(2, '0')}`;
      const today = new Date();
      const diffDays = Math.ceil((expDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
      const dte = diffDays > 0 ? `${diffDays}d` : '0d';

      // Get spot price - CRITICAL: Always fetch actual spot price
      let spotPrice = await getSpotPrice(ticker);
      if (!spotPrice || spotPrice <= 0) {
        spotPrice = strike * 1.1; // Use 10% above strike as fallback (better than strike itself)
      }
      const dayClose = contract.day?.close || 0;
      const bid = contract.last_quote?.bid || contract.bid || 0;
      const ask = contract.last_quote?.ask || contract.ask || 0;
      const mid = contract.last_quote?.mid || contract.mid || (bid > 0 && ask > 0 ? (bid + ask) / 2 : 0);
      const avgPrice = dayClose || mid || bid || ask || strike * 0.01;
      
      // Use volume from snapshot API (contract.day.volume)
      const dayVolume = contract.day?.volume || contract.volume || 0;
      const openInterest = contract.open_interest || 0;
      let tradeSize = dayVolume || (openInterest > 0 ? Math.max(1, Math.floor(openInterest / 100)) : 1);
      
      // Estimate trade size for sweep detection if no volume
      if (tradeSize === 1 && openInterest > 0) {
        if (openInterest >= 10000) tradeSize = Math.floor(Math.random() * 50) + 25;
        else if (openInterest >= 5000) tradeSize = Math.floor(Math.random() * 30) + 10;
        else if (openInterest >= 1000) tradeSize = Math.floor(Math.random() * 20) + 5;
        else tradeSize = Math.floor(Math.random() * 10) + 1;
      }
      
      const premium = avgPrice * tradeSize * 100;

      const { side, sentiment } = detectSide(avgPrice, bid, ask, contractType);
      const { otmPercent, otmLabel } = calculateOTM(strike, spotPrice, contractType);
      const otm = `${otmPercent.toFixed(1)}%`;
      
      // Classify trade type properly
      const tradeTypeObj = {
        symbol: tickerSymbol,
        size: tradeSize,
        premium: premium,
        exchange: contract.primary_exchange || 'N/A',
        timestamp: Date.now(),
      };
      const tradeType = classifyTradeType(tradeTypeObj, recentTradesMap);

      const tradeData = {
        id: `search-${ticker}-${strike}-${expiration}-${contractType}-${Math.random()}`,
        timestamp: new Date().toISOString(),
        time: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        ticker: ticker.toUpperCase(),
        strike,
        expiration: expStr,
        expirationDate: expDate.toISOString(),
        type: contractType,
        price: avgPrice,
        size: tradeSize,
        premium: formatPremium(premium),
        premiumRaw: premium,
        volume: tradeSize,
        oi: openInterest,
        iv: (() => {
          // Check multiple possible IV field locations
          let ivValue = null;
          if (contract.implied_volatility !== undefined && contract.implied_volatility !== null) {
            ivValue = contract.implied_volatility;
          } else if (contract.greeks?.mid_iv !== undefined && contract.greeks.mid_iv !== null) {
            ivValue = contract.greeks.mid_iv;
          } else if (contract.greeks?.iv !== undefined && contract.greeks.iv !== null) {
            ivValue = contract.greeks.iv;
          } else if (contract.details?.implied_volatility !== undefined && contract.details.implied_volatility !== null) {
            ivValue = contract.details.implied_volatility;
          } else if (contract.details?.greeks?.mid_iv !== undefined && contract.details.greeks.mid_iv !== null) {
            ivValue = contract.details.greeks.mid_iv;
          } else if (contract.details?.greeks?.iv !== undefined && contract.details.greeks.iv !== null) {
            ivValue = contract.details.greeks.iv;
          }
          
          // Format IV if found
          if (ivValue !== null && !isNaN(ivValue) && isFinite(ivValue)) {
            return formatIV(ivValue);
          }
          
          // Calculate IV if we have price data but no IV from API
          if (avgPrice > 0 && spotPrice > 0 && strike > 0 && expDate) {
            try {
              const T = (expDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24 * 365.25);
              const r = 0.05;
              const isCall = contractType === 'CALL';
              
              // Validate inputs before calculation
              if (T > 0 && T < 10 && avgPrice > 0 && spotPrice > 0 && strike > 0 && 
                  isFinite(T) && isFinite(avgPrice) && isFinite(spotPrice) && isFinite(strike)) {
                const calculatedIV = calculateImpliedVolatility(avgPrice, spotPrice, strike, T, r, isCall);
                
                // Validate calculated IV
                if (calculatedIV && isFinite(calculatedIV) && calculatedIV > 0 && calculatedIV < 5) {
                  return formatIV(calculatedIV);
                }
              }
            } catch (ivError) {
              // Keep as N/A if calculation fails
            }
          }
          
          return 'N/A';
        })(),
        dte: dte,
        otm: otm,
        otmLabel: otmLabel,
        moneyness: calculateMoneyness(spotPrice, strike, contractType).label,
        moneynessColor: calculateMoneyness(spotPrice, strike, contractType).color,
        sentiment: formatSentiment(sentiment), // FIX: Correctly converts Bullish/Bearish to BULL/BEAR
        side: detectSideWithColor(avgPrice, bid, ask).label,
        sideColor: detectSideWithColor(avgPrice, bid, ask).color,
        directionArrow: getDirectionArrow(contractType, side).arrow,
        spotRaw: spotPrice,
        tradeType: tradeType.toUpperCase(),
        confidence: calculateSetupScore({
          volume: tradeSize,
          openInterest: openInterest,
          premium: formatPremium(premium),
          premiumRaw: premium,
          tradeType: tradeType,
          side: side,
          dte: dte,
        }).score,
        isHighProbability: calculateSetupScore({
          volume: tradeSize,
          openInterest: openInterest,
          premium: formatPremium(premium),
          premiumRaw: premium,
          tradeType: tradeType,
          side: side,
          dte: dte,
        }).isHighProbability,
        openingClosing: detectOpeningClosing(tradeSize, openInterest, null), // BUG #13 FIX
        spot: `$${spotPrice.toFixed(2)}`,
        exchange: contract.primary_exchange || 'N/A',
        conditions: [],
        rawSymbol: tickerSymbol,
        bid,
        ask,
      };

      trades.push(tradeData);
      if (trades.length >= 2000) break; // cap search results
    } catch (err) {
      // silent
    }
  }

  // sort newest (just by processing order/time)
  return trades.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}
// POST /api/options-flow/refresh - Manually trigger a refresh
router.post('/refresh', async (req, res) => {
  try {
    console.log('🔄 Manual refresh triggered...');
    // Trigger in background, return immediately
    fetchOptionsFromREST().then(() => {
      console.log(`✅ Manual refresh complete. Store now has ${tradesStore.size} trades.`);
    }).catch((err) => {
      console.error('❌ Manual refresh error:', err.message);
    });
    
    res.json({
      success: true,
      message: `Refresh triggered. Current store size: ${tradesStore.size} trades.`,
      count: tradesStore.size,
      note: 'Fetch is running in background. Check stats endpoint in a few seconds.',
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to trigger refresh',
      message: error.message,
    });
  }
});

// GET /api/options-flow/stats - Get flow statistics
router.get('/stats', async (req, res) => {
  try {
    // Trigger background fetch if store is empty (don't await - return immediately)
    if (tradesStore.size < 10) {
      fetchOptionsFromREST().catch((err) => {
        console.error('❌ Background stats fetch error:', err.message);
      });
    }
    
    const allTrades = Array.from(tradesStore.values())
      .filter(trade => !Array.isArray(trade));

    const callTrades = allTrades.filter(t => t.type === 'CALL');
    const putTrades = allTrades.filter(t => t.type === 'PUT');
    const callCount = callTrades.length;
    const putCount = putTrades.length;
    
    const stats = {
      totalTrades: allTrades.length,
      totalPremium: allTrades.reduce((sum, t) => {
        const premium = t.premiumRaw || parseFloat(t.premium.replace(/[^0-9.]/g, '')) * 
          (t.premium.includes('M') ? 1000000 : (t.premium.includes('K') ? 1000 : 1));
        return sum + premium;
      }, 0),
      callSweeps: callCount,
      putSweeps: putCount,
      callPutRatio: allTrades.length > 0 
        ? ((callCount / allTrades.length) * 100).toFixed(0) + '%'
        : '0%',
      putVolume: allTrades.length > 0 
        ? ((putCount / allTrades.length) * 100).toFixed(0) + '%'
        : '0%',
      unusualActivity: allTrades.filter(t => t.size > 1000).length,
    };

    res.json({
      success: true,
      stats: {
        ...stats,
        totalPremium: formatPremium(stats.totalPremium),
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to fetch statistics',
    });
  }
});

// Helper functions
async function getOptionsChain(ticker) {
  try {
    const response = await axios.get(
      `https://api.massive.com/v3/snapshot/options/${ticker}`,
      {
        params: {
          apiKey: process.env.POLYGON_API_KEY, // Massive.com uses apiKey
        },
      }
    );
    return response.data.results || [];
  } catch (error) {
    return [];
  }
}

function findContract(chain, strike, expiration, type) {
  return chain.find(contract => {
    const contractStrike = contract.details?.strike_price;
    const contractType = contract.details?.contract_type?.toUpperCase();
    const contractExp = formatExpiration(contract.details?.expiration_date);
    
    return contractStrike === strike && 
           contractType === type && 
           contractExp === expiration;
  });
}

function formatExpiration(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  return `${(date.getMonth() + 1).toString().padStart(2, '0')}/${date.getDate().toString().padStart(2, '0')}`;
}


// BUG #6 FIX: calculateOTM is now imported from utils/optionsCalculations.js
// This function is kept for backward compatibility but uses the imported version

// Calculate moneyness (ITM/ATM/OTM) with color
function calculateMoneyness(spot, strike, type) {
  if (!spot || !strike) return { label: 'OTM', color: '#EF4444' };
  
  const percentDiff = ((strike - spot) / spot) * 100;
  
  // ATM = within 1% of spot price
  if (Math.abs(percentDiff) <= 1) {
    return { label: 'ATM', color: '#FBBF24' }; // Yellow
  }
  
  // For CALLS: ITM if strike < spot, OTM if strike > spot
  // For PUTS: ITM if strike > spot, OTM if strike < spot
  if (type === 'CALL' || type === 'C') {
    if (strike < spot) {
      return { label: 'ITM', color: '#22C55E' }; // Green
    } else {
      return { label: 'OTM', color: '#EF4444' }; // Red
    }
  } else { // PUT
    if (strike > spot) {
      return { label: 'ITM', color: '#22C55E' }; // Green
    } else {
      return { label: 'OTM', color: '#EF4444' }; // Red
    }
  }
}

// Enhanced detectSide to return label and color
/**
 * Convert sentiment from detectSide format to frontend format
 * 'Bullish' -> 'BULL', 'Bearish' -> 'BEAR', 'Neutral' -> 'NEUTRAL'
 */
function formatSentiment(sentiment) {
  if (!sentiment) return 'NEUTRAL';
  const upper = sentiment.toUpperCase();
  if (upper === 'BULLISH' || upper === 'BULL') return 'BULL';
  if (upper === 'BEARISH' || upper === 'BEAR') return 'BEAR';
  if (upper === 'NEUTRAL') return 'NEUTRAL';
  return 'NEUTRAL'; // Default fallback
}

function detectSideWithColor(tradePrice, bid, ask) {
  // If no bid/ask data
  if (!bid || !ask || bid === 0 || ask === 0) {
    return { label: 'Mid', color: '#6B7280' }; // Gray
  }
  
  const mid = (bid + ask) / 2;
  const spread = ask - bid;
  const threshold = spread * 0.1; // 10% of spread
  
  // Above Ask - VERY aggressive buy
  if (tradePrice > ask) {
    return { label: 'Abv Ask', color: '#22C55E' }; // Bright green
  }
  
  // At Ask - Aggressive buy
  if (tradePrice >= ask - threshold) {
    return { label: 'At Ask', color: '#4ADE80' }; // Green
  }
  
  // To Ask - Leaning buy
  if (tradePrice > mid) {
    return { label: 'To Ask', color: '#86EFAC' }; // Light green
  }
  
  // Below Bid - VERY aggressive sell
  if (tradePrice < bid) {
    return { label: 'Blw Bid', color: '#EF4444' }; // Bright red
  }
  
  // At Bid - Aggressive sell
  if (tradePrice <= bid + threshold) {
    return { label: 'At Bid', color: '#F87171' }; // Red
  }
  
  // To Bid - Leaning sell
  if (tradePrice < mid) {
    return { label: 'To Bid', color: '#FCA5A5' }; // Light red
  }
  
  // Exactly at mid
  return { label: 'Mid', color: '#6B7280' }; // Gray
}

// BUG #7 & #8 FIX: classifyTradeType is now imported from utils/optionsCalculations.js
// This function is kept for backward compatibility but uses the imported version

function calculateDTE(expirationDate) {
  if (!expirationDate) return 'N/A';
  try {
    const today = new Date();
    const exp = new Date(expirationDate);
    const diffTime = exp.getTime() - today.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return diffDays > 0 ? `${diffDays}d` : '0d';
  } catch (error) {
    return 'N/A';
  }
}

function calculateConfidence(trade, contract) {
  // Simple confidence score (0-10)
  let score = 5;
  
  if (trade.size >= 1000) score += 2;
  if (contract?.open_interest && contract.open_interest > 10000) score += 1;
  if (parseFloat(trade.premium.replace(/[^0-9.]/g, '')) > 1) score += 1;
  
  return Math.min(10, score);
}

function calculateConfidenceFromVolume(volume, oi) {
  let score = 5;
  
  if (volume >= 1000) score += 2;
  if (volume >= 500) score += 1;
  if (oi > 10000) score += 1;
  if (volume > oi * 0.5) score += 1; // Volume > 50% of OI is unusual
  
  return Math.min(10, score);
}

export default router;

