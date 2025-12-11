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
 * GET /api/options/quotes/:contractId
 * Get quotes for a contract
 * 
 * Params:
 * - contractId: e.g., O:SPY241220P00720000
 * 
 * Query params:
 * - order: asc|desc (default: asc)
 * - limit: number (default: 10)
 * - sort: timestamp|bid|ask|spread (default: timestamp)
 * - timestamp: Unix timestamp (milliseconds) - filter quotes after this timestamp
 * - timestamp.gte: Unix timestamp (milliseconds)
 * - timestamp.lte: Unix timestamp (milliseconds)
 */
router.get('/:contractId', async (req, res) => {
  try {
    const apiKey = getApiKey();
    const { contractId } = req.params;
    const {
      order = 'asc',
      limit = 10,
      sort = 'timestamp',
      timestamp,
      ...otherParams
    } = req.query;

    const params = {
      apiKey,
      order,
      limit: parseInt(limit),
      sort,
      ...(timestamp && { timestamp }),
      ...otherParams, // Support for .gte, .lte filters
    };

    console.log(`📡 Fetching quotes for ${contractId}`);

    const response = await axios.get(
      `${MASSIVE_API_BASE}/v3/quotes/${contractId}`,
      {
        params,
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
    console.error(`❌ Error fetching quotes for ${req.params.contractId}:`, error.message);
    if (error.response) {
      res.status(error.response.status).json({
        success: false,
        error: 'Failed to fetch quotes',
        message: error.response.data?.message || error.message,
        contractId: req.params.contractId,
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to fetch quotes',
        message: error.message,
        contractId: req.params.contractId,
      });
    }
  }
});

export default router;

