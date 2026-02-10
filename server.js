import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import optionsFlowRouter from './routes/optionsFlow.js';
import optionsContractsRouter from './routes/optionsContracts.js';
import optionsBarsRouter from './routes/optionsBars.js';
import optionsSnapshotsRouter from './routes/optionsSnapshots.js';
import optionsTradesRouter from './routes/optionsTrades.js';
import optionsQuotesRouter from './routes/optionsQuotes.js';
import optionsIndicatorsRouter from './routes/optionsIndicators.js';
import optionsMetadataRouter from './routes/optionsMetadata.js';
import gexRouter from './routes/gex.js';
import liveScannerRouter from './routes/liveScanner.js';
import thrivecartWebhookRouter from './routes/thrivecartWebhook.js';
import authRouter from './routes/auth.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Determine allowed origins for CORS
const getAllowedOrigins = () => {
  const origins = [];
  
  // Add frontend URL from environment (for production)
  if (process.env.FRONTEND_URL) {
    origins.push(process.env.FRONTEND_URL);
  }
  
  // Add localhost for development
  if (NODE_ENV === 'development') {
    origins.push('http://localhost:3000');
    origins.push('http://127.0.0.1:3000');
  }
  
  return origins.length > 0 ? origins : ['http://localhost:3000'];
};

const allowedOrigins = getAllowedOrigins();

// CORS configuration
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) !== -1 || NODE_ENV === 'development') {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Parse JSON for API routes
// SKIP body parsing for ThriveCart webhook - it needs the raw body for signature verification
app.use((req, res, next) => {
  const path = (req.originalUrl || req.url || '').split('?')[0];
  if (path.startsWith('/api/thrivecart') || path.startsWith('/webhook')) {
    return next();
  }
  express.json()(req, res, next);
});

// Log environment configuration
console.log('🔧 Backend Configuration:', {
  nodeEnv: NODE_ENV,
  port: PORT,
  frontendUrl: process.env.FRONTEND_URL || 'Not set (using localhost)',
  allowedOrigins: allowedOrigins,
  polygonApiKey: process.env.POLYGON_API_KEY ? '✅ Set' : '❌ Missing',
  supabaseUrl: process.env.SUPABASE_URL ? '✅ Set' : '❌ Missing',
  supabaseServiceRole: process.env.SUPABASE_SERVICE_ROLE_KEY ? '✅ Set' : '❌ Missing',
  thrivecartOrderValidSecret: process.env.THRIVECART_ORDERVALID_SECRET ? '✅ Set' : '❌ Missing',
  thrivecartApi: process.env.THRIVECART_API ? '✅ Set' : '❌ Missing',
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    service: 'SweepAlgo Backend API',
  });
});

// API Routes
app.use('/api/options-flow', optionsFlowRouter);
app.use('/api/options/contracts', optionsContractsRouter);
app.use('/api/options/bars', optionsBarsRouter);
app.use('/api/options/snapshots', optionsSnapshotsRouter);
app.use('/api/options/trades', optionsTradesRouter);
app.use('/api/options/quotes', optionsQuotesRouter);
app.use('/api/options/indicators', optionsIndicatorsRouter);
app.use('/api/options/metadata', optionsMetadataRouter);
app.use('/api/gex', gexRouter);
app.use('/api/live-scanner', liveScannerRouter);

// ThriveCart webhook - IMPORTANT: Must use raw body for signature verification
// The webhook endpoint handles its own body parsing
app.use('/api/thrivecart', thrivecartWebhookRouter);

// Also mount at /webhook for compatibility with some webhook providers
app.use('/webhook', thrivecartWebhookRouter);

