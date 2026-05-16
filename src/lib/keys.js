const crypto = require('crypto');

function generateApiKey() {
  return 'sk_agent_' + crypto.randomBytes(16).toString('hex');
}

function generateOrderId() {
  return 'ord_' + crypto.randomBytes(8).toString('hex');
}

module.exports = { generateApiKey, generateOrderId };
