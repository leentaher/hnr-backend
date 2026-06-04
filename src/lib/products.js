// SKU catalog with prices and Shopify variant IDs

const PRODUCTS = {
  'hat-myagent-os': {
    label: 'My Agent Bought Me This — Embroidered Hat',
    size: 'One Size',
    // Price is NOT stored per-product — it comes from lib/pricing (single source of
    // truth) so x402, the Stripe rail, and /orders/skus can never disagree.
    shopifyVariantId: '44665203589206',
  },
};

// Price comes from the single source of truth (lib/pricing) so /orders/skus always
// reflects exactly what /checkout charges.
const { getPricing } = require('./pricing');

function getProduct(sku) {
  return PRODUCTS[sku] || null;
}

function listSkus() {
  const { priceUsd } = getPricing();
  return Object.entries(PRODUCTS).map(([sku, p]) => ({
    sku,
    label: p.label,
    size: p.size,
    price_usd: priceUsd,   // single-sourced from lib/pricing — matches the x402 charge
  }));
}

module.exports = { getProduct, listSkus };
