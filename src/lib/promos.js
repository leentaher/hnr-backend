// Promo codes are stored in the PROMO_CODES env var as a comma-separated list
// e.g. PROMO_CODES=HNR-FREE-A1B2,HNR-FREE-C3D4,...
// Never hardcode codes here — the repo is public.

function getPromoCodes() {
  const raw = process.env.PROMO_CODES || '';
  return raw.split(',').map(c => c.trim().toUpperCase()).filter(Boolean);
}

function isValidPromoCode(code) {
  return getPromoCodes().includes((code || '').toUpperCase().trim());
}

module.exports = { getPromoCodes, isValidPromoCode };
