// Momentrip live prices (keys stay on the server).
//   GET /api/price?hotels=1&q=..&in=YYYY-MM-DD&out=YYYY-MM-DD&adults=2   → Google Hotels prices via SerpApi   (SERPAPI_KEY)
//   GET /api/price?flights=1&from=ICN&to=BKK&out=YYYY-MM-DD&back=YYYY-MM-DD&adults=2 → Google Flights via SerpApi (SERPAPI_KEY)
//   GET /api/price?rail=1&from=서울&to=강릉&date=YYYY-MM-DD   → Korail timetable + adult fare, 국토교통부 TAGO 열차정보 (DATA_GO_KR_KEY or TOURAPI_KEY)
//   GET /api/price?bus=1&from=서울&to=강릉&date=YYYY-MM-DD    → express-bus timetable + fare, 국토교통부 TAGO 고속버스정보 (same key)
const { whoIs, isAllowed } = require('./ai.js');

const cache = new Map();
const HOUR = 36e5, DAY = 24 * HOUR;
function fail(res, status, code, message) { res.status(status).json({ error: { code, message } }); }
function remember(key, body) {
  const n = body && Array.isArray(body.list) ? body.list.length : 1;
  if (!n) return body;
  if (cache.size > 2000) cache.clear();
  cache.set(key, { at: Date.now(), body });
  return body;
}
function cached(key, ttl) { const h = cache.get(key); return h && Date.now() - h.at < ttl ? h.body : null; }
const iso = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
const num = v => { const n = parseFloat(String(v == null ? '' : v).replace(/[^\d.]/g, '')); return isFinite(n) ? n : 0; };

// ---------- SerpApi: Google Hotels / Google Flights ----------
async function serp(params, key) {
  const u = 'https://serpapi.com/search.json?' + new URLSearchParams(Object.assign({ api_key: key, hl: 'ko', gl: 'kr', currency: 'KRW' }, params));
  const r = await fetch(u);
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 || r.status === 403) { const e = new Error('serpapi key'); e.code = 'bad_key'; throw e; }
  if (r.status === 429 || /run out of searches|plan limit/i.test(j.error || '')) { const e = new Error('serpapi quota'); e.code = 'quota'; throw e; }
  if (!r.ok && !j.search_metadata) { const e = new Error(j.error || ('serpapi ' + r.status)); e.code = 'upstream_error'; throw e; }
  return j;
}
async function hotels(key, q, din, dout, adults) {
  const j = await serp({ engine: 'google_hotels', q, check_in_date: din, check_out_date: dout, adults: String(adults) }, key);
  const props = (j.properties || []).slice(0, 25).map(p => ({
    name: p.name || '',
    night: num((p.rate_per_night || {}).extracted_lowest || (p.rate_per_night || {}).lowest),
    total: num((p.total_rate || {}).extracted_lowest || (p.total_rate || {}).lowest),
    rating: +p.overall_rating || 0, reviews: +p.reviews || 0, cls: p.extracted_hotel_class || 0,
    lat: p.gps_coordinates ? +p.gps_coordinates.latitude : null, lon: p.gps_coordinates ? +p.gps_coordinates.longitude : null,
    link: p.link || '',
    offers: (p.prices || []).slice(0, 4).map(o => ({ src: o.source || '', night: num((o.rate_per_night || {}).extracted_lowest || (o.rate_per_night || {}).lowest), link: o.link || '' })).filter(o => o.src && o.night),
  })).filter(p => p.name && p.night);
  return { src: 'google_hotels', at: Date.now(), url: (j.search_metadata || {}).google_hotels_url || '', list: props };
}
async function flights(key, from, to, dout, dback, adults) {
  const params = { engine: 'google_flights', departure_id: from, arrival_id: to, outbound_date: dout, adults: String(adults), type: dback ? '1' : '2' };
  if (dback) params.return_date = dback;
  const j = await serp(params, key);
  const all = [].concat(j.best_flights || [], j.other_flights || []);
  const list = all.slice(0, 8).map(o => {
    const legs = o.flights || [], a = legs[0] || {}, z = legs[legs.length - 1] || {};
    return {
      price: num(o.price), mins: +o.total_duration || 0, stops: Math.max(0, legs.length - 1),
      airline: [...new Set(legs.map(l => l.airline).filter(Boolean))].join(' · '),
      no: legs.map(l => l.flight_number).filter(Boolean).join(', '),
      dep: (a.departure_airport || {}).time || '', arr: (z.arrival_airport || {}).time || '',
      depId: (a.departure_airport || {}).id || from, arrId: (z.arrival_airport || {}).id || to,
    };
  }).filter(x => x.price);
  const pi = j.price_insights || {};
  return { src: 'google_flights', at: Date.now(), url: (j.search_metadata || {}).google_flights_url || '', round: !!dback, list,
    insight: { low: num(pi.lowest_price), level: pi.price_level || '', typical: Array.isArray(pi.typical_price_range) ? pi.typical_price_range.map(num) : [] } };
}

