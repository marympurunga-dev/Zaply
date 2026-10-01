// Vercel serverless function: POST /api/auth
// Actions: send, verify, profile, me, logout  (matches the Zaply app)
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const SECRET = process.env.AUTH_SECRET || 'change-me';
const CODE = process.env.DEMO_CODE || '123456'; // fixed code until an SMS provider is added
const DAYS = 30;

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
    ready = db().query(`CREATE TABLE IF NOT EXISTS users (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      phone VARCHAR(20) NOT NULL UNIQUE,
      name VARCHAR(80) NOT NULL DEFAULT '',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_login TIMESTAMP NULL)`);
  }
  return ready;
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
      const [rows] = await db().query('SELECT phone, name FROM users WHERE phone = ?', [b.phone]);
      return res.json({ token: sign(b.phone), user: rows[0] });
    }

    const phone = readToken(b.token);
    if (!phone) return res.status(401).json({ error: 'Session expired. Please sign in again.' });

    if (b.action === 'me') {
      const [rows] = await db().query('SELECT phone, name FROM users WHERE phone = ?', [phone]);
      if (!rows[0]) return res.status(401).json({ error: 'Account not found.' });
      return res.json({ user: rows[0] });
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
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
};
