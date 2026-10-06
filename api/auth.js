// Vercel serverless function: POST /api/auth
// Actions: send, verify, profile, me, logout  (matches the Zaply app)
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const SECRET = process.env.AUTH_SECRET || 'change-me';
const CODE = process.env.DEMO_CODE || '123456'; // fixed code until an SMS provider is added
const DAYS = 30;
const RESEND_KEY = process.env.RESEND_API_KEY;
const MAIL_FROM = process.env.RESEND_FROM || 'Zaply <onboarding@resend.dev>'; // set RESEND_FROM to an address on your verified domain

let pool;
function db() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 4000),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
      connectionLimit: 1,
      maxIdle: 1,
      idleTimeout: 60000,
      enableKeepAlive: true,
    });
  }
  return pool;
}

let ready;
function ensureTable() {
  if (!ready) {
    const addCol = (sql) => db().query(sql).catch((e) => { if (e.errno !== 1060) throw e; }); // 1060 = column already exists
    ready = db().query(`CREATE TABLE IF NOT EXISTS users (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      phone VARCHAR(20) NOT NULL UNIQUE,
      name VARCHAR(80) NOT NULL DEFAULT '',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_login TIMESTAMP NULL)`)
      .then(() => addCol('ALTER TABLE users ADD COLUMN email VARCHAR(190) NULL'))
      .then(() => addCol('ALTER TABLE users ADD COLUMN email_verified TINYINT(1) NOT NULL DEFAULT 0'))
      .then(() => db().query(`CREATE TABLE IF NOT EXISTS email_codes (
        phone VARCHAR(20) NOT NULL PRIMARY KEY,
        email VARCHAR(190) NOT NULL,
        code_hash CHAR(64) NOT NULL,
        attempts TINYINT NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL,
        expires_at DATETIME NOT NULL)`))
      .catch((e) => { ready = null; throw e; });
  }
  return ready;
}

const USER_COLS = 'phone, name, email, email_verified';
const hashCode = (c) => crypto.createHash('sha256').update(String(c) + SECRET).digest('hex');
const emailOk = (e) => typeof e === 'string' && e.length <= 190 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

async function sendCodeEmail(to, code) {
  if (!RESEND_KEY) throw Object.assign(new Error('Email is not set up yet.'), { status: 500 });
  const html = '<div style="font-family:Arial,sans-serif;max-width:420px;margin:auto;padding:24px">' +
    '<h2 style="margin:0 0 12px;color:#111">Your Zaply verification code</h2>' +
    '<p style="color:#444;margin:0 0 18px">Enter this code in Zaply to confirm your email. It expires in 10 minutes.</p>' +
    '<div style="font-size:34px;font-weight:700;letter-spacing:8px;color:#0e8f47;margin:0 0 18px">' + code + '</div>' +
    '<p style="color:#888;font-size:13px;margin:0">If you did not ask for this, you can ignore this email.</p></div>';
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: MAIL_FROM, to: [to], subject: 'Your Zaply verification code ' + code,
      html, text: 'Your Zaply verification code is ' + code + '. It expires in 10 minutes.',
    }),
  });
  if (!r.ok) {
    console.error('Resend error', r.status, await r.text());
    throw Object.assign(new Error('We could not send the email. Check the address and try again.'), { status: 502 });
  }
}

