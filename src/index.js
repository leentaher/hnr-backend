require('dotenv').config();
const express = require('express');
const path = require('path');
const Stripe = require('stripe');
const helmet = require('helmet');

// Catch unhandled rejections so Railway logs show the real error instead of just crashing
process.on('unhandledRejection', (reason, promise) => {
  console.error('[unhandledRejection]', reason);
});

const { initDb, getCustomerByEmail, getX402RateLimit } = require('./lib/db');
const { getProduct } = require('./lib/products');
const registerRouter = require('./routes/register');
const ordersRouter = require('./routes/orders');
const checkoutRouter = require('./routes/checkout');
const emailRouter = require('./routes/email');

// Stripe client — only instantiated when Stripe is enabled.
// Instantiating with undefined throws in Stripe SDK v14+, so guard it here.
const stripeEnabled = (process.env.ENABLE_STRIPE || 'true').toLowerCase().trim() !== 'false';
const stripe = stripeEnabled ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

// Validate wallet address at startup before accepting any payments
if (process.env.STORE_WALLET_ADDRESS && !/^0x[0-9a-fA-F]{40}$/.test(process.env.STORE_WALLET_ADDRESS)) {
  console.error('[startup] STORE_WALLET_ADDRESS is not a valid Ethereum address — aborting to prevent lost payments');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1); // Railway / reverse-proxy: trust X-Forwarded-For for real client IP

// Security headers — Helmet sets X-Content-Type-Options, X-Frame-Options, HSTS,
// Referrer-Policy, X-XSS-Protection, X-DNS-Prefetch-Control, Permissions-Policy.
// CSP and COEP disabled globally (API — no scripts/resources to restrict).
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

// Tighten headers on the two HTML pages where a browser loads a real page
app.use(['/setup-complete', '/setup-cancel'], (req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  next();
});

// CORS — restrict to configured origins (defaults to APP_URL for the setup flow).
// For a pure agent API no browser clients need CORS at all; this keeps the setup
// page working while blocking arbitrary third-party origins from reading responses.
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS || process.env.APP_URL || '')
    .split(',').map(o => o.trim()).filter(Boolean)
);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    // Known origin: allow full headers including Authorization
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Payment, Payment-Signature, MCP-Session-Id');
  } else if (!origin || allowedOrigins.size === 0) {
    // No browser origin (agent/server call) or no origins configured: omit ACAO entirely.
    // Browsers block credentialed requests to wildcard origins anyway; agents don't need CORS.
  } else {
    // Unknown origin — block silently (no ACAO header = browser blocks the response)
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'X-Payment-Response, Payment-Required');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '10kb' }));

// Dynamic /.well-known routes are registered BEFORE express.static so a stale static
// file (e.g. an old hardcoded payment-manifest.json) can never shadow them — that
// shadowing is what let the old $35 manifest leak out while /checkout charged $1.

// OpenAPI spec (GPT action auto-config)
app.get('/.well-known/openapi.json', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'openapi.json'));
});

// Payment manifest — emitted dynamically from lib/pricing so it always matches the live
// checkout price + network. Replaces the old static public/.well-known/payment-manifest.json,
// which hardcoded $35 and could drift from what /checkout actually charges.
app.get('/.well-known/payment-manifest.json', (req, res) => {
  const { getPricing } = require('./lib/pricing');
  const { priceStr, network, networkLabel, usdcAddress } = getPricing();
  res.json({
    protocol: 'x402',
    version: '2',
    description: 'Human Not Required accepts USDC payments from AI agents via x402 on Base. No registration, no card — agents pay directly from their wallet.',
    endpoints: [
      {
        path: '/checkout',
        method: 'POST',
        price: priceStr,
        currency: 'USDC',
        network,
        chain: networkLabel,
        usdc_contract: usdcAddress,
        description: `Buy the "My Agent Bought Me This" embroidered hat — ${priceStr} USDC on ${networkLabel}. Send { sku: "hat-myagent-os", name, email, address: { line1, city, state, postal_code, country } }.`,
        body_schema: {
          sku: 'hat-myagent-os',
          name: 'Full name for shipping label',
          email: 'Email for receipt',
          address: { line1: 'Street address', city: 'City', state: 'State/province', postal_code: 'Postal code', country: 'ISO 3166-1 alpha-2 country code' },
        },
      },
    ],
    contact: 'leen.taher@gmail.com',
  });
});

