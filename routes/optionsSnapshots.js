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
 * GET /api/options/snapshots/contract/:contractId
 * Get option contract snapshot
 * 
 * Params:
 * - ticker: underlying ticker (e.g., A)
 * - contractId: contract identifier (e.g., O:A250815C00055000)
 */
router.get('/contract/:ticker/:contractId', async (req, res) => {
  try {
    const apiKey = getApiKey();
    const { ticker, contractId } = req.params;

    console.log(`📡 Fetching contract snapshot for ${ticker}/${contractId}`);

    const response = await axios.get(
      `${MASSIVE_API_BASE}/v3/snapshot/options/${ticker}/${contractId}`,
      {
        params: { apiKey },
        timeout: 30000,
      }
    );

    res.json({
      success: true,
      data: response.data,
      ticker,
      contractId,
    });
  } catch (error) {
    console.error(`❌ Error fetching contract snapshot:`, error.message);
    if (error.response) {
      res.status(error.response.status).json({
        success: false,
        error: 'Failed to fetch contract snapshot',
        message: error.response.data?.message || error.message,
        ticker: req.params.ticker,
        contractId: req.params.contractId,
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to fetch contract snapshot',
        message: error.message,
        ticker: req.params.ticker,
        contractId: req.params.contractId,
      });
    }
  }
});

/**
 * GET /api/options/snapshots/chain/:ticker
 * Get option chain snapshot for an underlying ticker
 * 
 * Params:
 * - ticker: underlying ticker (e.g., A)
 * 
 * Query params:
 * - order: asc|desc (default: asc)
 * - limit: number (default: 10)
 * - sort: field to sort by (default: ticker)
 */
router.get('/chain/:ticker', async (req, res) => {
  try {
    const apiKey = getApiKey();
    const { ticker } = req.params;
    const {
      order = 'asc',
      limit = 10,
      sort = 'ticker',
    } = req.query;

    console.log(`📡 Fetching chain snapshot for ${ticker}`);

    const response = await axios.get(
      `${MASSIVE_API_BASE}/v3/snapshot/options/${ticker}`,
      {
        params: {
          apiKey,
          order,
          limit: parseInt(limit),
          sort,
        },
        timeout: 30000,
      }
    );

    res.json({
      success: true,
      data: response.data,
      ticker,
      count: response.data?.results?.length || 0,
    });
  } catch (error) {
    console.error(`❌ Error fetching chain snapshot for ${req.params.ticker}:`, error.message);
    if (error.response) {
      res.status(error.response.status).json({
        success: false,
        error: 'Failed to fetch chain snapshot',
        message: error.response.data?.message || error.message,
        ticker: req.params.ticker,
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to fetch chain snapshot',
        message: error.message,
        ticker: req.params.ticker,
      });
    }
  }
});

/**
 * GET /api/options/snapshots/unified
 * Get unified snapshot
 * 
 * Query params:
 * - ticker: contract ticker (e.g., O:A250815C00055000)
 * - order: asc|desc (default: asc)
 * - limit: number (default: 10)
 * - sort: field to sort by (default: ticker)
 */
router.get('/unified', async (req, res) => {
  try {
    const apiKey = getApiKey();
    const {
      ticker,
      order = 'asc',
      limit = 10,
      sort = 'ticker',
    } = req.query;

    if (!ticker) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameter',
        message: 'ticker parameter is required',
      });
    }

    console.log(`📡 Fetching unified snapshot for ${ticker}`);

    const response = await axios.get(
      `${MASSIVE_API_BASE}/v3/snapshot`,
      {
        params: {
          apiKey,
          ticker,
          order,
          limit: parseInt(limit),
          sort,
        },
        timeout: 30000,
      }
    );

    res.json({
      success: true,
      data: response.data,
      ticker,
    });
  } catch (error) {
    console.error(`❌ Error fetching unified snapshot:`, error.message);
    if (error.response) {
      res.status(error.response.status).json({
        success: false,
        error: 'Failed to fetch unified snapshot',
        message: error.response.data?.message || error.message,
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to fetch unified snapshot',
        message: error.message,
      });
    }
  }
});

export default router;

