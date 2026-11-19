// Makes the load test's people on STAGING: N active editors in the test Firebase project (users/{uid}), plus one test
// customer in the book, and writes accounts.json for k6. Run again: existing accounts are reused.
//   FB_KEY=<staging web key> FB_PROJECT=<staging project> OWNER_EMAIL=admin@shahm-debts.app OWNER_PASSWORD=... \
//   WORKER=https://shahm-ai-staging.hydrzyd83.workers.dev N=50 node loadtest/make-accounts.mjs
// Refuses the live project. Firebase lets one address make about 100 accounts an hour, so keep N ≤ 80.
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const env = k => { const v = process.env[k]; if (!v) { console.error(`missing ${k}`); process.exit(2); } return v; };
const KEY = env("FB_KEY"), PROJECT = env("FB_PROJECT"), WORKER = env("WORKER").replace(/\/$/, "");
const OWNER_EMAIL = env("OWNER_EMAIL"), OWNER_PASSWORD = env("OWNER_PASSWORD");
const N = Math.min(80, Number(process.env.N || 50)), TENANT = process.env.TENANT || "main";
const AUTH = process.env.AUTH_URL || "https://identitytoolkit.googleapis.com";
const FS = process.env.FIRESTORE_URL || "https://firestore.googleapis.com";
const OUT = process.env.OUT || new URL("./accounts.json", import.meta.url).pathname;
if (PROJECT === "shahm-debts-a080e" || /\/\/shahm-ai\.[^/]*workers\.dev/.test(WORKER)) { console.error("Staging only: this is the live project or server."); process.exit(2); }

const post = async (path, body) => { const r = await fetch(`${AUTH}/v1/accounts:${path}?key=${KEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { ok: r.ok, j: await r.json().catch(() => ({})) }; };
const signIn = (email, password) => post("signInWithPassword", { email, password, returnSecureToken: true });
const own = await signIn(OWNER_EMAIL, OWNER_PASSWORD);
if (!own.ok) { console.error("owner sign-in failed:", own.j.error && own.j.error.message); process.exit(1); }
const ownerToken = own.j.idToken;
const docs = `${FS}/v1/projects/${PROJECT}/databases/(default)/documents`;
const fields = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "number" ? { integerValue: String(v) } : { stringValue: String(v) }]));
const prof = TENANT === "main" ? uid => `users/${uid}` : uid => `shops/${TENANT}/users/${uid}`;

const old = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : [];
const accounts = [];
for (let i = 0; i < N; i++) {
  const email = `k6-${String(i).padStart(3, "0")}@loadtest.invalid`;
  const known = old.find(a => a.email === email);
  const password = known ? known.password : randomBytes(9).toString("base64url");
  let s = known ? await signIn(email, password) : await post("signUp", { email, password, returnSecureToken: true });
  if (!s.ok) { console.error(`${email}: ${s.j.error && s.j.error.message}`); continue; }
  const uid = s.j.localId;
  const r = await fetch(`${docs}/${prof(uid)}`, { method: "PATCH", headers: { Authorization: "Bearer " + ownerToken, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: fields({ status: "active", role: "editor", name: `k6-${i}`, username: `k6${i}`, createdAt: Date.now() }) }) });
  if (!r.ok) { console.error(`${email}: profile ${r.status} ${(await r.text()).slice(0, 200)}`); continue; }
  accounts.push({ email, password });
}
const c = { id: "k6-cust-1", name: "زبون اختبار التحمل", createdAt: Date.now() };
const p = await fetch(`${WORKER}/db/push?tenant=${TENANT}`, { method: "POST", headers: { Authorization: "Bearer " + ownerToken, "Content-Type": "application/json" }, body: JSON.stringify({ ops: [["customers", c.id, c]] }) });
console.log(`test customer: ${p.status}`);
writeFileSync(OUT, JSON.stringify(accounts, null, 1));
console.log(`${accounts.length} of ${N} accounts ready → ${OUT}`);
if (!accounts.length) process.exit(1);
