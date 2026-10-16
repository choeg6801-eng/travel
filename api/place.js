// Momentrip real-place lookups (keys stay on the server).
//   GET /api/place?q=..&lat=..&lon=..&dom=1       → find one place (to check that a stop exists / is open)
//       Korea + KAKAO_REST_API_KEY → Kakao Local; otherwise GOOGLE_PLACES_API_KEY → Google Places (also says if it closed)
//   GET /api/place?pool=1&city=..&lat=..&lon=..&kw=a,b → Korean candidate places from Kakao Local, before the AI plans
const { whoIs, isAllowed } = require('./ai.js');

const cache = new Map(); // key -> { at, body }
const DAY = 864e5;

function fail(res, status, code, message) {
  res.status(status).json({ error: { code, message } });
}
function remember(key, body) {
  if (cache.size > 3000) cache.clear();
  cache.set(key, { at: Date.now(), body });
  return body;
}
function distKm(a, b) {
  const t = Math.PI / 180, dLa = (b[0] - a[0]) * t, dLo = (b[1] - a[1]) * t;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * t) * Math.cos(b[0] * t) * Math.sin(dLo / 2) ** 2;
  return Math.round(2 * 6371 * Math.asin(Math.sqrt(h)));
}

// ---------- Kakao Local ----------
async function kakao(path, params, key) {
  const u = 'https://dapi.kakao.com/v2/local/search/' + path + '.json?' + new URLSearchParams(params);
  const r = await fetch(u, { headers: { Authorization: 'KakaoAK ' + key } });
  if (r.status === 401 || r.status === 403) { const e = new Error('kakao key'); e.code = 'bad_key'; throw e; }
  if (!r.ok) { const e = new Error('kakao ' + r.status); e.code = 'upstream_error'; throw e; }
  return (await r.json()).documents || [];
}
const kItem = d => ({ id: d.id, name: d.place_name, lat: +d.y, lon: +d.x, u: String(d.place_url || '').replace(/^http:/, 'https:'), addr: d.road_address_name || d.address_name || '', cat: d.category_name || '', code: d.category_group_code || '' });

function kCat(p) {
  const c = p.cat;
  if (p.code === 'CE7' || /카페|디저트|베이커리|제과/.test(c)) return '카페';
  if (/술집|바$|> 바 |와인바|칵테일바|재즈바|LP바|펍|호프|이자카야/.test(c)) return '바';
  if (p.code === 'FD6' || /^음식점/.test(c)) return '맛집';
  if (/시장|쇼핑|백화점|아울렛|쇼핑몰/.test(c)) return '쇼핑';
  if (/테마파크|놀이|체험|레저|아쿠아|동물원|수목원|워터파크|스포츠/.test(c)) return '체험';
  return '명소';
}
const CHAINS = /스타벅스|투썸|이디야|메가.?커피|메가MGC|빽다방|컴포즈|맥도날드|버거킹|롯데리아|맘스터치|KFC|파리바게뜨|뚜레쥬르|배스킨|던킨|폴바셋|할리스|커피빈|엔제리너스|파스쿠찌|공차|서브웨이|도미노|피자헛|교촌|BBQ|bhc|굽네|김밥천국|이삭토스트|CU|GS25|세븐일레븐|이마트24/i;

