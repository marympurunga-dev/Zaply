// Checks the block, report and group rules in chat.js using a small fake database (no real MySQL needed).
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const Module = require('module');

const db = { users: [], blocks: [], messages: [], reports: [], groups: [], members: [], gmsgs: [], profiles: [] };
const fakePool = {
  async query(sql, p = []) {
    sql = sql.replace(/\s+/g, ' ').trim();
    if (/^CREATE TABLE/i.test(sql)) return [[]];
    if (/^SELECT phone, name FROM users WHERE phone = \?$/.test(sql)) return [db.users.filter((u) => u.phone === p[0])];
    if (/^SELECT phone FROM users WHERE phone IN/.test(sql)) return [db.users.filter((u) => p[0].includes(u.phone))];
    if (/^SELECT blocker FROM blocks/.test(sql)) return [db.blocks.filter((b) => (b.blocker === p[0] && b.blocked === p[1]) || (b.blocker === p[2] && b.blocked === p[3]))];
    if (/^INSERT IGNORE INTO blocks/.test(sql)) { if (!db.blocks.some((b) => b.blocker === p[0] && b.blocked === p[1])) db.blocks.push({ blocker: p[0], blocked: p[1] }); return [{}]; }
    if (/^DELETE FROM blocks/.test(sql)) { db.blocks = db.blocks.filter((b) => !(b.blocker === p[0] && b.blocked === p[1])); return [{}]; }
    if (/^INSERT INTO messages/.test(sql)) { db.messages.push({ sender: p[0], receiver: p[1], body: p[2] }); return [{ insertId: db.messages.length }]; }
    if (/^INSERT INTO reports/.test(sql)) { db.reports.push({ reporter: p[0], reported: p[1], text: p[2] }); return [{}]; }
    if (/^INSERT INTO chat_groups/.test(sql)) { db.groups.push({ id: db.groups.length + 1, name: p[0], creator: p[1] }); return [{ insertId: db.groups.length }]; }
    if (/^INSERT INTO group_members/.test(sql)) { p[0].forEach((r) => db.members.push({ group_id: r[0], phone: r[1] })); return [{}]; }
    if (/^SELECT 1 FROM group_members/.test(sql)) return [db.members.filter((m) => m.group_id === p[0] && m.phone === p[1])];
    if (/^INSERT INTO group_messages/.test(sql)) { db.gmsgs.push({ group_id: p[0], sender: p[1], body: p[2] }); return [{ insertId: db.gmsgs.length }]; }
    if (/^SELECT name FROM chat_groups/.test(sql)) return [db.groups.filter((g) => g.id === p[0])];
    if (/^SELECT username, email, address, bio, DATE_FORMAT/.test(sql)) return [db.profiles.filter((r) => r.phone === p[0])];
    if (/^INSERT INTO profiles/.test(sql)) {
      if (p[1] && db.profiles.some((r) => r.username === p[1] && r.phone !== p[0])) { const e = new Error('dup'); e.code = 'ER_DUP_ENTRY'; throw e; }
      const row = { phone: p[0], username: p[1], email: p[2], address: p[3], bio: p[4], birthday: p[5], pet: p[6] };
      const i = db.profiles.findIndex((r) => r.phone === p[0]);
      if (i > -1) db.profiles[i] = row; else db.profiles.push(row);
      return [{}];
    }
    throw new Error('fake db: unhandled SQL: ' + sql.slice(0, 80));
  },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'mysql2/promise') return { createPool: () => fakePool };
  if (req === 'web-push') return { setVapidDetails() {}, sendNotification: async () => {} };
  return origLoad.call(this, req, ...rest);
};
const handler = require('./chat.js');
Module._load = origLoad;

function token(phone) {
  const body = Buffer.from(JSON.stringify({ p: phone, e: Date.now() + 1e6 })).toString('base64url');
  return body + '.' + crypto.createHmac('sha256', 'change-me').update(body).digest('base64url');
}
async function call(who, body) {
  let out = { status: 200, json: null };
  const res = { setHeader() {}, status(c) { out.status = c; return this; }, json(j) { out.json = j; return this; }, end() { return this; } };
  await handler({ method: 'POST', body: Object.assign({ token: token(who) }, body) }, res);
  return out;
}
const A = '+254700000001', B = '+254700000002', C = '+254700000003';
db.users.push({ phone: A, name: 'Ann' }, { phone: B, name: 'Bob' }, { phone: C, name: 'Cy' });

test('before blocking, messages go through', async () => {
  assert.strictEqual((await call(A, { action: 'send', to: B, body: 'hi' })).status, 200);
});

