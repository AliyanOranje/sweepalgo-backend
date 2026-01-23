/**
 * ThriveCart Webhook Handler
 * 
 * This route handles all ThriveCart webhook events for subscription management.
 * It is the ONLY source of truth for payment status - frontend never checks ThriveCart directly.
 * 
 * Events handled:
 * - order.success: New purchase, creates user account
 * - order.refund: Refund processed, downgrades subscription
 * - subscription.cancelled: User cancelled, updates status
 * - subscription.renewed: Subscription renewed, updates dates
 * - subscription.payment_failed: Payment failed, may need action
 */

import express from 'express';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { sendWelcomeEmail } from '../services/emailService.js';

const router = express.Router();

// Lazy initialization of Supabase Admin Client
// This allows the server to start even if Supabase isn't configured yet
let supabaseAdmin = null;

function getSupabaseAdmin() {
  if (!supabaseAdmin) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('Supabase environment variables not configured. Please set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
    }
    supabaseAdmin = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      }
    );
  }
  return supabaseAdmin;
}

// ==========================================
// PRODUCT ID TO TIER MAPPING
// ==========================================
// ThriveCart product: sweepAlgo
// Monthly: $49/mo, Annual: $497/yr
// Both pricing options give the same tier (pro)
const PRODUCT_TIER_MAP = {
  // sweepAlgo product - main product ID
  'sweepalgo': 'pro',
  'sweepAlgo': 'pro',
  'SweepAlgo': 'pro',
  
  // ThriveCart may send numeric product IDs
  // Add your actual ThriveCart product ID here once you find it
  // You can find it in ThriveCart dashboard or in webhook payloads
  
  // Pricing option variants (ThriveCart sometimes includes pricing info)
  'sweepalgo_monthly': 'pro',
  'sweepalgo_annual': 'pro',
  
  // Fallback for any sweepAlgo purchase
  'default': 'pro',
};

/**
 * Maps a ThriveCart product ID to a subscription tier
 * @param {string} productId - The ThriveCart product ID
 * @returns {string} - The subscription tier
 */
function getSubscriptionTier(productId) {
  const tier = PRODUCT_TIER_MAP[productId] || PRODUCT_TIER_MAP['default'];
  console.log(`📦 Mapping product ${productId} to tier: ${tier}`);
  return tier;
}

// ==========================================
// WEBHOOK SIGNATURE VERIFICATION
// ==========================================

/**
 * Verifies the ThriveCart webhook signature
 * IMPORTANT: This ensures the webhook came from ThriveCart, not an attacker
 * 
 * @param {string} payload - Raw request body
 * @param {string} signature - Signature from ThriveCart header
 * @returns {boolean} - Whether signature is valid
 */
function verifyWebhookSignature(payload, signature) {
  // Use THRIVECART_ORDERVALID_SECRET for order validation
  const webhookSecret = process.env.THRIVECART_ORDERVALID_SECRET || process.env.THRIVECART_WEBHOOK_SECRET;
  
  if (!webhookSecret) {
    console.error('❌ THRIVECART_ORDERVALID_SECRET not configured');
    return false;
  }
  
  if (!signature) {
    console.error('❌ No signature provided in webhook request');
    return false;
  }
  
  // ThriveCart uses HMAC SHA256 for signature
  const expectedSignature = crypto
    .createHmac('sha256', webhookSecret)
    .update(payload)
    .digest('hex');
  
  // Use timing-safe comparison to prevent timing attacks
  const isValid = crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
  
  if (!isValid) {
    console.error('❌ Webhook signature verification failed');
  }
  
  return isValid;
}

// ==========================================
// USER CREATION & MANAGEMENT
// ==========================================

/**
 * Generates a secure temporary password
 * This password is temporary - user will set their own via email link
 * 
 * @returns {string} - Temporary password
 */
function generateTemporaryPassword() {
  return crypto.randomBytes(32).toString('base64');
}

/**
 * Creates a new user in Supabase Auth and the users table
 * 
 * @param {Object} customerData - Customer data from ThriveCart
 * @param {Object} orderData - Order data from ThriveCart
 * @returns {Object} - Created user data
 */
