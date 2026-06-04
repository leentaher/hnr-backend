'use strict';
// Regression: x402 discovery gate on POST /checkout (src/index.js).
// Found by /qa on 2026-06-04.
//
// Bug it locks in: field validation used to run BEFORE the x402 middleware, so an
// unpaid discovery probe (no payment header) got 400 missing_field instead of a 402
// challenge — breaking standard x402 auto-discovery. The fix falls through to the
// x402 middleware when no payment header is present, while a PAID request (v1
// X-PAYMENT or v2 PAYMENT-SIGNATURE) still runs full validation before settlement.
//
// We can't boot the full Express app here (no Postgres + slow module load), so this
// asserts the exact gate predicate from index.js against a minimal request stub.
// Header detection itself is covered separately in payment-identity.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Mirror of the gate in src/index.js:141 — keep in sync if that line changes.
function isUnpaidDiscovery(req) {
  return !req.get('payment-signature') && !req.get('x-payment');
}

function reqWith(headers = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { get: (name) => lower[name.toLowerCase()] };
}

test('no payment header -> treated as discovery (falls through to 402 challenge)', () => {
  assert.equal(isUnpaidDiscovery(reqWith({})), true);
});

test('v1 X-PAYMENT header -> treated as paid (runs validation before settlement)', () => {
  assert.equal(isUnpaidDiscovery(reqWith({ 'X-Payment': 'ZmFrZQ==' })), false);
});

test('v2 PAYMENT-SIGNATURE header -> treated as paid (the v2 safety fix)', () => {
  assert.equal(isUnpaidDiscovery(reqWith({ 'Payment-Signature': 'ZmFrZQ==' })), false);
});

test('both payment headers present -> treated as paid', () => {
  assert.equal(isUnpaidDiscovery(reqWith({ 'X-Payment': 'a', 'Payment-Signature': 'b' })), false);
});
