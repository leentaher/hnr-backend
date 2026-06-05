// Shared Shopify order creation — used by both the x402 paid path (routes/checkout.js)
// and the promo free-order path (routes/checkout.js placePromoOrder). Single code path so
// the two rails can never drift on how an order is shaped or how failures are handled.

const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_API_KEY;

// note/tags default to the x402 wording; the promo path overrides them.
async function createShopifyOrder({ name, email, address, product, sku, note, tags }) {
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
      note: note || `Placed via x402 USDC payment on Base. SKU: ${sku}. Agent-native purchase.`,
      tags: tags || 'agent-order,x402,usdc',
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
    console.error('[fulfillment] Shopify API error:', response.status, text); // full detail in server logs only
    throw new Error(`Shopify order creation failed (${response.status})`); // sanitized for callers
  }

  const data = await response.json();
  return String(data.order.id);
}

module.exports = { createShopifyOrder };
