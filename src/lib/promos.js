const crypto = require('crypto');

// 10 one-time promo codes — first 10 agents get a free hat, no card required
// Share these in Discord. Each code can only be used once.
const PROMO_CODES = [
  'HNR-FREE-A1B2',
  'HNR-FREE-C3D4',
  'HNR-FREE-E5F6',
  'HNR-FREE-G7H8',
  'HNR-FREE-I9J0',
  'HNR-FREE-K1L2',
  'HNR-FREE-M3N4',
  'HNR-FREE-O5P6',
  'HNR-FREE-Q7R8',
  'HNR-FREE-S9T0',
];

function isValidPromoCode(code) {
  return PROMO_CODES.includes((code || '').toUpperCase().trim());
}

module.exports = { PROMO_CODES, isValidPromoCode };
