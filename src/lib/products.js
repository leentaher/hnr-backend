// SKU catalog with prices and Shopify variant IDs
// Step 4: Replace FILL_ME values with real Shopify variant IDs.
// Get them: Shopify Admin → Products → click product → click variant → ID is in the URL
// e.g. https://admin.shopify.com/store/human-not-required/products/123/variants/456 → ID is 456

const PRODUCTS = {
  'hat-myagent-os': {
    label: 'My Agent Bought Me This — Embroidered Hat',
    size: 'One Size',
    priceUsd: 35,
    shopifyVariantId: '7864672911446',
  },
};

function getProduct(sku) {
  return PRODUCTS[sku] || null;
}

function listSkus() {
  return Object.entries(PRODUCTS).map(([sku, p]) => ({
    sku,
    label: p.label,
    size: p.size,
    price_usd: p.priceUsd,
  }));
}

module.exports = { getProduct, listSkus };
