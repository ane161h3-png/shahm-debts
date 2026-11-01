// Statement links: the shop sends a customer a link (or its QR code) and the customer sees their own account, read only.
//   POST /st?tenant=X  body {cid, act: "make" | "new" | "stop", nm}  the book's owner and editors:
//        make = this account's link (the same one every time, made once), new = a fresh link (the old one stops working),
//        stop = no link (the old one stops working). nm is the shop name shown on the page. Answer {k} ("" after stop).
//   GET  /st?k=KEY  anyone holding the link: {shop, name, sup, rows: [[date, type, amount, note, createdAt]], bal, at}
// The key is 128 random bits, so links can't be guessed, and it opens one account only. The page reads the account from
// D1 (src/db.js), which every book's writes reach, so it works whether the book itself reads D1 or Firestore.
import { access, schema, validTenant, validId } from "./db.js";

const KEY = /^[A-Za-z0-9_-]{22}$/;
const MAX_ROWS = 3000;
const newKey = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const custOf = (env, t, cid) => env.DB.prepare("SELECT d FROM docs WHERE t = ? AND c = 'customers' AND id = ? AND del = 0").bind(t, cid).first("d");

export async function handleStatement(request, env, json, cors) {
  if (!env.DB) return json({ error: "الخدمة بعدها ما مفعّلة." }, 503, cors);
  const url = new URL(request.url);

  if (request.method === "GET") {
    // Public: opened from a customer's phone on any site, so any origin may read it.
    const open = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
    const k = url.searchParams.get("k") || "";
    if (!KEY.test(k)) return json({ error: "الرابط غير صحيح." }, 404, open);
    if (env.ST_LIMIT && !(await env.ST_LIMIT.limit({ key: request.headers.get("CF-Connecting-IP") || "x" })).success) return json({ error: "انتظر شوية وحاول." }, 429, open);
    await schema(env);
    const link = await env.DB.prepare("SELECT t, cid, nm FROM stlinks WHERE k = ?").bind(k).first();
    const cd = link && await custOf(env, link.t, link.cid);
    if (!cd) return json({ error: "هذا الرابط موقوف. اطلب رابط جديد من المحل." }, 404, open);
    const c = JSON.parse(cd);
    const { results } = await env.DB.prepare("SELECT d FROM docs WHERE t = ? AND c = 'txns' AND json_extract(d, '$.customerId') = ? AND del = 0 LIMIT ?")
      .bind(link.t, link.cid, MAX_ROWS).all();
    const list = results.map(r => JSON.parse(r.d)).filter(x => (x.type === "debt" || x.type === "pay") && typeof x.amount === "number" && x.amount > 0)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.createdAt || 0) - (b.createdAt || 0)));
    let bal = 0;
    const rows = list.map(x => { bal += x.type === "debt" ? x.amount : -x.amount; return [String(x.date || ""), x.type, x.amount, String(x.note || "").slice(0, 140), x.createdAt || 0]; });
    return json({ shop: link.nm || "", name: c.name || "", sup: c.kind === "supplier", rows, bal, at: Date.now() }, 200, open);
  }

  if (request.method !== "POST") return json({ error: "Not found" }, 404, cors);
  const tenant = url.searchParams.get("tenant");
  if (!validTenant(tenant)) return json({ error: "طلب غير صحيح." }, 400, cors);
  const a = await access(request, env, tenant);
  if (a.error) return json({ error: a.error }, a.status, cors);
  if (a.role !== "owner" && a.role !== "editor") return json({ error: "ما عندك صلاحية." }, 403, cors);
  const body = await request.json().catch(() => null) || {};
  const { cid, act } = body, nm = String(body.nm || "").replace(/\s+/g, " ").trim().slice(0, 60);
  if (!validId(cid) || !["make", "new", "stop"].includes(act)) return json({ error: "طلب غير صحيح." }, 400, cors);
  await schema(env);
  if (act === "stop") {
    await env.DB.prepare("DELETE FROM stlinks WHERE t = ? AND cid = ?").bind(tenant, cid).run();
    return json({ k: "" }, 200, cors);
  }
  if (!(await custOf(env, tenant, cid))) return json({ error: "الحساب بعده ما وصل للسيرفر. انتظر دقيقة وحاول." }, 409, cors);
  const old = await env.DB.prepare("SELECT k FROM stlinks WHERE t = ? AND cid = ?").bind(tenant, cid).first("k");
  if (old && act === "make") {
    if (nm) await env.DB.prepare("UPDATE stlinks SET nm = ? WHERE t = ? AND cid = ?").bind(nm, tenant, cid).run();
    return json({ k: old }, 200, cors);
  }
  const k = newKey();
  await env.DB.prepare("INSERT INTO stlinks (t, cid, k, nm, at, by) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (t, cid) DO UPDATE SET k = excluded.k, nm = excluded.nm, at = excluded.at, by = excluded.by")
    .bind(tenant, cid, k, nm, Date.now(), a.uid).run();
  return json({ k }, 200, cors);
}
