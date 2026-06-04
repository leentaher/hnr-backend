const express = require('express');
const router = express.Router();
const { listSkus } = require('../lib/products');

// GET /orders/skus — public product catalog. The only order rail is POST /checkout
// (x402 USDC on Base); there is no Stripe POST /orders endpoint in this store.
router.get('/skus', (req, res) => {
  res.json({ skus: listSkus() });
});

module.exports = router;
