// Momentrip offline support: the app shell and pictures are cached so a saved trip still opens
// without data. API and Supabase calls always go to the network.
const V = 'momentrip-85fc01b167';
const CORE = ['/', '/manifest.webmanifest', '/icons/icon-192.png',
  '/img/beach.jpg', '/img/tropical.jpg', '/img/market.jpg', '/img/forest.jpg', '/img/art.jpg',
  '/img/mountain.jpg', '/img/oldtown.jpg', '/img/city.jpg', '/img/canyon.jpg', '/img/temple.jpg'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(CORE)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
function good(r) { return r && r.ok && r.type === 'basic' && !r.redirected; }
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  if (e.request.mode === 'navigate') {
    // fresh page when the network answers within 4s, otherwise the cached shell
    const net = fetch(e.request).then(r => { if (good(r) && u.pathname === '/') { const cp = r.clone(); caches.open(V).then(c => c.put('/', cp)); } return r; });
    const fallback = new Promise(res => setTimeout(() => caches.match('/').then(res), 4000));
    e.respondWith(Promise.race([net.catch(() => caches.match('/')), fallback.then(c => c || net)]).then(r => r || net));
    return;
  }
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => {
    if (good(r)) { const cp = r.clone(); caches.open(V).then(c => c.put(e.request, cp)); }
    return r;
  })));
});
