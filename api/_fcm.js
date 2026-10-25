// Firebase Cloud Messaging sender. No extra npm packages needed.
// Vercel setting required: FIREBASE_SERVICE_ACCOUNT = the whole service-account JSON file contents.
const crypto = require('crypto');

let cfg = null, why = '', cached = null, cachedUntil = 0;
function conf() {
  if (cfg !== null) return cfg;
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) { why = 'FIREBASE_SERVICE_ACCOUNT is not set in Vercel'; cfg = false; return cfg; }
  try { cfg = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT); } catch (e) { console.error('FIREBASE_SERVICE_ACCOUNT is not valid JSON'); why = 'FIREBASE_SERVICE_ACCOUNT is not valid JSON (paste the whole file exactly as downloaded)'; cfg = false; }
  if (cfg && (!cfg.client_email || !cfg.private_key || !cfg.project_id)) { why = 'FIREBASE_SERVICE_ACCOUNT is missing client_email, private_key or project_id'; cfg = false; }
  return cfg;
}
const fcmOn = () => !!conf();
const fcmWhy = () => { conf(); return why; };
const b64u = (b) => Buffer.from(b).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

async function accessToken() {
  if (cached && Date.now() < cachedUntil) return cached;
  const c = conf(), now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64u(JSON.stringify({ iss: c.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = crypto.createSign('RSA-SHA256').update(head + '.' + claim).sign(c.private_key);
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + head + '.' + claim + '.' + b64u(sig),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('FCM auth failed: ' + JSON.stringify(j).slice(0, 200));
  cached = j.access_token; cachedUntil = Date.now() + (Math.max(60, (j.expires_in || 3600) - 120)) * 1000;
  return cached;
}

// data: flat object of strings. Returns the list of rows whose token is no longer valid.
// opts.errors (optional array): Google's error messages are pushed into it, so a caller can show what went wrong.
async function sendFcm(rows, data, opts) {
  if (!fcmOn() || !rows.length) return [];
  const o = opts || {}, dead = [], errs = Array.isArray(o.errors) ? o.errors : null;
  let at;
  try { at = await accessToken(); } catch (e) { console.error(e.message); if (errs) errs.push(e.message); return []; }
  const flat = {};
  Object.keys(data).forEach((k) => { flat[k] = String(data[k] == null ? '' : data[k]); });
  await Promise.allSettled(rows.map(async (row) => {
    try {
      const r = await fetch('https://fcm.googleapis.com/v1/projects/' + conf().project_id + '/messages:send', {
        method: 'POST', headers: { Authorization: 'Bearer ' + at, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: { token: row.token, data: flat, android: { priority: 'HIGH', ttl: o.ttl || '86400s' } } }),
      });
      if (!r.ok) {
        const t = await r.text();
        if (r.status === 404 || /UNREGISTERED|INVALID_ARGUMENT/.test(t)) dead.push(row.id);
        else { console.error('FCM send failed', r.status, t.slice(0, 200)); if (errs) errs.push(r.status + ' ' + t.replace(/\s+/g, ' ').slice(0, 180)); }
      }
    } catch (e) { console.error('FCM error', e.message); if (errs) errs.push(e.message); }
  }));
  return dead;
}
module.exports = { fcmOn, fcmWhy, sendFcm };
