import express from 'express';
import axios from 'axios';

const router = express.Router();
const MASSIVE_API_BASE = 'https://api.massive.com';

// Helper function to get API key
const getApiKey = () => {
  const apiKey = process.env.MASSIVE_API_KEY || process.env.POLYGON_API_KEY;
  if (!apiKey) {
    throw new Error('MASSIVE_API_KEY or POLYGON_API_KEY not set in environment variables');
  }
  return apiKey;
};

/**
 * GET /api/options/indicators/sma/:contractId
 * Get Simple Moving Average (SMA) for a contract
 * 
 * Params:
 * - contractId: e.g., O:SPY241220P00720000
 * 
 * Query params:
 * - timespan: minute|hour|day|week|month|quarter|year (default: day)
 * - adjusted: true|false (default: true)
 * - window: number (default: 50)
 * - series_type: open|high|low|close|volume (default: close)
 * - order: asc|desc (default: desc)
 * - limit: number (default: 10)
 */
router.get('/sma/:contractId', async (req, res) => {
  try {
    const apiKey = getApiKey();
    const { contractId } = req.params;
    const {
      timespan = 'day',
      adjusted = 'true',
      window = 50,
      series_type = 'close',
      order = 'desc',
      limit = 10,
    } = req.query;

    console.log(`📡 Fetching SMA for ${contractId}`);

    const response = await axios.get(
      `${MASSIVE_API_BASE}/v1/indicators/sma/${contractId}`,
      {
        params: {
          apiKey,
          timespan,
          adjusted,
          window: parseInt(window),
          series_type,
          order,
          limit: parseInt(limit),
        },
        timeout: 30000,
      }
    );

    res.json({
      success: true,
      data: response.data,
      contractId,
      indicator: 'SMA',
    });
  } catch (error) {
    console.error(`❌ Error fetching SMA for ${req.params.contractId}:`, error.message);
    if (error.response) {
      res.status(error.response.status).json({
        success: false,
        error: 'Failed to fetch SMA',
        message: error.response.data?.message || error.message,
        contractId: req.params.contractId,
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to fetch SMA',
        message: error.message,
        contractId: req.params.contractId,
      });
    }
  }
});

/**
 * GET /api/options/indicators/ema/:contractId
 * Get Exponential Moving Average (EMA) for a contract
 */
router.get('/ema/:contractId', async (req, res) => {
  try {
    const apiKey = getApiKey();
    const { contractId } = req.params;
    const {
      timespan = 'day',
      adjusted = 'true',
      window = 50,
      series_type = 'close',
      order = 'desc',
      limit = 10,
    } = req.query;

    console.log(`📡 Fetching EMA for ${contractId}`);

    const response = await axios.get(
      `${MASSIVE_API_BASE}/v1/indicators/ema/${contractId}`,
      {
        params: {
          apiKey,
          timespan,
          adjusted,
          window: parseInt(window),
          series_type,
          order,
          limit: parseInt(limit),
        },
        timeout: 30000,
      }
    );

    res.json({
      success: true,
      data: response.data,
      contractId,
      indicator: 'EMA',
    });
  } catch (error) {
    console.error(`❌ Error fetching EMA for ${req.params.contractId}:`, error.message);
    if (error.response) {
      res.status(error.response.status).json({
        success: false,
        error: 'Failed to fetch EMA',
        message: error.response.data?.message || error.message,
        contractId: req.params.contractId,
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to fetch EMA',
        message: error.message,
        contractId: req.params.contractId,
      });
    }
  }
});

/**
 * GET /api/options/indicators/macd/:contractId
 * Get MACD (Moving Average Convergence Divergence) for a contract
 */
router.get('/macd/:contractId', async (req, res) => {
  try {
    const apiKey = getApiKey();
    const { contractId } = req.params;
    const {
      timespan = 'day',
      adjusted = 'true',
      short_window = 12,
      long_window = 26,
      signal_window = 9,
      series_type = 'close',
      order = 'desc',
      limit = 10,
    } = req.query;

    console.log(`📡 Fetching MACD for ${contractId}`);

    const response = await axios.get(
      `${MASSIVE_API_BASE}/v1/indicators/macd/${contractId}`,
      {
        params: {
          apiKey,
          timespan,
          adjusted,
          short_window: parseInt(short_window),
          long_window: parseInt(long_window),
          signal_window: parseInt(signal_window),
          series_type,
          order,
          limit: parseInt(limit),
        },
        timeout: 30000,
      }
    );

    res.json({
      success: true,
      data: response.data,
      contractId,
      indicator: 'MACD',
    });
  } catch (error) {
    console.error(`❌ Error fetching MACD for ${req.params.contractId}:`, error.message);
    if (error.response) {
      res.status(error.response.status).json({
        success: false,
        error: 'Failed to fetch MACD',
        message: error.response.data?.message || error.message,
        contractId: req.params.contractId,
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to fetch MACD',
        message: error.message,
        contractId: req.params.contractId,
      });
    }
  }
});

/**
 * GET /api/options/indicators/rsi/:contractId
 * Get RSI (Relative Strength Index) for a contract
 */
router.get('/rsi/:contractId', async (req, res) => {
  try {
    const apiKey = getApiKey();
    const { contractId } = req.params;
    const {
      timespan = 'day',
      adjusted = 'true',
      window = 14,
      series_type = 'close',
      order = 'desc',
      limit = 10,
    } = req.query;

    console.log(`📡 Fetching RSI for ${contractId}`);

    const response = await axios.get(
      `${MASSIVE_API_BASE}/v1/indicators/rsi/${contractId}`,
      {
        params: {
          apiKey,
          timespan,
          adjusted,
          window: parseInt(window),
          series_type,
          order,
          limit: parseInt(limit),
        },
        timeout: 30000,
      }
    );

    res.json({
      success: true,
      data: response.data,
      contractId,
      indicator: 'RSI',
    });
  } catch (error) {
    console.error(`❌ Error fetching RSI for ${req.params.contractId}:`, error.message);
    if (error.response) {
      res.status(error.response.status).json({
        success: false,
        error: 'Failed to fetch RSI',
        message: error.response.data?.message || error.message,
        contractId: req.params.contractId,
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to fetch RSI',
        message: error.message,
        contractId: req.params.contractId,
      });
    }
  }
});

export default router;

