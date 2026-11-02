// Each book's accounts and transactions in Cloudflare D1 (binding DB), to move off Firestore's daily limit.
// Every account/transaction write goes to Firestore and here. Books listed in D1_READ (wrangler.toml: "all", or book ids
// separated by commas) are read from here; the rest still read Firestore. Firestore stays the reference: once a day the
// owner's device compares it with this copy and sends what differs.
//   POST /db/push?tenant=X  body {ops: [[coll, id, data | null], ...]}  the book's writers: saves each record (null = deleted)
//   GET  /db/pull?tenant=X&since=U  the book's members: records saved after U, oldest first, a page at a time (more: true);
//                                   read: whether the app should show this book from here
//   GET  /db/live?tenant=X  (WebSocket, login sent as the protocol "bearer, <token>") the book's members: a message {u}
//                           after every save, so the app pulls what changed straight away (see Live below)
// tenant is a shop's id (its owner's uid) or "main" for the root book. Who may read or write follows firestore.rules
// (owner, active editors, active viewers read only), read from Firestore with the person's own login and kept a few
// minutes. Each record keeps u, a number from the book's own counter (ctr) that only goes up (and is at least the
// save's time in ms), so "since U" never misses a save. A delete keeps the row, marked del, so other devices learn of it and nothing is
// ever erased from here.

const COLLS = new Set(["customers", "txns"]);
const MAX_OPS = 400;
const PAGE = 1000;
const MAX_DOC = 100_000; // characters of one record's JSON
const ROLE_TTL = 5 * 60e3;

export const validTenant = t => typeof t === "string" && (t === "main" || /^[A-Za-z0-9]{10,40}$/.test(t));
export const validId = id => typeof id === "string" && id.length > 0 && id.length <= 100 && !id.includes("/");

let schemaReady = false;
export async function schema(env) {
  if (schemaReady) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS docs (t TEXT NOT NULL, c TEXT NOT NULL, id TEXT NOT NULL, d TEXT, u INTEGER NOT NULL, del INTEGER NOT NULL DEFAULT 0, by TEXT, PRIMARY KEY (t, c, id)) WITHOUT ROWID"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS docs_tu ON docs (t, u)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS ctr (t TEXT PRIMARY KEY, u INTEGER NOT NULL)"),
    // An account's own records, for the statement link a customer opens (src/statement.js).
    env.DB.prepare("CREATE INDEX IF NOT EXISTS docs_cust ON docs (t, c, json_extract(d, '$.customerId'))"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS stlinks (t TEXT NOT NULL, cid TEXT NOT NULL, k TEXT NOT NULL UNIQUE, nm TEXT, at INTEGER NOT NULL, by TEXT, PRIMARY KEY (t, cid)) WITHOUT ROWID"),
  ]);
  schemaReady = true;
}

// Firestore REST value → plain value (only the kinds the rules look at).
const val = f => f == null ? null : "stringValue" in f ? f.stringValue : "booleanValue" in f ? f.booleanValue
  : "integerValue" in f ? Number(f.integerValue) : "doubleValue" in f ? f.doubleValue : "timestampValue" in f ? Date.parse(f.timestampValue) : null;
const field = (doc, k) => doc && doc.fields ? val(doc.fields[k]) : null;

