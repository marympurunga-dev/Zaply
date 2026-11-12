// POST /api/chat  — actions: list, start, history, send, media_sign, media_get, block, unblock, blockstate, report, setkey, getkey,
//                           group_create, group_info, group_leave (groups are chats with the id "g:<number>"),
//                           profile_get, profile_set (username, email, address, bio, birthday, pet),
//                           status_list, status_post, status_sign, status_view, status_like, status_delete (24-hour status updates),
//                           presence_ping, presence_get, presence_bulk (online / last seen), ably_auth (real-time token)
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
      db().query(`CREATE TABLE IF NOT EXISTS saved_contacts (
        owner VARCHAR(20) NOT NULL,
        phone VARCHAR(20) NOT NULL,
        PRIMARY KEY (owner, phone),
        INDEX idx_phone (phone))`),
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
      await db().query("ALTER TABLE profiles MODIFY COLUMN links VARCHAR(700) NOT NULL DEFAULT ''").catch(() => {});
      await db().query("ALTER TABLE profiles ADD COLUMN extra TEXT NULL").catch(() => {});
      await db().query("ALTER TABLE chat_groups MODIFY COLUMN name VARCHAR(255) NOT NULL").catch(() => {});
      // channels: one row per channel, one row per subscriber (posts are stored once, never copied per subscriber)
      await db().query(`CREATE TABLE IF NOT EXISTS channels (
        id INT AUTO_INCREMENT PRIMARY KEY, owner VARCHAR(20) NOT NULL, name VARCHAR(120) NOT NULL, description VARCHAR(500) NOT NULL DEFAULT '',
        photo_url VARCHAR(300) NOT NULL DEFAULT '', subscribers INT NOT NULL DEFAULT 1, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX idx_o (owner))`).catch(() => {});
      await db().query(`CREATE TABLE IF NOT EXISTS channel_subs (
        channel_id INT NOT NULL, phone VARCHAR(20) NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (channel_id, phone), INDEX idx_p (phone))`).catch(() => {});
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
      /* status updates: disappear after 24 hours */
      await db().query(`CREATE TABLE IF NOT EXISTS statuses (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        owner VARCHAR(20) NOT NULL,
        type VARCHAR(10) NOT NULL DEFAULT 'text',
        text VARCHAR(800) NOT NULL DEFAULT '',
        bg VARCHAR(7) NOT NULL DEFAULT '#128c7e',
        url VARCHAR(300) NOT NULL DEFAULT '',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_st_owner (owner, id),
        INDEX idx_st_exp (expires_at))`).catch((e) => console.error(e));
      await db().query(`CREATE TABLE IF NOT EXISTS status_views (
        status_id BIGINT NOT NULL, viewer VARCHAR(20) NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (status_id, viewer), INDEX idx_sv_viewer (viewer))`).catch((e) => console.error(e));
      await db().query(`CREATE TABLE IF NOT EXISTS status_likes (
        status_id BIGINT NOT NULL, viewer VARCHAR(20) NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (status_id, viewer))`).catch((e) => console.error(e));
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
const { fcmOn, fcmWhy, sendFcm } = require('./_fcm');
const rt = require('./_realtime');
const phoneOk = (p) => typeof p === 'string' && /^\+\d{7,15}$/.test(p);
// Business accounts are shown to other people by their business name; personal accounts by their personal name.
async function displayNames(phones) {
  const out = {};
  if (!phones || !phones.length) return out;
  const [u] = await db().query('SELECT phone, name FROM users WHERE phone IN (?)', [phones]);
  u.forEach((x) => { out[x.phone] = x.name; });
  try {
    const [p] = await db().query('SELECT phone, extra FROM profiles WHERE phone IN (?) AND extra IS NOT NULL', [phones]);
    p.forEach((x) => { const e = parseExtra(x.extra); if (e.acct === 'business' && e.biz && e.biz.name) out[x.phone] = e.biz.name; });
  } catch (e) {}
  return out;
}
async function findUser(phone) {
  const [r] = await db().query('SELECT phone, name FROM users WHERE phone = ?', [phone]);
  if (!r[0]) return null;
  const n = await displayNames([phone]).catch(() => ({}));
  return { phone: r[0].phone, name: n[phone] || r[0].name };
}

