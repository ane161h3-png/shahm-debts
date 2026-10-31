// Daily cloud copies of each shop's book, kept in Workers KV (binding BK), so a shop can get back what was deleted.
// The data comes from the shop's own device (its local copy, already in sync), so it costs no Firestore reads.
//   POST /backup?tenant=X&c=&t=&by=  body: the app's backup file, gzipped by the device. Any signed-in member of that
//                                book: stores the day's copy once (the first upload of a Baghdad day wins, so a delete
//                                later that day can't replace the good copy) and the month's first copy, kept with no end.
//   GET  /backup?tenant=X        the book's owner only: the list of copies (date, counts).
//   GET  /backup?tenant=X&key=K  the book's owner only: one copy, gzipped (the app opens it).
// tenant is a shop's id (its owner's uid) or "main" for the root book. Copies are sealed with AES-GCM under BK_SECRET
// (made once by .github/workflows/ai-worker.yml; never regenerate it, or older copies can't be opened). The device does
// the gzip and the worker never parses the data, so a big book stays within the free plan's few milliseconds of CPU.

const DAY_TTL = 32 * 86400; // daily copies: about a month
const BAGHDAD = 3 * 3600e3;
const MAX_BYTES = 20 * 1024 * 1024;
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

const secretKey = env => crypto.subtle.importKey("raw", unb64(env.BK_SECRET), "AES-GCM", false, ["encrypt", "decrypt"]);
async function seal(env, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await secretKey(env), bytes));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12); return out;
}
async function open(env, buf) {
  const u = new Uint8Array(buf);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: u.subarray(0, 12) }, await secretKey(env), u.subarray(12));
}

const validTenant = t => typeof t === "string" && (t === "main" || /^[A-Za-z0-9]{10,40}$/.test(t));

// Who is asking, from their Firebase ID token; and can they read this book (member) / are they its owner.
async function who(request, env, tenant) {
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return { error: "سجّل دخولك أولاً.", status: 401 };
  const authUrl = env.AUTH_URL || "https://identitytoolkit.googleapis.com";
  const r = await fetch(`${authUrl}/v1/accounts:lookup?key=${env.FIREBASE_API_KEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) });
  const j = await r.json().catch(() => ({}));
  const user = r.ok && j.users && j.users[0];
  if (!user) return { error: "انتهت الجلسة. اطلع وادخل من جديد.", status: 401 };
  const docs = `${env.FIRESTORE_URL || "https://firestore.googleapis.com"}/v1/projects/${env.FIREBASE_PROJECT}/databases/(default)/documents`;
  const get = p => fetch(`${docs}/${p}`, { headers: { Authorization: "Bearer " + token } });
  let owner;
  if (tenant === "main") {
    const o = await get("settings/owner"), od = o.ok ? await o.json().catch(() => null) : null;
    const uid = od && od.fields && od.fields.uid && od.fields.uid.stringValue;
    owner = uid ? uid === user.localId : o.status === 404 && user.email === env.OWNER_EMAIL;
  } else owner = user.localId === tenant;
  // A member is whoever the rules let read the book's settings (an active member of an open shop, or of the root book).
  const s = await get(tenant === "main" ? "settings/main" : `shops/${tenant}/settings/main`);
  return { user, owner, member: owner || s.ok || s.status === 404 };
}

const dayOf = ms => new Date(ms + BAGHDAD).toISOString().slice(0, 10);

export async function handleBackup(request, env, json, cors) {
  if (!env.BK || !env.BK_SECRET) return json({ error: "النسخ على السحابة بعده ما مفعّل على السيرفر.", off: true }, 503, cors);
  const url = new URL(request.url);
  if (request.method === "GET") {
    const tenant = url.searchParams.get("tenant");
    if (!validTenant(tenant)) return json({ error: "طلب غير صحيح." }, 400, cors);
    const w = await who(request, env, tenant);
    if (w.error) return json({ error: w.error }, w.status, cors);
    if (!w.owner) return json({ error: "استرجاع النسخ لصاحب الدفتر فقط." }, 403, cors);
    const key = url.searchParams.get("key");
    if (key) {
      if (!key.startsWith(`bk:${tenant}:`)) return json({ error: "طلب غير صحيح." }, 400, cors);
      const v = await env.BK.get(key, "arrayBuffer");
      if (!v) return json({ error: "هذي النسخة ما موجودة." }, 404, cors);
      return new Response(await open(env, v), { status: 200, headers: { "Content-Type": "application/gzip", ...cors } });
    }
    const items = [];let cursor;
    do { const l = await env.BK.list({ prefix: `bk:${tenant}:`, cursor }); for (const k of l.keys) items.push({ key: k.name, ...(k.metadata || {}) }); cursor = l.list_complete ? null : l.cursor; } while (cursor);
    items.sort((a, b) => (b.at || 0) - (a.at || 0));
    return json({ items }, 200, cors);
  }
  if (request.method !== "POST") return json({ error: "Not found" }, 404, cors);
  const len = Number(request.headers.get("Content-Length") || 0);
  if (len > MAX_BYTES) return json({ error: "النسخة كبيرة هواية." }, 413, cors);
  const tenant = url.searchParams.get("tenant"), num = k => Math.max(0, Math.floor(Number(url.searchParams.get(k)) || 0));
  if (!validTenant(tenant)) return json({ error: "طلب غير صحيح." }, 400, cors);
  const w = await who(request, env, tenant);
  if (w.error) return json({ error: w.error }, w.status, cors);
  if (!w.member) return json({ error: "ما عندك صلاحية على هذا الدفتر." }, 403, cors);
  if (env.BK_LIMIT && !(await env.BK_LIMIT.limit({ key: w.user.localId })).success) return json({ error: "انتظر شوية." }, 429, cors);
  const now = Date.now(), day = dayOf(now), month = day.slice(0, 7);
  const meta = { at: now, day, c: num("c"), t: num("t"), by: String(url.searchParams.get("by") || "").slice(0, 40) };
  const dayKey = `bk:${tenant}:d:${day}`, monthKey = `bk:${tenant}:m:${month}`;
  const [hasDay, hasMonth] = await Promise.all([env.BK.get(dayKey, "stream").then(s => { if (s) s.cancel(); return !!s; }), env.BK.get(monthKey, "stream").then(s => { if (s) s.cancel(); return !!s; })]);
  if (hasDay && hasMonth) return json({ ok: true, kept: true, day }, 200, cors);
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.length < 20 || body.length > MAX_BYTES || body[0] !== 0x1f || body[1] !== 0x8b) return json({ error: "طلب غير صحيح." }, 400, cors);
  const sealed = await seal(env, body);
  if (!hasDay) await env.BK.put(dayKey, sealed, { expirationTtl: DAY_TTL, metadata: { ...meta, kind: "d" } });
  if (!hasMonth) await env.BK.put(monthKey, sealed, { metadata: { ...meta, kind: "m" } });
  return json({ ok: true, day }, 200, cors);
}
