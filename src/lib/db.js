const { Pool } = require('pg');

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
      last_order_date TEXT
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
  `);
  console.log('[db] Tables ready');
}

// Customers
async function getCustomerByKey(apiKey) {
  const r = await pool.query('SELECT * FROM customers WHERE api_key = $1', [apiKey]);
  return r.rows[0] || null;
}

async function getCustomerByEmail(email) {
  const r = await pool.query('SELECT * FROM customers WHERE email = $1', [email]);
  return r.rows[0] || null;
}

async function createCustomer({ apiKey, stripeCustomerId, email, name, address }) {
  await pool.query(
    'INSERT INTO customers (api_key, stripe_customer_id, email, name, address) VALUES ($1, $2, $3, $4, $5)',
    [apiKey, stripeCustomerId, email, name, JSON.stringify(address)]
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

module.exports = { initDb, getCustomerByKey, getCustomerByEmail, createCustomer, incrementOrderCount, createOrder, getOrder };
