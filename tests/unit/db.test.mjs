// worker/src/db.js pure checks: book ids, record ids, and what a worker barred from editing may still send.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validTenant, validId, editAllowed, barred, FRESH_MS } from "../../worker/src/db.js";

test("book and record ids", () => {
  assert.ok(validTenant("main"));
  assert.ok(validTenant("AbCdEf0123456789"));
  for (const t of ["", "x", "../main", "a/b", null, "a".repeat(41)]) assert.ok(!validTenant(t), String(t));
  assert.ok(validId("t1"));
  for (const id of ["", "a/b", "x".repeat(101), 5]) assert.ok(!validId(id), String(id));
});

test("perms.edit read from the Firestore profile", () => {
  assert.equal(barred({ fields: { perms: { mapValue: { fields: { edit: { booleanValue: false } } } } } }), true);
  assert.equal(barred({ fields: { perms: { mapValue: { fields: { totals: { booleanValue: false } } } } } }), false);
  assert.equal(barred({ fields: {} }), false);
  assert.equal(barred(null), false);
});

test("barred worker: new records yes, old changes and deletes no", () => {
  const now = Date.now(), old = { id: "t", customerId: "c", type: "debt", amount: 5, createdAt: now - 864e5 };
  assert.ok(editAllowed("txns", { ...old }, null, now), "new record");
  assert.ok(!editAllowed("txns", null, null, now), "deleting nothing");
  assert.ok(!editAllowed("txns", { ...old, amount: 9 }, old, now), "amount change");
  assert.ok(!editAllowed("txns", null, old, now), "delete old");
  assert.ok(editAllowed("txns", { ...old, waSent: now, waId: "w" }, old, now), "WhatsApp mark");
  const fresh = { ...old, createdAt: now - FRESH_MS + 60e3 };
  assert.ok(editAllowed("txns", null, fresh, now), "undo own fresh");
  assert.ok(editAllowed("txns", { ...fresh, amount: 9 }, fresh, now), "fix own fresh");
});

test("barred worker: customer name and limit stay, no customer delete", () => {
  const c = { id: "c", name: "زبون", limit: 1000 };
  assert.ok(editAllowed("customers", { ...c, phone: "077" }, c));
  assert.ok(!editAllowed("customers", { ...c, name: "x" }, c));
  assert.ok(!editAllowed("customers", { ...c, limit: 5 }, c));
  assert.ok(!editAllowed("customers", null, c));
  assert.ok(editAllowed("customers", { id: "c", name: "a", phone: "1" }, { id: "c", name: "a" }));
});

test("busy D1 is asked again, other errors are not", async () => {
  const { retry, busyErr } = await import("../../worker/src/db.js");
  assert.ok(busyErr(new Error("D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window.")));
  assert.ok(!busyErr(new Error("D1_ERROR: no such table: docs")));
  const nap = async () => {};
  let n = 0;
  assert.equal(await retry(async () => { if (++n < 3) throw new Error("D1 DB is overloaded"); return "ok"; }, 4, nap), "ok");
  assert.equal(n, 3);
  n = 0;
  await assert.rejects(retry(async () => { n++; throw new Error("SQL syntax"); }, 4, nap), /syntax/);
  assert.equal(n, 1, "a real error is not repeated");
  n = 0;
  await assert.rejects(retry(async () => { n++; throw new Error("overloaded"); }, 4, nap), /overloaded/);
  assert.equal(n, 4, "gives up after 4 tries");
});

test("pull page memory stays bounded", async () => {
  const { pullGet, pullPut } = await import("../../worker/src/db.js");
  for (let i = 0; i < 60; i++) pullPut("b|0|" + i, "x".repeat(1000));
  assert.equal(pullGet("b|0|0"), undefined, "oldest dropped");
  assert.equal(pullGet("b|0|59"), "x".repeat(1000));
  pullPut("big", "y".repeat(7e6));
  assert.equal(pullGet("big"), undefined, "a page too big is not kept");
});

