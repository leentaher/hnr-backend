/**
 * x402 end-to-end test script
 * Tests the full payment flow: 402 → sign EIP-3009 auth → hat ships
 *
 * Usage:
 *   PRIVATE_KEY=0xYOUR_PRIVATE_KEY node test-x402.mjs
 *
 * Get free testnet USDC at: https://faucet.circle.com (Base Sepolia)
 */

import { x402Client, x402HTTPClient } from '@x402/core/client';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error('Set PRIVATE_KEY env var: PRIVATE_KEY=0x... node test-x402.mjs');
  process.exit(1);
}

const CHECKOUT_URL = 'https://web-production-77376.up.railway.app/checkout';

const ORDER = {
  sku: 'hat-myagent-os',
  name: 'Leen Taher',
  email: 'leen.taher@gmail.com',
  address: {
    line1: '123 Test Street',
    city: 'Toronto',
    state: 'ON',
    postal_code: 'M1M 1M1',
    country: 'CA',
  },
};

async function run() {
  const account = privateKeyToAccount(PRIVATE_KEY);
  console.log(`\nAgent wallet: ${account.address}`);

  // Build x402 client with EVM exact scheme (handles EIP-3009 signing)
  const coreClient = new x402Client();
  registerExactEvmScheme(coreClient, { signer: account });
  const httpClient = new x402HTTPClient(coreClient);

  const body = JSON.stringify(ORDER);
  const headers = { 'Content-Type': 'application/json' };

  // Step 1: Hit /checkout — expect 402
  console.log('\nStep 1: POST /checkout (expecting 402)...');
  const firstRes = await fetch(CHECKOUT_URL, { method: 'POST', headers, body });

  if (firstRes.status !== 402) {
    console.error(`Expected 402, got ${firstRes.status}`);
    console.error(await firstRes.text());
    process.exit(1);
  }

  // Step 2: Parse the 402 payment requirements from the response
  const resBody = await firstRes.json();
  const paymentRequired = httpClient.getPaymentRequiredResponse(
    name => firstRes.headers.get(name),
    resBody,
  );
  const req = paymentRequired.accepts[0];
  console.log(`Got 402. Payment details:`);
  console.log(`  Network:  ${req.network}`);
  console.log(`  Amount:   $${Number(req.maxAmountRequired) / 1_000_000} USDC`);
  console.log(`  Pay to:   ${req.payTo}`);

  // Step 3: Create signed payment payload (EIP-3009 transferWithAuthorization)
  console.log('\nStep 3: Signing payment authorization...');
  const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
  const paymentHeader = httpClient.encodePaymentSignatureHeader(paymentPayload);
  console.log('Signed.');

  // Step 4: Retry /checkout with the signed payment header
  console.log('\nStep 4: Re-sending /checkout with payment proof...');
  const secondRes = await fetch(CHECKOUT_URL, {
    method: 'POST',
    headers: { ...headers, ...paymentHeader },
    body,
  });

  const result = await secondRes.json();
  if (secondRes.status === 201) {
    console.log(`\nORDER PLACED. Hat is on the way.`);
    console.log(`  Order ID:       ${result.order_id}`);
    console.log(`  Shopify order:  ${result.shopify_order_id}`);
    console.log(`  Payment:        ${result.payment}`);
  } else {
    console.error(`\nUnexpected response (${secondRes.status}):`);
    console.error(result);
  }
}

run().catch(err => {
  console.error('\nError:', err.message);
  process.exit(1);
});
