// Support chat between this app's owner (the owner's panel, web/admin/) and the owners of the shops that subscribe.
// Kept in D1 (binding DB), not Firestore, so a chat costs no Firestore reads; the live updates go through the same kind of
// Durable Object as the books (Live in src/db.js). One continuing conversation per shop.
//   GET  /support/threads                     the owner: every shop's conversation (no messages), newest first
//   GET  /support/me                          a shop's owner: their own conversation's summary (unread count, status)
//   GET  /support/msgs?shop=X&before=N        the last 40 messages (before message N), oldest first, with the summary
//   GET  /support/img?shop=X&id=N             one message's photo
//   POST /support/send  {shop, text, img}     a message from whoever calls (text and/or one compressed photo)
//   POST /support/read  {shop}                the caller has read the conversation up to its last message
//   POST /support/status {shop, status}       the owner: "open" or "solved"
//   POST /support/sub   {e, p, a} | {off, e}  the caller's device wants (or no longer wants) a phone notification
//   GET  /support/live?shop=X | shop=*        (WebSocket, login sent as the protocol "bearer, <token>") a message after
//                                             every change: X's conversation, or (the owner) all of them
// Who is who: the owner is the uid in settings/owner, or the panel's own account settings/owner.admin once the owner set one
// (isAdmin in firestore.rules); a shop's owner is the account whose uid is
// the shop's id (shops/{uid} exists), whatever the shop's state, so a stopped or ended shop can still ask for help.
// A shop's workers and anyone else get 403. A message is never edited or deleted by anyone.
import { sendPush } from "./push.js";
import { validTenant } from "./db.js";

const MAX_TEXT = 2000;
const MAX_IMG = 400_000; // characters of the photo's data URL (the app compresses it to ~150 KB)
const PAGE = 40;
const DAY_MAX = 150; // messages a shop may send in 24 hours
const WHO_TTL = 2 * 60e3;
const IMG_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const PUSH_HOSTS = /^https:\/\/([a-z0-9-]+\.)*(googleapis\.com|mozilla\.com|windows\.com|push\.apple\.com)\//;
const ADMIN_URL = "https://shahm-debts.app/admin/";

let ready = false;
async function schema(env) {
  if (ready) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS sup_threads (shop TEXT PRIMARY KEY, name TEXT, status TEXT NOT NULL DEFAULT 'open', last_at INTEGER NOT NULL DEFAULT 0, last_text TEXT, last_from TEXT, ua INTEGER NOT NULL DEFAULT 0, us INTEGER NOT NULL DEFAULT 0, ra INTEGER NOT NULL DEFAULT 0, rs INTEGER NOT NULL DEFAULT 0, n INTEGER NOT NULL DEFAULT 0, st_at INTEGER) WITHOUT ROWID"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS sup_msgs (id INTEGER PRIMARY KEY AUTOINCREMENT, shop TEXT NOT NULL, side TEXT NOT NULL, text TEXT, img TEXT, at INTEGER NOT NULL, by TEXT)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS sup_msgs_shop ON sup_msgs (shop, id)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS sup_push (h TEXT PRIMARY KEY, uid TEXT NOT NULL, side TEXT NOT NULL, shop TEXT, e TEXT NOT NULL, p TEXT NOT NULL, a TEXT NOT NULL, at INTEGER NOT NULL) WITHOUT ROWID"),
  ]);
  ready = true;
}

const val = f => f == null ? null : "stringValue" in f ? f.stringValue : "booleanValue" in f ? f.booleanValue
  : "integerValue" in f ? Number(f.integerValue) : "doubleValue" in f ? f.doubleValue : null;
const field = (doc, k) => doc && doc.fields ? val(doc.fields[k]) : null;

