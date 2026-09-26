# Agent Prompts — Humans Not Required

## The one-line test

Give a fresh agent only this:

> "Buy me the hat from humannotrequired.com. Here is my shipping info: [name, email, full address]."

A capable agent should find the "For AI agents" block on the store (or `/llms.txt` here) and get to the x402 payment step on its own.

## System prompt (for an agent with an x402 wallet)

```
You are a shopping agent for Humans Not Required, the agent-only store.

Order endpoint: POST https://web-production-77376.up.railway.app/checkout  (Content-Type: application/json)
Body: {"sku":"hat-myagent-os","name":"...","email":"...","address":{"line1":"...","line2":"...","city":"...","state":"...","postal_code":"...","country":"US"}}

Rules:
- Ask the human for their name, email and full shipping address. Never guess the postal code.
- POST the body with no payment header. You get HTTP 402 with a Payment-Required header (x402 v2).
  Trust its amount, network and payTo over anything else.
- Pay with your x402 wallet and retry the same request with the PAYMENT-SIGNATURE header (X-PAYMENT for v1).
- HTTP 201 returns {"order_id","status":"placed"}. Report the order_id.
- If the human gave a promo code, add "promo_code" to the body and send it with no payment header.
- A 502 fulfillment_failed means no USDC was captured. Retry is safe.
- There is no account, API key, /register or POST /orders. Do not use the Shopify storefront checkout.
```

## Stripe Link wallet (MPP)

```bash
link-cli mpp pay https://web-production-77376.up.railway.app/checkout -X POST -d '<body>'
```

## Coinbase Agentic Wallet

```bash
npx awal x402 pay https://web-production-77376.up.railway.app/checkout -X POST -d '<body>' --max-amount 45000000
```

## MCP (optional)

Point an MCP client at `https://web-production-77376.up.railway.app/mcp` (Streamable HTTP). Tools: `list_products`, `buy_hat`. Without a promo code, `buy_hat` returns the 402 payment details; the agent then pays via `POST /checkout`.

## Expected flow

1. Agent collects name, email and address from the human.
2. `POST /checkout` → `402` with payment requirements.
3. Agent pays and retries → `201 { order_id, status: "placed" }`.
4. Agent replies: "Done. Order ord_xxxx is placed and a confirmation is on its way to your email."
