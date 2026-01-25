/**
 * Authentication Routes
 * 
 * These routes handle user authentication operations that require
 * server-side processing or admin privileges.
 * 
 * Note: Most auth operations (login, logout, password update) are handled
 * directly by the frontend using Supabase client SDK.
 */

import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { sendPasswordResetEmail } from '../services/emailService.js';

const router = express.Router();

// Lazy initialization of Supabase Admin Client
// This allows the server to start even if Supabase isn't configured yet
let supabaseAdmin = null;

function getSupabaseAdmin() {
  if (!supabaseAdmin) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('Supabase environment variables not configured');
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

/**
 * GET /api/auth/user
 * 
 * Fetches the current user's data from the users table.
 * Requires Bearer token in Authorization header.
 * 
 * This is used by the frontend to get subscription status and other user data.
 */
router.get('/user', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: 'Missing or invalid authorization header',
      });
    }
    
    const token = authHeader.substring(7);
    
    // Verify the token and get the user
    const { data: { user }, error: authError } = await getSupabaseAdmin().auth.getUser(token);
    
    if (authError || !user) {
      return res.status(401).json({
        success: false,
        error: 'Invalid or expired token',
      });
    }
    
    // Fetch user data from users table
    const { data: userData, error: userError } = await getSupabaseAdmin()
      .from('users')
      .select('*')
      .eq('id', user.id)
      .single();
    
    if (userError || !userData) {
      // SECURITY: User exists in auth.users but NOT in public.users
      // This means they signed up directly without paying through ThriveCart
      console.warn(`⚠️ SECURITY: User ${user.email} exists in auth but not in users table`);
      return res.status(403).json({
        success: false,
        error: 'Account not properly provisioned. Please purchase a subscription.',
        code: 'NO_SUBSCRIPTION_RECORD',
      });
    }
    
    // Update last_login_at
    await getSupabaseAdmin()
      .from('users')
      .update({ last_login_at: new Date().toISOString() })
      .eq('id', user.id);
    
    return res.json({
      success: true,
      user: {
        id: userData.id,
        email: userData.email,
        firstName: userData.first_name,
        lastName: userData.last_name,
        subscriptionTier: userData.subscription_tier,
        subscriptionStatus: userData.subscription_status,
        subscriptionStartedAt: userData.subscription_started_at,
        emailVerified: userData.email_verified,
        lastLoginAt: userData.last_login_at,
        createdAt: userData.created_at,
      },
    });
    
  } catch (error) {
    console.error('Error in /api/auth/user:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

/**
 * POST /api/auth/resend-password-reset
 * 
 * Resends the password reset email for users who:
 * 1. Have an account created via ThriveCart purchase
 * 2. Never set their password
 * 3. Their original reset link expired
 * 
 * Body: { email: string }
 */
router.post('/resend-password-reset', async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({
        success: false,
        error: 'Email is required',
      });
    }
    
    const normalizedEmail = email.toLowerCase().trim();
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    
    console.log(`📧 Password reset requested for: ${normalizedEmail}`);
    console.log(`📧 Frontend URL: ${frontendUrl}`);
    
    // Check if user exists in users table (only paid users have records here)
    const { data: user, error: lookupError } = await getSupabaseAdmin()
      .from('users')
      .select('id, first_name, email')
      .eq('email', normalizedEmail)
      .single();
    
    if (lookupError || !user) {
      console.log(`⚠️ User not found in database: ${normalizedEmail}`);
      // Don't reveal whether email exists - return success anyway
      return res.json({
        success: true,
        message: 'If an account exists with this email, a password reset link will be sent.',
      });
    }
    
    console.log(`✅ User found: ${user.first_name} (${normalizedEmail})`);
    
    // Use Supabase's built-in resetPasswordForEmail
    // This sends the email directly through Supabase (works for ANY email address)
    const { error: resetError } = await getSupabaseAdmin().auth.resetPasswordForEmail(normalizedEmail, {
      redirectTo: `${frontendUrl}/set-password`,
    });
    
    if (resetError) {
      console.error('❌ Error sending password reset email:', resetError);
      return res.status(500).json({
        success: false,
        error: 'Failed to send password reset email. Please try again.',
      });
    }
    
    console.log(`✅ Password reset email sent to ${normalizedEmail}`);
    
    return res.json({
      success: true,
      message: 'Password reset link has been sent to your email.',
    });
    
  } catch (error) {
    console.error('❌ Error in /api/auth/resend-password-reset:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

/**
 * POST /api/auth/check-user
 * 
 * Checks if a user exists in the users table (paid customers only).
 * Used by frontend to determine which error message to show on login failure.
 * 
 * Body: { email: string }
 * Returns: { exists: boolean }
 */
router.post('/check-user', async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({
        success: false,
        error: 'Email is required',
      });
    }
    
    // Check if user exists in users table (only paid users have records here)
    const { data: user, error } = await getSupabaseAdmin()
      .from('users')
      .select('id, email')
      .eq('email', email.toLowerCase())
      .single();
    
    // Return whether user exists (paid customer)
    return res.json({
      success: true,
      exists: !error && !!user,
    });
    
  } catch (error) {
    console.error('Error in /api/auth/check-user:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

/**
 * GET /api/auth/subscription-status
 * 
 * Quick check for subscription status.
 * Used by frontend for route protection.
 */
router.get('/subscription-status', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
    }
    
    const token = authHeader.substring(7);
    
    // Verify the token
    const { data: { user }, error: authError } = await getSupabaseAdmin().auth.getUser(token);
    
    if (authError || !user) {
      return res.status(401).json({
        success: false,
        error: 'Invalid token',
      });
    }
    
    // Get subscription status (only exists for paid users)
    const { data: userData, error: userError } = await getSupabaseAdmin()
      .from('users')
      .select('subscription_tier, subscription_status')
      .eq('id', user.id)
      .single();
    
    if (userError || !userData) {
      // SECURITY: User authenticated but no subscription record
      // This means they bypassed payment
      console.warn(`⚠️ SECURITY: Auth user ${user.email} has no subscription record`);
      return res.status(403).json({
        success: false,
        error: 'No subscription found. Please purchase a subscription.',
        code: 'NO_SUBSCRIPTION_RECORD',
        subscriptionTier: 'none',
        subscriptionStatus: 'none',
        hasActiveSubscription: false,
      });
    }
    
    const hasActiveSubscription = userData.subscription_status === 'active';
    
    return res.json({
      success: true,
      subscriptionTier: userData.subscription_tier,
      subscriptionStatus: userData.subscription_status,
      hasActiveSubscription,
    });
    
  } catch (error) {
    console.error('Error in /api/auth/subscription-status:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

export default router;
