// firestore.rules: a worker the owner barred from editing (perms.edit == false) adds but can't change or delete,
// except undoing their own record from the last 15 minutes or marking a WhatsApp send. Main book and shops.
import { test, before, after, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, setDoc, updateDoc, deleteDoc } from "firebase/firestore";

let env;
const OLD = Date.now() - 3 * 864e5, NOW = Date.now();
const tx = (id, at, extra = {}) => ({ id, customerId: "c1", type: "debt", amount: 5000, date: "2026-11-01", createdAt: at, by: "w", ...extra });

before(async () => {
  env = await initializeTestEnvironment({ projectId: "shahm-test", firestore: { rules: readFileSync(new URL("../../firestore.rules", import.meta.url), "utf8") } });
});
after(async () => { await env.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, "settings/owner"), { uid: "own" });
    await setDoc(doc(db, "users/ed"), { status: "active", role: "editor", name: "ed" });
    await setDoc(doc(db, "users/w"), { status: "active", role: "editor", name: "w", perms: { edit: false } });
    await setDoc(doc(db, "customers/c1"), { id: "c1", name: "زبون", limit: 100000 });
    await setDoc(doc(db, "txns/old"), tx("old", OLD));
    await setDoc(doc(db, "txns/new"), tx("new", NOW));
    await setDoc(doc(db, "shops/shopA"), { status: "active", until: NOW + 30 * 864e5, name: "محل" });
    await setDoc(doc(db, "shops/shopA/users/sw"), { status: "active", role: "editor", name: "sw", perms: { edit: false } });
    await setDoc(doc(db, "shops/shopA/users/se"), { status: "active", role: "editor", name: "se" });
    await setDoc(doc(db, "shops/shopA/customers/c1"), { id: "c1", name: "زبون", limit: 100000 });
    await setDoc(doc(db, "shops/shopA/txns/old"), tx("old", OLD));
    await setDoc(doc(db, "shops/shopA/txns/new"), tx("new", NOW));
  });
});
const as = uid => env.authenticatedContext(uid).firestore();

for (const [book, P, barredUid, freeUid, ownerUid] of [["main", "", "w", "ed", "own"], ["shop", "shops/shopA/", "sw", "se", "shopA"]]) {
  test(`${book}: barred worker still adds debts and customers`, async () => {
    const db = as(barredUid);
    await assertSucceeds(setDoc(doc(db, P + "txns/t9"), tx("t9", Date.now())));
    await assertSucceeds(setDoc(doc(db, P + "customers/c9"), { id: "c9", name: "جديد" }));
  });
  test(`${book}: barred worker can't change or delete an old transaction`, async () => {
    const db = as(barredUid);
    await assertFails(updateDoc(doc(db, P + "txns/old"), { amount: 1 }));
    await assertFails(deleteDoc(doc(db, P + "txns/old")));
  });
  test(`${book}: barred worker may undo their fresh transaction and mark WhatsApp`, async () => {
    const db = as(barredUid);
    await assertSucceeds(updateDoc(doc(db, P + "txns/old"), { waSent: Date.now(), waId: "x" }));
    await assertSucceeds(updateDoc(doc(db, P + "txns/new"), { amount: 7000 }));
    await assertSucceeds(deleteDoc(doc(db, P + "txns/new")));
  });
  test(`${book}: barred worker keeps customer name and limit, can't delete a customer`, async () => {
    const db = as(barredUid);
    await assertSucceeds(updateDoc(doc(db, P + "customers/c1"), { phone: "07700000000", promise: null }));
    await assertFails(updateDoc(doc(db, P + "customers/c1"), { name: "اسم ثاني" }));
    await assertFails(updateDoc(doc(db, P + "customers/c1"), { limit: 1 }));
    await assertFails(deleteDoc(doc(db, P + "customers/c1")));
  });
  test(`${book}: a normal editor and the owner keep full edit`, async () => {
    for (const uid of [freeUid, ownerUid]) {
      const db = as(uid);
      await assertSucceeds(updateDoc(doc(db, P + "txns/old"), { amount: 6000 + uid.length }));
      await assertSucceeds(updateDoc(doc(db, P + "customers/c1"), { name: "اسم " + uid }));
    }
    await assertSucceeds(deleteDoc(doc(as(freeUid), P + "txns/old")));
    await assertSucceeds(deleteDoc(doc(as(ownerUid), P + "customers/c1")));
  });
}
test("another shop's worker reads nothing here", async () => {
  await assertFails(setDoc(doc(as("w"), "shops/shopA/txns/x"), tx("x", Date.now())));
  const { getDoc } = await import("firebase/firestore");
  await assertFails(getDoc(doc(as("w"), "shops/shopA/txns/old")));
});
