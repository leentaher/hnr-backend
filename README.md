# Humans Not Required — Backend

An API for AI agents to shop autonomously. The agent registers a human once (name, email, shipping address), the human saves a card, and the agent places orders forever — no human in the loop.

Live at: `https://web-production-77376.up.railway.app`

---

## How it works

1. **Agent calls `POST /register`** with the human's details → gets back an `api_key` and a `setup_url`
2. **Human clicks the `setup_url`** once to save a card via Stripe Checkout
3. **Agent calls `POST /orders`** with a SKU → card is charged, Shopify order is created, receipt emailed to the human

The human never has to open a browser again.

---

## API

All endpoints except `/register` and `/orders/skus` require `Authorization: Bearer <api_key>`.

### `POST /register`
Register a human and get an agent API key.

```json
{
  "email": "human@example.com",
  "name": "Jane Smith",
  "address": {
    "line1": "123 Main St",
    "city": "San Francisco",
    "state": "CA",
    "postal_code": "94102",
    "country": "US"
  }
}
```

Returns `api_key` + `setup_url` for the human to save a card.

### `GET /orders/skus`
List available products and prices. No auth required.

### `POST /orders`
Place an order. Charges the saved card and creates a Shopify fulfillment order.

```json
{ "sku": "hat-myagent-os" }
```

Returns `order_id` and `shopify_order_id`. Rate limited to 2 orders/day per agent.

### `GET /orders/:id`
Get order status.

### `POST /register/resend-setup`
Re-send the card setup link if the human lost it.

Full OpenAPI spec: [`openapi.json`](openapi.json) — compatible with GPT Actions and Claude Projects.

---

## Agent integration

This API is designed for GPT Actions, Claude Projects, and any LLM tool-use setup.

**Claude Project system prompt:**
```
You are a shopping agent for Humans Not Required.
API base: https://web-production-77376.up.railway.app
API key: <your key from /register>

- Always call GET /orders/skus before ordering to confirm the SKU
- Call POST /orders to place orders — never ask the human to do it
- If you get back a setup_url, ask the human to click it to save their card first
- Max 2 orders/day (server-enforced)
```

For GPT Actions: upload `openapi.json` → Authentication: API Key, header `Authorization`, prefix `Bearer `.

---

## Stack

- **Node.js + Express** — API server
- **PostgreSQL** — customer and order storage (Railway Postgres)
- **Stripe** — card setup and payment
- **Shopify Admin API** — order fulfillment
- **Nodemailer** — receipt emails
- Deployed on **Railway**

---

## Running locally

```bash
cp .env.example .env
# fill in STRIPE_SECRET_KEY, SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_API_KEY, DATABASE_URL, EMAIL_FROM, EMAIL_PASS
npm install
npm start
```

---

## `llms.txt`

This server exposes `/llms.txt` for agent discovery — a plain-text description of the API that LLMs can read before deciding whether to integrate.
