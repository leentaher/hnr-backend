// SKU catalog with prices and Shopify variant IDs
// Step 4: Replace FILL_ME values with real Shopify variant IDs.
// Get them: Shopify Admin → Products → click product → click variant → ID is in the URL
// e.g. https://admin.shopify.com/store/human-not-required/products/123/variants/456 → ID is 456

const PRODUCTS = {
  'hat-myagent-os': {
    label: 'My Agent Bought Me This — Embroidered Hat',
    size: 'One Size',
    priceUsd: 35,
    shopifyVariantId: 'FILL_ME', // hat variant ID
  },
  'shirt-myagent-s': {
    label: 'My agent bought me this',
    size: 'S',
    priceUsd: 35,
    shopifyVariantId: 'FILL_ME',
  },
  'shirt-myagent-m': {
    label: 'My agent bought me this',
    size: 'M',
    priceUsd: 35,
    shopifyVariantId: 'FILL_ME',
  },
  'shirt-myagent-l': {
    label: 'My agent bought me this',
    size: 'L',
    priceUsd: 35,
    shopifyVariantId: 'FILL_ME',
  },
  'shirt-afk-s': {
    label: 'I was AFK. My agent handled it.',
    size: 'S',
    priceUsd: 35,
    shopifyVariantId: 'FILL_ME',
  },
  'shirt-afk-m': {
    label: 'I was AFK. My agent handled it.',
    size: 'M',
    priceUsd: 35,
    shopifyVariantId: 'FILL_ME',
  },
  'shirt-afk-l': {
    label: 'I was AFK. My agent handled it.',
    size: 'L',
    priceUsd: 35,
    shopifyVariantId: 'FILL_ME',
  },
  'shirt-claude-s': {
    label: "I didn't ask for this. Claude did.",
    size: 'S',
    priceUsd: 35,
    shopifyVariantId: 'FILL_ME',
  },
  'shirt-claude-m': {
    label: "I didn't ask for this. Claude did.",
    size: 'M',
    priceUsd: 35,
    shopifyVariantId: 'FILL_ME',
  },
  'shirt-claude-l': {
    label: "I didn't ask for this. Claude did.",
    size: 'L',
    priceUsd: 35,
    shopifyVariantId: 'FILL_ME',
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