const EMPTY_PROFILE = { name: '', username: '', email: '', address: '', bio: '', birthday: '', pet: '', links: '', photo_url: '', acct: 'personal', biz: null };
// the "extra" column holds the account type and the business profile as JSON
const NAME_STYLES = ['bold', 'italic', 'serif', 'script', 'mono', 'grad'];
function parseExtra(raw) {
  let o = {}; try { o = JSON.parse(raw || '{}') || {}; } catch (e) { o = {}; }
  return { acct: o.acct === 'business' ? 'business' : 'personal', biz: o.biz && typeof o.biz === 'object' ? o.biz : null,
    pstyle: NAME_STYLES.indexOf(o.pstyle) > -1 ? o.pstyle : '', pcolor: /^#[0-9a-f]{6}$/i.test(String(o.pcolor || '')) ? String(o.pcolor) : '', pset: o.pset && typeof o.pset === 'object' ? o.pset : {} };
}
const cleanRow = (r) => Object.assign({ username: r.username || '', email: r.email || '', address: r.address || '', bio: r.bio || '', birthday: r.birthday || '', pet: r.pet || '', links: r.links || '', photo_url: r.photo_url || '' }, parseExtra(r.extra));
// trims, and cuts to a number of characters (emoji count as one)
const clip = (v, n) => Array.from(String(v == null ? '' : v).trim()).slice(0, n).join('');
// a link must look like a web address; "chris.com" becomes "https://chris.com"
function cleanLink(v, max) {
  let t = clip(v, max || 200).replace(/\s+/g, '');
  if (!t) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) t = 'https://' + t;
  if (!/^https?:\/\/[^\s\/?#.]+\.[^\s]{2,}$/i.test(t) && !/^https?:\/\/localhost/i.test(t)) return null;
  return t;
}
// "CHRIS" / "chRIS" -> "Chris"; letters (any language) and single spaces only, up to 40 letters
function cleanName(v) {
  const t = String(v == null ? '' : v).replace(/[^\p{L}\s]/gu, '').replace(/\s+/g, ' ').trim();
  return Array.from(t).slice(0, 40).join('').split(' ').map((w) => { const a = Array.from(w.toLowerCase()); return a.length ? a[0].toUpperCase() + a.slice(1).join('') : ''; }).join(' ');
}
function cleanBiz(b) {
  if (b === null) return { biz: null };
  if (!b || typeof b !== 'object') return { biz: undefined };
  const out = { name: clip(b.name, 60), username: clip(b.username, 31).replace(/^@/, '').toLowerCase(), email: clip(b.email, 120), address: clip(b.address, 160),
    link: '', cat: clip(b.cat, 60), catOther: clip(b.catOther, 60), links: [], social: {},
    // "what does the business do" (204 letters) and opening days / hours shown to other people
    bio: clip(b.bio, 204),
    days: (Array.isArray(b.days) ? b.days : []).filter((d, i, a) => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].includes(d) && a.indexOf(d) === i),
    from: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(b.from || '')) ? String(b.from) : '',
    to: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(b.to || '')) ? String(b.to) : '',
    open24: !!b.open24 };
  if (out.username && !/^[a-z0-9.]{3,30}$/.test(out.username)) return { error: 'Business username must be 3 to 30 letters, numbers or dots.' };
  if (out.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(out.email)) return { error: 'That business email doesn’t look right.' };
  if (b.link) { const l = cleanLink(b.link); if (l === null) return { error: 'That business link doesn’t look right.' }; out.link = l; }
  for (const raw of (Array.isArray(b.links) ? b.links : []).slice(0, 5)) {
    if (!String(raw || '').trim()) continue;
    const l = cleanLink(raw); if (l === null) return { error: 'One of the business links doesn’t look right.' }; out.links.push(l);
  }
  const soc = b.social && typeof b.social === 'object' ? b.social : {};
  for (const k of Object.keys(soc).slice(0, 40)) {
    if (!/^[a-z0-9_]{2,20}$/.test(k) || !String(soc[k] || '').trim()) continue;
    const l = cleanLink(soc[k]); if (l === null) return { error: 'One of the social media links doesn’t look right.' }; out.social[k] = l;
  }
  return { biz: out };
}
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
  let name;
  if (b.name !== undefined) { name = cleanName(b.name); if (!name) return { error: 'Enter your name using letters only.' }; }
  // up to 3 links, one per line
  const linkList = [];
  for (const raw of String(b.links || '').split(/\n/).slice(0, 3)) {
    if (!raw.trim()) continue;
    const l = cleanLink(raw); if (l === null) return { error: 'One of the links doesn’t look right.' }; linkList.push(l);
  }
  const biz = cleanBiz(b.biz); if (biz.error) return { error: biz.error };
  const acct = b.acct === undefined ? undefined : (b.acct === 'business' ? 'business' : 'personal');
  return { name, username, email, address: clip(b.address, 120), bio: clip(b.bio, 114), birthday, pet: clip(b.pet, 40), links: linkList.join('\n'), acct, biz: biz.biz };
}
const sha = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');
const MAX_GROUP = 100000; // free: 100,000 members
const MAX_GROUP_PREM = 1000000; // Premium: 1M members
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
// Zanply Premium: one bundle. A row means the person has (or had) a plan; it counts while until_at is in the future.
let premReady = null;
function premTable() {
  if (!premReady) premReady = db().query('CREATE TABLE IF NOT EXISTS premium (phone VARCHAR(20) NOT NULL PRIMARY KEY, plan VARCHAR(10) NOT NULL, until_at DATETIME NOT NULL, renew TINYINT NOT NULL DEFAULT 1, updated TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)').catch((e) => { premReady = null; throw e; });
  return premReady;
}
let wallReady = null;
function wallTable() {
  if (!wallReady) wallReady = db().query('CREATE TABLE IF NOT EXISTS chat_walls (owner VARCHAR(20) NOT NULL, peer VARCHAR(20) NOT NULL, css MEDIUMTEXT NOT NULL, kind VARCHAR(12) NOT NULL DEFAULT \'\', updated TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, PRIMARY KEY (owner, peer))').catch((e) => { wallReady = null; throw e; });
  return wallReady;
}
let stColsReady = null;
function statusCols() {
  if (!stColsReady) stColsReady = db().query("ALTER TABLE statuses ADD COLUMN music VARCHAR(300) NOT NULL DEFAULT ''").catch(() => {}).then(() => db().query("ALTER TABLE statuses ADD COLUMN music_name VARCHAR(120) NOT NULL DEFAULT ''").catch(() => {}));
  return stColsReady;
}
async function isPremium(phone) {
  try { await premTable(); const [r] = await db().query('SELECT 1 FROM premium WHERE phone = ? AND until_at > NOW()', [phone]); return r.length > 0; } catch (e) { return false; }
}
async function premInfo(phone) {
  try { await premTable(); const [r] = await db().query('SELECT plan, until_at, renew FROM premium WHERE phone = ? AND until_at > NOW()', [phone]); if (r[0]) return { active: true, plan: r[0].plan, until: new Date(r[0].until_at).toISOString(), renew: !!r[0].renew }; } catch (e) {}
  return { active: false };
}
let fcmReady = null;
function fcmTable() {
  if (!fcmReady) fcmReady = db().query('CREATE TABLE IF NOT EXISTS fcm_tokens (id BIGINT AUTO_INCREMENT PRIMARY KEY, phone VARCHAR(20) NOT NULL, hash CHAR(64) NOT NULL, token VARCHAR(512) NOT NULL, updated TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, UNIQUE KEY uq_h (hash), INDEX idx_p (phone))').then(() => db().query("ALTER TABLE fcm_tokens ADD COLUMN chan VARCHAR(80) NOT NULL DEFAULT ''").catch(() => {})).catch((e) => { fcmReady = null; throw e; });
  return fcmReady;
}
async function fcmPush(rows, data, opts) {
  if (!rows.length) return;
  const dead = await sendFcm(rows, data, opts);
  if (dead.length) await db().query('DELETE FROM fcm_tokens WHERE id IN (' + dead.map(() => '?').join(',') + ')', dead);
}
async function senderPhoto(from, to) {
  try {
    const [r] = await db().query("SELECT photo_url, privacy FROM profiles WHERE phone = ? AND photo_url <> ''", [from]);
    if (!r.length || !/^https:\/\//.test(r[0].photo_url)) return '';
    const pv = parsePv(r[0].privacy);
    if (pv.photo === 'nobody') return '';
    if (pv.photo === 'contacts') {
      const [sv] = await db().query('SELECT 1 FROM saved_contacts WHERE owner = ? AND phone = ? LIMIT 1', [from, to]);
      if (!sv.length) return '';
    }
    return r[0].photo_url;
  } catch (e) { return ''; }
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
      const [rows] = await db().query('SELECT t.id, t.token, t.chan FROM fcm_tokens t JOIN group_members m ON m.phone = t.phone WHERE m.group_id = ? AND t.phone <> ?', [g, from]);
      await fcmPush(rows, { type: 'msg', title: groupName, body, sender: 'g:' + g });
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
      const [rows] = await db().query('SELECT id, token, chan FROM fcm_tokens WHERE phone = ?', [to]);
      if (isCall) {
        let video = '0'; try { video = JSON.parse(String(text).slice(8)).v ? '1' : '0'; } catch (e) {}
        await fcmPush(rows, { type: 'call', title: name, body: 'Incoming call', sender: from, name, video, call: String(text) }, { ttl: '45s' });
      } else {
        // 'cipher' is still scrambled text (the server cannot read it). The Android app opens it on the phone to show the real message.
        const cipher = String(text).indexOf('e2e1:') === 0 && String(text).length <= 2500 ? String(text) : '';
        await fcmPush(rows, { type: 'msg', title: name, body: preview(text), sender: from, photo: await senderPhoto(from, to), cipher, me: to });
      }
    }
  } catch (e) { console.error(e); }
}