async function kakaoPool(key, city, ll, kws) {
  const xy = { x: ll[1], y: ll[0] };
  const jobs = [];
  // nearby by category, ranked by Kakao's relevance
  for (const code of ['AT4', 'CT1', 'FD6', 'CE7']) for (const page of [1, 2, 3]) jobs.push({ tag: code, w: 1, call: () => kakao('category', { category_group_code: code, ...xy, radius: 20000, sort: 'accuracy', page, size: 15 }, key) });
  // what people search for in this city, plus the traveller's own taste words
  const words = ['가볼만한곳', '관광명소', '맛집', '현지인 맛집', '카페', '시장'].concat(kws.map(k => k + ' 맛집').filter((x, i) => i < 1)).concat(kws);
  for (const w of words) for (const page of [1, 2]) jobs.push({ tag: w, w: kws.includes(w) ? 2 : 1.5, call: () => kakao('keyword', { query: city + ' ' + w, ...xy, page, size: 15 }, key) });
  const results = await Promise.all(jobs.map(j => j.call().then(list => ({ j, list }), e => { if (e.code === 'bad_key') throw e; return { j, list: [] }; })));
  const byId = new Map();
  for (const { j, list } of results) list.forEach((d, i) => {
    const p = byId.get(d.id) || Object.assign(kItem(d), { sc: 0, hits: 0 });
    p.sc += j.w * (1 - i / 20); p.hits++;
    byId.set(d.id, p);
  });
  const out = [];
  for (const p of byId.values()) {
    if (CHAINS.test(p.name)) continue;
    const d = distKm(ll, [p.lat, p.lon]); if (d > 45) continue;
    out.push({ name: p.name, ko: '', cat: kCat(p), sub: p.cat.split('>').map(s => s.trim()).filter(Boolean).slice(-1)[0] || '', d, lat: p.lat, lon: p.lon, u: p.u, sc: p.sc + p.hits * 0.5 - d / 15 });
  }
  return { src: 'kakao', list: out };
}

// ---------- Google Places (New): only Pro fields (5,000 free requests a month) ----------
async function google(key, q, ll, size) {
  const body = { textQuery: q, languageCode: 'ko', pageSize: Math.max(1, Math.min(20, size || 5)) };
  if (ll) body.locationBias = { circle: { center: { latitude: ll[0], longitude: ll[1] }, radius: 50000 } };
  const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'places.id,places.displayName,places.location,places.businessStatus,places.googleMapsUri,places.primaryType' },
    body: JSON.stringify(body),
  });
  if (r.status === 401 || r.status === 403) { const e = new Error('google key'); e.code = 'bad_key'; throw e; }
  if (!r.ok) { const e = new Error('google ' + r.status); e.code = 'upstream_error'; throw e; }
  const j = await r.json();
  return { src: 'google', items: (j.places || []).map(p => ({ id: p.id || '', name: (p.displayName || {}).text || '', lat: (p.location || {}).latitude, lon: (p.location || {}).longitude, u: p.googleMapsUri || '', status: p.businessStatus || 'OPERATIONAL', type: p.primaryType || '' })).filter(x => x.name && isFinite(x.lat)) };
}

