'use strict';
const test = require('node:test');
const assert = require('node:assert');
const mpp = require('../src/lib/mpp');

const fakeReq = (headers) => ({ get: (h) => headers[h.toLowerCase()] });
const cred = (payload) => 'Payment ' + Buffer.from(JSON.stringify({ challenge: {}, payload })).toString('base64url');

test('hasMppCredential only matches the Payment auth scheme', () => {
  assert.equal(mpp.hasMppCredential(fakeReq({ authorization: cred({ spt: 'spt_1' }) })), true);
  assert.equal(mpp.hasMppCredential(fakeReq({ 'payment-authorization': 'Payment abc' })), true);
  assert.equal(mpp.hasMppCredential(fakeReq({ authorization: 'Bearer sk_agent_x' })), false);
  assert.equal(mpp.hasMppCredential(fakeReq({})), false);
});

test('credentialSpt extracts a spt_ token and rejects anything else', () => {
  assert.equal(mpp.credentialSpt(fakeReq({ authorization: cred({ spt: 'spt_abc' }) })), 'spt_abc');
  assert.equal(mpp.credentialSpt(fakeReq({ authorization: cred({ spt: 'pm_abc' }) })), null);
  assert.equal(mpp.credentialSpt(fakeReq({ authorization: 'Payment not-json' })), null);
});

test('initMpp fails closed: no keys, or a live key before mainnet', async () => {
  const saved = { ...process.env };
  try {
    delete process.env.STRIPE_SECRET_KEY; delete process.env.STRIPE_PROFILE_ID;
    assert.equal((await mpp.initMpp()).active, false);

    process.env.STRIPE_SECRET_KEY = 'sk_live_x'; process.env.STRIPE_PROFILE_ID = 'profile_x';
    process.env.X402_ENV = 'testnet';
    const s = await mpp.initMpp({ stripeClient: {} });
    assert.equal(s.active, false);
    assert.match(s.reason, /live Stripe key refused/);

    process.env.MPP_ENABLED = 'false'; process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    assert.equal((await mpp.initMpp({ stripeClient: {} })).active, false);
  } finally {
    process.env = saved;
  }
});

test('initMpp prices MPP from the same source as x402', async () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PROFILE_ID: 'profile_test_x', X402_ENV: 'mainnet', MPP_ENABLED: 'true' });
    delete process.env.X402_PRICE;
    const s = await mpp.initMpp({ stripeClient: {} });
    assert.equal(s.active, true);
    assert.equal(s.amount, '45.00');
  } finally {
    process.env = saved;
  }
});

test('MPP_LIVE lets a live key run on a testnet store, priced at mainnet not testnet', async () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { STRIPE_SECRET_KEY: 'sk_live_x', STRIPE_PROFILE_ID: 'profile_x', X402_ENV: 'testnet', X402_PRICE: '$0.50', MPP_LIVE: 'true' });
    delete process.env.MPP_ENABLED; delete process.env.MPP_PRICE;
    let s = await mpp.initMpp({ stripeClient: {} });
    assert.equal(s.active, true);
    assert.equal(s.livemode, true);
    assert.equal(s.amount, '45.00');

    process.env.MPP_PRICE = '$39';
    s = await mpp.initMpp({ stripeClient: {} });
    assert.equal(s.amount, '39.00');

    process.env.MPP_PRICE = 'abc';
    assert.equal((await mpp.initMpp({ stripeClient: {} })).active, false);
  } finally {
    process.env = saved;
  }
});
