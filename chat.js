// POST /api/chat  — actions: list, start, history, send
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const webpush = require('web-push');
const pushOn = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
if (pushOn) webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@zaply.app', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);

const SECRET = process.env.AUTH_SECRET || 'change-me';
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
      connectionLimit: 1, maxIdle: 1, idleTimeout: 60000, enableKeepAlive: true,
    });
  }
  return pool;
}
let ready;
function ensureTable() {
  if (!ready) {
    ready = Promise.all([db().query(`CREATE TABLE IF NOT EXISTS messages (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      sender VARCHAR(20) NOT NULL,
      receiver VARCHAR(20) NOT NULL,
      body VARCHAR(2000) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_sr (sender, receiver, id),
      INDEX idx_rs (receiver, sender, id))`),
      db().query(`CREATE TABLE IF NOT EXISTS push_subs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        phone VARCHAR(20) NOT NULL,
        hash CHAR(64) NOT NULL UNIQUE,
        sub TEXT NOT NULL,
        INDEX idx_p (phone))`)]);
  }
  return ready;
}
function readToken(t) {
  if (!t || typeof t !== 'string' || t.indexOf('.') < 0) return null;
  const [body, sig] = t.split('.');
  const good = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try { const d = JSON.parse(Buffer.from(body, 'base64url').toString()); return d.e > Date.now() ? d.p : null; }
  catch (e) { return null; }
}
const phoneOk = (p) => typeof p === 'string' && /^\+\d{7,15}$/.test(p);
async function findUser(phone) {
  const [r] = await db().query('SELECT phone, name FROM users WHERE phone = ?', [phone]);
  return r[0] || null;
}

const sha = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');
async function notify(from, to, text) {
  if (!pushOn) return;
  try {
    const u = await findUser(from);
    const [subs] = await db().query('SELECT id, sub FROM push_subs WHERE phone = ?', [to]);
    const payload = JSON.stringify({ title: (u && u.name) || from, body: text.slice(0, 140), tag: from, from });
    await Promise.allSettled(subs.map(async (r) => {
      try { await webpush.sendNotification(JSON.parse(r.sub), payload, { TTL: 86400, urgency: 'high' }); }
      catch (e) { if (e.statusCode === 404 || e.statusCode === 410) await db().query('DELETE FROM push_subs WHERE id = ?', [r.id]); }
    }));
  } catch (e) { console.error(e); }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const b = req.body || {};
    const me = readToken(b.token);
    if (!me) return res.status(401).json({ error: 'Session expired. Please sign in again.' });
    await ensureTable();

    if (b.action === 'list') {
      const [last] = await db().query(
        `SELECT id, sender, receiver, body, created_at FROM messages
         WHERE id IN (SELECT MAX(id) FROM messages WHERE sender = ? OR receiver = ?
                      GROUP BY IF(sender = ?, receiver, sender))
         ORDER BY id DESC LIMIT 100`, [me, me, me]);
      const others = last.map((m) => (m.sender === me ? m.receiver : m.sender));
      let names = {};
      if (others.length) {
        const [u] = await db().query('SELECT phone, name FROM users WHERE phone IN (?)', [others]);
        u.forEach((x) => { names[x.phone] = x.name; });
      }
      return res.json({ chats: last.map((m, i) => ({
        phone: others[i], name: names[others[i]] || '', last: m.body,
        mine: m.sender === me, at: m.created_at })) });
    }

    if (b.action === 'start') {
      if (!phoneOk(b.phone)) return res.status(400).json({ error: 'Enter a valid phone number.' });
      if (b.phone === me) return res.status(400).json({ error: "That's your own number." });
      const u = await findUser(b.phone);
      if (!u) return res.status(404).json({ error: "That number isn't on Zaply yet." });
      return res.json({ user: u });
    }

    if (b.action === 'history') {
      if (!phoneOk(b.with)) return res.status(400).json({ error: 'Bad request.' });
      const after = Number(b.after) || 0;
      const [rows] = await db().query(
        `SELECT id, sender, body, created_at FROM messages
         WHERE id > ? AND ((sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?))
         ORDER BY id ASC LIMIT 200`, [after, me, b.with, b.with, me]);
      return res.json({ messages: rows.map((m) => ({
        id: m.id, mine: m.sender === me, body: m.body, at: m.created_at })) });
    }

    if (b.action === 'send') {
      const body = String(b.body || '').trim().slice(0, 2000);
      if (!phoneOk(b.to) || !body) return res.status(400).json({ error: 'Bad request.' });
      if (!(await findUser(b.to))) return res.status(404).json({ error: "That number isn't on Zaply yet." });
      const [r] = await db().query('INSERT INTO messages (sender, receiver, body) VALUES (?, ?, ?)', [me, b.to, body]);
      await notify(me, b.to, body);
      return res.json({ message: { id: r.insertId, mine: true, body, at: new Date().toISOString() } });
    }

    if (b.action === 'pushkey') return res.json({ key: pushOn ? process.env.VAPID_PUBLIC_KEY : '' });

    if (b.action === 'subscribe') {
      const sub = b.sub;
      if (!sub || typeof sub.endpoint !== 'string' || !sub.keys) return res.status(400).json({ error: 'Bad request.' });
      await db().query(
        'INSERT INTO push_subs (phone, hash, sub) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE phone = VALUES(phone), sub = VALUES(sub)',
        [me, sha(sub.endpoint), JSON.stringify(sub)]);
      return res.json({ ok: true });
    }

    if (b.action === 'unsubscribe') {
      if (typeof b.endpoint === 'string') await db().query('DELETE FROM push_subs WHERE hash = ? AND phone = ?', [sha(b.endpoint), me]);
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action.' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
};
