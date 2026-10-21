// Builds and sends the verification email through Resend.
// Env: RESEND_API_KEY, RESEND_FROM (address on your verified domain), RESEND_REPLY_TO (optional)

function buildEmail(code) {
  const subject = 'Zaply verification code';
  const text =
    'Your Zaply verification code is ' + code + '.\n\n' +
    'It expires in 10 minutes. If you did not request it, you can ignore this email.\n\n' +
    'Zaply';
  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:420px;margin:auto;padding:24px;color:#222">' +
    '<p style="margin:0 0 16px;font-size:16px">Use this code to confirm your email on Zaply:</p>' +
    '<p style="margin:0 0 16px;font-size:32px;font-weight:700;letter-spacing:6px">' + code + '</p>' +
    '<p style="margin:0 0 16px;font-size:14px;color:#555">It expires in 10 minutes.</p>' +
    '<p style="margin:0;font-size:12px;color:#888">You received this because someone entered this address while signing up for Zaply. If that was not you, ignore this email.</p>' +
    '</div>';
  return { subject, text, html };
}

async function sendCodeEmail(to, code, env = process.env, fetchFn = globalThis.fetch) {
  if (!env.RESEND_API_KEY) throw Object.assign(new Error('Email is not set up yet.'), { status: 500 });
  const mail = buildEmail(code);
  const body = {
    from: env.RESEND_FROM || 'Zaply <onboarding@resend.dev>',
    to: [to],
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
  };
  if (env.RESEND_REPLY_TO) body.reply_to = env.RESEND_REPLY_TO;
  const r = await fetchFn('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const raw = await r.text(); let why = ''; try { why = String((JSON.parse(raw) || {}).message || ''); } catch (e) {}
    console.error('Resend error', r.status, raw);
    // Resend refuses unverified senders and (with the test sender) any address except the account owner's
    let msg = 'We could not send the email. Check the address and try again.';
    if (r.status === 401 || r.status === 400 && /api key/i.test(why)) msg = 'Email is not set up correctly on the server (API key).';
    else if (r.status === 403 || /verify|own email|testing emails/i.test(why)) msg = 'The email sender is not verified yet, so codes can only go to the account owner. Verify your domain in Resend and set RESEND_FROM.';
    else if (r.status === 429) msg = 'Too many emails were sent. Please wait a minute and try again.';
    if (env.RESEND_DEBUG === '1' && why) msg += ' [' + r.status + ': ' + why + ']';
    throw Object.assign(new Error(msg), { status: 502 });
  }
}

module.exports = { buildEmail, sendCodeEmail };
