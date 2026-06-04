const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.EMAIL_FROM || !process.env.EMAIL_PASS) return null;
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_FROM, pass: process.env.EMAIL_PASS },
  });
  return transporter;
}

// sendOrderConfirmation is used by the x402 checkout flow to alert the store owner
// when a Shopify order creation fails after payment authorization (see checkout.js).
async function sendOrderConfirmation({ to, subject, html }) {
  const t = getTransporter();
  if (!t) {
    console.warn('[email] Skipping alert — EMAIL_FROM/EMAIL_PASS not configured');
    return;
  }
  await t.sendMail({ from: process.env.EMAIL_FROM, to, subject, html });
}

module.exports = { sendOrderConfirmation };
