// Daily backup: signs in to Firebase as the read-only `backup` account, reads every collection the app
// uses, and sends the file to Telegram in the same format as the app's «حفظ نسخة» (so «استعادة» accepts it).
// Runs from .github/workflows/backup.yml. Needs env: BACKUP_PASSWORD, TELEGRAM_TOKEN, TELEGRAM_CHAT_ID.
// The data never touches the repo or the logs.
import { readFileSync } from "node:fs";
import vm from "node:vm";

const env = name => {
  const v = (process.env[name] || "").trim();
  if (!v) { console.error(`Missing secret: ${name}`); process.exit(1); }
  return v;
};

// Public Firebase keys come from the app's own config so there is one place to change them.
const cfgSrc = readFileSync(new URL("../web/config.js", import.meta.url), "utf8");
const sandbox = { window: {} };
vm.runInNewContext(cfgSrc, sandbox);
const cfg = sandbox.window.FIREBASE_CONFIG;
const AUTH_URL = process.env.AUTH_URL || "https://identitytoolkit.googleapis.com";
const DB_URL = process.env.FIRESTORE_URL || "https://firestore.googleapis.com";
const TG_URL = process.env.TELEGRAM_URL || "https://api.telegram.org";
const USER = process.env.BACKUP_USER || "backup";

