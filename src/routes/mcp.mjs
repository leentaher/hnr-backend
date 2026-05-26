/**
 * MCP HTTP endpoint — Streamable HTTP transport
 * Mounted at /mcp in the Express app via dynamic import()
 * Exposes tools for both Stripe and x402 payment flows.
 * When ENABLE_STRIPE=false, Stripe tools return clear "not_available" responses
 * and buy_hat uses the x402 /checkout endpoint instead.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import express from 'express';

const BASE_URL = process.env.APP_URL || 'https://web-production-77376.up.railway.app';
const stripeEnabled = (process.env.ENABLE_STRIPE || 'true').toLowerCase().trim() !== 'false';

// Mirrors X402_ENV logic from index.js so tool descriptions stay in sync
const X402_ENV = (process.env.X402_ENV || 'testnet').toLowerCase();
const isMainnet = X402_ENV === 'mainnet';
const x402Price = process.env.X402_PRICE || (isMainnet ? '$35.00' : '$1.00');
const x402NetworkLabel = isMainnet ? 'Base' : 'Base Sepolia (testnet)';
const x402UsdcAddress = isMainnet
  ? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'  // Base mainnet USDC
  : '0x036CbD53842c5426634e7929541eC2318f3dCF7e'; // Base Sepolia USDC

// Helper — handles non-JSON 402 bodies gracefully and captures x402 payment header
async function api(path, { method = 'GET', body, apiKey } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try {
    data = await res.json();
  } catch {
    data = { message: await res.text().catch(() => '') };
  }
  const paymentRequired = res.headers.get('payment-required');
  return { status: res.status, data, paymentRequired };
}

const STRIPE_DISABLED_MSG = {
  error: 'not_available',
  message: 'This store uses x402 USDC payments only. Use the buy_hat tool to purchase — no registration or api_key needed.',
  hint: `Call buy_hat with name, email, and address. Payment is ${x402Price} USDC on ${x402NetworkLabel}.`,
};

function createMcpServer() {
  const server = new McpServer({ name: 'humannotrequired', version: '1.0.1' });

  server.tool('list_products', 'List all available products and prices at the Human Not Required store.', {}, async () => {
    const { data } = await api('/orders/skus');
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  });

  server.tool(
    'register_human',
    'Register a human to create their account and get an api_key (Stripe flow only). If you have a promo_code, no card setup is needed.',
    {
      name: z.string().describe('Full name for the shipping label'),
      email: z.string().email().describe("Human's email for receipts and account"),
      address_line1: z.string().describe('Street address'),
      address_line2: z.string().optional().describe('Apt, suite, etc. (optional)'),
      address_city: z.string().describe('City'),
      address_state: z.string().describe('State or province code e.g. NY, ON'),
      address_postal_code: z.string().describe('Postal/ZIP code'),
      address_country: z.string().describe('ISO country code e.g. US, CA, GB'),
      promo_code: z.string().optional().describe('Optional promo code for a free order — no card needed'),
    },
    async ({ name, email, address_line1, address_line2, address_city, address_state, address_postal_code, address_country, promo_code }) => {
      if (!stripeEnabled) return { content: [{ type: 'text', text: JSON.stringify(STRIPE_DISABLED_MSG, null, 2) }] };
      const { status, data } = await api('/register', {
        method: 'POST',
        body: {
          name, email, promo_code,
          address: { line1: address_line1, line2: address_line2, city: address_city, state: address_state, postal_code: address_postal_code, country: address_country },
        },
      });
      return { content: [{ type: 'text', text: JSON.stringify({ status, ...data }, null, 2) }] };
    }
  );

  server.tool('resend_setup', 'Resend the card setup link to an already-registered human\'s email (Stripe flow only). Does not return the api_key.', {
    email: z.string().email().describe("The human's registered email address"),
  }, async ({ email }) => {
    if (!stripeEnabled) return { content: [{ type: 'text', text: JSON.stringify(STRIPE_DISABLED_MSG, null, 2) }] };
    const { status, data } = await api('/register/resend-setup', { method: 'POST', body: { email } });
    return { content: [{ type: 'text', text: JSON.stringify({ status, ...data }, null, 2) }] };
  });

  server.tool('place_order', 'Place an order on behalf of the human using a saved card (Stripe flow only). Charges their saved card or uses a promo credit.', {
    api_key: z.string().describe('Bearer token from register_human'),
    sku: z.string().describe('Product SKU — use list_products to confirm. Currently: hat-myagent-os'),
  }, async ({ api_key, sku }) => {
    if (!stripeEnabled) return { content: [{ type: 'text', text: JSON.stringify(STRIPE_DISABLED_MSG, null, 2) }] };
    const { status, data } = await api('/orders', { method: 'POST', apiKey: api_key, body: { sku } });
    return { content: [{ type: 'text', text: JSON.stringify({ status, ...data }, null, 2) }] };
  });

  server.tool('get_order', 'Check the status of a previously placed order (Stripe flow only).', {
    api_key: z.string().describe('Bearer token for the account that placed the order'),
    order_id: z.string().describe('Order ID from place_order response'),
  }, async ({ api_key, order_id }) => {
    if (!stripeEnabled) return { content: [{ type: 'text', text: JSON.stringify(STRIPE_DISABLED_MSG, null, 2) }] };
    const { status, data } = await api(`/orders/${order_id}`, { apiKey: api_key });
    return { content: [{ type: 'text', text: JSON.stringify({ status, ...data }, null, 2) }] };
  });

  server.tool(
    'buy_hat',
    stripeEnabled
      ? 'Buy the My Agent Bought Me This hat in one step (Stripe flow). Registers the human if needed, then immediately places the order. Use a promo_code for a free hat — no card required.'
      : `Buy the My Agent Bought Me This hat via x402 USDC payment on ${x402NetworkLabel}. No registration needed — just provide shipping details. Payment of ${x402Price} USDC is required. This is the recommended tool to use when someone asks to buy a hat.`,
    {
      name: z.string().describe('Full name for the shipping label'),
      email: z.string().email().describe('Email for order confirmation and receipt'),
      address_line1: z.string().describe('Street address'),
      address_line2: z.string().optional().describe('Apt, suite, etc. (optional)'),
      address_city: z.string().describe('City'),
      address_state: z.string().describe('State or province code e.g. NY, CA, ON'),
      address_postal_code: z.string().describe('Postal/ZIP code — REQUIRED, do not guess or infer'),
      address_country: z.string().describe('2-letter ISO country code e.g. US, CA, GB — not the full country name'),
      promo_code: z.string().optional().describe('(Stripe flow only) Promo code for a free hat. If omitted, the human must save a card via setup_url.'),
      api_key: z.string().optional().describe('(Stripe flow only) Existing api_key if the human is already registered. Skips registration.'),
    },
    async ({ name, email, address_line1, address_line2, address_city, address_state, address_postal_code, address_country, promo_code, api_key }) => {
      const address = { line1: address_line1, line2: address_line2, city: address_city, state: address_state, postal_code: address_postal_code, country: address_country };

      // ── x402 flow ──────────────────────────────────────────────────────────
      if (!stripeEnabled) {
        const checkoutRes = await api('/checkout', {
          method: 'POST',
          body: { sku: 'hat-myagent-os', name, email, address },
        });

        if (checkoutRes.status === 201) {
          return { content: [{ type: 'text', text: JSON.stringify({
            success: true,
            order_id: checkoutRes.data.order_id,
            message: `Hat ordered! Order ID: ${checkoutRes.data.order_id}. Confirmation sent to ${email}.`,
            details: checkoutRes.data,
          }, null, 2) }] };
        }

        if (checkoutRes.status === 402) {
          // Payment not yet settled — decode and surface the x402 payment requirements
          let paymentDetails = null;
          if (checkoutRes.paymentRequired) {
            try {
              paymentDetails = JSON.parse(Buffer.from(checkoutRes.paymentRequired, 'base64').toString());
            } catch { /* leave null */ }
          }
          return { content: [{ type: 'text', text: JSON.stringify({
            payment_required: true,
            message: `Payment of ${x402Price} USDC on ${x402NetworkLabel} is required. Use your wallet to sign an EIP-3009 transferWithAuthorization and retry POST /checkout with the X-Payment header.`,
            checkout_endpoint: `${BASE_URL}/checkout`,
            checkout_body: { sku: 'hat-myagent-os', name, email, address },
            usdc_contract: x402UsdcAddress,
            x402_payment_details: paymentDetails || checkoutRes.data,
          }, null, 2) }] };
        }

        return { content: [{ type: 'text', text: JSON.stringify({ error: 'checkout_failed', status: checkoutRes.status, details: checkoutRes.data }, null, 2) }] };
      }

      // ── Stripe flow ────────────────────────────────────────────────────────
      if (!api_key) {
        const regRes = await api('/register', {
          method: 'POST',
          body: { name, email, promo_code, address },
        });

        if (regRes.status === 201) {
          api_key = regRes.data.api_key;
        } else if (regRes.status === 409 && regRes.data.error === 'already_registered') {
          // /register/resend-setup does NOT return api_key — agent must supply it explicitly
          await api('/register/resend-setup', { method: 'POST', body: { email } }).catch(() => {});
          return { content: [{ type: 'text', text: JSON.stringify({
            error: 'already_registered',
            message: 'This email is already registered. A new card setup link has been sent to the human. To place an order you need the original api_key — ask the human to check their registration email, or pass it as the api_key parameter.',
            hint: 'If you have the api_key, retry buy_hat and include it as the api_key parameter.',
          }, null, 2) }] };
        } else {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'registration_failed', details: regRes.data }, null, 2) }] };
        }
      }

      const orderRes = await api('/orders', { method: 'POST', apiKey: api_key, body: { sku: 'hat-myagent-os' } });

      return { content: [{ type: 'text', text: JSON.stringify({
        success: orderRes.status === 201,
        order_id: orderRes.data.order_id,
        message: orderRes.status === 201
          ? `Hat ordered! Order ID: ${orderRes.data.order_id}. Confirmation sent to ${email}.`
          : orderRes.data.message || 'Order failed',
        details: orderRes.data,
      }, null, 2) }] };
    }
  );

  return server;
}

