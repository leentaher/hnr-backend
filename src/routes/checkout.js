const express = require('express');
const router = express.Router();
const { getProduct } = require('../lib/products');
const { createOrder, reserveX402Order, markX402OrderPlaced, markX402OrderFailed, incrementX402RateLimit } = require('../lib/db');
const { generateOrderId } = require('../lib/keys');
const { sendOrderConfirmation } = require('../lib/email');
const { extractPaymentIdentity } = require('../lib/x402-payment');

// Minimal HTML escaper — prevents injected HTML/script in alert emails sent to store owner
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_API_KEY;
const ALERT_EMAIL = process.env.EMAIL_FROM || 'leen.taher@gmail.com';

const STORE_CLOSED = { error: 'store_closed', message: 'The store is temporarily closed. Check back soon.' };

// POST /checkout
// Field validation, fulfillment gates, the rate-limit pre-check, and the x402 payment
// middleware all run BEFORE this handler (see index.js).
//
// IMPORTANT: x402 uses DEFERRED capture. The USDC transfer is settled on-chain AFTER this
// handler returns 2xx, and is CANCELLED if we return 4xx/5xx. So payment is NOT captured by
// the time we're here. We reserve the payment nonce, create the Shopify order, return 201,
// and the middleware then captures. A capture that fails after a 201 leaves a 'placed' order
// with no funds — detected out-of-band via payer_address + payment_nonce (T9b reconciliation).
router.post('/', async (req, res) => {
  if ((process.env.STORE_OPEN || 'true').toLowerCase().trim() === 'false') return res.status(503).json(STORE_CLOSED);
  const { sku, name, email, address } = req.body || {};

  const product = getProduct(sku);
  if (!product) {
    return res.status(400).json({ error: 'invalid_sku', message: `SKU "${sku}" not found`, hint: 'GET /orders/skus to see available products' });
  }

  const { payer, nonce } = extractPaymentIdentity(req);
  const orderId = generateOrderId();

  // Idempotency / concurrency gate: reserve this payment's nonce BEFORE the Shopify side
  // effect. The unique index on payment_nonce means a duplicate or concurrently-retried
  // payment authorization cannot create a second Shopify order.
  if (nonce) {
    let reservation;
    try {
      reservation = await reserveX402Order({ orderId, apiKey: `x402_${email}`, sku, payerAddress: payer, paymentNonce: nonce });
    } catch (err) {
      console.error('[checkout] reserveX402Order failed:', err.message);
      return res.status(503).json({ error: 'service_unavailable', message: 'Could not start checkout. No payment was taken — please try again.' });
    }
    if (!reservation.reserved) {
      const existing = reservation.existing;
      const placed = existing?.status === 'placed';
      return res.status(placed ? 200 : 409).json({
        order_id: existing?.order_id,
        status: existing?.status,
        sku,
        shopify_order_id: existing?.shopify_order_id || null,
        payment: 'x402_usdc_base',
        idempotent: true,
        message: placed
          ? 'This payment was already processed — returning your original order.'
          : 'A checkout for this payment is already in progress or has failed. Do not re-pay with the same authorization.',
      });
    }
  }

  // Create the Shopify order. Payment captures AFTER we return 201.
  let shopifyOrderId;
  try {
    shopifyOrderId = await createShopifyOrder({ name, email, address, product, sku });
  } catch (err) {
    console.error('[checkout] Shopify order creation failed:', err.message);
    if (nonce) await markX402OrderFailed(orderId).catch(e => console.warn('[checkout] markX402OrderFailed failed:', e.message));
    // Returning 5xx makes the x402 middleware CANCEL the authorization — no USDC is captured.
    try {
      await sendOrderConfirmation({
        to: ALERT_EMAIL,
        subject: '⚠️ x402 checkout: Shopify order creation failed (payment cancelled)',
        html: `<p>An x402 checkout failed at Shopify order creation. The x402 payment was cancelled — no USDC captured.</p>
               <p><strong>Customer:</strong> ${esc(name)} &lt;${esc(email)}&gt;</p>
               <p><strong>SKU:</strong> ${esc(sku)}</p>
               <p><strong>Payer wallet:</strong> ${esc(payer || 'unknown')}</p>
               <p><strong>Address:</strong> ${esc(address.line1)}, ${esc(address.city)}, ${esc(address.state)} ${esc(address.postal_code)}, ${esc(address.country)}</p>
               <p><strong>Error:</strong> ${esc(err.message)}</p>`,
      });
    } catch (emailErr) {
      console.error('[checkout] Failed to send alert email:', emailErr.message);
    }
    return res.status(502).json({
      error: 'fulfillment_failed',
      message: 'Order creation failed. No payment was taken — safe to retry.',
      sku,
    });
  }

  // Persist the order: mark the reserved row placed, or (if no nonce was decodable) insert directly.
  try {
    if (nonce) {
      await markX402OrderPlaced(orderId, shopifyOrderId);
    } else {
      console.warn('[checkout] No x402 payment nonce decoded — order saved without an idempotency key');
      await createOrder({ orderId, apiKey: `x402_${email}`, sku, stripePaymentIntentId: null, shopifyOrderId });
    }
  } catch (err) {
    console.warn('[checkout] Failed to persist order record (non-fatal):', err.message);
  }

  // Daily rate-limit counter (keyed on email today; T3 moves this to the payer wallet).
  const dailyLimit = parseInt(process.env.X402_DAILY_LIMIT ?? '2', 10);
  if (dailyLimit > 0) {
    incrementX402RateLimit(email).catch(err =>
      console.warn('[checkout] Failed to increment rate limit counter (non-fatal):', err.message)
    );
  }

  res.status(201).json({
    order_id: orderId,
    status: 'placed',
    sku,
    shopify_order_id: shopifyOrderId,
    payment: 'x402_usdc_base',
    message: 'Order placed. USDC payment is being captured on Base.',
  });
});

async function createShopifyOrder({ name, email, address, product, sku }) {
  if (!SHOPIFY_DOMAIN || !SHOPIFY_TOKEN) throw new Error('Shopify not configured');
  if (!product.shopifyVariantId || product.shopifyVariantId === 'FILL_ME') {
    throw new Error(`Shopify variant ID not configured for SKU "${sku}" — update products.js`);
  }

  const body = {
    order: {
      email,
      financial_status: 'paid',
      line_items: [{ variant_id: product.shopifyVariantId, quantity: 1 }],
      shipping_address: {
        first_name: name.split(' ')[0],
        last_name: name.split(' ').slice(1).join(' ') || '',
        address1: address.line1,
        address2: address.line2 || '',
        city: address.city,
        province: address.state,
        zip: address.postal_code,
        country_code: address.country,
      },
      send_receipt: true,  // Shopify sends customer confirmation email automatically
      note: `Placed via x402 USDC payment on Base. SKU: ${sku}. Agent-native purchase.`,
      tags: 'agent-order,x402,usdc',
    },
  };

  // 10 second timeout — prevents the handler hanging forever if Shopify is slow
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  let response;
  try {
    response = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/2025-01/orders.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': SHOPIFY_TOKEN,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Shopify API timed out after 10s');
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const text = await response.text();
    console.error('[checkout] Shopify API error:', response.status, text); // full detail in server logs only
    throw new Error(`Shopify order creation failed (${response.status})`); // sanitized for callers
  }

  const data = await response.json();
  return String(data.order.id);
}

module.exports = router;