async function signIn() {
  const r = await fetch(`${AUTH_URL}/v1/accounts:signInWithPassword?key=${cfg.apiKey}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `${USER}@shahm-debts.app`, password: env("BACKUP_PASSWORD"), returnSecureToken: true }),
  });
  const j = await r.json();
  if (!r.ok) {
    const code = (j.error && j.error.message) || "";
    if (/INVALID_PASSWORD|INVALID_LOGIN_CREDENTIALS|EMAIL_NOT_FOUND/.test(code))
      throw new Error(`كلمة مرور حساب ${USER} غلط، أو الحساب غير موجود (${code})`);
    throw new Error("Sign-in failed: " + code);
  }
  return j.idToken;
}

// Firestore REST values -> plain JSON.
function plain(v) {
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("timestampValue" in v) return v.timestampValue;
  if ("mapValue" in v) return fields(v.mapValue.fields || {});
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(plain);
  return null;
}
const fields = f => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, plain(v)]));

async function readAll(token, coll) {
  const out = [];
  let page = "";
  do {
    const url = `${DB_URL}/v1/projects/${cfg.projectId}/databases/(default)/documents/${coll}?pageSize=300${page ? "&pageToken=" + page : ""}`;
    const r = await fetch(url, { headers: { Authorization: "Bearer " + token } });
    const j = await r.json();
    if (r.status === 403) throw new Error(`حساب ${USER} غير مفعّل أو موقوف. فعّله من الإعدادات ← المستخدمين.`);
    if (!r.ok) throw new Error(`Reading ${coll} failed: ${j.error && j.error.message}`);
    for (const d of j.documents || []) out.push(fields(d.fields || {}));
    page = j.nextPageToken || "";
  } while (page);
  return out;
}

async function readDoc(token, path) {
  const r = await fetch(`${DB_URL}/v1/projects/${cfg.projectId}/databases/(default)/documents/${path}`, { headers: { Authorization: "Bearer " + token } });
  if (r.status === 404) return {};
  if (r.status === 403) throw new Error(`حساب ${USER} غير مفعّل أو موقوف. فعّله من الإعدادات ← المستخدمين.`);
  const j = await r.json();
  if (!r.ok) throw new Error(`Reading ${path} failed: ${j.error && j.error.message}`);
  return fields(j.fields || {});
}

const fmt = n => Math.round(n).toLocaleString("en-US");

const BAGHDAD = 3 * 3600e3;
const isoDay = ms => new Date(ms + BAGHDAD).toISOString().slice(0, 10);

// End-of-day report. The job runs at 02:00 Baghdad time, so before noon it reports the day that just ended;
// a manual run in the afternoon reports today so far. Counts what was recorded that day (createdAt).
function daySummary(customers, txns, settings, now) {
  const local = new Date(now.getTime() + BAGHDAD);
  const day = isoDay(now.getTime() - (local.getUTCHours() < 12 ? 24 * 3600e3 : 0));
  const next = isoDay(Date.parse(day + "T12:00:00Z") + 24 * 3600e3);
  const byId = new Map(customers.map(c => [c.id, c]));
  const sup = id => (byId.get(id) || {}).kind === "supplier";
  const done = txns.filter(t => t.createdAt && isoDay(Number(t.createdAt)) === day);
  const sum = (list, type, supplier) => list.filter(t => t.type === type && sup(t.customerId) === supplier)
    .reduce((a, t) => ({ n: a.n + 1, v: a.v + (Number(t.amount) || 0) }), { n: 0, v: 0 });
  const debt = sum(done, "debt", false), pay = sum(done, "pay", false);
  const buy = sum(done, "debt", true), paySup = sum(done, "pay", true);
  const newCust = customers.filter(c => c.kind !== "supplier" && c.createdAt && isoDay(Number(c.createdAt)) === day).length;

  const who = new Map();
  for (const t of done) { const k = t.by || "غير معروف"; who.set(k, (who.get(k) || 0) + 1); }
  const top = new Map();
  for (const t of done) if (t.type === "debt" && !sup(t.customerId)) top.set(t.customerId, (top.get(t.customerId) || 0) + Number(t.amount || 0));
  const topList = [...top].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id, v]) => `  • ${(byId.get(id) || {}).name || "؟"}: ${fmt(v)}`);

  // Promises to pay that fall on the coming day, so the owner knows whom to expect or remind.
  const promised = customers.filter(c => c.promise && c.promise.date === next)
    .map(c => `  • ${c.name}${c.promise.amount ? ": " + fmt(c.promise.amount) : ""}`);

  const shop = settings.shopName || "ماركت الشهم";
  const lines = [`📊 ملخص يوم ${day}: ${shop}`, ""];
  if (!done.length && !newCust) lines.push("ما انسجلت أي حركة بهذا اليوم.");
  else {
    lines.push(`🔴 ديون جديدة: ${fmt(debt.v)} د.ع (${debt.n} حركة)`);
    lines.push(`🟢 واصل: ${fmt(pay.v)} د.ع (${pay.n} حركة)`);
    const net = debt.v - pay.v;
    lines.push(`${net > 0 ? "📈" : "📉"} الصافي: ${net > 0 ? "زادت" : net < 0 ? "نقصت" : "ثابتة"} الديون ${net ? fmt(Math.abs(net)) + " د.ع" : ""}`.trim());
    if (newCust) lines.push(`👤 زبائن جدد: ${newCust}`);
    if (buy.n || paySup.n) lines.push(`🚚 الموردين: مشتريات ${fmt(buy.v)} · دفعات ${fmt(paySup.v)} د.ع`);
    if (topList.length) lines.push("", "أكثر الديون اليوم:", ...topList);
    if (who.size) lines.push("", "منو سجّل:", ...[...who].sort((a, b) => b[1] - a[1]).map(([k, v]) => `  • ${k}: ${v}`));
  }
  if (promised.length) lines.push("", `🤝 وعدوا يدفعون يوم ${next}:`, ...promised);
  return lines.join("\n");
}

async function main() {
  const token = await signIn();
  const [customers, txns, activity, settings] = await Promise.all([
    readAll(token, "customers"), readAll(token, "txns"), readAll(token, "activity"), readDoc(token, "settings/main"),
  ]);
  const now = new Date();
  const day = new Date(now.getTime() + 3 * 3600e3).toISOString().slice(0, 10); // Baghdad date
  const backup = { app: "shahm-debts", version: 3, exportedAt: now.toISOString(), source: "daily-telegram", settings, customers, txns, accounts: [], activity };

  const bal = new Map();
  for (const t of txns) bal.set(t.customerId, (bal.get(t.customerId) || 0) + (t.type === "debt" ? t.amount : -t.amount));
  let owed = 0, owing = 0;
  for (const c of customers) if (c.kind !== "supplier") { const b = bal.get(c.id) || 0; if (b > 0) { owed += b; owing++; } }
  const shop = settings.shopName || "ماركت الشهم";
  const caption = [
    `💾 نسخة احتياطية يومية: ${shop}`,
    `📅 ${day}`,
    `👥 ${customers.length} حساب · ${txns.length} حركة`,
    `💰 مجموع الديون: ${fmt(owed)} د.ع (${owing} زبون)`,
    `للاستعادة: الإعدادات ← النسخ الاحتياطي ← اختيار ملف النسخة`,
  ].join("\n");

  const form = new FormData();
  form.append("chat_id", env("TELEGRAM_CHAT_ID"));
  form.append("caption", caption);
  form.append("document", new Blob([JSON.stringify(backup)], { type: "application/json" }), `نسخة-ديون-${shop.replace(/\s+/g, "-")}-${day}.json`);
  const r = await fetch(`${TG_URL}/bot${env("TELEGRAM_TOKEN")}/sendDocument`, { method: "POST", body: form });
  const j = await r.json();
  if (!j.ok) throw new Error("Telegram: " + j.description);
  console.log(`Sent backup: ${customers.length} accounts, ${txns.length} transactions, ${activity.length} activity entries.`);

  const summary = daySummary(customers, txns, settings, now);
  const s = await fetch(`${TG_URL}/bot${env("TELEGRAM_TOKEN")}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env("TELEGRAM_CHAT_ID"), text: summary }),
  });
  const sj = await s.json();
  if (!sj.ok) throw new Error("Telegram summary: " + sj.description);
  console.log("Sent end-of-day summary.");
}

main().catch(async e => {
  console.error(e.message);
  // Tell the owner on Telegram too, so a broken backup does not go unnoticed.
  const tok = process.env.TELEGRAM_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (tok && chat) {
    try { await fetch(`${TG_URL}/bot${tok}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chat, text: "⚠️ فشلت النسخة الاحتياطية اليومية: " + e.message }) }); } catch {}
  }
  process.exit(1);
});
