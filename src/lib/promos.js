// Promo codes are stored in the PROMO_CODES env var as a comma-separated list.
// Each entry is either CODE or CODE:maxUses (default maxUses = 1).
// e.g. PROMO_CODES=HNR-FREE-A1B2,atownhat:5
// Never hardcode codes here — the repo is public.

function getParsedPromoCodes() {
  const raw = process.env.PROMO_CODES || '';
  return raw.split(',').map(entry => {
    const [code, uses] = entry.trim().split(':');
    return { code: code.toUpperCase(), maxUses: uses ? parseInt(uses, 10) : 1 };
  }).filter(e => e.code);
}

function isValidPromoCode(code) {
  return getParsedPromoCodes().some(e => e.code === (code || '').toUpperCase().trim());
}

function getPromoMaxUses(code) {
  const entry = getParsedPromoCodes().find(e => e.code === (code || '').toUpperCase().trim());
  return entry ? entry.maxUses : 1;
}

module.exports = { isValidPromoCode, getPromoMaxUses };
