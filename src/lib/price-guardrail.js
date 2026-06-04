'use strict';
// Boot-time guardrail: verify the live Shopify variant price agrees with the x402 charge
// (lib/pricing). Catches silent drift between what the agent's wallet pays and what Shopify
// records as the order total — WITHOUT putting Shopify on the live payment path.
//
// Policy:
//   - Only meaningful on mainnet. Testnet intentionally charges $1, not the real price, so
//     we skip the check there.
//   - A Shopify fetch failure is NON-FATAL: the x402 charge is still well-defined by
//     lib/pricing, so we never let Shopify availability block startup.
//   - A CONFIRMED mismatch (successful fetch, different USD price) logs a loud error. Set
//     STRICT_PRICE_CHECK=true to also hard-fail boot on drift.
//   - Non-USD store currency is reported but not numerically asserted (USDC settles ~USD;
//     a real FX conversion would be needed and is out of scope for this guard).

const { getProduct } = require('./products');
const { getPricing } = require('./pricing');

const SHOPIFY_API_VERSION = '2025-01';

async function shopifyGet(pathname) {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ADMIN_API_KEY;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 8000);
  try {
    const r = await fetch(`https://${domain}/admin/api/${SHOPIFY_API_VERSION}/${pathname}`, {
      headers: { 'X-Shopify-Access-Token': token },
      signal: controller.signal,
    });
    if (!r.ok) throw new Error(`Shopify ${r.status}`);
    return await r.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Shopify API timed out after 8s');
    throw err;
  } finally {
    clearTimeout(t);
  }
}

async function checkShopifyPriceConsistency(sku = 'hat-myagent-os') {
  const { isMainnet, priceUsd, env } = getPricing();

  if (!isMainnet) {
    console.log(`[price-check] skipped — X402_ENV=${env} charges $${priceUsd} for testing, not the real Shopify price.`);
    return { ok: true, skipped: 'testnet' };
  }
  if (!process.env.SHOPIFY_STORE_DOMAIN || !process.env.SHOPIFY_ADMIN_API_KEY) {
    console.warn('[price-check] Shopify not configured — cannot verify price consistency.');
    return { ok: true, skipped: 'no-shopify' };
  }
  const product = getProduct(sku);
  if (!product || !product.shopifyVariantId || product.shopifyVariantId === 'FILL_ME') {
    console.warn(`[price-check] no Shopify variant for SKU "${sku}" — skipping.`);
    return { ok: true, skipped: 'no-variant' };
  }

  let variant, shop;
  try {
    [variant, shop] = await Promise.all([
      shopifyGet(`variants/${product.shopifyVariantId}.json`).then(j => j.variant),
      shopifyGet('shop.json').then(j => j.shop),
    ]);
  } catch (err) {
    // Non-fatal — never let Shopify availability gate boot. The x402 charge stands.
    console.warn(`[price-check] could not reach Shopify (${err.message}) — skipping verification. x402 charge stands at $${priceUsd}.`);
    return { ok: true, skipped: 'fetch-failed' };
  }

  const currency = shop && shop.currency;
  const shopPrice = parseFloat(variant && variant.price);

  if (currency && currency !== 'USD') {
    console.warn(`[price-check] Shopify store currency is ${currency}, not USD — x402 settles USDC (~USD). Charge=$${priceUsd}, variant=${variant.price} ${currency}. Verify conversion manually.`);
    return { ok: true, skipped: 'non-usd', shopPrice, currency };
  }
  if (!Number.isFinite(shopPrice)) {
    console.warn(`[price-check] Shopify variant ${product.shopifyVariantId} returned no usable price — skipping.`);
    return { ok: true, skipped: 'no-price' };
  }

  if (Math.abs(shopPrice - priceUsd) > 0.005) {
    const msg = `[price-check] PRICE DRIFT — x402 charges $${priceUsd} but Shopify variant ${product.shopifyVariantId} is $${shopPrice}. The agent's wallet charge and the Shopify order total disagree. Fix X402_PRICE or the Shopify variant price.`;
    console.error(msg);
    if ((process.env.STRICT_PRICE_CHECK || '').toLowerCase().trim() === 'true') {
      throw new Error(msg);
    }
    return { ok: false, drift: true, shopPrice, priceUsd };
  }

  console.log(`[price-check] OK — x402 charge $${priceUsd} matches Shopify variant $${shopPrice} (${currency || 'USD'}).`);
  return { ok: true, shopPrice, priceUsd };
}

module.exports = { checkShopifyPriceConsistency };
