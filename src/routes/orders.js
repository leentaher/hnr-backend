const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const { orders } = require('../lib/db');
const { generateOrderId } = require('../lib/keys');
const { getProduct, listSkus } = require('../lib/products');
const auth = require('../middleware/auth');

// GET /orders/skus — list available products
router.get('/skus', (req, res) => {
  res.json({ skus: listSkus() });
});

// GET /orders/:id — order status
router.get('/:id', auth, (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) {
    return res.status(404).json({ error: 'order_not_found', order_id: req.params.id });
  }
  // Only return orders belonging to this API key
  if (order.apiKey !== req.apiKey) {
    return res.status(403).json({ error: 'forbidden' });
  }
  res.json({ order_id: order.orderId, sku: order.sku, status: order.status, created_at: order.createdAt });
});

// POST /orders — charge card and create Shopify order
// Body: { sku }
// Returns: { order_id, status }
router.post('/', auth, async (req, res) => {
  const { sku } = req.body || {};
  const { customer, apiKey } = req;

  if (!sku) {
    return res.status(400).json({ error: 'missing_field', field: 'sku' });
  }

  const product = getProduct(sku);
  if (!product) {
    return res.status(400).json({
      error: 'invalid_sku',
      message: `SKU "${sku}" not found`,
      hint: 'GET /orders/skus to see available products',
    });
  }

  if (product.shopifyVariantId === 'FILL_ME') {
    return res.status(503).json({
      error: 'product_not_configured',
      message: `Shopify variant ID not set for SKU "${sku}". See products.js Step 4.`,
    });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const amountCents = product.priceUsd * 100;

  // 1. Get saved payment method from Stripe customer
  let paymentMethodId;
  try {
    const paymentMethods = await stripe.paymentMethods.list({
      customer: customer.stripeCustomerId,
      type: 'card',
    });
    if (!paymentMethods.data.length) {
      return res.status(402).json({
        error: 'no_payment_method',
        message: 'No saved card on file. The human must complete card setup first.',
        hint: 'Call POST /register again to re-send the card setup link.',
      });
    }
    paymentMethodId = paymentMethods.data[0].id;
  } catch (err) {
    console.error('[orders] Failed to list payment methods:', err.message);
    return res.status(502).json({ error: 'stripe_error', message: 'Could not retrieve payment methods.' });
  }

  // 2. Charge via off-session PaymentIntent
  let paymentIntent;
  try {
    paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      customer: customer.stripeCustomerId,
      payment_method: paymentMethodId,
      off_session: true,
      confirm: true,
      description: `${product.label} (${sku}) — Human Not Required`,
    });
  } catch (err) {
    // Stripe throws for card declines — surface as structured error, not 500
    console.error('[orders] Stripe charge failed:', err.message);
    const stripeCode = err.decline_code || err.code || 'unknown';
    return res.status(402).json({
      error: 'payment_failed',
      reason: stripeCode,
      message: err.message,
    });
  }

  if (paymentIntent.status !== 'succeeded') {
    return res.status(402).json({
      error: 'payment_not_confirmed',
      stripe_status: paymentIntent.status,
      message: 'Payment did not complete. No order placed.',
    });
  }

  // 3. Create paid Shopify order
  let shopifyOrderId;
  try {
    shopifyOrderId = await createShopifyOrder({ customer, product, sku, paymentIntentId: paymentIntent.id });
  } catch (err) {
    // Payment succeeded but Shopify order failed — log for manual recovery
    console.error('[orders] Shopify order creation failed after successful payment!', {
      paymentIntentId: paymentIntent.id,
      error: err.message,
    });
    return res.status(502).json({
      error: 'shopify_error',
      message: 'Payment charged but order creation failed. Support has been notified.',
      stripe_payment_intent_id: paymentIntent.id,
    });
  }

  // 4. Persist order and increment daily counter
  const orderId = generateOrderId();
  orders.set(orderId, {
    orderId,
    apiKey,
    sku,
    stripePaymentIntentId: paymentIntent.id,
    shopifyOrderId,
    status: 'placed',
    createdAt: new Date().toISOString(),
  });
  customer.ordersToday += 1;

  res.status(201).json({ order_id: orderId, status: 'placed', sku, shopify_order_id: shopifyOrderId });
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
      fulfillment_status: null,
      line_items: [{ variant_id: product.shopifyVariantId, quantity: 1 }],
      shipping_address: {
        first_name: customer.email.split('@')[0],
        address1: addr.line1,
        address2: addr.line2 || '',
        city: addr.city,
        province: addr.state,
        zip: addr.postal_code,
        country_code: addr.country,
      },
      note: `Placed by AI agent. Stripe PaymentIntent: ${paymentIntentId}. SKU: ${sku}`,
    },
  };

  const response = await fetch(`https://${domain}/admin/api/2024-01/orders.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Shopify ${response.status}: ${text}`);
  }

  const data = await response.json();
  return String(data.order.id);
}

module.exports = router;
