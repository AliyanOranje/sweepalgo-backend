# SweepAlgo Options API Documentation

Complete API documentation for all Massive.com (formerly Polygon.io) options endpoints integrated into SweepAlgo.

## Base URL

- **Development**: `http://localhost:5000`
- **Production**: Set via `FRONTEND_URL` environment variable

## Authentication

All endpoints require a valid Massive.com API key set in environment variables:
- `MASSIVE_API_KEY` (preferred)
- `POLYGON_API_KEY` (fallback)

---

## Endpoints

### Options Contracts

#### Get All Contracts
```
GET /api/options/contracts
```

**Query Parameters:**
- `order` (string, optional): `asc` or `desc` (default: `asc`)
- `limit` (number, optional): Number of results (default: `10`)
- `sort` (string, optional): Field to sort by (default: `ticker`)
- `ticker` (string, optional): Filter by underlying ticker
- `contract_type` (string, optional): `CALL` or `PUT`
- `expiration_date` (string, optional): `YYYY-MM-DD`
- `strike_price` (number, optional): Strike price
- `expiration_date.gte` (string, optional): Filter expiration >= date
- `expiration_date.lte` (string, optional): Filter expiration <= date
- `strike_price.gte` (number, optional): Filter strike >= price
- `strike_price.lte` (number, optional): Filter strike <= price

**Example:**
```bash
GET /api/options/contracts?ticker=SPY&contract_type=CALL&limit=20
```

**Response:**
```json
{
  "success": true,
  "data": {
    "results": [...],
    "status": "OK",
    "request_id": "..."
  },
  "count": 20
}
```

#### Get Contract Overview
```
GET /api/options/contracts/:contractId
```

**Parameters:**
- `contractId` (string, required): Contract identifier (e.g., `O:SPY251219C00650000`)

**Example:**
```bash
GET /api/options/contracts/O:SPY251219C00650000
```

---

### Options Bars (OHLC)

#### Get Custom Bars (Aggregates)
```
GET /api/options/bars/:contractId/range
```

**Parameters:**
- `contractId` (string, required): Contract identifier

**Query Parameters:**
- `multiplier` (number, optional): Bar multiplier (default: `1`)
- `timespan` (string, optional): `minute`, `hour`, `day`, `week`, `month`, `quarter`, `year` (default: `day`)
- `from` (string, required): Start date `YYYY-MM-DD`
- `to` (string, required): End date `YYYY-MM-DD`
- `adjusted` (boolean, optional): Adjusted prices (default: `true`)
- `sort` (string, optional): `asc` or `desc` (default: `asc`)
- `limit` (number, optional): Number of results (default: `120`)

**Example:**
```bash
GET /api/options/bars/O:SPY251219C00650000/range?from=2023-01-09&to=2023-02-10&timespan=day
```

#### Get Daily Ticker Summary
```
GET /api/options/bars/:contractId/daily/:date
```

**Parameters:**
- `contractId` (string, required): Contract identifier
- `date` (string, required): Date in `YYYY-MM-DD` format

**Query Parameters:**
- `adjusted` (boolean, optional): Adjusted prices (default: `true`)

**Example:**
```bash
GET /api/options/bars/O:SPY251219C00650000/daily/2023-01-09
```

#### Get Previous Day Bar
```
GET /api/options/bars/:contractId/prev
```

**Parameters:**
- `contractId` (string, required): Contract identifier

**Query Parameters:**
- `adjusted` (boolean, optional): Adjusted prices (default: `true`)

**Example:**
```bash
GET /api/options/bars/O:SPY251219C00650000/prev
```

---

### Options Snapshots

#### Get Contract Snapshot
```
GET /api/options/snapshots/contract/:ticker/:contractId
```

**Parameters:**
- `ticker` (string, required): Underlying ticker (e.g., `A`)
- `contractId` (string, required): Contract identifier (e.g., `O:A250815C00055000`)

**Example:**
```bash
GET /api/options/snapshots/contract/A/O:A250815C00055000
```

#### Get Chain Snapshot
```
GET /api/options/snapshots/chain/:ticker
```

**Parameters:**
- `ticker` (string, required): Underlying ticker

**Query Parameters:**
- `order` (string, optional): `asc` or `desc` (default: `asc`)
- `limit` (number, optional): Number of results (default: `10`)
- `sort` (string, optional): Field to sort by (default: `ticker`)

**Example:**
```bash
GET /api/options/snapshots/chain/SPY?limit=50
```

#### Get Unified Snapshot
```
GET /api/options/snapshots/unified
```

**Query Parameters:**
- `ticker` (string, required): Contract ticker (e.g., `O:A250815C00055000`)
- `order` (string, optional): `asc` or `desc` (default: `asc`)
- `limit` (number, optional): Number of results (default: `10`)
- `sort` (string, optional): Field to sort by (default: `ticker`)

**Example:**
```bash
GET /api/options/snapshots/unified?ticker=O:A250815C00055000
```

---

### Options Trades

#### Get Historic Trades
```
GET /api/options/trades/:contractId
```

**Parameters:**
- `contractId` (string, required): Contract identifier

**Query Parameters:**
- `order` (string, optional): `asc` or `desc` (default: `asc`)
- `limit` (number, optional): Number of results (default: `10`)
- `sort` (string, optional): `timestamp`, `price`, or `size` (default: `timestamp`)
- `timestamp` (number, optional): Unix timestamp (milliseconds)
- `timestamp.gte` (number, optional): Filter trades >= timestamp
- `timestamp.lte` (number, optional): Filter trades <= timestamp

