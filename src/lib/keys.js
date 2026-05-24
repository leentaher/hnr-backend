const crypto = require('crypto');

function generateApiKey() {
  return 'sk_agent_' + crypto.randomBytes(16).toString('hex');
}

function generateOrderId() {
  return 'ord_' + crypto.randomBytes(8).toString('hex');
}

// SHA-256 of the plain key — stored in DB instead of the plain key.
// Keys have 128 bits of entropy so no salt is needed (unlike passwords).
function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

module.exports = { generateApiKey, generateOrderId, hashApiKey };
