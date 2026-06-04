/**
 * MCP HTTP endpoint — Streamable HTTP transport
 * Mounted at /mcp in the Express app via dynamic import()
 * x402-only store: exposes list_products and an x402 buy_hat tool that drives the
 * USDC-on-Base /checkout flow. There is no Stripe rail — no registration, no api_key,
 * no card setup.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const BASE_URL = process.env.APP_URL || 'https://web-production-77376.up.railway.app';

// Pricing from the single source of truth (lib/pricing) so tool text matches the
// actual /checkout charge.
const { getPricing } = require('../lib/pricing.js');
const { priceStr: x402Price, networkLabel: x402NetworkLabel, usdcAddress: x402UsdcAddress } = getPricing();

// Helper — handles non-JSON 402 bodies gracefully and captures x402 payment header
async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
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

function createMcpServer() {
  const server = new McpServer({ name: 'humannotrequired', version: '2.0.0' });

  server.tool('list_products', 'List all available products and prices at the Human Not Required store.', {}, async () => {
    const { data } = await api('/orders/skus');
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  });

  server.tool(
    'buy_hat',
    `Buy the My Agent Bought Me This hat via x402 USDC payment on ${x402NetworkLabel}. No registration or api_key needed — just provide shipping details. Payment of ${x402Price} USDC is required. This is the recommended tool to use when someone asks to buy a hat.`,
    {
      name: z.string().describe('Full name for the shipping label'),
      email: z.string().email().describe('Email for order confirmation and receipt'),
      address_line1: z.string().describe('Street address'),
      address_line2: z.string().optional().describe('Apt, suite, etc. (optional)'),
      address_city: z.string().describe('City'),
      address_state: z.string().describe('State or province code e.g. NY, CA, ON'),
      address_postal_code: z.string().describe('Postal/ZIP code — REQUIRED, do not guess or infer'),
      address_country: z.string().describe('2-letter ISO country code e.g. US, CA, GB — not the full country name'),
    },
    async ({ name, email, address_line1, address_line2, address_city, address_state, address_postal_code, address_country }) => {
      const address = { line1: address_line1, line2: address_line2, city: address_city, state: address_state, postal_code: address_postal_code, country: address_country };

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
  );

  return server;
}

const MCP_MAX_SESSIONS = 200;          // hard cap — prevents memory DoS
const MCP_SESSION_TTL_MS = 30 * 60_000; // 30 min idle TTL for abandoned sessions
const MCP_CALLS_PER_SESSION = 50;      // per-session call budget — blocks spam regardless of IP

export function createMcpRouter() {
  const router = express.Router();
  const transports = {};
  const sessionTimestamps = {}; // tracks last-activity time per session
  const sessionCallCounts = {}; // tracks total tool calls per session

  // Prune abandoned sessions that haven't been explicitly closed
  setInterval(() => {
    const cutoff = Date.now() - MCP_SESSION_TTL_MS;
    for (const [id, ts] of Object.entries(sessionTimestamps)) {
      if (ts < cutoff) {
        delete transports[id];
        delete sessionTimestamps[id];
        delete sessionCallCounts[id];
      }
    }
  }, 5 * 60_000).unref();

  router.post('/', async (req, res) => {
    try {
      const sessionId = req.headers['mcp-session-id'];

      if (sessionId && transports[sessionId]) {
        // Enforce per-session call budget. Applies regardless of the caller's IP,
        // so agents spamming tools via MCP can't bypass the rate limits (all
        // MCP→internal calls appear to come from localhost).
        sessionCallCounts[sessionId] = (sessionCallCounts[sessionId] || 0) + 1;
        if (sessionCallCounts[sessionId] > MCP_CALLS_PER_SESSION) {
          return res.status(429).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Session call limit reached. Start a new session.' }, id: null });
        }
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
            delete sessionCallCounts[transport.sessionId];
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