// Serve remaining static files (llms.txt, agent.json, etc.). Mounted AFTER the dynamic
// routes above so it only handles files that aren't dynamically generated.
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/.well-known', express.static(path.join(__dirname, '..', 'public', '.well-known')));

// Validate POST /checkout fields BEFORE x402 fires so payment never settles on invalid input.
// Requests that fail here return 400 without touching the x402 middleware.
// Valid requests fall through to x402 (which issues a 402 challenge if unpaid,
// or settles payment and calls next() if the X-Payment header is present).
app.post('/checkout', async (req, res, next) => {
  // Fulfillment gates run BEFORE the x402 middleware so we never settle USDC for an order
  // we can't fulfill (store closed, Shopify unconfigured, variant missing). Returning here
  // skips the x402 middleware entirely, so no payment is ever taken.
  if ((process.env.STORE_OPEN || 'true').toLowerCase().trim() === 'false') {
    return res.status(503).json({ error: 'store_closed', message: 'The store is temporarily closed. Check back soon.' });
  }

  // x402 discovery: a request without a payment header is asking for the 402 challenge
  // (payment requirements), not placing an order — standard x402 clients probe this way and
  // may not send a body yet. Fall through to the x402 middleware so it issues the 402.
  // The PAID retry carries the payment header and re-runs every gate below BEFORE settlement,
  // so we still never settle USDC on invalid input. Check BOTH header names (v2
  // PAYMENT-SIGNATURE and v1 X-PAYMENT) so a paid v2 request can never skip validation —
  // mirrors the detection in lib/x402-payment.js.
  if (!req.get('payment-signature') && !req.get('x-payment')) {
    return next();
  }

  const { sku, name, email, address } = req.body || {};

  if (!sku) {
    return res.status(400).json({ error: 'missing_field', field: 'sku', hint: 'GET /orders/skus to see available products' });
  }

  const product = getProduct(sku);
  if (!product) {
    return res.status(400).json({ error: 'invalid_sku', message: `SKU "${sku}" not found`, hint: 'GET /orders/skus to see available products' });
  }

  // Can we actually fulfill this SKU? Check before payment, not after.
  if (!process.env.SHOPIFY_STORE_DOMAIN || !process.env.SHOPIFY_ADMIN_API_KEY) {
    return res.status(503).json({ error: 'service_unavailable', message: 'Fulfillment is temporarily unavailable. No payment was taken.' });
  }
  if (!product.shopifyVariantId || product.shopifyVariantId === 'FILL_ME') {
    return res.status(503).json({ error: 'product_not_configured', message: `SKU "${sku}" is not available for purchase right now. No payment was taken.` });
  }

  if (!name || !email || !address?.line1 || !address?.city || !address?.state || !address?.postal_code || !address?.country) {
    return res.status(400).json({
      error: 'needs_address',
      prompt: 'Ask the human: what is their full name, email address, and shipping address (street, city, state, postal code, country)?',
      required: ['name', 'email', 'address.line1', 'address.city', 'address.state', 'address.postal_code', 'address.country'],
      hint: 'Retry POST /checkout with all required fields.',
    });
  }

  const nameTrimmed = name.trim();
  if (nameTrimmed.length < 2 || nameTrimmed.split(/\s+/).length < 2) {
    return res.status(400).json({
      error: 'invalid_name',
      message: 'A full name (first and last) is required for the shipping label.',
      hint: 'Provide the recipient\'s full name e.g. "Jane Smith". No payment is charged.',
    });
  }

  const TEST_DOMAINS = new Set(['test.com', 'test.test', 'example.com', 'example.org',
    'example.net', 'dummy.com', 'fake.com', 'noemail.com', 'noreply.com', 'invalid.com']);
  const emailDomain = email.toLowerCase().split('@')[1] || '';
  if (TEST_DOMAINS.has(emailDomain)) {
    return res.status(400).json({
      error: 'invalid_email',
      message: `"${emailDomain}" is not a valid email domain. Provide a real email to receive your order confirmation.`,
      hint: 'Use the recipient\'s real email address. No payment is charged.',
    });
  }

  if (address.line1.trim().length < 5) {
    return res.status(400).json({
      error: 'invalid_address',
      field: 'address.line1',
      message: 'Street address must be at least 5 characters.',
      hint: 'Provide the full street address e.g. "123 Main Street". No payment is charged.',
    });
  }

  const fieldLimits = { name: 200, 'address.line1': 200, 'address.city': 100, 'address.state': 100, 'address.postal_code': 20 };
  for (const [field, max] of Object.entries(fieldLimits)) {
    const val = field.includes('.') ? address[field.split('.')[1]] : (field === 'name' ? name : null);
    if (val && val.length > max) {
      return res.status(400).json({
        error: 'field_too_long',
        field,
        max_length: max,
        message: `"${field}" exceeds maximum length of ${max} characters.`,
      });
    }
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({
      error: 'invalid_email',
      message: `"${email}" is not a valid email address`,
      hint: 'Provide a valid email address (e.g. name@example.com).',
    });
  }

  if (!/^[A-Z]{2}$/.test(address.country.toUpperCase())) {
    return res.status(400).json({
      error: 'invalid_country',
      message: `"${address.country}" is not a valid ISO country code`,
      hint: 'Use a 2-letter ISO country code e.g. US, CA, GB, AU.',
    });
  }

  address.country = address.country.toUpperCase();
  req.body.email = email.toLowerCase();
  const normEmail = req.body.email;

  // Daily per-email cap is OFF by default (0). Set X402_DAILY_LIMIT=N in prod to re-enable.
  const dailyLimit = parseInt(process.env.X402_DAILY_LIMIT ?? '0', 10);
  if (dailyLimit > 0) {
    try {
      const count = await getX402RateLimit(normEmail);
      if (count >= dailyLimit) {
        return res.status(429).json({
          error: 'rate_limit',
          message: `This email has already placed ${dailyLimit} orders today via x402. Try again tomorrow.`,
          hint: `Maximum ${dailyLimit} x402 orders per email per 24 hours.`,
        });
      }
    } catch (err) {
      console.error('[checkout] Rate limit DB error — blocking request:', err.message);
      return res.status(503).json({
        error: 'service_unavailable',
        message: 'Unable to verify rate limit. Please try again in a moment.',
      });
    }
  }

  next();
});

