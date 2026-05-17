const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const { getOrder, createOrder, incrementOrderCount } = require('../lib/db');
const { generateOrderId } = require('../lib/keys');
const { getProduct, listSkus } = require('../lib/products');
const auth = require('../middleware/auth');

const DAILY_ORDER_LIMIT = 2;

// GET /orders/skus
router.get('/skus', (req, res) => {
  res.json({ skus: listSkus() });
});

// GET /orders/:id
router.get('/:id', auth, async (req, res) => {
  const order = await getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'order_not_found' });
  if (order.api_key !== req.apiKey) return res.status(403).json({ error: 'forbidden' });
  res.json({ order_id: order.order_id, sku: order.sku, status: order.status, created_at: order.created_at });
});

// POST /orders
router.post('/', auth, async (req, res) => {
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

  // Check daily limit
  const today = new Date().toISOString().slice(0, 10);
  const ordersToday = customer.last_order_date === today ? customer.orders_today : 0;
  if (ordersToday >= DAILY_ORDER_LIMIT) {
    return res.status(429).json({ error: 'daily_limit_reached', message: `Max ${DAILY_ORDER_LIMIT} orders per day.`, resets_at: 'midnight UTC' });
  }

  // 1. Get saved payment method
  let paymentMethodId;
  try {
    const pms = await stripe.paymentMethods.list({ customer: customer.stripe_customer_id, type: 'card' });
    if (!pms.data.length) {
      return res.status(402).json({ error: 'no_payment_method', message: 'No saved card. The human must complete card setup first.', hint: 'Call POST /register/resend-setup to re-send the setup link.' });
    }
    paymentMethodId = pms.data[0].id;
  } catch (err) {
    return res.status(502).json({ error: 'stripe_error', message: err.message });
  }

  // 2. Charge off-session
  let paymentIntent;
  try {
    paymentIntent = await stripe.paymentIntents.create({
      amount: product.priceUsd * 100,
      currency: 'usd',
      customer: customer.stripe_customer_id,
      payment_method: paymentMethodId,
      off_session: true,
      confirm: true,
      description: `${product.label} (${sku}) — Human Not Required`,
    });
  } catch (err) {
    return res.status(402).json({ error: 'payment_failed', reason: err.decline_code || err.code || 'unknown', message: err.message });
  }

  if (paymentIntent.status !== 'succeeded') {
    return res.status(402).json({ error: 'payment_not_confirmed', stripe_status: paymentIntent.status });
  }

  // 3. Create Shopify order
  let shopifyOrderId;
  try {
    shopifyOrderId = await createShopifyOrder({ customer, product, sku, paymentIntentId: paymentIntent.id });
  } catch (err) {
    console.error('[orders] Shopify failed after charge!', { paymentIntentId: paymentIntent.id, error: err.message });
    return res.status(502).json({ error: 'shopify_error', message: 'Payment charged but order creation failed.', stripe_payment_intent_id: paymentIntent.id });
  }

  // 4. Save order and update count
  const orderId = generateOrderId();
  await createOrder({ orderId, apiKey: req.apiKey, sku, stripePaymentIntentId: paymentIntent.id, shopifyOrderId });
  await incrementOrderCount(req.apiKey);

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
      line_items: [{ variant_id: product.shopifyVariantId, quantity: 1 }],
      shipping_address: {
        first_name: customer.name || customer.email.split('@')[0],
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

  const response = await fetch(`https://${domain}/admin/api/2025-01/orders.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
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
