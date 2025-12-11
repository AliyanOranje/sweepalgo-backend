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
 * GET /api/options/bars/:contractId/range
 * Get custom bars (aggregates) for a contract
 * 
 * Params:
 * - contractId: e.g., O:SPY251219C00650000
 * 
 * Query params:
 * - multiplier: number (default: 1)
 * - timespan: minute|hour|day|week|month|quarter|year (default: day)
 * - from: YYYY-MM-DD (required)
 * - to: YYYY-MM-DD (required)
 * - adjusted: true|false (default: true)
 * - sort: asc|desc (default: asc)
 * - limit: number (default: 120)
 */
router.get('/:contractId/range', async (req, res) => {
  try {
    const apiKey = getApiKey();
    const { contractId } = req.params;
    const {
      multiplier = 1,
      timespan = 'day',
      from,
      to,
      adjusted = 'true',
      sort = 'asc',
      limit = 120,
    } = req.query;

    if (!from || !to) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters',
        message: 'Both "from" and "to" date parameters are required',
      });
    }

    console.log(`📡 Fetching bars for ${contractId} from ${from} to ${to}`);

    const response = await axios.get(
      `${MASSIVE_API_BASE}/v2/aggs/ticker/${contractId}/range/${multiplier}/${timespan}/${from}/${to}`,
      {
        params: {
          apiKey,
          adjusted,
          sort,
          limit: parseInt(limit),
        },
        timeout: 30000,
      }
    );

    res.json({
      success: true,
      data: response.data,
      contractId,
      count: response.data?.resultsCount || 0,
    });
  } catch (error) {
    console.error(`❌ Error fetching bars for ${req.params.contractId}:`, error.message);
    if (error.response) {
      res.status(error.response.status).json({
        success: false,
        error: 'Failed to fetch bars',
        message: error.response.data?.message || error.message,
        contractId: req.params.contractId,
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to fetch bars',
        message: error.message,
        contractId: req.params.contractId,
      });
    }
  }
});

/**
 * GET /api/options/bars/:contractId/daily/:date
 * Get daily ticker summary (OHLC) for a specific date
 * 
 * Params:
 * - contractId: e.g., O:SPY251219C00650000
 * - date: YYYY-MM-DD
 * 
 * Query params:
 * - adjusted: true|false (default: true)
 */
router.get('/:contractId/daily/:date', async (req, res) => {
  try {
    const apiKey = getApiKey();
    const { contractId, date } = req.params;
    const { adjusted = 'true' } = req.query;

    console.log(`📡 Fetching daily summary for ${contractId} on ${date}`);

    const response = await axios.get(
      `${MASSIVE_API_BASE}/v1/open-close/${contractId}/${date}`,
      {
        params: {
          apiKey,
          adjusted,
        },
        timeout: 30000,
      }
    );

    res.json({
      success: true,
      data: response.data,
      contractId,
      date,
    });
  } catch (error) {
    console.error(`❌ Error fetching daily summary for ${req.params.contractId}:`, error.message);
    if (error.response) {
      res.status(error.response.status).json({
        success: false,
        error: 'Failed to fetch daily summary',
        message: error.response.data?.message || error.message,
        contractId: req.params.contractId,
        date: req.params.date,
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to fetch daily summary',
        message: error.message,
        contractId: req.params.contractId,
        date: req.params.date,
      });
    }
  }
});

/**
 * GET /api/options/bars/:contractId/prev
 * Get previous day bar (OHLC)
 * 
 * Params:
 * - contractId: e.g., O:SPY251219C00650000
 * 
 * Query params:
 * - adjusted: true|false (default: true)
 */
router.get('/:contractId/prev', async (req, res) => {
  try {
    const apiKey = getApiKey();
    const { contractId } = req.params;
    const { adjusted = 'true' } = req.query;

    console.log(`📡 Fetching previous day bar for ${contractId}`);

    const response = await axios.get(
      `${MASSIVE_API_BASE}/v2/aggs/ticker/${contractId}/prev`,
      {
        params: {
          apiKey,
          adjusted,
        },
        timeout: 30000,
      }
    );

    res.json({
      success: true,
      data: response.data,
      contractId,
    });
  } catch (error) {
    console.error(`❌ Error fetching previous day bar for ${req.params.contractId}:`, error.message);
    if (error.response) {
      res.status(error.response.status).json({
        success: false,
        error: 'Failed to fetch previous day bar',
        message: error.response.data?.message || error.message,
        contractId: req.params.contractId,
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to fetch previous day bar',
        message: error.message,
        contractId: req.params.contractId,
      });
    }
  }
});

export default router;

