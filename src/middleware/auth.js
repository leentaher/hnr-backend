const { getCustomerByKey } = require('../lib/db');
const { hashApiKey } = require('../lib/keys');

async function auth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const apiKey = header.replace(/^Bearer\s+/i, '').trim();

  if (!apiKey) {
    return res.status(401).json({ error: 'missing_api_key', message: 'Authorization: Bearer <key> required' });
  }

  let customer;
  try {
    customer = await getCustomerByKey(apiKey);
  } catch (err) {
    console.error('[auth] DB error:', err.message);
    return res.status(503).json({ error: 'service_unavailable', message: 'Database unreachable. Try again shortly.' });
  }

  if (!customer) {
    return res.status(401).json({ error: 'invalid_api_key', message: 'API key not found' });
  }

  req.apiKey = hashApiKey(apiKey); // store hash so order records never reference the plain key
  req.customer = customer;
  next();
}

module.exports = auth;
