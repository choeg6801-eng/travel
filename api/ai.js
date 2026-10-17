// Momentrip AI proxy.
// The browser never sees the Anthropic key: it sends the signed-in user's
// Supabase token, this function checks it (and the email allow-list),
// then calls the Messages API with ANTHROPIC_API_KEY from Vercel settings.
const { DEFAULT_URL, DEFAULT_KEY } = require('./config.js');

const MODELS = ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'];
const MAX_CHARS = 150000;
const userCache = new Map(); // token -> { email, until }

function fail(res, status, code, message) {
  res.status(status).json({ error: { code, message } });
}

async function whoIs(token) {
  const hit = userCache.get(token);
  if (hit && hit.until > Date.now()) return hit.email;
  const url = process.env.SUPABASE_URL || DEFAULT_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY || DEFAULT_KEY;
  const r = await fetch(url + '/auth/v1/user', { headers: { apikey: key, Authorization: 'Bearer ' + token } });
  if (r.status === 401 || r.status === 403) return null;
  if (!r.ok) throw new Error('supabase ' + r.status);
  const u = await r.json();
  const email = String((u && u.email) || '').toLowerCase();
  if (!email) return null;
  if (userCache.size > 200) userCache.clear();
  userCache.set(token, { email, until: Date.now() + 60000 });
  return email;
}