async function createNewUser(customerData, orderData) {
  const { email, firstName, lastName } = customerData;
  const { orderId, customerId, subscriptionId, productId, amount, currency } = orderData;
  
  const subscriptionTier = getSubscriptionTier(productId);
  const temporaryPassword = generateTemporaryPassword();
  
  console.log(`👤 Creating new user for ${email}...`);
  
  // Step 1: Create Supabase Auth user with admin API
  // Using createUser instead of signUp to auto-confirm email
  const { data: authData, error: authError } = await getSupabaseAdmin().auth.admin.createUser({
    email: email,
    password: temporaryPassword,
    email_confirm: true, // Auto-confirm email - user came from purchase
    user_metadata: {
      first_name: firstName,
      last_name: lastName,
      source: 'thrivecart_purchase',
    },
  });
  
  if (authError) {
    console.error('❌ Error creating auth user:', authError);
    throw new Error(`Failed to create auth user: ${authError.message}`);
  }
  
  console.log(`✅ Auth user created with ID: ${authData.user.id}`);
  
  // Step 2: Insert row into users table
  const now = new Date().toISOString();
  const { data: userData, error: userError } = await getSupabaseAdmin()
    .from('users')
    .insert({
      id: authData.user.id, // References auth.users.id
      email: email,
      first_name: firstName,
      last_name: lastName,
      subscription_tier: subscriptionTier,
      subscription_status: 'active',
      subscription_started_at: now,
      thrivecart_customer_id: customerId,
      thrivecart_order_id: orderId,
      thrivecart_subscription_id: subscriptionId,
      email_verified: true,
      created_at: now,
      updated_at: now,
    })
    .select()
    .single();
  
  if (userError) {
    console.error('❌ Error creating user record:', userError);
    // Attempt to clean up auth user if database insert fails
    await getSupabaseAdmin().auth.admin.deleteUser(authData.user.id);
    throw new Error(`Failed to create user record: ${userError.message}`);
  }
  
  console.log(`✅ User record created in database`);
  
  // Step 3: Generate password reset link and send welcome email
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  let passwordSetUrl = `${frontendUrl}/set-password?welcome=true`;
  
  try {
    // Generate a password recovery link using Supabase Admin
    const { data: linkData, error: resetError } = await getSupabaseAdmin().auth.admin.generateLink({
      type: 'recovery',
      email: email,
      options: {
        redirectTo: `${frontendUrl}/set-password?welcome=true`,
      },
    });
    
    if (resetError) {
      console.error('⚠️ Warning: Failed to generate password reset link:', resetError);
    } else if (linkData?.properties?.action_link) {
      // Use the actual Supabase-generated link
      passwordSetUrl = linkData.properties.action_link;
      console.log('✅ Password reset link generated:', passwordSetUrl.substring(0, 50) + '...');
    } else {
      console.log('⚠️ No action_link in response, using fallback URL');
    }
  } catch (linkErr) {
    console.error('⚠️ Warning: Error generating password reset link:', linkErr.message);
  }
  
  // Step 4: Send welcome email with the password setup link
  try {
    await sendWelcomeEmail({
      email,
      firstName,
      subscriptionTier,
      redirectUrl: passwordSetUrl,
    });
    console.log(`✅ Welcome email sent to ${email}`);
  } catch (emailError) {
    console.error('⚠️ Warning: Failed to send welcome email:', emailError.message);
    console.error('Email error details:', emailError);
    // Don't throw - user account was created successfully
  }
  
  return {
    userId: authData.user.id,
    email,
    subscriptionTier,
    isNewUser: true,
  };
}

/**
 * Updates an existing user's subscription
 * 
 * @param {Object} existingUser - Existing user from database
 * @param {Object} orderData - Order data from ThriveCart
 * @returns {Object} - Updated user data
 */
