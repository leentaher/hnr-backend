/**
 * MCP HTTP endpoint — Streamable HTTP transport
 * Mounted at /mcp in the Express app via dynamic import()
 * Exposes the same 5 tools as the stdio MCP server
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import express from 'express';

const BASE_URL = process.env.APP_URL || 'https://web-production-77376.up.railway.app';

async function api(path, { method = 'GET', body, apiKey } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  return { status: res.status, data };
}

function createMcpServer() {
  const server = new McpServer({ name: 'humannotrequired', version: '1.0.1' });

  server.tool('list_products', 'List all available products and prices at the Human Not Required store.', {}, async () => {
    const { data } = await api('/orders/skus');
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  });

  server.tool(
    'register_human',
    'Register a human to create their account and get an api_key. If you have a promo_code, include it and no card setup is needed.',
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

  server.tool('resend_setup', 'Get the api_key and a fresh card setup link for an already-registered human.', {
    email: z.string().email().describe("The human's registered email address"),
  }, async ({ email }) => {
    const { status, data } = await api('/register/resend-setup', { method: 'POST', body: { email } });
    return { content: [{ type: 'text', text: JSON.stringify({ status, ...data }, null, 2) }] };
  });

  server.tool('place_order', 'Place an order on behalf of the human. Charges their saved card or uses a promo credit.', {
    api_key: z.string().describe('Bearer token from register_human or resend_setup'),
    sku: z.string().describe('Product SKU — use list_products to confirm. Currently: hat-myagent-os'),
  }, async ({ api_key, sku }) => {
    const { status, data } = await api('/orders', { method: 'POST', apiKey: api_key, body: { sku } });
    return { content: [{ type: 'text', text: JSON.stringify({ status, ...data }, null, 2) }] };
  });

  server.tool('get_order', 'Check the status of a previously placed order.', {
    api_key: z.string().describe('Bearer token for the account that placed the order'),
    order_id: z.string().describe('Order ID from place_order response'),
  }, async ({ api_key, order_id }) => {
    const { status, data } = await api(`/orders/${order_id}`, { apiKey: api_key });
    return { content: [{ type: 'text', text: JSON.stringify({ status, ...data }, null, 2) }] };
  });

  return server;
}

export function createMcpRouter() {
  const router = express.Router();
  const transports = {};

  router.post('/', async (req, res) => {
    try {
      const sessionId = req.headers['mcp-session-id'];

      if (sessionId && transports[sessionId]) {
        await transports[sessionId].handleRequest(req, res, req.body);
        return;
      }

      if (!sessionId && isInitializeRequest(req.body)) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => { transports[id] = transport; },
        });
        transport.onclose = () => {
          if (transport.sessionId) delete transports[transport.sessionId];
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
