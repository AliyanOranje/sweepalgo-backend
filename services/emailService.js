/**
 * Email Service for SweepAlgo
 * 
 * This service handles sending emails for:
 * - Welcome emails after purchase
 * - Password reset links
 * - Subscription notifications
 * 
 * IMPORTANT: Configure your email provider by setting the following environment variables:
 * 
 * For Resend (recommended):
 * - RESEND_API_KEY: Your Resend API key
 * 
 * For SendGrid:
 * - SENDGRID_API_KEY: Your SendGrid API key
 * 
 * For SMTP (generic):
 * - SMTP_HOST: SMTP server host
 * - SMTP_PORT: SMTP server port
 * - SMTP_USER: SMTP username
 * - SMTP_PASS: SMTP password
 * 
 * Common:
 * - EMAIL_FROM: Sender email address (e.g., "SweepAlgo <noreply@sweepalgo.com>")
 * - FRONTEND_URL: Frontend URL for links
 */

/**
 * Get the email provider - checked at runtime to ensure env vars are loaded
 */
function getEmailProvider() {
  const provider = process.env.EMAIL_PROVIDER || 
    (process.env.RESEND_API_KEY ? 'resend' : 
     process.env.SENDGRID_API_KEY ? 'sendgrid' : 
     process.env.SMTP_HOST ? 'smtp' : 'console');
  return provider;
}

// Log on first import (may show console if loaded before dotenv)
console.log(`📧 Email provider configured: ${getEmailProvider()}`);

/**
 * Sends an email using the configured provider
 * 
 * @param {Object} options - Email options
 * @param {string} options.to - Recipient email
 * @param {string} options.subject - Email subject
 * @param {string} options.html - HTML content
 * @param {string} options.text - Plain text content (optional)
 */
async function sendEmail({ to, subject, html, text }) {
  const from = process.env.EMAIL_FROM || 'SweepAlgo <noreply@sweepalgo.com>';
  const provider = getEmailProvider();
  
  console.log(`📧 Sending email to ${to}: ${subject} (via ${provider})`);
  
  switch (provider) {
    case 'resend':
      return await sendWithResend({ to, from, subject, html, text });
      
    case 'sendgrid':
      return await sendWithSendGrid({ to, from, subject, html, text });
      
    case 'smtp':
      return await sendWithSMTP({ to, from, subject, html, text });
      
    case 'console':
    default:
      // Development mode - just log the email
      console.log('\n========================================');
      console.log('📧 EMAIL (Console Mode - Not Sent)');
      console.log('========================================');
      console.log(`From: ${from}`);
      console.log(`To: ${to}`);
      console.log(`Subject: ${subject}`);
      console.log('----------------------------------------');
      console.log('HTML Preview:');
      console.log(html.replace(/<[^>]*>/g, '').substring(0, 500) + '...');
      console.log('========================================\n');
      return { success: true, mode: 'console' };
  }
}

/**
 * Send email using Resend API
 * https://resend.com/docs
 */
