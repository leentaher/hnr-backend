const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const stripeEnabled = (process.env.ENABLE_STRIPE || 'true').toLowerCase().trim() !== 'false';
const stripe = stripeEnabled ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const STRIPE_DISABLED = { error: 'not_available', message: 'This store uses x402 USDC payments only. See /checkout.' };
const { getOrder, createOrder, claimOrderSlot, releaseOrderSlot, incrementOrderCount, decrementFreeOrder } = require('../lib/db');
const { sendOrderConfirmation } = require('../lib/email');
const ALERT_EMAIL = process.env.EMAIL_FROM || 'leen.taher@gmail.com';
const { generateOrderId } = require('../lib/keys');
const { getProduct, listSkus } = require('../lib/products');
const { getPricing } = require('../lib/pricing');
const auth = require('../middleware/auth');

const DAILY_ORDER_LIMIT = 2;

// GET /orders/skus
router.get('/skus', (req, res) => {
  res.json({ skus: listSkus() });
});

// GET /orders/:id  (Stripe flow only)
router.get('/:id', auth, async (req, res) => {
  if (!stripeEnabled) return res.status(404).json(STRIPE_DISABLED);
  let order;
  try {
    order = await getOrder(req.params.id);
  } catch (err) {
    console.error('[orders] DB error on getOrder:', err.message);
    return res.status(503).json({ error: 'service_unavailable', message: 'Database unreachable. Try again shortly.' });
  }
  if (!order) return res.status(404).json({ error: 'order_not_found' });
  if (order.api_key !== req.apiKey) return res.status(403).json({ error: 'forbidden' });
  res.json({ order_id: order.order_id, sku: order.sku, status: order.status, created_at: order.created_at });
});

const STORE_CLOSED = { error: 'store_closed', message: 'The store is temporarily closed. Check back soon.' };