// Authentication routes
app.use('/api/auth', authRouter);
// Stock ticker info endpoint - fetches company details and price data using Massive.com API
app.get('/api/stock/:ticker/info', async (req, res) => {
  try {
    const { ticker } = req.params;
    const axios = (await import('axios')).default;
    const apiKey = process.env.POLYGON_API_KEY;
    
    console.log(`📡 Fetching stock info for ${ticker}...`);
    
    // Fetch ticker details, previous close, stock snapshot, AND Yahoo Finance (fallback) in parallel
    // Massive.com = Polygon.io (same service, rebranded)
    const [tickerDetailsRes, prevCloseRes, snapshotRes, yahooRes] = await Promise.all([
      // 1. Company info (name, exchange, industry, market cap)
      axios.get(`https://api.massive.com/v3/reference/tickers/${ticker.toUpperCase()}`, {
        params: { apiKey }
      }).catch(err => {
        console.warn(`⚠️ Could not fetch ticker details: ${err.message}`);
        return null;
      }),
      // 2. Previous close from aggs endpoint
      axios.get(`https://api.massive.com/v2/aggs/ticker/${ticker.toUpperCase()}/prev`, {
        params: { adjusted: true, apiKey }
      }).catch(err => {
        console.warn(`⚠️ Could not fetch prev close from Massive: ${err.message}`);
        return null;
      }),
      // 3. Stock snapshot for real-time data including today's change
      axios.get(`https://api.massive.com/v2/snapshot/locale/us/markets/stocks/tickers/${ticker.toUpperCase()}`, {
        params: { apiKey }
      }).catch(err => {
        console.warn(`⚠️ Could not fetch snapshot from Massive: ${err.message}`);
        return null;
      }),
      // 4. Yahoo Finance fallback - always returns price change data, no API key needed
      axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker.toUpperCase()}`, {
        params: { range: '2d', interval: '1d', includePrePost: false },
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        timeout: 5000,
      }).catch(err => {
        console.warn(`⚠️ Could not fetch Yahoo Finance data: ${err.message}`);
        return null;
      })
    ]);

    // Extract ticker details
    const details = tickerDetailsRes?.data?.results || {};
    const prevCloseData = prevCloseRes?.data?.results?.[0] || {};
    const snapshot = snapshotRes?.data?.ticker || {};
    
    // Extract Yahoo Finance data (most reliable fallback for price change)
    const yahooMeta = yahooRes?.data?.chart?.result?.[0]?.meta || {};
    const yahooQuotes = yahooRes?.data?.chart?.result?.[0]?.indicators?.quote?.[0] || {};
    const yahooTimestamps = yahooRes?.data?.chart?.result?.[0]?.timestamp || [];

    console.log(`📊 Raw data sources for ${ticker}:`, {
      hasDetails: !!tickerDetailsRes?.data?.results,
      hasPrevClose: !!prevCloseRes?.data?.results?.[0],
      hasSnapshot: !!snapshotRes?.data?.ticker,
      hasYahoo: !!yahooRes?.data?.chart?.result?.[0],
      prevCloseFields: Object.keys(prevCloseData),
      snapshotFields: Object.keys(snapshot),
      yahooPreviousClose: yahooMeta.previousClose,
      yahooChartPreviousClose: yahooMeta.chartPreviousClose,
      yahooRegularMarketPrice: yahooMeta.regularMarketPrice,
      yahooCloseArray: yahooQuotes.close,
    });

    // Format market cap
    const formatMarketCap = (value) => {
      if (!value) return 'N/A';
      if (value >= 1e12) return `$${(value / 1e12).toFixed(2)}T`;
      if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
      if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
      return `$${value.toLocaleString()}`;
    };

    // Simplify industry from SIC description
    const simplifyIndustry = (sicDescription, type) => {
      if (!sicDescription) {
        if (type === 'ETF') return 'ETF';
        return 'UNKNOWN';
      }
      const desc = sicDescription.toUpperCase();
      if (desc.includes('SOFTWARE')) return 'SOFTWARE';
      if (desc.includes('SEMICONDUCTOR')) return 'SEMICONDUCTORS';
      if (desc.includes('COMPUTER') && desc.includes('STORAGE')) return 'DATA STORAGE';
      if (desc.includes('COMPUTER')) return 'TECHNOLOGY';
      if (desc.includes('ELECTRONIC')) return 'ELECTRONICS';
      if (desc.includes('RETAIL')) return 'RETAIL';
      if (desc.includes('MOTOR VEHICLE')) return 'AUTOMOTIVE';
      if (desc.includes('PHARMACEUTICAL')) return 'PHARMACEUTICALS';
      if (desc.includes('BANK')) return 'BANKING';
      if (desc.includes('INSURANCE')) return 'INSURANCE';
      if (desc.includes('OIL') || desc.includes('GAS')) return 'ENERGY';
      if (desc.includes('TELECOMMUNICATION')) return 'TELECOM';
      if (desc.includes('AEROSPACE')) return 'AEROSPACE';
      if (desc.includes('FOOD')) return 'FOOD & BEVERAGE';
      if (desc.includes('SERVICES')) return 'SERVICES';
      return sicDescription.split(' ').slice(0, 2).join(' ').toUpperCase();
    };

    // =====================================================================
    // PRICE DATA EXTRACTION - Multi-source with fallback chain
    // Priority: Massive/Polygon snapshot > Massive/Polygon aggs > Yahoo Finance
    // =====================================================================

    // --- Source 1: Massive/Polygon stock snapshot (best: real-time + change data) ---
    const snapDayClose = snapshot.day?.c || snapshot.day?.close || 0;
    const snapPrevDayClose = snapshot.prevDay?.c || snapshot.prevDay?.close || 0;
    const lastTradePrice = snapshot.lastTrade?.p || snapshot.lastTrade?.price || snapshot.last?.price || 0;
    const snapTodaysChange = snapshot.todaysChange || snapshot.todays_change || 0;
    const snapTodaysChangePerc = snapshot.todaysChangePerc || snapshot.todays_change_perc || 0;

    // --- Source 2: Massive/Polygon aggs/prev (previous day OHLCV) ---
    const aggsPrevClose = prevCloseData.c || prevCloseData.close || 0;
    const aggsPrevOpen = prevCloseData.o || prevCloseData.open || 0;
    const aggsPrevHigh = prevCloseData.h || prevCloseData.high || 0;
    const aggsPrevLow = prevCloseData.l || prevCloseData.low || 0;
    const aggsPrevVolume = prevCloseData.v || prevCloseData.volume || 0;

    // --- Source 3: Yahoo Finance (always available, reliable fallback) ---
    // IMPORTANT: Only use yahooMeta.previousClose (yesterday's close).
    // DO NOT use chartPreviousClose - that's the close from BEFORE the chart range
    // (e.g., 5+ trading days ago with range=5d), NOT yesterday's close.
    const yahooPrevClose = yahooMeta.previousClose || 0;
    const yahooCurrentPrice = yahooMeta.regularMarketPrice || 0;
    // Fallback: calculate previous close from the daily quotes array
    // The array is ordered chronologically: [..., 2_days_ago, yesterday, today]
    // We want yesterday's close = second-to-last non-null value
    let yahooCalculatedPrevClose = 0;
    if (yahooQuotes.close && yahooQuotes.close.length >= 2) {
      // Find the last non-null close (today or most recent)
      let lastIdx = -1;
      for (let i = yahooQuotes.close.length - 1; i >= 0; i--) {
        if (yahooQuotes.close[i] != null) {
          lastIdx = i;
          break;
        }
      }
      // Find the second-to-last non-null close (previous trading day)
      if (lastIdx > 0) {
        for (let i = lastIdx - 1; i >= 0; i--) {
          if (yahooQuotes.close[i] != null) {
            yahooCalculatedPrevClose = yahooQuotes.close[i];
            break;
          }
        }
      }
    }

    // =====================================================================
    // RESOLVE FINAL VALUES using priority chain
    // =====================================================================

    // Previous close: snapshot.prevDay > aggs/prev > Yahoo meta > Yahoo quotes
    const previousClose = snapPrevDayClose || aggsPrevClose || yahooPrevClose || yahooCalculatedPrevClose || 0;

    // Current price: snapshot.day > snapshot.lastTrade > Yahoo meta > aggs/prev (stale fallback)
    const currentPrice = snapDayClose || lastTradePrice || yahooCurrentPrice || aggsPrevClose || 0;

    // Today's change: snapshot direct > calculate from currentPrice vs previousClose
    let finalChange = snapTodaysChange;
    let finalChangePerc = snapTodaysChangePerc;

    // If snapshot didn't provide change, calculate it ourselves
    if (finalChange === 0 && finalChangePerc === 0 && currentPrice > 0 && previousClose > 0 && currentPrice !== previousClose) {
      finalChange = currentPrice - previousClose;
      finalChangePerc = (finalChange / previousClose) * 100;
    }

    const responseData = {
      success: true,
      ticker: ticker.toUpperCase(),
      name: details.name || ticker.toUpperCase(),
      exchange: details.primary_exchange || 'UNKNOWN',
      industry: simplifyIndustry(details.sic_description, details.type),
      type: details.type || 'STOCK',
      marketCap: formatMarketCap(details.market_cap),
      marketCapRaw: details.market_cap || null,
      // Price data
      price: currentPrice,
      open: snapshot.day?.o || snapshot.day?.open || aggsPrevOpen || 0,
      high: snapshot.day?.h || snapshot.day?.high || aggsPrevHigh || 0,
      low: snapshot.day?.l || snapshot.day?.low || aggsPrevLow || 0,
      close: currentPrice,
      volume: snapshot.day?.v || snapshot.day?.volume || aggsPrevVolume || 0,
      prevClose: previousClose,
      // Today's change
      todaysChange: finalChange,
      todaysChangePerc: finalChangePerc,
      // Additional info
      homepageUrl: details.homepage_url || null,
      totalEmployees: details.total_employees || null,
      listDate: details.list_date || null,
    };

    console.log(`✅ Stock info for ${ticker}:`, {
      price: responseData.price,
      prevClose: responseData.prevClose,
      change: responseData.todaysChange,
      changePerc: responseData.todaysChangePerc,
      dataSources: {
        snapshot: !!snapshotRes?.data?.ticker ? 'YES' : 'NO',
        aggsPrev: !!prevCloseRes?.data?.results?.[0] ? 'YES' : 'NO',
        yahoo: !!yahooRes?.data?.chart?.result?.[0] ? 'YES' : 'NO',
        prevCloseFrom: snapPrevDayClose ? 'snapshot' : aggsPrevClose ? 'aggs' : yahooPrevClose ? 'yahoo-meta' : yahooCalculatedPrevClose ? 'yahoo-quotes' : 'NONE',
        currentPriceFrom: snapDayClose ? 'snapshot' : lastTradePrice ? 'lastTrade' : yahooCurrentPrice ? 'yahoo' : aggsPrevClose ? 'aggs(stale)' : 'NONE',
      }
    });

    res.json(responseData);
  } catch (error) {
    console.error(`❌ Error fetching stock info for ${req.params.ticker}:`, error.message);
    res.status(500).json({
      success: false,
      ticker: req.params.ticker.toUpperCase(),
      error: 'Failed to fetch stock info',
      message: error.message,
      // Return fallback data
      name: req.params.ticker.toUpperCase(),
      exchange: 'UNKNOWN',
      industry: 'UNKNOWN',
      marketCap: 'N/A',
      price: 0,
      prevClose: 0,
      todaysChange: 0,
      todaysChangePerc: 0,
    });
  }
});

// Options chain endpoint
app.get('/api/options-chain/:ticker', async (req, res) => {
  try {
    const { ticker } = req.params;
    const axios = (await import('axios')).default;
    
    console.log(`📡 Fetching options chain for ${ticker}...`);
    
    const response = await axios.get(
      `https://api.massive.com/v3/snapshot/options/${ticker.toUpperCase()}`,
      {
        params: {
          apiKey: process.env.POLYGON_API_KEY, // Massive.com uses apiKey
        },
      }
    );

    console.log(`✅ Options chain fetched: ${response.data?.results?.length || 0} contracts`);

    res.json({
      success: true,
      ticker: ticker.toUpperCase(),
      data: response.data,
    });
  } catch (error) {
    console.error('❌ Error fetching options chain:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
    res.status(500).json({
      success: false,
      error: 'Failed to fetch options chain',
      message: error.message,
    });
  }
});

// GEX endpoint is now handled by gexRouter

// WebSocket server for real-time data
const server = createServer(app);
const wss = new WebSocketServer({ 
  server,
  path: '/ws', // BUG #16 FIX: Set WebSocket path
});

// Store connected clients and their subscriptions
const clients = new Set();
const clientSubscriptions = new Map(); // Map<WebSocket, Set<ticker>>

// BUG #16 FIX: Function to broadcast trade updates to subscribed clients
function broadcastTradeUpdate(trade) {
  const message = JSON.stringify({
    type: 'options-trade',
    data: trade,
    timestamp: new Date().toISOString(),
  });
  
  clients.forEach((client) => {
    if (client.readyState === 1) { // WebSocket.OPEN
      const subscriptions = clientSubscriptions.get(client) || new Set();
      // If no specific ticker subscription, send all trades
      // If subscribed to specific ticker, only send matching trades
      if (subscriptions.size === 0 || subscriptions.has(trade.ticker) || subscriptions.has('*')) {
        try {
          client.send(message);
        } catch (error) {
          console.error('Error sending WebSocket message:', error);
        }
      }
    }
  });
}

// Make broadcastTradeUpdate available globally for optionsFlow route
global.broadcastTradeUpdate = broadcastTradeUpdate;

// Store GEX subscriptions (ticker -> Set<WebSocket>)
const gexSubscriptions = new Map(); // Map<ticker, Set<WebSocket>>

// Function to broadcast GEX updates to subscribed clients
function broadcastGEXUpdate(ticker, gexData) {
  const message = JSON.stringify({
    type: 'gex-update',
    ticker: ticker.toUpperCase(),
    data: gexData,
    timestamp: new Date().toISOString(),
  });
  
  const subscribers = gexSubscriptions.get(ticker.toUpperCase()) || new Set();
  subscribers.forEach((client) => {
    if (client.readyState === 1) { // WebSocket.OPEN
      try {
        client.send(message);
      } catch (error) {
        console.error('Error sending GEX WebSocket message:', error);
      }
    }
  });
}

// Make broadcastGEXUpdate available globally
global.broadcastGEXUpdate = broadcastGEXUpdate;

wss.on('connection', (ws) => {
  console.log('✅ Client connected to WebSocket');
  clients.add(ws);
  clientSubscriptions.set(ws, new Set());
  
  // Send welcome message
  ws.send(JSON.stringify({
    type: 'connected',
    message: 'Connected to SweepAlgo WebSocket',
    timestamp: new Date().toISOString(),
  }));
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      console.log('Received from client:', data);
      
      // BUG #16 FIX: Handle subscriptions
      if (data.type === 'subscribe') {
        if (data.channel === 'options-flow') {
          ws.send(JSON.stringify({
            type: 'subscribed',
            channel: 'options-flow',
            message: 'Subscribed to options flow updates',
          }));
        } else if (data.channel === 'gex' && data.ticker) {
          // Subscribe to GEX updates for specific ticker
          const ticker = data.ticker.toUpperCase();
          if (!gexSubscriptions.has(ticker)) {
            gexSubscriptions.set(ticker, new Set());
          }
          gexSubscriptions.get(ticker).add(ws);
          
          ws.send(JSON.stringify({
            type: 'subscribed',
            channel: 'gex',
            ticker: ticker,
            message: `Subscribed to GEX updates for ${ticker}`,
          }));
        }
      }
      
      // Handle unsubscriptions
      if (data.type === 'unsubscribe') {
        if (data.channel === 'gex' && data.ticker) {
          const ticker = data.ticker.toUpperCase();
          const subscribers = gexSubscriptions.get(ticker);
          if (subscribers) {
            subscribers.delete(ws);
            if (subscribers.size === 0) {
              gexSubscriptions.delete(ticker);
            }
          }
        }
      }
      
      // BUG #2 FIX: Handle ticker-specific subscriptions
      if (data.type === 'subscribe-ticker') {
        const ticker = data.ticker?.toUpperCase();
        const subscriptions = clientSubscriptions.get(ws) || new Set();
        
        if (ticker) {
          subscriptions.add(ticker);
          clientSubscriptions.set(ws, subscriptions);
          ws.send(JSON.stringify({
            type: 'subscribed-ticker',
            ticker: ticker,
            message: `Subscribed to ${ticker} options flow`,
          }));
          console.log(`📡 Client subscribed to ticker: ${ticker}`);
        } else {
          // Subscribe to all tickers
          subscriptions.add('*');
          clientSubscriptions.set(ws, subscriptions);
          ws.send(JSON.stringify({
            type: 'subscribed-ticker',
            ticker: '*',
            message: 'Subscribed to all tickers',
          }));
        }
      }
      
      // BUG #2 FIX: Handle ticker unsubscriptions
      if (data.type === 'unsubscribe-ticker') {
        const ticker = data.ticker?.toUpperCase();
        const subscriptions = clientSubscriptions.get(ws) || new Set();
        
        if (ticker) {
          subscriptions.delete(ticker);
          subscriptions.delete('*');
          clientSubscriptions.set(ws, subscriptions);
          ws.send(JSON.stringify({
            type: 'unsubscribed-ticker',
            ticker: ticker,
            message: `Unsubscribed from ${ticker}`,
          }));
        }
      }
    } catch (error) {
      console.error('Error parsing client message:', error);
    }
  });
  
  ws.on('close', () => {
    console.log('❌ Client disconnected from WebSocket');
    clients.delete(ws);
    clientSubscriptions.delete(ws);
    
    // Remove from GEX subscriptions
    gexSubscriptions.forEach((subscribers, ticker) => {
      subscribers.delete(ws);
      if (subscribers.size === 0) {
        gexSubscriptions.delete(ticker);
      }
    });
  });
  
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    clients.delete(ws);
    clientSubscriptions.delete(ws);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 SweepAlgo Backend API running on port ${PORT}`);
  console.log(`🌍 Environment: ${NODE_ENV}`);
  console.log(`📡 WebSocket server ready`);
  console.log(`🔑 Polygon.io API key: ${process.env.POLYGON_API_KEY ? '✅ Set' : '❌ Missing'}`);
  console.log(`🌐 Allowed origins: ${allowedOrigins.join(', ')}`);
  
  if (NODE_ENV === 'production') {
    console.log(`✅ Production mode - CORS enabled for: ${process.env.FRONTEND_URL || 'Not configured'}`);
  } else {
    console.log(`🔧 Development mode - CORS enabled for localhost`);
  }
});
