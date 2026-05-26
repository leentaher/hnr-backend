const express = require('express');
const router = express.Router();
const { getProduct, listSkus } = require('../lib/products');
const { createOrder, incrementOrderCount } = require('../lib/db');
const { generateOrderId } = require('../lib/keys');
const { sendOrderConfirmation } = require('../lib/email');

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

// POST /checkout
// Validation, rate limiting, and x402 payment middleware all run before this handler.
// By the time we get here: all fields are present, email/country are valid, rate limit
// is not exceeded, and USDC payment is settled on Base.
router.post('/', async (req, res) => {
  const { sku, name, email, address } = req.body || {};

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
    // Payment is already taken — alert store owner for manual resolution
    try {
      await sendOrderConfirmation({
        to: ALERT_EMAIL,
        subject: '🚨 x402 payment settled but Shopify order FAILED — manual action needed',
        html: `<p><strong>URGENT:</strong> A customer paid via x402 but the Shopify order failed.</p>
               <p><strong>Customer:</strong> ${esc(name)} &lt;${esc(email)}&gt;</p>
               <p><strong>SKU:</strong> ${esc(sku)}</p>
               <p><strong>Address:</strong> ${esc(address.line1)}, ${esc(address.city)}, ${esc(address.state)} ${esc(address.postal_code)}, ${esc(address.country)}</p>
               <p><strong>Error:</strong> ${esc(err.message)}</p>
               <p>Please create the order manually in Shopify and confirm with the customer.</p>`,
      });
    } catch (emailErr) {
      console.error('[checkout] Failed to send alert email:', emailErr.message);
    }
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
