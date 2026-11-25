// worker/src/push.js: one entry (same tag) is pushed once; a second ask for it is dropped, a different entry still goes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handlePush } from "../../worker/src/push.js";

const json = (body, status, headers) => new Response(JSON.stringify(body), { status, headers });
const store = new Map();
globalThis.caches = { default: { match: async r => store.get(r.url) || null, put: async (r, v) => { store.set(r.url, v); } } };
const jwk = await crypto.subtle.exportKey("jwk", (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])).privateKey);
const ua = new Uint8Array(await crypto.subtle.exportKey("raw", (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])).publicKey));
const b64u = b => Buffer.from(b).toString("base64url");
const env = { VAPID_JWK: JSON.stringify(jwk), FIREBASE_PROJECT: "p", FIREBASE_API_KEY: "k" };
let sends = 0;
globalThis.fetch = async (url) => {
  url = String(url);
  if (url.includes("accounts:lookup")) return json({ users: [{ localId: "worker1" }] }, 200);
  if (url.includes("settings/main")) return json({ fields: { push: { mapValue: { fields: { h1: { mapValue: { fields: {
    e: { stringValue: "https://fcm.googleapis.com/fcm/send/x" }, p: { stringValue: b64u(ua) }, a: { stringValue: b64u(new Uint8Array(16)) },
    u: { stringValue: "owner" }, k: { arrayValue: { values: [{ stringValue: "debt" }] } } } } } } } } } }, 200);
  if (url.startsWith("https://fcm.googleapis.com/")) { sends++; return new Response("", { status: 201 }); }
  throw new Error("unexpected " + url);
};
const ask = tag => handlePush(new Request("https://w/push", { method: "POST", headers: { Authorization: "Bearer t" }, body: JSON.stringify({ kind: "debt", title: "دين", tag }) }), env, json, {}).then(r => r.json());

test("/push: the same entry twice reaches the phone once", async () => {
  assert.equal((await ask("a1")).sent, 1);
  const again = await ask("a1");
  assert.equal(again.dup, true);
  assert.equal(sends, 1);
  assert.equal((await ask("a2")).sent, 1, "another entry still goes");
  assert.equal(sends, 2);
});
