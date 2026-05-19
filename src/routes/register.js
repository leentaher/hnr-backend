const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const { getCustomerByEmail, createCustomer, isPromoUsed, markPromoUsed } = require('../lib/db');
const { generateApiKey } = require('../lib/keys');
const { sendApiKeyEmail, sendCardSetupEmail } = require('../lib/email');
const { isValidPromoCode } = require('../lib/promos');

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

  const { email, name, address, promo_code } = req.body || {};

  if (!email || typeof email !== 'string' || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'invalid_field', field: 'email', message: 'A valid email address is required.' });
  }
  if (!name || typeof name !== 'string' || name.trim().length < 1) {
    return res.status(400).json({ error: 'missing_field', field: 'name', message: 'A name is required for the shipping label.' });
  }
  if (!address || !address.line1 || !address.city || !address.state || !address.postal_code || !address.country) {
    return res.status(400).json({ error: 'missing_field', field: 'address', message: 'address.line1, city, state, postal_code, and country are required.' });
  }

  // Validate promo code if provided
  let freeOrders = 0;
  if (promo_code) {
    if (!isValidPromoCode(promo_code)) {
      return res.status(400).json({ error: 'invalid_promo_code', message: 'That promo code is not valid.' });
    }
    const alreadyUsed = await isPromoUsed(promo_code);
    if (alreadyUsed) {
      return res.status(409).json({ error: 'promo_already_used', message: 'That promo code has already been redeemed.' });
    }
    freeOrders = 1;
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

    // 2. Check if human already has a saved card via Stripe Link
    let hasLinkCard = false;
    if (freeOrders === 0) {
      try {
        const paymentMethods = await stripe.customers.listPaymentMethods(stripeCustomer.id, { type: 'card' });
        hasLinkCard = paymentMethods.data.length > 0;
      } catch (err) {
        console.warn('[register] Link check failed (non-fatal):', err.message);
      }
    }

    // 3. Save to database
    const apiKey = generateApiKey();
    await createCustomer({ apiKey, stripeCustomerId: stripeCustomer.id, email, name, address, freeOrders });

    // 4. Mark promo as used
    if (promo_code && freeOrders > 0) {
      await markPromoUsed(promo_code, email);
    }

    // 5. Build setup URL — only needed if no promo and no Link card
    const setupUrl = `${APP_URL}/setup?email=${encodeURIComponent(email)}`;
    const needsSetup = freeOrders === 0 && !hasLinkCard;

    // 6. Send emails in background
    sendApiKeyEmail({ to: email, apiKey }).catch(err => console.warn('[register] API key email failed:', err.message));
    if (needsSetup) {
      sendCardSetupEmail({ to: email, setupUrl }).catch(err => console.warn('[register] Card setup email failed:', err.message));
    }

    const message = freeOrders > 0
      ? 'Registration successful. You have 1 free order — no card needed. Call POST /orders with your api_key to claim your free hat.'
      : hasLinkCard
        ? 'Registration successful. A saved card was found via Stripe Link — you can order immediately. Call POST /orders with your api_key.'
        : 'Registration successful. Tell the human to click the setup_url to save their card — after that you can order autonomously forever.';

    res.status(201).json({
      api_key: apiKey,
      setup_url: needsSetup ? setupUrl : null,
      free_orders_remaining: freeOrders,
      has_saved_card: hasLinkCard || freeOrders > 0,
      message,
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
