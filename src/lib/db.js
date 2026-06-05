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
    // 42P16 = invalid_table_definition (already has this PK) — safe to ignore.
    // Any other code is a genuine migration failure worth surfacing.
    if (err.code === '42P16' || err.message?.includes('already exists')) {
      console.log('[db] used_promos composite PK already present — skipping');
    } else {
      console.error('[db] WARN: used_promos PK migration failed unexpectedly:', err.message, err.code);
    }
  }

  // Migration: promo redemptions track the order they produced. Two-phase free-order
  // create (reserve→place→release) mirrors the x402 path. NULLs are fine for any
  // Stripe-era redemption rows that predate these columns.
  await pool.query(`ALTER TABLE used_promos ADD COLUMN IF NOT EXISTS order_id TEXT`);
  await pool.query(`ALTER TABLE used_promos ADD COLUMN IF NOT EXISTS shopify_order_id TEXT`);
  await pool.query(`ALTER TABLE used_promos ADD COLUMN IF NOT EXISTS status TEXT`);

  // Migration: x402 payment identity on orders — payer wallet + EIP-3009 nonce.
  // Enables idempotency (one payment authorization can create at most one order, even
  // under concurrent retries) and reconciliation of the capture-after-fulfillment window.
  // NULLs are allowed (Stripe-era orders) and are distinct under a Postgres unique index,
  // so many NULL rows coexist fine.
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS payer_address TEXT`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_nonce TEXT`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS orders_payment_nonce_uq ON orders (payment_nonce)`);

  // Migration: hash any plain-text api_keys still in the DB.
  // Plain keys start with 'sk_agent_'; SHA-256 hashes are 64 hex chars and never match that prefix.
  // Short-circuit with a cheap COUNT first to avoid a table scan on every startup once migrated.
  const { rows: [{ count: plainCount }] } = await pool.query(
    `SELECT COUNT(*) FROM customers WHERE api_key LIKE 'sk_agent_%'`
  );
  const { rowCount } = plainCount > 0 ? await pool.query(`
    UPDATE customers SET api_key = encode(sha256(api_key::bytea), 'hex')
    WHERE api_key LIKE 'sk_agent_%'
  `) : { rowCount: 0 };
  if (rowCount > 0) {
    await pool.query(`
      UPDATE orders SET api_key = encode(sha256(api_key::bytea), 'hex')
      WHERE api_key LIKE 'sk_agent_%'
    `);
    console.log(`[db] Hashed ${rowCount} plain-text api_key(s)`);
  }

  console.log('[db] Tables ready');
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

async function getOrderByNonce(nonce) {
  if (!nonce) return null;
  const r = await pool.query('SELECT * FROM orders WHERE payment_nonce = $1', [nonce]);
  return r.rows[0] || null;
}

// x402 two-phase order create — step 1: atomically RESERVE a payment nonce by inserting a
// 'pending' order. The unique index on payment_nonce makes this the concurrency gate: a
// duplicate/retried payment authorization (same nonce) cannot create a second order.
// Returns { reserved: true } on a fresh reservation, or { reserved: false, existing } when
// the nonce was already seen (idempotent retry or concurrent double-submit).
async function reserveX402Order({ orderId, apiKey, sku, payerAddress, paymentNonce }) {
  const r = await pool.query(
    `INSERT INTO orders (order_id, api_key, sku, status, created_at, payer_address, payment_nonce)
     VALUES ($1, $2, $3, 'pending', $4, $5, $6)
     ON CONFLICT (payment_nonce) DO NOTHING
     RETURNING order_id`,
    [orderId, apiKey, sku, new Date().toISOString(), payerAddress, paymentNonce]
  );
  if (r.rows[0]) return { reserved: true };
  return { reserved: false, existing: await getOrderByNonce(paymentNonce) };
}

// x402 two-phase order create — step 2a: mark a reserved order placed once Shopify succeeds.
async function markX402OrderPlaced(orderId, shopifyOrderId) {
  await pool.query(
    `UPDATE orders SET status = 'placed', shopify_order_id = $2 WHERE order_id = $1`,
    [orderId, shopifyOrderId]
  );
}

// x402 two-phase order create — step 2b: mark a reserved order failed if Shopify creation
// throws. Payment is cancelled by the x402 middleware on a 4xx/5xx response, so this row
// records an attempt that took no money.
async function markX402OrderFailed(orderId) {
  await pool.query(
    `UPDATE orders SET status = 'fulfillment_failed' WHERE order_id = $1`,
    [orderId]
  );
}

// x402 rate limit — read-only check, returns current count without incrementing.
// Use this BEFORE payment fires so failed payments don't consume the daily quota.
async function getX402RateLimit(email) {
  const today = new Date().toISOString().slice(0, 10);
  const r = await pool.query(
    'SELECT count FROM x402_rate_limit WHERE email = $1 AND date = $2',
    [email.toLowerCase(), today]
  );
  return r.rows[0]?.count ?? 0;
}

// x402 rate limit — atomically increments counter, returns new count.
// Call this AFTER payment settles (inside the checkout handler) so failed
// payments don't consume the daily quota.
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

// ── Promo free-order claim (two-phase, atomic per code) ──────────────────────
// A promo grants a FREE order and bypasses x402. Because /checkout is public and
// unauthenticated, the per-code use cap must be race-safe: two concurrent requests
// must not both slip past a maxUses check. We serialize claims for a given code with
// a transaction-scoped advisory lock, so the COUNT + INSERT is effectively atomic.
//
// Returns one of:
//   { reserved: true }             — fresh claim, caller may fulfill
//   { already: true, existing }    — (code,email) genuinely redeemed: return original, don't re-ship
//   { inProgress: true, existing } — a 'pending' reservation exists (in flight, or crashed
//                                    mid-flight); caller should 409/retry. Never auto-reclaimed.
//   { exhausted: true }            — code has hit its maxUses cap
async function claimPromo({ code, email, maxUses, orderId }) {
  const c = code.toUpperCase().trim();
  const e = email.toLowerCase().trim();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize all concurrent claims for THIS code (released automatically at COMMIT/ROLLBACK).
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [c]);

    // Existing redemption for this (code, email)?
    const mine = await client.query('SELECT order_id, shopify_order_id, status FROM used_promos WHERE code = $1 AND email = $2', [c, e]);
    const row = mine.rows[0];
    if (row) {
      // Genuinely redeemed: a placed new-rail order, OR a legacy Stripe-era row (no
      // status/order_id columns populated). Either way, don't fulfill again.
      if (row.status === 'placed' || (row.status == null && row.order_id == null)) {
        await client.query('COMMIT');
        return { already: true, existing: row };
      }
      // A 'pending' reservation: fulfillment is in flight, or a prior attempt crashed
      // mid-flight. We deliberately do NOT auto-reclaim it — a crash AFTER the Shopify order
      // was created but BEFORE it was marked 'placed' would let a reclaim ship a SECOND free
      // hat. Return in-progress; genuinely stuck 'pending' rows are reconciled out-of-band
      // (same model as the x402 pending path), so a free order is never double-shipped.
      await client.query('COMMIT');
      return { inProgress: true, existing: row };
    }

    // Enforce the per-code total cap under the lock — race-free.
    const { rows } = await client.query('SELECT COUNT(*)::int AS n FROM used_promos WHERE code = $1', [c]);
    if (rows[0].n >= maxUses) {
      await client.query('ROLLBACK');
      return { exhausted: true };
    }

    await client.query(
      `INSERT INTO used_promos (code, email, used_at, order_id, status) VALUES ($1, $2, $3, $4, 'pending')`,
      [c, e, new Date().toISOString(), orderId]
    );
    await client.query('COMMIT');
    return { reserved: true };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Step 2a: mark a reserved promo redemption placed once Shopify succeeds.
async function markPromoOrderPlaced({ code, email, shopifyOrderId }) {
  await pool.query(
    `UPDATE used_promos SET status = 'placed', shopify_order_id = $3 WHERE code = $1 AND email = $2`,
    [code.toUpperCase().trim(), email.toLowerCase().trim(), shopifyOrderId]
  );
}

// Step 2b: release a reserved redemption if fulfillment fails, so the code use is NOT
// consumed. Only deletes the still-'pending' reservation — never a placed order.
async function releasePromo({ code, email }) {
  await pool.query(
    `DELETE FROM used_promos WHERE code = $1 AND email = $2 AND status = 'pending'`,
    [code.toUpperCase().trim(), email.toLowerCase().trim()]
  );
}

module.exports = { initDb, createOrder, getOrder, getOrderByNonce, reserveX402Order, markX402OrderPlaced, markX402OrderFailed, getX402RateLimit, incrementX402RateLimit, claimPromo, markPromoOrderPlaced, releasePromo };
