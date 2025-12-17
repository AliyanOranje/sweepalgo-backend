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

app.use(express.json());

// Log environment configuration
console.log('🔧 Backend Configuration:', {
  nodeEnv: NODE_ENV,
  port: PORT,
  frontendUrl: process.env.FRONTEND_URL || 'Not set (using localhost)',
  allowedOrigins: allowedOrigins,
  polygonApiKey: process.env.POLYGON_API_KEY ? '✅ Set' : '❌ Missing',
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
      if (data.type === 'subscribe' && data.channel === 'options-flow') {
        ws.send(JSON.stringify({
          type: 'subscribed',
          channel: 'options-flow',
          message: 'Subscribed to options flow updates',
        }));
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
