'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// lib/pricing + lib/products read env at call time, so we can flip env per test.
const { getPricing, checkoutDescription } = require('../src/lib/pricing');
const { listSkus } = require('../src/lib/products');

let saved;
beforeEach(() => { saved = { env: process.env.X402_ENV, price: process.env.X402_PRICE, net: process.env.X402_NETWORK }; });
afterEach(() => {
  for (const [k, v] of [['X402_ENV', saved.env], ['X402_PRICE', saved.price], ['X402_NETWORK', saved.net]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test('mainnet default price is $45 on Base mainnet', () => {
  process.env.X402_ENV = 'mainnet';
  delete process.env.X402_PRICE;
  const p = getPricing();
  assert.equal(p.priceStr, '$45.00');
  assert.equal(p.priceUsd, 45);
  assert.equal(p.network, 'eip155:8453');
});

test('testnet default price is $1 on Base Sepolia', () => {
  process.env.X402_ENV = 'testnet';
  delete process.env.X402_PRICE;
  const p = getPricing();
  assert.equal(p.priceStr, '$1.00');
  assert.equal(p.priceUsd, 1);
  assert.equal(p.network, 'eip155:84532');
});

test('X402_PRICE override wins over the env default', () => {
  process.env.X402_ENV = 'mainnet';
  process.env.X402_PRICE = '$60.00';
  const p = getPricing();
  assert.equal(p.priceStr, '$60.00');
  assert.equal(p.priceUsd, 60);
});

// The invariant that would have caught the original $35-manifest / $45-charge drift:
// every price-quoting surface derives from one source.
test('price-consistency invariant: /orders/skus, description, and getPricing agree', () => {
  process.env.X402_ENV = 'mainnet';
  delete process.env.X402_PRICE;
  const { priceUsd, priceStr } = getPricing();
  assert.equal(listSkus()[0].price_usd, priceUsd, 'skus price must equal source price');
  assert.ok(checkoutDescription().includes(priceStr), 'description must quote the source price');
});
