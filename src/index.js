require('dotenv').config();
const express = require('express');
const path = require('path');

const { initDb } = require('./lib/db');
const registerRouter = require('./routes/register');
const ordersRouter = require('./routes/orders');

const app = express();
app.use(express.json());

// Serve /.well-known/ static files
app.use('/.well-known', express.static(path.join(__dirname, '..', 'public', '.well-known')));

// OpenAPI spec (GPT action auto-config)
app.get('/.well-known/openapi.json', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'openapi.json'));
});

// Routes
app.use('/register', registerRouter);
app.use('/orders', ordersRouter);

// GET /setup?email=... — browser-friendly card setup (creates fresh Stripe session and redirects)
app.get('/setup', async (req, res) => {
  const { getCustomerByEmail } = require('./lib/db');
  const Stripe = require('stripe');
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
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
    res.status(502).send(`Stripe error: ${err.message}`);
  }
});

// Card setup confirmation pages (Stripe redirects here after setup)
app.get('/setup-complete', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>Card Saved</title><style>body{background:#1C1C1E;color:#00FF41;font-family:'Courier New',monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}</style></head><body><div><p style="font-size:2rem">✓</p><h1>Card saved.</h1><p>Your agent can now shop autonomously.</p><p style="color:#888;font-size:.9rem">You will receive a receipt for every purchase.</p></div></body></html>`);
});

app.get('/setup-cancel', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>Setup Cancelled</title><style>body{background:#1C1C1E;color:#FF3D8F;font-family:'Courier New',monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}</style></head><body><div><h1>Setup cancelled.</h1><p>No card saved. Your agent cannot place orders yet.</p><p style="color:#888;font-size:.9rem">Ask your agent to re-send the setup link when you're ready.</p></div></body></html>`);
});

// ONE-TIME: Shopify OAuth callback to capture the real Admin API access token
// Visit: https://human-not-required.myshopify.com/admin/oauth/authorize?client_id=SHOPIFY_CLIENT_ID&scope=write_orders,read_orders,read_products&redirect_uri=https://web-production-77376.up.railway.app/shopify/callback
app.get('/shopify/callback', async (req, res) => {
  const { code, shop } = req.query;
  if (!code || !shop) return res.status(400).send('Missing code or shop');
  console.log('[shopify-oauth] shop:', shop);
  console.log('[shopify-oauth] code length:', code?.length);
  console.log('[shopify-oauth] client_id:', process.env.SHOPIFY_CLIENT_ID);
  console.log('[shopify-oauth] client_secret prefix:', process.env.SHOPIFY_CLIENT_SECRET?.slice(0, 12));
  try {
    const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.SHOPIFY_CLIENT_ID,
        client_secret: process.env.SHOPIFY_CLIENT_SECRET,
        code,
      }),
    });
    const raw = await response.text();
    console.log('[shopify-oauth] RAW RESPONSE:', raw);
    const data = JSON.parse(raw);
    console.log('[shopify-oauth] ACCESS TOKEN:', data.access_token);
    res.send(`Token captured. Check Railway logs for your SHOPIFY_ADMIN_API_KEY. Token starts with: ${data.access_token?.slice(0, 8)}...`);
  } catch (err) {
    res.status(500).send(`OAuth error: ${err.message}`);
  }
});

// ONE-TIME: Delete customer by email (dev only)
app.delete('/admin/customer/:email', async (req, res) => {
  const { pool } = require('./lib/db');
  const r = await pool.query('DELETE FROM customers WHERE email = $1 RETURNING email', [req.params.email]);
  res.json({ deleted: r.rows });
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// 404
app.use((req, res) => res.status(404).json({ error: 'not_found' }));

// Global error handler
app.use((err, req, res, next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'internal_error' });
});

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => app.listen(PORT, () => console.log(`Human Not Required API running on port ${PORT}`)))
  .catch(err => { console.error('[startup] DB init failed:', err.message); process.exit(1); });
