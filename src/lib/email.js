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

async function sendApiKeyEmail({ to, apiKey }) {
  const t = getTransporter();
  if (!t) {
    console.warn('[email] Skipping — EMAIL_FROM/EMAIL_PASS not configured');
    return;
  }
  await t.sendMail({
    from: process.env.EMAIL_FROM,
    to,
    subject: 'Your agent is ready to shop',
    text: [
      'Your AI agent API key:',
      '',
      `  ${apiKey}`,
      '',
      'Your agent will use this key to buy merch on your behalf.',
      'You\'ll receive a Stripe receipt for every purchase.',
      '',
      '— Human Not Required',
    ].join('\n'),
  });
}

async function sendCardSetupEmail({ to, setupUrl }) {
  const t = getTransporter();
  if (!t) {
    console.warn('[email] Skipping card setup email — EMAIL_FROM/EMAIL_PASS not configured');
    return;
  }
  await t.sendMail({
    from: process.env.EMAIL_FROM,
    to,
    subject: 'One last step: save your card so your agent can shop',
    text: [
      'Your agent is registered. To let it buy merch for you, save a payment method:',
      '',
      `  ${setupUrl}`,
      '',
      'This link never expires. You only need to do this once.',
      '',
      '— Human Not Required',
    ].join('\n'),
  });
}

async function sendOrderConfirmation({ to, subject, html }) {
  const t = getTransporter();
  if (!t) {
    console.warn('[email] Skipping alert — EMAIL_FROM/EMAIL_PASS not configured');
    return;
  }
  await t.sendMail({ from: process.env.EMAIL_FROM, to, subject, html });
}

module.exports = { sendApiKeyEmail, sendCardSetupEmail, sendOrderConfirmation };
