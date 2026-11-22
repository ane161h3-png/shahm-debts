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
