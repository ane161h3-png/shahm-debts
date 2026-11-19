// worker/src/health.js: /health answers from D1 + KV only, and the self-check alerts once after two failures, then once on recovery.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleHealth, nextState, selfCheck } from "../../worker/src/health.js";

const json = (body, status, headers) => new Response(JSON.stringify(body), { status, headers });
const kv = () => { const m = new Map(); return { m, get: async (k, t) => m.has(k) ? (t === "json" ? JSON.parse(m.get(k)) : m.get(k)) : null, put: async (k, v) => { m.set(k, v); } }; };
const db = ok => ({ prepare: () => ({ first: async () => { if (!ok) throw new Error("down"); return 1; } }) });

test("/health: 200 when D1 and KV answer, 503 when D1 doesn't, no details leak", async () => {
  let r = await handleHealth(new Request("https://w/health"), { DB: db(true), BK: kv() }, json);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.deepEqual(Object.keys(j.checks).sort(), ["d1", "kv"]);
  r = await handleHealth(new Request("https://w/health"), { DB: db(false), BK: kv() }, json);
  assert.equal(r.status, 503);
  const t = await r.text();
  assert.ok(!t.includes("down"), "error text not shown");
});

test("/health is rate limited per address", async () => {
  const r = await handleHealth(new Request("https://w/health"), { DB: db(true), BK: kv(), HEALTH_LIMIT: { limit: async () => ({ success: false }) } }, json);
  assert.equal(r.status, 429);
});

test("alert after two failing checks in a row, once; recovery message once", () => {
  const bad = { d1: { ok: false, why: "error" }, kv: { ok: true } }, good = { d1: { ok: true }, kv: { ok: true } };
  let s = nextState(null, bad);
  assert.equal(s.message, null, "first failure: wait");
  s = nextState(s.state, bad);
  assert.match(s.message, /قاعدة البيانات/);
  s = nextState(s.state, bad);
  assert.equal(s.message, null, "no repeat");
  s = nextState(s.state, good);
  assert.match(s.message, /رجع كلشي/);
  s = nextState(s.state, good);
  assert.equal(s.message, null);
  assert.equal(s.changed, false, "nothing written while healthy");
});

test("one slow answer that recovers sends nothing", () => {
  const s1 = nextState(null, { site: { ok: false, why: "timeout" } });
  const s2 = nextState(s1.state, { site: { ok: true } });
  assert.equal(s1.message, null); assert.equal(s2.message, null);
});

test("Firestore quota is named as quota", () => {
  let s = nextState(null, { firestore: { ok: false, why: "quota" } });
  s = nextState(s.state, { firestore: { ok: false, why: "quota" } });
  assert.match(s.message, /خلصت قراءات Firestore/);
});

test("selfCheck end to end with fake services", async () => {
  const sent = [], store = kv();
  const env = { DB: db(true), BK: store, FIREBASE_API_KEY: "k", FIREBASE_PROJECT: "p", TELEGRAM_TOKEN: "t", TELEGRAM_CHAT_ID: "1" };
  let siteUp = false;
  const fetcher = async (url, opt) => {
    if (url.startsWith("https://api.telegram.org")) { sent.push(JSON.parse(opt.body).text); return new Response("{}"); }
    if (url.startsWith("https://shahm-debts.app")) return new Response("", { status: siteUp ? 200 : 502 });
    if (url.includes("firestore")) return new Response("", { status: 403 });
    return new Response("{}", { status: 200 });
  };
  await selfCheck(env, fetcher); await selfCheck(env, fetcher);
  assert.equal(sent.length, 1); assert.match(sent[0], /الموقع/);
  siteUp = true; await selfCheck(env, fetcher);
  assert.equal(sent.length, 2); assert.match(sent[1], /رجع/);
});
