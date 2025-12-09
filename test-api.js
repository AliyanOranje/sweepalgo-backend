// Quick test script to verify Massive.com API connection
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const API_KEY = process.env.POLYGON_API_KEY || 'hhnPF6pG7zzwFppFWFZBnTbEmaTIhsFo';

async function testAPI() {
  console.log('🧪 Testing Massive.com API Connection...\n');
  console.log('API Key:', API_KEY.substring(0, 10) + '...\n');

  // Test 1: Options Chain for SPY
  try {
    console.log('📡 Test 1: Fetching SPY options chain...');
    const response = await axios.get(
      'https://api.polygon.io/v3/snapshot/options/SPY',
      {
        params: {
          apiKey: API_KEY,
        },
      }
    );

    console.log('✅ Success!');
    console.log('Status:', response.status);
    console.log('Contracts:', response.data?.results?.length || 0);
    
    if (response.data?.results && response.data.results.length > 0) {
      const contract = response.data.results[0];
      console.log('\n📊 Sample Contract:');
      console.log('  Ticker:', contract.underlying_ticker);
      console.log('  Strike:', contract.details?.strike_price);
      console.log('  Type:', contract.details?.contract_type);
      console.log('  Expiration:', contract.details?.expiration_date);
      console.log('  Volume:', contract.day?.volume);
      console.log('  OI:', contract.open_interest);
      console.log('  IV:', contract.greeks?.mid_iv);
      console.log('  Last Price:', contract.last_quote?.last);
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Data:', error.response.data);
    }
  }

  // Test 2: Stock Price
  try {
    console.log('\n📡 Test 2: Fetching SPY stock price...');
    const response = await axios.get(
      'https://api.polygon.io/v2/aggs/ticker/SPY/prev',
      {
        params: {
          apiKey: API_KEY,
        },
      }
    );

    console.log('✅ Success!');
    if (response.data?.results?.[0]) {
      const quote = response.data.results[0];
      console.log('  Price:', quote.c);
      console.log('  Volume:', quote.v);
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

testAPI();

