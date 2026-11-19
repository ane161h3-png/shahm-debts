// Health of the server and what it depends on.
//   GET /health  anyone (an uptime monitor): checks D1 and the backups store right here; 200 {ok: true, checks} or 503.
//                Never shows data or errors' details. At most 30 a minute per address (HEALTH_LIMIT).
// selfCheck(): every 10 minutes from the cron (wrangler.toml), also the website, Firebase sign-in and Firestore (a
// refused unsigned read: 403 = up, 429 = the day's free reads are used up). The first time something fails twice in a
// row it sends one Telegram alert, and one more when everything is back, keeping that state in KV (BK) under
// "health:state" (written only when it changes).

const TIMEOUT = 8000;
const SITE = "https://shahm-debts.app/";

async function timed(fn) {
  const t0 = Date.now();
  try {
    const ok = await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), TIMEOUT))]);
    return ok === true ? { ok: true, ms: Date.now() - t0 } : { ok: false, ms: Date.now() - t0, why: String(ok || "failed") };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, why: e && e.message === "timeout" ? "timeout" : "error" };
  }
}

// The server's own parts: answer quickly, read nothing that costs.
export async function coreChecks(env) {
  const checks = {};
  checks.d1 = env.DB ? await timed(async () => (await env.DB.prepare("SELECT 1 AS x").first("x")) === 1) : { ok: false, why: "not bound" };
  checks.kv = env.BK ? await timed(async () => { await env.BK.get("health:state"); return true; }) : { ok: false, why: "not bound" };
  return checks;
}

export async function deepChecks(env, fetcher = fetch) {
  const checks = await coreChecks(env);
  checks.site = await timed(async () => { const r = await fetcher(SITE, { method: "HEAD", redirect: "follow" }); return r.ok || `http ${r.status}`; });
  const auth = env.AUTH_URL || "https://identitytoolkit.googleapis.com";
  checks.auth = await timed(async () => {
    const r = await fetcher(`${auth}/v1/projects?key=${env.FIREBASE_API_KEY}`);
    return r.status < 500 || `http ${r.status}`;
  });
  const fs = env.FIRESTORE_URL || "https://firestore.googleapis.com";
  checks.firestore = await timed(async () => {
    const r = await fetcher(`${fs}/v1/projects/${env.FIREBASE_PROJECT}/databases/(default)/documents/meta/health`);
    return r.status === 429 ? "quota" : r.status < 500 || `http ${r.status}`;
  });
  return checks;
}

export async function handleHealth(request, env, json) {
  const open = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
  if (env.HEALTH_LIMIT) {
    const ip = request.headers.get("CF-Connecting-IP") || "?";
    if (!(await env.HEALTH_LIMIT.limit({ key: ip })).success) return json({ error: "too many" }, 429, open);
  }
  const checks = await coreChecks(env);
  const ok = Object.values(checks).every(c => c.ok);
  return json({ ok, checks, at: new Date().toISOString() }, ok ? 200 : 503, open);
}

const NAMES = { d1: "قاعدة البيانات (D1)", kv: "خزن النسخ الاحتياطية", site: "الموقع shahm-debts.app", auth: "تسجيل الدخول (Firebase)", firestore: "Firestore" };
const why = (k, c) => k === "firestore" && c.why === "quota" ? "خلصت قراءات Firestore المجانية لليوم (التطبيق يكمل من D1)" : `${NAMES[k] || k}: ${c.why === "timeout" ? "ما يرد" : "يرجع خطأ"}`;

// Compares with the last state and says what to send: {state, message|null}. Pure, so it can be tested.
export function nextState(prev, checks, now = Date.now()) {
  const bad = Object.entries(checks).filter(([, c]) => !c.ok).map(([k, c]) => why(k, c)).sort();
  const p = prev || { bad: [], streak: 0, alerted: false };
  if (!bad.length) {
    const message = p.alerted ? `✅ رجع كلشي يشتغل (${new Date(now).toISOString().slice(11, 16)} UTC).` : null;
    return { state: { bad: [], streak: 0, alerted: false }, message, changed: p.bad.length > 0 || p.alerted };
  }
  const same = JSON.stringify(bad) === JSON.stringify(p.bad);
  const streak = same ? p.streak + 1 : 1;
  // Twice in a row (20 minutes) before alerting, so one slow answer doesn't wake anybody; again only if what's wrong changes.
  const send = streak >= 2 && (!p.alerted || !same);
  const message = send ? `⚠️ مشكلة بالسيرفر:\n- ${bad.join("\n- ")}\nالتطبيق يحفظ بالجهاز ويرسل لما يرجع. راح تجيك رسالة لما يتصلح.` : null;
  return { state: { bad, streak, alerted: p.alerted && same ? true : send }, message, changed: true };
}

export async function selfCheck(env, fetcher = fetch) {
  const checks = await deepChecks(env, fetcher);
  let prev = null;
  try { prev = env.BK ? await env.BK.get("health:state", "json") : null; } catch (e) {}
  const { state, message, changed } = nextState(prev, checks);
  if (changed && env.BK) try { await env.BK.put("health:state", JSON.stringify(state)); } catch (e) {}
  if (message && env.TELEGRAM_TOKEN && env.TELEGRAM_CHAT_ID) {
    await fetcher(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: message }),
    }).catch(() => {});
  }
  console.log(JSON.stringify({ level: Object.values(checks).every(c => c.ok) ? "info" : "warn", event: "health.self", checks, alerted: !!message }));
  return { checks, state, message };
}
