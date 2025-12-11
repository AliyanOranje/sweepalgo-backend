/**
 * API Tests for Massive.com Options Endpoints
 * 
 * Run with: npm test
 * 
 * Note: These tests require MASSIVE_API_KEY or POLYGON_API_KEY in environment variables
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import axios from 'axios';

const BASE_URL = process.env.TEST_API_URL || 'http://localhost:5000';
const API_KEY = process.env.MASSIVE_API_KEY || process.env.POLYGON_API_KEY;

describe('Options API Endpoints', () => {
  beforeAll(() => {
    if (!API_KEY) {
      console.warn('⚠️  MASSIVE_API_KEY or POLYGON_API_KEY not set. Some tests may fail.');
    }
  });

  describe('GET /api/options/contracts', () => {
    it('should fetch all contracts with default parameters', async () => {
      const response = await axios.get(`${BASE_URL}/api/options/contracts`, {
        params: { limit: 10 },
      });
      
      expect(response.status).toBe(200);
      expect(response.data.success).toBe(true);
      expect(response.data.data).toBeDefined();
    });

    it('should filter contracts by ticker', async () => {
      const response = await axios.get(`${BASE_URL}/api/options/contracts`, {
        params: { ticker: 'SPY', limit: 5 },
      });
      
      expect(response.status).toBe(200);
      expect(response.data.success).toBe(true);
    });

    it('should filter contracts by type', async () => {
      const response = await axios.get(`${BASE_URL}/api/options/contracts`, {
        params: { contract_type: 'CALL', limit: 5 },
      });
      
      expect(response.status).toBe(200);
      expect(response.data.success).toBe(true);
    });
  });

  describe('GET /api/options/contracts/:contractId', () => {
    it('should fetch contract overview', async () => {
      const contractId = 'O:SPY251219C00650000';
      const response = await axios.get(`${BASE_URL}/api/options/contracts/${contractId}`);
      
      expect(response.status).toBe(200);
      expect(response.data.success).toBe(true);
      expect(response.data.contractId).toBe(contractId);
    });
  });

  describe('GET /api/options/bars/:contractId/range', () => {
    it('should fetch custom bars', async () => {
      const contractId = 'O:SPY251219C00650000';
      const response = await axios.get(`${BASE_URL}/api/options/bars/${contractId}/range`, {
        params: {
          from: '2023-01-09',
          to: '2023-02-10',
          limit: 10,
        },
      });
      
      expect(response.status).toBe(200);
      expect(response.data.success).toBe(true);
    });

    it('should return 400 if from/to dates are missing', async () => {
      const contractId = 'O:SPY251219C00650000';
      try {
        await axios.get(`${BASE_URL}/api/options/bars/${contractId}/range`);
      } catch (error) {
        expect(error.response.status).toBe(400);
      }
    });
  });

  describe('GET /api/options/bars/:contractId/prev', () => {
    it('should fetch previous day bar', async () => {
      const contractId = 'O:SPY251219C00650000';
      const response = await axios.get(`${BASE_URL}/api/options/bars/${contractId}/prev`);
      
      expect(response.status).toBe(200);
      expect(response.data.success).toBe(true);
    });
  });

  describe('GET /api/options/snapshots/chain/:ticker', () => {
    it('should fetch chain snapshot', async () => {
      const ticker = 'SPY';
      const response = await axios.get(`${BASE_URL}/api/options/snapshots/chain/${ticker}`, {
        params: { limit: 10 },
      });
      
      expect(response.status).toBe(200);
      expect(response.data.success).toBe(true);
      expect(response.data.ticker).toBe(ticker);
    });
  });

  describe('GET /api/options/trades/:contractId', () => {
    it('should fetch historic trades', async () => {
      const contractId = 'O:TSLA210903C00700000';
      const response = await axios.get(`${BASE_URL}/api/options/trades/${contractId}`, {
        params: { limit: 10 },
      });
      
      expect(response.status).toBe(200);
      expect(response.data.success).toBe(true);
    });
  });

  describe('GET /api/options/trades/:contractId/last', () => {
    it('should fetch last trade', async () => {
      const contractId = 'O:TSLA210903C00700000';
      const response = await axios.get(`${BASE_URL}/api/options/trades/${contractId}/last`);
      
      expect(response.status).toBe(200);
      expect(response.data.success).toBe(true);
    });
  });

  describe('GET /api/options/quotes/:contractId', () => {
    it('should fetch quotes', async () => {
      const contractId = 'O:SPY241220P00720000';
      const response = await axios.get(`${BASE_URL}/api/options/quotes/${contractId}`, {
        params: { limit: 10 },
      });
      
      expect(response.status).toBe(200);
      expect(response.data.success).toBe(true);
    });
  });

  describe('GET /api/options/indicators/sma/:contractId', () => {
    it('should fetch SMA indicator', async () => {
      const contractId = 'O:SPY241220P00720000';
      const response = await axios.get(`${BASE_URL}/api/options/indicators/sma/${contractId}`, {
        params: { window: 50, limit: 10 },
      });
      
      expect(response.status).toBe(200);
      expect(response.data.success).toBe(true);
      expect(response.data.indicator).toBe('SMA');
    });
  });

  describe('GET /api/options/metadata/status', () => {
    it('should fetch market status', async () => {
      const response = await axios.get(`${BASE_URL}/api/options/metadata/status`);
      
      expect(response.status).toBe(200);
      expect(response.data.success).toBe(true);
      expect(response.data.data).toBeDefined();
    });
  });

  describe('GET /api/options/metadata/exchanges', () => {
    it('should fetch exchanges', async () => {
      const response = await axios.get(`${BASE_URL}/api/options/metadata/exchanges`);
      
      expect(response.status).toBe(200);
      expect(response.data.success).toBe(true);
    });
  });
});

