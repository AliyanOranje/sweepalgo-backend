import express from 'express';
import axios from 'axios';
import WebSocket from 'ws';

const router = express.Router();

// Store for real-time trades
const tradesStore = new Map();
const MAX_TRADES = 1000;

// Polygon.io WebSocket connection
let polygonWS = null;
let isConnected = false;

// Initialize Polygon.io WebSocket
function initPolygonWebSocket() {
  if (polygonWS && isConnected) {
    console.log('⚠️ WebSocket already connected, skipping initialization');
    return;
  }

  console.log('🔌 Initializing Massive.com (Polygon.io) WebSocket connection...');
  // Try both endpoints - Massive.com may use same endpoint or different
  const ws = new WebSocket('wss://socket.polygon.io/options');

  ws.on('open', () => {
    console.log('✅ Connected to Polygon.io WebSocket');
    console.log('🔑 Authenticating with API key:', process.env.POLYGON_API_KEY ? 'Set' : 'Missing!');
    
    // Authenticate
    const authMessage = {
      action: 'auth',
      params: process.env.POLYGON_API_KEY
    };
    console.log('📤 Sending auth message:', JSON.stringify(authMessage));
    ws.send(JSON.stringify(authMessage));
  });

  ws.on('message', (data) => {
    try {
      const rawData = data.toString();
      console.log('📥 Raw WebSocket message received:', rawData.substring(0, 200)); // Log first 200 chars
      
      const messages = JSON.parse(rawData);
      
      // Handle array of messages (Polygon sends arrays)
      const messageArray = Array.isArray(messages) ? messages : [messages];
      
      console.log(`📦 Processing ${messageArray.length} message(s)`);
      
      messageArray.forEach((msg, index) => {
        // Handle single message object or array
        const message = Array.isArray(msg) ? msg[0] : msg;
        
        console.log(`🔍 Message ${index + 1}:`, JSON.stringify(message, null, 2));
        
        // Authentication confirmation
        if (message?.ev === 'status' && message?.status === 'auth_success') {
          console.log('✅ Authenticated with Polygon.io');
          isConnected = true;
          
          // Subscribe to options trades for major tickers
          const tickers = ['SPY', 'QQQ', 'NVDA', 'AAPL', 'TSLA', 'MSFT', 'GOOGL', 'AMZN', 'META', 'AMD'];
          const subscriptions = tickers.map(ticker => `O.${ticker}*`).join(',');
          
          ws.send(JSON.stringify({
            action: 'subscribe',
            params: subscriptions
          }));
          
          console.log(`📡 Subscribed to: ${subscriptions}`);
        }
        
        // Status messages
        if (message?.ev === 'status') {
          console.log(`📊 Status: ${message.status}`, message.message || '');
        }
        
        // Options trade data
        if (message?.ev === 'O') {
          console.log('🎯 Options trade detected:', {
            symbol: message.sym,
            price: message.p,
            size: message.s,
            exchange: message.x,
            timestamp: message.t,
          });
          processOptionsTrade(message);
        }
      });
    } catch (error) {
      console.error('❌ Error parsing WebSocket message:', error);
      console.error('Raw data:', data.toString().substring(0, 500));
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    isConnected = false;
  });

  ws.on('close', () => {
    console.log('❌ Polygon.io WebSocket disconnected. Reconnecting...');
    isConnected = false;
    
    // Reconnect after 5 seconds
    setTimeout(() => {
      initPolygonWebSocket();
    }, 5000);
  });

  polygonWS = ws;
}

// Process incoming options trade
function processOptionsTrade(trade) {
  try {
    console.log('🔄 Processing options trade:', JSON.stringify(trade, null, 2));
    
    // Extract trade data
    const {
      sym,      // Symbol (e.g., "O:SPY241115C00585000")
      x,        // Exchange
      p,        // Price per contract
      s,        // Size (number of contracts)
      c,        // Conditions
      t,        // Timestamp
    } = trade;

    console.log('📊 Trade details:', {
      symbol: sym,
      price: p,
      size: s,
      exchange: x,
      timestamp: t,
      conditions: c,
    });

    // Parse option symbol to get ticker, strike, expiration, type
    const optionDetails = parseOptionSymbol(sym);
    if (!optionDetails) {
      console.log('⚠️ Failed to parse option symbol:', sym);
      return;
    }

    console.log('✅ Parsed option details:', optionDetails);

    const { ticker, strike, expiration, type, expirationDate } = optionDetails;

    // Calculate premium
    const premium = p * s * 100; // Price * Contracts * 100
    console.log(`💰 Premium calculated: $${premium.toLocaleString()} (${p} × ${s} × 100)`);

    // Filter by minimum premium (lowered for testing - can increase later)
    const minPremium = 10000; // Lowered from 100000 for more trades
    if (premium < minPremium) {
      console.log(`⏭️ Trade filtered out (premium $${premium.toLocaleString()} < $${minPremium.toLocaleString()})`);
      return;
    }

    // Create trade object
    const tradeData = {
      id: `${sym}-${t}-${s}-${Date.now()}`,
      timestamp: new Date(t).toISOString(),
      time: new Date(t).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      ticker,
      strike,
      expiration,
      expirationDate: expirationDate.toISOString(), // Store for DTE calculation
      type: type.toUpperCase(),
      price: p,
      size: s,
      premium: formatPremium(premium),
      premiumRaw: premium, // Keep raw value for filtering
      volume: s, // Will be updated with total volume
      oi: 0, // Will be fetched later
      iv: 'N/A', // Will be fetched later
      dte: calculateDTE(expirationDate),
      otm: 'N/A', // Will be calculated later
      sentiment: type === 'CALL' ? 'BULL' : 'BEAR',
      tradeType: classifyTradeType({ size: s }),
      confidence: 5, // Default
      moneyness: 'OTM', // Default
      exchange: x,
      conditions: c,
      rawSymbol: sym,
      spot: `$${strike}`, // Placeholder
    };

    console.log('✅ Trade data created:', JSON.stringify(tradeData, null, 2));

    // Store trade in global list (for API endpoint)
    const globalKey = `trade-${Date.now()}-${Math.random()}`;
    tradesStore.set(globalKey, tradeData);
    
    console.log(`💾 Stored trade. Total trades in store: ${tradesStore.size}`);
    
    // Clean up old trades
    if (tradesStore.size > MAX_TRADES) {
      const firstKey = tradesStore.keys().next().value;
      tradesStore.delete(firstKey);
      console.log('🧹 Cleaned up old trade');
    }

    // Log summary
    console.log('📈 Trade Summary:', {
      ticker,
      contract: `${type} ${strike} ${expiration}`,
      premium: tradeData.premium,
      size: s,
      time: tradeData.time,
    });

  } catch (error) {
    console.error('❌ Error processing options trade:', error);
    console.error('Trade object:', JSON.stringify(trade, null, 2));
  }
}

// Parse option symbol (e.g., "O:SPY241115C00585000" or "O.SPY241115C00585000")
function parseOptionSymbol(symbol) {
  try {
    // Remove prefix (O: or O.)
    const cleanSymbol = symbol.replace(/^O[:.]/, '');
    
    // Format: TICKERYYMMDDC/PSTRIKE
    // Example: SPY241115C00585000 = SPY, Nov 15 2024, Call, $585 strike
    
    // Extract ticker (variable length, ends at first digit)
    const tickerMatch = cleanSymbol.match(/^([A-Z]+)/);
    if (!tickerMatch) return null;
    
    const ticker = tickerMatch[1];
    const remaining = cleanSymbol.substring(ticker.length);
    
    // Extract date (6 digits: YYMMDD)
    if (remaining.length < 6) return null;
    const dateStr = remaining.substring(0, 6);
    
    // Extract type (C or P)
    if (remaining.length < 7) return null;
    const type = remaining.substring(6, 7);
    
    // Extract strike (remaining digits)
    const strikeStr = remaining.substring(7);
    if (!strikeStr || strikeStr.length === 0) return null;
    
    // Parse date (YYMMDD)
    const year = 2000 + parseInt(dateStr.substring(0, 2));
    const month = parseInt(dateStr.substring(2, 4)) - 1;
    const day = parseInt(dateStr.substring(4, 6));
    const expiration = new Date(year, month, day);
    
    // Parse strike (divide by 1000 for standard strikes, or by 10000 for fractional)
    let strike;
    if (strikeStr.length >= 8) {
      strike = parseInt(strikeStr) / 10000; // Fractional strikes
    } else {
      strike = parseInt(strikeStr) / 1000; // Standard strikes
    }
    
    // Format expiration
    const expStr = `${(month + 1).toString().padStart(2, '0')}/${day.toString().padStart(2, '0')}`;
    
    return {
      ticker,
      strike,
      expiration: expStr,
      expirationDate: expiration,
      type: type === 'C' ? 'CALL' : 'PUT',
    };
  } catch (error) {
    console.error('Error parsing option symbol:', symbol, error);
    return null;
  }
}

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
console.log('🚀 Initializing Massive.com (Polygon.io) WebSocket on server start...');
console.log('🔑 API Key check:', process.env.POLYGON_API_KEY ? `✅ Set (${process.env.POLYGON_API_KEY.substring(0, 10)}...)` : '❌ Missing!');
initPolygonWebSocket();

// Also fetch initial data from REST API
console.log('📡 Fetching initial options flow from REST API...');
setTimeout(() => {
  fetchOptionsFromREST();
  
  // Set up periodic fetching every 30 seconds
  setInterval(() => {
    console.log('🔄 Periodic REST fetch triggered...');
    fetchOptionsFromREST();
  }, 30000); // Every 30 seconds
}, 2000); // Wait 2 seconds for server to be ready

// GET /api/options-flow - Get recent options flow with comprehensive filtering
router.get('/', async (req, res) => {
  try {
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
      
      // Exclude symbols
      excludeSymbols, // Comma-separated list
    } = req.query;

    const pageNum = parseInt(page) || 1;
    const limitNum = parseInt(limit) || 20;
    const offset = (pageNum - 1) * limitNum;

    console.log('📥 Options flow request with filters:', {
      minPremium,
      maxPremium,
      minPremiums,
      maxPremiums,
      minStrike,
      maxStrike,
      minBidask,
      maxBidask,
      limit: limitNum,
      page: pageNum,
      offset,
      ticker,
      type,
      tradeType,
      calls,
      puts,
      dte,
      stockPrice,
      openInterest,
      volume,
      storeSize: tradesStore.size,
    });

    // Always try to fetch fresh data from REST API if store is small
    // This ensures we have data even if WebSocket hasn't populated it yet
    // Don't filter by ticker when fetching - we want ALL trades for the Options Flow tab
    if (tradesStore.size < 1000) {
      console.log(`📡 Store has ${tradesStore.size} trades (less than 1000), fetching from REST API for ALL tickers...`);
      // Pass null to fetch all tickers, not just the requested one
      await fetchOptionsFromREST(null);
      // Wait a moment for data to be processed
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    // Get all trades from store
    const allTradesRaw = Array.from(tradesStore.values());
    console.log(`📊 Total trades in store: ${allTradesRaw.length}`);
    
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
        
        // Strike filters
        if (minStrike && trade.strike < parseFloat(minStrike)) return false;
        if (maxStrike && trade.strike > parseFloat(maxStrike)) return false;
        
        // Bid/Ask filters (would need bid/ask data in trade object)
        // if (minBidask && trade.bidask < parseFloat(minBidask)) return false;
        // if (maxBidask && trade.bidask > parseFloat(maxBidask)) return false;
        
        // Type filters
        if (calls === 'true' && trade.type !== 'CALL') return false;
        if (puts === 'true' && trade.type !== 'PUT') return false;
        if (type && trade.type !== type.toUpperCase()) return false;
        
        // Trade type filters
        if (sweeps === 'true' && trade.tradeType !== 'SWEEP') return false;
        if (blocks === 'true' && trade.tradeType !== 'BLOCK') return false;
        if (splits === 'true' && trade.tradeType !== 'SPLIT') return false;
        if (tradeType && trade.tradeType !== tradeType.toUpperCase()) return false;
        
        // ITM/OTM filters
        if (itm === 'true' && trade.moneyness !== 'ITM') return false;
        if (otm === 'true' && trade.moneyness !== 'OTM') return false;
        
        // Volume > OI filter
        if (volGtOi === 'true' && trade.volume <= trade.oi) return false;
        
        // DTE filter
        if (dte) {
          const selectedDTEs = dte.split(',').map(d => parseInt(d.trim())).filter(d => !isNaN(d));
          if (!checkDTE(trade.dte, selectedDTEs)) return false;
        }
        
        // Short Expiry / LEAPS filter
        const dteNum = parseInt(trade.dte?.replace('d', '')) || 0;
        if (shortExpiry === 'true' && dteNum > 30) return false;
        if (leaps === 'true' && dteNum < 365) return false;
        
        // Premium > $1M filter
        if (premium1m === 'true' && premiumNum < 1000000) return false;
        
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
        
        // Ticker filter
        if (ticker && trade.ticker !== ticker.toUpperCase()) return false;
        
        return true;
      })
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    // Calculate pagination
    const totalCount = filteredTrades.length;
    const totalPages = Math.ceil(totalCount / limitNum);
    const paginatedTrades = filteredTrades.slice(offset, offset + limitNum);

    console.log(`✅ Filtered to ${totalCount} total trades, showing page ${pageNum} of ${totalPages} (${paginatedTrades.length} trades)`);

    // Enrich trades with additional data (OI, IV, etc.)
    const enrichedTrades = paginatedTrades.map((trade) => {
      // Use existing data or defaults
      const enriched = {
        ...trade,
        oi: trade.oi || 0,
        iv: trade.iv || 'N/A',
        volume: trade.volume || trade.size,
        dte: trade.dte || (trade.expirationDate ? calculateDTE(new Date(trade.expirationDate)) : 'N/A'),
        otm: trade.otm || '0%',
        moneyness: trade.moneyness || 'OTM',
        sentiment: trade.sentiment || (trade.type === 'CALL' ? 'BULL' : 'BEAR'),
        tradeType: trade.tradeType || 'NORMAL',
        confidence: trade.confidence || 5,
        spot: trade.spot || `$${trade.strike}`,
      };
      return enriched;
    });

    console.log(`📤 Sending ${enrichedTrades.length} trades to client (page ${pageNum}/${totalPages})`);
    
    // Always return trades array, even if empty
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

// Fetch options trades from REST API (Massive.com)
async function fetchOptionsFromREST(ticker = null) {
  try {
    const apiKey = process.env.POLYGON_API_KEY;
    if (!apiKey) {
      console.error('❌ POLYGON_API_KEY not set');
      return;
    }

    // Fetch for all major tickers to get comprehensive options flow data
    // This ensures we have enough data for pagination
    const tickersToFetch = ticker ? [ticker.toUpperCase()] : [
      'SPY', 'QQQ', 'NVDA', 'AAPL', 'TSLA', 'MSFT', 'GOOGL', 'AMZN', 'META', 'AMD',
      'NFLX', 'INTC', 'MU', 'SMH', 'XLF', 'XLE', 'XLI', 'XLV', 'XLK', 'IWM'
    ];
    
    console.log('📡 Fetching options chain from REST API for:', tickersToFetch);

    for (const t of tickersToFetch) {
      try {
        console.log(`📡 Fetching options chain for ${t}...`);
        
        // Fetch options chain snapshot from Massive.com
        const response = await axios.get(
          `https://api.massive.com/v3/snapshot/options/${t}`,
          {
            params: {
              apiKey: apiKey, // Massive.com uses apiKey (not apikey)
            },
            timeout: 10000, // 10 second timeout
          }
        );

        console.log(`✅ Fetched options chain for ${t}:`, response.data?.results?.length || 0, 'contracts');
        console.log(`📊 Response status:`, response.status);
        console.log(`📊 Response keys:`, Object.keys(response.data || {}));
        
        if (response.data?.status) {
          console.log(`📊 API Status:`, response.data.status);
        }

        // Handle pagination - fetch ALL pages (no limit)
        let allContracts = [];
        let currentResponse = response;
        let pageCount = 0;
        const maxPages = 200; // Increased limit to fetch all pages (safety limit to prevent infinite loops)
        
        while (currentResponse?.data?.results && currentResponse.data.results.length > 0 && pageCount < maxPages) {
          pageCount++;
          console.log(`📄 Processing page ${pageCount} with ${currentResponse.data.results.length} contracts...`);
          allContracts = allContracts.concat(currentResponse.data.results);
          
          // Check if there's a next page
          if (currentResponse.data.next_url) {
            console.log(`📄 Found next_url, fetching page ${pageCount + 1}...`);
            try {
              // Use next_url directly (it already contains the API key)
              const nextUrl = currentResponse.data.next_url;
              const nextResponse = await axios.get(nextUrl, {
                timeout: 15000, // Increased timeout for large requests
              });
              currentResponse = nextResponse;
              
              // Small delay to avoid rate limiting
              await new Promise(resolve => setTimeout(resolve, 100));
            } catch (error) {
              console.error(`❌ Error fetching next page ${pageCount + 1}:`, error.message);
              if (error.response?.status === 429) {
                console.log('⏳ Rate limited, waiting 2 seconds...');
                await new Promise(resolve => setTimeout(resolve, 2000));
                // Retry once
                try {
                  const nextUrl = currentResponse.data.next_url;
                  const nextResponse = await axios.get(nextUrl, {
                    timeout: 15000,
                  });
                  currentResponse = nextResponse;
                } catch (retryError) {
                  console.error(`❌ Retry failed, stopping pagination`);
                  break;
                }
              } else {
                break;
              }
            }
          } else {
            console.log(`✅ No more pages (next_url is null)`);
            break; // No more pages
          }
        }
        
        console.log(`✅ Fetched ${allContracts.length} total contracts across ${pageCount} page(s) for ${t}`);
        
        if (allContracts.length > 0) {
          console.log(`📊 Processing ${allContracts.length} contracts for ${t}...`);
          let processedCount = 0;
          
          // Process each contract with volume
          allContracts.forEach((contract, index) => {
            const dayVolume = contract.day?.volume || 0;
            
            // Log first contract structure for debugging
            if (index === 0) {
              console.log('📋 Sample contract structure:', JSON.stringify(contract, null, 2));
            }
            
            // Try multiple price sources - check all possible locations
            const bid = contract.last_quote?.bid || contract.bid || contract.quote?.bid || 0;
            const ask = contract.last_quote?.ask || contract.ask || contract.quote?.ask || 0;
            const mid = contract.last_quote?.mid || contract.mid || (bid > 0 && ask > 0 ? (bid + ask) / 2 : 0);
            const last = contract.last_quote?.last || contract.last_trade?.price || contract.last || 0;
            const close = contract.close || contract.prev_day?.close || contract.day?.close || 0;
            
            // Use the best available price
            const lastPrice = mid || last || close || (bid > 0 && ask > 0 ? (bid + ask) / 2 : 0);
            
            if (index < 3) {
              console.log(`📊 Contract ${index + 1} price check:`, {
                bid,
                ask,
                mid,
                last,
                close,
                lastPrice,
                dayVolume,
                openInterest: contract.open_interest,
              });
            }
            
            // Accept contracts with volume or OI, even if price is 0 (we'll use a default)
            // This allows us to show trades even when market is closed or price data unavailable
            if (dayVolume > 0 || contract.open_interest > 0) {
              // If no price available, use a default based on strike and type
              const finalPrice = lastPrice > 0 ? lastPrice : (contract.details?.strike_price ? contract.details.strike_price * 0.01 : 0.01);
              const strike = contract.details?.strike_price;
              const expiration = contract.details?.expiration_date;
              const contractType = contract.details?.contract_type?.toUpperCase();
              
              if (strike && expiration && contractType) {
                // Calculate premium (estimate from volume and price)
                // Use the finalPrice we calculated above
                const avgPrice = finalPrice;
                
                // Use volume or OI for size calculation
                // If no volume, use a minimum size of 1 for display purposes
                const tradeSize = dayVolume > 0 ? dayVolume : (contract.open_interest > 0 ? Math.max(1, Math.floor(contract.open_interest / 100)) : 1);
                const premium = avgPrice * tradeSize * 100;
                
                // Store all trades regardless of premium (we lowered threshold)
                // This ensures we show trades even with low volume/price
                
                // Parse expiration
                const expDate = new Date(expiration);
                const expStr = `${(expDate.getMonth() + 1).toString().padStart(2, '0')}/${expDate.getDate().toString().padStart(2, '0')}`;
                
                // Calculate DTE
                const today = new Date();
                const diffTime = expDate.getTime() - today.getTime();
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                const dte = diffDays > 0 ? `${diffDays}d` : '0d';
                
                const tradeData = {
                  id: `${t}-${strike}-${expiration}-${contractType}-${Date.now()}`,
                  timestamp: new Date().toISOString(),
                  time: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
                  ticker: t,
                  strike: strike,
                  expiration: expStr,
                  expirationDate: expDate.toISOString(),
                  type: contractType === 'CALL' ? 'CALL' : 'PUT',
                  price: avgPrice,
                  size: tradeSize,
                  premium: formatPremium(premium),
                  premiumRaw: premium,
                  volume: dayVolume || tradeSize,
                  oi: contract.open_interest || 0,
                  iv: contract.greeks?.mid_iv ? `${(contract.greeks.mid_iv * 100).toFixed(1)}%` : 
                      (contract.greeks?.iv ? `${(contract.greeks.iv * 100).toFixed(1)}%` : 
                      (contract.implied_volatility ? `${(contract.implied_volatility * 100).toFixed(1)}%` : 'N/A')),
                  dte: dte,
                  otm: '0%', // Will calculate with current price
                  moneyness: 'OTM', // Will calculate with current price
                  sentiment: contractType === 'CALL' ? 'BULL' : 'BEAR',
                  tradeType: tradeSize >= 1000 ? 'BLOCK' : (tradeSize >= 100 ? 'SWEEP' : 'NORMAL'),
                  confidence: calculateConfidenceFromVolume(tradeSize, contract.open_interest || 0),
                  spot: `$${strike}`, // Will fetch current price
                  exchange: 'N/A',
                  conditions: [],
                  rawSymbol: `${t}${expiration.replace(/-/g, '')}${contractType === 'CALL' ? 'C' : 'P'}${String(strike * 1000).padStart(8, '0')}`,
                };
                
                // Store trade
                const key = `rest-${t}-${strike}-${expiration}-${Date.now()}-${Math.random()}`;
                tradesStore.set(key, tradeData);
                processedCount++;
                
                if (processedCount <= 5) { // Log first 5 trades
                  console.log(`💾 Stored REST trade: ${t} ${strike}${contractType === 'CALL' ? 'C' : 'P'} ${expStr} - Premium: ${tradeData.premium}, Size: ${tradeSize}, Volume: ${dayVolume}, OI: ${contract.open_interest || 0}, Price: ${avgPrice}`);
                }
              } else {
                if (index < 3) { // Log first 3 skipped contracts for debugging
                  console.log(`⏭️ Skipped contract ${index + 1} for ${t} (missing data):`, {
                    hasStrike: !!strike,
                    hasExpiration: !!expiration,
                    hasType: !!contractType,
                    strike,
                    expiration,
                    contractType,
                  });
                }
              }
            } else {
              if (index < 3) { // Log first 3 skipped contracts for debugging
                console.log(`⏭️ Skipped contract ${index + 1} for ${t} (no volume/OI):`, {
                  dayVolume,
                  openInterest: contract.open_interest,
                  lastPrice,
                });
              }
            }
          });
          
          console.log(`✅ Processed ${processedCount} trades from ${allContracts.length} contracts for ${t}`);
        } else {
          console.log(`⚠️ No results in response for ${t}`, {
            hasResults: !!response.data?.results,
            resultsLength: response.data?.results?.length || 0,
            responseKeys: Object.keys(response.data || {}),
          });
        }
      } catch (error) {
        console.error(`❌ Error fetching options chain for ${t}:`, error.message);
        if (error.response) {
          console.error('Response status:', error.response.status);
          console.error('Response headers:', error.response.headers);
          console.error('Response data:', JSON.stringify(error.response.data, null, 2));
        } else if (error.request) {
          console.error('No response received. Request details:', {
            url: error.config?.url,
            method: error.config?.method,
          });
        } else {
          console.error('Error setting up request:', error.message);
        }
        console.error('Full error:', error);
      }
    }

    console.log(`✅ REST fetch complete. Total trades in store: ${tradesStore.size}`);
    
    if (tradesStore.size === 0) {
      console.warn('⚠️ WARNING: No trades stored after REST fetch. Possible issues:');
      console.warn('  - API key may not have options data access');
      console.warn('  - Market may be closed (volume updates during market hours)');
      console.warn('  - Contracts may not meet filtering criteria');
      console.warn('  - Rate limit may have been exceeded');
    }
  } catch (error) {
    console.error('❌ Error in fetchOptionsFromREST:', error);
    console.error('Error stack:', error.stack);
  }
}

// POST /api/options-flow/refresh - Manually trigger a refresh
router.post('/refresh', async (req, res) => {
  try {
    console.log('🔄 Manual refresh triggered');
    await fetchOptionsFromREST();
    const count = tradesStore.size;
    res.json({
      success: true,
      message: `Refresh complete. ${count} trades in store.`,
      count: count,
    });
  } catch (error) {
    console.error('❌ Error in manual refresh:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to refresh',
      message: error.message,
    });
  }
});

// GET /api/options-flow/stats - Get flow statistics
router.get('/stats', async (req, res) => {
  try {
    console.log('📊 Stats request received');
    
    // If store is empty, try to fetch from REST
    if (tradesStore.size < 10) {
      console.log('📡 Store is empty, fetching from REST API for stats...');
      await fetchOptionsFromREST();
    }
    
    const allTrades = Array.from(tradesStore.values())
      .filter(trade => !Array.isArray(trade));

    console.log(`📊 Calculating stats from ${allTrades.length} trades`);

    const stats = {
      totalTrades: allTrades.length,
      totalPremium: allTrades.reduce((sum, t) => {
        const premium = t.premiumRaw || parseFloat(t.premium.replace(/[^0-9.]/g, '')) * 
          (t.premium.includes('M') ? 1000000 : (t.premium.includes('K') ? 1000 : 1));
        return sum + premium;
      }, 0),
      callSweeps: allTrades.filter(t => t.type === 'CALL').length,
      putSweeps: allTrades.filter(t => t.type === 'PUT').length,
      callPutRatio: allTrades.length > 0 
        ? ((allTrades.filter(t => t.type === 'CALL').length / allTrades.length) * 100).toFixed(0) + '%'
        : '0%',
      unusualActivity: allTrades.filter(t => t.size > 1000).length,
    };

    console.log('📊 Stats calculated:', stats);

    res.json({
      success: true,
      stats: {
        ...stats,
        totalPremium: formatPremium(stats.totalPremium),
      },
    });
  } catch (error) {
    console.error('❌ Error fetching stats:', error);
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
    console.error(`Error fetching options chain for ${ticker}:`, error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
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


async function calculateOTM(ticker, strike, type) {
  try {
    // Get current stock price
    const response = await axios.get(
      `https://api.massive.com/v2/aggs/ticker/${ticker}/prev`,
      {
        params: {
          apiKey: process.env.POLYGON_API_KEY, // Massive.com uses apiKey
        },
      }
    );
    
    const currentPrice = response.data.results?.[0]?.c;
    if (!currentPrice) return 'N/A';
    
    const otm = type === 'CALL' 
      ? ((strike - currentPrice) / currentPrice * 100)
      : ((currentPrice - strike) / currentPrice * 100);
    
    return `${otm >= 0 ? otm.toFixed(1) : Math.abs(otm).toFixed(1)}%`;
  } catch (error) {
    console.error(`Error calculating OTM for ${ticker}:`, error.message);
    return 'N/A';
  }
}

function calculateMoneyness(ticker, strike, type) {
  // This would need current price - simplified for now
  return 'OTM'; // or 'ITM' or 'ATM'
}

function classifyTradeType(trade) {
  // Simple classification - can be enhanced with flowAnalyzer.ts
  if (trade.size >= 1000) return 'BLOCK';
  if (trade.size >= 100) return 'SWEEP';
  return 'NORMAL';
}

function calculateDTE(expirationDate) {
  if (!expirationDate) return 'N/A';
  try {
    const today = new Date();
    const exp = new Date(expirationDate);
    const diffTime = exp.getTime() - today.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return diffDays > 0 ? `${diffDays}d` : '0d';
  } catch (error) {
    console.error('Error calculating DTE:', error);
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

