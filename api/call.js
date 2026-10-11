// Creates a Daily.co room for a call. Needs the DAILY_API_KEY environment variable in Vercel.
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    if (!body.token) return res.status(401).json({ error: 'Not signed in' });
    if (!process.env.DAILY_API_KEY) return res.status(500).json({ error: 'Calls are not set up yet' });

    // check the user with the existing auth endpoint of this same site
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const me = await fetch('https://' + host + '/api/auth', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'me', token: body.token })
    });
    if (!me.ok) return res.status(401).json({ error: 'Not signed in' });

    const r = await fetch('https://api.daily.co/v1/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.DAILY_API_KEY },
      body: JSON.stringify({ properties: { exp: Math.floor(Date.now() / 1000) + 3600, max_participants: 2, start_video_off: !body.video, enable_prejoin_ui: false, enable_chat: false } })
    });
    const room = await r.json();
    if (!r.ok) return res.status(502).json({ error: room.info || 'Could not create the call' });
    return res.status(200).json({ ok: true, url: room.url });
  } catch (e) {
    return res.status(500).json({ error: 'Call failed' });
  }
};