// Google Places restaurants/cafes with ratings for trips abroad. Uses Enterprise fields
// (rating, review count, price level): 1,000 free requests a month, ~4 per new city.
const PRICE = { PRICE_LEVEL_INEXPENSIVE: '저렴', PRICE_LEVEL_MODERATE: '보통', PRICE_LEVEL_EXPENSIVE: '고급', PRICE_LEVEL_VERY_EXPENSIVE: '고급' };
function gCat(t) {
  t = String(t || '');
  if (/cafe|coffee|bakery|dessert|tea_house|ice_cream|confectionery|juice/.test(t)) return '카페';
  if (/restaurant|food|bar_and_grill|diner|steak|ramen|sushi|noodle|bistro|brunch|meal|pub/.test(t)) return '맛집';
  if (/market|shopping|mall|store/.test(t)) return '쇼핑';
  if (/amusement|zoo|aquarium|park|spa/.test(t)) return '체험';
  return '명소';
}
async function googlePool(key, city, ll, kws) {
  const qs = [city + ' 맛집', city + ' 현지 맛집', city + ' 카페', city + ' 가볼만한 곳'].concat(kws.filter(k => !/맛집|카페/.test(k)).slice(0, 2).map(k => city + ' ' + k + ' 맛집'));
  const mask = 'places.id,places.displayName,places.location,places.businessStatus,places.googleMapsUri,places.primaryType,places.rating,places.userRatingCount,places.priceLevel';
  const runs = await Promise.all(qs.map(q => fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': mask },
    body: JSON.stringify({ textQuery: q, languageCode: 'ko', pageSize: 20, locationBias: { circle: { center: { latitude: ll[0], longitude: ll[1] }, radius: 20000 } } }),
  }).then(async r => {
    if (r.status === 401 || r.status === 403) { const e = new Error('google key'); e.code = 'bad_key'; throw e; }
    return r.ok ? ((await r.json()).places || []) : [];
  }, () => [])));
  const seen = new Map(), low = [];
  runs.forEach(list => list.forEach((p, i) => {
    const n = +p.userRatingCount || 0, rt = +p.rating || 0, nm = (p.displayName || {}).text || '';
    const bad = (p.businessStatus && p.businessStatus !== 'OPERATIONAL') || (n >= 30 && rt && rt < 3.9);
    if (bad && p.location) { low.push({ name: nm, lat: p.location.latitude, lon: p.location.longitude }); return; }
    if (!p.location || (n && rt && (rt < 4.0 || n < 30))) return;
    const d = distKm(ll, [p.location.latitude, p.location.longitude]); if (d > 20) return;
    const bayes = n ? (rt * n + 4.1 * 150) / (n + 150) : 4.0; // fewer reviews → pulled toward average
    const sc = (bayes - 4.0) * 12 + Math.log10(n + 1) + (1 - i / 25) - d / 10;
    const prev = seen.get(p.id);
    if (prev) { prev.sc += 1; return; }
    const cnt = n >= 10000 ? (n / 10000).toFixed(1) + '만' : n >= 1000 ? (n / 1000).toFixed(1) + '천' : String(n);
    const rating = rt ? '★' + rt.toFixed(1) + ' (' + cnt + ')' : '';
    seen.set(p.id, { gid: p.id, name: (p.displayName || {}).text || '', ko: '', cat: gCat(p.primaryType), sub: String(p.primaryType || '').replace(/_/g, ' '), d, lat: p.location.latitude, lon: p.location.longitude, u: p.googleMapsUri || '', src: 'google', sc, rating: rating ? 'Google ' + rating : '', info: [rating, PRICE[p.priceLevel] || ''].filter(Boolean).join(' · ') });
  }));
  return { src: 'google', list: [...seen.values()].filter(x => x.name), low };
}

