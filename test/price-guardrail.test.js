'use strict';
// Tests for the boot-time price guardrail (src/lib/price-guardrail.js), no-network paths.
// Found by /qa on 2026-06-04.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { checkShopifyPriceConsistency } = require('../src/lib/price-guardrail');

const saved = {};
beforeEach(() => {
  for (const k of ['X402_ENV', 'X402_PRICE', 'SHOPIFY_STORE_DOMAIN', 'SHOPIFY_ADMIN_API_KEY']) saved[k] = process.env[k];
});
function restore() { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }

test('testnet -> skipped without any Shopify call', async () => {
  process.env.X402_ENV = 'testnet';
  const r = await checkShopifyPriceConsistency();
  assert.equal(r.ok, true);
  assert.equal(r.skipped, 'testnet');
  restore();
});

test('mainnet + Shopify unconfigured -> skipped (no-shopify), never blocks boot', async () => {
  process.env.X402_ENV = 'mainnet';
  delete process.env.SHOPIFY_STORE_DOMAIN;
  delete process.env.SHOPIFY_ADMIN_API_KEY;
  const r = await checkShopifyPriceConsistency();
  assert.equal(r.ok, true);
  assert.equal(r.skipped, 'no-shopify');
  restore();
});
