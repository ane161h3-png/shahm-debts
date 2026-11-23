// The k6 test's flow in plain Node, small: N people at once, each reads the whole book, saves a debt, reads what changed,
// and holds the live link a moment. A quick check before k6 (and the same staging-only rule).
//   BASE=<staging worker> FB_KEY=<staging key> USERS=100 node loadtest/smoke.mjs
import { readFileSync } from "node:fs";
const BASE = process.env.BASE, KEY = process.env.FB_KEY, USERS = Number(process.env.USERS || 100), TENANT = process.env.TENANT || "main";
const AUTH = process.env.AUTH_URL || "https://identitytoolkit.googleapis.com";
if (!BASE || /\/\/shahm-ai\.[^/]*workers\.dev/.test(BASE) || KEY === "AIzaSyA8ZcghTnu-k3iQ01JuBeXPl44Pj0pwDDg") { console.error("Staging only."); process.exit(2); }
const accounts = JSON.parse(readFileSync(process.env.ACCOUNTS || new URL("./accounts.json", import.meta.url), "utf8"));
const tokens = [];
for (const a of accounts) { const r = await fetch(`${AUTH}/v1/accounts:signInWithPassword?key=${KEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...a, returnSecureToken: true }) }); const j = await r.json(); if (j.idToken) tokens.push(j.idToken); }
if (!tokens.length) { console.error("no sign-in worked"); process.exit(1); }
const times = { pull: [], push: [], delta: [], ws: [] }, errs = {};
const bad = (k, s) => { errs[`${k} ${s}`] = (errs[`${k} ${s}`] || 0) + 1; };
const timed = async (k, fn) => { const t = performance.now(); try { const r = await fn(); times[k].push(performance.now() - t); return r; } catch (e) { bad(k, e.message); } };
async function person(i) {
  const H = { Authorization: "Bearer " + tokens[i % tokens.length] };
  let since = 0, more = true;
  // Like the app (d1Get): a busy answer (502/503) is asked again twice after a short random wait.
  const get = async url => { for (let i = 0; ; i++) { const r = await fetch(url, { headers: H }); if (i >= 2 || (r.status !== 502 && r.status !== 503)) return r; bad("pull retry", r.status); await new Promise(z => setTimeout(z, 700 * (i + 1) + Math.random() * 1500)); } };
  while (more) { const r = await timed("pull", () => get(`${BASE}/db/pull?tenant=${TENANT}&since=${since}`)); if (!r || !r.ok) { bad("pull", r && r.status); return; } const j = await r.json(); since = j.u; more = j.more; }
  const id = `smoke-${i}-${Date.now()}`;
  // A save the busy server did not take is sent again in 5-20 s, as the app does (d1Flush).
  const send = () => fetch(`${BASE}/db/push?tenant=${TENANT}`, { method: "POST", headers: { ...H, "Content-Type": "application/json" },
    body: JSON.stringify({ ops: [["txns", id, { id, customerId: "k6-cust-1", type: "debt", amount: 1000, at: Date.now(), by: "smoke", note: "load-test" }]] }) });
  const r = await timed("push", async () => { for (let i = 0; ; i++) { const x = await send(); if (i >= 2 || (x.status !== 502 && x.status !== 503)) return x; bad("push retry", x.status); await new Promise(z => setTimeout(z, 5000 + Math.random() * 15000)); } });
  if (!r || !r.ok) bad("push", r && r.status);
  const d = await timed("delta", () => fetch(`${BASE}/db/pull?tenant=${TENANT}&since=${since}`, { headers: H }));
  if (!d || !d.ok) bad("delta", d && d.status);
  await timed("ws", () => new Promise((res, rej) => { const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/db/live?tenant=${TENANT}`, ["bearer", tokens[i % tokens.length]]);
    ws.onopen = () => { setTimeout(() => { ws.close(); res(); }, 500); }; ws.onerror = () => rej(new Error("ws")); }));
}
const t0 = performance.now();
await Promise.all(Array.from({ length: USERS }, (_, i) => person(i)));
const p95 = a => a.length ? Math.round(a.sort((x, y) => x - y)[Math.floor(a.length * 0.95) - (a.length > 1 ? 1 : 0)] || a[a.length - 1]) : "-";
console.log(`${USERS} people at once, ${tokens.length} accounts, ${Math.round(performance.now() - t0)} ms total`);
for (const k of Object.keys(times)) console.log(`  ${k}: ${times[k].length} ok, p95 ${p95(times[k])} ms`);
console.log(Object.keys(errs).length ? "  errors: " + JSON.stringify(errs) : "  no errors");
process.exit(Object.keys(errs).some(k => !/^(pull|push) retry/.test(k)) ? 1 : 0);
