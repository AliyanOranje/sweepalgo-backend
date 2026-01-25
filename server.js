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
// Note: ThriveCart webhook handles its own body parsing
app.use(express.json());

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
    
    // Fetch ticker details, previous close, and snapshot in parallel
    const [tickerDetailsRes, prevCloseRes, snapshotRes] = await Promise.all([
      // Get company info (name, exchange, industry, market cap) - Massive.com API
      axios.get(`https://api.massive.com/v3/reference/tickers/${ticker.toUpperCase()}`, {
        params: { apiKey }
      }).catch(err => {
        console.warn(`⚠️ Could not fetch ticker details: ${err.message}`);
        return null;
      }),
      // Get previous close for price change calculation
      axios.get(`https://api.massive.com/v2/aggs/ticker/${ticker.toUpperCase()}/prev`, {
        params: { adjusted: true, apiKey }
      }).catch(err => {
        console.warn(`⚠️ Could not fetch prev close: ${err.message}`);
        return null;
      }),
      // Get stock snapshot for real-time data including today's change
      axios.get(`https://api.massive.com/v2/snapshot/locale/us/markets/stocks/tickers/${ticker.toUpperCase()}`, {
        params: { apiKey }
      }).catch(err => {
        console.warn(`⚠️ Could not fetch snapshot: ${err.message}`);
        return null;
      })
    ]);

    // Extract ticker details
    const details = tickerDetailsRes?.data?.results || {};
    const prevClose = prevCloseRes?.data?.results?.[0] || {};
    const snapshot = snapshotRes?.data?.ticker || {};

    console.log(`📊 Raw data for ${ticker}:`, {
      hasDetails: !!tickerDetailsRes?.data?.results,
      hasPrevClose: !!prevCloseRes?.data?.results?.[0],
      hasSnapshot: !!snapshotRes?.data?.ticker,
      detailsName: details.name,
      prevClosePrice: prevClose.c,
      snapshotData: snapshot
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

    // Get price data from snapshot (most accurate for real-time)
    // Snapshot has: day (today's OHLCV), prevDay (yesterday's OHLCV), todaysChange, todaysChangePerc
    const todaysChange = snapshot.todaysChange || 0;
    const todaysChangePerc = snapshot.todaysChangePerc || 0;
    const currentPrice = snapshot.day?.c || snapshot.lastTrade?.p || prevClose.c || 0;
    const previousClose = snapshot.prevDay?.c || prevClose.c || 0;

    const responseData = {
      success: true,
      ticker: ticker.toUpperCase(),
      name: details.name || ticker.toUpperCase(),
      exchange: details.primary_exchange || 'UNKNOWN',
      industry: simplifyIndustry(details.sic_description, details.type),
      type: details.type || 'STOCK',
      marketCap: formatMarketCap(details.market_cap),
      marketCapRaw: details.market_cap || null,
      // Price data - prefer snapshot for real-time accuracy
      price: currentPrice,
      open: snapshot.day?.o || prevClose.o || 0,
      high: snapshot.day?.h || prevClose.h || 0,
      low: snapshot.day?.l || prevClose.l || 0,
      close: currentPrice,
      volume: snapshot.day?.v || prevClose.v || 0,
      prevClose: previousClose,
      // Today's change (from snapshot if available)
      todaysChange: todaysChange,
      todaysChangePerc: todaysChangePerc,
      // Additional info
      homepageUrl: details.homepage_url || null,
      totalEmployees: details.total_employees || null,
      listDate: details.list_date || null,
    };

    console.log(`✅ Stock info fetched for ${ticker}:`, {
      name: responseData.name,
      exchange: responseData.exchange,
      industry: responseData.industry,
      marketCap: responseData.marketCap,
      price: responseData.price,
      prevClose: responseData.prevClose,
      change: responseData.todaysChange,
      changePerc: responseData.todaysChangePerc
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