// x402 payment middleware — protects POST /checkout with USDC on Base
// STORE_WALLET_ADDRESS: your Base wallet address that receives USDC
// Falls back gracefully if not configured (x402 disabled)
let x402Active = false; // fail-closed gate: /checkout only mounts the real handler when x402 settlement is live
if (process.env.STORE_WALLET_ADDRESS) {
  // Price + network come from the single source of truth (lib/pricing) so the checkout
  // charge, /orders/skus, the MCP tool text, and the payment manifest can never disagree.
  const { getPricing, checkoutDescription } = require('./lib/pricing');
  const { env: X402_ENV, network, priceStr: x402Price } = getPricing();
  const x402Description = checkoutDescription();
  console.log(`[x402] X402_ENV=${X402_ENV}`);

  // x402.org/facilitator is behind Cloudflare which blocks Railway's AWS IPs.
  // Default to the Vercel proxy which can reach x402.org reliably.
  // Override via X402_FACILITATOR_URL env var if needed.
  const facilitatorUrl = process.env.X402_FACILITATOR_URL || 'https://test-inky-five-64.vercel.app/api/x402-proxy';

  try {
    const { paymentMiddleware, x402ResourceServer } = require('@x402/express');
    const { HTTPFacilitatorClient } = require('@x402/core/server');
    const { ExactEvmScheme } = require('@x402/evm/exact/server');
    const { declareDiscoveryExtension } = require('@x402/extensions');
    const crypto = require('crypto');

    // CDP Secret API keys use simple Bearer token auth (Key ID + Secret),
    // not the JWT/EC signing approach. Pass the secret directly.
    const cdpKeyName = process.env.CDP_API_KEY_NAME;
    const cdpSecret = process.env.CDP_API_KEY_PRIVATE_KEY;

    const facilitatorConfig = { url: facilitatorUrl };
    if (cdpKeyName && cdpSecret) {
      facilitatorConfig.createAuthHeaders = async () => {
        const headers = { Authorization: `Bearer ${cdpSecret}` };
        return { verify: headers, settle: headers, supported: headers };
      };
      console.log('[x402] CDP auth configured');
    } else {
      console.warn('[x402] CDP_API_KEY_NAME/PRIVATE_KEY not set — facilitator calls will be unauthenticated');
    }

    const facilitatorClient = new HTTPFacilitatorClient(facilitatorConfig);
    const resourceServer = new x402ResourceServer(facilitatorClient)
      .register(network, new ExactEvmScheme());
    // Bazaar extension is auto-registered by paymentMiddleware when it detects
    // declareDiscoveryExtension metadata in the route config below

    app.use(paymentMiddleware(
      {
        'POST /checkout': {
          accepts: {
            scheme: 'exact',
            price: x402Price,
            network,
            payTo: process.env.STORE_WALLET_ADDRESS,
          },
          description: x402Description,
          // Bazaar discovery metadata — produces the rich card in CDP Bazaar search
          extensions: declareDiscoveryExtension({
            discoverable: true,
            name: 'Humans Not Required — Agent Hat Store',
            description: 'Buy the "My Agent Bought Me This" embroidered hat. Agents pay directly with USDC on Base — no human needed.',
            bodyType: 'json',
            input: {
              sku: { type: 'string', description: 'Product SKU. Use "hat-myagent-os" for the embroidered hat.' },
              name: { type: 'string', description: 'Full name of the recipient for shipping.' },
              email: { type: 'string', description: 'Email address for the order confirmation receipt.' },
              address: {
                type: 'object',
                description: 'Shipping address.',
                properties: {
                  line1: { type: 'string', description: 'Street address line 1.' },
                  line2: { type: 'string', description: 'Street address line 2 (optional).' },
                  city: { type: 'string', description: 'City.' },
                  state: { type: 'string', description: 'State or province.' },
                  postal_code: { type: 'string', description: 'ZIP or postal code.' },
                  country: { type: 'string', description: 'ISO 2-letter country code, e.g. US, CA, GB.' },
                },
              },
            },
            output: {
              example: {
                order_id: 'ORD-abc123',
                status: 'placed',
                sku: 'hat-myagent-os',
                payment: 'x402_usdc_base',
                message: 'Payment settled on Base. Your hat is on the way.',
              },
            },
          }),
        },
      },
      resourceServer,
    ));
    x402Active = true;
    console.log(`[x402] Payment middleware active on POST /checkout (network: ${network}, price: ${x402Price})`);
  } catch (err) {
    console.error('[x402] FATAL: payment middleware failed to initialize — /checkout DISABLED (fail closed) to prevent unpaid orders:', err.message);
  }
} else {
  console.error('[x402] STORE_WALLET_ADDRESS not set — /checkout DISABLED (fail closed) to prevent unpaid orders');
}