/* ---- last seen / online rules ----
   last seen:  everyone = anyone who has a chat with me | contacts = people I saved in my contacts | nobody = no one
   online:     everyone | contacts | same (= follows the last seen rule, so "nobody" hides online too)
   Old saved values: "except" counts as "contacts". */
function parsePv(raw) { try { return JSON.parse(raw || '{}') || {}; } catch (e) { return {}; } }
const lsRule = (pv) => (pv.lastseen === 'nobody' ? 'nobody' : pv.lastseen === 'contacts' || pv.lastseen === 'except' ? 'contacts' : 'everyone');
const onRule = (pv) => (pv.online === 'same' ? 'same' : pv.online === 'contacts' ? 'contacts' : 'everyone');
/* how does `viewer` stand with `owner`? */
async function relation(owner, viewer) {
  const [s] = await db().query('SELECT 1 FROM saved_contacts WHERE owner = ? AND phone = ? LIMIT 1', [owner, viewer]);
  const [c] = await db().query('SELECT 1 FROM messages WHERE (sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?) LIMIT 1', [owner, viewer, viewer, owner]);
  return { saved: s.length > 0, chat: c.length > 0 || s.length > 0 };
}
function rulePass(rule, rel) { return rule === 'everyone' ? rel.chat : rule === 'contacts' ? rel.saved : false; }
/* what may `viewer` see about `owner`? */
async function presenceAccess(owner, ownerPrivacyRaw, viewer) {
  const pv = parsePv(ownerPrivacyRaw), rel = await relation(owner, viewer), lr = lsRule(pv), or = onRule(pv);
  const canLast = rulePass(lr, rel);
  const canOnline = or === 'everyone' ? true : or === 'contacts' ? rel.saved : canLast;
  return { canLast, canOnline };
}

