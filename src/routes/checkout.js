const express = require('express');
const router = express.Router();
const { getProduct, listSkus } = require('../lib/products');
const { createOrder, incrementOrderCount } = require('../lib/db');
const { generateOrderId } = require('../lib/keys');

const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_API_KEY;

// POST /checkout
// x402 payment middleware runs before this handler — by the time we get here, USDC is settled
router.post('/', async (req, res) => {
  const { sku, name, email, address } = req.body || {};

  // Validate required fields
  if (!sku) return res.status(400).json({ error: 'missing_field', field: 'sku', hint: 'GET /orders/skus to see available products' });
  if (!name) return res.status(400).json({ error: 'missing_field', field: 'name', message: 'Full name required for shipping label' });
  if (!email) return res.status(400).json({ error: 'missing_field', field: 'email' });
  if (!address?.line1 || !address?.city || !address?.state || !address?.postal_code || !address?.country) {
    return res.status(400).json({ error: 'missing_field', field: 'address', message: 'address.line1, city, state, postal_code, and country are required' });
  }

  const product = getProduct(sku);
  if (!product) {
    return res.status(400).json({ error: 'invalid_sku', message: `SKU "${sku}" not found`, hint: 'GET /orders/skus to see available products' });
  }

  // Payment is already settled by x402 middleware — create Shopify order
  let shopifyOrderId;
  try {
    shopifyOrderId = await createShopifyOrder({ name, email, address, product, sku });
  } catch (err) {
    console.error('[checkout] Shopify order failed after x402 payment settled!', err.message);
    // Payment is already taken — log for manual resolution
    return res.status(502).json({
      error: 'fulfillment_failed',
      message: 'Payment received but order creation failed. You will be contacted to resolve this.',
      sku,
    });
  }

  // Save order record
  const orderId = generateOrderId();
  try {
    await createOrder({
      orderId,
      apiKey: `x402_${email}`, // x402 orders aren't tied to an api_key, use email as ref
      sku,
      stripePaymentIntentId: null,
      shopifyOrderId,
    });
  } catch (err) {
    console.warn('[checkout] Failed to save order record (non-fatal):', err.message);
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

async function createShopifyOrder({ name, email, address, product, sku }) {
  if (!SHOPIFY_DOMAIN || !SHOPIFY_TOKEN) throw new Error('Shopify not configured');

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
      note: `Placed via x402 USDC payment on Base. SKU: ${sku}. Agent-native purchase.`,
      tags: 'agent-order,x402,usdc',
    },
  };

  const response = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/2025-01/orders.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_TOKEN,
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