// ---------- 국토교통부 TAGO (data.go.kr) ----------
function goKey(k) { return /%[0-9A-Fa-f]{2}/.test(k) ? k : encodeURIComponent(k); }
async function tago(paths, op, params, key) {
  // the gateway moved in 2026 (TrainInfoService → TrainInfo, getX → GetX); try the new path first
  let last;
  for (const [base, o] of paths.map(p => [p, op])) {
    const name = /Service$/.test(base) ? o.charAt(0).toLowerCase() + o.slice(1) : o;
    const u = 'https://apis.data.go.kr/1613000/' + base + '/' + name + '?serviceKey=' + goKey(key) + '&_type=json&numOfRows=500&pageNo=1&' + new URLSearchParams(params);
    try {
      const r = await fetch(u); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {}
      const head = j && j.response && j.response.header;
      if (head && head.resultCode === '00') { const it = j.response.body && j.response.body.items; return it ? [].concat(it.item || []) : []; }
      const reason = (head && head.resultMsg) || (t.match(/<returnAuthMsg>([^<]+)/) || [])[1] || ('HTTP ' + r.status);
      last = new Error(reason); last.code = /SERVICE_KEY|NOT_REGISTERED|UNREGISTERED|SERVICE ACCESS DENIED|키/i.test(reason) ? 'not_registered' : 'upstream_error';
    } catch (e) { last = e; }
  }
  throw last || new Error('tago');
}
const TRAIN = ['TrainInfo', 'TrainInfoService'], BUS = ['ExpBusInfo', 'ExpBusInfoService'];
let STATIONS = null, TERMINALS = null;
async function stations(key) {
  if (STATIONS && Date.now() - STATIONS.at < 30 * DAY) return STATIONS.list;
  const cities = await tago(TRAIN, 'GetCtyCodeList', {}, key);
  const lists = await Promise.all(cities.map(c => tago(TRAIN, 'GetCtyAcctoTrainSttnList', { cityCode: c.citycode }, key).then(l => l.map(s => ({ id: s.nodeid, name: String(s.nodename || ''), city: c.cityname })), () => [])));
  const list = [].concat(...lists).filter(s => s.id && s.name);
  if (list.length) STATIONS = { at: Date.now(), list };
  return list;
}
async function terminals(key) {
  if (TERMINALS && Date.now() - TERMINALS.at < 30 * DAY) return TERMINALS.list;
  const l = await tago(BUS, 'GetExpBusTrminlList', {}, key);
  const list = l.map(t => ({ id: t.terminalId || t.terminalid, name: String(t.terminalNm || t.terminalnm || '') })).filter(t => t.id && t.name);
  if (list.length) TERMINALS = { at: Date.now(), list };
  return list;
}
const bare = s => String(s || '').replace(/\s/g, '').replace(/(특별시|광역시|특별자치시|특별자치도|시|군)$/, '');
// main stations first for big cities; otherwise the station named after the city
const MAIN = { 서울: ['서울', '용산', '청량리', '영등포', '광명'], 부산: ['부산', '구포', '부전'], 대구: ['동대구', '서대구', '대구'], 대전: ['대전', '서대전'], 광주: ['광주송정', '광주'], 인천: ['인천공항T1', '검암'], 수원: ['수원', '광명'], 울산: ['울산(통도사)', '태화강'], 여수: ['여수EXPO', '여천'], 경주: ['경주', '신경주'], 포항: ['포항'], 강릉: ['강릉', '정동진'], 전주: ['전주'], 목포: ['목포'], 순천: ['순천'], 춘천: ['춘천', '남춘천'], 천안: ['천안아산', '천안'], 아산: ['천안아산', '온양온천'], 안동: ['안동'], 동해: ['동해', '묵호'], 정동진: ['정동진'], 진주: ['진주'], 창원: ['창원중앙', '창원'], 김천: ['김천구미', '김천'], 익산: ['익산'], 오송: ['오송'] };
function pickStations(all, city) {
  const c = bare(city), want = MAIN[c] || [c];
  const out = [];
  want.forEach(n => all.filter(s => s.name === n).forEach(s => { if (!out.some(o => o.id === s.id)) out.push(s); }));
  if (!out.length) all.filter(s => s.name.startsWith(c) || bare(s.name) === c).forEach(s => out.push(s));
  return out.slice(0, 3);
}
const MAIN_T = { 서울: ['서울경부', '센트럴시티(서울)', '동서울'], 부산: ['부산', '부산해운대', '서부산(사상)'], 대구: ['동대구', '서대구'], 대전: ['대전복합', '유성'], 광주: ['광주(유·스퀘어)'], 인천: ['인천'] };
function pickTerminals(all, city) {
  const c = bare(city), want = MAIN_T[c] || [];
  const out = [];
  want.forEach(n => all.filter(t => t.name === n).forEach(t => out.push(t)));
  if (!out.length) all.filter(t => t.name === c || t.name.startsWith(c)).forEach(t => out.push(t));
  return out.slice(0, 3);
}
const hhmm = v => { const s = String(v || ''); return s.length >= 12 ? s.slice(8, 10) + ':' + s.slice(10, 12) : ''; };
async function rail(key, from, to, date) {
  const all = await stations(key), A = pickStations(all, from), B = pickStations(all, to);
  if (!A.length || !B.length) return { src: 'tago', list: [], none: !A.length ? 'from' : 'to' };
  const d = date.replace(/-/g, ''), pairs = [];
  A.forEach(a => B.forEach(b => { if (pairs.length < 6) pairs.push([a, b]); }));
  const rs = await Promise.all(pairs.map(([a, b]) => tago(TRAIN, 'GetStrtpntAlocFndTrainInfo', { depPlaceId: a.id, arrPlaceId: b.id, depPlandTime: d }, key).catch(() => [])));
  const seen = new Set(), list = [];
  [].concat(...rs).forEach(x => {
    const k = x.trainno + '|' + x.depplandtime; if (seen.has(k)) return; seen.add(k);
    list.push({ no: String(x.trainno || '').replace(/^0+/, ''), grade: x.traingradename || '', from: x.depplacename || '', to: x.arrplacename || '', dep: hhmm(x.depplandtime), arr: hhmm(x.arrplandtime), fare: +x.adultcharge || 0, mins: x.depplandtime && x.arrplandtime ? minsBetween(x.depplandtime, x.arrplandtime) : 0 });
  });
  list.sort((a, b) => a.dep.localeCompare(b.dep));
  return { src: 'tago_train', date, list };
}
async function bus(key, from, to, date) {
  const all = await terminals(key), A = pickTerminals(all, from), B = pickTerminals(all, to);
  if (!A.length || !B.length) return { src: 'tago_bus', list: [], none: !A.length ? 'from' : 'to' };
  const d = date.replace(/-/g, ''), pairs = [];
  A.forEach(a => B.forEach(b => { if (pairs.length < 6) pairs.push([a, b]); }));
  // keep the terminal ids: they carry the KOBUS terminal codes (NAEK010 → 010) for a ready-filled booking page
  const rs = await Promise.all(pairs.map(([a, b]) => tago(BUS, 'GetStrtpntAlocFndExpbusInfo', { depTerminalId: a.id, arrTerminalId: b.id, depPlandTime: d }, key).then(l => l.map(x => Object.assign({ _dep: a.id, _arr: b.id }, x)), () => [])));
  const seen = new Set(), list = [];
  [].concat(...rs).forEach(x => {
    const dep = String(x.depPlandTime || ''), arr = String(x.arrPlandTime || ''), k = (x.depPlaceNm || '') + dep + (x.gradeNm || '');
    if (seen.has(k)) return; seen.add(k);
    list.push({ grade: x.gradeNm || '', from: x.depPlaceNm || '', to: x.arrPlaceNm || '', dep: hhmm(dep), arr: hhmm(arr), fare: +x.charge || 0, mins: dep && arr ? minsBetween(dep, arr) : 0, depId: String(x._dep || ''), arrId: String(x._arr || '') });
  });
  list.sort((a, b) => a.dep.localeCompare(b.dep));
  return { src: 'tago_bus', date, list };
}
function minsBetween(a, b) {
  const t = s => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12));
  const m = Math.round((t(String(b)) - t(String(a))) / 6e4); return m > 0 && m < 24 * 60 ? m : 0;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return fail(res, 405, 'method', 'GET only');
  const sKey = process.env.SERPAPI_KEY, dKey = process.env.DATA_GO_KR_KEY || process.env.TOURAPI_KEY;
  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return fail(res, 401, 'signed_out', 'Sign in first');
  let email;
  try { email = await whoIs(token); } catch (e) { return fail(res, 502, 'network', 'Could not reach Supabase'); }
  if (!email) return fail(res, 401, 'signed_out', 'Session expired');
  if (!isAllowed(email)) return fail(res, 403, 'not_allowed', email + ' is not in ALLOWED_EMAILS');
  const q = req.query || {};
  const adults = Math.max(1, Math.min(8, parseInt(q.adults, 10) || 2));
  try {
    if (q.hotels) {
      if (!sKey) return fail(res, 501, 'no_key', 'SERPAPI_KEY is not set');
      const text = String(q.q || '').trim().slice(0, 80);
      if (text.length < 2 || !iso(q.in) || !iso(q.out) || q.out <= q.in) return fail(res, 400, 'bad_request', 'q, in, out required');
      const ck = 'h|' + text + '|' + q.in + '|' + q.out + '|' + adults, hit = cached(ck, 3 * HOUR);
      if (hit) return res.status(200).json(hit);
      return res.status(200).json(remember(ck, await hotels(sKey, text, q.in, q.out, adults)));
    }
    if (q.flights) {
      if (!sKey) return fail(res, 501, 'no_key', 'SERPAPI_KEY is not set');
      const from = String(q.from || '').toUpperCase(), to = String(q.to || '').toUpperCase();
      if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to) || !iso(q.out) || (q.back && (!iso(q.back) || q.back < q.out))) return fail(res, 400, 'bad_request', 'from, to (IATA), out required');
      const ck = 'f|' + from + to + '|' + q.out + '|' + (q.back || '') + '|' + adults, hit = cached(ck, 3 * HOUR);
      if (hit) return res.status(200).json(hit);
      return res.status(200).json(remember(ck, await flights(sKey, from, to, q.out, q.back || '', adults)));
    }
    if (q.rail || q.bus) {
      if (!dKey) return fail(res, 501, 'no_key', 'DATA_GO_KR_KEY is not set');
      const from = String(q.from || '').trim().slice(0, 20), to = String(q.to || '').trim().slice(0, 20);
      if (!from || !to || !iso(q.date)) return fail(res, 400, 'bad_request', 'from, to, date required');
      const ck = (q.rail ? 'r|' : 'b|') + from + '|' + to + '|' + q.date, hit = cached(ck, 6 * HOUR);
      if (hit) return res.status(200).json(hit);
      return res.status(200).json(remember(ck, q.rail ? await rail(dKey, from, to, q.date) : await bus(dKey, from, to, q.date)));
    }
    return fail(res, 400, 'bad_request', 'hotels, flights, rail or bus');
  } catch (e) {
    if (e.code === 'bad_key') return fail(res, 502, 'bad_key', 'The price key was rejected');
    if (e.code === 'quota') return fail(res, 429, 'quota', 'SerpApi monthly searches used up');
    if (e.code === 'not_registered') return fail(res, 502, 'not_registered', String(e.message || ''));
    return fail(res, 502, e.code || 'upstream_error', String(e.message || e));
  }
};
module.exports.pickStations = pickStations; module.exports.pickTerminals = pickTerminals;