test("Firestore down: last known role kept, else 503, never a cached refusal", async () => {
  const { access } = await import("../../worker/src/db.js");
  const env = { FIREBASE_API_KEY: "k", FIREBASE_PROJECT: "p", AUTH_URL: "http://auth", FIRESTORE_URL: "http://fs", OWNER_EMAIL: "admin@x" };
  let fsDown = false, lookups = 0, reads = 0;
  const real = globalThis.fetch, realNow = Date.now;
  globalThis.fetch = async (url) => {
    url = String(url);
    if (url.startsWith("http://auth")) { lookups++; return new Response(JSON.stringify({ users: [{ localId: "w1", email: "w@x" }] })); }
    reads++;
    if (fsDown) return new Response("{}", { status: 429 });
    if (url.endsWith("/settings/owner")) return new Response(JSON.stringify({ fields: { uid: { stringValue: "own" } } }));
    if (url.endsWith("/users/w1")) return new Response(JSON.stringify({ fields: { status: { stringValue: "active" }, role: { stringValue: "editor" } } }));
    return new Response("{}", { status: 404 });
  };
  const req = t => new Request("http://w/db/pull", { headers: { Authorization: "Bearer " + t } });
  try {
    let t0 = realNow();
    Date.now = () => t0;
    assert.equal((await access(req("tokA"), env, "main")).role, "editor");
    assert.equal((await access(req("tokB"), env, "main")).role, "editor", "same account, new login");
    assert.equal(reads, 2, "the role is read once per account, not per login");
    t0 += 10 * 60e3; fsDown = true;
    assert.equal((await access(req("tokA"), env, "main")).role, "editor", "Firestore down: last role kept");
    const fresh = await access(new Request("http://w/db/pull", { headers: { Authorization: "Bearer tokC" } }), env, "AbCdEf0123456789");
    assert.equal(fresh.status, 503, "nothing known: try again, not 403");
    fsDown = false;
    const shop = await access(req("tokC"), env, "AbCdEf0123456789");
    assert.equal(shop.role, "", "after recovery the real answer comes back");
    assert.ok(lookups >= 3);
  } finally { globalThis.fetch = real; Date.now = realNow; }
});

test("full pull pages are shared after saves; a record saved again still arrives with its new value", async () => {
  const { handleDb } = await import("../../worker/src/db.js");
  // A fake D1 with one book: 2,500 customers, u = 1..2500, counter at 2500.
  const docs = new Map(); let ctr = 2500, pageReads = 0;
  for (let i = 1; i <= 2500; i++) docs.set("c" + i, { c: "customers", id: "c" + i, d: JSON.stringify({ id: "c" + i, v: 1 }), u: i, del: 0 });
  const stmt = sql => ({ bind: (...a) => ({
    first: async () => /FROM ctr/.test(sql) ? ctr : null,
    all: async () => {
      if (!/FROM docs/.test(sql)) return { results: [] };
      pageReads++;
      const [, since, lim] = a;
      return { results: [...docs.values()].filter(x => x.u > since).sort((x, y) => x.u - y.u).slice(0, lim) };
    },
    run: async () => ({}) }) });
  const env = { DB: { prepare: stmt, batch: async () => [] }, FIREBASE_API_KEY: "k", FIREBASE_PROJECT: "p", AUTH_URL: "http://auth",
    FIRESTORE_URL: "http://fs", OWNER_EMAIL: "o@x", D1_READ: "main" };
  const real = globalThis.fetch;
  globalThis.fetch = async url => String(url).startsWith("http://auth")
    ? new Response(JSON.stringify({ users: [{ localId: "own", email: "o@x" }] })) : new Response("{}", { status: 404 });
  const json = (o, s) => new Response(JSON.stringify(o), { status: s || 200 });
  const pullAll = async () => {
    const got = new Map(); let since = 0, more = true;
    while (more) {
      const r = await handleDb(new Request(`http://w/db/pull?tenant=main&since=${since}`, { headers: { Authorization: "Bearer T" } }), env, json, {});
      assert.equal(r.status, 200); const j = await r.json();
      for (const [, id, d] of j.rows) got.set(id, d); since = j.u; more = j.more;
    }
    return got;
  };
  try {
    const first = await pullAll();
    assert.equal(first.size, 2500); assert.equal(pageReads, 3);
    // c5 (on the first page) is saved again: it leaves u 5 and takes u 2501.
    ctr = 2501; docs.get("c5").u = 2501; docs.get("c5").d = JSON.stringify({ id: "c5", v: 2 });
    pageReads = 0;
    const second = await pullAll();
    assert.equal(pageReads, 1, "the two full pages come from memory, only the last page is read");
    assert.equal(second.size, 2500);
    assert.equal(second.get("c5").v, 2, "the newer value arrives on the last page and wins");
  } finally { globalThis.fetch = real; }
});
