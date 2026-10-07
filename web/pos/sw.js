// Offline shell for the cashier (scope: pos/). Same approach as the debt book's sw.js: the page is fetched from the
// network first so updates arrive, everything else comes from cache and refreshes in the background.
const CACHE = "shahm-pos-v27";
const SHELL = [
  "./", "index.html", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png",
  "../config.js", "../vendor/firebase-app-compat.js", "../vendor/firebase-auth-compat.js", "../vendor/firebase-firestore-compat.js",
  "../vendor/jspdf.umd.min.js", "../vendor/capacitor.js", "../vendor/fonts/fonts.css",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  // Only this app's old caches; the debt book's caches belong to its own worker.
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("shahm-pos-") && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put("index.html", copy)); } return r; })
      .catch(() => caches.open(CACHE).then(c => c.match("index.html"))));
    return;
  }
  e.respondWith(caches.open(CACHE).then(c => c.match(req)).then(hit => {
    const net = fetch(req).then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return r; }).catch(() => hit);
    return hit || net;
  }));
});