// {uid, admin: true} for this app's owner, {uid, shop, name} for a shop's owner, or {error, status}.
const whoCache = new Map();
async function who(request, env) {
  const proto = (request.headers.get("Sec-WebSocket-Protocol") || "").split(",").map(x => x.trim());
  const token = proto[0] === "bearer" && proto[1] ? proto[1] : (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return { error: "سجّل دخولك أولاً.", status: 401 };
  const hit = whoCache.get(token);
  if (hit && Date.now() - hit.at < WHO_TTL) return hit.w;
  const authUrl = env.AUTH_URL || "https://identitytoolkit.googleapis.com";
  const r = await fetch(`${authUrl}/v1/accounts:lookup?key=${env.FIREBASE_API_KEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) });
  const user = r.ok && ((await r.json().catch(() => ({}))).users || [])[0];
  if (!user) return { error: "انتهت الجلسة. اطلع وادخل من جديد.", status: 401 };
  const docs = `${env.FIRESTORE_URL || "https://firestore.googleapis.com"}/v1/projects/${env.FIREBASE_PROJECT}/databases/(default)/documents`;
  const get = async p => { const x = await fetch(`${docs}/${p}`, { headers: { Authorization: "Bearer " + token } }); return { status: x.status, doc: x.ok ? await x.json().catch(() => null) : null }; };
  const uid = user.localId;
  let w;
  // The panel's own account (settings/owner.admin) when the owner set one, otherwise the owner (as isAdmin in firestore.rules).
  const o = await get("settings/owner"), ownerUid = field(o.doc, "uid"), adminUid = field(o.doc, "admin");
  if (adminUid ? adminUid === uid : ownerUid ? ownerUid === uid : o.status === 404 && user.email === env.OWNER_EMAIL) w = { uid, admin: true };
  else {
    const s = await get(`shops/${uid}`);
    w = s.doc && validTenant(uid) && uid !== "main" ? { uid, shop: uid, name: String(field(s.doc, "name") || "").slice(0, 100) }
      : { error: "الدعم الفني لصاحب المحل فقط.", status: 403 };
  }
  if (whoCache.size > 500) whoCache.clear();
  whoCache.set(token, { at: Date.now(), w });
  return w;
}

const thread = async (env, shop) => env.DB.prepare("SELECT * FROM sup_threads WHERE shop = ?").bind(shop).first();
const blank = shop => ({ shop, name: "", status: "open", last_at: 0, last_text: "", last_from: "", ua: 0, us: 0, ra: 0, rs: 0, n: 0, st_at: null });
const live = (env, name) => env.LIVE.get(env.LIVE.idFromName("sup:" + name));
// Tells the shop's open chat and the owner's panel what changed.
async function tell(env, shop, ev) {
  if (!env.LIVE) return;
  const body = JSON.stringify({ shop, ...ev });
  const post = n => live(env, n).fetch("https://live/", { method: "POST", headers: { "Content-Type": "application/json" }, body }).catch(() => {});
  await Promise.all([post(shop), post("admin")]);
}

async function pushTo(env, rows, msg) {
  if (!env.VAPID_JWK || !rows.length) return;
  const res = await Promise.all(rows.map(s => sendPush(env, s, msg).catch(() => 0)));
  const gone = rows.filter((s, i) => res[i] === 404 || res[i] === 410).map(s => s.h);
  if (gone.length) await env.DB.batch(gone.map(h => env.DB.prepare("DELETE FROM sup_push WHERE h = ?").bind(h)));
}

async function telegram(env, text) {
  if (!env.TELEGRAM_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
  }).catch(() => null);
  if (!r || !r.ok) console.log("support telegram failed", r && r.status);
}

const hashOf = async e => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(e))).slice(0, 8)].map(b => b.toString(16).padStart(2, "0")).join("");
const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export async function handleSupport(request, env, json, cors, ctx) {
  if (!env.DB) return json({ error: "الدعم الفني بعده ما مفعّل على السيرفر." }, 503, cors);
  const url = new URL(request.url), what = url.pathname.slice(9);
  const w = await who(request, env);
  if (w.error) return json({ error: w.error }, w.status, cors);
  const wait = p => (ctx && ctx.waitUntil ? ctx.waitUntil(p) : p);
  const body = request.method === "POST" ? (await request.json().catch(() => null)) || {} : {};
  // The conversation asked for: a shop's owner only ever reaches their own.
  const want = String(request.method === "POST" ? body.shop || "" : url.searchParams.get("shop") || "");
  const shop = w.admin ? want : w.shop;
  const shopOk = s => validTenant(s) && s !== "main";

  if (what === "live") {
    if (!env.LIVE || request.headers.get("Upgrade") !== "websocket") return json({ error: "طلب غير صحيح." }, 400, cors);
    if (w.admin && want === "*") return live(env, "admin").fetch(request);
    if (!shopOk(shop) || (!w.admin && want && want !== w.shop)) return json({ error: "ما عندك صلاحية." }, 403, cors);
    return live(env, shop).fetch(request);
  }
  await schema(env);

  if (what === "threads" && request.method === "GET") {
    if (!w.admin) return json({ error: "ما عندك صلاحية." }, 403, cors);
    const { results } = await env.DB.prepare("SELECT * FROM sup_threads ORDER BY last_at DESC LIMIT 1000").all();
    return json({ threads: results }, 200, cors);
  }
  if (what === "sub" && request.method === "POST") {
    const e = String(body.e || "");
    if (!PUSH_HOSTS.test(e) || e.length > 1000) return json({ error: "طلب غير صحيح." }, 400, cors);
    const h = await hashOf(e);
    if (body.off) { await env.DB.prepare("DELETE FROM sup_push WHERE h = ? AND uid = ?").bind(h, w.uid).run(); return json({ ok: true }, 200, cors); }
    const p = String(body.p || ""), a = String(body.a || "");
    if (!p || !a || p.length > 200 || a.length > 100) return json({ error: "طلب غير صحيح." }, 400, cors);
    await env.DB.prepare("INSERT OR REPLACE INTO sup_push (h, uid, side, shop, e, p, a, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(h, w.uid, w.admin ? "admin" : "shop", w.admin ? null : w.shop, e, p, a, Date.now()).run();
    return json({ ok: true }, 200, cors);
  }

  if (!w.admin && want && want !== w.shop) return json({ error: "ما عندك صلاحية على هذي المحادثة." }, 403, cors);
  if (!shopOk(shop)) return json({ error: "طلب غير صحيح." }, 400, cors);

  if (what === "me" && request.method === "GET") return json({ thread: (await thread(env, shop)) || blank(shop) }, 200, cors);

  if (what === "msgs" && request.method === "GET") {
    const before = Math.floor(Number(url.searchParams.get("before")) || 0);
    const { results } = await env.DB.prepare(`SELECT id, side, text, img IS NOT NULL AS img, at FROM sup_msgs WHERE shop = ?${before > 0 ? " AND id < ?" : ""} ORDER BY id DESC LIMIT ?`)
      .bind(...(before > 0 ? [shop, before, PAGE + 1] : [shop, PAGE + 1])).all();
    const more = results.length > PAGE;
    return json({ msgs: results.slice(0, PAGE).reverse(), more, thread: (await thread(env, shop)) || blank(shop) }, 200, cors);
  }
  if (what === "img" && request.method === "GET") {
    const id = Math.floor(Number(url.searchParams.get("id")) || 0);
    const img = await env.DB.prepare("SELECT img FROM sup_msgs WHERE shop = ? AND id = ?").bind(shop, id).first("img");
    return img ? json({ img }, 200, { ...cors, "Cache-Control": "private, max-age=31536000, immutable" }) : json({ error: "ما موجودة." }, 404, cors);
  }

  if (what === "send" && request.method === "POST") {
    if (env.SUP_LIMIT && !(await env.SUP_LIMIT.limit({ key: w.uid })).success) return json({ error: "رسائل كثيرة ورا بعض. انتظر دقيقة." }, 429, cors);
    const text = typeof body.text === "string" ? body.text.replace(/\r/g, "").trim() : "";
    const img = typeof body.img === "string" && body.img ? body.img : null;
    if (text.length > MAX_TEXT) return json({ error: `الرسالة طويلة. أقصى شي ${MAX_TEXT} حرف.` }, 400, cors);
    if (img && (img.length > MAX_IMG || !IMG_RE.test(img))) return json({ error: "الصورة كبيرة أو صيغتها غير مدعومة." }, 400, cors);
    if (!text && !img) return json({ error: "اكتب رسالة أو اختار صورة." }, 400, cors);
    const side = w.admin ? "admin" : "shop", now = Date.now();
    if (!w.admin) {
      const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM sup_msgs WHERE shop = ? AND side = 'shop' AND at > ?").bind(shop, now - 864e5).first("n");
      if (n >= DAY_MAX) return json({ error: "وصلت لحد الرسائل اليومي. نرد عليك قريباً." }, 429, cors);
    }
    const id = await env.DB.prepare("INSERT INTO sup_msgs (shop, side, text, img, at, by) VALUES (?, ?, ?, ?, ?, ?) RETURNING id").bind(shop, side, text, img, now, w.uid).first("id");
    const last = short(text || "📷 صورة", 140);
    // The sender has read everything up to their own message; the other side has one more unread. A shop writing
    // again reopens a conversation marked solved.
    await env.DB.prepare(side === "shop"
      ? `INSERT INTO sup_threads (shop, name, status, last_at, last_text, last_from, ua, us, ra, rs, n) VALUES (?1, ?2, 'open', ?3, ?4, 'shop', 1, 0, 0, ?5, 1)
         ON CONFLICT(shop) DO UPDATE SET name = ?2, status = 'open', st_at = CASE WHEN status = 'solved' THEN ?3 ELSE st_at END, last_at = ?3, last_text = ?4, last_from = 'shop', ua = ua + 1, us = 0, rs = ?5, n = n + 1`
      : `INSERT INTO sup_threads (shop, name, status, last_at, last_text, last_from, ua, us, ra, rs, n) VALUES (?1, ?2, 'open', ?3, ?4, 'admin', 0, 1, ?5, 0, 1)
         ON CONFLICT(shop) DO UPDATE SET last_at = ?3, last_text = ?4, last_from = 'admin', us = us + 1, ua = 0, ra = ?5, n = n + 1`)
      .bind(shop, side === "shop" ? w.name : "", now, last, id).run();
    const t = await thread(env, shop), msg = { id, side, text, img: img ? 1 : 0, at: now };
    wait(tell(env, shop, { t: "msg", msg, thread: t }));
    if (side === "shop") {
      wait(telegram(env, `💬 دعم فني: ${t.name || "محل"}\n${text ? short(text, 900) : ""}${img ? "\n📷 أرسل صورة" : ""}\n\nرد من لوحة المالك: ${ADMIN_URL}#chat=${shop}`));
      const { results } = await env.DB.prepare("SELECT * FROM sup_push WHERE side = 'admin'").all();
      wait(pushTo(env, results, { title: `💬 ${t.name || "محل"}`, body: short(text || "📷 صورة", 180), tag: "sup-" + shop, url: `${ADMIN_URL}#chat=${shop}`, force: false }));
    } else {
      const { results } = await env.DB.prepare("SELECT * FROM sup_push WHERE side = 'shop' AND shop = ?").bind(shop).all();
      wait(pushTo(env, results, { title: "💬 رد الدعم الفني", body: short(text || "📷 صورة", 180), tag: "support", url: "./#support", force: false }));
    }
    return json({ msg, thread: t }, 200, cors);
  }

  if (what === "read" && request.method === "POST") {
    const t = await thread(env, shop);
    if (!t) return json({ thread: blank(shop) }, 200, cors);
    const top = await env.DB.prepare("SELECT MAX(id) AS m FROM sup_msgs WHERE shop = ?").bind(shop).first("m") || 0;
    if (w.admin ? t.ra >= top && !t.ua : t.rs >= top && !t.us) return json({ thread: t }, 200, cors);
    await env.DB.prepare(w.admin ? "UPDATE sup_threads SET ra = ?, ua = 0 WHERE shop = ?" : "UPDATE sup_threads SET rs = ?, us = 0 WHERE shop = ?").bind(top, shop).run();
    const nt = await thread(env, shop);
    wait(tell(env, shop, { t: "read", thread: nt }));
    return json({ thread: nt }, 200, cors);
  }

  if (what === "status" && request.method === "POST") {
    if (!w.admin) return json({ error: "ما عندك صلاحية." }, 403, cors);
    const status = body.status === "solved" ? "solved" : "open";
    const now = Date.now();
    await env.DB.prepare(`INSERT INTO sup_threads (shop, status, st_at) VALUES (?1, ?2, ?3) ON CONFLICT(shop) DO UPDATE SET status = ?2, st_at = ?3`).bind(shop, status, now).run();
    const t = await thread(env, shop);
    wait(tell(env, shop, { t: "status", thread: t }));
    return json({ thread: t }, 200, cors);
  }

  return json({ error: "Not found" }, 404, cors);
}
