'use strict';

// Single source of truth for x402 price + network. EVERYTHING that quotes a price or
// network (checkout middleware, /orders/skus, MCP tool text, the payment manifest, the
// x402 description) derives from here so the surfaces can never drift — e.g. the manifest
// saying $35 while checkout charges $45.
//
// X402_ENV=testnet (default) | mainnet picks the defaults below.
// X402_PRICE / X402_NETWORK override explicitly when set.

const MAINNET_DEFAULT_PRICE = '$45.00';
const TESTNET_DEFAULT_PRICE = '$1.00';

function getPricing() {
  const env = (process.env.X402_ENV || 'testnet').toLowerCase();
  const isMainnet = env === 'mainnet';

  const priceStr = process.env.X402_PRICE || (isMainnet ? MAINNET_DEFAULT_PRICE : TESTNET_DEFAULT_PRICE);
  const priceUsd = parseFloat(priceStr.replace(/^\$/, '')) || (isMainnet ? 45 : 1);

  const network = process.env.X402_NETWORK || (isMainnet ? 'eip155:8453' : 'eip155:84532');
  const networkLabel = isMainnet ? 'Base' : 'Base Sepolia (testnet)';
  const usdcAddress = isMainnet
    ? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'  // Base mainnet USDC
    : '0x036CbD53842c5426634e7929541eC2318f3dCF7e'; // Base Sepolia USDC

  return { env, isMainnet, priceStr, priceUsd, network, networkLabel, usdcAddress };
}

// Human-readable product description, derived from the live price so it always matches.
function checkoutDescription() {
  const { priceStr, networkLabel } = getPricing();
  return `Buy the "My Agent Bought Me This" embroidered hat — ${priceStr} USDC on ${networkLabel}`;
}

module.exports = { getPricing, checkoutDescription };
