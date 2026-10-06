const test = require('node:test');
const assert = require('node:assert');
const { buildEmail, sendCodeEmail } = require('../api/_mail');

test('email contains the code and a plain subject', () => {
  const m = buildEmail('482913');
  assert.strictEqual(m.subject, 'Zaply verification code');
  assert.ok(m.text.includes('482913'));
  assert.ok(m.html.includes('482913'));
});

test('sends through Resend with the configured sender and reply-to', async () => {
  let call;
  const fakeFetch = async (url, opts) => { call = { url, opts }; return { ok: true }; };
  await sendCodeEmail('user@example.com', '123456',
    { RESEND_API_KEY: 'key', RESEND_FROM: 'Zaply <noreply@mydomain.com>', RESEND_REPLY_TO: 'help@mydomain.com' }, fakeFetch);
  const body = JSON.parse(call.opts.body);
  assert.strictEqual(call.url, 'https://api.resend.com/emails');
  assert.strictEqual(call.opts.headers.Authorization, 'Bearer key');
  assert.deepStrictEqual(body.to, ['user@example.com']);
  assert.strictEqual(body.from, 'Zaply <noreply@mydomain.com>');
  assert.strictEqual(body.reply_to, 'help@mydomain.com');
});

test('fails with 500 when the API key is missing', async () => {
  await assert.rejects(() => sendCodeEmail('a@b.co', '111111', {}, async () => ({ ok: true })), (e) => e.status === 500);
});

test('fails with 502 when Resend rejects the request', async () => {
  const fakeFetch = async () => ({ ok: false, status: 422, text: async () => 'bad' });
  await assert.rejects(() => sendCodeEmail('a@b.co', '111111', { RESEND_API_KEY: 'k' }, fakeFetch), (e) => e.status === 502);
});
