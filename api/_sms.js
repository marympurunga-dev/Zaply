// Sends the phone login code through Africa's Talking.
// Env: AT_USERNAME, AT_API_KEY, AT_SENDER (optional approved sender ID). Use AT_USERNAME=sandbox for free tests (no real SMS).

async function sendCodeSms(to, code, env = process.env, fetchFn = globalThis.fetch) {
  if (!env.AT_USERNAME || !env.AT_API_KEY) throw Object.assign(new Error('SMS is not set up yet.'), { status: 500 });
  const sandbox = env.AT_USERNAME === 'sandbox';
  const url = sandbox ? 'https://api.sandbox.africastalking.com/version1/messaging' : 'https://api.africastalking.com/version1/messaging';
  const form = new URLSearchParams({
    username: env.AT_USERNAME,
    to,
    message: 'Your Zaply code is ' + code + '. It expires in 10 minutes.',
  });
  if (env.AT_SENDER) form.set('from', env.AT_SENDER);
  const r = await fetchFn(url, {
    method: 'POST',
    headers: { apiKey: env.AT_API_KEY, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const text = await r.text();
  let rec;
  try { rec = JSON.parse(text).SMSMessageData.Recipients[0]; } catch (e) { rec = null; }
  if (!r.ok || !rec || !/^(100|101|102)$/.test(String(rec.statusCode))) {
    console.error('Africa\'s Talking error', r.status, text);
    throw Object.assign(new Error('We could not send the SMS. Check the number and try again.'), { status: 502 });
  }
}

module.exports = { sendCodeSms };