// ---------- Google Gemini (free tier) ----------
const GEMINI_MODELS = () => [process.env.GEMINI_MODEL, 'gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash', 'gemini-flash-latest', 'gemini-flash-lite-latest'].filter((m, i, a) => m && a.indexOf(m) === i);
function geminiCode(status, msg) {
  if (status === 429) return 'quota';
  if (status === 400 && /API key not valid|API_KEY_INVALID/i.test(msg)) return 'bad_key';
  if (status === 401 || status === 403) return 'key_forbidden';
  if (status === 400 && /location is not supported/i.test(msg)) return 'region';
  if (status === 503 || status === 500) return 'overloaded';
  return 'upstream_error';
}
const FIRST_MS = +process.env.AI_FIRST_MS || 70000;
async function gemini(res, key, msgs, stream) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 285000);
  res.on('close', () => { if (!res.writableEnded) ctrl.abort(); });
  // same question → same answer: a seed from the request text, and a low temperature for one-shot
  // structured requests (recommendations, course options, day plans); chat turns keep a little variety
  let h = 2166136261; const all = msgs.map(m => m.role + ':' + m.content).join('\n');
  for (let i = 0; i < all.length; i++) { h ^= all.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  const oneShot = msgs.filter(m => m.role !== 'assistant').length === 1;
  // Gemini 3: keep the default temperature (Google: lower values can loop and slow down) and think at "low"
  // for speed; older models: low temperature and a small thinking budget. The seed keeps answers stable.
  const contents = msgs.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const cfgFor = (m, plain) => {
    const g = { maxOutputTokens: 30000, responseMimeType: 'application/json', seed: h % 2147483647 };
    if (plain) return g;
    if (/^gemini-3/.test(m)) g.thinkingConfig = { thinkingLevel: 'low' };
    else { g.temperature = oneShot ? 0.35 : 0.5; if (/^gemini-2\.5/.test(m)) g.thinkingConfig = { thinkingBudget: oneShot ? 1024 : 0 }; }
    return g;
  };
  const payloadFor = (m, plain) => JSON.stringify({ contents, generationConfig: cfgFor(m, plain) });
  let r = null, model, lastMsg = '', seen = [], reader = null, first = null, slow = 0;
  const list = GEMINI_MODELS(), url = m => 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(m) + ':' + (stream ? 'streamGenerateContent?alt=sse' : 'generateContent');
  for (let mi = 0; mi < list.length; mi++) {
    const m = list[mi]; model = m;
    const mc = new AbortController(), stopIt = () => mc.abort(); ctrl.signal.addEventListener('abort', stopIt);
    try {
      r = await fetch(url(m), { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: payloadFor(m, false), signal: mc.signal });
      // a model that doesn't know a speed setting: ask again without it
      if (r.status === 400) {
        const t = await r.clone().text().catch(() => '');
        if (/thinking|seed|temperature|Unknown name|Invalid JSON payload/i.test(t)) r = await fetch(url(m), { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: payloadFor(m, true), signal: mc.signal });
      }
    } catch (e) {
      if (ctrl.signal.aborted) { clearTimeout(timer); return fail(res, 504, 'timeout', 'Gemini did not answer in time'); }
      seen.push(503); r = null; continue;
    }
    // not available / busy / this model's free quota used up → try the next free model
    if ([404, 429, 500, 503].includes(r.status)) {
      seen.push(r.status);
      lastMsg = ((await r.json().catch(() => ({}))).error || {}).message || '';
      if (r.status !== 404) await new Promise(ok => setTimeout(ok, 600));
      continue;
    }
    if (!r.ok || !stream) break;
    // streaming: wait for the first piece of the answer; a model that stays silent too long is skipped,
    // so one stuck model can't leave the traveller waiting for minutes
    reader = r.body.getReader();
    const got = await Promise.race([reader.read(), new Promise(ok => setTimeout(() => ok(null), slow ? FIRST_MS * 1.5 : FIRST_MS))]).catch(() => null);
    if (got) { first = got; break; }
    mc.abort(); reader = null; seen.push(503); lastMsg = m + ' did not start answering in time';
    // two silent models in a row: Gemini is overloaded right now — say so instead of keeping the traveller waiting
    if (++slow >= 2 || ctrl.signal.aborted) break;
  }
  if (!r || !r.ok || (stream && !reader)) {
    clearTimeout(timer);
    const j = r && !r.ok ? await r.json().catch(() => ({})) : {};
    const msg = (j && j.error && j.error.message) || lastMsg;
    // every model was tried: report the real reason (used-up free quota is the usual one), not just the last model's 404
    const tried = !r || r.ok || [404, 429, 500, 503].includes(r.status);
    const code = !tried ? geminiCode(r.status, msg) : seen.includes(429) ? 'quota' : seen.some(s => s >= 500) ? 'overloaded' : r && r.status === 404 ? 'bad_model' : 'overloaded';
    return fail(res, code === 'quota' ? 429 : 502, code, msg);
  }
  const textOf = j => ((((j.candidates || [])[0] || {}).content || {}).parts || []).filter(p => !p.thought && typeof p.text === 'string').map(p => p.text).join('');
  const stopOf = j => (((j.candidates || [])[0] || {}).finishReason) || '';
  const stopCode = f => f === 'MAX_TOKENS' ? 'max_tokens' : /SAFETY|PROHIBITED|BLOCKLIST|RECITATION/.test(f) ? 'refusal' : f ? 'end_turn' : '';
  if (!stream) {
    const j = await r.json().catch(() => ({}));
    clearTimeout(timer);
    return res.status(200).json({ text: textOf(j), stop_reason: stopCode(stopOf(j)), model });
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
  const dec = new TextDecoder();
  let buf = '', stop = '', failed = '';
  try {
    for (;;) {
      const { done, value } = first || await reader.read(); first = null;
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        let j; try { j = JSON.parse(line.slice(5)); } catch (e) { continue; }
        if (j.error) { failed = geminiCode(j.error.code || 500, j.error.message || ''); break; }
        const t = textOf(j); if (t) res.write(t);
        const f = stopOf(j); if (f) stop = stopCode(f);
      }
      if (failed) break;
    }
  } catch (e) { failed = ctrl.signal.aborted ? 'timeout' : 'upstream_error'; }
  clearTimeout(timer);
  if (!res.writableEnded) { res.write(failed ? '\u0000ERR:' + failed : '\u0000END:' + stop); res.end(); }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return fail(res, 405, 'method', 'POST only');

  const geminiKey = process.env.GEMINI_API_KEY;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const useGemini = !!geminiKey && (process.env.AI_PROVIDER || '').toLowerCase() !== 'claude' || (!!geminiKey && !apiKey);
  if (!geminiKey && !apiKey) return fail(res, 500, 'no_key', 'Set GEMINI_API_KEY (free) or ANTHROPIC_API_KEY in Vercel and redeploy');

  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return fail(res, 401, 'signed_out', 'Sign in first');

  let email;
  try { email = await whoIs(token); } catch (e) { return fail(res, 502, 'network', 'Could not reach Supabase'); }
  if (!email) return fail(res, 401, 'signed_out', 'Session expired');

  // Fail closed: with no allow-list nobody can spend the key.
  if (!isAllowed(email)) return fail(res, 403, 'not_allowed', email + ' is not in ALLOWED_EMAILS');

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  const msgs = body && Array.isArray(body.messages) ? body.messages : null;
  if (!msgs || !msgs.length || msgs.length > 60) return fail(res, 400, 'bad_request', 'messages required');
  let chars = 0;
  for (const m of msgs) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string' || !m.content) return fail(res, 400, 'bad_request', 'bad message');
    chars += m.content.length;
  }
  if (chars > MAX_CHARS) return fail(res, 413, 'prompt_too_large', 'Prompt too long');
  if (msgs[0].role !== 'user') return fail(res, 400, 'bad_request', 'first message must be user');
  const model = MODELS.includes(body.model) ? body.model : (process.env.DEFAULT_MODEL || MODELS[0]);

  const stream = !!(body && body.stream);
  if (useGemini) return gemini(res, geminiKey, msgs, stream);
  // stop paying for an answer nobody is waiting for
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 285000);
  res.on('close', () => { if (!res.writableEnded) ctrl.abort(); });

  let r;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 16000, messages: msgs, stream }),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    return fail(res, 504, 'timeout', 'Claude did not answer in time');
  }
  if (!r.ok) {
    clearTimeout(timer);
    const j = await r.json().catch(() => ({}));
    const msg = (j && j.error && j.error.message) || '';
    const code = r.status === 401 ? 'bad_key' : r.status === 403 ? 'key_forbidden'
      : r.status === 404 ? 'bad_model'
      : r.status === 429 ? 'rate_limited'
      : r.status === 529 ? 'overloaded'
      : (r.status === 400 && /credit|billing/i.test(msg)) ? 'no_credit'
      : (r.status === 400 && /model/i.test(msg)) ? 'bad_model'
      : 'upstream_error';
    return fail(res, r.status === 429 ? 429 : 502, code, msg);
  }

  if (!stream) {
    const j = await r.json().catch(() => ({}));
    clearTimeout(timer);
    const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    return res.status(200).json({ text, stop_reason: j.stop_reason || '' });
  }

  // Streaming: plain text deltas, then "\u0000END:<stop_reason>" or "\u0000ERR:<code>".
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '', stop = '', failed = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        let ev; try { ev = JSON.parse(line.slice(5)); } catch (e) { continue; }
        if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') res.write(ev.delta.text);
        else if (ev.type === 'message_delta' && ev.delta && ev.delta.stop_reason) stop = ev.delta.stop_reason;
        else if (ev.type === 'error') failed = (ev.error && ev.error.type === 'overloaded_error') ? 'overloaded' : 'upstream_error';
      }
      if (failed) break;
    }
  } catch (e) {
    failed = ctrl.signal.aborted ? 'timeout' : 'upstream_error';
  }
  clearTimeout(timer);
  if (!res.writableEnded) { res.write(failed ? '\u0000ERR:' + failed : '\u0000END:' + stop); res.end(); }
};
module.exports.whoIs = whoIs;
// ALLOWED_EMAILS: "a@x.com,b@y.com" (exact), "@company.com" (a whole domain) or "*" (everyone who signs in)
function isAllowed(email) {
  email = String(email || '').toLowerCase();
  const list = String(process.env.ALLOWED_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return list.some(a => a === '*' || a === email || (a.startsWith('@') && email.endsWith(a)));
}
module.exports.isAllowed = isAllowed;
