// In-memory store — resets on restart (swap for Postgres in v2)
const customers = new Map(); // apiKey → { stripeCustomerId, email, address, ordersToday, lastOrderDate }
const orders = new Map();    // orderId → { apiKey, sku, stripePaymentIntentId, shopifyOrderId, status, createdAt }

module.exports = { customers, orders };