async function updateExistingUser(existingUser, orderData) {
  const { orderId, customerId, subscriptionId, productId } = orderData;
  const subscriptionTier = getSubscriptionTier(productId);
  const now = new Date().toISOString();
  
  console.log(`🔄 Updating existing user ${existingUser.email}...`);
  
  const { data, error } = await getSupabaseAdmin()
    .from('users')
    .update({
      subscription_tier: subscriptionTier,
      subscription_status: 'active',
      subscription_started_at: now,
      thrivecart_customer_id: customerId,
      thrivecart_order_id: orderId,
      thrivecart_subscription_id: subscriptionId,
      updated_at: now,
    })
    .eq('id', existingUser.id)
    .select()
    .single();
  
  if (error) {
    console.error('❌ Error updating user:', error);
    throw new Error(`Failed to update user: ${error.message}`);
  }
  
  console.log(`✅ User subscription updated to ${subscriptionTier}`);
  
  return {
    userId: existingUser.id,
    email: existingUser.email,
    subscriptionTier,
    isNewUser: false,
  };
}

/**
 * Logs a subscription event to the subscription_events table
 * 
 * @param {Object} eventData - Event data to log
 */
async function logSubscriptionEvent(eventData) {
  const {
    userId,
    eventType,
    oldTier,
    newTier,
    oldStatus,
    newStatus,
    orderId,
    amount,
    currency,
  } = eventData;
  
  const { error } = await getSupabaseAdmin()
    .from('subscription_events')
    .insert({
      user_id: userId,
      event_type: eventType,
      old_tier: oldTier,
      new_tier: newTier,
      old_status: oldStatus,
      new_status: newStatus,
      thrivecart_order_id: orderId,
      amount: amount,
      currency: currency,
      created_at: new Date().toISOString(),
    });
  
  if (error) {
    console.error('⚠️ Warning: Failed to log subscription event:', error);
    // Don't throw - this is a logging operation
  } else {
    console.log(`📝 Subscription event logged: ${eventType}`);
  }
}

// ==========================================
// WEBHOOK EVENT HANDLERS
// ==========================================

/**
 * Handles order.success event
 * Creates new user or updates existing user's subscription
 */
async function handleOrderSuccess(payload) {
  console.log('💰 Processing order.success event...');
  console.log('📋 Full payload for debugging:', JSON.stringify(payload, null, 2));
  
  // Extract customer data from ThriveCart payload
  // ThriveCart has multiple possible structures depending on webhook version
  
  // Customer info - try multiple possible locations
  const customerEmail = (
    payload.customer?.email || 
    payload.email || 
    payload.customer_email ||
    payload.purchaser?.email ||
    ''
  ).toLowerCase().trim();
  
  const customerFirstName = (
    payload.customer?.first_name || 
    payload.customer?.name?.split(' ')[0] ||
    payload.first_name || 
    payload.customer_firstname ||
    payload.purchaser?.first_name ||
    ''
  ).trim();
  
  const customerLastName = (
    payload.customer?.last_name || 
    payload.customer?.name?.split(' ').slice(1).join(' ') ||
    payload.last_name || 
    payload.customer_lastname ||
    payload.purchaser?.last_name ||
    ''
  ).trim();
  
  // Order/Transaction info
  const orderId = (
    payload.order_id || 
    payload.order?.id || 
    payload.invoice_id ||
    payload.transaction_id ||
    payload.txn_id ||
    ''
  ).toString();
  
  const customerId = (
    payload.customer_id || 
    payload.customer?.id ||
    payload.thrivecart_customer ||
    ''
  ).toString();
  
  const subscriptionId = (
    payload.subscription_id || 
    payload.subscription?.id ||
    payload.rebill_id ||
    ''
  ).toString();
  
  // Product info - ThriveCart uses base_product or item info
  const productId = (
    payload.base_product || 
    payload.product_id || 
    payload.product?.id ||
    payload.item_name ||
    payload.product_name ||
    'sweepalgo'
  ).toString().toLowerCase();
  
  // Amount info
  const amount = parseFloat(
    payload.order?.total || 
    payload.amount || 
    payload.order_total ||
    payload.total ||
    0
  );
  
  const currency = payload.order?.currency || payload.currency || 'USD';
  
  console.log('📧 Extracted Customer Email:', customerEmail);
  console.log('👤 Extracted Name:', customerFirstName, customerLastName);
  console.log('🆔 Order ID:', orderId);
  console.log('📦 Product ID:', productId);
  
  if (!customerEmail) {
    throw new Error('Customer email is required');
  }
  
  console.log(`📧 Customer: ${customerEmail} (${customerFirstName} ${customerLastName})`);
  console.log(`📦 Product: ${productId}, Order: ${orderId}`);
  
  // Check if user already exists
  const { data: existingUser, error: lookupError } = await getSupabaseAdmin()
    .from('users')
    .select('*')
    .eq('email', customerEmail.toLowerCase())
    .single();
  
  let result;
  let oldTier = 'free';
  let oldStatus = 'free';
  
  if (lookupError && lookupError.code !== 'PGRST116') {
    // PGRST116 = no rows found, which is expected for new users
    console.error('❌ Error looking up user:', lookupError);
    throw new Error(`Failed to lookup user: ${lookupError.message}`);
  }
  
  if (existingUser) {
    // Update existing user
    oldTier = existingUser.subscription_tier;
    oldStatus = existingUser.subscription_status;
    result = await updateExistingUser(existingUser, {
      orderId,
      customerId,
      subscriptionId,
      productId,
      amount,
      currency,
    });
  } else {
    // Create new user
    result = await createNewUser(
      {
        email: customerEmail.toLowerCase(),
        firstName: customerFirstName,
        lastName: customerLastName,
      },
      {
        orderId,
        customerId,
        subscriptionId,
        productId,
        amount,
        currency,
      }
    );
  }
  
  // Log the subscription event
  await logSubscriptionEvent({
    userId: result.userId,
    eventType: 'order.success',
    oldTier,
    newTier: result.subscriptionTier,
    oldStatus,
    newStatus: 'active',
    orderId,
    amount,
    currency,
  });
  
  return result;
}

