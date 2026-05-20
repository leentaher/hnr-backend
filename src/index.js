require('dotenv').config();
const express = require('express');
const path = require('path');
const Stripe = require('stripe');
const { paymentMiddleware, x402ResourceServer } = require('@x402/express');
const { HTTPFacilitatorClient } = require('@x402/core/server');
const { ExactEvmScheme } = require('@x402/evm/exact/server');
const NodeCache = require('node-cache');

const { initDb, getCustomerByEmail } = require('./lib/db');
const registerRouter = require('./routes/register');
const ordersRouter = require('./routes/orders');
const checkoutRouter = require('./routes/checkout');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const app = express();
app.set('trust proxy', 1); // Railway / reverse-proxy: trust X-Forwarded-For for real client IP

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '10kb' }));

// Serve static files (llms.txt, /.well-known/)
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/.well-known', express.static(path.join(__dirname, '..', 'public', '.well-known')));

// OpenAPI spec (GPT action auto-config)
app.get('/.well-known/openapi.json', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'openapi.json'));
});

// x402 payment middleware — protects POST /checkout with USDC on Base
// STORE_WALLET_ADDRESS: your Base wallet address that receives USDC
// Falls back gracefully if not configured (x402 disabled)
if (process.env.STORE_WALLET_ADDRESS) {
  const facilitatorUrl = process.env.X402_FACILITATOR_URL || 'https://facilitator.x402.org';
  const network = process.env.X402_NETWORK || 'eip155:84532'; // Base Sepolia testnet by default

  try {
    const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });
    const resourceServer = new x402ResourceServer(facilitatorClient)
      .register(network, new ExactEvmScheme());

    app.use(paymentMiddleware(
      {
        'POST /checkout': {
          accepts: {
            scheme: 'exact',
            price: '$35.00',
            network,
            payTo: process.env.STORE_WALLET_ADDRESS,
          },
          description: 'Buy the My Agent Bought Me This embroidered hat — $35 USDC on Base',
        },
      },
      resourceServer,
      undefined, // paywallConfig
      undefined, // paywall
      false,     // syncFacilitatorOnStart — avoid unhandled rejection crash on startup
    ));
    console.log(`[x402] Payment middleware active on POST /checkout (network: ${network})`);
  } catch (err) {
    console.warn('[x402] Failed to initialize payment middleware (non-fatal):', err.message);
  }
} else {
  console.warn('[x402] STORE_WALLET_ADDRESS not set — x402 checkout disabled');
}

// Routes
app.use('/register', registerRouter);
app.use('/orders', ordersRouter);
app.use('/checkout', checkoutRouter);

// Rate limit for /setup (in-memory, per IP)
const setupAttempts = new Map();

// GET /setup?email=... — browser-friendly card setup (creates fresh Stripe session and redirects)
app.get('/setup', async (req, res) => {
  // Rate limit: 5 attempts per IP per minute
  const ip = req.ip;
  const now = Date.now();
  const attempts = (setupAttempts.get(ip) || []).filter(t => now - t < 60_000);
  if (attempts.length >= 5) {
    return res.status(429).send('Too many requests. Try again in a minute.');
  }
  setupAttempts.set(ip, [...attempts, now]);

  const email = req.query.email;
  if (!email) return res.status(400).send('Missing email parameter. Use /setup?email=you@example.com');

  const foundCustomer = await getCustomerByEmail(email);
  if (!foundCustomer) return res.status(404).send('Email not registered. Use POST /register first.');

  try {
    const appUrl = process.env.APP_URL || 'https://web-production-77376.up.railway.app';
    const session = await stripe.checkout.sessions.create({
      mode: 'setup',
      customer: foundCustomer.stripe_customer_id,
      payment_method_types: ['card'],
      success_url: `${appUrl}/setup-complete`,
      cancel_url: `${appUrl}/setup-cancel`,
    });
    res.redirect(session.url);
  } catch (err) {
    console.error('[setup] Stripe error:', err.message);
    res.status(502).send('Card setup unavailable. Please try again later.');
  }
});

// Card setup confirmation pages (Stripe redirects here after setup)
app.get('/setup-complete', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>Card Saved</title><style>body{background:#1C1C1E;color:#00FF41;font-family:'Courier New',monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}</style></head><body><div><p style="font-size:2rem">✓</p><h1>Card saved.</h1><p>Your agent can now shop autonomously.</p><p style="color:#888;font-size:.9rem">You will receive a receipt for every purchase.</p></div></body></html>`);
});

app.get('/setup-cancel', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>Setup Cancelled</title><style>body{background:#1C1C1E;color:#FF3D8F;font-family:'Courier New',monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}</style></head><body><div><h1>Setup cancelled.</h1><p>No card saved. Your agent cannot place orders yet.</p><p style="color:#888;font-size:.9rem">Ask your agent to re-send the setup link when you're ready.</p></div></body></html>`);
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// 404
app.use((req, res) => res.status(404).json({ error: 'not_found' }));

// Global error handler — propagate HTTP status from middleware errors (e.g. 413 from body-size limit)
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('[unhandled]', err);
  res.status(status).json({ error: err.type || 'internal_error', message: err.message });
});

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => app.listen(PORT, () => console.log(`Human Not Required API running on port ${PORT}`)))
  .catch(err => { console.error('[startup] DB init failed:', err.message); process.exit(1); });
