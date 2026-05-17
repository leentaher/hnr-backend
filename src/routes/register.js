const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const { customers } = require('../lib/db');
const { generateApiKey } = require('../lib/keys');
const { sendApiKeyEmail, sendCardSetupEmail } = require('../lib/email');

// Stripe singleton — instantiated once at module load, not per request
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Simple in-memory rate limiter for /register — max 5 registrations per IP per hour
const registerAttempts = new Map(); // ip → { count, resetAt }
function checkRateLimit(ip) {
  const now = Date.now();
  const rec = registerAttempts.get(ip);
  if (!rec || rec.resetAt < now) {
    registerAttempts.set(ip, { count: 1, resetAt: now + 3600_000 });
    return true;
  }
  if (rec.count >= 5) return false;
  rec.count++;
  return true;
}

// POST /register
// Body: { email, address: { line1, city, state, postal_code, country } }
// Returns: { api_key, setup_url, message }
router.post('/', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'rate_limited', message: 'Too many registrations from this IP. Try again in an hour.' });
  }

  const { email, name, address } = req.body || {};

  if (!email || typeof email !== 'string' || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'invalid_field', field: 'email', message: 'A valid email address is required.' });
  }
  if (!name || typeof name !== 'string' || name.trim().length < 1) {
    return res.status(400).json({ error: 'missing_field', field: 'name', message: 'A name is required for the shipping label.' });
  }
  if (!address || !address.line1 || !address.city || !address.state || !address.postal_code || !address.country) {
    return res.status(400).json({
      error: 'missing_field',
      field: 'address',
      required: ['line1', 'city', 'state', 'postal_code', 'country'],
    });
  }

  // Reject duplicate registrations
  for (const [, c] of customers) {
    if (c.email === email) {
      return res.status(409).json({ error: 'already_registered', message: 'This email is already registered. Use POST /register/resend-setup to get a new card setup link.' });
    }
  }

  try {
    // 1. Create Stripe customer
    const stripeCustomer = await stripe.customers.create({
      email,
      shipping: {
        name,
        address: {
          line1: address.line1,
          line2: address.line2 || '',
          city: address.city,
          state: address.state,
          postal_code: address.postal_code,
          country: address.country,
        },
      },
    });

    // 2. Create Stripe Checkout session in setup mode — gives the human a real hosted payment page
    const appUrl = process.env.APP_URL || 'https://web-production-77376.up.railway.app';
    const checkoutSession = await stripe.checkout.sessions.create({
      mode: 'setup',
      customer: stripeCustomer.id,
      currency: 'usd',
      success_url: `${appUrl}/setup-complete?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/setup-cancel`,
    });
    const setupUrl = checkoutSession.url;

    // 3. Generate API key and store customer record
    const apiKey = generateApiKey();
    customers.set(apiKey, {
      stripeCustomerId: stripeCustomer.id,
      email,
      name,
      address,
      ordersToday: 0,
      lastOrderDate: null,
    });

    // 4. Email the API key (graceful — won't crash if misconfigured)
    try {
      await sendApiKeyEmail({ to: email, apiKey });
    } catch (emailErr) {
      console.warn('[register] API key email failed:', emailErr.message);
    }

    // 5. Email the Stripe Checkout setup link
    try {
      await sendCardSetupEmail({ to: email, setupUrl });
    } catch (emailErr) {
      console.warn('[register] Card setup email failed:', emailErr.message);
    }

    res.status(201).json({
      api_key: apiKey,
      setup_url: setupUrl,
      message: 'Registration successful. Tell the human to click the setup_url to save their card — after that you can order autonomously forever.',
    });
  } catch (err) {
    console.error('[register] Error:', err.message);
    if (err.type && err.type.startsWith('Stripe')) {
      return res.status(502).json({ error: 'stripe_error', message: err.message });
    }
    res.status(500).json({ error: 'internal_error', message: 'Registration failed. Try again.' });
  }
});

// POST /register/resend-setup
// Re-sends a fresh Stripe Checkout setup link to an existing registered email
router.post('/resend-setup', async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'missing_field', field: 'email' });

  let foundKey = null;
  let foundCustomer = null;
  for (const [key, c] of customers) {
    if (c.email === email) { foundKey = key; foundCustomer = c; break; }
  }
  if (!foundCustomer) {
    return res.status(404).json({ error: 'not_found', message: 'Email not registered. Use POST /register first.' });
  }

  try {
    const appUrl = process.env.APP_URL || 'https://web-production-77376.up.railway.app';
    const checkoutSession = await stripe.checkout.sessions.create({
      mode: 'setup',
      customer: foundCustomer.stripeCustomerId,
      currency: 'usd',
      success_url: `${appUrl}/setup-complete?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/setup-cancel`,
    });

    try {
      await sendCardSetupEmail({ to: email, setupUrl: checkoutSession.url });
    } catch (emailErr) {
      console.warn('[resend-setup] Email failed:', emailErr.message);
    }

    res.json({ setup_url: checkoutSession.url, message: 'New setup link sent to the human.' });
  } catch (err) {
    console.error('[resend-setup] Error:', err.message);
    res.status(502).json({ error: 'stripe_error', message: err.message });
  }
});

module.exports = router;
