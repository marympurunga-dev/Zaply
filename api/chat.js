// POST /api/chat  — actions: list, start, history, send, media_sign, media_get, block, unblock, blockstate, report, setkey, getkey,
//                           group_create, group_info, group_leave (groups are chats with the id "g:<number>"),
//                           profile_get, profile_set (username, email, address, bio, birthday, pet),
//                           presence_ping, presence_get (online / last seen)
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const webpush = require('web-push');
// Photos, videos, voice notes and files live in Cloudinary (set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET in Vercel).
// Run: npm i cloudinary
let cld;
function cloud() {
  if (!cld) {
    cld = require('cloudinary').v2;
    cld.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET, secure: true });
  }
  return cld;
}
const cloudOn = () => !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
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
      db().query(`CREATE TABLE IF NOT EXISTS media (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        owner VARCHAR(20) NOT NULL,
        peer VARCHAR(40) NOT NULL,
        size INT NOT NULL,
        data LONGBLOB NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_media_peer (peer))`),
      db().query(`CREATE TABLE IF NOT EXISTS cloud_media (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        owner VARCHAR(20) NOT NULL,
        peer VARCHAR(40) NOT NULL,
        size INT NOT NULL,
        public_id VARCHAR(80) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_cmedia_peer (peer))`),
      db().query(`CREATE TABLE IF NOT EXISTS profiles (
        phone VARCHAR(20) NOT NULL PRIMARY KEY,
        username VARCHAR(30) NULL,
        email VARCHAR(120) NOT NULL DEFAULT '',
        address VARCHAR(120) NOT NULL DEFAULT '',
        bio VARCHAR(800) NOT NULL DEFAULT '',
        birthday DATE NULL,
        pet VARCHAR(40) NOT NULL DEFAULT '',
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_username (username))`)]).then(async () => {
      /* message ticks: delivered_at = receiver's app fetched it, read_at = receiver opened the chat */
      await db().query("ALTER TABLE messages ADD COLUMN read_at TIMESTAMP NULL").catch(() => {});
      await db().query("ALTER TABLE messages ADD COLUMN delivered_at TIMESTAMP NULL")
        .then(() => db().query("UPDATE messages SET delivered_at = created_at, read_at = created_at WHERE read_at IS NULL")).catch(() => {});
      await db().query("ALTER TABLE messages ADD INDEX idx_rd (receiver, delivered_at)").catch(() => {});
      await db().query("ALTER TABLE profiles ADD COLUMN photo_url VARCHAR(300) NOT NULL DEFAULT ''").catch(() => {});
      await db().query("ALTER TABLE profiles ADD COLUMN links VARCHAR(300) NOT NULL DEFAULT ''").catch(() => {});
      await db().query("ALTER TABLE profiles ADD COLUMN privacy VARCHAR(1500) NOT NULL DEFAULT ''").catch(() => {});
      /* online / last seen: last_active = last time their app told us it was open, is_online = 0 once they close it */
      await db().query("ALTER TABLE profiles ADD COLUMN last_active TIMESTAMP NULL").catch(() => {});
      await db().query("ALTER TABLE profiles ADD COLUMN is_online TINYINT NOT NULL DEFAULT 0").catch(() => {});
      await db().query(`CREATE TABLE IF NOT EXISTS phone_otps (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        owner VARCHAR(20) NOT NULL,
        new_phone VARCHAR(20) NOT NULL,
        code_hash CHAR(64) NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        tries INT NOT NULL DEFAULT 0,
        used TINYINT NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_po (owner, created_at))`);
      await db().query(`CREATE TABLE IF NOT EXISTS two_step (
        phone VARCHAR(20) NOT NULL PRIMARY KEY,
        salt VARCHAR(32) NOT NULL,
        hash VARCHAR(128) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    });
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
function mintToken(p) {
  const body = Buffer.from(JSON.stringify({ p, e: Date.now() + 1000 * 60 * 60 * 24 * 365 })).toString('base64url');
  return body + '.' + crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
}
// Africa's Talking SMS (set AT_USERNAME and AT_API_KEY in Vercel; AT_SENDER is optional)
async function sendSms(to, message) {
  if (!process.env.AT_API_KEY || !process.env.AT_USERNAME) throw new Error('SMS is not set up on the server yet.');
  const form = new URLSearchParams({ username: process.env.AT_USERNAME, to, message });
  if (process.env.AT_SENDER) form.set('from', process.env.AT_SENDER);
  const base = process.env.AT_USERNAME === 'sandbox' ? 'https://api.sandbox.africastalking.com' : 'https://api.africastalking.com';
  const r = await fetch(base + '/version1/messaging', { method: 'POST', headers: { apiKey: process.env.AT_API_KEY, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
  const raw = await r.text(); let j = null; try { j = JSON.parse(raw); } catch (e) {}
  if (!r.ok) {
    console.error('Africa\'s Talking HTTP', r.status, raw.slice(0, 300));
    throw new Error(r.status === 401 ? 'SMS login failed. Check AT_USERNAME and AT_API_KEY on the server.' : 'Could not send the SMS. Try again.');
  }
  // Africa's Talking answers HTTP 201 even when a message is rejected, so the per-number status must be checked
  const rec = (j && j.SMSMessageData && j.SMSMessageData.Recipients) || [];
  const bad = rec.find((x) => ![100, 101, 102].includes(Number(x.statusCode)));
  if (bad || !rec.length) {
    console.error('Africa\'s Talking rejected the SMS:', raw.slice(0, 400));
    const why = String((bad && bad.status) || (j && j.SMSMessageData && j.SMSMessageData.Message) || '');
    const map = { InvalidSenderId: 'The SMS sender name (AT_SENDER) is not approved on Africa\'s Talking.', InsufficientBalance: 'The SMS account has no balance left.', InvalidPhoneNumber: 'That phone number is not valid.', UnsupportedNumberType: 'SMS cannot be sent to that kind of number.', UserInBlacklist: 'That number has opted out of SMS.', CouldNotRoute: 'SMS cannot be delivered to that network.', RiskHold: 'The SMS was held for review by Africa\'s Talking.' };
    throw new Error(map[why] || 'The SMS could not be delivered' + (why ? ' (' + why + ')' : '') + '.');
  }
}
// Email codes use the same sender as sign-up (api/_mail.js), so it needs no new Vercel settings
const { sendCodeEmail } = require('./_mail');
const { fcmOn, sendFcm } = require('./_fcm');
const phoneOk = (p) => typeof p === 'string' && /^\+\d{7,15}$/.test(p);
async function findUser(phone) {
  const [r] = await db().query('SELECT phone, name FROM users WHERE phone = ?', [phone]);
  return r[0] || null;
}

const EMPTY_PROFILE = { name: '', username: '', email: '', address: '', bio: '', birthday: '', pet: '', links: '', photo_url: '' };
const cleanRow = (r) => ({ username: r.username || '', email: r.email || '', address: r.address || '', bio: r.bio || '', birthday: r.birthday || '', pet: r.pet || '', links: r.links || '', photo_url: r.photo_url || '' });
// trims, and cuts to a number of characters (emoji count as one)
const clip = (v, n) => Array.from(String(v == null ? '' : v).trim()).slice(0, n).join('');
function cleanProfile(b) {
  const username = clip(b.username, 31).replace(/^@/, '').toLowerCase();
  if (username && !/^[a-z0-9.]{3,30}$/.test(username)) return { error: 'Username must be 3 to 30 letters, numbers or dots.' };
  const email = clip(b.email, 120);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: 'That email address doesn’t look right.' };
  const birthday = clip(b.birthday, 10);
  if (birthday) {
    const d = new Date(birthday + 'T00:00:00Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birthday) || isNaN(d) || d.toISOString().slice(0, 10) !== birthday || d > new Date() || d.getUTCFullYear() < 1900)
      return { error: 'That birthday isn’t a valid date.' };
  }
  const name = b.name === undefined ? undefined : clip(b.name, 40);
  if (name !== undefined && !name) return { error: 'Enter your name.' };
  return { name, username, email, address: clip(b.address, 120), bio: clip(b.bio, 130), birthday, pet: clip(b.pet, 40), links: clip(b.links, 300) };
}
const sha = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');
const MAX_GROUP = 50;
const MEDIA_MAX = 10 * 1024 * 1024; // Cloudinary free plan allows 10 MB per raw file
const isGroup = (x) => typeof x === 'string' && /^g:\d{1,9}$/.test(x);
const gid = (x) => Number(x.slice(2));
// The server cannot read end-to-end encrypted messages, so notifications must not show the scrambled text.
function preview(text) {
  if (String(text).indexOf('e2e1:') === 0) return 'New message';
  if (String(text).indexOf('__call__') === 0) return 'Incoming call';
  if (String(text).indexOf('__media__') === 0) return 'Sent an attachment';
  if (String(text).indexOf('__loc__') === 0) return 'Shared a location';
  if (String(text).indexOf('__game__') === 0) return 'Game move';
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
let fcmReady = null;
function fcmTable() {
  if (!fcmReady) fcmReady = db().query('CREATE TABLE IF NOT EXISTS fcm_tokens (id BIGINT AUTO_INCREMENT PRIMARY KEY, phone VARCHAR(20) NOT NULL, hash CHAR(64) NOT NULL, token VARCHAR(512) NOT NULL, updated TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, UNIQUE KEY uq_h (hash), INDEX idx_p (phone))').catch((e) => { fcmReady = null; throw e; });
  return fcmReady;
}
async function fcmPush(rows, data, opts) {
  if (!rows.length) return;
  const dead = await sendFcm(rows, data, opts);
  if (dead.length) await db().query('DELETE FROM fcm_tokens WHERE id IN (' + dead.map(() => '?').join(',') + ')', dead);
}
async function notifyGroup(from, g, groupName, text) {
  try {
    const u = await findUser(from);
    const who = (u && u.name) || from, body = who + ': ' + preview(text);
    if (pushOn) {
      const [subs] = await db().query(
        'SELECT s.id, s.sub FROM push_subs s JOIN group_members m ON m.phone = s.phone WHERE m.group_id = ? AND s.phone <> ?', [g, from]);
      await pushTo(subs, JSON.stringify({ title: groupName, body, tag: 'g:' + g, from: 'g:' + g }));
    }
    if (fcmOn()) {
      await fcmTable();
      const [rows] = await db().query('SELECT t.id, t.token FROM fcm_tokens t JOIN group_members m ON m.phone = t.phone WHERE m.group_id = ? AND t.phone <> ?', [g, from]);
      await fcmPush(rows, { type: 'msg', title: groupName, body, from: 'g:' + g });
    }
  } catch (e) { console.error(e); }
}
async function notify(from, to, text) {
  try {
    const u = await findUser(from);
    const name = (u && u.name) || from, isCall = String(text).indexOf('__call__') === 0;
    if (pushOn) {
      const [subs] = await db().query('SELECT id, sub FROM push_subs WHERE phone = ?', [to]);
      await pushTo(subs, JSON.stringify({ title: name, body: preview(text), tag: from, from }));
    }
    if (fcmOn()) {
      await fcmTable();
      const [rows] = await db().query('SELECT id, token FROM fcm_tokens WHERE phone = ?', [to]);
      if (isCall) {
        let video = '0'; try { video = JSON.parse(String(text).slice(8)).v ? '1' : '0'; } catch (e) {}
        await fcmPush(rows, { type: 'call', title: name, body: 'Incoming call', from, name, video, call: String(text) }, { ttl: '45s' });
      } else await fcmPush(rows, { type: 'msg', title: name, body: preview(text), from });
    }
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
      /* the app is open, so everything waiting for me counts as delivered (two grey ticks for the sender) */
      await db().query('UPDATE messages SET delivered_at = NOW() WHERE receiver = ? AND delivered_at IS NULL', [me]).catch(() => {});
      const [last] = await db().query(
        `SELECT id, sender, receiver, body, created_at, delivered_at, read_at FROM messages
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
        mine: m.sender === me, at: m.created_at,
        st: m.sender === me ? (m.read_at ? 3 : m.delivered_at ? 2 : 1) : 0 }));
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
      if (!u) return res.status(404).json({ error: "That number isn't on Zanply yet." });
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
      /* the chat is open on my screen, so what they sent me is read (blue ticks for them) */
      await db().query(
        'UPDATE messages SET delivered_at = COALESCE(delivered_at, NOW()), read_at = NOW() WHERE receiver = ? AND sender = ? AND read_at IS NULL',
        [me, b.with]).catch(() => {});
      const [rows] = await db().query(
        `SELECT id, sender, body, created_at, delivered_at, read_at FROM messages
         WHERE id > ? AND ((sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?))
         ORDER BY id ASC LIMIT 200`, [after, me, b.with, b.with, me]);
      const stOf = (m) => (m.read_at ? 3 : m.delivered_at ? 2 : 1);
      /* new tick state for my earlier messages the app is still tracking */
      let ticks = {};
      const track = (Array.isArray(b.track) ? b.track : []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 100);
      if (track.length) {
        const [ts] = await db().query('SELECT id, delivered_at, read_at FROM messages WHERE id IN (?) AND sender = ? AND receiver = ?', [track, me, b.with]);
        ts.forEach((m) => { ticks[m.id] = stOf(m); });
      }
      return res.json({ ticks, messages: rows.map((m) => ({
        id: m.id, mine: m.sender === me, body: m.body, at: m.created_at, st: m.sender === me ? stOf(m) : 0 })) });
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
      if (!(await findUser(b.to))) return res.status(404).json({ error: "That number isn't on Zanply yet." });
      const bs = await blockState(me, b.to);
      if (bs.iBlocked) return res.status(403).json({ error: 'You blocked this contact. Unblock them to send messages.', blocked: true });
      if (bs.blockedMe) return res.status(403).json({ error: "You can't message this person." });
      const [r] = await db().query('INSERT INTO messages (sender, receiver, body) VALUES (?, ?, ?)', [me, b.to, body]);
      await notify(me, b.to, body);
      return res.json({ message: { id: r.insertId, mine: true, body, at: new Date().toISOString(), st: 1 } });
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


    // Privacy settings (kept on the server so they follow the account)
    if (b.action === 'privacy_get') {
      const [r] = await db().query('SELECT privacy FROM profiles WHERE phone = ?', [me]);
      let pv = {}; try { pv = JSON.parse((r[0] && r[0].privacy) || '{}'); } catch (e) {}
      return res.json({ privacy: pv });
    }
    if (b.action === 'privacy_set') {
      let pv; try { pv = JSON.parse(String(b.privacy || '{}')); } catch (e) { return res.status(400).json({ error: 'Bad request.' }); }
      const ok = ['everyone', 'contacts', 'except', 'nobody'], clean = {
        lastseen: ok.includes(pv.lastseen) ? pv.lastseen : 'contacts', online: pv.online === 'same' ? 'same' : 'everyone',
        photo: ok.includes(pv.photo) ? pv.photo : 'everyone', hidePhone: !!pv.hidePhone,
        ex: { lastseen: (pv.ex && Array.isArray(pv.ex.lastseen) ? pv.ex.lastseen : []).filter(phoneOk).slice(0, 60), photo: (pv.ex && Array.isArray(pv.ex.photo) ? pv.ex.photo : []).filter(phoneOk).slice(0, 60) }
      };
      await db().query('INSERT INTO profiles (phone, privacy) VALUES (?, ?) ON DUPLICATE KEY UPDATE privacy = VALUES(privacy)', [me, JSON.stringify(clean)]);
      return res.json({ ok: true });
    }
    // Online / last seen. The app pings every ~25s while open; "online" = pinged within the last 60s.
    if (b.action === 'presence_ping') {
      await db().query('INSERT INTO profiles (phone, last_active, is_online) VALUES (?, NOW(), ?) ON DUPLICATE KEY UPDATE last_active = NOW(), is_online = VALUES(is_online)', [me, b.online === false ? 0 : 1]);
      return res.json({ ok: true });
    }
    if (b.action === 'presence_get') {
      const who = b.with;
      if (!phoneOk(who) || who === me) return res.json({ hidden: true });
      const bs = await blockState(me, who);
      if (bs.iBlocked || bs.blockedMe) return res.json({ hidden: true });
      /* if I hide my own last seen, I can't see other people's either */
      const [mine] = await db().query('SELECT privacy FROM profiles WHERE phone = ?', [me]);
      let mp = {}; try { mp = JSON.parse((mine[0] && mine[0].privacy) || '{}'); } catch (e) {}
      if (mp.lastseen === 'nobody') return res.json({ hidden: true });
      const [rows] = await db().query('SELECT privacy, last_active, (is_online = 1 AND last_active > NOW() - INTERVAL 60 SECOND) AS online FROM profiles WHERE phone = ?', [who]);
      const r = rows[0];
      if (!r || !r.last_active) return res.json({ hidden: false, online: false, last: null });
      let pv = {}; try { pv = JSON.parse(r.privacy || '{}'); } catch (e) {}
      const rule = pv.lastseen || 'contacts';
      let canLast = rule === 'everyone';
      if (rule === 'contacts' || rule === 'except') {
        /* a contact = someone they have chatted with */
        const [c] = await db().query('SELECT 1 FROM messages WHERE (sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?) LIMIT 1', [me, who, who, me]);
        canLast = c.length > 0;
        if (rule === 'except' && ((pv.ex && pv.ex.lastseen) || []).includes(me)) canLast = false;
      }
      const canOnline = pv.online !== 'same' || canLast;
      return res.json({ hidden: !canOnline && !canLast, online: canOnline && Number(r.online) === 1, last: canLast ? r.last_active : null });
    }
    if (b.action === 'blocklist') {
      const [r] = await db().query('SELECT b.blocked AS phone, u.name AS name FROM blocks b LEFT JOIN users u ON u.phone = b.blocked WHERE b.blocker = ? ORDER BY b.created_at DESC', [me]);
      return res.json({ blocked: r.map((x) => ({ phone: x.phone, name: x.name || '' })) });
    }

    // Change phone number: code goes to the NEW number (or email), then the account moves over
    if (b.action === 'phone_change_send') {
      const np = String(b.phone || '');
      if (!phoneOk(np) || np === me) return res.status(400).json({ error: 'Enter a valid new number with the country code, for example +254…' });
      const channel = ['sms', 'email', 'call', 'missedcall'].includes(b.channel) ? b.channel : 'sms';
      if (channel === 'call' || channel === 'missedcall') return res.status(400).json({ error: 'This option is not available yet. Please use the text message.' });
      if (await findUser(np)) return res.status(409).json({ error: 'That number is already registered on Zanply.' });
      const [cnt] = await db().query('SELECT COUNT(*) AS n FROM phone_otps WHERE owner = ? AND created_at > (NOW() - INTERVAL 1 DAY)', [me]);
      if (cnt[0].n >= 3) return res.status(429).json({ error: 'You have reached today’s limit for code requests. Try again tomorrow.' });
      const [last] = await db().query('SELECT TIMESTAMPDIFF(SECOND, created_at, NOW()) AS age FROM phone_otps WHERE owner = ? ORDER BY id DESC LIMIT 1', [me]);
      if (last[0] && last[0].age < 170) return res.status(429).json({ error: 'Please wait for the countdown before asking for another code.' });
      let mailTo = '';
      if (channel === 'email') {
        const [pe] = await db().query('SELECT email FROM profiles WHERE phone = ?', [me]);
        mailTo = pe[0] && pe[0].email; if (!mailTo) return res.status(400).json({ error: 'Add an email to your profile first.' });
      }
      const code = String(crypto.randomInt(100000, 1000000));
      const msg = 'Your Zanply code is ' + code + '. It expires in 10 minutes. Do not share it.';
      try { if (channel === 'email') await sendCodeEmail(mailTo, code); else await sendSms(np, msg); }
      catch (e) { return res.status(502).json({ error: e.message || 'Could not send the code.' }); }
      await db().query('INSERT INTO phone_otps (owner, new_phone, code_hash, expires_at) VALUES (?, ?, ?, NOW() + INTERVAL 10 MINUTE)', [me, np, sha(code + SECRET)]);
      return res.json({ ok: true });
    }
    if (b.action === 'phone_change_verify') {
      const np = String(b.phone || ''), code = String(b.code || '').trim();
      if (!phoneOk(np) || !/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the 6-digit code.' });
      const [rows] = await db().query('SELECT id, code_hash, tries, TIMESTAMPDIFF(SECOND, NOW(), expires_at) AS secs FROM phone_otps WHERE owner = ? AND new_phone = ? AND used = 0 ORDER BY id DESC LIMIT 1', [me, np]);
      const o = rows[0];
      if (!o) return res.status(400).json({ error: 'Ask for a new code first.' });
      if (o.secs <= 0) return res.status(400).json({ error: 'That code has expired. Ask for a new one.' });
      if (o.tries >= 5) return res.status(429).json({ error: 'Too many wrong tries. Ask for a new code.' });
      if (sha(code + SECRET) !== o.code_hash) { await db().query('UPDATE phone_otps SET tries = tries + 1 WHERE id = ?', [o.id]); return res.status(400).json({ error: 'Wrong code. Try again.' }); }
      if (await findUser(np)) return res.status(409).json({ error: 'That number is already registered on Zanply.' });
      const conn = await db().getConnection();
      try {
        await conn.beginTransaction();
        const moves = [['users', 'phone'], ['profiles', 'phone'], ['messages', 'sender'], ['messages', 'receiver'], ['blocks', 'blocker'], ['blocks', 'blocked'], ['push_subs', 'phone'],
          ['user_keys', 'phone'], ['two_step', 'phone'], ['group_members', 'phone'], ['chat_groups', 'creator'], ['group_messages', 'sender'],
          ['media', 'owner'], ['media', 'peer'], ['cloud_media', 'owner'], ['cloud_media', 'peer']];
        for (const [t, col] of moves) await conn.query('UPDATE IGNORE `' + t + '` SET `' + col + '` = ? WHERE `' + col + '` = ?', [np, me]);
        await conn.query('UPDATE phone_otps SET used = 1 WHERE owner = ?', [me]);
        await conn.commit();
      } catch (e) { await conn.rollback().catch(() => {}); throw e; } finally { conn.release(); }
      const [u] = await db().query('SELECT name FROM users WHERE phone = ?', [np]);
      return res.json({ ok: true, token: mintToken(np), phone: np, name: u[0] ? u[0].name : '' });
    }

    // Change / add email: a 6-digit code goes to the NEW address (Resend, through ./_mail), then the profile email is saved
    if (b.action === 'email_change_send') {
      const em = String(b.email || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em) || em.length > 120) return res.status(400).json({ error: 'That email address doesn\u2019t look right.' });
      await db().query(`CREATE TABLE IF NOT EXISTS email_otps (id BIGINT AUTO_INCREMENT PRIMARY KEY, owner VARCHAR(20) NOT NULL, email VARCHAR(120) NOT NULL, code_hash CHAR(64) NOT NULL, tries INT NOT NULL DEFAULT 0, used TINYINT NOT NULL DEFAULT 0, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at TIMESTAMP NOT NULL, INDEX idx_o (owner))`);
      const [cnt] = await db().query('SELECT COUNT(*) AS n FROM email_otps WHERE owner = ? AND created_at > (NOW() - INTERVAL 1 DAY)', [me]);
      if (cnt[0].n >= 5) return res.status(429).json({ error: 'You have reached today\u2019s limit for code requests. Try again tomorrow.' });
      const code = String(crypto.randomInt(100000, 1000000));
      try { await sendCodeEmail(em, code); } catch (e) { return res.status(502).json({ error: e.message || 'Could not send the code. Check the email address.' }); }
      await db().query('INSERT INTO email_otps (owner, email, code_hash, expires_at) VALUES (?, ?, ?, NOW() + INTERVAL 10 MINUTE)', [me, em, sha(code + SECRET)]);
      return res.json({ ok: true });
    }
    if (b.action === 'email_change_verify') {
      const em = String(b.email || '').trim().toLowerCase(), code = String(b.code || '').trim();
      if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the 6-digit code.' });
      const [rows] = await db().query('SELECT id, code_hash, tries, TIMESTAMPDIFF(SECOND, NOW(), expires_at) AS secs FROM email_otps WHERE owner = ? AND email = ? AND used = 0 ORDER BY id DESC LIMIT 1', [me, em]);
      const o = rows[0];
      if (!o) return res.status(400).json({ error: 'Ask for a new code first.' });
      if (o.secs <= 0) return res.status(400).json({ error: 'That code has expired. Ask for a new one.' });
      if (o.tries >= 5) return res.status(429).json({ error: 'Too many wrong tries. Ask for a new code.' });
      if (sha(code + SECRET) !== o.code_hash) { await db().query('UPDATE email_otps SET tries = tries + 1 WHERE id = ?', [o.id]); return res.status(400).json({ error: 'Wrong code. Try again.' }); }
      await db().query('UPDATE email_otps SET used = 1 WHERE owner = ?', [me]);
      await db().query('INSERT INTO profiles (phone, email) VALUES (?, ?) ON DUPLICATE KEY UPDATE email = VALUES(email)', [me, em]);
      return res.json({ ok: true, email: em });
    }

    if (b.action === 'profile_get') {
      const who = b.phone === undefined ? me : b.phone;
      if (!phoneOk(who)) return res.status(400).json({ error: 'Bad request.' });
      if (who !== me) {
        if (!(await findUser(who))) return res.status(404).json({ error: "That number isn't on Zanply yet." });
        const bs = await blockState(me, who);
        if (bs.iBlocked || bs.blockedMe) return res.json({ profile: EMPTY_PROFILE });
      }
      const [r] = await db().query(
        "SELECT username, email, address, bio, DATE_FORMAT(birthday, '%Y-%m-%d') AS birthday, pet, links, photo_url FROM profiles WHERE phone = ?", [who]);
      const [nm] = await db().query('SELECT name FROM users WHERE phone = ?', [who]);
      let hide = false;
      if (who !== me) { const [pr] = await db().query('SELECT privacy FROM profiles WHERE phone = ?', [who]); try { hide = !!JSON.parse((pr[0] && pr[0].privacy) || '{}').hidePhone; } catch (e) {} }
      return res.json({ profile: Object.assign({}, r[0] ? cleanRow(r[0]) : EMPTY_PROFILE, { name: nm[0] ? nm[0].name || '' : '', phone_hidden: hide }) });
    }

    if (b.action === 'profile_set') {
      const p = cleanProfile(b);
      if (p.error) return res.status(400).json({ error: p.error });
      try {
        await db().query(
          `INSERT INTO profiles (phone, username, email, address, bio, birthday, pet, links) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE username = VALUES(username), email = VALUES(email), address = VALUES(address),
             bio = VALUES(bio), birthday = VALUES(birthday), pet = VALUES(pet), links = VALUES(links)`,
          [me, p.username || null, p.email, p.address, p.bio, p.birthday || null, p.pet, p.links]);
        if (p.name) await db().query('UPDATE users SET name = ? WHERE phone = ?', [p.name, me]);
      } catch (e) {
        if (e && e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'That username is already taken.' });
        throw e;
      }
      const [nm2] = await db().query('SELECT name FROM users WHERE phone = ?', [me]);
      return res.json({ profile: { name: nm2[0] ? nm2[0].name || '' : '', username: p.username, email: p.email, address: p.address, bio: p.bio, birthday: p.birthday, pet: p.pet, links: p.links } });
    }

    // Profile pictures of other people (hidden when either side blocked the other).
    if (b.action === 'photos') {
      const list = Array.from(new Set((Array.isArray(b.phones) ? b.phones : []).filter(phoneOk))).slice(0, 80);
      if (!list.length) return res.json({ photos: {} });
      const [rows] = await db().query("SELECT phone, photo_url, privacy FROM profiles WHERE phone IN (?) AND photo_url <> ''", [list]);
      const out = {};
      await Promise.all(rows.map(async (r) => {
        if (r.phone !== me) {
          let pv = {}; try { pv = JSON.parse(r.privacy || '{}'); } catch (e) {}
          if (pv.photo === 'nobody') return;
          const bs = await blockState(me, r.phone); if (bs.iBlocked || bs.blockedMe) return;
        }
        out[r.phone] = r.photo_url;
      }));
      return res.json({ photos: out });
    }

    // Profile picture: the phone uploads it straight to Cloudinary (public image), the database keeps only the link.
    if (b.action === 'avatar_sign') {
      if (!cloudOn()) return res.status(500).json({ error: 'File storage is not set up on the server yet.' });
      const publicId = 'zucket/avatars/' + crypto.randomBytes(12).toString('hex');
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = cloud().utils.api_sign_request({ public_id: publicId, timestamp }, process.env.CLOUDINARY_API_SECRET);
      return res.json({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, timestamp, signature, public_id: publicId });
    }
    if (b.action === 'profile_photo_set') {
      const url = String(b.url || '');
      const okUrl = cloudOn() && url.length <= 300 && url.indexOf('https://res.cloudinary.com/' + process.env.CLOUDINARY_CLOUD_NAME + '/image/upload/') === 0;
      if (!okUrl) return res.status(400).json({ error: 'Bad request.' });
      await db().query('INSERT INTO profiles (phone, photo_url) VALUES (?, ?) ON DUPLICATE KEY UPDATE photo_url = VALUES(photo_url)', [me, url]);
      return res.json({ photo_url: url });
    }

    // Two-step verification PIN (needs an email on the profile, because email + PIN are used to recover chats).
    if (b.action === 'ts_status') {
      const [t] = await db().query('SELECT phone FROM two_step WHERE phone = ?', [me]);
      return res.json({ enabled: !!t[0] });
    }
    if (b.action === 'ts_set') {
      const pin = String(b.pin || '');
      if (!/^\d{6}$/.test(pin)) return res.status(400).json({ error: 'The PIN must be 6 digits.' });
      const [p] = await db().query('SELECT email FROM profiles WHERE phone = ?', [me]);
      if (!p[0] || !p[0].email) return res.status(400).json({ error: 'Please add your email address to be able to add Two-Step-Verification.', needEmail: true });
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = crypto.scryptSync(pin, salt, 32).toString('hex');
      await db().query('INSERT INTO two_step (phone, salt, hash) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE salt = VALUES(salt), hash = VALUES(hash)', [me, salt, hash]);
      return res.json({ enabled: true });
    }
    if (b.action === 'ts_off') {
      const [t] = await db().query('SELECT salt, hash FROM two_step WHERE phone = ?', [me]);
      if (!t[0]) return res.json({ enabled: false });
      const test = crypto.scryptSync(String(b.pin || ''), t[0].salt, 32);
      if (!crypto.timingSafeEqual(test, Buffer.from(t[0].hash, 'hex'))) return res.status(403).json({ error: 'Wrong PIN.' });
      await db().query('DELETE FROM two_step WHERE phone = ?', [me]);
      return res.json({ enabled: false });
    }

    if (b.action === 'group_create') {
      const name = String(b.name || '').trim().slice(0, 80);
      if (!name) return res.status(400).json({ error: 'Give the group a name.' });
      const wanted = Array.from(new Set((Array.isArray(b.members) ? b.members : []).filter((p) => phoneOk(p) && p !== me))).slice(0, MAX_GROUP - 1);
      if (!wanted.length) return res.status(400).json({ error: 'Add at least one member.' });
      const [found] = await db().query('SELECT phone FROM users WHERE phone IN (?)', [wanted]);
      const members = found.map((x) => x.phone);
      if (!members.length) return res.status(400).json({ error: 'None of those people are on Zanply.' });
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

    // Photos, videos, voice notes and files. The phone scrambles the file (one-to-one chats) and uploads it straight to
    // Cloudinary. The database only keeps a small record (who, which chat, Cloudinary id) so we can check who may open it.
    if (b.action === 'media_sign') {
      if (!cloudOn()) return res.status(500).json({ error: 'File storage is not set up on the server yet.' });
      const to = String(b.to || '');
      const size = Number(b.size) || 0;
      if (size < 1) return res.status(400).json({ error: 'Bad request.' });
      if (size > MEDIA_MAX) return res.status(413).json({ error: 'That file is too big. The limit is 10 MB.' });
      if (isGroup(to)) {
        if (!(await isMember(gid(to), me))) return res.status(403).json({ error: 'You are not in this group.' });
      } else {
        if (!phoneOk(to) || !(await findUser(to))) return res.status(404).json({ error: "That number isn't on Zanply yet." });
        const bs = await blockState(me, to);
        if (bs.iBlocked) return res.status(403).json({ error: 'You blocked this contact. Unblock them to send messages.', blocked: true });
        if (bs.blockedMe) return res.status(403).json({ error: "You can't message this person." });
      }
      const publicId = 'zucket/' + crypto.randomBytes(16).toString('hex');
      const [r] = await db().query('INSERT INTO cloud_media (owner, peer, size, public_id) VALUES (?, ?, ?, ?)', [me, to, size, publicId]);
      const timestamp = Math.floor(Date.now() / 1000);
      const params = { public_id: publicId, timestamp, type: 'authenticated' };
      const signature = cloud().utils.api_sign_request(params, process.env.CLOUDINARY_API_SECRET);
      return res.json({ id: r.insertId, cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, timestamp, signature, public_id: publicId, type: 'authenticated' });
    }

    if (b.action === 'media_get') {
      const id = Number(b.id);
      if (!id) return res.status(400).json({ error: 'Bad request.' });
      if (b.c) {
        if (!cloudOn()) return res.status(500).json({ error: 'File storage is not set up on the server yet.' });
        const [m] = await db().query('SELECT owner, peer, public_id FROM cloud_media WHERE id = ?', [id]);
        const row = m[0];
        const allowed = row && (row.owner === me || row.peer === me || (isGroup(row.peer) && (await isMember(gid(row.peer), me))));
        if (!allowed) return res.status(404).json({ error: 'File not found.' });
        const url = cloud().url(row.public_id, { resource_type: 'raw', type: 'authenticated', sign_url: true, secure: true });
        return res.json({ url });
      }
      // Old files sent before the move to Cloudinary are still readable from the database.
      const [m] = await db().query('SELECT owner, peer, data FROM media WHERE id = ?', [id]);
      const row = m[0];
      const allowed = row && (row.owner === me || row.peer === me || (isGroup(row.peer) && (await isMember(gid(row.peer), me))));
      if (!allowed) return res.status(404).json({ error: 'File not found.' });
      return res.json({ data: Buffer.from(row.data).toString('base64') });
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

    if (b.action === 'fcmreg') {
      const ft = typeof b.ftoken === 'string' ? b.ftoken.trim() : '';
      if (ft.length < 20 || ft.length > 500) return res.status(400).json({ error: 'Bad request.' });
      await fcmTable();
      await db().query('INSERT INTO fcm_tokens (phone, hash, token) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE phone = VALUES(phone), token = VALUES(token)', [me, sha(ft), ft]);
      return res.json({ ok: true, server: fcmOn() });
    }

    if (b.action === 'fcmunreg') {
      if (typeof b.ftoken === 'string') { await fcmTable(); await db().query('DELETE FROM fcm_tokens WHERE hash = ? AND phone = ?', [sha(b.ftoken.trim()), me]); }
      return res.json({ ok: true });
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
