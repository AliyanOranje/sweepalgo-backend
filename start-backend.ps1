# SweepAlgo Backend Startup Script
Write-Host "🚀 Starting SweepAlgo Backend Server..." -ForegroundColor Green
Write-Host "📁 Directory: $PWD" -ForegroundColor Gray
Write-Host ""

# Check if .env exists
if (-not (Test-Path ".env")) {
    Write-Host "⚠️  Warning: .env file not found!" -ForegroundColor Yellow
    Write-Host "   Creating .env file with default values..." -ForegroundColor Yellow
    @"
PORT=5000
NODE_ENV=development
FRONTEND_URL=http://localhost:3000
POLYGON_API_KEY=hhnPF6pG7zzwFppFWFZBnTbEmaTIhsFo
"@ | Out-File -FilePath ".env" -Encoding utf8
}

# Check if node_modules exists
if (-not (Test-Path "node_modules")) {
    Write-Host "📦 Installing dependencies..." -ForegroundColor Cyan
    npm install
}

Write-Host "🔌 Starting backend server on port 5000..." -ForegroundColor Green
Write-Host "   Health check: http://localhost:5000/health" -ForegroundColor Gray
Write-Host "   API endpoint: http://localhost:5000/api" -ForegroundColor Gray
Write-Host ""
Write-Host "Press Ctrl+C to stop the server" -ForegroundColor Yellow
Write-Host ""

npm run dev

