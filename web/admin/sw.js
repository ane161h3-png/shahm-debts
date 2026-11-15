// Offline shell for the owner's panel (admin/), apart from the debt book's worker (../sw.js) and the cashier's (../pos/sw.js).
// The page always tries the network first; the rest is served from cache and refreshed in the background.
const CACHE = "shahm-admin-v2";
const SHELL = [
  "./", "index.html", "manifest.webmanifest", "../config.js", "../support.js",
  "../vendor/firebase-app-compat.js", "../vendor/firebase-auth-compat.js", "../vendor/firebase-firestore-compat.js",
  "../vendor/fonts/fonts.css", "../icons/icon-192.png",
];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("shahm-admin-v") && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request, u = new URL(req.url);
  if (req.method !== "GET" || u.origin !== location.origin) return;
  if (req.mode === "navigate" || /\/(config|support)\.js$/.test(u.pathname)) {
    e.respondWith(fetch(req).then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req.mode === "navigate" ? "index.html" : req, copy)); } return r; })
      .catch(() => caches.match(req.mode === "navigate" ? "index.html" : req)));
    return;
  }
  e.respondWith(caches.match(req).then(hit => {
    const net = fetch(req).then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return r; }).catch(() => hit);
    return hit || net;
  }));
});
// A shop's support message (worker/src/support.js): shown unless the panel is on screen, where it appears by itself.
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) {}
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    if (!d.force && list.some(c => c.focused && new URL(c.url).pathname.includes("/admin/"))) return;
    return self.registration.showNotification(d.title || "لوحة المالك", {
      body: d.body || "", tag: d.tag || undefined, lang: "ar", dir: "rtl", icon: "../icons/icon-192.png", badge: "../icons/icon-192.png", data: { url: d.url || "./" },
    });
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const to = (e.notification.data && e.notification.data.url) || "./";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    const app = list.find(c => new URL(c.url).pathname.includes("/admin/"));
    if (app) { app.postMessage({ open: to }); return app.focus(); }
    return self.clients.openWindow(to);
  }));
});