// ---------- 한국관광공사 TourAPI (KorService2): official festivals and registered lodging ----------
function tourKey(k) { return /%[0-9A-Fa-f]{2}/.test(k) ? k : encodeURIComponent(k); } // accepts the "Encoding" or "Decoding" key
async function tour(op, params, key) {
  const u = 'https://apis.data.go.kr/B551011/KorService2/' + op + '?serviceKey=' + tourKey(key) + '&MobileOS=ETC&MobileApp=Momentrip&_type=json&' + new URLSearchParams(params);
  const r = await fetch(u);
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch (e) { const er = new Error(/SERVICE_KEY|NOT_REGISTERED|UNREGISTERED/i.test(text) ? 'tour key' : 'tour ' + r.status); er.code = /SERVICE_KEY|NOT_REGISTERED|UNREGISTERED/i.test(text) ? 'bad_key' : 'upstream_error'; throw er; }
  const body = (j.response || {}).body || {};
  const it = (body.items || {}).item;
  return { total: +body.totalCount || 0, items: Array.isArray(it) ? it : it ? [it] : [] };
}
const ymd = d => String(d || '').replace(/-/g, '');
const iso = d => /^\d{8}$/.test(String(d)) ? String(d).slice(0, 4) + '-' + String(d).slice(4, 6) + '-' + String(d).slice(6, 8) : '';
async function tourFestivals(key, ll, from, to) {
  // ask from 3 months earlier so long-running festivals that already started are included, then keep the overlapping ones
  const f = new Date(from); f.setMonth(f.getMonth() - 3);
  const params = { eventStartDate: ymd(f.toISOString().slice(0, 10)), eventEndDate: ymd(to), numOfRows: 500, pageNo: 1, arrange: 'A' };
  const first = await tour('searchFestival2', params, key);
  let items = first.items;
  if (first.total > 500) items = items.concat((await tour('searchFestival2', { ...params, pageNo: 2 }, key)).items);
  return items.map(x => ({ kind: 'festival', name: String(x.title || '').trim(), start: iso(x.eventstartdate), end: iso(x.eventenddate), place: x.addr1 || '', lat: +x.mapy, lon: +x.mapx, img: x.firstimage || '', src: 'tour' }))
    .filter(e => e.name && e.start && e.start <= to && (e.end || e.start) >= from && isFinite(e.lat) && e.lat && distKm(ll, [e.lat, e.lon]) <= 50)
    .map(e => Object.assign(e, { d: distKm(ll, [e.lat, e.lon]), url: 'https://search.naver.com/search.naver?query=' + encodeURIComponent(e.name) }));
}
async function tourStays(key, ll) {
  const r = await tour('locationBasedList2', { mapX: ll[1], mapY: ll[0], radius: 8000, contentTypeId: 32, numOfRows: 100, pageNo: 1, arrange: 'E' }, key);
  return r.items.map(x => {
    const name = String(x.title || '').trim(), t = name;
    const cat = /호스텔|게스트하우스|게하/.test(t) ? '게스트하우스' : /펜션|풀빌라/.test(t) ? '펜션' : /한옥/.test(t) ? '한옥' : /리조트|콘도/.test(t) ? '리조트' : /모텔/.test(t) ? '모텔' : /레지던스|스테이/.test(t) ? '스테이' : '호텔';
    return { name, ko: '', cat, sub: '관광공사 등록', lat: +x.mapy, lon: +x.mapx, src: 'tour', sc: 2.5, info: '한국관광공사 등록 숙소' + (x.addr1 ? ' · ' + String(x.addr1).split(' ').slice(0, 3).join(' ') : ''), u: '' };
  }).filter(x => x.name && isFinite(x.lat) && x.lat);
}
// ---------- lodging candidates ----------
async function kakaoStays(key, city, ll, types) {
  const xy = { x: ll[1], y: ll[0] };
  const jobs = [1, 2, 3].map(page => kakao('category', { category_group_code: 'AD5', ...xy, radius: 8000, sort: 'accuracy', page, size: 15 }, key));
  types.slice(0, 3).forEach(t => jobs.push(kakao('keyword', { query: city + ' ' + t, ...xy, radius: 15000, page: 1, size: 15 }, key)));
  const lists = await Promise.all(jobs.map(j => j.catch(e => { if (e.code === 'bad_key') throw e; return []; })));
  const by = new Map();
  lists.forEach((L, k) => L.forEach((d, i) => {
    const p = by.get(d.id) || Object.assign(kItem(d), { sc: 0 });
    p.sc += (k >= 3 ? 1.5 : 1) * (1 - i / 20);
    by.set(d.id, p);
  }));
  return [...by.values()].filter(p => p.code === 'AD5' || /숙박/.test(p.cat)).map(p => {
    const sub = p.cat.split('>').map(s => s.trim()).filter(Boolean);
    const kind = sub[2] || sub[1] || '숙소';
    return { name: p.name, ko: '', cat: /모텔/.test(kind) ? '모텔' : kind.replace(/^숙박$/, '숙소'), sub: sub.slice(-1)[0] || '', lat: p.lat, lon: p.lon, u: p.u, src: 'kakao', sc: p.sc, info: sub.slice(2).join(' · ') };
  });
}
async function googleStays(key, city, ll, types) {
  const mask = 'places.id,places.displayName,places.location,places.businessStatus,places.googleMapsUri,places.primaryType,places.rating,places.userRatingCount,places.priceLevel';
  const qs = [city + ' 숙소'].concat(types.slice(0, 2).map(t => city + ' ' + t));
  const runs = await Promise.all(qs.map(q => fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST', headers: { 'content-type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': mask },
    body: JSON.stringify({ textQuery: q, includedType: 'lodging', languageCode: 'ko', pageSize: 20, locationBias: { circle: { center: { latitude: ll[0], longitude: ll[1] }, radius: 6000 } } }),
  }).then(async r => { if (r.status === 401 || r.status === 403) { const e = new Error('google key'); e.code = 'bad_key'; throw e; } return r.ok ? ((await r.json()).places || []) : []; }, () => [])));
  const seen = new Map();
  runs.forEach(L => L.forEach((p, i) => {
    if (!p.location || (p.businessStatus && p.businessStatus !== 'OPERATIONAL') || seen.has(p.id)) return;
    const n = +p.userRatingCount || 0, rt = +p.rating || 0;
    if (n >= 20 && rt && rt < 3.8) return;
    const cnt = n >= 10000 ? (n / 10000).toFixed(1) + '만' : n >= 1000 ? (n / 1000).toFixed(1) + '천' : String(n);
    const t = String(p.primaryType || '');
    const cat = /hostel/.test(t) ? '호스텔' : /guest_house|bed_and_breakfast/.test(t) ? '게스트하우스' : /resort/.test(t) ? '리조트' : /motel/.test(t) ? '모텔' : /apartment|cottage|private_guest_room/.test(t) ? '아파트형' : '호텔';
    seen.set(p.id, { name: (p.displayName || {}).text || '', ko: '', cat, sub: t.replace(/_/g, ' '), lat: p.location.latitude, lon: p.location.longitude, u: p.googleMapsUri || '', src: 'google', sc: 1 - i / 25,
      info: [rt ? '★' + rt.toFixed(1) + ' (' + cnt + ')' : '', PRICE[p.priceLevel] || ''].filter(Boolean).join(' · ') });
  }));
  return [...seen.values()].filter(x => x.name);
}
// ---------- Ticketmaster: concerts, sports, shows near the destination ----------
async function ticketmaster(key, ll, from, to) {
  const u = 'https://app.ticketmaster.com/discovery/v2/events.json?' + new URLSearchParams({ apikey: key, latlong: ll[0] + ',' + ll[1], radius: '40', unit: 'km', startDateTime: from + 'T00:00:00Z', endDateTime: to + 'T23:59:59Z', size: '100', sort: 'relevance,desc', locale: '*' });
  const r = await fetch(u);
  if (r.status === 401 || r.status === 403) { const e = new Error('tm key'); e.code = 'bad_key'; throw e; }
  if (!r.ok) return [];
  const j = await r.json();
  const by = new Map();
  (((j._embedded || {}).events) || []).forEach(ev => {
    const name = String(ev.name || '').trim(); if (!name) return;
    const d = ((ev.dates || {}).start || {}).localDate || '';
    const v = (((ev._embedded || {}).venues) || [])[0] || {};
    const seg = (((ev.classifications || [])[0] || {}).segment || {}).name || '';
    const g = by.get(name);
    if (g) { if (d && d < g.start) g.start = d; if (d && d > g.end) g.end = d; return; }
    by.set(name, { kind: 'show', name, start: d, end: d, place: v.name || '', lat: v.location ? +v.location.latitude : null, lon: v.location ? +v.location.longitude : null, desc: seg, url: ev.url || '', src: 'tm' });
  });
  return [...by.values()].slice(0, 25);
}

