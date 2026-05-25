// SKU catalog with prices and Shopify variant IDs

const PRODUCTS = {
  'hat-myagent-os': {
    label: 'My Agent Bought Me This — Embroidered Hat',
    size: 'One Size',
    priceUsd: 35,
    shopifyVariantId: '44665203589206',
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
