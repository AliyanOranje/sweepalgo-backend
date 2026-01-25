/**
 * Test script: sends a fake ThriveCart order.success to your webhook.
 *
 * Use this to check:
 * - Webhook is reachable and returns 200
 * - User is created in DB (check Supabase users + public.users)
 * - If 200 + user created → webhook code works; if ThriveCart doesn't create users, the webhook isn't being triggered by ThriveCart.
 *
 * Run:
 *   node scripts/test-thrivecart-webhook.js
 *
 * Requires in .env (or env): THRIVECART_ORDERVALID_SECRET = your "Secret word" from
 * ThriveCart → Settings → API & Webhooks → ThriveCart order validation.
 *
 * Optional: WEBHOOK_URL (default: production)
 *   WEBHOOK_URL=https://sweepalgo-backend-production.up.railway.app/api/thrivecart/webhook node scripts/test-thrivecart-webhook.js
 */

import 'dotenv/config';

const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://sweepalgo-backend-production.up.railway.app/api/thrivecart/webhook';
const SECRET = process.env.THRIVECART_ORDERVALID_SECRET || process.env.THRIVECART_WEBHOOK_SECRET;

// Use a unique test email so you can find it in Supabase
const TEST_EMAIL = `webhook-test-${Date.now()}@example.com`;

const body = new URLSearchParams({
  event: 'order.success',
  thrivecart_secret: SECRET,
  base_product: 'sweepalgo',
  order_id: String(900000000 + Math.floor(Math.random() * 99999999)),
  customer_id: String(8000000 + Math.floor(Math.random() * 999999)),
  currency: 'USD',
  'customer[email]': TEST_EMAIL,
  'customer[first_name]': 'WebhookTest',
  'customer[last_name]': 'Script',
  'order[total]': '4900',
});

async function run() {
  if (!SECRET) {
    console.error('❌ THRIVECART_ORDERVALID_SECRET or THRIVECART_WEBHOOK_SECRET must be set in .env');
    process.exit(1);
  }

  console.log('📤 Sending order.success to:', WEBHOOK_URL);
  console.log('   Test email:', TEST_EMAIL);

  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  console.log('📥 Status:', res.status, res.statusText);
  console.log('   Body:', json || text);

  if (res.ok && json?.success) {
    console.log('\n✅ Webhook returned 200 and success:true. Check Supabase:');
    console.log('   - auth.users: email =', TEST_EMAIL);
    console.log('   - public.users: email =', TEST_EMAIL);
    console.log('\n   If both exist → webhook works. If ThriveCart purchases do not create users, ThriveCart is not calling this URL.');
  } else if (res.status === 401) {
    console.log('\n❌ 401: thrivecart_secret did not match. Ensure THRIVECART_ORDERVALID_SECRET in .env equals the "Secret word" in ThriveCart → Settings → API & Webhooks → ThriveCart order validation.');
  } else {
    console.log('\n⚠️ Request did not succeed. Check Railway logs for the webhook handler.');
  }
}

run().catch((e) => {
  console.error('Request failed:', e.message);
  process.exit(1);
});
