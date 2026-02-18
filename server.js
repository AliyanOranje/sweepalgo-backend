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
    // Support both env var names (live may use MASSIVE_API_KEY)
    const apiKey = process.env.POLYGON_API_KEY || process.env.MASSIVE_API_KEY;
    
    console.log(`📡 Fetching stock info for ${ticker}...`);

    const base = 'https://api.polygon.io';
    let tickerDetailsRes = null;
    let prevCloseRes = null;
    let snapshotRes = null;
    if (apiKey) {
      [tickerDetailsRes, prevCloseRes, snapshotRes] = await Promise.all([
        axios.get(`${base}/v3/reference/tickers/${ticker.toUpperCase()}`, { params: { apiKey } }).catch(err => { console.warn(`⚠️ Ticker details: ${err.message}`); return null; }),
        axios.get(`${base}/v2/aggs/ticker/${ticker.toUpperCase()}/prev`, { params: { adjusted: true, apiKey } }).catch(err => { console.warn(`⚠️ Prev close: ${err.message}`); return null; }),
        axios.get(`${base}/v2/snapshot/locale/us/markets/stocks/tickers/${ticker.toUpperCase()}`, { params: { apiKey } }).catch(err => { console.warn(`⚠️ Snapshot: ${err.message}`); return null; }),
      ]);
    } else {
      console.warn(`⚠️ POLYGON_API_KEY / MASSIVE_API_KEY not set — using Yahoo fallback for price/change`);
    }

    const details = tickerDetailsRes?.data?.results || {};
    const prevCloseData = prevCloseRes?.data?.results?.[0] || {};
    let rawSnapshot = snapshotRes?.data;
    let snapshot = rawSnapshot?.ticker || rawSnapshot?.results?.[0] || (rawSnapshot && typeof rawSnapshot.day === 'object' ? rawSnapshot : {}) || {};
    if (!snapshot.day && !snapshot.lastTrade && !snapshot.prevDay) {
      try {
        const altRes = await axios.get(`https://api.massive.com/v2/snapshot/locale/us/markets/stocks/tickers/${ticker.toUpperCase()}`, { params: { apiKey } });
        rawSnapshot = altRes?.data;
        snapshot = rawSnapshot?.ticker || rawSnapshot?.results?.[0] || (rawSnapshot && typeof rawSnapshot.day === 'object' ? rawSnapshot : {}) || {};
      } catch (e) {
        console.warn(`⚠️ Snapshot fallback (massive.com): ${e.message}`);
      }
    }

    console.log(`📊 Stock info ${ticker}:`, {
      snapshotStatus: snapshotRes?.status,
      snapshotHasTicker: !!rawSnapshot?.ticker,
      snapshotKeys: Object.keys(snapshot),
      dayC: snapshot.day?.c,
      prevDayC: snapshot.prevDay?.c,
      lastTradeP: snapshot.lastTrade?.p,
      aggsPrevC: prevCloseData?.c ?? prevCloseData?.close,
      apiChange: snapshot.todaysChange ?? snapshot.todays_change,
      apiChangePerc: snapshot.todaysChangePerc ?? snapshot.todays_change_perc,
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
    // PRICE DATA — Polygon/Massive only (snapshot + aggs/prev)
    // =====================================================================

    // --- Polygon/Massive only: snapshot (real-time) + aggs/prev (previous close) ---
    const snapDayClose = snapshot.day?.c ?? snapshot.day?.close ?? 0;
    const snapPrevDayClose = snapshot.prevDay?.c ?? snapshot.prevDay?.close ?? 0;
    const lastTradePrice = snapshot.lastTrade?.p ?? snapshot.lastTrade?.price ?? snapshot.last?.price ?? 0;
    // API may return camelCase or snake_case; coerce to number
    const snapTodaysChange = Number(snapshot.todaysChange ?? snapshot.todays_change);
    const snapTodaysChangePerc = Number(snapshot.todaysChangePerc ?? snapshot.todays_change_perc);

    const aggsPrevClose = prevCloseData.c ?? prevCloseData.close ?? 0;
    const aggsPrevOpen = prevCloseData.o ?? prevCloseData.open ?? 0;
    const aggsPrevHigh = prevCloseData.h ?? prevCloseData.high ?? 0;
    const aggsPrevLow = prevCloseData.l ?? prevCloseData.low ?? 0;
    const aggsPrevVolume = prevCloseData.v ?? prevCloseData.volume ?? 0;

    // Current price: snapshot day close or last trade, then aggs prev as fallback
    const currentPrice = snapDayClose || lastTradePrice || aggsPrevClose || 0;
    const previousClose = snapPrevDayClose || aggsPrevClose || 0;

    let finalChange = 0;
    let finalChangePerc = 0;
    const hasApiChange = Number.isFinite(snapTodaysChange) && Number.isFinite(snapTodaysChangePerc);
    if (hasApiChange) {
      finalChange = snapTodaysChange;
      finalChangePerc = snapTodaysChangePerc;
    }
    if (!hasApiChange && currentPrice > 0 && previousClose > 0) {
      finalChange = currentPrice - previousClose;
      finalChangePerc = (finalChange / previousClose) * 100;
    }

    // Fallback: when Polygon snapshot is not entitled (403) or returns no change, use Yahoo Finance
    let fallbackPrice = currentPrice;
    let fallbackPrevClose = previousClose;
    let fallbackChange = finalChange;
    let fallbackChangePerc = finalChangePerc;
    const needsFallback = (currentPrice === 0 && previousClose === 0) || (finalChange === 0 && finalChangePerc === 0 && currentPrice > 0 && previousClose > 0 && currentPrice === previousClose);
    if (needsFallback) {
      try {
        const yahooRes = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker.toUpperCase()}`, {
          params: { range: '5d', interval: '1d', includePrePost: false },
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
          timeout: 15000,
        });
        const meta = yahooRes?.data?.chart?.result?.[0]?.meta || {};
        const quotes = yahooRes?.data?.chart?.result?.[0]?.indicators?.quote?.[0] || {};
        const closes = quotes.close || [];
        let yPrice = meta.regularMarketPrice || 0;
        let yPrev = meta.previousClose || 0;
        if (closes.length >= 2) {
          let lastIdx = -1;
          for (let i = closes.length - 1; i >= 0; i--) {
            if (closes[i] != null && closes[i] > 0) { lastIdx = i; break; }
          }
          if (lastIdx >= 0) {
            if (!yPrice) yPrice = closes[lastIdx];
            if (lastIdx > 0 && !yPrev) {
              for (let i = lastIdx - 1; i >= 0; i--) {
                if (closes[i] != null && closes[i] > 0) { yPrev = closes[i]; break; }
              }
            }
          }
        }
        if (yPrice > 0 && yPrev > 0) {
          fallbackPrice = yPrice;
          fallbackPrevClose = yPrev;
          fallbackChange = yPrice - yPrev;
          fallbackChangePerc = (fallbackChange / yPrev) * 100;
          console.log(`📊 Stock info ${ticker}: using Yahoo fallback for price/change (Polygon snapshot not entitled or no change)`);
        }
      } catch (yahooErr) {
        console.warn(`⚠️ Yahoo fallback failed for ${ticker}:`, yahooErr.message);
      }
    }

    const useFallback = needsFallback && fallbackPrice > 0 && fallbackPrevClose > 0;
    const outPrice = useFallback ? fallbackPrice : currentPrice;
    const outPrevClose = useFallback ? fallbackPrevClose : previousClose;
    const outChange = useFallback ? fallbackChange : finalChange;
    const outChangePerc = useFallback ? fallbackChangePerc : finalChangePerc;

    const responseData = {
      success: true,
      ticker: ticker.toUpperCase(),
      name: details.name || ticker.toUpperCase(),
      exchange: details.primary_exchange || 'UNKNOWN',
      industry: simplifyIndustry(details.sic_description, details.type),
      type: details.type || 'STOCK',
      marketCap: formatMarketCap(details.market_cap),
      marketCapRaw: details.market_cap || null,
      price: outPrice,
      open: snapshot.day?.o || snapshot.day?.open || aggsPrevOpen || 0,
      high: snapshot.day?.h || snapshot.day?.high || aggsPrevHigh || 0,
      low: snapshot.day?.l || snapshot.day?.low || aggsPrevLow || 0,
      close: outPrice,
      volume: snapshot.day?.v || snapshot.day?.volume || aggsPrevVolume || 0,
      prevClose: outPrevClose,
      todaysChange: outChange,
      todaysChangePerc: outChangePerc,
      homepageUrl: details.homepage_url || null,
      totalEmployees: details.total_employees || null,
      listDate: details.list_date || null,
    };

    console.log(`✅ Stock info for ${ticker}:`, {
      price: responseData.price,
      prevClose: responseData.prevClose,
      change: responseData.todaysChange,
      changePerc: responseData.todaysChangePerc,
      source: useFallback ? 'yahoo_fallback' : 'polygon',
    });

    // Prevent caching so live clients always get fresh price/prevClose (avoids 304 reusing stale zeros)
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
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