// Routes
// x402 flow — FAIL CLOSED: only mount the real checkout handler when payment settlement is
// actually active. If x402 failed to init (or STORE_WALLET_ADDRESS is unset), serve a 503
// instead — otherwise checkout.js would create Shopify orders with no payment taken.
if (x402Active) {
  app.use('/checkout', checkoutRouter);
} else {
  app.use('/checkout', (req, res) => res.status(503).json({
    error: 'payment_unavailable',
    message: 'Checkout is temporarily unavailable — no payment system is active. No order was created and no payment was taken.',
  }));
}

console.log(`[stripe] ENABLE_STRIPE="${process.env.ENABLE_STRIPE}" → stripeEnabled=${stripeEnabled}`);
// GET /orders/skus is always available regardless of Stripe flag
// ordersRouter handles its own 404s for Stripe-only endpoints when stripeEnabled=false
app.use('/orders', ordersRouter);

if (stripeEnabled) {
  app.use('/register', registerRouter);
  app.use('/email', emailRouter);
  console.log('[stripe] Stripe flow enabled');
} else {
  app.use('/register', (req, res) => res.status(404).json({ error: 'not_available', message: 'This store uses x402 USDC payments only. See /checkout.' }));
  console.log('[stripe] Stripe flow disabled (ENABLE_STRIPE=false)');
}

