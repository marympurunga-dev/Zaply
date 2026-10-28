// Vercel serverless function: POST /api/auth
// Actions: send, verify, profile, me, logout  (matches the Zaply app)
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const SECRET = process.env.AUTH_SECRET || 'change-me';
const CODE = process.env.DEMO_CODE || ''; // demo sign-in is OFF unless you set DEMO_CODE in Vercel
const DEMO_PHONES = String(process.env.DEMO_PHONES || '').split(',').map((x) => x.trim()).filter(Boolean); // optional: only these numbers (e.g. +254712345678) may use DEMO_CODE
const demoOk = (p) => !!CODE && (!DEMO_PHONES.length || DEMO_PHONES.includes(p));
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || '';
if (SECRET === 'change-me') console.warn('WARNING: set AUTH_SECRET in Vercel, otherwise login tokens can be forged.');

// Ask Google which phone number a Firebase sign-in proof (idToken) belongs to
async function phoneFromFirebase(idToken) {
  if (!FIREBASE_API_KEY || typeof idToken !== 'string') return null;
  const r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + encodeURIComponent(FIREBASE_API_KEY), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken })
  });
  if (!r.ok) return null;
  const j = await r.json();
  return (j.users && j.users[0] && j.users[0].phoneNumber) || null;
}
const DAYS = 30;
const { sendCodeEmail } = require('./_mail');
const { sendCodeSms } = require('./_sms');

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
      .then(() => db().query(`CREATE TABLE IF NOT EXISTS phone_codes (
        phone VARCHAR(20) NOT NULL PRIMARY KEY,
        code_hash CHAR(64) NOT NULL,
        attempts TINYINT NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL,
        expires_at DATETIME NOT NULL)`))
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
async function loadUser(phone) {
  const [rows] = await db().query('SELECT ' + USER_COLS + ' FROM users WHERE phone = ?', [phone]);
  const user = rows[0];
  if (!user) return null;
  if (!user.email_verified) {
    // a code was already sent and has not expired: lets the app return to the code page after being closed
    const [p] = await db().query('SELECT email FROM email_codes WHERE phone = ? AND expires_at > NOW()', [phone]);
    if (p[0]) user.pending_email = p[0].email;
  }
  return user;
}
const hashCode = (c) => crypto.createHash('sha256').update(String(c) + SECRET).digest('hex');
const emailOk = (e) => typeof e === 'string' && e.length <= 190 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

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
  if (req.method === 'GET') { // open /api/auth in a browser to see which version is live and whether the demo code is on (no secrets shown)
    return res.status(200).json({ version: 'auth-demo-2', demoCodeSet: !!CODE, demoPhonesCount: DEMO_PHONES.length, smsProvider: process.env.SMS_PROVIDER || 'africastalking', firebaseKeySet: !!FIREBASE_API_KEY });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    await ensureTable();
    const b = req.body || {};
    const phoneOk = (p) => typeof p === 'string' && /^\+\d{7,15}$/.test(p);

    if (b.action === 'send') {
      if (!phoneOk(b.phone)) return res.status(400).json({ error: 'Enter a valid phone number.' });
      if (demoOk(b.phone)) return res.json({ ok: true }); // demo number: no SMS is sent, use DEMO_CODE
      const [prev] = await db().query('SELECT TIMESTAMPDIFF(SECOND, created_at, NOW()) AS age FROM phone_codes WHERE phone = ?', [b.phone]);
      if (prev[0] && prev[0].age < 30) return res.status(429).json({ error: 'Please wait a little before asking for another code.' });
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      await db().query(
        `INSERT INTO phone_codes (phone, code_hash, attempts, created_at, expires_at)
         VALUES (?, ?, 0, NOW(), DATE_ADD(NOW(), INTERVAL 10 MINUTE))
         ON DUPLICATE KEY UPDATE code_hash = VALUES(code_hash), attempts = 0, created_at = NOW(), expires_at = DATE_ADD(NOW(), INTERVAL 10 MINUTE)`,
        [b.phone, hashCode(code)]
      );
      await sendCodeSms(b.phone, code);
      return res.json({ ok: true });
    }

    if (b.action === 'verify') {
      if (!phoneOk(b.phone)) return res.status(400).json({ error: 'Enter a valid phone number.' });
      let verified = false;
      if (b.idToken) verified = (await phoneFromFirebase(b.idToken)) === b.phone;
      else if (demoOk(b.phone) && String(b.code) === CODE) verified = true; // only when DEMO_CODE is set (and the number is allowed)
      else if (b.code) {
        const [rows] = await db().query('SELECT code_hash, attempts, (expires_at > NOW()) AS valid FROM phone_codes WHERE phone = ?', [b.phone]);
        const row = rows[0];
        if (!row || !row.valid) return res.status(400).json({ error: 'That code has expired. Request a new one.' });
        if (row.attempts >= 5) return res.status(429).json({ error: 'Too many tries. Request a new code.' });
        if (hashCode(b.code) !== row.code_hash) {
          await db().query('UPDATE phone_codes SET attempts = attempts + 1 WHERE phone = ?', [b.phone]);
          return res.status(400).json({ error: 'Wrong code. Please try again.' });
        }
        await db().query('DELETE FROM phone_codes WHERE phone = ?', [b.phone]);
        verified = true;
      }
      if (!verified) return res.status(400).json({ error: 'Wrong code. Please try again.' });
      await db().query(
        'INSERT INTO users (phone, last_login) VALUES (?, NOW()) ON DUPLICATE KEY UPDATE last_login = NOW()',
        [b.phone]
      );
      return res.json({ token: sign(b.phone), user: await loadUser(b.phone) });
    }

    const phone = readToken(b.token);
    if (!phone) return res.status(401).json({ error: 'Session expired. Please sign in again.' });

    if (b.action === 'me') {
      const user = await loadUser(phone);
      if (!user) return res.status(401).json({ error: 'Account not found.' });
      return res.json({ user });
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
