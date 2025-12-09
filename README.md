# SweepAlgo Backend

Node.js + Express backend API for SweepAlgo - handles options flow data, WebSocket connections, and API integrations.

## 🚀 Quick Start

### Prerequisites
- Node.js 18+ and npm
- Polygon.io (Massive.com) API key

### Installation

```bash
npm install
```

### Environment Variables

Create a `.env` file:

```env
PORT=5000
NODE_ENV=development
FRONTEND_URL=http://localhost:3000
POLYGON_API_KEY=your_polygon_api_key_here
```

### Development

```bash
npm run dev
```

The backend will run on `http://localhost:5000`

### Production

```bash
npm start
```

## 🏗️ Project Structure

```
sweepalgo-backend/
├── routes/
│   └── optionsFlow.js      # Options flow API routes
├── server.js               # Express server
├── package.json
└── .env                    # Environment variables (not committed)
```

## 📡 API Endpoints

### Options Flow
- `GET /api/options-flow` - Get options flow data (supports pagination)
- `GET /api/options-flow/stats` - Get flow statistics
- `POST /api/options-flow/refresh` - Manually refresh data

### Health Check
- `GET /health` - Server health check

### Options Chain
- `GET /api/options-chain/:ticker` - Get options chain for a ticker

### GEX (Placeholder)
- `GET /api/gex/:ticker` - Gamma exposure endpoint (coming soon)

## 🌐 Deployment

Deploy to Railway:

1. Connect your GitHub repository
2. Set root directory to `sweepalgo-backend`
3. Add environment variables (see below)
4. Deploy

## 🔧 Environment Variables

| Variable | Development | Production | Description |
|----------|-------------|------------|-------------|
| `NODE_ENV` | `development` | `production` | Node.js environment mode |
| `PORT` | `5000` | `5000` (or Railway assigned) | Server port |
| `FRONTEND_URL` | `http://localhost:3000` | `https://your-frontend.vercel.app` | Frontend URL for CORS |
| `POLYGON_API_KEY` | Your API key | Your API key | Polygon.io API key |

## 🔌 WebSocket Support

The backend includes WebSocket server support for real-time data updates. Railway supports WebSocket connections.

## 📝 Notes

- The backend uses Polygon.io (Massive.com) API for options data
- CORS is configured to allow requests from the frontend URL
- WebSocket server runs on the same port as the HTTP server
- Environment variables are loaded from `.env` file (not committed to git)

## 🧪 Testing

Test the health endpoint:
```bash
curl http://localhost:5000/health
```

Test options flow endpoint:
```bash
curl http://localhost:5000/api/options-flow?limit=10&page=1
```