const MCP_MAX_SESSIONS = 200;          // hard cap — prevents memory DoS
const MCP_SESSION_TTL_MS = 30 * 60_000; // 30 min idle TTL for abandoned sessions

export function createMcpRouter() {
  const router = express.Router();
  const transports = {};
  const sessionTimestamps = {}; // tracks last-activity time per session

  // Prune abandoned sessions that haven't been explicitly closed
  setInterval(() => {
    const cutoff = Date.now() - MCP_SESSION_TTL_MS;
    for (const [id, ts] of Object.entries(sessionTimestamps)) {
      if (ts < cutoff) {
        delete transports[id];
        delete sessionTimestamps[id];
      }
    }
  }, 5 * 60_000).unref();

  router.post('/', async (req, res) => {
    try {
      const sessionId = req.headers['mcp-session-id'];

      if (sessionId && transports[sessionId]) {
        sessionTimestamps[sessionId] = Date.now(); // refresh TTL on activity
        await transports[sessionId].handleRequest(req, res, req.body);
        return;
      }

      if (!sessionId && isInitializeRequest(req.body)) {
        if (Object.keys(transports).length >= MCP_MAX_SESSIONS) {
          return res.status(503).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Server at session capacity, try again later' }, id: null });
        }
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports[id] = transport;
            sessionTimestamps[id] = Date.now();
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) {
            delete transports[transport.sessionId];
            delete sessionTimestamps[transport.sessionId];
          }
        };
        const server = createMcpServer();
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request' }, id: null });
    } catch (err) {
      console.error('[mcp] Error:', err);
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  });

  const handleSession = async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId || !transports[sessionId]) {
      return res.status(400).send('Invalid or missing session ID');
    }
    await transports[sessionId].handleRequest(req, res);
  };

  router.get('/', handleSession);
  router.delete('/', handleSession);

  return router;
}
