// SKU catalog with prices and Shopify variant IDs

const PRODUCTS = {
  'hat-myagent-os': {
    label: 'My Agent Bought Me This — Embroidered Hat',
    size: 'One Size',
    priceUsd: 35,           // mainnet price — used for Stripe flow
    shopifyVariantId: '44665203589206',
  },
};

// x402 price derives from env (same logic as index.js and mcp.mjs)
// so /orders/skus always reflects what the checkout endpoint actually charges
const X402_ENV = (process.env.X402_ENV || 'testnet').toLowerCase();
const isMainnet = X402_ENV === 'mainnet';
const x402PriceStr = process.env.X402_PRICE || (isMainnet ? '$35.00' : '$1.00');
// Strip leading $ and parse to float for the JSON field
const x402PriceUsd = parseFloat(x402PriceStr.replace(/^\$/, '')) || (isMainnet ? 35 : 1);

function getProduct(sku) {
  return PRODUCTS[sku] || null;
}

function listSkus() {
  return Object.entries(PRODUCTS).map(([sku, p]) => ({
    sku,
    label: p.label,
    size: p.size,
    price_usd: x402PriceUsd,   // reflects actual x402 charge (testnet: $1, mainnet: $35)
  }));
}

module.exports = { getProduct, listSkus };