/**
 * Handles order.refund event
 * Downgrades user to free tier
 */
async function handleOrderRefund(payload) {
  console.log('💸 Processing order.refund event...');
  
  const customerEmail = payload.customer?.email || payload.email;
  const orderId = payload.order_id || payload.order?.id;
  const amount = parseFloat(payload.amount || payload.refund?.amount || 0);
  const currency = payload.currency || 'USD';
  
  if (!customerEmail) {
    throw new Error('Customer email is required for refund');
  }
  
  // Find user by email
  const { data: user, error: lookupError } = await getSupabaseAdmin()
    .from('users')
    .select('*')
    .eq('email', customerEmail.toLowerCase())
    .single();
  
  if (lookupError || !user) {
    console.error('❌ User not found for refund:', customerEmail);
    throw new Error(`User not found: ${customerEmail}`);
  }
  
  const oldTier = user.subscription_tier;
  const oldStatus = user.subscription_status;
  
  // Update user to free tier
  const { error: updateError } = await getSupabaseAdmin()
    .from('users')
    .update({
      subscription_tier: 'free',
      subscription_status: 'cancelled',
      updated_at: new Date().toISOString(),
    })
    .eq('id', user.id);
  
  if (updateError) {
    console.error('❌ Error updating user for refund:', updateError);
    throw new Error(`Failed to process refund: ${updateError.message}`);
  }
  
  console.log(`✅ Refund processed for ${customerEmail}`);
  
  // Log the refund event
  await logSubscriptionEvent({
    userId: user.id,
    eventType: 'order.refund',
    oldTier,
    newTier: 'free',
    oldStatus,
    newStatus: 'cancelled',
    orderId,
    amount,
    currency,
  });
  
  return { userId: user.id, email: user.email, refunded: true };
}

/**
 * Handles subscription.cancelled event
 * Updates subscription status but keeps user account
 */
