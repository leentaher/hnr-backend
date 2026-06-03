'use strict';

// Recover the payer wallet + EIP-3009 nonce from an x402 payment header so callers can key
// idempotency and reconciliation on them. The header is base64(JSON), sent as
// PAYMENT-SIGNATURE (x402 v2) or X-PAYMENT (v1). Exact-EVM payload shape:
//   { x402Version, payload: { authorization: { from, to, value, nonce, ... }, signature } }
//
// Pure + dependency-free on purpose: unit-testable without booting Express/DB/email.
function extractPaymentIdentity(req) {
  const header = req.get('payment-signature') || req.get('x-payment');
  if (!header) return { payer: null, nonce: null };
  try {
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf-8'));
    const auth = decoded?.payload?.authorization || {};
    return { payer: auth.from || null, nonce: auth.nonce || null };
  } catch {
    return { payer: null, nonce: null };
  }
}

module.exports = { extractPaymentIdentity };
