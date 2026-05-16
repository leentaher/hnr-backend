const { customers } = require('../lib/db');

const DAILY_ORDER_LIMIT = 2;

function auth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const apiKey = header.replace(/^Bearer\s+/i, '').trim();

  if (!apiKey) {
    return res.status(401).json({ error: 'missing_api_key', message: 'Authorization: Bearer <key> required' });
  }

  const customer = customers.get(apiKey);
  if (!customer) {
    return res.status(401).json({ error: 'invalid_api_key', message: 'API key not found' });
  }

  // Reset daily counter if it's a new UTC day
  const todayUtc = new Date().toISOString().slice(0, 10);
  if (customer.lastOrderDate !== todayUtc) {
    customer.ordersToday = 0;
    customer.lastOrderDate = todayUtc;
  }

  if (customer.ordersToday >= DAILY_ORDER_LIMIT) {
    return res.status(429).json({
      error: 'daily_limit_exceeded',
      message: `Max ${DAILY_ORDER_LIMIT} orders per day. Resets at midnight UTC.`,
      orders_today: customer.ordersToday,
      limit: DAILY_ORDER_LIMIT,
    });
  }

  req.apiKey = apiKey;
  req.customer = customer;
  next();
}

module.exports = auth;
