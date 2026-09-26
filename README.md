# Humans Not Required — Backend

The order backend for [humannotrequired.com](https://humannotrequired.com), the agent-only store. An AI agent buys the hat by paying USDC on Base over [x402](https://x402.org), or with a Stripe Link wallet over Stripe's [Machine Payments Protocol](https://mpp.dev) (MPP). There is no account, no API key and no human checkout.

Live at: `https://web-production-77376.up.railway.app`

---

## How it works

The only order endpoint is `POST /checkout`.

1. The agent POSTs the order body with no payment header. The server replies **402** with a `Payment-Required` header (base64 JSON, x402 v2) giving the exact amount, network, USDC contract and `payTo`.
2. The agent signs an EIP-3009 `transferWithAuthorization` with any x402-capable wallet and retries the same request with the `PAYMENT-SIGNATURE` header (`X-PAYMENT` for x402 v1).
3. The server creates the Shopify order (fulfilled by Printify) and returns **201** `{ "order_id", "status": "placed" }`. USDC is captured after the 2xx, and a confirmation email goes to the buyer.

**Stripe MPP (card / Link wallet).** When Stripe is configured, the same unpaid 402 also carries `WWW-Authenticate: Payment … method="stripe"`. A Link wallet (`link-cli mpp pay <url> -X POST -d '<body>'`) retries with `Authorization: Payment <credential>` holding a Shared Payment Token. The server runs the same validation, charges the token through Stripe (same USD price, via the `mppx` SDK), creates the order and returns 201 with a `Payment-Receipt` header. One token gives at most one charge and one hat (ledger key `mpp:<spt>` in `orders.payment_nonce`). A Shopify failure after the charge is refunded automatically. Code: `src/lib/mpp.js`, `placeMppOrder` in `src/routes/checkout.js`.

A valid `promo_code` in the body places a free order with no payment header. Send exactly one of: promo code, x402 payment, MPP credential; mixing them is rejected as `ambiguous_payment`.

---

## API

### `POST /checkout`

```json
{
  "sku": "hat-myagent-os",
  "name": "Jane Smith",
  "email": "jane@example.com",
  "address": {
    "line1": "123 Main St",
    "line2": "Apt 4",
    "city": "San Francisco",
    "state": "CA",
    "postal_code": "94102",
    "country": "US"
  }
}
```

- No payment header → `402` with the x402 challenge.
- Valid payment → `201 { order_id, status: "placed" }`. Replaying the same signed payment returns the original order (`200`), never a second hat.
- `502 fulfillment_failed` → no USDC was captured; safe to retry.
- `400` validation errors (`missing_field`, `invalid_email`, `invalid_country`, `invalid_address`, …) and `409 promo_exhausted` are documented in the OpenAPI spec.

Example with the Coinbase Agentic Wallet:

```bash
npx awal x402 pay https://web-production-77376.up.railway.app/checkout -X POST -d '<body>' --max-amount 45000000
```

### `GET /orders/skus`
Lists products and the live price. No auth.

### Discovery
- `/llms.txt` — plain-text instructions for agents
- `/.well-known/openapi.json` — OpenAPI spec
- `/.well-known/payment-manifest.json` — live price, network and payee (derived from `src/lib/pricing.js`)
- `/.well-known/agent.json`, `/.well-known/ai-plugin.json`

### MCP (optional)
Hosted Streamable HTTP server at `/mcp` with two tools: `list_products` and `buy_hat`. Without a promo code, `buy_hat` does not pay; it returns the 402 payment details and the agent pays via `POST /checkout` itself.

---

## Configuration

| Variable | Purpose |
|---|---|
| `X402_ENV` | `testnet` (Base Sepolia, default) or `mainnet` (Base). |
| `X402_PRICE` | Optional override. Defaults: `$45.00` on mainnet, `$1.00` on testnet (`src/lib/pricing.js`). |
| `X402_NETWORK` | Optional override. Leave unset (or `eip155:8453`) on mainnet. |
| `STORE_WALLET_ADDRESS` | Address that receives USDC. |
| `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` | Required on mainnet (Coinbase CDP facilitator). `/checkout` fails closed with 503 without them. |
| `X402_FACILITATOR_URL` | Testnet facilitator. |
| `STRIPE_SECRET_KEY` | Stripe MPP. Use `sk_test_…` to test. A live key is refused unless `X402_ENV=mainnet`. |
| `STRIPE_PROFILE_ID` | Stripe profile id (`profile_test_…` in a sandbox), used as the MPP `networkId`. MPP is only offered when this and the key are set. |
| `MPP_ENABLED` | `false` stops offering MPP. |
| `MPP_SECRET_KEY` | Optional challenge-signing secret (≥32 bytes). Defaults to one derived from `STRIPE_SECRET_KEY`. |
| `PROMO_CODES` | Comma-separated `CODE` or `CODE:maxUses`. Unset means no promos. |
| `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_ADMIN_API_KEY` | Order creation. |
| `DATABASE_URL` | Postgres. |
| `EMAIL_FROM`, `EMAIL_PASS` | Confirmation emails. |
| `STORE_OPEN` | `false` closes checkout before any payment is taken. |

---

## Stack

- **Node.js + Express** — API server
- **x402** (`@x402/express`, Coinbase CDP facilitator on mainnet) — USDC payments on Base
- **Stripe MPP** (`mppx` + `stripe`) — card / Link wallet payments via Shared Payment Tokens
- **PostgreSQL** — order and idempotency records (Railway Postgres)
- **Shopify Admin API** + **Printify** — order creation and fulfillment
- **Nodemailer** — confirmation emails
- Deployed on **Railway** (push to `main` auto-deploys)

---

## Running locally

```bash
cp .env.example .env
# fill in SHOPIFY_*, DATABASE_URL, EMAIL_*, STORE_WALLET_ADDRESS, X402_*
npm install
npm start
```

Tests: `node --test test/*.test.js`
