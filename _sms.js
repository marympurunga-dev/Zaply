// Sends the phone login code through Africa's Talking.
// Env: AT_USERNAME, AT_API_KEY, AT_SENDER (optional approved sender ID), AT_APP_HASH (optional 11-character Android app hash). Use AT_USERNAME=sandbox for free tests (no real SMS).

// Message layout: "<#>" line, warning, "Your Zucket code: 123-456", then the optional 11-character Android app hash (AT_APP_HASH).
function buildMessage(code, appHash) {
  const c = String(code);
  const shown = c.length === 6 ? c.slice(0, 3) + '-' + c.slice(3) : c;
  const lines = [
    '<#> Your number is being registered to Zucket.',
    '',
    'Do not share this code with anyone.',
    'Your Zucket code: ' + shown,
  ];
  if (appHash) lines.push(appHash);
  return lines.join('\n');
}

async function sendCodeSms(to, code, env = process.env, fetchFn = globalThis.fetch) {
  if (!env.AT_USERNAME || !env.AT_API_KEY) throw Object.assign(new Error('SMS is not set up yet.'), { status: 500 });
  const sandbox = env.AT_USERNAME === 'sandbox';
  const url = sandbox ? 'https://api.sandbox.africastalking.com/version1/messaging' : 'https://api.africastalking.com/version1/messaging';
  const form = new URLSearchParams({
    username: env.AT_USERNAME,
    to,
    message: buildMessage(code, env.AT_APP_HASH),
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
    const why = rec && rec.status ? rec.status : String(text).replace(/\s+/g, ' ').slice(0, 80);
    throw Object.assign(new Error('We could not send the SMS. (' + r.status + ': ' + why + ')'), { status: 502 });
  }
}

module.exports = { sendCodeSms, buildMessage };
