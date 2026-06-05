const express = require('express');
const router = express.Router();
const { getProduct } = require('../lib/products');
const { createOrder, reserveX402Order, markX402OrderPlaced, markX402OrderFailed, incrementX402RateLimit, claimPromo, markPromoOrderPlaced, releasePromo } = require('../lib/db');
const { generateOrderId } = require('../lib/keys');
const { sendOrderConfirmation } = require('../lib/email');
const { extractPaymentIdentity } = require('../lib/x402-payment');
const { createShopifyOrder } = require('../lib/fulfillment');
const { isValidPromoCode, getPromoMaxUses } = require('../lib/promos');

// Minimal HTML escaper — prevents injected HTML/script in alert emails sent to store owner
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

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

  // Daily rate-limit counter (keyed on email). OFF by default — set X402_DAILY_LIMIT=N to enable.
  const dailyLimit = parseInt(process.env.X402_DAILY_LIMIT ?? '0', 10);
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
    message: 'Payment settled on Base. Your hat is on the way.',
  });
});

// placePromoOrder — the FREE rail. Runs from the index.js /checkout gate BEFORE the x402
// payment middleware (a promo request carries no payment header, so it never reaches x402).
// Fields (sku/name/email/address) are already validated by the gate. Flow mirrors the x402
// path: reserve → fulfill → place / release, but with no payment.
async function placePromoOrder(req, res) {
  const { sku, name, email, address, promo_code } = req.body || {};
  const code = String(promo_code || '').trim();

  // Allowlist check — codes come from the PROMO_CODES env var, never arbitrary input.
  if (!isValidPromoCode(code)) {
    return res.status(400).json({
      error: 'invalid_promo_code',
      message: `"${code}" is not a valid promo code. Remove it to pay with USDC via x402, or double-check the code.`,
    });
  }

  const product = getProduct(sku); // already validated in the gate, re-fetch for fulfillment
  const orderId = generateOrderId();
  const maxUses = getPromoMaxUses(code);

  // Reserve the redemption atomically (race-safe per-code cap + one-use-per-email).
  let claim;
  try {
    claim = await claimPromo({ code, email, maxUses, orderId });
  } catch (err) {
    console.error('[promo] claimPromo failed:', err.message);
    return res.status(503).json({ error: 'service_unavailable', message: 'Could not redeem the promo right now. No order was created — please try again.' });
  }

  if (claim.exhausted) {
    return res.status(409).json({ error: 'promo_exhausted', message: 'This promo code has reached its redemption limit.' });
  }
  if (claim.inProgress) {
    // A recent reservation for this (code,email) is still being fulfilled. Don't double-ship —
    // tell the caller to retry shortly. A stale reservation (crash window) self-heals via reclaim.
    return res.status(409).json({ error: 'redemption_in_progress', message: 'A redemption for this promo and email is already being processed. Retry in a moment.' });
  }
  if (claim.already) {
    // Idempotent: this email already has a PLACED order for this code — return it, don't re-ship.
    return res.status(200).json({
      order_id: claim.existing.order_id,
      status: claim.existing.status || 'placed',
      sku,
      shopify_order_id: claim.existing.shopify_order_id || null,
      payment: 'promo_free',
      idempotent: true,
      message: 'This promo was already redeemed with this email — returning your original order.',
    });
  }

  // Fulfill. On any failure, release the reservation so the code use is not consumed.
  let shopifyOrderId;
  try {
    shopifyOrderId = await createShopifyOrder({
      name, email, address, product, sku,
      note: `Placed via promo code (free). SKU: ${sku}. Agent-native purchase.`,
      tags: 'agent-order,promo,free',
    });
  } catch (err) {
    console.error('[promo] Shopify order creation failed:', err.message);
    await releasePromo({ code, email }).catch(e => console.warn('[promo] releasePromo failed:', e.message));
    try {
      await sendOrderConfirmation({
        to: ALERT_EMAIL,
        subject: '⚠️ promo checkout: Shopify order creation failed (redemption released)',
        html: `<p>A promo (free) checkout failed at Shopify order creation. The promo redemption was released — the code can be used again.</p>
               <p><strong>Customer:</strong> ${esc(name)} &lt;${esc(email)}&gt;</p>
               <p><strong>Promo:</strong> ${esc(code)}</p>
               <p><strong>SKU:</strong> ${esc(sku)}</p>
               <p><strong>Address:</strong> ${esc(address.line1)}, ${esc(address.city)}, ${esc(address.state)} ${esc(address.postal_code)}, ${esc(address.country)}</p>
               <p><strong>Error:</strong> ${esc(err.message)}</p>`,
      });
    } catch (emailErr) {
      console.error('[promo] Failed to send alert email:', emailErr.message);
    }
    return res.status(502).json({ error: 'fulfillment_failed', message: 'Order creation failed. The promo was not consumed — safe to retry.', sku });
  }

  // Mark the redemption placed, and record the order in the orders table for history.
  try {
    await markPromoOrderPlaced({ code, email, shopifyOrderId });
    await createOrder({ orderId, apiKey: `promo_${code}`, sku, stripePaymentIntentId: null, shopifyOrderId });
  } catch (err) {
    console.warn('[promo] Failed to persist order record (non-fatal):', err.message);
  }

  return res.status(201).json({
    order_id: orderId,
    status: 'placed',
    sku,
    shopify_order_id: shopifyOrderId,
    payment: 'promo_free',
    free_order: true,
    message: 'Promo redeemed — your hat is on the way. No payment required.',
  });
}

module.exports = router;
module.exports.placePromoOrder = placePromoOrder;
