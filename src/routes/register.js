const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const { getCustomerByEmail, createCustomer } = require('../lib/db');
const { generateApiKey } = require('../lib/keys');
const { sendApiKeyEmail, sendCardSetupEmail } = require('../lib/email');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAILY_REGISTER_LIMIT = 5;
const registerAttempts = new Map();

const APP_URL = process.env.APP_URL || 'https://web-production-77376.up.railway.app';

// POST /register
router.post('/', async (req, res) => {
  const ip = req.ip;
  const now = Date.now();
  const attempts = (registerAttempts.get(ip) || []).filter(t => now - t < 60_000);
  if (attempts.length >= DAILY_REGISTER_LIMIT) {
    return res.status(429).json({ error: 'rate_limited', message: 'Too many registration attempts. Try again in a minute.' });
  }
  registerAttempts.set(ip, [...attempts, now]);

  const { email, name, address } = req.body || {};

  if (!email || typeof email !== 'string' || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'invalid_field', field: 'email', message: 'A valid email address is required.' });
  }
  if (!name || typeof name !== 'string' || name.trim().length < 1) {
    return res.status(400).json({ error: 'missing_field', field: 'name', message: 'A name is required for the shipping label.' });
  }
  if (!address || !address.line1 || !address.city || !address.state || !address.postal_code || !address.country) {
    return res.status(400).json({ error: 'missing_field', field: 'address', message: 'address.line1, city, state, postal_code, and country are required.' });
  }

  try {
    const existing = await getCustomerByEmail(email);
    if (existing) {
      return res.status(409).json({ error: 'already_registered', message: 'This email is already registered. Use POST /register/resend-setup to get a new card setup link.' });
    }

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

    // 2. Save to database
    const apiKey = generateApiKey();
    await createCustomer({ apiKey, stripeCustomerId: stripeCustomer.id, email, name, address });

    // 3. Build setup URL (always fresh — never expires)
    const setupUrl = `${APP_URL}/setup?email=${encodeURIComponent(email)}`;

    // 4. Send emails in background
    sendApiKeyEmail({ to: email, apiKey }).catch(err => console.warn('[register] API key email failed:', err.message));
    sendCardSetupEmail({ to: email, setupUrl }).catch(err => console.warn('[register] Card setup email failed:', err.message));

    res.status(201).json({
      api_key: apiKey,
      setup_url: setupUrl,
      message: 'Registration successful. Tell the human to click the setup_url to save their card — after that you can order autonomously forever.',
    });
  } catch (err) {
    console.error('[register] Error:', err.message);
    res.status(502).json({ error: 'registration_failed', message: 'Registration failed. Please try again.' });
  }
});

// POST /register/resend-setup
router.post('/resend-setup', async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'missing_field', field: 'email' });

  const customer = await getCustomerByEmail(email);
  if (!customer) {
    return res.status(404).json({ error: 'not_found', message: 'Email not registered. Use POST /register first.' });
  }

  const setupUrl = `${APP_URL}/setup?email=${encodeURIComponent(email)}`;
  sendCardSetupEmail({ to: email, setupUrl }).catch(err => console.warn('[resend-setup] Email failed:', err.message));

  res.json({ api_key: customer.api_key, setup_url: setupUrl, message: 'Setup link sent. The human can click it any time — it never expires.' });
});

module.exports = router;