async function handleSubscriptionCancelled(payload) {
  console.log('🚫 Processing subscription.cancelled event...');
  
  const subscriptionId = payload.subscription_id || payload.subscription?.id;
  const customerEmail = payload.customer?.email || payload.email;
  
  // Try to find user by subscription ID first, then by email
  let user;
  
  if (subscriptionId) {
    const { data, error } = await getSupabaseAdmin()
      .from('users')
      .select('*')
      .eq('thrivecart_subscription_id', subscriptionId)
      .single();
    
    if (!error && data) {
      user = data;
    }
  }
  
  if (!user && customerEmail) {
    const { data, error } = await getSupabaseAdmin()
      .from('users')
      .select('*')
      .eq('email', customerEmail.toLowerCase())
      .single();
    
    if (!error && data) {
      user = data;
    }
  }
  
  if (!user) {
    console.error('❌ User not found for cancellation');
    throw new Error('User not found for cancellation');
  }
  
  const oldStatus = user.subscription_status;
  
  // Update subscription status - user can still log in
  const { error: updateError } = await getSupabaseAdmin()
    .from('users')
    .update({
      subscription_status: 'cancelled',
      updated_at: new Date().toISOString(),
    })
    .eq('id', user.id);
  
  if (updateError) {
    console.error('❌ Error updating cancellation:', updateError);
    throw new Error(`Failed to process cancellation: ${updateError.message}`);
  }
  
  console.log(`✅ Subscription cancelled for ${user.email}`);
  
  // Log the cancellation event
  await logSubscriptionEvent({
    userId: user.id,
    eventType: 'subscription.cancelled',
    oldTier: user.subscription_tier,
    newTier: user.subscription_tier, // Tier doesn't change on cancellation
    oldStatus,
    newStatus: 'cancelled',
    orderId: user.thrivecart_order_id,
    amount: null,
    currency: null,
  });
  
  return { userId: user.id, email: user.email, cancelled: true };
}

/**
 * Handles subscription.renewed event
 * Updates subscription status back to active
 */
async function handleSubscriptionRenewed(payload) {
  console.log('🔄 Processing subscription.renewed event...');
  
  const subscriptionId = payload.subscription_id || payload.subscription?.id;
  const customerEmail = payload.customer?.email || payload.email;
  const orderId = payload.order_id || payload.order?.id;
  const amount = parseFloat(payload.amount || 0);
  const currency = payload.currency || 'USD';
  
  // Find user by subscription ID or email
  let user;
  
  if (subscriptionId) {
    const { data, error } = await getSupabaseAdmin()
      .from('users')
      .select('*')
      .eq('thrivecart_subscription_id', subscriptionId)
      .single();
    
    if (!error && data) {
      user = data;
    }
  }
  
  if (!user && customerEmail) {
    const { data, error } = await getSupabaseAdmin()
      .from('users')
      .select('*')
      .eq('email', customerEmail.toLowerCase())
      .single();
    
    if (!error && data) {
      user = data;
    }
  }
  
  if (!user) {
    console.error('❌ User not found for renewal');
    throw new Error('User not found for renewal');
  }
  
  const oldStatus = user.subscription_status;
  
  // Update subscription status to active
  const { error: updateError } = await getSupabaseAdmin()
    .from('users')
    .update({
      subscription_status: 'active',
      updated_at: new Date().toISOString(),
    })
    .eq('id', user.id);
  
  if (updateError) {
    console.error('❌ Error updating renewal:', updateError);
    throw new Error(`Failed to process renewal: ${updateError.message}`);
  }
  
  console.log(`✅ Subscription renewed for ${user.email}`);
  
  // Log the renewal event
  await logSubscriptionEvent({
    userId: user.id,
    eventType: 'subscription.renewed',
    oldTier: user.subscription_tier,
    newTier: user.subscription_tier,
    oldStatus,
    newStatus: 'active',
    orderId,
    amount,
    currency,
  });
  
  return { userId: user.id, email: user.email, renewed: true };
}

/**
 * Handles subscription.payment_failed event
 * Logs the event but doesn't immediately downgrade
 */
