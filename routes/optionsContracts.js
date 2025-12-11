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
 * GET /api/options/contracts
 * Get all options contracts with filtering and pagination
 * 
 * Query params:
 * - order: asc|desc (default: asc)
 * - limit: number (default: 10)
 * - sort: field to sort by (default: ticker)
 * - ticker: filter by underlying ticker
 * - contract_type: CALL|PUT
 * - expiration_date: YYYY-MM-DD
 * - strike_price: number
 * - expiration_date.gte: YYYY-MM-DD
 * - expiration_date.lte: YYYY-MM-DD
 * - strike_price.gte: number
 * - strike_price.lte: number
 */
router.get('/', async (req, res) => {
  try {
    const apiKey = getApiKey();
    const {
      order = 'asc',
      limit = 10,
      sort = 'ticker',
      ticker,
      contract_type,
      expiration_date,
      strike_price,
      ...otherParams
    } = req.query;

    const params = {
      apiKey,
      order,
      limit: parseInt(limit),
      sort,
      ...(ticker && { underlying_ticker: ticker }),
      ...(contract_type && { contract_type }),
      ...(expiration_date && { expiration_date }),
      ...(strike_price && { strike_price }),
      ...otherParams, // Support for .gte, .lte filters
    };

    console.log('📡 Fetching all contracts:', params);

    const response = await axios.get(`${MASSIVE_API_BASE}/v3/reference/options/contracts`, {
      params,
      timeout: 30000,
    });

    res.json({
      success: true,
      data: response.data,
      count: response.data?.results?.length || 0,
      status: response.data?.status,
      request_id: response.data?.request_id,
    });
  } catch (error) {
    console.error('❌ Error fetching contracts:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
      res.status(error.response.status).json({
        success: false,
        error: 'Failed to fetch contracts',
        message: error.response.data?.message || error.message,
        status: error.response.status,
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to fetch contracts',
        message: error.message,
      });
    }
  }
});

/**
 * GET /api/options/contracts/:contractId
 * Get contract overview for a specific contract
 * 
 * Params:
 * - contractId: e.g., O:SPY251219C00650000
 */
router.get('/:contractId', async (req, res) => {
  try {
    const apiKey = getApiKey();
    const { contractId } = req.params;

    console.log(`📡 Fetching contract overview for ${contractId}`);

    const response = await axios.get(
      `${MASSIVE_API_BASE}/v3/reference/options/contracts/${contractId}`,
      {
        params: { apiKey },
        timeout: 30000,
      }
    );

    res.json({
      success: true,
      data: response.data,
      contractId,
    });
  } catch (error) {
    console.error(`❌ Error fetching contract ${req.params.contractId}:`, error.message);
    if (error.response) {
      res.status(error.response.status).json({
        success: false,
        error: 'Failed to fetch contract',
        message: error.response.data?.message || error.message,
        contractId: req.params.contractId,
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to fetch contract',
        message: error.message,
        contractId: req.params.contractId,
      });
    }
  }
});

export default router;

