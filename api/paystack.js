// POST /api/paystack — Paystack webhook. In the Paystack dashboard set the webhook URL to https://YOUR-SITE/api/paystack
// Vercel env: PAYSTACK_SECRET_KEY (same DB_* vars as chat.js). Activates / extends Premium after a successful payment.
const crypto = require('crypto');
const mysql = require('mysql2/promise');
let pool;
function db() { if (!pool) pool = mysql.createPool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 4000), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true }, connectionLimit: 1 }); return pool; }
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
  const sig = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY || '').update(raw).digest('hex');
  if (!process.env.PAYSTACK_SECRET_KEY || sig !== req.headers['x-paystack-signature']) return res.status(401).end();
  const ev = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  if (ev.event === 'charge.success' && ev.data && ev.data.metadata) {
    const phone = String(ev.data.metadata.phone || ''), span = { monthly: '1 MONTH', six: '6 MONTH', annual: '1 YEAR' }[ev.data.metadata.plan];
    if (phone && span) await db().query('INSERT INTO premium (phone, plan, until_at, renew) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ' + span + '), 1) ON DUPLICATE KEY UPDATE plan = VALUES(plan), until_at = DATE_ADD(GREATEST(until_at, NOW()), INTERVAL ' + span + '), renew = 1', [phone, ev.data.metadata.plan]);
  }
  return res.status(200).json({ ok: true });
};
