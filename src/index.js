require('dotenv').config();
const express = require('express');
const path = require('path');
const Stripe = require('stripe');
const NodeCache = require('node-cache');

// Catch unhandled rejections so Railway logs show the real error instead of just crashing
process.on('unhandledRejection', (reason, promise) => {
  console.error('[unhandledRejection]', reason);
});

const { initDb, getCustomerByEmail } = require('./lib/db');
const { getProduct } = require('./lib/products');
const registerRouter = require('./routes/register');
const ordersRouter = require('./routes/orders');
const checkoutRouter = require('./routes/checkout');
const emailRouter = require('./routes/email');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const app = express();
app.set('trust proxy', 1); // Railway / reverse-proxy: trust X-Forwarded-For for real client IP

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Payment, Payment-Signature');
  res.setHeader('Access-Control-Expose-Headers', 'X-Payment-Response, Payment-Required');
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

// Pre-validate POST /checkout before x402 fires — agent never gets charged for a missing-field request
app.post('/checkout', (req, res, next) => {
  const { sku, name, email, address } = req.body || {};

  if (!sku) {
    return res.status(400).json({ error: 'missing_field', field: 'sku', hint: 'GET /orders/skus to see available products' });
  }

  if (!getProduct(sku)) {
    return res.status(400).json({ error: 'invalid_sku', message: `SKU "${sku}" not found`, hint: 'GET /orders/skus to see available products' });
  }

  if (!name || !email || !address?.line1 || !address?.city || !address?.state || !address?.postal_code || !address?.country) {
    return res.status(400).json({
      error: 'needs_address',
      prompt: 'Ask the human: what is their full name, email address, and shipping address (street, city, state, postal code, country)?',
      required: ['name', 'email', 'address.line1', 'address.city', 'address.state', 'address.postal_code', 'address.country'],
      hint: 'Retry POST /checkout with all required fields. No payment is charged until all fields are present.',
    });
  }

  next();
});

// x402 payment middleware — protects POST /checkout with USDC on Base
// STORE_WALLET_ADDRESS: your Base wallet address that receives USDC
// Falls back gracefully if not configured (x402 disabled)
if (process.env.STORE_WALLET_ADDRESS) {
  const facilitatorUrl = process.env.X402_FACILITATOR_URL || 'https://x402.org/facilitator';
  const network = process.env.X402_NETWORK || 'eip155:84532'; // Base Sepolia testnet by default

  try {
    const { paymentMiddleware, x402ResourceServer } = require('@x402/express');
    const { HTTPFacilitatorClient } = require('@x402/core/server');
    const { ExactEvmScheme } = require('@x402/evm/exact/server');
    const crypto = require('crypto');

    // Build a CDP JWT for the given sub-path (verify / settle / supported)
    // Parses the PEM at startup once so sign errors surface immediately in logs
    let cdpKeyObject = null;
    const cdpKeyName = process.env.CDP_API_KEY_NAME;
    if (cdpKeyName && process.env.CDP_API_KEY_PRIVATE_KEY) {
      try {
        const rawPem = process.env.CDP_API_KEY_PRIVATE_KEY.replace(/\\n/g, '\n');
        cdpKeyObject = crypto.createPrivateKey({ key: rawPem, format: 'pem' });
        console.log('[x402] CDP private key loaded OK');
      } catch (err) {
        console.error('[x402] Failed to parse CDP private key:', err.message);
      }
    }

    function buildCdpJwt(path) {
      if (!cdpKeyObject || !cdpKeyName) return null;
      try {
        const now = Math.floor(Date.now() / 1000);
        const nonce = crypto.randomBytes(16).toString('hex');
        const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: cdpKeyName })).toString('base64url');
        const payload = Buffer.from(JSON.stringify({
          sub: cdpKeyName, iss: 'cdp', nbf: now, exp: now + 120, nonce,
          uri: `POST api.cdp.coinbase.com/platform/v2/x402/${path}`,
        })).toString('base64url');

        const signingInput = `${header}.${payload}`;
        const sign = crypto.createSign('SHA256');
        sign.update(signingInput);
        const der = sign.sign(cdpKeyObject);

        // Convert DER-encoded EC signature to raw r||s (required by JWT ES256)
        let offset = 2;
        if (der[1] === 0x81) offset = 3;
        offset++;
        const rLen = der[offset++];
        let r = der.slice(offset, offset + rLen); offset += rLen;
        offset++;
        const sLen = der[offset++];
        let s = der.slice(offset, offset + sLen);
        if (r[0] === 0) r = r.slice(1);
        if (s[0] === 0) s = s.slice(1);
        const sig = Buffer.concat([Buffer.alloc(32 - r.length), r, Buffer.alloc(32 - s.length), s]).toString('base64url');

        return `${signingInput}.${sig}`;
      } catch (err) {
        console.error('[x402] CDP JWT signing failed:', err.message);
        return null;
      }
    }

    const facilitatorConfig = { url: facilitatorUrl };
    if (process.env.CDP_API_KEY_NAME && process.env.CDP_API_KEY_PRIVATE_KEY) {
      facilitatorConfig.createAuthHeaders = async () => {
        const authFor = (path) => {
          const token = buildCdpJwt(path);
          return token ? { Authorization: `Bearer ${token}` } : {};
        };
        return { verify: authFor('verify'), settle: authFor('settle'), supported: authFor('supported') };
      };
      console.log('[x402] CDP auth configured');
    } else {
      console.warn('[x402] CDP_API_KEY_NAME/PRIVATE_KEY not set — facilitator calls will be unauthenticated');
    }

    const facilitatorClient = new HTTPFacilitatorClient(facilitatorConfig);
    const resourceServer = new x402ResourceServer(facilitatorClient)
      .register(network, new ExactEvmScheme());

    app.use(paymentMiddleware(
      {
        'POST /checkout': {
          accepts: {
            scheme: 'exact',
            price: '$10.00',
            network,
            payTo: process.env.STORE_WALLET_ADDRESS,
          },
          description: 'Buy the My Agent Bought Me This embroidered hat — $35 USDC on Base',
        },
      },
      resourceServer,
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
app.use('/email', emailRouter);

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

// Temporary debug endpoint — shows what headers Railway passes through to Express
app.get('/debug-headers', (req, res) => res.json({ headers: req.headers }));

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// 404
app.use((req, res) => res.status(404).json({ error: 'not_found' }));

// Global error handler — propagate HTTP status from middleware errors (e.g. 413 from body-size limit)
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) {
    console.error('[unhandled]', err);
    return res.status(status).json({ error: 'internal_error', message: 'Something went wrong. Please try again.' });
  }
  res.status(status).json({ error: err.type || 'internal_error', message: err.message });
});

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => app.listen(PORT, () => console.log(`Human Not Required API running on port ${PORT}`)))
  .catch(err => { console.error('[startup] DB init failed:', err.message); process.exit(1); });
