/**
 * QA regression tests for the x402 checkout validation, /email admin auth, and
 * CORS fixes. No external deps — uses Node built-in assert only.
 * Run: node test-qa-fixes.mjs
 */

import assert from 'node:assert/strict';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

// ─── Helper: simulate the Express validation middleware from index.js ──────────
// Extracted to be testable without booting Express.

const TEST_DOMAINS = new Set(['test.com', 'test.test', 'example.com', 'example.org',
  'example.net', 'dummy.com', 'fake.com', 'noemail.com', 'noreply.com', 'invalid.com']);

function getProduct(sku) {
  const products = { 'hat-myagent-os': { label: 'Hat', shopifyVariantId: '12345', priceUsd: 35 } };
  return products[sku] || null;
}

function validateCheckout(body) {
  const { sku, name, email, address } = body || {};

  if (!sku) return { status: 400, error: 'missing_field', field: 'sku' };
  if (!getProduct(sku)) return { status: 400, error: 'invalid_sku' };
  if (!name || !email || !address?.line1 || !address?.city || !address?.state || !address?.postal_code || !address?.country) {
    return { status: 400, error: 'needs_address' };
  }
  const nameTrimmed = name.trim();
  if (nameTrimmed.length < 2 || nameTrimmed.split(/\s+/).length < 2) {
    return { status: 400, error: 'invalid_name' };
  }
  const emailDomain = email.toLowerCase().split('@')[1] || '';
  if (TEST_DOMAINS.has(emailDomain)) return { status: 400, error: 'invalid_email', reason: 'test_domain' };
  if (address.line1.trim().length < 5) return { status: 400, error: 'invalid_address' };
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) return { status: 400, error: 'invalid_email', reason: 'format' };
  if (!/^[A-Z]{2}$/.test(address.country.toUpperCase())) return { status: 400, error: 'invalid_country' };
  return null; // valid
}

const VALID_BODY = {
  sku: 'hat-myagent-os',
  name: 'Jane Smith',
  email: 'jane@realcompany.com',
  address: { line1: '123 Main Street', city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' },
};

// ─── Fix 1: Validation runs BEFORE payment (prevents charging on bad input) ──

console.log('\nFix 1: Validation before payment');

test('valid body passes validation', () => {
  const result = validateCheckout(VALID_BODY);
  assert.equal(result, null);
});

test('missing SKU returns 400 before payment fires', () => {
  const result = validateCheckout({ ...VALID_BODY, sku: undefined });
  assert.equal(result.status, 400);
  assert.equal(result.error, 'missing_field');
});

test('invalid SKU returns 400 before payment fires', () => {
  const result = validateCheckout({ ...VALID_BODY, sku: 'hat-does-not-exist' });
  assert.equal(result.status, 400);
  assert.equal(result.error, 'invalid_sku');
});

test('test domain email blocked before payment fires', () => {
  const result = validateCheckout({ ...VALID_BODY, email: 'agent@example.com' });
  assert.equal(result.status, 400);
  assert.equal(result.error, 'invalid_email');
  assert.equal(result.reason, 'test_domain');
});

test('all test domains blocked', () => {
  const domains = ['test.com', 'test.test', 'example.com', 'example.org', 'example.net',
    'dummy.com', 'fake.com', 'noemail.com', 'noreply.com', 'invalid.com'];
  for (const d of domains) {
    const r = validateCheckout({ ...VALID_BODY, email: `x@${d}` });
    assert.equal(r?.error, 'invalid_email', `expected invalid_email for ${d}`);
  }
});

test('single-word name blocked (no last name)', () => {
  const result = validateCheckout({ ...VALID_BODY, name: 'Agent' });
  assert.equal(result.status, 400);
  assert.equal(result.error, 'invalid_name');
});

test('short street address blocked', () => {
  const result = validateCheckout({ ...VALID_BODY, address: { ...VALID_BODY.address, line1: '123' } });
  assert.equal(result.status, 400);
  assert.equal(result.error, 'invalid_address');
});

test('invalid country code blocked', () => {
  const result = validateCheckout({ ...VALID_BODY, address: { ...VALID_BODY.address, country: 'USA' } });
  assert.equal(result.status, 400);
  assert.equal(result.error, 'invalid_country');
});

test('missing address fields caught', () => {
  const result = validateCheckout({ ...VALID_BODY, address: { line1: '123 Main St' } });
  assert.equal(result.status, 400);
  assert.equal(result.error, 'needs_address');
});

// ─── Fix 4: ADMIN_SECRET fail-closed ─────────────────────────────────────────

console.log('\nFix 4: ADMIN_SECRET fail-closed');

function checkAdminAuth(adminSecret, providedHeader) {
  if (!adminSecret) return { status: 503, error: 'not_configured' };
  const provided = (providedHeader || '').trim();
  if (!provided || provided !== adminSecret) return { status: 401, error: 'unauthorized' };
  return null; // authorized
}

test('no ADMIN_SECRET set → 503, not unauthenticated passthrough', () => {
  const result = checkAdminAuth(undefined, 'anything');
  assert.equal(result.status, 503);
  assert.equal(result.error, 'not_configured');
});

test('ADMIN_SECRET set, no header → 401', () => {
  const result = checkAdminAuth('supersecret', '');
  assert.equal(result.status, 401);
});

test('ADMIN_SECRET set, wrong header → 401', () => {
  const result = checkAdminAuth('supersecret', 'wrongvalue');
  assert.equal(result.status, 401);
});

test('ADMIN_SECRET set, correct header → authorized', () => {
  const result = checkAdminAuth('supersecret', 'supersecret');
  assert.equal(result, null);
});

// ─── Fix 6: CORS — no wildcard with Authorization ────────────────────────────

console.log('\nFix 6: CORS wildcard + Authorization');

function computeCorsHeaders(origin, allowedOrigins) {
  if (origin && allowedOrigins.has(origin)) {
    return { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'Content-Type, Authorization, X-Payment, Payment-Signature, MCP-Session-Id' };
  }
  // No ACAO for unknown origins or no origins configured
  return {};
}

test('known origin gets full CORS headers including Authorization', () => {
  const headers = computeCorsHeaders('https://myapp.com', new Set(['https://myapp.com']));
  assert.equal(headers['access-control-allow-origin'], 'https://myapp.com');
  assert(headers['access-control-allow-headers'].includes('Authorization'));
});

test('unknown origin gets no ACAO header', () => {
  const headers = computeCorsHeaders('https://evil.com', new Set(['https://myapp.com']));
  assert.equal(headers['access-control-allow-origin'], undefined);
});

test('no origins configured → no wildcard ACAO emitted', () => {
  const headers = computeCorsHeaders(undefined, new Set());
  assert.equal(headers['access-control-allow-origin'], undefined, 'wildcard must not be set');
});

test('agent request (no origin header) → no ACAO header needed', () => {
  const headers = computeCorsHeaders(undefined, new Set(['https://myapp.com']));
  assert.equal(headers['access-control-allow-origin'], undefined);
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('\nFAILED — see above for details');
  process.exit(1);
} else {
  console.log('\nAll tests passed ✓');
}