const b64 = (b) => Buffer.from(b).toString('base64url');
function sign(phone) {
  const body = b64(JSON.stringify({ p: phone, e: Date.now() + DAYS * 864e5 }));
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}
function readToken(t) {
  if (!t || typeof t !== 'string' || t.indexOf('.') < 0) return null;
  const [body, sig] = t.split('.');
  const good = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try {
    const d = JSON.parse(Buffer.from(body, 'base64url').toString());
    return d.e > Date.now() ? d.p : null;
  } catch (e) { return null; }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    await ensureTable();
    const b = req.body || {};
    const phoneOk = (p) => typeof p === 'string' && /^\+\d{7,15}$/.test(p);

    if (b.action === 'send') {
      if (!phoneOk(b.phone)) return res.status(400).json({ error: 'Enter a valid phone number.' });
      return res.json({ ok: true }); // real SMS goes here later
    }

    if (b.action === 'verify') {
      if (!phoneOk(b.phone)) return res.status(400).json({ error: 'Enter a valid phone number.' });
      if (String(b.code) !== CODE) return res.status(400).json({ error: 'Wrong code. Please try again.' });
      await db().query(
        'INSERT INTO users (phone, last_login) VALUES (?, NOW()) ON DUPLICATE KEY UPDATE last_login = NOW()',
        [b.phone]
      );
      const [rows] = await db().query('SELECT ' + USER_COLS + ' FROM users WHERE phone = ?', [b.phone]);
      return res.json({ token: sign(b.phone), user: rows[0] });
    }

    const phone = readToken(b.token);
    if (!phone) return res.status(401).json({ error: 'Session expired. Please sign in again.' });

    if (b.action === 'me') {
      const [rows] = await db().query('SELECT ' + USER_COLS + ' FROM users WHERE phone = ?', [phone]);
      if (!rows[0]) return res.status(401).json({ error: 'Account not found.' });
      return res.json({ user: rows[0] });
    }

    if (b.action === 'email_send') {
      const email = String(b.email || '').trim().toLowerCase();
      if (!emailOk(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
      const [prev] = await db().query('SELECT TIMESTAMPDIFF(SECOND, created_at, NOW()) AS age FROM email_codes WHERE phone = ?', [phone]);
      if (prev[0] && prev[0].age < 30) return res.status(429).json({ error: 'Please wait a little before asking for another code.' });
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      await db().query(
        `INSERT INTO email_codes (phone, email, code_hash, attempts, created_at, expires_at)
         VALUES (?, ?, ?, 0, NOW(), DATE_ADD(NOW(), INTERVAL 10 MINUTE))
         ON DUPLICATE KEY UPDATE email = VALUES(email), code_hash = VALUES(code_hash), attempts = 0, created_at = NOW(), expires_at = DATE_ADD(NOW(), INTERVAL 10 MINUTE)`,
        [phone, email, hashCode(code)]
      );
      await sendCodeEmail(email, code);
      return res.json({ ok: true });
    }

    if (b.action === 'email_verify') {
      const [rows] = await db().query('SELECT email, code_hash, attempts, (expires_at > NOW()) AS valid FROM email_codes WHERE phone = ?', [phone]);
      const row = rows[0];
      if (!row || !row.valid) return res.status(400).json({ error: 'That code has expired. Request a new one.' });
      if (row.attempts >= 5) return res.status(429).json({ error: 'Too many tries. Request a new code.' });
      if (hashCode(b.code) !== row.code_hash) {
        await db().query('UPDATE email_codes SET attempts = attempts + 1 WHERE phone = ?', [phone]);
        return res.status(400).json({ error: 'Wrong code. Please try again.' });
      }
      await db().query('UPDATE users SET email = ?, email_verified = 1 WHERE phone = ?', [row.email, phone]);
      await db().query('DELETE FROM email_codes WHERE phone = ?', [phone]);
      const [u] = await db().query('SELECT ' + USER_COLS + ' FROM users WHERE phone = ?', [phone]);
      return res.json({ user: u[0] });
    }

    if (b.action === 'profile') {
      const name = String(b.name || '').trim().slice(0, 80);
      if (!name) return res.status(400).json({ error: 'Please enter your name.' });
      await db().query('UPDATE users SET name = ? WHERE phone = ?', [name, phone]);
      return res.json({ user: { phone, name } });
    }

    if (b.action === 'logout') return res.json({ ok: true });

    return res.status(400).json({ error: 'Unknown action.' });
  } catch (e) {
    console.error(e);
    if (e.status) return res.status(e.status).json({ error: e.message });
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
};
