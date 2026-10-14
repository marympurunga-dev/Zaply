// POST /api/chat  — actions: list, start, history, send, block, unblock, blockstate, report, setkey, getkey,
//                           group_create, group_info, group_leave (groups are chats with the id "g:<number>"),
//                           profile_get, profile_set (username, email, address, bio, birthday, pet)
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
        INDEX idx_p (phone))`),
      db().query(`CREATE TABLE IF NOT EXISTS blocks (
        blocker VARCHAR(20) NOT NULL,
        blocked VARCHAR(20) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (blocker, blocked),
        INDEX idx_blocked (blocked))`),
      db().query(`CREATE TABLE IF NOT EXISTS reports (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        reporter VARCHAR(20) NOT NULL,
        reported VARCHAR(40) NOT NULL,
        text VARCHAR(2000) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`),
      db().query(`CREATE TABLE IF NOT EXISTS user_keys (
        phone VARCHAR(20) NOT NULL PRIMARY KEY,
        public_key VARCHAR(200) NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`),
      db().query(`CREATE TABLE IF NOT EXISTS chat_groups (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(80) NOT NULL,
        creator VARCHAR(20) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`),
      db().query(`CREATE TABLE IF NOT EXISTS group_members (
        group_id INT NOT NULL,
        phone VARCHAR(20) NOT NULL,
        PRIMARY KEY (group_id, phone),
        INDEX idx_gm_phone (phone))`),
      db().query(`CREATE TABLE IF NOT EXISTS group_messages (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        group_id INT NOT NULL,
        sender VARCHAR(20) NOT NULL,
        body VARCHAR(2000) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_g (group_id, id))`),
      db().query(`CREATE TABLE IF NOT EXISTS profiles (
        phone VARCHAR(20) NOT NULL PRIMARY KEY,
        username VARCHAR(30) NULL,
        email VARCHAR(120) NOT NULL DEFAULT '',
        address VARCHAR(120) NOT NULL DEFAULT '',
        bio VARCHAR(800) NOT NULL DEFAULT '',
        birthday DATE NULL,
        pet VARCHAR(40) NOT NULL DEFAULT '',
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_username (username))`)]);
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

const EMPTY_PROFILE = { username: '', email: '', address: '', bio: '', birthday: '', pet: '' };
const cleanRow = (r) => ({ username: r.username || '', email: r.email || '', address: r.address || '', bio: r.bio || '', birthday: r.birthday || '', pet: r.pet || '' });
// trims, and cuts to a number of characters (emoji count as one)
const clip = (v, n) => Array.from(String(v == null ? '' : v).trim()).slice(0, n).join('');
function cleanProfile(b) {
  const username = clip(b.username, 31).replace(/^@/, '').toLowerCase();
  if (username && !/^[a-z0-9_.]{3,30}$/.test(username)) return { error: 'Username must be 3 to 30 letters, numbers, dots or underscores.' };
  const email = clip(b.email, 120);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: 'That email address doesn’t look right.' };
  const birthday = clip(b.birthday, 10);
  if (birthday) {
    const d = new Date(birthday + 'T00:00:00Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birthday) || isNaN(d) || d.toISOString().slice(0, 10) !== birthday || d > new Date() || d.getUTCFullYear() < 1900)
      return { error: 'That birthday isn’t a valid date.' };
  }
  return { username, email, address: clip(b.address, 120), bio: clip(b.bio, 200), birthday, pet: clip(b.pet, 40) };
}
const sha = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');
const MAX_GROUP = 50;
const isGroup = (x) => typeof x === 'string' && /^g:\d{1,9}$/.test(x);
const gid = (x) => Number(x.slice(2));
// The server cannot read end-to-end encrypted messages, so notifications must not show the scrambled text.
function preview(text) {
  if (String(text).indexOf('e2e1:') === 0) return 'New message';
  if (String(text).indexOf('__call__') === 0) return 'Incoming call';
  return String(text).slice(0, 140);
}
async function blockState(a, b) {
  const [r] = await db().query(
    'SELECT blocker FROM blocks WHERE (blocker = ? AND blocked = ?) OR (blocker = ? AND blocked = ?)', [a, b, b, a]);
  return { iBlocked: r.some((x) => x.blocker === a), blockedMe: r.some((x) => x.blocker === b) };
}
async function isMember(g, phone) {
  const [r] = await db().query('SELECT 1 FROM group_members WHERE group_id = ? AND phone = ?', [g, phone]);
  return r.length > 0;
}
async function pushTo(subs, payload) {
  await Promise.allSettled(subs.map(async (r) => {
    try { await webpush.sendNotification(JSON.parse(r.sub), payload, { TTL: 86400, urgency: 'high' }); }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) await db().query('DELETE FROM push_subs WHERE id = ?', [r.id]); }
  }));
}
async function notifyGroup(from, g, groupName, text) {
  if (!pushOn) return;
  try {
    const u = await findUser(from);
    const [subs] = await db().query(
      'SELECT s.id, s.sub FROM push_subs s JOIN group_members m ON m.phone = s.phone WHERE m.group_id = ? AND s.phone <> ?', [g, from]);
    const payload = JSON.stringify({ title: groupName, body: ((u && u.name) || from) + ': ' + preview(text), tag: 'g:' + g, from: 'g:' + g });
    await pushTo(subs, payload);
  } catch (e) { console.error(e); }
}
async function notify(from, to, text) {
  if (!pushOn) return;
  try {
    const u = await findUser(from);
    const [subs] = await db().query('SELECT id, sub FROM push_subs WHERE phone = ?', [to]);
    const payload = JSON.stringify({ title: (u && u.name) || from, body: preview(text), tag: from, from });
    await pushTo(subs, payload);
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
      const chats = last.map((m, i) => ({
        phone: others[i], name: names[others[i]] || '', last: m.body,
        mine: m.sender === me, at: m.created_at }));
      const [gs] = await db().query(
        `SELECT g.id, g.name, g.created_at,
           (SELECT body FROM group_messages WHERE group_id = g.id ORDER BY id DESC LIMIT 1) AS body,
           (SELECT sender FROM group_messages WHERE group_id = g.id ORDER BY id DESC LIMIT 1) AS sender,
           (SELECT created_at FROM group_messages WHERE group_id = g.id ORDER BY id DESC LIMIT 1) AS mat
         FROM chat_groups g JOIN group_members m ON m.group_id = g.id WHERE m.phone = ?`, [me]);
      let gnames = {};
      const senders = gs.map((g) => g.sender).filter(Boolean);
      if (senders.length) {
        const [u2] = await db().query('SELECT phone, name FROM users WHERE phone IN (?)', [senders]);
        u2.forEach((x) => { gnames[x.phone] = x.name; });
      }
      gs.forEach((g) => chats.push({
        phone: 'g:' + g.id, name: g.name, group: true, last: g.body || '', mine: g.sender === me,
        from: g.sender ? (gnames[g.sender] || g.sender) : '', at: g.mat || g.created_at }));
      chats.sort((a, b) => new Date(b.at) - new Date(a.at));
      return res.json({ chats });
    }

    if (b.action === 'start') {
      if (!phoneOk(b.phone)) return res.status(400).json({ error: 'Enter a valid phone number.' });
      if (b.phone === me) return res.status(400).json({ error: "That's your own number." });
      const u = await findUser(b.phone);
      if (!u) return res.status(404).json({ error: "That number isn't on Zucket yet." });
      return res.json({ user: u });
    }

    if (b.action === 'history') {
      const after = Number(b.after) || 0;
      if (isGroup(b.with)) {
        if (!(await isMember(gid(b.with), me))) return res.status(403).json({ error: 'You are not in this group.' });
        const [gr] = await db().query(
          `SELECT gm.id, gm.sender, gm.body, gm.created_at, u.name FROM group_messages gm
           LEFT JOIN users u ON u.phone = gm.sender
           WHERE gm.group_id = ? AND gm.id > ? ORDER BY gm.id ASC LIMIT 200`, [gid(b.with), after]);
        return res.json({ messages: gr.map((m) => ({
          id: m.id, mine: m.sender === me, body: m.body, at: m.created_at, from: m.name || m.sender })) });
      }
      if (!phoneOk(b.with)) return res.status(400).json({ error: 'Bad request.' });
      const [rows] = await db().query(
        `SELECT id, sender, body, created_at FROM messages
         WHERE id > ? AND ((sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?))
         ORDER BY id ASC LIMIT 200`, [after, me, b.with, b.with, me]);
      return res.json({ messages: rows.map((m) => ({
        id: m.id, mine: m.sender === me, body: m.body, at: m.created_at })) });
    }

    if (b.action === 'send') {
      const raw = String(b.body || '').trim();
      // an encrypted message cut short can never be decrypted, so refuse it instead of truncating
      if (raw.length > 2000 && raw.indexOf('e2e1:') === 0) return res.status(400).json({ error: 'Message too long.' });
      const body = raw.slice(0, 2000);
      if (isGroup(b.to)) {
        if (!body) return res.status(400).json({ error: 'Bad request.' });
        const g = gid(b.to);
        if (!(await isMember(g, me))) return res.status(403).json({ error: 'You are not in this group.' });
        const [gr] = await db().query('INSERT INTO group_messages (group_id, sender, body) VALUES (?, ?, ?)', [g, me, body]);
        const [gn] = await db().query('SELECT name FROM chat_groups WHERE id = ?', [g]);
        await notifyGroup(me, g, (gn[0] && gn[0].name) || 'Group', body);
        return res.json({ message: { id: gr.insertId, mine: true, body, at: new Date().toISOString(), from: '' } });
      }
      if (!phoneOk(b.to) || !body) return res.status(400).json({ error: 'Bad request.' });
      if (!(await findUser(b.to))) return res.status(404).json({ error: "That number isn't on Zucket yet." });
      const bs = await blockState(me, b.to);
      if (bs.iBlocked) return res.status(403).json({ error: 'You blocked this contact. Unblock them to send messages.', blocked: true });
      if (bs.blockedMe) return res.status(403).json({ error: "You can't message this person." });
      const [r] = await db().query('INSERT INTO messages (sender, receiver, body) VALUES (?, ?, ?)', [me, b.to, body]);
      await notify(me, b.to, body);
      return res.json({ message: { id: r.insertId, mine: true, body, at: new Date().toISOString() } });
    }

    if (b.action === 'blockstate') {
      if (!phoneOk(b.with)) return res.status(400).json({ error: 'Bad request.' });
      const bs = await blockState(me, b.with);
      return res.json({ blocked: bs.iBlocked });
    }

    if (b.action === 'block') {
      if (!phoneOk(b.phone) || b.phone === me) return res.status(400).json({ error: 'Bad request.' });
      await db().query('INSERT IGNORE INTO blocks (blocker, blocked) VALUES (?, ?)', [me, b.phone]);
      return res.json({ ok: true });
    }

    if (b.action === 'unblock') {
      if (!phoneOk(b.phone)) return res.status(400).json({ error: 'Bad request.' });
      await db().query('DELETE FROM blocks WHERE blocker = ? AND blocked = ?', [me, b.phone]);
      return res.json({ ok: true });
    }

    if (b.action === 'report') {
      const text = String(b.text || '').trim().slice(0, 2000);
      const about = String(b.to || '');
      if (!text || !(phoneOk(about) || isGroup(about))) return res.status(400).json({ error: 'Bad request.' });
      await db().query('INSERT INTO reports (reporter, reported, text) VALUES (?, ?, ?)', [me, about, text]);
      return res.json({ ok: true });
    }

    if (b.action === 'setkey') {
      if (typeof b.key !== 'string' || !/^[A-Za-z0-9+/=]{80,100}$/.test(b.key)) return res.status(400).json({ error: 'Bad request.' });
      await db().query(
        'INSERT INTO user_keys (phone, public_key) VALUES (?, ?) ON DUPLICATE KEY UPDATE public_key = VALUES(public_key)', [me, b.key]);
      return res.json({ ok: true });
    }

    if (b.action === 'getkey') {
      if (!phoneOk(b.phone)) return res.status(400).json({ error: 'Bad request.' });
      const [k] = await db().query('SELECT public_key FROM user_keys WHERE phone = ?', [b.phone]);
      return res.json({ key: k[0] ? k[0].public_key : null });
    }

    if (b.action === 'profile_get') {
      const who = b.phone === undefined ? me : b.phone;
      if (!phoneOk(who)) return res.status(400).json({ error: 'Bad request.' });
      if (who !== me) {
        if (!(await findUser(who))) return res.status(404).json({ error: "That number isn't on Zucket yet." });
        const bs = await blockState(me, who);
        if (bs.iBlocked || bs.blockedMe) return res.json({ profile: EMPTY_PROFILE });
      }
      const [r] = await db().query(
        "SELECT username, email, address, bio, DATE_FORMAT(birthday, '%Y-%m-%d') AS birthday, pet FROM profiles WHERE phone = ?", [who]);
      return res.json({ profile: r[0] ? cleanRow(r[0]) : EMPTY_PROFILE });
    }

    if (b.action === 'profile_set') {
      const p = cleanProfile(b);
      if (p.error) return res.status(400).json({ error: p.error });
      try {
        await db().query(
          `INSERT INTO profiles (phone, username, email, address, bio, birthday, pet) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE username = VALUES(username), email = VALUES(email), address = VALUES(address),
             bio = VALUES(bio), birthday = VALUES(birthday), pet = VALUES(pet)`,
          [me, p.username || null, p.email, p.address, p.bio, p.birthday || null, p.pet]);
      } catch (e) {
        if (e && e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'That username is already taken.' });
        throw e;
      }
      return res.json({ profile: { username: p.username, email: p.email, address: p.address, bio: p.bio, birthday: p.birthday, pet: p.pet } });
    }

    if (b.action === 'group_create') {
      const name = String(b.name || '').trim().slice(0, 80);
      if (!name) return res.status(400).json({ error: 'Give the group a name.' });
      const wanted = Array.from(new Set((Array.isArray(b.members) ? b.members : []).filter((p) => phoneOk(p) && p !== me))).slice(0, MAX_GROUP - 1);
      if (!wanted.length) return res.status(400).json({ error: 'Add at least one member.' });
      const [found] = await db().query('SELECT phone FROM users WHERE phone IN (?)', [wanted]);
      const members = found.map((x) => x.phone);
      if (!members.length) return res.status(400).json({ error: 'None of those people are on Zucket.' });
      const [g] = await db().query('INSERT INTO chat_groups (name, creator) VALUES (?, ?)', [name, me]);
      const rows = [me].concat(members).map((p) => [g.insertId, p]);
      await db().query('INSERT INTO group_members (group_id, phone) VALUES ?', [rows]);
      return res.json({ group: { phone: 'g:' + g.insertId, name, group: true, members: rows.length } });
    }

    if (b.action === 'group_info') {
      if (!isGroup(b.group) || !(await isMember(gid(b.group), me))) return res.status(403).json({ error: 'You are not in this group.' });
      const [g] = await db().query('SELECT name, creator FROM chat_groups WHERE id = ?', [gid(b.group)]);
      const [m] = await db().query(
        'SELECT gm.phone, u.name FROM group_members gm LEFT JOIN users u ON u.phone = gm.phone WHERE gm.group_id = ?', [gid(b.group)]);
      return res.json({ name: g[0] ? g[0].name : '', creator: g[0] ? g[0].creator : '', members: m.map((x) => ({ phone: x.phone, name: x.name || '' })) });
    }

    if (b.action === 'group_leave') {
      if (!isGroup(b.group)) return res.status(400).json({ error: 'Bad request.' });
      await db().query('DELETE FROM group_members WHERE group_id = ? AND phone = ?', [gid(b.group), me]);
      const [left] = await db().query('SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?', [gid(b.group)]);
      if (!left[0].n) {
        await db().query('DELETE FROM group_messages WHERE group_id = ?', [gid(b.group)]);
        await db().query('DELETE FROM chat_groups WHERE id = ?', [gid(b.group)]);
      }
      return res.json({ ok: true });
    }

    if (b.action === 'testpush') {
      if (!pushOn) return res.status(400).json({ error: 'Server has no push keys. Add the VAPID settings in Vercel and redeploy.' });
      const [subs] = await db().query('SELECT id, sub FROM push_subs WHERE phone = ?', [me]);
      if (!subs.length) return res.status(400).json({ error: 'No notification address is saved for this account. Tap the bell button and allow notifications.' });
      await new Promise((r) => setTimeout(r, 7000));
      const payload = JSON.stringify({ title: 'Zaply test', body: 'If you can see this, notifications work.', tag: 'test', from: '' });
      const results = [];
      for (const r of subs) {
        try { await webpush.sendNotification(JSON.parse(r.sub), payload, { TTL: 60, urgency: 'high' }); results.push('sent'); }
        catch (e) {
          results.push('failed ' + (e.statusCode || '') + ' ' + String(e.body || e.message || '').slice(0, 80));
          if (e.statusCode === 404 || e.statusCode === 410) await db().query('DELETE FROM push_subs WHERE id = ?', [r.id]);
        }
      }
      return res.json({ results });
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