async function sendWithResend({ to, from, subject, html, text }) {
  const apiKey = process.env.RESEND_API_KEY;
  
  if (!apiKey) {
    throw new Error('RESEND_API_KEY not configured');
  }
  
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to,
      subject,
      html,
      text,
    }),
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Resend error: ${JSON.stringify(error)}`);
  }
  
  const result = await response.json();
  console.log(`✅ Email sent via Resend: ${result.id}`);
  return result;
}

/**
 * Send email using SendGrid API
 * https://docs.sendgrid.com/api-reference/mail-send/mail-send
 */
async function sendWithSendGrid({ to, from, subject, html, text }) {
  const apiKey = process.env.SENDGRID_API_KEY;
  
  if (!apiKey) {
    throw new Error('SENDGRID_API_KEY not configured');
  }
  
  const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: from.includes('<') ? from.match(/<(.+)>/)[1] : from },
      subject,
      content: [
        { type: 'text/plain', value: text || html.replace(/<[^>]*>/g, '') },
        { type: 'text/html', value: html },
      ],
    }),
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`SendGrid error: ${error}`);
  }
  
  console.log('✅ Email sent via SendGrid');
  return { success: true };
}

/**
 * Send email using generic SMTP
 * Requires nodemailer to be installed
 */
async function sendWithSMTP({ to, from, subject, html, text }) {
  // Dynamic import for nodemailer (only load if using SMTP)
  let nodemailer;
  try {
    nodemailer = (await import('nodemailer')).default;
  } catch (error) {
    throw new Error('nodemailer not installed. Run: npm install nodemailer');
  }
  
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  
  const result = await transporter.sendMail({
    from,
    to,
    subject,
    html,
    text,
  });
  
  console.log(`✅ Email sent via SMTP: ${result.messageId}`);
  return result;
}

// ==========================================
// EMAIL TEMPLATES
// ==========================================

/**
 * Generates the welcome email HTML
 * 
 * @param {Object} data - Template data
 * @param {string} data.firstName - User's first name
 * @param {string} data.subscriptionTier - Subscription tier name
 * @param {string} data.setPasswordUrl - URL to set password
 */
function generateWelcomeEmailHTML({ firstName, subscriptionTier, setPasswordUrl }) {
  const tierDisplayName = {
    'basic': 'Basic',
    'pro': 'Pro',
    'premium': 'Premium',
    'enterprise': 'Enterprise',
  }[subscriptionTier] || subscriptionTier;
  
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome to SweepAlgo</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      line-height: 1.6;
      color: #333;
      max-width: 600px;
      margin: 0 auto;
      padding: 20px;
      background-color: #f5f5f5;
    }
    .container {
      background-color: #ffffff;
      border-radius: 12px;
      padding: 40px;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
    }
    .logo {
      text-align: center;
      margin-bottom: 30px;
    }
    .logo h1 {
      color: #6366f1;
      font-size: 28px;
      margin: 0;
    }
    h2 {
      color: #1a1a1a;
      font-size: 24px;
      margin-bottom: 20px;
    }
    p {
      color: #4a4a4a;
      font-size: 16px;
      margin-bottom: 15px;
    }
    .tier-badge {
      display: inline-block;
      background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
      color: white;
      padding: 8px 20px;
      border-radius: 20px;
      font-weight: 600;
      font-size: 14px;
      margin: 10px 0 20px 0;
    }
    .button-container {
      text-align: center;
      margin: 30px 0;
    }
    .button {
      display: inline-block;
      background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
      color: white !important;
      text-decoration: none;
      padding: 16px 40px;
      border-radius: 8px;
      font-weight: 600;
      font-size: 16px;
      transition: transform 0.2s ease;
    }
    .button:hover {
      transform: translateY(-2px);
    }
    .features {
      background-color: #f8fafc;
      border-radius: 8px;
      padding: 20px;
      margin: 20px 0;
    }
    .features h3 {
      color: #1a1a1a;
      font-size: 16px;
      margin-bottom: 15px;
    }
    .features ul {
      margin: 0;
      padding-left: 20px;
    }
    .features li {
      color: #4a4a4a;
      margin-bottom: 8px;
    }
    .footer {
      text-align: center;
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid #eee;
    }
    .footer p {
      color: #888;
      font-size: 14px;
    }
    .expire-note {
      color: #888;
      font-size: 13px;
      text-align: center;
      margin-top: 15px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">
      <h1>SweepAlgo</h1>
    </div>
    
    <h2>Welcome${firstName ? `, ${firstName}` : ''}! 🎉</h2>
    
    <p>Thank you for purchasing SweepAlgo! Your account has been created automatically.</p>
    
    <p>Your subscription tier:</p>
    <span class="tier-badge">${tierDisplayName}</span>
    
    <p>To get started, please set your password by clicking the button below:</p>
    
    <div class="button-container">
      <a href="${setPasswordUrl}" class="button">Set Your Password</a>
    </div>
    
    <p class="expire-note">This link expires in 24 hours. If it expires, you can request a new one from the login page.</p>
    
    <div class="features">
      <h3>What you get with ${tierDisplayName}:</h3>
      <ul>
        <li>Real-time options flow analysis</li>
        <li>Gamma exposure (GEX) visualization</li>
        <li>Advanced filtering and alerts</li>
        <li>Historical data access</li>
        <li>Priority support</li>
      </ul>
    </div>
    
    <p>If you have any questions, simply reply to this email - we're here to help!</p>
    
    <div class="footer">
      <p>© ${new Date().getFullYear()} SweepAlgo. All rights reserved.</p>
      <p>You're receiving this because you purchased a SweepAlgo subscription.</p>
    </div>
  </div>
</body>
</html>
`;
}

/**
 * Generates plain text version of welcome email
 */