/* which of these people may I watch live (online / last seen)? Same privacy rules as presence_bulk. */
async function watchAllowed(me, list) {
  if (!list.length) return [];
  const [rows] = await db().query('SELECT phone, privacy FROM profiles WHERE phone IN (?)', [list]);
  const pr = {}; rows.forEach((r) => { pr[r.phone] = r.privacy; });
  const out = [];
  await Promise.all(list.map(async (p) => {
    const bs = await blockState(me, p); if (bs.iBlocked || bs.blockedMe) return;
    const acc = await presenceAccess(p, pr[p], me);
    if (acc.canOnline) out.push(p);
  }));
  return out;
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
      let waiting = [];
      if (rt.on()) { const [ws] = await db().query('SELECT DISTINCT sender FROM messages WHERE receiver = ? AND delivered_at IS NULL', [me]).catch(() => [[]]); waiting = ws.map((x) => x.sender); }
      await db().query('UPDATE messages SET delivered_at = NOW() WHERE receiver = ? AND delivered_at IS NULL', [me]).catch(() => {});
      if (waiting.length) await rt.signal(waiting, 'tick', { from: me });
      const [last] = await db().query(
        `SELECT id, sender, receiver, body, created_at, delivered_at, read_at FROM messages
         WHERE id IN (SELECT MAX(id) FROM messages WHERE sender = ? OR receiver = ?
                      GROUP BY IF(sender = ?, receiver, sender))
         ORDER BY id DESC LIMIT 100`, [me, me, me]);
      const others = last.map((m) => (m.sender === me ? m.receiver : m.sender));
      let names = {}, unames = {};
      if (others.length) {
        names = await displayNames(others);
        const [un] = await db().query('SELECT phone, username, extra FROM profiles WHERE phone IN (?) AND username IS NOT NULL', [others]).catch(() => [[]]);
        un.forEach((x) => { if (parseExtra(x.extra).acct !== 'business') unames[x.phone] = x.username; });
      }
      const chats = last.map((m, i) => ({
        phone: others[i], name: names[others[i]] || '', username: unames[others[i]] || '', last: m.body,
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
        gnames = await displayNames(senders);
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
      try { const [pr] = await db().query('SELECT username, extra FROM profiles WHERE phone = ?', [b.phone]); if (pr && pr[0] && pr[0].username && parseExtra(pr[0].extra).acct !== 'business') u.username = pr[0].username; } catch (e) {}
      return res.json({ user: u });
    }

    if (b.action === 'history') {
      const after = Number(b.after) || 0;
      if (isGroup(b.with)) {
        if (!(await isMember(gid(b.with), me))) return res.status(403).json({ error: 'You are not in this group.' });
        const [gr] = await db().query(
          `SELECT gm.id, gm.sender, gm.body, gm.created_at FROM group_messages gm
           WHERE gm.group_id = ? AND gm.id > ? ORDER BY gm.id ASC LIMIT 200`, [gid(b.with), after]);
        const gdn = await displayNames([...new Set(gr.map((m) => m.sender))]);
        return res.json({ messages: gr.map((m) => ({
          id: m.id, mine: m.sender === me, body: m.body, at: m.created_at, from: gdn[m.sender] || m.sender })) });
      }
      if (!phoneOk(b.with)) return res.status(400).json({ error: 'Bad request.' });
      /* the chat is open on my screen, so what they sent me is read (blue ticks for them) */
      const upd = await db().query(
        'UPDATE messages SET delivered_at = COALESCE(delivered_at, NOW()), read_at = NOW() WHERE receiver = ? AND sender = ? AND read_at IS NULL',
        [me, b.with]).catch(() => null);
      if (upd && upd[0] && upd[0].affectedRows) await rt.signal([b.with], 'tick', { from: me });
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
        if (rt.on()) { const [gm] = await db().query('SELECT phone FROM group_members WHERE group_id = ? AND phone <> ?', [g, me]); await rt.signal(gm.map((x) => x.phone), 'msg', { from: 'g:' + g }); }
        await notifyGroup(me, g, (gn[0] && gn[0].name) || 'Group', body);
        return res.json({ message: { id: gr.insertId, mine: true, body, at: new Date().toISOString(), from: '' } });
      }
      if (!phoneOk(b.to) || !body) return res.status(400).json({ error: 'Bad request.' });
      if (!(await findUser(b.to))) return res.status(404).json({ error: "That number isn't on Zanply yet." });
      const bs = await blockState(me, b.to);
      if (bs.iBlocked) return res.status(403).json({ error: 'You blocked this contact. Unblock them to send messages.', blocked: true });
      if (bs.blockedMe) return res.status(403).json({ error: "You can't message this person." });
      const [r] = await db().query('INSERT INTO messages (sender, receiver, body) VALUES (?, ?, ?)', [me, b.to, body]);
      await rt.signal([b.to], 'msg', { from: me });
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
        lastseen: pv.lastseen === 'except' ? 'contacts' : ['everyone', 'contacts', 'nobody'].includes(pv.lastseen) ? pv.lastseen : 'everyone', online: ['everyone', 'contacts', 'same'].includes(pv.online) ? pv.online : 'everyone',
        photo: ok.includes(pv.photo) ? pv.photo : 'everyone', hidePhone: !!pv.hidePhone,
        ex: { lastseen: (pv.ex && Array.isArray(pv.ex.lastseen) ? pv.ex.lastseen : []).filter(phoneOk).slice(0, 60), photo: (pv.ex && Array.isArray(pv.ex.photo) ? pv.ex.photo : []).filter(phoneOk).slice(0, 60) }
      };
      await db().query('INSERT INTO profiles (phone, privacy) VALUES (?, ?) ON DUPLICATE KEY UPDATE privacy = VALUES(privacy)', [me, JSON.stringify(clean)]);
      return res.json({ ok: true });
    }
    // Real-time token (Ably). Only the channels this person is allowed to watch go into it.
    if (b.action === 'ably_auth') {
      if (!rt.on()) return res.status(503).json({ error: 'Real-time is not set up.' });
      const want = Array.from(new Set((Array.isArray(b.watch) ? b.watch : []).filter(phoneOk))).filter((p) => p !== me).slice(0, 40);
      try {
        return res.json({ token: await rt.tokenRequest(me, await watchAllowed(me, want)) });
      } catch (e) {
        console.error('ably_auth failed', e);
        return res.status(500).json({ error: 'Real-time token failed: ' + String((e && e.message) || e).slice(0, 160) });
      }
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
      const [mine] = await db().query('SELECT privacy FROM profiles WHERE phone = ?', [me]);
      const myLast = lsRule(parsePv(mine[0] && mine[0].privacy)) !== 'nobody'; /* if I hide my own last seen, I can't see other people's last seen either (online is still shown) */
      const [rows] = await db().query('SELECT privacy, last_active, (is_online = 1 AND last_active > NOW() - INTERVAL 60 SECOND) AS online FROM profiles WHERE phone = ?', [who]);
      const r = rows[0];
      if (!r || !r.last_active) return res.json({ hidden: false, online: false, last: null });
      const acc = await presenceAccess(who, r.privacy, me);
      const online = acc.canOnline && Number(r.online) === 1;
      return res.json({ hidden: false, online, last: acc.canLast && myLast && !online ? r.last_active : null });
    }
    // Who is online right now, for the chat list (green dot). Same privacy rules as presence_get.
    if (b.action === 'presence_bulk') {
      const list = Array.from(new Set((Array.isArray(b.phones) ? b.phones : []).filter(phoneOk))).filter((p) => p !== me).slice(0, 80);
      if (!list.length) return res.json({ online: {} });
      const [rows] = await db().query('SELECT phone, privacy FROM profiles WHERE phone IN (?) AND is_online = 1 AND last_active > NOW() - INTERVAL 60 SECOND', [list]);
      const out = {};
      await Promise.all(rows.map(async (r) => {
        const bs = await blockState(me, r.phone); if (bs.iBlocked || bs.blockedMe) return;
        const acc = await presenceAccess(r.phone, r.privacy, me);
        if (acc.canOnline) out[r.phone] = 1;
      }));
      return res.json({ online: out });
    }
    // The phone tells the server which numbers are saved in this person's contacts (needed for the "My contacts" privacy choice).
    if (b.action === 'contacts_sync') {
      const list = Array.from(new Set((Array.isArray(b.phones) ? b.phones : []).filter(phoneOk))).filter((p) => p !== me).slice(0, 3000);
      await db().query('DELETE FROM saved_contacts WHERE owner = ?', [me]);
      for (let i = 0; i < list.length; i += 500) {
        const part = list.slice(i, i + 500);
        await db().query('INSERT IGNORE INTO saved_contacts (owner, phone) VALUES ' + part.map(() => '(?, ?)').join(','), part.flatMap((p) => [me, p]));
      }
      return res.json({ ok: true, n: list.length });
    }
    if (b.action === 'blocklist') {
      const [r] = await db().query('SELECT b.blocked AS phone FROM blocks b WHERE b.blocker = ? ORDER BY b.created_at DESC', [me]);
      const bdn = await displayNames(r.map((x) => x.phone));
      return res.json({ blocked: r.map((x) => ({ phone: x.phone, name: bdn[x.phone] || '' })) });
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
        "SELECT username, email, address, bio, DATE_FORMAT(birthday, '%Y-%m-%d') AS birthday, pet, links, photo_url, extra FROM profiles WHERE phone = ?", [who]);
      const [nm] = await db().query('SELECT name FROM users WHERE phone = ?', [who]);
      let hide = false;
      if (who !== me) { const [pr] = await db().query('SELECT privacy FROM profiles WHERE phone = ?', [who]); try { hide = !!JSON.parse((pr[0] && pr[0].privacy) || '{}').hidePhone; } catch (e) {} }
      const pv = await premInfo(who);
      return res.json({ profile: Object.assign({}, r[0] ? cleanRow(r[0]) : EMPTY_PROFILE, { name: nm[0] ? nm[0].name || '' : '', display_name: (await displayNames([who]).catch(() => ({})))[who] || (nm[0] ? nm[0].name || '' : ''), phone_hidden: hide, verified: !!pv.active, pstyle: pv.active && r[0] ? parseExtra(r[0].extra).pstyle : '', pcolor: pv.active && r[0] ? parseExtra(r[0].extra).pcolor : '' }) });
    }

    if (b.action === 'profile_set') {
      const p = cleanProfile(b);
      if (p.error) return res.status(400).json({ error: p.error });
      let ex = { acct: 'personal', biz: null };
      try { const [cur] = await db().query('SELECT extra FROM profiles WHERE phone = ?', [me]); ex = parseExtra(cur && cur[0] && cur[0].extra); } catch (e) {}
      if (p.acct !== undefined) ex.acct = p.acct;
      if (p.biz !== undefined) ex.biz = p.biz;
      try {
        await db().query(
          `INSERT INTO profiles (phone, username, email, address, bio, birthday, pet, links, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE username = VALUES(username), email = VALUES(email), address = VALUES(address),
             bio = VALUES(bio), birthday = VALUES(birthday), pet = VALUES(pet), links = VALUES(links), extra = VALUES(extra)`,
          [me, p.username || null, p.email, p.address, p.bio, p.birthday || null, p.pet, p.links, JSON.stringify(ex)]);
        if (p.name) await db().query('UPDATE users SET name = ? WHERE phone = ?', [p.name, me]);
      } catch (e) {
        if (e && e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'That username is already taken.' });
        throw e;
      }
      const [nm2] = await db().query('SELECT name FROM users WHERE phone = ?', [me]);
      return res.json({ profile: { name: nm2[0] ? nm2[0].name || '' : '', username: p.username, email: p.email, address: p.address, bio: p.bio, birthday: p.birthday, pet: p.pet, links: p.links, acct: ex.acct, biz: ex.biz } });
    }

    // ---- Premium effects: verified badge + name style/colour for many phones, wallpaper for both sides ----
    if (b.action === 'premium_bulk') {
      const ph = (Array.isArray(b.phones) ? b.phones : []).filter(phoneOk).slice(0, 100);
      if (!ph.length) return res.json({ premium: {} });
      await premTable();
      const [rows] = await db().query('SELECT p.phone, pr.extra FROM premium p LEFT JOIN profiles pr ON pr.phone = p.phone WHERE p.until_at > NOW() AND p.phone IN (?)', [ph]);
      const out = {};
      rows.forEach((r) => { const ex = parseExtra(r.extra); out[r.phone] = { s: ex.pstyle, c: ex.pcolor }; });
      return res.json({ premium: out });
    }
    if (b.action === 'profile_style_set') {
      if (!(await isPremium(me))) return res.status(403).json({ error: 'Name styles and profile colours are part of Zanply Premium.', premium: true });
      const st = NAME_STYLES.indexOf(b.pstyle) > -1 ? b.pstyle : '', co = /^#[0-9a-f]{6}$/i.test(String(b.pcolor || '')) ? String(b.pcolor) : '';
      let ex = parseExtra(null);
      try { const [cur] = await db().query('SELECT extra FROM profiles WHERE phone = ?', [me]); ex = parseExtra(cur && cur[0] && cur[0].extra); } catch (e) {}
      ex.pstyle = st; ex.pcolor = co;
      await db().query('INSERT INTO profiles (phone, extra) VALUES (?, ?) ON DUPLICATE KEY UPDATE extra = VALUES(extra)', [me, JSON.stringify(ex)]);
      return res.json({ ok: true, pstyle: st, pcolor: co });
    }
    if (b.action === 'wall_set') {
      const to = String(b.to || '');
      if (!phoneOk(to)) return res.status(400).json({ error: 'Bad request.' });
      if (!(await isPremium(me))) return res.status(403).json({ error: 'Wallpaper for both sides is part of Zanply Premium.', premium: true });
      await wallTable();
      const css = String(b.css || '');
      if (!css) { await db().query('DELETE FROM chat_walls WHERE owner = ? AND peer = ?', [me, to]); return res.json({ ok: true }); }
      if (css.length > 200000) return res.status(413).json({ error: 'That wallpaper is too large to share. Pick a preset or a smaller picture.' });
      if (/url\(\s*['"]?\s*(?!data:image\/)/i.test(css) || /[<>]|expression|javascript:/i.test(css)) return res.status(400).json({ error: 'That wallpaper cannot be shared.' });
      await db().query('INSERT INTO chat_walls (owner, peer, css, kind) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE css = VALUES(css), kind = VALUES(kind)', [me, to, css, String(b.k || '').slice(0, 12)]);
      return res.json({ ok: true });
    }
    if (b.action === 'wall_get') {
      const peer = String(b.peer || '');
      if (!phoneOk(peer)) return res.status(400).json({ error: 'Bad request.' });
      const bs = await blockState(me, peer);
      if (bs.iBlocked || bs.blockedMe || !(await isPremium(peer))) return res.json({ wall: null });
      await wallTable();
      const [r] = await db().query('SELECT css, kind FROM chat_walls WHERE owner = ? AND peer = ?', [peer, me]);
      return res.json({ wall: r[0] ? { css: r[0].css, k: r[0].kind } : null });
    }

    // Is a username free? If not, five different names built from what the person typed.
    if (b.action === 'username_check') {
      const want = clip(b.username, 31).replace(/^@/, '').toLowerCase();
      if (!/^[a-z0-9.]{3,30}$/.test(want)) return res.status(400).json({ error: 'Username must be 3 to 30 letters, numbers or dots.' });
      const taken = async (names) => {
        const [r] = await db().query('SELECT username, phone FROM profiles WHERE username IN (?)', [names]);
        return r || [];
      };
      const rows = await taken([want]);
      const mine = rows.some((r) => r.phone === me);
      if (!rows.length || mine) return res.json({ available: true, username: want, suggestions: [] });
      const base = want.replace(/\.+$/, '').slice(0, 24), pool = [];
      const add = (x) => { x = x.slice(0, 30); if (/^[a-z0-9.]{3,30}$/.test(x) && x !== want && !pool.includes(x)) pool.push(x); };
      [base + '.official', base + '.' + (Math.floor(Math.random() * 90) + 10), base + (Math.floor(Math.random() * 900) + 100), 'the.' + base, base + '.' + new Date().getFullYear() % 100,
        base + '_', base + '.app', 'real.' + base, base + (Math.floor(Math.random() * 9000) + 1000), base + '.z', 'its.' + base, base + '.hq'].forEach(add);
      const used = new Set((await taken(pool)).map((r) => r.username));
      return res.json({ available: false, username: want, suggestions: pool.filter((x) => !used.has(x)).slice(0, 5) });
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
      const okUrl = cloudOn() && url.length <= 300 && url.indexOf('https://res.cloudinary.com/' + process.env.CLOUDINARY_CLOUD_NAME + '/' + 'image' + '/upload/') === 0;
      if (!okUrl) return res.status(400).json({ error: 'Bad request.' });
      await db().query('INSERT INTO profiles (phone, photo_url) VALUES (?, ?) ON DUPLICATE KEY UPDATE photo_url = VALUES(photo_url)', [me, url]);
      return res.json({ photo_url: url });
    }

    if (b.action === 'profile_photo_delete') {
      await db().query("UPDATE profiles SET photo_url = '' WHERE phone = ?", [me]);
      return res.json({ photo_url: '' });
    }

    // Zanply Premium. Real payments are not connected yet: activation only works while PREMIUM_TEST_MODE=1 is set in Vercel.
    if (b.action === 'premium_status') { const i = await premInfo(me); return res.json(Object.assign({}, i, { expires: i.until })); }
    if (b.action === 'premium_autorenew') {
      await premTable(); await db().query('UPDATE premium SET renew = ? WHERE phone = ?', [b.on ? 1 : 0, me]);
      const i = await premInfo(me); return res.json(Object.assign({}, i, { expires: i.until }));
    }
    // Premium checkout (Paystack: cards + M-Pesa in Kenya). Needs PAYSTACK_SECRET_KEY (and optional PAYSTACK_CALLBACK) in Vercel.
    if (b.action === 'premium_checkout') {
      const usd = { monthly: 3.99, six: 19.99, annual: 29.99 }[b.plan];
      if (!usd) return res.status(400).json({ error: 'Bad request.' });
      if (!process.env.PAYSTACK_SECRET_KEY) return res.status(402).json({ error: 'Payments are being connected. No charge was made.' });
      const rate = { KES: 129, NGN: 1600, GHS: 15, ZAR: 18, USD: 1 }, cur = rate[b.currency] ? b.currency : 'USD';
      const em = await db().query('SELECT email FROM profiles WHERE phone = ?', [me]).then((r) => (r[0][0] && r[0][0].email) || '').catch(() => '');
      const r = await fetch('https://api.paystack.co/transaction/initialize', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.PAYSTACK_SECRET_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: em || (me + '@zanply.app'), amount: Math.round(usd * rate[cur] * 100), currency: cur, callback_url: process.env.PAYSTACK_CALLBACK || undefined, metadata: { phone: me, plan: b.plan } }) });
      const j = await r.json().catch(() => ({}));
      if (!j.status || !j.data) return res.status(502).json({ error: 'Could not start payment. No charge was made.' });
      return res.json({ url: j.data.authorization_url });
    }
    // Stealth / auto-reply / backup settings. Typing "contacts"/"nobody" is free; everything else here is Premium.
    if (b.action === 'premium_setting') {
      const K = ['typ_see', 'typ_view', 'hide_online', 'hide_typing', 'hide_ticks', 'hide_seen', 'ar_on', 'ar_msg', 'ar_when', 'cloud_unlimited'];
      const key = String(b.key || ''); if (K.indexOf(key) < 0) return res.status(400).json({ error: 'Bad request.' });
      let val = b.value; if (key === 'ar_msg') val = String(val || '').slice(0, 500); else if (key === 'ar_when') val = ['Always', 'When Busy', 'When Offline'].indexOf(val) > -1 ? val : 'Always'; else if (/^typ_/.test(key)) val = ['Everyone', 'Contacts', 'Nobody'].indexOf(val) > -1 ? val : 'Contacts'; else val = !!val;
      if (!(/^typ_/.test(key) && val !== 'Everyone') && !(await isPremium(me))) return res.status(403).json({ error: 'This is part of Zanply Premium.', premium: true });
      let ex = parseExtra(null); try { const [cur] = await db().query('SELECT extra FROM profiles WHERE phone = ?', [me]); ex = parseExtra(cur && cur[0] && cur[0].extra); } catch (e) {}
      ex.pset[key] = val;
      await db().query('INSERT INTO profiles (phone, extra) VALUES (?, ?) ON DUPLICATE KEY UPDATE extra = VALUES(extra)', [me, JSON.stringify(ex)]);
      return res.json({ ok: true, pset: ex.pset });
    }
    if (b.action === 'premium_get') return res.json(await premInfo(me));
    if (b.action === 'premium_renew') {
      await premTable(); await db().query('UPDATE premium SET renew = ? WHERE phone = ?', [b.renew ? 1 : 0, me]);
      return res.json(await premInfo(me));
    }
    if (b.action === 'premium_activate') {
      const span = { monthly: '1 MONTH', six: '6 MONTH', annual: '1 YEAR' }[b.plan];
      if (!span) return res.status(400).json({ error: 'Bad request.' });
      if (process.env.PREMIUM_TEST_MODE !== '1') return res.status(402).json({ error: 'Payments are being connected. No charge was made.' });
      await premTable();
      await db().query('INSERT INTO premium (phone, plan, until_at, renew) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ' + span + '), 1) ON DUPLICATE KEY UPDATE plan = VALUES(plan), until_at = DATE_ADD(GREATEST(until_at, NOW()), INTERVAL ' + span + '), renew = 1', [me, b.plan]);
      return res.json(await premInfo(me));
    }

    // Channels: create one, and list the ones I own or follow.
    if (b.action === 'channel_create') {
      const name = Array.from(String(b.name || '').trim()).slice(0, 100).join('');
      if (!name) return res.status(400).json({ error: 'Give the channel a name.' });
      { const lim = (await isPremium(me)) ? 10 : 2; const [oc] = await db().query('SELECT COUNT(*) AS n FROM channels WHERE owner = ?', [me]); if (Number(oc[0].n) >= lim) return res.status(403).json({ error: lim === 2 ? 'Free accounts can create 2 channels. Go Premium to create up to 10.' : 'You reached the limit of 10 channels.', premium: true }); }
      const description = Array.from(String(b.description || '').trim()).slice(0, 255).join('');
      const url = String(b.photo_url || '');
      const photo = cloudOn() && url.length <= 300 && url.indexOf('https://res.cloudinary.com/' + process.env.CLOUDINARY_CLOUD_NAME + '/' + 'image' + '/upload/') === 0 ? url : '';
      const [c] = await db().query('INSERT INTO channels (owner, name, description, photo_url) VALUES (?, ?, ?, ?)', [me, name, description, photo]);
      await db().query('INSERT INTO channel_subs (channel_id, phone) VALUES (?, ?)', [c.insertId, me]);
      return res.json({ channel: { id: c.insertId, name, description, photo_url: photo, subscribers: 1 } });
    }
    // Stop following a channel (owners cannot unfollow their own channel).
    if (b.action === 'channel_unfollow') {
      const cid = parseInt(String(b.channel || '').replace(/^c:/, ''), 10);
      if (!cid) return res.status(400).json({ error: 'Bad request.' });
      const [own] = await db().query('SELECT owner FROM channels WHERE id = ?', [cid]);
      if (own[0] && own[0].owner === me) return res.status(400).json({ error: 'You own this channel.' });
      const [del] = await db().query('DELETE FROM channel_subs WHERE channel_id = ? AND phone = ?', [cid, me]);
      if (del.affectedRows) await db().query('UPDATE channels SET subscribers = GREATEST(subscribers - 1, 0) WHERE id = ?', [cid]);
      return res.json({ ok: true });
    }
    if (b.action === 'channel_list') {
      const [r] = await db().query('SELECT c.id, c.name, c.description, c.photo_url, c.subscribers, c.owner FROM channels c JOIN channel_subs s ON s.channel_id = c.id WHERE s.phone = ? ORDER BY c.id DESC LIMIT 200', [me]);
      return res.json({ channels: r.map((x) => ({ id: x.id, name: x.name, description: x.description, photo_url: x.photo_url, subscribers: x.subscribers, mine: x.owner === me })) });
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
      const name = Array.from(String(b.name || '').trim()).slice(0, 250).join('');
      if (!name) return res.status(400).json({ error: 'Give the group a name.' });
      { const lim = (await isPremium(me)) ? 10 : 2; const [og] = await db().query('SELECT COUNT(*) AS n FROM chat_groups WHERE creator = ?', [me]); if (Number(og[0].n) >= lim) return res.status(403).json({ error: lim === 2 ? 'Free accounts can create 2 groups. Go Premium to create up to 10.' : 'You reached the limit of 10 groups.', premium: true }); }
      const wanted = Array.from(new Set((Array.isArray(b.members) ? b.members : []).filter((p) => phoneOk(p) && p !== me))).slice(0, ((await isPremium(me)) ? MAX_GROUP_PREM : MAX_GROUP) - 1);
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
      const [m] = await db().query('SELECT gm.phone FROM group_members gm WHERE gm.group_id = ?', [gid(b.group)]);
      const mdn = await displayNames(m.map((x) => x.phone));
      return res.json({ name: g[0] ? g[0].name : '', creator: g[0] ? g[0].creator : '', members: m.map((x) => ({ phone: x.phone, name: mdn[x.phone] || '' })) });
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
      { const prem = await isPremium(me), cap = (prem ? 150 : 30) * 1024 * 1024; if (size > cap) return res.status(413).json({ error: prem ? 'That file is too big. The limit is 150 MB.' : 'To send a file above 30 MB you have to subscribe to Zanply Premium', premium: !prem }); }
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

    // Notification check: what the server has set up, and what it saved for this account
    if (b.action === 'pushdiag') {
      let nWeb = 0, nFcm = 0;
      try { const [w] = await db().query('SELECT COUNT(*) AS n FROM push_subs WHERE phone = ?', [me]); nWeb = Number(w[0].n); } catch (e) {}
      try { await fcmTable(); const [f] = await db().query('SELECT COUNT(*) AS n FROM fcm_tokens WHERE phone = ?', [me]); nFcm = Number(f[0].n); } catch (e) {}
      return res.json({
        vapid: { public: !!process.env.VAPID_PUBLIC_KEY, private: !!process.env.VAPID_PRIVATE_KEY, subject: !!process.env.VAPID_SUBJECT },
        fcm: !!fcmOn(), fcmWhy: fcmOn() ? '' : fcmWhy(), webSubs: nWeb, fcmTokens: nFcm, ably: rt.on() });
    }
    // Sends one real test to every address saved for this account (after a short wait so the app can be closed) and reports each result
    if (b.action === 'pushtest') {
      const out = { web: null, fcm: null };
      let subs = [], rows = [];
      try { [subs] = await db().query('SELECT id, sub FROM push_subs WHERE phone = ?', [me]); } catch (e) {}
      try { if (fcmOn()) { await fcmTable(); [rows] = await db().query('SELECT id, token, chan FROM fcm_tokens WHERE phone = ?', [me]); } } catch (e) {}
      await new Promise((r) => setTimeout(r, 6000));
      if (!pushOn) out.web = 'Server has no VAPID keys';
      else if (!subs.length) out.web = 'No web-push address saved for this account';
      else {
        const payload = JSON.stringify({ title: 'Zanply test', body: 'If you can see this, notifications work.', tag: 'test', from: '' });
        const rs = [];
        for (const r of subs) {
          try { await webpush.sendNotification(JSON.parse(r.sub), payload, { TTL: 60, urgency: 'high' }); rs.push('sent'); }
          catch (e) {
            rs.push('failed ' + (e.statusCode || '') + ' ' + String(e.body || e.message || '').slice(0, 80));
            if (e.statusCode === 404 || e.statusCode === 410) await db().query('DELETE FROM push_subs WHERE id = ?', [r.id]);
          }
        }
        out.web = rs.join(', ');
      }
      if (!fcmOn()) out.fcm = 'Server has no Firebase settings: ' + fcmWhy();
      else if (!rows.length) out.fcm = 'No Firebase token saved for this account';
      else {
        try {
          const errs = [];
          const dead = await sendFcm(rows, { type: 'msg', title: 'Zanply test', body: 'If you can see this, notifications work.', sender: '' }, { errors: errs });
          if (dead && dead.length) await db().query('DELETE FROM fcm_tokens WHERE id IN (' + dead.map(() => '?').join(',') + ')', dead);
          if (errs.length) out.fcm = 'Google refused it: ' + errs[0];
          else out.fcm = dead && dead.length ? 'Google says ' + dead.length + ' of ' + rows.length + ' token(s) are no longer valid and were removed. Reopen the app to register again' : 'accepted by Google for ' + rows.length + ' phone(s)';
        } catch (e) { out.fcm = 'failed: ' + String((e && (e.message || e.code)) || e).slice(0, 140); }
      }
      return res.json(out);
    }

    if (b.action === 'fcmreg') {
      const ft = typeof b.ftoken === 'string' ? b.ftoken.trim() : '';
      if (ft.length < 20 || ft.length > 500) return res.status(400).json({ error: 'Bad request.' });
      await fcmTable();
      const chan = typeof b.chan === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(b.chan) ? b.chan : '';
      await db().query('INSERT INTO fcm_tokens (phone, hash, token, chan) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE phone = VALUES(phone), token = VALUES(token), chan = VALUES(chan)', [me, sha(ft), ft, chan]);
      return res.json({ ok: true, server: fcmOn() });
    }

    if (b.action === 'fcmunreg') {
      if (typeof b.ftoken === 'string') { await fcmTable(); await db().query('DELETE FROM fcm_tokens WHERE hash = ? AND phone = ?', [sha(b.ftoken.trim()), me]); }
      return res.json({ ok: true });
    }

    // ---- Status updates (24 hours). Visible to people I have a chat with or saved, never across a block. ----
    if (b.action === 'status_list') {
      await statusCols();
      const [rows] = await db().query(
        `SELECT s.id, s.owner, s.type, s.text, s.bg, s.url, s.music, s.music_name, s.created_at, s.expires_at,
           (SELECT COUNT(*) FROM status_likes l WHERE l.status_id = s.id) AS likes,
           (SELECT COUNT(*) FROM status_views v WHERE v.status_id = s.id AND v.viewer <> s.owner) AS views,
           EXISTS(SELECT 1 FROM status_likes l WHERE l.status_id = s.id AND l.viewer = ?) AS liked,
           EXISTS(SELECT 1 FROM status_views v WHERE v.status_id = s.id AND v.viewer = ?) AS seen
         FROM statuses s
         WHERE s.expires_at > NOW() AND (s.owner = ? OR (
           (EXISTS (SELECT 1 FROM saved_contacts c WHERE c.owner = s.owner AND c.phone = ?)
            OR EXISTS (SELECT 1 FROM messages m WHERE (m.sender = s.owner AND m.receiver = ?) OR (m.sender = ? AND m.receiver = s.owner)))
           AND NOT EXISTS (SELECT 1 FROM blocks bl WHERE (bl.blocker = s.owner AND bl.blocked = ?) OR (bl.blocker = ? AND bl.blocked = s.owner))))
         ORDER BY s.id ASC LIMIT 300`, [me, me, me, me, me, me, me, me]);
      const owners = Array.from(new Set(rows.map((r) => r.owner)));
      const names = owners.length ? await displayNames(owners) : {};
      return res.json({ statuses: rows.map((r) => ({
        id: r.id, phone: r.owner, name: names[r.owner] || '', type: r.type, text: r.text, bg: r.bg, url: r.url, music: r.music || '', music_name: r.music_name || '',
        at: r.created_at, expires: r.expires_at, likes: Number(r.likes) || 0, views: Number(r.views) || 0,
        liked: !!Number(r.liked), seen: !!Number(r.seen), mine: r.owner === me })) });
    }
    if (b.action === 'status_sign') {
      if (!cloudOn()) return res.status(500).json({ error: 'File storage is not set up on the server yet.' });
      const publicId = 'zucket/status/' + crypto.randomBytes(12).toString('hex');
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = cloud().utils.api_sign_request({ public_id: publicId, timestamp }, process.env.CLOUDINARY_API_SECRET);
      return res.json({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, timestamp, signature, public_id: publicId });
    }
    if (b.action === 'status_post') {
      await statusCols();
      const type = ['image', 'video', 'audio'].indexOf(b.type) > -1 ? b.type : 'text';
      let text = Array.from(String(b.text || '').trim()).slice(0, type === 'text' ? 400 : 200).join(''), bg = '#128c7e', url = '';
      if (type === 'text') {
        if (!text) return res.status(400).json({ error: 'Write something first.' });
        if (/^#[0-9a-f]{6}$/i.test(String(b.bg || ''))) bg = String(b.bg);
      } else {
        url = String(b.url || '');
        const okUrl = cloudOn() && url.length <= 300 && url.indexOf('https://res.cloudinary.com/' + process.env.CLOUDINARY_CLOUD_NAME + '/' + (type === 'image' ? 'image' : 'video') + '/upload/') === 0;
        if (!okUrl) return res.status(400).json({ error: 'Bad request.' });
      }
      let music = '', musicName = '';
      if (type === 'image' && b.music) {
        music = String(b.music);
        if (!(cloudOn() && music.length <= 300 && music.indexOf('https://res.cloudinary.com/' + process.env.CLOUDINARY_CLOUD_NAME + '/video/upload/') === 0)) return res.status(400).json({ error: 'Bad request.' });
        musicName = Array.from(String(b.music_name || '').trim()).slice(0, 100).join('');
      }
      const premU = await isPremium(me); let hrs = [24, 48, 72, 96].indexOf(Number(b.hours)) > -1 ? Number(b.hours) : 24;
      if (hrs > 24 && !premU) return res.status(403).json({ error: 'To use 48h+ Status duration you need Zanply Premium', premium: true });
      const [cnt] = await db().query('SELECT COUNT(*) AS n FROM statuses WHERE owner = ? AND created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)', [me]).catch(() => db().query('SELECT COUNT(*) AS n FROM statuses WHERE owner = ? AND expires_at > NOW()', [me]));
      { const lim = (await isPremium(me)) ? 13 : 2; if (Number(cnt[0].n) >= lim) return res.status(403).json({ error: lim === 2 ? 'Free accounts can share 2 Status per day. Go Premium to share up to 13.' : 'You reached 13 Status for today.', premium: true }); }
      const [r] = await db().query('INSERT INTO statuses (owner, type, text, bg, url, music, music_name, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR))', [me, type, text, bg, url, music, musicName, hrs]);
      /* tidy up: remove updates that expired more than a day ago, with their views and likes */
      db().query('DELETE FROM status_views WHERE status_id IN (SELECT id FROM statuses WHERE expires_at < DATE_SUB(NOW(), INTERVAL 1 DAY))').catch(() => {});
      db().query('DELETE FROM status_likes WHERE status_id IN (SELECT id FROM statuses WHERE expires_at < DATE_SUB(NOW(), INTERVAL 1 DAY))').catch(() => {});
      db().query('DELETE FROM statuses WHERE expires_at < DATE_SUB(NOW(), INTERVAL 1 DAY)').catch(() => {});
      return res.json({ status: { id: r.insertId, phone: me, type, text, bg, url, music, music_name: musicName, at: new Date().toISOString(), likes: 0, views: 0, liked: false, seen: true, mine: true } });
    }
    if (b.action === 'status_view' || b.action === 'status_like') {
      const id = Number(b.id) || 0; if (!id) return res.status(400).json({ error: 'Bad request.' });
      const [st] = await db().query('SELECT id, owner FROM statuses WHERE id = ? AND expires_at > NOW()', [id]);
      if (!st[0]) return res.status(404).json({ error: 'This status is no longer available.' });
      if (st[0].owner === me) return res.json({ ok: true });
      const bs = await blockState(me, st[0].owner), rel = await relation(st[0].owner, me);
      if (bs.iBlocked || bs.blockedMe || !rel.chat) return res.status(403).json({ error: "You can't see this status." });
      if (b.action === 'status_view') await db().query('INSERT IGNORE INTO status_views (status_id, viewer) VALUES (?, ?)', [id, me]);
      else if (b.on) await db().query('INSERT IGNORE INTO status_likes (status_id, viewer) VALUES (?, ?)', [id, me]);
      else await db().query('DELETE FROM status_likes WHERE status_id = ? AND viewer = ?', [id, me]);
      return res.json({ ok: true });
    }
    if (b.action === 'status_delete') {
      const id = Number(b.id) || 0; if (!id) return res.status(400).json({ error: 'Bad request.' });
      const [st] = await db().query('SELECT id FROM statuses WHERE id = ? AND owner = ?', [id, me]);
      if (!st[0]) return res.status(404).json({ error: 'Status not found.' });
      await db().query('DELETE FROM status_views WHERE status_id = ?', [id]);
      await db().query('DELETE FROM status_likes WHERE status_id = ?', [id]);
      await db().query('DELETE FROM statuses WHERE id = ? AND owner = ?', [id, me]);
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
