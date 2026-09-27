'use strict';

// Stripe Machine Payments Protocol (MPP) — the card/Link rail on POST /checkout, next to x402.
//
// Spec: https://mpp.dev + https://paymentauth.org/draft-stripe-charge-00. We use the official
// `mppx` server SDK (ESM-only, loaded via dynamic import) so the challenge / credential /
// receipt formats are exactly what Stripe's `link-cli mpp pay` expects:
//   402  → WWW-Authenticate: Payment id=…, realm=…, method="stripe", intent="charge", request=<b64url JCS>
//   retry → Authorization: Payment <b64url JSON { challenge, payload: { spt: "spt_…" } }>
//   2xx  → Payment-Receipt: <b64url JSON { method:"stripe", reference:"pi_…", status:"success" }>
//
// Unlike x402 (deferred capture), MPP settles IMMEDIATELY: mppx verifies the HMAC-bound
// challenge and creates + confirms a Stripe PaymentIntent with the Shared Payment Token before
// we fulfill. So a fulfillment failure after settlement must be REFUNDED (see refund()).
//
// Activation (fail closed — MPP is simply not offered unless all of this holds):
//   STRIPE_SECRET_KEY  — sk_test_… for testing. A live key is refused unless X402_ENV=mainnet
//                        OR MPP_LIVE=true (explicit opt-in to real card/Link charges while the
//                        x402 rail stays on testnet).
//   MPP_PRICE          — optional USD price for the Stripe rail, e.g. "45.00". In live mode it
//                        defaults to the mainnet price ($45), never the testnet x402 price, so
//                        real cards can't be charged a testnet amount. In test mode it defaults
//                        to the x402 price.
//   STRIPE_PROFILE_ID  — Stripe profile id (profile_test_… in a sandbox) = MPP networkId.
//   MPP_ENABLED        — optional kill switch; set to "false" to stop offering MPP.
//   MPP_SECRET_KEY     — optional challenge-HMAC secret (≥32 bytes); defaults to one derived
//                        from STRIPE_SECRET_KEY, as in Stripe's MPP sample.

const crypto = require('crypto');
const { getPricing, MAINNET_DEFAULT_PRICE } = require('./pricing');

const parseUsd = (v) => parseFloat(String(v).replace(/^\$/, ''));

const DESCRIPTION = 'My Agent Bought Me This embroidered hat (Humans Not Required)';

let state = { active: false, reason: 'not initialized' };

function appBaseUrl() {
  return (process.env.APP_URL || 'https://web-production-77376.up.railway.app').replace(/\/+$/, '');
}

// `stripeClient` is injectable for tests; production builds one from STRIPE_SECRET_KEY.
async function initMpp({ stripeClient } = {}) {
  const key = process.env.STRIPE_SECRET_KEY;
  const profileId = process.env.STRIPE_PROFILE_ID;
  if ((process.env.MPP_ENABLED || 'true').toLowerCase().trim() === 'false') {
    state = { active: false, reason: 'MPP_ENABLED=false' };
  } else if (!key || !profileId) {
    state = { active: false, reason: 'STRIPE_SECRET_KEY and STRIPE_PROFILE_ID are required' };
  } else {
    const livemode = !key.includes('_test_');
    const { isMainnet, priceUsd } = getPricing();
    const liveOptIn = (process.env.MPP_LIVE || '').toLowerCase().trim() === 'true';
    // Live charges use MPP_PRICE, else the mainnet price — never a testnet x402 price.
    const mppPrice = process.env.MPP_PRICE
      ? parseUsd(process.env.MPP_PRICE)
      : (livemode && !isMainnet ? parseUsd(MAINNET_DEFAULT_PRICE) : priceUsd);
    if (livemode && !isMainnet && !liveOptIn) {
      state = { active: false, reason: 'live Stripe key refused while X402_ENV is not mainnet (set MPP_LIVE=true or use an sk_test_ key)' };
    } else if (!(mppPrice > 0)) {
      state = { active: false, reason: `invalid MPP_PRICE "${process.env.MPP_PRICE}"` };
    } else {
      try {
        const { Mppx, stripe } = await import('mppx/server');
        const client = stripeClient || new (await import('stripe')).default(key);
        const secretKey = process.env.MPP_SECRET_KEY
          || crypto.createHmac('sha256', key).update('mpp-challenge-signing').digest('base64');
        const mppx = Mppx.create({
          methods: [stripe.charge({
            client,
            networkId: profileId,
            paymentMethodTypes: ['card', 'link'],
            currency: 'usd',
            decimals: 2,
          })],
          secretKey,
          realm: new URL(appBaseUrl()).host,
        });
        const amount = mppPrice.toFixed(2);
        state = { active: true, livemode, amount, client, handler: mppx.charge({ amount, description: DESCRIPTION }) };
        console.log(`[mpp] Stripe MPP active on POST /checkout ($${amount}, ${livemode ? 'LIVE' : 'test'} mode)`);
        return state;
      } catch (err) {
        state = { active: false, reason: `init failed: ${err.message}` };
      }
    }
  }
  console.warn(`[mpp] Stripe MPP not offered — ${state.reason}`);
  return state;
}