async function handlePaymentFailed(payload) {
  console.log('⚠️ Processing subscription.payment_failed event...');
  
  const subscriptionId = payload.subscription_id || payload.subscription?.id;
  const customerEmail = payload.customer?.email || payload.email;
  const orderId = payload.order_id || payload.order?.id;
  
  // Find user
  let user;
  
  if (subscriptionId) {
    const { data, error } = await getSupabaseAdmin()
      .from('users')
      .select('*')
      .eq('thrivecart_subscription_id', subscriptionId)
      .single();
    
    if (!error && data) {
      user = data;
    }
  }
  
  if (!user && customerEmail) {
    const { data, error } = await getSupabaseAdmin()
      .from('users')
      .select('*')
      .eq('email', customerEmail.toLowerCase())
      .single();
    
    if (!error && data) {
      user = data;
    }
  }
  
  if (!user) {
    console.error('❌ User not found for payment failure');
    throw new Error('User not found for payment failure');
  }
  
  // Update status to payment_failed
  const { error: updateError } = await getSupabaseAdmin()
    .from('users')
    .update({
      subscription_status: 'payment_failed',
      updated_at: new Date().toISOString(),
    })
    .eq('id', user.id);
  
  if (updateError) {
    console.error('❌ Error updating payment failure:', updateError);
  }
  
  console.log(`⚠️ Payment failed for ${user.email}`);
  
  // Log the payment failure event
  await logSubscriptionEvent({
    userId: user.id,
    eventType: 'subscription.payment_failed',
    oldTier: user.subscription_tier,
    newTier: user.subscription_tier,
    oldStatus: user.subscription_status,
    newStatus: 'payment_failed',
    orderId,
    amount: null,
    currency: null,
  });
  
  return { userId: user.id, email: user.email, paymentFailed: true };
}

// ==========================================
// MAIN WEBHOOK ENDPOINT
// ==========================================

/**
 * POST /api/thrivecart/webhook
 * 
 * Main webhook endpoint that receives all ThriveCart events.
 * This endpoint must be registered in ThriveCart webhook settings.
 * 
 * Required environment variables:
 * - THRIVECART_WEBHOOK_SECRET: Secret for signature verification
 * - SUPABASE_URL: Supabase project URL
 * - SUPABASE_SERVICE_ROLE_KEY: Supabase service role key (admin access)
 * - FRONTEND_URL: Frontend URL for email links
 */