**Example:**
```bash
GET /api/options/trades/O:TSLA210903C00700000?limit=20&order=desc
```

#### Get Last Trade
```
GET /api/options/trades/:contractId/last
```

**Parameters:**
- `contractId` (string, required): Contract identifier

**Example:**
```bash
GET /api/options/trades/O:TSLA210903C00700000/last
```

---

### Options Quotes

#### Get Quotes
```
GET /api/options/quotes/:contractId
```

**Parameters:**
- `contractId` (string, required): Contract identifier

**Query Parameters:**
- `order` (string, optional): `asc` or `desc` (default: `asc`)
- `limit` (number, optional): Number of results (default: `10`)
- `sort` (string, optional): `timestamp`, `bid`, `ask`, or `spread` (default: `timestamp`)
- `timestamp` (number, optional): Unix timestamp (milliseconds)
- `timestamp.gte` (number, optional): Filter quotes >= timestamp
- `timestamp.lte` (number, optional): Filter quotes <= timestamp

**Example:**
```bash
GET /api/options/quotes/O:SPY241220P00720000?limit=20
```

---

### Technical Indicators

#### Get SMA (Simple Moving Average)
```
GET /api/options/indicators/sma/:contractId
```

**Parameters:**
- `contractId` (string, required): Contract identifier

**Query Parameters:**
- `timespan` (string, optional): `minute`, `hour`, `day`, `week`, `month`, `quarter`, `year` (default: `day`)
- `adjusted` (boolean, optional): Adjusted prices (default: `true`)
- `window` (number, optional): Window size (default: `50`)
- `series_type` (string, optional): `open`, `high`, `low`, `close`, `volume` (default: `close`)
- `order` (string, optional): `asc` or `desc` (default: `desc`)
- `limit` (number, optional): Number of results (default: `10`)

**Example:**
```bash
GET /api/options/indicators/sma/O:SPY241220P00720000?window=50&limit=10
```

#### Get EMA (Exponential Moving Average)
```
GET /api/options/indicators/ema/:contractId
```

Same parameters as SMA.

#### Get MACD (Moving Average Convergence Divergence)
```
GET /api/options/indicators/macd/:contractId
```

**Query Parameters:** (Same as SMA, plus)
- `short_window` (number, optional): Short window (default: `12`)
- `long_window` (number, optional): Long window (default: `26`)
- `signal_window` (number, optional): Signal window (default: `9`)

**Example:**
```bash
GET /api/options/indicators/macd/O:SPY241220P00720000?short_window=12&long_window=26&signal_window=9
```

#### Get RSI (Relative Strength Index)
```
GET /api/options/indicators/rsi/:contractId
```

**Query Parameters:** (Same as SMA, but)
- `window` (number, optional): Window size (default: `14`)

**Example:**
```bash
GET /api/options/indicators/rsi/O:SPY241220P00720000?window=14
```

---

### Market Metadata

#### Get Exchanges
```
GET /api/options/metadata/exchanges
```

**Query Parameters:**
- `asset_class` (string, optional): `options` (default: `options`)
- `locale` (string, optional): `us` or `global` (default: `us`)

**Example:**
```bash
GET /api/options/metadata/exchanges?asset_class=options&locale=us
```

#### Get Market Holidays
```
GET /api/options/metadata/holidays
```

**Example:**
```bash
GET /api/options/metadata/holidays
```

#### Get Market Status
```
GET /api/options/metadata/status
```

**Example:**
```bash
GET /api/options/metadata/status
```

#### Get Condition Codes
```
GET /api/options/metadata/conditions
```

**Query Parameters:**
- `asset_class` (string, optional): `options` (default: `options`)
- `order` (string, optional): `asc` or `desc` (default: `asc`)
- `limit` (number, optional): Number of results (default: `10`)
- `sort` (string, optional): `asset_class` or `condition` (default: `asset_class`)

**Example:**
```bash
GET /api/options/metadata/conditions?asset_class=options
```

---

## Error Responses

All endpoints return errors in the following format:

```json
{
  "success": false,
  "error": "Error description",
  "message": "Detailed error message"
}
```

**HTTP Status Codes:**
- `200`: Success
- `400`: Bad Request (missing or invalid parameters)
- `404`: Not Found
- `500`: Internal Server Error
- `429`: Rate Limit Exceeded (from Massive.com API)
- `401`: Unauthorized (invalid API key)

---

## Rate Limits

Rate limits are enforced by Massive.com. Refer to their documentation for current limits:
https://massive.com/docs/rest/options/overview

---

## Frontend Integration

All endpoints are available through the frontend API service:

```typescript
import {
  optionsContractsAPI,
  optionsBarsAPI,
  optionsSnapshotsAPI,
  optionsTradesAPI,
  optionsQuotesAPI,
  optionsIndicatorsAPI,
  optionsMetadataAPI,
} from '@/services/api';

// Example usage
const contracts = await optionsContractsAPI.getAllContracts({ ticker: 'SPY', limit: 20 });
const lastTrade = await optionsTradesAPI.getLastTrade('O:SPY251219C00650000');
const sma = await optionsIndicatorsAPI.getSMA('O:SPY241220P00720000', { window: 50 });
```

---

## Testing

Run API tests:
```bash
npm test
```

Tests require:
- Backend server running on `http://localhost:5000` (or set `TEST_API_URL`)
- Valid `MASSIVE_API_KEY` or `POLYGON_API_KEY` in environment

---

## Support

For issues or questions:
1. Check the [Massive.com API Documentation](https://massive.com/docs/rest/options/overview)
2. Review backend logs for detailed error messages
3. Check environment variables are set correctly

