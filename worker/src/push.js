// Phone notifications that arrive even when the app is closed (standard Web Push: RFC 8030 delivery, RFC 8291 payload
// encryption, RFC 8292 VAPID). The owner's devices subscribe in Settings > الإشعارات and store the subscription in
// settings/main.push; when a worker records a debt or payment, the app asks this server to push it to them.
// VAPID_JWK is the server's private P-256 key (a JWK), made once by .github/workflows/ai-worker.yml and kept as a secret.

const enc = new TextEncoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const cat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let i = 0; for (const p of parts) { out.set(p, i); i += p.length; } return out; };
const hmac = async (key, data) => new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), data));

function vapidKeys(env) {
  const jwk = JSON.parse(env.VAPID_JWK);
  return { jwk, pub: b64u(cat(new Uint8Array([4]), unb64u(jwk.x), unb64u(jwk.y))) };
}

export const vapidPublic = env => (env.VAPID_JWK ? vapidKeys(env).pub : "");

async function vapidHeader(env, endpoint) {
  const { jwk, pub } = vapidKeys(env);
  const key = await crypto.subtle.importKey("jwk", { ...jwk, key_ops: ["sign"] }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: "https://shahm-debts.app" })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${head}.${claims}`));
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${pub}`;
}

// aes128gcm body for one subscription (RFC 8291 section 3.4): salt, record size, our one-off public key, then the sealed text.
export async function encryptPayload(p256dh, authSecret, text) {
  const ua = unb64u(p256dh), auth = unb64u(authSecret);
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const as = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", ua, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, eph.privateKey, 256));
  const ikm = await hmac(await hmac(auth, shared), cat(enc.encode("WebPush: info\0"), ua, as, new Uint8Array([1])));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, cat(enc.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, cat(enc.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, cat(enc.encode(text), new Uint8Array([2]))));
  return cat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([as.length]), as, sealed);
}

// Only the push services of the browsers we support, so a planted subscription can't make this server call anywhere else.
const PUSH_HOSTS = /^https:\/\/([a-z0-9-]+\.)*(googleapis\.com|mozilla\.com|windows\.com|push\.apple\.com)\//;

export async function sendPush(env, sub, msg) {
  if (!PUSH_HOSTS.test(sub.e)) return 400;
  const body = await encryptPayload(sub.p, sub.a, JSON.stringify(msg));
  const r = await fetch(sub.e, { method: "POST", body, headers: {
    Authorization: await vapidHeader(env, sub.e), "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "86400", Urgency: "high",
  } });
  return r.status;
}

const str = (v, n) => (typeof v === "string" ? v : "").slice(0, n);
const KINDS = ["debt", "pay", "edit", "cust", "test"];

// POST /push {shop, kind, title, body, tag}: the caller must be a member of that shop (Firestore lets them read its
// settings), and it goes to every stored device that wants this kind, except the caller's own; kind "test" goes only to the caller's.
export async function handlePush(request, env, json, cors) {
  if (!env.VAPID_JWK) return json({ error: "الإشعارات بعدها ما مفعّلة على السيرفر." }, 503, cors);
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "سجّل دخولك أولاً." }, 401, cors);
  const b = await request.json().catch(() => null) || {};
  const shop = str(b.shop, 64), kind = str(b.kind, 8);
  if ((shop && !/^[A-Za-z0-9]+$/.test(shop)) || !KINDS.includes(kind)) return json({ error: "طلب غير صحيح." }, 400, cors);
  const authUrl = env.AUTH_URL || "https://identitytoolkit.googleapis.com";
  const lr = await fetch(`${authUrl}/v1/accounts:lookup?key=${env.FIREBASE_API_KEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) });
  const user = lr.ok && ((await lr.json().catch(() => ({}))).users || [])[0];
  if (!user) return json({ error: "انتهت الجلسة. اطلع وادخل من جديد." }, 401, cors);
  if (env.PUSH_LIMIT && !(await env.PUSH_LIMIT.limit({ key: user.localId })).success) return json({ error: "إشعارات كثيرة ورا بعض." }, 429, cors);
  const dbUrl = env.FIRESTORE_URL || "https://firestore.googleapis.com";
  const path = `${dbUrl}/v1/projects/${env.FIREBASE_PROJECT}/databases/(default)/documents/${shop ? `shops/${shop}/` : ""}settings/main?mask.fieldPaths=push`;
  const sr = await fetch(path, { headers: { Authorization: "Bearer " + token } });
  if (!sr.ok) return json({ error: "ما عندك صلاحية." }, sr.status === 404 ? 404 : 403, cors);
  const doc = await sr.json().catch(() => ({}));
  const map = (((doc.fields || {}).push || {}).mapValue || {}).fields || {};
  const subs = Object.entries(map).map(([h, v]) => {
    const f = (v.mapValue || {}).fields || {}, s = k => (f[k] && f[k].stringValue) || "";
    return { h, e: s("e"), p: s("p"), a: s("a"), u: s("u"), k: ((f.k && f.k.arrayValue && f.k.arrayValue.values) || []).map(x => x.stringValue) };
  }).filter(s => s.e && s.p && s.a && (kind === "test" ? s.u === user.localId : s.u !== user.localId && s.k.includes(kind)));
  const msg = { title: str(b.title, 120) || "دفتر الديون", body: str(b.body, 200), tag: str(b.tag, 40), force: kind === "test" };
  const res = await Promise.all(subs.map(s => sendPush(env, s, msg).catch(() => 0)));
  const gone = subs.filter((s, i) => res[i] === 404 || res[i] === 410).map(s => s.h);
  console.log(`push ${kind}: ${res.filter(x => x >= 200 && x < 300).length}/${subs.length} sent`);
  return json({ sent: res.filter(x => x >= 200 && x < 300).length, tried: subs.length, gone }, 200, cors);
}
