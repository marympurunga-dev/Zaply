// Ably real-time helpers for Zanply.
// Vercel env: ABLY_API_KEY   |   install: npm i ably
//   u:<phone>  inbox channel. Only the server publishes to it, only its owner may subscribe. Events carry no message text.
//   p:<phone>  presence channel. The owner enters it while the app is open; people the server allows may watch it.
let rest, promiseStyle = false;
const on = () => !!process.env.ABLY_API_KEY;
function client() {
  if (!rest) {
    // ably 1.x: the plain module is callback-style (calls without a callback return nothing); "ably/promises" returns promises.
    let Ably;
    try { Ably = require('ably/promises'); promiseStyle = true; } catch (e) { Ably = require('ably'); promiseStyle = false; }
    rest = new Ably.Rest({ key: process.env.ABLY_API_KEY });
  }
  return rest;
}
/* tell these people "something changed"; the app then asks /api/chat for the real data */
async function signal(phones, name, data) {
  if (!on()) return;
  const list = Array.from(new Set((phones || []).filter(Boolean)));
  await Promise.allSettled(list.map((p) => new Promise((resolve, reject) => {
    const ch = client().channels.get('u:' + p);
    if (promiseStyle) return ch.publish(name, data || {}).then(resolve, reject);
    ch.publish(name, data || {}, (err) => (err ? reject(err) : resolve()));
  })));
}
async function tokenRequest(phone, watch) {
  const cap = {};
  cap['u:' + phone] = ['subscribe'];
  cap['p:' + phone] = ['presence', 'subscribe'];
  (watch || []).forEach((w) => { cap['p:' + w] = ['subscribe']; });
  const params = { clientId: phone, capability: JSON.stringify(cap), ttl: 10 * 60 * 1000 };
  const c = client();
  if (promiseStyle) return c.auth.createTokenRequest(params);
  return new Promise((resolve, reject) => {
    c.auth.createTokenRequest(params, null, (err, tr) => (err ? reject(err) : resolve(tr)));
  });
}
module.exports = { on, signal, tokenRequest };
