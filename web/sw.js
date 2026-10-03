// Offline shell: the page always tries the network first (so updates arrive), everything else is served
// from cache and refreshed in the background. Firebase traffic is cross-origin and never touched here.
const CACHE = "shahm-v7";
const SHELL = [
  "./", "index.html", "config.js", "manifest.webmanifest",
  "vendor/firebase-app-compat.js", "vendor/firebase-auth-compat.js", "vendor/firebase-firestore-compat.js",
  "vendor/capacitor.js", "vendor/jspdf.umd.min.js", "vendor/qrcode.js", "vendor/fonts/fonts.css",
  "icons/icon-192.png", "icons/icon-512.png",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  if (req.mode === "navigate") {
    // Only the app page goes into the index.html slot; other pages (the printable sheet) must not replace it.
    const isApp = /\/(index\.html)?$/.test(new URL(req.url).pathname);
    e.respondWith(fetch(req).then(r => { if (isApp && r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put("index.html", copy)); } return r; })
      .catch(() => caches.match("index.html")));
    return;
  }
  e.respondWith(caches.match(req).then(hit => {
    const net = fetch(req).then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return r; }).catch(() => hit);
    return hit || net;
  }));
});