router.post('/webhook', express.urlencoded({ extended: true }), express.json(), async (req, res) => {
  console.log('\n========================================');
  console.log('📨 ThriveCart Webhook Received');
  console.log('========================================');
  
  const contentType = req.headers['content-type'] || '';
  console.log('📋 Content-Type:', contentType);
  console.log('📋 Body Type:', typeof req.body);
  
  try {
    let payload;
    let rawBody;
    let parseMethod = 'unknown';
    
    // ThriveCart can send data as JSON or form-urlencoded
    // Handle both formats robustly
    
    if (typeof req.body === 'string') {
      // Raw string body - try JSON first, then URL-encoded
      rawBody = req.body;
      if (contentType.includes('application/json') || req.body.trim().startsWith('{')) {
        try {
          payload = JSON.parse(rawBody);
          parseMethod = 'JSON (from string)';
        } catch (e) {
          // Fall back to URL-encoded
          payload = Object.fromEntries(new URLSearchParams(rawBody));
          parseMethod = 'URL-encoded (from string)';
        }
      } else {
        payload = Object.fromEntries(new URLSearchParams(rawBody));
        parseMethod = 'URL-encoded (from string)';
      }
    } else if (Buffer.isBuffer(req.body)) {
      // Buffer body
      rawBody = req.body.toString();
      if (contentType.includes('application/json') || rawBody.trim().startsWith('{')) {
        try {
          payload = JSON.parse(rawBody);
          parseMethod = 'JSON (from buffer)';
        } catch (e) {
          payload = Object.fromEntries(new URLSearchParams(rawBody));
          parseMethod = 'URL-encoded (from buffer)';
        }
      } else {
        payload = Object.fromEntries(new URLSearchParams(rawBody));
        parseMethod = 'URL-encoded (from buffer)';
      }
    } else if (typeof req.body === 'object' && req.body !== null) {
      // Already parsed by express middleware (JSON or urlencoded)
      payload = req.body;
      rawBody = JSON.stringify(req.body);
      parseMethod = contentType.includes('application/json') ? 'JSON (pre-parsed)' : 'URL-encoded (pre-parsed)';
    } else {
      throw new Error('Unable to parse webhook body - unexpected body type');
    }
    
    console.log('📋 Parse Method:', parseMethod);
    
    // ThriveCart may wrap data in thrivecart[...] format when form-urlencoded
    // Also handle nested JSON strings
    if (payload.thrivecart) {
      console.log('📋 Found thrivecart wrapper, unwrapping...');
      if (typeof payload.thrivecart === 'string') {
        try {
          payload = JSON.parse(payload.thrivecart);
        } catch {
          payload = payload.thrivecart;
        }
      } else {
        payload = payload.thrivecart;
      }
    }
    
    // Handle case where entire payload might be a JSON string
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
        console.log('📋 Parsed nested JSON string');
      } catch {
        // Keep as is
      }
    }
    
    console.log('📦 Final Parsed Payload:', JSON.stringify(payload, null, 2));
    
    const signature = req.headers['x-thrivecart-signature'] || req.headers['thrivecart-signature'] || req.headers['x-tc-signature'];
    
    // Verify webhook signature
    if (process.env.NODE_ENV === 'production') {
      if (!verifyWebhookSignature(rawBody, signature)) {
        console.error('❌ Webhook signature verification failed');
        return res.status(401).json({
          success: false,
          error: 'Invalid webhook signature',
        });
      }
      console.log('✅ Webhook signature verified');
    } else {
      console.log('⚠️ Development mode: Skipping signature verification');
    }
    
    // Get the event type
    const eventType = payload.event || payload.type;
    console.log(`📌 Event Type: ${eventType}`);
    console.log(`📦 Payload:`, JSON.stringify(payload, null, 2));
    
    // Handle the event based on type
    let result;
    
    switch (eventType) {
      case 'order.success':
      case 'order.completed':
        result = await handleOrderSuccess(payload);
        break;
        
      case 'order.refund':
      case 'order.refunded':
        result = await handleOrderRefund(payload);
        break;
        
      case 'subscription.cancelled':
      case 'subscription.canceled':
        result = await handleSubscriptionCancelled(payload);
        break;
        
      case 'subscription.renewed':
      case 'subscription.renewal':
        result = await handleSubscriptionRenewed(payload);
        break;
        
      case 'subscription.payment_failed':
      case 'subscription.failed':
        result = await handlePaymentFailed(payload);
        break;
        
      default:
        console.log(`ℹ️ Unhandled event type: ${eventType}`);
        return res.status(200).json({
          success: true,
          message: `Event ${eventType} acknowledged but not processed`,
        });
    }
    
    console.log('✅ Webhook processed successfully');
    console.log('📊 Result:', result);
    console.log('========================================\n');
    
    // Always return 200 to acknowledge receipt
    // This prevents ThriveCart from retrying
    return res.status(200).json({
      success: true,
      event: eventType,
      result,
    });
    
  } catch (error) {
    console.error('❌ Webhook processing error:', error);
    console.log('========================================\n');
    
    // Return 200 even on error to prevent infinite retries
    // Log the error for investigation
    return res.status(200).json({
      success: false,
      error: error.message,
      note: 'Error logged for investigation',
    });
  }
});

/**
 * GET /api/thrivecart/webhook
 * Health check endpoint for webhook verification
 */
router.get('/webhook', (req, res) => {
  res.json({
    status: 'ok',
    message: 'ThriveCart webhook endpoint is active',
    timestamp: new Date().toISOString(),
  });
});

/**
 * Root endpoint - some webhook providers test the root
 */
router.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'ThriveCart integration active',
    webhook_url: '/api/thrivecart/webhook',
    timestamp: new Date().toISOString(),
  });
});

/**
 * POST to root - redirect to webhook handler
 */
router.post('/', express.urlencoded({ extended: true }), express.json(), async (req, res, next) => {
  // Forward to the main webhook handler
  req.url = '/webhook';
  router.handle(req, res, next);
});

export default router;