// ---------- opening hours of one Google place (Place Details, Enterprise field: 1,000 free a month) ----------
async function googleHours(key, id) {
  const r = await fetch('https://places.googleapis.com/v1/places/' + encodeURIComponent(id) + '?languageCode=ko', { headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'regularOpeningHours' } });
  if (r.status === 401 || r.status === 403) { const e = new Error('google key'); e.code = 'bad_key'; throw e; }
  if (!r.ok) { const e = new Error('google ' + r.status); e.code = 'upstream_error'; throw e; }
  const h = (await r.json()).regularOpeningHours || {};
  const pt = x => x ? [x.day, (x.hour || 0) * 60 + (x.minute || 0)] : null;
  return { periods: (h.periods || []).map(p => ({ o: pt(p.open), c: pt(p.close) })), text: h.weekdayDescriptions || [] };
}
// ---------- 외교부 국가·지역별 여행경보 (data.go.kr, same key as TourAPI) ----------
let ALERTS = null;
async function travelAlerts(key) {
  if (ALERTS && Date.now() - ALERTS.at < DAY / 2) return ALERTS.map;
  const u = 'https://apis.data.go.kr/1262000/TravelAlarmService2/getTravelAlarmList2?serviceKey=' + tourKey(key) + '&returnType=JSON&numOfRows=500&pageNo=1';
  const r = await fetch(u); const text = await r.text();
  let j; try { j = JSON.parse(text); } catch (e) { const er = new Error('alert ' + r.status); er.code = /SERVICE_KEY|NOT_REGISTERED|UNREGISTERED/i.test(text) ? 'bad_key' : 'upstream_error'; throw er; }
  const body = (j.response || {}).body || j;
  let items = body.data || (body.items && (body.items.item || body.items)) || [];
  if (!Array.isArray(items)) items = [items];
  const pick = (o, re) => { for (const k of Object.keys(o)) if (re.test(k)) return o[k]; return undefined; };
  const map = {};
  items.forEach(o => {
    if (!o || typeof o !== 'object') return;
    const cc = String(pick(o, /iso.*alp2|alp2|iso2/i) || '').toUpperCase(); if (!/^[A-Z]{2}$/.test(cc)) return;
    const lvl = parseInt(pick(o, /alarm.?lvl|alarmlevel|lvl/i), 10) || 0;
    const region = String(pick(o, /region|remark|area/i) || '').slice(0, 80);
    if (!map[cc] || lvl > map[cc].lvl) map[cc] = { lvl, region: lvl ? region : '' };
  });
  ALERTS = { at: Date.now(), map };
  return map;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return fail(res, 405, 'method', 'GET only');
  const kKey = process.env.KAKAO_REST_API_KEY, gKey = process.env.GOOGLE_PLACES_API_KEY, tKey = process.env.TOURAPI_KEY, mKey = process.env.TICKETMASTER_API_KEY;
  if (!kKey && !gKey && !tKey && !mKey) return fail(res, 501, 'no_key', 'No place keys are set');

  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return fail(res, 401, 'signed_out', 'Sign in first');
  let email;
  try { email = await whoIs(token); } catch (e) { return fail(res, 502, 'network', 'Could not reach Supabase'); }
  if (!email) return fail(res, 401, 'signed_out', 'Session expired');
  if (!isAllowed(email)) return fail(res, 403, 'not_allowed', email + ' is not in ALLOWED_EMAILS');

  const q = req.query || {};
  const lat = parseFloat(q.lat), lon = parseFloat(q.lon);
  const ll = isFinite(lat) && isFinite(lon) ? [lat, lon] : null;
  try {
    if (q.hours) {
      if (!gKey) return fail(res, 501, 'no_key', 'GOOGLE_PLACES_API_KEY is not set');
      const id = String(q.id || ''); if (!/^[A-Za-z0-9_-]{10,}$/.test(id)) return fail(res, 400, 'bad_request', 'id required');
      const ck = 'hours|' + id, hit = cache.get(ck);
      if (hit && Date.now() - hit.at < 7 * DAY) return res.status(200).json(hit.body);
      return res.status(200).json(remember(ck, await googleHours(gKey, id)));
    }
    if (q.alert) {
      if (!tKey) return fail(res, 501, 'no_key', 'TOURAPI_KEY is not set');
      const cc = String(q.cc || '').toUpperCase(); if (!/^[A-Z]{2}$/.test(cc)) return fail(res, 400, 'bad_request', 'cc required');
      const map = await travelAlerts(tKey);
      return res.status(200).json(map[cc] || { lvl: 0 });
    }
    const isoOk = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
    if (q.fest || q.tm) {
      if (!ll || !isoOk(q.from) || !isoOk(q.to) || q.to < q.from) return fail(res, 400, 'bad_request', 'lat, lon, from, to required');
      const useKey = q.fest ? tKey : mKey;
      if (!useKey) return fail(res, 501, 'no_key', (q.fest ? 'TOURAPI_KEY' : 'TICKETMASTER_API_KEY') + ' is not set');
      const ck = (q.fest ? 'fest|' : 'tm|') + ll[0].toFixed(2) + ',' + ll[1].toFixed(2) + '|' + q.from + '|' + q.to;
      const hit = cache.get(ck);
      if (hit && Date.now() - hit.at < DAY / 2) return res.status(200).json(hit.body);
      const list = q.fest ? await tourFestivals(useKey, ll, q.from, q.to) : await ticketmaster(useKey, ll, q.from, q.to);
      return res.status(200).json(remember(ck, { list }));
    }
    if (q.stay) {
      if (!ll) return fail(res, 400, 'bad_request', 'lat, lon required');
      const city = String(q.city || '').trim().slice(0, 40);
      const types = String(q.kw || '').split(',').map(s => s.trim()).filter(s => s.length >= 2).slice(0, 3);
      const dom = q.dom === '1';
      const ck = 'stay|' + city + '|' + ll[0].toFixed(3) + ',' + ll[1].toFixed(3) + '|' + types.join(',') + '|' + dom;
      const hit = cache.get(ck);
      if (hit && Date.now() - hit.at < DAY) return res.status(200).json(hit.body);
      const jobs = [];
      if (dom && kKey) jobs.push(kakaoStays(kKey, city, ll, types));
      if (dom && tKey) jobs.push(tourStays(tKey, ll).catch(() => []));
      if (gKey) jobs.push(googleStays(gKey, city, ll, types));
      if (!jobs.length) return fail(res, 501, 'no_key', 'No lodging source for this trip');
      const lists = await Promise.all(jobs.map(j => j.catch(e => { if (e.code === 'bad_key') throw e; return []; })));
      return res.status(200).json(remember(ck, { list: [].concat(...lists) }));
    }
    if (q.gpool) {
      if (!gKey) return fail(res, 501, 'no_key', 'GOOGLE_PLACES_API_KEY is not set');
      const city = String(q.city || '').trim().slice(0, 40);
      if (!city || !ll) return fail(res, 400, 'bad_request', 'city, lat, lon required');
      const kws = String(q.kw || '').split(',').map(s => s.trim()).filter(s => s.length >= 2).slice(0, 3);
      const ck = 'gpool|' + city + '|' + kws.join(',');
      const hit = cache.get(ck);
      if (hit && Date.now() - hit.at < 7 * DAY) return res.status(200).json(hit.body);
      return res.status(200).json(remember(ck, await googlePool(gKey, city, ll, kws)));
    }
    if (q.pool) {
      if (!kKey) return fail(res, 501, 'no_key', 'KAKAO_REST_API_KEY is not set');
      const city = String(q.city || '').trim().slice(0, 40);
      if (!city || !ll) return fail(res, 400, 'bad_request', 'city, lat, lon required');
      const kws = String(q.kw || '').split(',').map(s => s.trim()).filter(s => s.length >= 2).slice(0, 3);
      const ck = 'pool|' + city + '|' + kws.join(',');
      const hit = cache.get(ck);
      if (hit && Date.now() - hit.at < DAY) return res.status(200).json(hit.body);
      return res.status(200).json(remember(ck, await kakaoPool(kKey, city, ll, kws)));
    }
    const text = String(q.q || '').trim().slice(0, 80);
    if (text.length < 2) return fail(res, 400, 'bad_request', 'q required');
    const useKakao = kKey && (q.dom === '1' || !gKey);
    const size = Math.max(1, Math.min(15, parseInt(q.size, 10) || 8));
    const ck = (useKakao ? 'k|' : 'g|') + text + '|' + size + '|' + (ll ? ll[0].toFixed(2) + ',' + ll[1].toFixed(2) : '');
    const hit = cache.get(ck);
    if (hit && Date.now() - hit.at < DAY) return res.status(200).json(hit.body);
    let body;
    if (useKakao) body = { src: 'kakao', items: (await kakao('keyword', Object.assign({ query: text, size }, ll ? { x: ll[1], y: ll[0] } : {}), kKey)).map(kItem) };
    else body = await google(gKey, text, ll, size);
    res.status(200).json(remember(ck, body));
  } catch (e) {
    if (e.code === 'bad_key') return fail(res, 502, 'bad_key', 'The map key was rejected');
    return fail(res, 502, e.code || 'upstream_error', String(e.message || e));
  }
};
