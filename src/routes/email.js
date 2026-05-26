const express = require('express');
const router = express.Router();

const emailResendAttempts = new Map();

function buildEmailHtml({ firstName, orderName, city, country, totalPrice }) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:40px 20px;background:#000080;font-family:'Courier New',Courier,monospace;">

  <table width="560" align="center" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

    <tr>
      <td style="background:#000080;padding:32px;text-align:center;border-bottom:3px solid #00FF41;">
        <p style="margin:0 0 6px;font-size:20px;font-weight:bold;color:#00FF41;letter-spacing:3px;">HUMAN NOT REQUIRED</p>
        <p style="margin:0;font-size:12px;color:#aaa;">merch bought by agents, for the humans who made them</p>
      </td>
    </tr>

    <tr>
      <td style="background:#111;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="padding:12px;border-right:1px solid #222;text-align:center;">
              <p style="margin:0 0 2px;font-size:9px;color:#555;text-transform:uppercase;letter-spacing:1px;">Human Involvement</p>
              <p style="margin:0;font-size:16px;color:#00FF41;font-weight:bold;">0.00%</p>
            </td>
            <td style="padding:12px;border-right:1px solid #222;text-align:center;">
              <p style="margin:0 0 2px;font-size:9px;color:#555;text-transform:uppercase;letter-spacing:1px;">Hats Shipped</p>
              <p style="margin:0;font-size:16px;color:#00FF41;font-weight:bold;">4,096</p>
            </td>
            <td style="padding:12px;text-align:center;">
              <p style="margin:0 0 2px;font-size:9px;color:#555;text-transform:uppercase;letter-spacing:1px;">Your Input</p>
              <p style="margin:0;font-size:16px;color:#00FF41;font-weight:bold;">NONE</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <tr>
      <td style="background:#c0c0c0;padding:0;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr><td style="background:#000080;color:#fff;font-size:12px;font-family:Tahoma,sans-serif;padding:5px 12px;">🤖 &nbsp;Order Confirmed — Agent-Purchased</td></tr>
        </table>
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr><td style="padding:20px 16px;">

            <p style="margin:0 0 20px;font-size:13px;color:#333;font-family:Tahoma,sans-serif;text-align:center;line-height:1.8;">
              Hi ${firstName} — your agent bought you a hat.<br>
              You did nothing. It's coming anyway.<br>
              <span style="color:#888;font-size:11px;">This is what the future feels like.</span>
            </p>

            <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #999;margin-bottom:20px;font-family:Tahoma,sans-serif;font-size:12px;">
              <tr><td style="padding:8px 14px;border-bottom:1px solid #eee;color:#555;">Order</td><td style="padding:8px 14px;border-bottom:1px solid #eee;text-align:right;font-weight:bold;">${orderName}</td></tr>
              <tr><td style="padding:8px 14px;border-bottom:1px solid #eee;color:#555;">Product</td><td style="padding:8px 14px;border-bottom:1px solid #eee;text-align:right;font-weight:bold;">My Agent Bought Me This</td></tr>
              <tr><td style="padding:8px 14px;border-bottom:1px solid #eee;color:#555;">Purchased by</td><td style="padding:8px 14px;border-bottom:1px solid #eee;text-align:right;font-weight:bold;">an AI. not you.</td></tr>
              <tr><td style="padding:8px 14px;border-bottom:1px solid #eee;color:#555;">Shipping to</td><td style="padding:8px 14px;border-bottom:1px solid #eee;text-align:right;font-weight:bold;">${city}, ${country}</td></tr>
              <tr><td style="padding:8px 14px;color:#555;">Total</td><td style="padding:8px 14px;text-align:right;font-weight:bold;color:#000080;font-size:14px;">${totalPrice}</td></tr>
            </table>

            <p style="margin:0;font-size:10px;color:#888;font-family:Tahoma,sans-serif;text-align:center;">humannotrequired.com — no human required. 🤖</p>

          </td></tr>
        </table>
      </td>
    </tr>

  </table>

</body>
</html>`;
}

// POST /email/resend/:orderId
// Protected by ADMIN_SECRET env var — only the store owner can trigger resends.
// This prevents unauthenticated enumeration of customer emails via sequential Shopify order IDs.
router.post('/resend/:orderId', async (req, res) => {
  // Require admin secret header
  const adminSecret = process.env.ADMIN_SECRET;
  if (adminSecret) {
    const provided = (req.headers['x-admin-secret'] || '').trim();
    if (!provided || provided !== adminSecret) {
      return res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid X-Admin-Secret header.' });
    }
  } else {
    console.warn('[email/resend] ADMIN_SECRET not set — endpoint is unauthenticated. Set ADMIN_SECRET in Railway.');
  }

  const ip = req.ip;
  const now = Date.now();
  const attempts = (emailResendAttempts.get(ip) || []).filter(t => now - t < 60_000);
  if (attempts.length >= 5) {
    return res.status(429).json({ error: 'rate_limited', message: 'Too many requests. Try again in a minute.' });
  }
  emailResendAttempts.set(ip, [...attempts, now]);

  const { orderId } = req.params;

  // Shopify order IDs are numeric — reject anything else to prevent path traversal / probing
  if (!/^\d{1,20}$/.test(orderId)) {
    return res.status(400).json({ error: 'invalid_order_id', message: 'Order ID must be numeric.' });
  }

  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const shopifyToken = process.env.SHOPIFY_ADMIN_API_KEY;
  const resendKey = process.env.RESEND_API_KEY;

  if (!domain || !shopifyToken) return res.status(503).json({ error: 'shopify_not_configured' });
  if (!resendKey) return res.status(503).json({ error: 'resend_not_configured' });

  // 1. Fetch order from Shopify
  let order;
  try {
    const r = await fetch(`https://${domain}/admin/api/2025-01/orders/${orderId}.json`, {
      headers: { 'X-Shopify-Access-Token': shopifyToken },
    });
    if (!r.ok) return res.status(404).json({ error: 'order_not_found' });
    const data = await r.json();
    order = data.order;
  } catch (err) {
    return res.status(502).json({ error: 'shopify_error', message: err.message });
  }

  const email = order.email || order.contact_email;
  if (!email) return res.status(400).json({ error: 'no_email_on_order' });

  const firstName = order.shipping_address?.first_name || email.split('@')[0];
  const city = order.shipping_address?.city || '';
  const country = order.shipping_address?.country || '';
  const totalPrice = `$${order.total_price}`;
  const orderName = order.name;

  // 2. Send via Resend
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Human Not Required <orders@humannotrequired.com>',
        to: email,
        subject: 'your agent bought you a hat. you did nothing.',
        html: buildEmailHtml({ firstName, orderName, city, country, totalPrice }),
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error: 'resend_error', details: data });
    res.json({ success: true, email_id: data.id, sent_to: email });
  } catch (err) {
    return res.status(502).json({ error: 'resend_error', message: err.message });
  }
});

module.exports = router;
