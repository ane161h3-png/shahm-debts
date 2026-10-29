// Offline shell for the debt book: the page always tries the network first (so updates arrive), everything else is served
// from cache and refreshed in the background. Firebase traffic is cross-origin and never touched here.
const CACHE = "shahm-v75";
const SHELL = [
  "./", "index.html", "config.js", "manifest.webmanifest",
  "vendor/firebase-app-compat.js", "vendor/firebase-auth-compat.js", "vendor/firebase-firestore-compat.js",
  "vendor/capacitor.js", "vendor/jspdf.umd.min.js", "vendor/qrcode.js", "vendor/chart.umd.js", "vendor/fonts/fonts.css",
  "icons/icon-192.png", "icons/icon-512.png",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("shahm-v") && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  // The cashier (pos/) is a separate app with its own worker and cache.
  if (new URL(req.url).pathname.includes("/pos/")) return;
  if (req.mode === "navigate") {
    // Only the app page goes into the index.html slot; other pages (the printable sheet) must not replace it.
    const isApp = /\/(index\.html)?$/.test(new URL(req.url).pathname);
    e.respondWith(fetch(req).then(r => { if (isApp && r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put("index.html", copy)); } return r; })
      .catch(() => caches.match("index.html")));
    return;
  }
  // config.js says which Firebase project to use: the network first, so a change reaches the next load, not the one after.
  if (/\/config\.js$/.test(new URL(req.url).pathname)) {
    e.respondWith(fetch(req).then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return r; })
      .catch(() => caches.match(req)));
    return;
  }
  e.respondWith(caches.match(req).then(hit => {
    const net = fetch(req).then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return r; }).catch(() => hit);
    return hit || net;
  }));
});

// Phone notifications sent by the server (worker/src/push.js) when a worker records a debt or payment. While the app is
// on screen it shows the entry itself, so the push is skipped then (the test push always shows).
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) {}
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    if (!d.force && list.some(c => c.focused && !new URL(c.url).pathname.includes("/pos/"))) return;
    return self.registration.showNotification(d.title || "دفتر الديون", {
      body: d.body || "", tag: d.tag || undefined, lang: "ar", dir: "rtl", icon: "icons/icon-192.png", badge: "icons/icon-192.png",
    });
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    const app = list.find(c => !new URL(c.url).pathname.includes("/pos/"));
    return app ? app.focus() : self.clients.openWindow("./");
  }));
});
