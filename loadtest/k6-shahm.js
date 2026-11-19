// Load test: 3000 people at once on the app's real endpoints (sign-in, reading the book, saving a debt, the live link).
// STAGING ONLY (it refuses the live server and the live Firebase key). How to run: loadtest/README.md.
//   k6 run -e BASE=https://shahm-ai-staging.hydrzyd83.workers.dev -e FB_KEY=<staging web key> -e ACCOUNTS=./accounts.json k6-shahm.js
// SCALE=0.1 runs 300 people instead of 3000; HOLD=10m how long the peak lasts; TENANTS=main,<shop uid> spreads people over books.
import http from "k6/http";
import ws from "k6/ws";
import { check, sleep } from "k6";
import { SharedArray } from "k6/data";
import { Counter, Trend } from "k6/metrics";

const BASE = __ENV.BASE;                        // رابط الـ worker التجريبي
const AUTH = __ENV.AUTH_URL || "https://identitytoolkit.googleapis.com"; // أو http://127.0.0.1:9099/identitytoolkit.googleapis.com للمحاكي
const KEY = __ENV.FB_KEY;
const TENANTS = (__ENV.TENANTS || __ENV.TENANT || "main").split(",").map(s => s.trim()).filter(Boolean);
const TENANT_OF = () => TENANTS[(__VU - 1) % TENANTS.length];
const SCALE = Number(__ENV.SCALE || 1), HOLD = __ENV.HOLD || "10m", RAMP = __ENV.RAMP || "3m";
const n = x => Math.max(1, Math.round(x * SCALE));
const CUST = __ENV.CUSTOMER || "k6-cust-1";     // زبون تجريبي موجود بدفتر التجربة
const accounts = new SharedArray("accounts", () => JSON.parse(open(__ENV.ACCOUNTS || "./accounts.json")));

const limited = new Counter("rate_limited_429");
const loginT = new Trend("login_ms", true);

// 3000 مستخدم: 1800 يتصفح (سحب)، 900 يسجّل ديون/تسديدات (حفظ)، 300 مربوطين على التحديث المباشر.
// تسجيل الدخول معدل ثابت لأن Firebase Auth يحظر الضغط العالي من نفس الـ IP.
export const options = {
  setupTimeout: "10m",
  scenarios: {
    login: { executor: "constant-arrival-rate", rate: Math.max(1, Math.round(5 * SCALE)), timeUnit: "1s", duration: HOLD, startTime: RAMP, preAllocatedVUs: 20, exec: "login" },
    browse: { executor: "ramping-vus", startVUs: 0, exec: "browse",
      stages: [{ duration: RAMP, target: n(1800) }, { duration: HOLD, target: n(1800) }, { duration: "1m", target: 0 }] },
    save: { executor: "ramping-vus", startVUs: 0, exec: "save",
      stages: [{ duration: RAMP, target: n(900) }, { duration: HOLD, target: n(900) }, { duration: "1m", target: 0 }] },
    live: { executor: "ramping-vus", startVUs: 0, exec: "live",
      stages: [{ duration: RAMP, target: n(300) }, { duration: HOLD, target: n(300) }, { duration: "1m", target: 0 }] },
  },
  thresholds: {
    "http_req_failed{scenario:browse}": ["rate<0.01"],
    "http_req_failed{scenario:save}": ["rate<0.01"],
    "http_req_duration{scenario:browse}": ["p(95)<800"],
    "http_req_duration{scenario:save}": ["p(95)<1000"],
    login_ms: ["p(95)<1500"],
    rate_limited_429: ["count<100"],
  },
};

function signIn(a) {
  const r = http.post(`${AUTH}/v1/accounts:signInWithPassword?key=${KEY}`,
    JSON.stringify({ email: a.email, password: a.password, returnSecureToken: true }),
    { headers: { "Content-Type": "application/json" }, tags: { name: "login" } });
  return r.status === 200 ? { token: r.json("idToken"), ms: r.timings.duration } : null;
}

// توكن لكل حساب مرة وحدة (صالح ساعة). الـ VUs يتقاسمون الحسابات بالتناوب.
const LIVE_KEY = "AIzaSyA8ZcghTnu-k3iQ01JuBeXPl44Pj0pwDDg";
export function setup() {
  if (!BASE || /\/\/shahm-ai\.[^/]*workers\.dev/.test(BASE) || /shahm-debts\.app/.test(BASE) || KEY === LIVE_KEY)
    throw new Error("This load test runs on staging only (BASE must be the staging worker, FB_KEY the test project's).");
  const tokens = [];
  for (const a of accounts) { const s = signIn(a); if (s) tokens.push(s.token); sleep(0.2); }
  if (!tokens.length) throw new Error("ما نجح ولا تسجيل دخول");
  return { tokens };
}
const tok = d => d.tokens[(__VU - 1) % d.tokens.length];
const auth = d => ({ Authorization: `Bearer ${tok(d)}` });

export function login() {
  const s = signIn(accounts[Math.floor(Math.random() * accounts.length)]);
  check(s, { "login ok": x => !!x });
  if (s) loginT.add(s.ms);
}

// فتح الدفتر: أول سحب كامل (since=0) ثم سحب التغييرات بس، مثل التطبيق (web/index.html d1Read).
export function browse(d) {
  let since = 0, more = true;
  while (more) {
    const r = http.get(`${BASE}/db/pull?tenant=${TENANT_OF()}&since=${since}`, { headers: auth(d), tags: { name: "pull" } });
    if (r.status === 429) { limited.add(1); break; }
    if (!check(r, { "pull 200": x => x.status === 200 })) break;
    since = r.json("u"); more = r.json("more");
  }
  for (let i = 0; i < 6; i++) {
    sleep(10 + Math.random() * 10);
    const r = http.get(`${BASE}/db/pull?tenant=${TENANT_OF()}&since=${since}`, { headers: auth(d), tags: { name: "pull_delta" } });
    if (r.status === 429) { limited.add(1); continue; }
    if (check(r, { "delta 200": x => x.status === 200 })) since = r.json("u");
  }
}

// «الطلب» = حفظ دين أو تسديد (POST /db/push)، نفس شكل الحركة اللي يقبله shapeOk.
export function save(d) {
  const id = `k6-${__VU}-${__ITER}-${Date.now()}`;
  const txn = { id, customerId: CUST, type: Math.random() < 0.7 ? "debt" : "pay", amount: 1000 * (1 + Math.floor(Math.random() * 20)),
    at: Date.now(), by: "k6", note: "load-test" };
  const r = http.post(`${BASE}/db/push?tenant=${TENANT_OF()}`, JSON.stringify({ ops: [["txns", id, txn]] }),
    { headers: { ...auth(d), "Content-Type": "application/json" }, tags: { name: "push" } });
  if (r.status === 429) limited.add(1);
  else check(r, { "push 200": x => x.status === 200 });
  sleep(15 + Math.random() * 15);
}

// «تحديث الموقع» = الرابط المباشر بين الأجهزة (WebSocket /db/live على Durable Object).
export function live(d) {
  const url = `${BASE.replace(/^http/, "ws")}/db/live?tenant=${TENANT_OF()}`;
  const res = ws.connect(url, { headers: { "Sec-WebSocket-Protocol": `bearer, ${tok(d)}` } }, s => {
    s.setInterval(() => s.send("ping"), 30000);
    s.setTimeout(() => s.close(), 120000);
  });
  check(res, { "ws 101": r => r && r.status === 101 });
}