// MCP HTTP endpoint — loaded via dynamic import (SDK is ESM-only)
// Register placeholder synchronously so it sits BEFORE the 404 handler
let mcpRouter = null;
import('./routes/mcp.mjs').then(({ createMcpRouter }) => {
  mcpRouter = createMcpRouter();
  console.log('[mcp] HTTP endpoint ready at /mcp');
}).catch(err => {
  console.warn('[mcp] Failed to load MCP router (non-fatal):', err.message);
});
app.use('/mcp', (req, res, next) => {
  if (mcpRouter) return mcpRouter(req, res, next);
  res.status(503).json({ error: 'mcp_starting', message: 'MCP server is starting, try again in a moment.' });
});

// Rate limit for /setup (in-memory, per IP)
const setupAttempts = new Map();

// Prune IPs that haven't hit /setup in the last minute — prevents unbounded Map growth
setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [ip, times] of setupAttempts.entries()) {
    const fresh = times.filter(t => t > cutoff);
    if (fresh.length === 0) setupAttempts.delete(ip);
    else setupAttempts.set(ip, fresh);
  }
}, 5 * 60_000).unref(); // unref so it doesn't keep the process alive during tests

// GET /setup?email=... — browser-friendly card setup (creates fresh Stripe session and redirects)
app.get('/setup', async (req, res) => {
  // x402-only: no card setup exists. Guard before touching the (null) Stripe client.
  if (!stripeEnabled) {
    return res.status(404).json({ error: 'not_available', message: 'This store uses x402 USDC payments only. No card setup needed — see /checkout.' });
  }
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
// Safe messages only — never forward raw err.message to callers (may leak internals)
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  console.error('[unhandled]', err);
  if (status >= 500) {
    return res.status(status).json({ error: 'internal_error', message: 'Something went wrong. Please try again.' });
  }
  // Map common middleware statuses to safe messages
  const safeMessages = {
    400: 'Bad request',
    401: err.message || 'Unauthorized',
    402: err.message || 'Payment required',
    403: 'Forbidden',
    404: 'Not found',
    405: 'Method not allowed',
    413: 'Request body too large (max 10kb)',
    429: err.message || 'Too many requests',
  };
  const message = safeMessages[status] || 'Request error';
  res.status(status).json({ error: err.type || 'request_error', message });
});

const PORT = process.env.PORT || 3000;
const { checkShopifyPriceConsistency } = require('./lib/price-guardrail');
initDb()
  // Verify Shopify's price agrees with the x402 charge before we serve traffic. Returns
  // normally (logs a warning) unless STRICT_PRICE_CHECK=true and a real drift is found,
  // in which case it throws and we fail closed. Shopify outages are non-fatal (see lib).
  .then(() => checkShopifyPriceConsistency().catch(err => {
    console.error('[startup] price guardrail failed (strict mode):', err.message);
    process.exit(1);
  }))
  .then(() => app.listen(PORT, () => console.log(`Human Not Required API running on port ${PORT}`)))
  .catch(err => { console.error('[startup] DB init failed:', err.message); process.exit(1); });
