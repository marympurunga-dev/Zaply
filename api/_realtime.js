// Ably real-time helpers for Zanply.
// Vercel env: ABLY_API_KEY   |   install: npm i ably
//   u:<phone>  inbox channel. Only the server publishes to it, only its owner may subscribe. Events carry no message text.
//   p:<phone>  presence channel. The owner enters it while the app is open; people the server allows may watch it.
let rest;
const on = () => !!process.env.ABLY_API_KEY;
function client() {
  if (!rest) { const Ably = require('ably'); rest = new Ably.Rest({ key: process.env.ABLY_API_KEY }); }
  return rest;
}
/* tell these people "something changed"; the app then asks /api/chat for the real data */
async function signal(phones, name, data) {
  if (!on()) return;
  const list = Array.from(new Set((phones || []).filter(Boolean)));
  await Promise.allSettled(list.map((p) => client().channels.get('u:' + p).publish(name, data || {})));
}
async function tokenRequest(phone, watch) {
  const cap = {};
  cap['u:' + phone] = ['subscribe'];
  cap['p:' + phone] = ['presence', 'subscribe'];
  (watch || []).forEach((w) => { cap['p:' + w] = ['subscribe']; });
  return client().auth.createTokenRequest({ clientId: phone, capability: JSON.stringify(cap), ttl: 10 * 60 * 1000 });
}
module.exports = { on, signal, tokenRequest };
