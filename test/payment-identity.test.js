'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractPaymentIdentity } = require('../src/lib/x402-payment');

// Minimal Express-req stub: case-insensitive header lookup like req.get().
function reqWith(headers = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { get: (name) => lower[name.toLowerCase()] };
}

function encode(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64');
}

const PAYER = '0x1111111111111111111111111111111111111111';
const NONCE = '0xabc123def4567890abc123def4567890abc123def4567890abc123def4567890';

function validPayload() {
  return {
    x402Version: 2,
    payload: {
      authorization: {
        from: PAYER,
        to: '0x2222222222222222222222222222222222222222',
        value: '45000000',
        validAfter: '1000',
        validBefore: '2000',
        nonce: NONCE,
      },
      signature: '0xdeadbeef',
    },
  };
}

test('decodes payer + nonce from a v2 PAYMENT-SIGNATURE header', () => {
  const req = reqWith({ 'PAYMENT-SIGNATURE': encode(validPayload()) });
  assert.deepEqual(extractPaymentIdentity(req), { payer: PAYER, nonce: NONCE });
});

test('decodes from a v1 X-PAYMENT header (fallback)', () => {
  const req = reqWith({ 'X-PAYMENT': encode(validPayload()) });
  assert.deepEqual(extractPaymentIdentity(req), { payer: PAYER, nonce: NONCE });
});

test('PAYMENT-SIGNATURE takes precedence over X-PAYMENT', () => {
  const other = validPayload();
  other.payload.authorization.nonce = '0xother';
  const req = reqWith({ 'PAYMENT-SIGNATURE': encode(validPayload()), 'X-PAYMENT': encode(other) });
  assert.equal(extractPaymentIdentity(req).nonce, NONCE);
});

test('returns nulls when no payment header is present', () => {
  assert.deepEqual(extractPaymentIdentity(reqWith({})), { payer: null, nonce: null });
});

test('returns nulls on malformed base64 / non-JSON', () => {
  const req = reqWith({ 'PAYMENT-SIGNATURE': '!!!not-base64!!!' });
  assert.deepEqual(extractPaymentIdentity(req), { payer: null, nonce: null });
});

test('returns nulls when authorization is missing from the payload', () => {
  const req = reqWith({ 'PAYMENT-SIGNATURE': encode({ x402Version: 2, payload: {} }) });
  assert.deepEqual(extractPaymentIdentity(req), { payer: null, nonce: null });
});
