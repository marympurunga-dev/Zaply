// Tests the browser-side encryption code that lives in index.html (between the E2E markers).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const code = html.slice(html.indexOf('/*E2E-START*/'), html.indexOf('/*E2E-END*/'));

// A tiny in-memory "server" for public keys plus a fake key store per person.
function makeWorld() {
  const keys = {};
  function person(phone) {
    const mem = new Map();
    const store = { get: async (k) => mem.get(k), put: async (k, v) => { mem.set(k, v); } };
    const chatCall = async (action, data) => {
      if (action === 'setkey') { keys[phone] = data.key; return { ok: true }; }
      if (action === 'getkey') return { key: keys[data.phone] || null };
      throw new Error('unexpected ' + action);
    };
    const E2E = new Function('window', 'chatCall', 'indexedDB', code + '; return E2E;')({ crypto: globalThis.crypto }, chatCall, {});
    E2E._store(store);
    return { phone, E2E, store, chatCall };
  }
  return { keys, person };
}

test('both people can read a message, and the server only sees scrambled text', async () => {
  const w = makeWorld(), a = w.person('+254700000001'), b = w.person('+254700000002');
  await a.E2E.init(a.phone); await b.E2E.init(b.phone);
  const wire = await a.E2E.encrypt(b.phone, 'Hello Bob 👋');
  assert.ok(wire.startsWith('e2e1:'));
  assert.ok(!wire.includes('Hello'));
  assert.strictEqual(await b.E2E.decrypt(a.phone, wire), 'Hello Bob 👋');
  assert.strictEqual(await a.E2E.decrypt(b.phone, wire), 'Hello Bob 👋'); // sender can read their own history
});

test('the same message encrypts differently every time', async () => {
  const w = makeWorld(), a = w.person('+254700000001'), b = w.person('+254700000002');
  await a.E2E.init(a.phone); await b.E2E.init(b.phone);
  assert.notStrictEqual(await a.E2E.encrypt(b.phone, 'hi'), await a.E2E.encrypt(b.phone, 'hi'));
});

test('a changed message cannot be read', async () => {
  const w = makeWorld(), a = w.person('+254700000001'), b = w.person('+254700000002');
  await a.E2E.init(a.phone); await b.E2E.init(b.phone);
  const wire = await a.E2E.encrypt(b.phone, 'pay 100');
  const bad = wire.slice(0, -4) + (wire.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
  assert.strictEqual(await b.E2E.decrypt(a.phone, bad), b.E2E.HIDDEN);
});

test('a message cannot be replayed into a different chat', async () => {
  const w = makeWorld(), a = w.person('+254700000001'), b = w.person('+254700000002'), c = w.person('+254700000003');
  await a.E2E.init(a.phone); await b.E2E.init(b.phone); await c.E2E.init(c.phone);
  const wire = await a.E2E.encrypt(b.phone, 'secret');
  assert.strictEqual(await c.E2E.decrypt(a.phone, wire), c.E2E.HIDDEN);
});

test('sending to someone with no key is refused, not sent in the clear', async () => {
  const w = makeWorld(), a = w.person('+254700000001');
  await a.E2E.init(a.phone);
  await assert.rejects(() => a.E2E.encrypt('+254700000009', 'hi'), (e) => e.e2e === true);
});

test('both people see the same 60-digit security code', async () => {
  const w = makeWorld(), a = w.person('+254700000001'), b = w.person('+254700000002');
  await a.E2E.init(a.phone); await b.E2E.init(b.phone);
  const ca = await a.E2E.fingerprint(b.phone), cb = await b.E2E.fingerprint(a.phone);
  assert.deepStrictEqual(ca, cb);
  assert.strictEqual(ca.length, 12);
  assert.ok(ca.every((g) => /^\d{5}$/.test(g)));
});

test('the security code changes when someone signs in on a new device', async () => {
  const w = makeWorld(), a = w.person('+254700000001'), b = w.person('+254700000002');
  await a.E2E.init(a.phone); await b.E2E.init(b.phone);
  const before = await a.E2E.fingerprint(b.phone);
  const b2 = w.person(b.phone); await b2.E2E.init(b.phone); // new device, new key
  const after = await a.E2E.fingerprint(b.phone);
  assert.notDeepStrictEqual(before, after);
});

test('after the other person gets a new key, new messages still arrive', async () => {
  const w = makeWorld(), a = w.person('+254700000001'), b = w.person('+254700000002');
  await a.E2E.init(a.phone); await b.E2E.init(b.phone);
  await a.E2E.decrypt(b.phone, await b.E2E.encrypt(a.phone, 'first')); // a caches b's old key
  const b2 = w.person(b.phone); await b2.E2E.init(b.phone);
  const wire = await b2.E2E.encrypt(a.phone, 'from my new phone');
  assert.strictEqual(await a.E2E.decrypt(b.phone, wire), 'from my new phone');
});

test('plain text from before encryption passes through, and a network error is retried not hidden', async () => {
  const w = makeWorld(), a = w.person('+254700000001'), b = w.person('+254700000002');
  await a.E2E.init(a.phone); await b.E2E.init(b.phone);
  assert.strictEqual(await a.E2E.decrypt(b.phone, 'old message'), 'old message');
  const wire = await b.E2E.encrypt(a.phone, 'x');
  const down = w.person('+254700000004'); await down.E2E.init(down.phone);
  down.E2E._store({ get: async () => undefined, put: async () => {} });
  const lonely = new Function('window', 'chatCall', 'indexedDB', code + '; return E2E;')(
    { crypto: globalThis.crypto }, async () => { const e = new Error('offline'); e.status = 0; throw e; }, {});
  await assert.rejects(() => lonely.decrypt(b.phone, wire));
});
