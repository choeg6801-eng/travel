// Keeps the free Supabase databases awake. Supabase pauses a free project after about a week with no
// activity, and then login and saving stop working ("서버에 연결하지 못했어요").
// Vercel runs this once a day (vercel.json → crons). It only reads: one tiny query per database.
const { DEFAULT_URL, DEFAULT_KEY } = require('./config.js');

const TARGETS = [
  // Momentrip (+ balance-game votes, which live in the same database)
  { name: 'momentrip', url: process.env.SUPABASE_URL || DEFAULT_URL, key: process.env.SUPABASE_PUBLISHABLE_KEY || DEFAULT_KEY, path: '/rest/v1/rpc/voter_count', method: 'POST' },
  // setreview
  { name: 'setreview', url: 'https://vdqaqksvngecoakpbqvi.supabase.co', key: 'sb_publishable_sU7_eGHyI1F2siIb7cZhHg_fUVAfz0V', path: '/rest/v1/app_settings?select=*&limit=1', method: 'GET' },
];

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const out = {};
  await Promise.all(TARGETS.map(async t => {
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const r = await fetch(t.url + t.path, { method: t.method, headers: { apikey: t.key, 'content-type': 'application/json' }, body: t.method === 'POST' ? '{}' : undefined, signal: ctrl.signal });
      out[t.name] = r.status;
    } catch (e) { out[t.name] = 'unreachable'; }
    clearTimeout(timer);
  }));
  res.status(200).json({ at: new Date().toISOString(), ok: out });
};
