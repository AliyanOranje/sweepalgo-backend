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
 * GET /api/options/metadata/exchanges
 * Get options exchanges
 * 
 * Query params:
 * - asset_class: options (default: options)
 * - locale: us|global (default: us)
 */
router.get('/exchanges', async (req, res) => {
  try {
    const apiKey = getApiKey();
    const {
      asset_class = 'options',
      locale = 'us',
    } = req.query;

    console.log('📡 Fetching exchanges');

    const response = await axios.get(
      `${MASSIVE_API_BASE}/v3/reference/exchanges`,
      {
        params: {
          apiKey,
          asset_class,
          locale,
        },
        timeout: 30000,
      }
    );

    res.json({
      success: true,
      data: response.data,
      count: response.data?.results?.length || 0,
    });
  } catch (error) {
    console.error('❌ Error fetching exchanges:', error.message);
    if (error.response) {
      res.status(error.response.status).json({
        success: false,
        error: 'Failed to fetch exchanges',
        message: error.response.data?.message || error.message,
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to fetch exchanges',
        message: error.message,
      });
    }
  }
});

/**
 * GET /api/options/metadata/holidays
 * Get market holidays
 */
router.get('/holidays', async (req, res) => {
  try {
    const apiKey = getApiKey();

    console.log('📡 Fetching market holidays');

    const response = await axios.get(
      `${MASSIVE_API_BASE}/v1/marketstatus/upcoming`,
      {
        params: { apiKey },
        timeout: 30000,
      }
    );

    res.json({
      success: true,
      data: response.data,
      count: response.data?.results?.length || 0,
    });
  } catch (error) {
    console.error('❌ Error fetching market holidays:', error.message);
    if (error.response) {
      res.status(error.response.status).json({
        success: false,
        error: 'Failed to fetch market holidays',
        message: error.response.data?.message || error.message,
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to fetch market holidays',
        message: error.message,
      });
    }
  }
});

/**
 * GET /api/options/metadata/status
 * Get current market status
 */
router.get('/status', async (req, res) => {
  try {
    const apiKey = getApiKey();

    console.log('📡 Fetching market status');

    const response = await axios.get(
      `${MASSIVE_API_BASE}/v1/marketstatus/now`,
      {
        params: { apiKey },
        timeout: 30000,
      }
    );

    res.json({
      success: true,
      data: response.data,
      market: response.data?.market,
      exchanges: response.data?.exchanges,
    });
  } catch (error) {
    console.error('❌ Error fetching market status:', error.message);
    if (error.response) {
      res.status(error.response.status).json({
        success: false,
        error: 'Failed to fetch market status',
        message: error.response.data?.message || error.message,
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to fetch market status',
        message: error.message,
      });
    }
  }
});

/**
 * GET /api/options/metadata/conditions
 * Get condition codes for options
 * 
 * Query params:
 * - asset_class: options (default: options)
 * - order: asc|desc (default: asc)
 * - limit: number (default: 10)
 * - sort: asset_class|condition (default: asset_class)
 */
router.get('/conditions', async (req, res) => {
  try {
    const apiKey = getApiKey();
    const {
      asset_class = 'options',
      order = 'asc',
      limit = 10,
      sort = 'asset_class',
    } = req.query;

    console.log('📡 Fetching condition codes');

    const response = await axios.get(
      `${MASSIVE_API_BASE}/v3/reference/conditions`,
      {
        params: {
          apiKey,
          asset_class,
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
      count: response.data?.results?.length || 0,
    });
  } catch (error) {
    console.error('❌ Error fetching condition codes:', error.message);
    if (error.response) {
      res.status(error.response.status).json({
        success: false,
        error: 'Failed to fetch condition codes',
        message: error.response.data?.message || error.message,
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to fetch condition codes',
        message: error.message,
      });
    }
  }
});

export default router;

