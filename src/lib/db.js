const { Pool } = require('pg');
const { hashApiKey } = require('./keys');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      api_key TEXT PRIMARY KEY,
      stripe_customer_id TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      address JSONB NOT NULL,
      orders_today INT DEFAULT 0,
      last_order_date TEXT,
      free_orders_remaining INT DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS orders (
      order_id TEXT PRIMARY KEY,
      api_key TEXT NOT NULL,
      sku TEXT NOT NULL,
      stripe_payment_intent_id TEXT,
      shopify_order_id TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS used_promos (
      code TEXT NOT NULL,
      email TEXT NOT NULL,
      used_at TEXT NOT NULL,
      PRIMARY KEY (code, email)
    );
  `);

  // x402 rate limit table — atomic per-email daily counter (survives redeploys, race-safe)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS x402_rate_limit (
      email TEXT NOT NULL,
      date TEXT NOT NULL,
      count INT DEFAULT 0,
      PRIMARY KEY (email, date)
    );
  `);

  // Migration: add free_orders_remaining to existing installs
  await pool.query(`
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS free_orders_remaining INT DEFAULT 0;
  `);

  // Migration: change used_promos primary key from (code) to (code, email)
  // so the same promo code can be used by different emails (one use per email)
  try {
    await pool.query(`ALTER TABLE used_promos DROP CONSTRAINT IF EXISTS used_promos_pkey`);
    await pool.query(`ALTER TABLE used_promos ADD PRIMARY KEY (code, email)`);
    console.log('[db] Migrated used_promos to composite PK (code, email)');
  } catch (err) {
    // Likely already has composite PK — safe to ignore
    console.log('[db] used_promos PK already migrated or skipped:', err.message);
  }

  // Migration: hash any plain-text api_keys still in the DB.
  // Plain keys start with 'sk_agent_'; SHA-256 hashes are 64 hex chars and never match that prefix.
  // Idempotent — safe to run on every startup.
  const { rowCount } = await pool.query(`
    UPDATE customers SET api_key = encode(sha256(api_key::bytea), 'hex')
    WHERE api_key LIKE 'sk_agent_%'
  `);
  if (rowCount > 0) {
    await pool.query(`
      UPDATE orders SET api_key = encode(sha256(api_key::bytea), 'hex')
      WHERE api_key LIKE 'sk_agent_%'
    `);
    console.log(`[db] Hashed ${rowCount} plain-text api_key(s)`);
  }

  console.log('[db] Tables ready');
}

// Customers
async function getCustomerByKey(apiKey) {
  const r = await pool.query('SELECT * FROM customers WHERE api_key = $1', [hashApiKey(apiKey)]);
  return r.rows[0] || null;
}

async function getCustomerByEmail(email) {
  const r = await pool.query('SELECT * FROM customers WHERE email = $1', [email]);
  return r.rows[0] || null;
}

async function createCustomer({ apiKey, stripeCustomerId, email, name, address, freeOrders = 0 }) {
  await pool.query(
    'INSERT INTO customers (api_key, stripe_customer_id, email, name, address, free_orders_remaining) VALUES ($1, $2, $3, $4, $5, $6)',
    [hashApiKey(apiKey), stripeCustomerId, email, name, JSON.stringify(address), freeOrders]
  );
}

async function isPromoUsed(code, email) {
  const r = await pool.query(
    'SELECT code FROM used_promos WHERE code = $1 AND email = $2',
    [code.toUpperCase().trim(), email.toLowerCase().trim()]
  );
  return r.rows.length > 0;
}

async function markPromoUsed(code, email) {
  await pool.query(
    'INSERT INTO used_promos (code, email, used_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [code.toUpperCase().trim(), email, new Date().toISOString()]
  );
}

async function decrementFreeOrder(apiKey) {
  await pool.query(
    'UPDATE customers SET free_orders_remaining = free_orders_remaining - 1 WHERE api_key = $1 AND free_orders_remaining > 0',
    [apiKey]
  );
}

async function incrementOrderCount(apiKey) {
  const today = new Date().toISOString().slice(0, 10);
  await pool.query(
    `UPDATE customers SET
       orders_today = CASE WHEN last_order_date = $1 THEN orders_today + 1 ELSE 1 END,
       last_order_date = $1
     WHERE api_key = $2`,
    [today, apiKey]
  );
}

// Orders
async function createOrder({ orderId, apiKey, sku, stripePaymentIntentId, shopifyOrderId }) {
  await pool.query(
    'INSERT INTO orders (order_id, api_key, sku, stripe_payment_intent_id, shopify_order_id, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [orderId, apiKey, sku, stripePaymentIntentId, shopifyOrderId, 'placed', new Date().toISOString()]
  );
}

async function getOrder(orderId) {
  const r = await pool.query('SELECT * FROM orders WHERE order_id = $1', [orderId]);
  return r.rows[0] || null;
}

// x402 rate limit — atomically increments counter, returns new count
// PostgreSQL handles concurrent requests safely via its transaction model
async function incrementX402RateLimit(email) {
  const today = new Date().toISOString().slice(0, 10);
  const r = await pool.query(`
    INSERT INTO x402_rate_limit (email, date, count)
    VALUES ($1, $2, 1)
    ON CONFLICT (email, date) DO UPDATE
    SET count = x402_rate_limit.count + 1
    RETURNING count
  `, [email.toLowerCase(), today]);
  return r.rows[0].count; // new count after increment
}

module.exports = { initDb, getCustomerByKey, getCustomerByEmail, createCustomer, incrementOrderCount, createOrder, getOrder, isPromoUsed, markPromoUsed, decrementFreeOrder, incrementX402RateLimit };