function generateWelcomeEmailText({ firstName, subscriptionTier, setPasswordUrl }) {
  const tierDisplayName = {
    'basic': 'Basic',
    'pro': 'Pro',
    'premium': 'Premium',
    'enterprise': 'Enterprise',
  }[subscriptionTier] || subscriptionTier;
  
  return `
Welcome to SweepAlgo${firstName ? `, ${firstName}` : ''}!

Thank you for purchasing SweepAlgo! Your account has been created automatically.

Your subscription tier: ${tierDisplayName}

To get started, please set your password by visiting:
${setPasswordUrl}

This link expires in 24 hours. If it expires, you can request a new one from the login page.

What you get with ${tierDisplayName}:
- Real-time options flow analysis
- Gamma exposure (GEX) visualization
- Advanced filtering and alerts
- Historical data access
- Priority support

If you have any questions, simply reply to this email - we're here to help!

© ${new Date().getFullYear()} SweepAlgo. All rights reserved.
`.trim();
}

// ==========================================
// EXPORTED FUNCTIONS
// ==========================================

/**
 * Sends a welcome email to a new user
 * 
 * @param {Object} options - Email options
 * @param {string} options.email - Recipient email
 * @param {string} options.firstName - User's first name
 * @param {string} options.subscriptionTier - Subscription tier
 * @param {string} options.redirectUrl - Password reset redirect URL
 */
export async function sendWelcomeEmail({ email, firstName, subscriptionTier, redirectUrl }) {
  const setPasswordUrl = redirectUrl || `${process.env.FRONTEND_URL}/set-password?welcome=true`;
  
  const html = generateWelcomeEmailHTML({
    firstName,
    subscriptionTier,
    setPasswordUrl,
  });
  
  const text = generateWelcomeEmailText({
    firstName,
    subscriptionTier,
    setPasswordUrl,
  });
  
  return await sendEmail({
    to: email,
    subject: 'Welcome to SweepAlgo - Set Your Password',
    html,
    text,
  });
}

/**
 * Sends a password reset email
 * 
 * @param {Object} options - Email options
 * @param {string} options.email - Recipient email
 * @param {string} options.firstName - User's first name (optional)
 * @param {string} options.resetUrl - Password reset URL
 */
export async function sendPasswordResetEmail({ email, firstName, resetUrl }) {
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reset Your Password</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      line-height: 1.6;
      color: #333;
      max-width: 600px;
      margin: 0 auto;
      padding: 20px;
      background-color: #f5f5f5;
    }
    .container {
      background-color: #ffffff;
      border-radius: 12px;
      padding: 40px;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
    }
    .logo {
      text-align: center;
      margin-bottom: 30px;
    }
    .logo h1 {
      color: #6366f1;
      font-size: 28px;
      margin: 0;
    }
    h2 {
      color: #1a1a1a;
      font-size: 24px;
      margin-bottom: 20px;
    }
    p {
      color: #4a4a4a;
      font-size: 16px;
      margin-bottom: 15px;
    }
    .button-container {
      text-align: center;
      margin: 30px 0;
    }
    .button {
      display: inline-block;
      background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
      color: white !important;
      text-decoration: none;
      padding: 16px 40px;
      border-radius: 8px;
      font-weight: 600;
      font-size: 16px;
    }
    .footer {
      text-align: center;
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid #eee;
    }
    .footer p {
      color: #888;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">
      <h1>SweepAlgo</h1>
    </div>
    
    <h2>Reset Your Password</h2>
    
    <p>Hi${firstName ? ` ${firstName}` : ''},</p>
    
    <p>We received a request to reset your password. Click the button below to set a new password:</p>
    
    <div class="button-container">
      <a href="${resetUrl}" class="button">Reset Password</a>
    </div>
    
    <p>This link expires in 24 hours.</p>
    
    <p>If you didn't request this, you can safely ignore this email.</p>
    
    <div class="footer">
      <p>© ${new Date().getFullYear()} SweepAlgo. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
`;
  
  const text = `
Reset Your Password

Hi${firstName ? ` ${firstName}` : ''},

We received a request to reset your password. Visit the link below to set a new password:

${resetUrl}

This link expires in 24 hours.

If you didn't request this, you can safely ignore this email.

© ${new Date().getFullYear()} SweepAlgo. All rights reserved.
`.trim();
  
  return await sendEmail({
    to: email,
    subject: 'Reset Your SweepAlgo Password',
    html,
    text,
  });
}

export default {
  sendWelcomeEmail,
  sendPasswordResetEmail,
  sendEmail,
};