// POST /orders  (Stripe flow only)
router.post('/', auth, async (req, res) => {
  if ((process.env.STORE_OPEN || 'true').toLowerCase().trim() === 'false') return res.status(503).json(STORE_CLOSED);
  if (!stripeEnabled) return res.status(404).json(STRIPE_DISABLED);
  const { sku } = req.body || {};
  const customer = req.customer;

  if (!sku) return res.status(400).json({ error: 'missing_field', field: 'sku' });

  const product = getProduct(sku);
  if (!product) {
    return res.status(400).json({ error: 'invalid_sku', message: `SKU "${sku}" not found`, hint: 'GET /orders/skus to see available products' });
  }

  if (product.shopifyVariantId === 'FILL_ME') {
    return res.status(503).json({ error: 'product_not_configured', message: `Shopify variant ID not set for SKU "${sku}".` });
  }

  // Generate orderId up front — used as the Stripe idempotency key.
  const orderId = generateOrderId();

  // Atomically claim one order slot. Safe under concurrent requests — the DB UPDATE
  // only succeeds when the count is still below the limit, so two concurrent calls
  // cannot both claim the same slot.
  const slotCount = await claimOrderSlot(req.apiKey, DAILY_ORDER_LIMIT);
  if (slotCount === null) {
    return res.status(429).json({ error: 'daily_limit_reached', message: `Max ${DAILY_ORDER_LIMIT} orders per day.`, resets_at: 'midnight UTC' });
  }

  // 1. Payment — skip Stripe if customer has a free order remaining
  let paymentIntentId = null;
  const isFreeOrder = customer.free_orders_remaining > 0;

  if (!isFreeOrder) {
    let paymentMethodId;
    try {
      const pms = await stripe.paymentMethods.list({ customer: customer.stripe_customer_id, type: 'card' });
      if (!pms.data.length) {
        releaseOrderSlot(req.apiKey).catch(e => console.error('[orders] releaseOrderSlot failed:', e.message));
        return res.status(402).json({ error: 'no_payment_method', message: 'No saved card. The human must complete card setup first.', hint: 'Call POST /register/resend-setup to re-send the setup link.' });
      }
      paymentMethodId = pms.data[0].id;
    } catch (err) {
      releaseOrderSlot(req.apiKey).catch(e => console.error('[orders] releaseOrderSlot failed:', e.message));
      return res.status(502).json({ error: 'stripe_error', message: 'Unable to retrieve payment method.' });
    }

    let paymentIntent;
    try {
      paymentIntent = await stripe.paymentIntents.create({
        // Single source of truth (lib/pricing) — same value the x402 rail charges,
        // so the Stripe and x402 prices can never drift.
        amount: Math.round(getPricing().priceUsd * 100),
        currency: 'usd',
        customer: customer.stripe_customer_id,
        payment_method: paymentMethodId,
        off_session: true,
        confirm: true,
        description: `${product.label} (${sku}) — Human Not Required`,
      }, {
        // Use the pre-generated orderId as idempotency key — guaranteed unique per request,
        // no race condition possible unlike the previous ordersToday-based approach.
        idempotencyKey: orderId,
      });
    } catch (err) {
      console.error('[orders] Stripe payment failed:', err.message);
      releaseOrderSlot(req.apiKey).catch(e => console.error('[orders] releaseOrderSlot failed:', e.message));
      return res.status(402).json({ error: 'payment_failed', reason: err.decline_code || err.code || 'unknown' });
    }

    if (paymentIntent.status !== 'succeeded') {
      releaseOrderSlot(req.apiKey).catch(e => console.error('[orders] releaseOrderSlot failed:', e.message));
      return res.status(402).json({ error: 'payment_not_confirmed', stripe_status: paymentIntent.status });
    }

    paymentIntentId = paymentIntent.id;
  }

  // 3. Create Shopify order
  let shopifyOrderId;
  try {
    shopifyOrderId = await createShopifyOrder({ customer, product, sku, paymentIntentId: paymentIntentId || 'free_order' });
  } catch (err) {
    console.error('[orders] Shopify failed!', { paymentIntentId, error: err.message });
    if (paymentIntentId) {
      // Payment is already taken — alert store owner for manual resolution
      try {
        await sendOrderConfirmation({
          to: ALERT_EMAIL,
          subject: '🚨 Stripe payment succeeded but Shopify order FAILED — manual action needed',
          html: `<p><strong>URGENT:</strong> A customer was charged via Stripe but the Shopify order failed.</p>
                 <p><strong>Customer:</strong> ${customer.email}</p>
                 <p><strong>Stripe PaymentIntent:</strong> ${paymentIntentId}</p>
                 <p><strong>SKU:</strong> ${sku}</p>
                 <p><strong>Error:</strong> ${err.message}</p>
                 <p>Please create the Shopify order manually and confirm with the customer. The Stripe charge may need to be refunded if you cannot fulfill.</p>`,
        });
      } catch (emailErr) {
        console.error('[orders] Failed to send reconciliation alert:', emailErr.message);
      }
    }
    const errPayload = { error: 'shopify_error', message: 'Order creation failed.' };
    if (paymentIntentId) errPayload.stripe_payment_intent_id = paymentIntentId;
    return res.status(502).json(errPayload);
  }

  // 4. Save order record. Order slot was already claimed atomically above; free order
  // decrement is the only remaining counter to update.
  try {
    await createOrder({ orderId, apiKey: req.apiKey, sku, stripePaymentIntentId: paymentIntentId, shopifyOrderId });
  } catch (err) {
    if (!err.message?.includes('duplicate') && err.code !== '23505') {
      console.error('[orders] ALERT: createOrder failed after Shopify success! Manual reconciliation needed.', {
        orderId, sku, shopifyOrderId, paymentIntentId, error: err.message,
      });
    }
  }
  if (isFreeOrder) {
    decrementFreeOrder(req.apiKey).catch(err =>
      console.error('[orders] Failed to decrement free order (non-fatal):', err.message)
    );
  }

  res.status(201).json({
    order_id: orderId,
    status: 'placed',
    sku,
    shopify_order_id: shopifyOrderId,
    ...(isFreeOrder && { free_order: true, message: 'Your free hat is on the way. No charge.' }),
  });
});

async function createShopifyOrder({ customer, product, sku, paymentIntentId }) {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ADMIN_API_KEY;
  if (!domain || !token) throw new Error('SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_API_KEY not set');

  const addr = customer.address;
  const body = {
    order: {
      email: customer.email,
      financial_status: 'paid',
      send_receipt: true,
      send_fulfillment_receipt: true,
      line_items: [{ variant_id: product.shopifyVariantId, quantity: 1 }],
      shipping_address: {
        first_name: (customer.name || customer.email.split('@')[0]).split(' ')[0],
        last_name: (customer.name || '').split(' ').slice(1).join(' ') || '.',
        address1: addr.line1,
        address2: addr.line2 || '',
        city: addr.city,
        province: addr.state,
        zip: addr.postal_code,
        country_code: addr.country,
        phone: '',
      },
      note: `Placed by AI agent. Stripe PaymentIntent: ${paymentIntentId}. SKU: ${sku}`,
    },
  };

  // 10 second timeout — prevents the handler hanging forever if Shopify is slow
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  let response;
  try {
    response = await fetch(`https://${domain}/admin/api/2025-01/orders.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
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
    console.error('[orders] Shopify API error:', response.status, text); // full detail in server logs only
    throw new Error(`Shopify order creation failed (${response.status})`); // sanitized for callers
  }

  const data = await response.json();
  return String(data.order.id);
}

module.exports = router;