// Who is asking and what they may do in this book: {uid, role: "owner" | "editor" | "viewer" | ""}.
const roles = new Map();
export async function access(request, env, tenant) {
  // A browser can't set headers on a WebSocket, so the live link sends the login as its second protocol.
  const proto = (request.headers.get("Sec-WebSocket-Protocol") || "").split(",").map(x => x.trim());
  const token = proto[0] === "bearer" && proto[1] ? proto[1] : (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return { error: "سجّل دخولك أولاً.", status: 401 };
  const key = tenant + "|" + token, hit = roles.get(key);
  if (hit && Date.now() - hit.at < ROLE_TTL) return hit.a;
  const authUrl = env.AUTH_URL || "https://identitytoolkit.googleapis.com";
  const r = await fetch(`${authUrl}/v1/accounts:lookup?key=${env.FIREBASE_API_KEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) });
  const j = await r.json().catch(() => ({}));
  const user = r.ok && j.users && j.users[0];
  if (!user) return { error: "انتهت الجلسة. اطلع وادخل من جديد.", status: 401 };
  const docs = `${env.FIRESTORE_URL || "https://firestore.googleapis.com"}/v1/projects/${env.FIREBASE_PROJECT}/databases/(default)/documents`;
  const get = async p => { const x = await fetch(`${docs}/${p}`, { headers: { Authorization: "Bearer " + token } }); return { status: x.status, doc: x.ok ? await x.json().catch(() => null) : null }; };
  const uid = user.localId;
  let role = "";
  if (tenant === "main") {
    const o = await get("settings/owner"), ownerUid = field(o.doc, "uid");
    if (ownerUid ? ownerUid === uid : o.status === 404 && user.email === env.OWNER_EMAIL) role = "owner";
    else {
      const p = await get(`users/${uid}`);
      if (p.doc && field(p.doc, "status") === "active") role = field(p.doc, "role") === "editor" ? "editor" : "viewer";
    }
  } else {
    const s = await get(`shops/${tenant}`), until = field(s.doc, "until");
    if (s.doc && field(s.doc, "status") === "active" && (until == null || until > Date.now())) {
      if (uid === tenant) role = "owner";
      else {
        const p = await get(`shops/${tenant}/users/${uid}`);
        if (p.doc && field(p.doc, "status") === "active") role = field(p.doc, "role") === "editor" ? "editor" : "viewer";
      }
    }
  }
  const a = { uid, role };
  if (roles.size > 500) roles.clear();
  roles.set(key, { at: Date.now(), a });
  return a;
}

// What a writer other than the owner may save, as in firestore.rules (the owner is exempt: a restored backup goes as it is).
function shapeOk(c, id, d) {
  if (d.id !== id) return false;
  if (c === "customers") return typeof d.name === "string" && d.name.length > 0 && d.name.length <= 100;
  return typeof d.customerId === "string" && (d.type === "debt" || d.type === "pay")
    && typeof d.amount === "number" && d.amount > 0 && d.amount < 1e10;
}

const readOn = (env, tenant) => { const l = String(env.D1_READ || "").split(",").map(x => x.trim()); return l.includes("all") || l.includes(tenant); };

// One per book: holds the open live links of its devices and tells them when something was saved. Idle links hibernate
// (no cost), and the keep-alive ping is answered without waking it.
export class Live {
  constructor(ctx) { this.ctx = ctx; ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong")); }
  async fetch(request) {
    if (request.headers.get("Upgrade") === "websocket") {
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client, headers: { "Sec-WebSocket-Protocol": "bearer" } });
    }
    const msg = JSON.stringify(await request.json());
    for (const ws of this.ctx.getWebSockets()) try { ws.send(msg); } catch (e) {}
    return new Response("ok");
  }
  webSocketClose(ws, code) { try { ws.close(code === 1005 ? 1000 : code, "bye"); } catch (e) {} }
}
const liveOf = (env, tenant) => env.LIVE.get(env.LIVE.idFromName(tenant));

export async function handleDb(request, env, json, cors) {
  if (!env.DB) return json({ error: "قاعدة البيانات الجديدة بعدها ما مفعّلة على السيرفر.", off: true }, 503, cors);
  const url = new URL(request.url), what = url.pathname.slice(4), tenant = url.searchParams.get("tenant");
  if (!validTenant(tenant)) return json({ error: "طلب غير صحيح." }, 400, cors);
  const a = await access(request, env, tenant);
  if (a.error) return json({ error: a.error }, a.status, cors);
  if (!a.role) return json({ error: "ما عندك صلاحية على هذا الدفتر." }, 403, cors);
  if (what === "live") {
    if (!env.LIVE || request.headers.get("Upgrade") !== "websocket") return json({ error: "طلب غير صحيح." }, 400, cors);
    return liveOf(env, tenant).fetch(request);
  }
  await schema(env);

  if (what === "pull" && request.method === "GET") {
    const since = Math.max(0, Math.floor(Number(url.searchParams.get("since")) || 0));
    const { results } = await env.DB.prepare("SELECT c, id, d, u, del FROM docs WHERE t = ? AND u > ? ORDER BY u LIMIT ?").bind(tenant, since, PAGE + 1).all();
    const more = results.length > PAGE, rows = results.slice(0, PAGE).map(x => [x.c, x.id, x.del ? null : JSON.parse(x.d), x.u]);
    return json({ rows, more, u: rows.length ? rows[rows.length - 1][3] : since, read: readOn(env, tenant) }, 200, cors);
  }

  if (what === "push" && request.method === "POST") {
    if (a.role === "viewer") return json({ error: "ما عندك صلاحية لهذا التعديل." }, 403, cors);
    if (env.DB_LIMIT && !(await env.DB_LIMIT.limit({ key: a.uid })).success) return json({ error: "انتظر شوية." }, 429, cors);
    const body = await request.json().catch(() => null), ops = body && body.ops;
    if (!Array.isArray(ops) || !ops.length || ops.length > MAX_OPS) return json({ error: "طلب غير صحيح." }, 400, cors);
    // Last save of each record wins if one arrives twice.
    const keep = new Map();
    for (const op of ops) {
      if (!Array.isArray(op) || op.length !== 3) return json({ error: "طلب غير صحيح." }, 400, cors);
      const [c, id, d] = op;
      if (!COLLS.has(c) || !validId(id)) return json({ error: "طلب غير صحيح." }, 400, cors);
      let s = null;
      if (d !== null) {
        if (typeof d !== "object" || Array.isArray(d)) return json({ error: "طلب غير صحيح." }, 400, cors);
        if (a.role !== "owner" && !shapeOk(c, id, d)) return json({ error: "ما عندك صلاحية لهذا التعديل." }, 403, cors);
        s = JSON.stringify(d);
        if (s.length > MAX_DOC) return json({ error: "السجل كبير هواية." }, 413, cors);
      }
      keep.delete(c + "|" + id); keep.set(c + "|" + id, [c, id, s]);
    }
    // The book's counter moves up by the number of records (and at least to now), then each record takes one number of
    // that range, in order. It all runs as one transaction, so two saves can't mix their numbers or land out of order.
    // Few statements (many records each), because the free plan allows 50 queries per request.
    const recs = [...keep.values()], n = recs.length, stmts = [env.DB.prepare(
      "INSERT INTO ctr (t, u) VALUES (?, ?) ON CONFLICT (t) DO UPDATE SET u = MAX(ctr.u + ?, ?)").bind(tenant, Date.now() + n, n, Date.now() + n)];
    const PER = 16; // 6 values a record; D1 takes at most 100 in one statement
    for (const del of [false, true]) {
      const part = recs.map((r, i) => [r, i]).filter(([r]) => (r[2] === null) === del);
      for (let i = 0; i < part.length; i += PER) {
        const chunk = part.slice(i, i + PER), args = [];
        const rows = chunk.map(([[c, id, s], k]) => { args.push(tenant, c, id, s, tenant, a.uid); return `(?, ?, ?, ?, (SELECT u FROM ctr WHERE t = ?) - ${n - 1 - k}, ${del ? 1 : 0}, ?)`; });
        stmts.push(env.DB.prepare(`INSERT INTO docs (t, c, id, d, u, del, by) VALUES ${rows.join(", ")}
          ON CONFLICT (t, c, id) DO UPDATE SET ${del ? "" : "d = excluded.d, "}u = excluded.u, del = excluded.del, by = excluded.by`).bind(...args));
      }
    }
    await env.DB.batch(stmts);
    const u = await env.DB.prepare("SELECT u FROM ctr WHERE t = ?").bind(tenant).first("u");
    if (env.LIVE) try { await liveOf(env, tenant).fetch("https://live/notify", { method: "POST", body: JSON.stringify({ u }) }); } catch (e) { console.warn("live", e); }
    return json({ ok: true, n, u }, 200, cors);
  }
  return json({ error: "Not found" }, 404, cors);
}