function isActive() {
  return state.active;
}

// Public description of the Stripe rail for discovery docs (payment manifest). Null when off.
function info() {
  if (!state.active) return null;
  return {
    protocol: 'mpp',
    method: 'stripe',
    payment_method_types: ['card', 'link'],
    path: '/checkout',
    httpMethod: 'POST',
    price: `$${state.amount}`,
    currency: 'USD',
    livemode: state.livemode,
    how: 'POST /checkout unpaid → 402 with WWW-Authenticate: Payment method="stripe"; pay with a Link wallet (e.g. npx @stripe/link-cli mpp pay <url> -X POST -d <body>) and retry with Authorization: Payment <credential>.',
  };
}

// An MPP credential arrives as `Authorization: Payment …` (or `Payment-Authorization` when the
// challenge asked for it). A Bearer or other scheme is not ours.
function hasMppCredential(req) {
  const v = req.get('payment-authorization') || req.get('authorization') || '';
  return /^payment\s+/i.test(v);
}

// Decode the SPT from the credential without verifying it — used only as the idempotency key.
// Verification (HMAC, expiry, settlement) is mppx's job.
function credentialSpt(req) {
  try {
    const v = (req.get('payment-authorization') || req.get('authorization') || '').replace(/^payment\s+/i, '').trim();
    const cred = JSON.parse(Buffer.from(v, 'base64url').toString('utf8'));
    const spt = cred?.payload?.spt;
    return typeof spt === 'string' && spt.startsWith('spt_') ? spt : null;
  } catch {
    return null;
  }
}

// Express request → Fetch Request for mppx. The URL uses APP_URL so the realm/host is stable
// behind Railway's proxy.
function toFetchRequest(req) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || k === 'content-length' || k === 'host') continue;
    headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
  }
  return new Request(appBaseUrl() + req.originalUrl, {
    method: req.method,
    headers,
    body: req.body && req.method !== 'GET' ? JSON.stringify(req.body) : undefined,
  });
}

async function sendFetchResponse(res, response) {
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.status(response.status).send(Buffer.from(await response.arrayBuffer()));
}

// Unpaid probe: compute the Stripe challenge and return its WWW-Authenticate header value so the
// x402 middleware's 402 carries BOTH challenges. Never throws — a failure just omits MPP.
async function challengeHeader(req) {
  if (!state.active) return null;
  try {
    const result = await state.handler(toFetchRequest(req));
    return result.status === 402 ? result.challenge.headers.get('www-authenticate') : null;
  } catch (err) {
    console.error('[mpp] challenge generation failed:', err.message);
    return null;
  }
}

// Paid retry: verify the credential and settle the SPT through Stripe.
// Returns { ok: true, paymentIntentId, withReceipt } on a succeeded PaymentIntent, or
// { ok: false, response } carrying mppx's 402 (fresh challenge + problem+json) otherwise.
async function settle(req) {
  const result = await state.handler(toFetchRequest(req));
  if (result.status === 402) return { ok: false, response: result.challenge };
  // Read the PaymentIntent id off the receipt mppx would attach.
  const probe = result.withReceipt(new Response(null, { status: 204 }));
  let paymentIntentId = null;
  try {
    const receipt = JSON.parse(Buffer.from(probe.headers.get('payment-receipt') || '', 'base64url').toString('utf8'));
    paymentIntentId = receipt.reference || null;
  } catch { /* leave null */ }
  return { ok: true, paymentIntentId, withReceipt: result.withReceipt };
}

async function refund(paymentIntentId) {
  if (!paymentIntentId) throw new Error('no PaymentIntent id to refund');
  return state.client.refunds.create(
    { payment_intent: paymentIntentId },
    { idempotencyKey: `refund_${paymentIntentId}` },
  );
}

module.exports = { initMpp, isActive, info, hasMppCredential, credentialSpt, challengeHeader, settle, refund, sendFetchResponse };