test('when A blocks B, B can no longer message A', async () => {
  assert.strictEqual((await call(A, { action: 'block', phone: B })).status, 200);
  const r = await call(B, { action: 'send', to: A, body: 'hello?' });
  assert.strictEqual(r.status, 403);
  assert.ok(!db.messages.some((m) => m.body === 'hello?'));
});

test('A also cannot message B while the block stands, and gets told why', async () => {
  const r = await call(A, { action: 'send', to: B, body: 'still there?' });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.json.blocked, true);
});

test('blockstate only tells A that A blocked B, and never tells B', async () => {
  assert.strictEqual((await call(A, { action: 'blockstate', with: B })).json.blocked, true);
  assert.strictEqual((await call(B, { action: 'blockstate', with: A })).json.blocked, false);
});

test('other people are not affected', async () => {
  assert.strictEqual((await call(C, { action: 'send', to: A, body: 'hey from Cy' })).status, 200);
});

test('call invites are blocked too, because they travel as messages', async () => {
  const r = await call(B, { action: 'send', to: A, body: '__call__{"u":"https://x","v":1}' });
  assert.strictEqual(r.status, 403);
});

test('after unblocking, messages flow again', async () => {
  await call(A, { action: 'unblock', phone: B });
  assert.strictEqual((await call(B, { action: 'send', to: A, body: 'back again' })).status, 200);
});

test('a scrambled message that is too long is refused instead of cut short', async () => {
  const r = await call(A, { action: 'send', to: B, body: 'e2e1:' + 'A'.repeat(2100) });
  assert.strictEqual(r.status, 400);
});

test('reports are saved', async () => {
  assert.strictEqual((await call(A, { action: 'report', to: B, text: 'spam' })).status, 200);
  assert.strictEqual(db.reports.length, 1);
  assert.strictEqual((await call(A, { action: 'report', to: B, text: '' })).status, 400);
});

test('groups: only members can post, and the creator is a member', async () => {
  const g = await call(A, { action: 'group_create', name: 'Friends', members: [B] });
  assert.strictEqual(g.status, 200);
  assert.strictEqual(g.json.group.phone, 'g:1');
  assert.strictEqual((await call(B, { action: 'send', to: 'g:1', body: 'hi all' })).status, 200);
  assert.strictEqual((await call(C, { action: 'send', to: 'g:1', body: 'let me in' })).status, 403);
  assert.strictEqual((await call(A, { action: 'group_create', name: '', members: [B] })).status, 400);
  assert.strictEqual((await call(A, { action: 'group_create', name: 'Solo', members: [] })).status, 400);
});

test('profiles: save and read back username, email, address, bio, birthday and pet', async () => {
  const s = await call(A, { action: 'profile_set', username: '@Ann_K', email: 'ann@example.com', address: 'Nairobi', bio: 'Hello', birthday: '2005-12-22', pet: 'Cat' });
  assert.strictEqual(s.status, 200);
  assert.strictEqual(s.json.profile.username, 'ann_k');
  const g = await call(C, { action: 'profile_get', phone: A });
  assert.strictEqual(g.status, 200);
  assert.deepStrictEqual(g.json.profile, { username: 'ann_k', email: 'ann@example.com', address: 'Nairobi', bio: 'Hello', birthday: '2005-12-22', pet: 'Cat' });
  assert.strictEqual((await call(A, { action: 'profile_get' })).json.profile.pet, 'Cat'); // own profile when no phone is given
});

test('profiles: bio is cut at 200 letters and emoji count as one letter', async () => {
  const r = await call(B, { action: 'profile_set', bio: '😀'.repeat(250) });
  assert.strictEqual(Array.from(r.json.profile.bio).length, 200);
});

test('profiles: a username can only belong to one person, and bad values are refused', async () => {
  assert.strictEqual((await call(B, { action: 'profile_set', username: 'ANN_K' })).status, 409);
  assert.strictEqual((await call(B, { action: 'profile_set', username: 'a b' })).status, 400);
  assert.strictEqual((await call(B, { action: 'profile_set', email: 'not-an-email' })).status, 400);
  assert.strictEqual((await call(B, { action: 'profile_set', birthday: '2999-01-01' })).status, 400);
  assert.strictEqual((await call(B, { action: 'profile_set', birthday: '2005-02-31' })).status, 400);
});

test('profiles: a blocked person sees an empty profile, and unknown numbers are refused', async () => {
  await call(A, { action: 'block', phone: C });
  const g = await call(C, { action: 'profile_get', phone: A });
  assert.strictEqual(g.status, 200);
  assert.strictEqual(g.json.profile.email, '');
  await call(A, { action: 'unblock', phone: C });
  assert.strictEqual((await call(A, { action: 'profile_get', phone: '+254799999999' })).status, 404);
});
