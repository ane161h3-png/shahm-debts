// Telegram reports: signs in to Firebase as the read-only `backup` account, reads every collection the app
// uses, and sends backups in the same format as the app's «حفظ نسخة» (so «استعادة» accepts them).
//   MODE=periodic (every 2 hours): what changed in the last two hours, what is still pending, a backup, and a PDF of those transactions.
//   MODE=daily (02:00 Baghdad): backup, end-of-day summary, and a PDF with every transaction of the day.
// Runs from .github/workflows/backup.yml. Needs env: BACKUP_PASSWORD, TELEGRAM_TOKEN, TELEGRAM_CHAT_ID.
// The data never touches the repo or the logs.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { dayPdf, windowPdf } from "./day-report.mjs";

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
    for (const d of j.documents || []) out.push({ id: d.name.split("/").pop(), ...fields(d.fields || {}) });
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

// The cashier's collections are newer than the backup account's rules may be: until firestore.rules is published
// they read as forbidden, and the report goes on without them instead of failing.
async function readOptional(token, coll) {
  try { return await readAll(token, coll); } catch (e) { console.warn(`Skipping ${coll}: ${e.message}`); return []; }
}

const fmt = n => Math.round(n).toLocaleString("en-US");

// Cashier sales (web/pos/) in a time range: totals, how they were paid, and the best sellers.
function salesSummary(sales, inRange) {
  const list = sales.filter(s => s.status !== "void" && inRange(Number(s.at) || 0));
  const sum = k => list.reduce((a, s) => a + (Number(s[k]) || 0), 0);
  const items = new Map();
  // Profit counts only items sold with a known purchase price (cost per sold unit), minus the discounts.
  let margin = 0, costed = 0, uncosted = 0;
  for (const s of list) for (const i of s.items || []) {
    const x = items.get(i.name) || { qty: 0, total: 0 };
    x.qty += Number(i.qty) || 0; x.total += Number(i.total) || 0; items.set(i.name, x);
    if (Number(i.cost) > 0) { costed++; margin += (Number(i.total) || 0) - Number(i.cost) * (Number(i.qty) || 0); }
    else uncosted += Number(i.total) || 0;
  }
  return { n: list.length, total: sum("total"), cash: sum("cash"), debt: sum("debt"), discount: sum("discount"),
    profit: costed ? margin - sum("discount") : null, uncosted,
    top: [...items].sort((a, b) => b[1].total - a[1].total).slice(0, 5) };
}
const salesLine = p => `🛒 مبيعات الكاشير: ${fmt(p.total)} د.ع (${p.n} فاتورة) · كاش ${fmt(p.cash)}${p.debt ? ` · دين ${fmt(p.debt)}` : ""}`;

const profitLine = p => p.profit === null ? "" : `💰 الربح: ${fmt(p.profit)} د.ع${p.uncosted ? ` (مبيعات ${fmt(p.uncosted)} بدون سعر شراء ما محسوبة)` : ""}`;

// Items to reorder or check: out of stock, at or under their minimum, expired or expiring within 30 days.
function stockAlerts(products, today) {
  const out = [];
  const days = iso => Math.round((Date.parse(iso + "T12:00:00Z") - Date.parse(today + "T12:00:00Z")) / 864e5);
  for (const p of products) {
    if (p.active === false) continue;
    const w = [];
    if (p.track === true) {
      const s = Number(p.stock) || 0, u = p.unit || "حبة";
      if (s <= 0) w.push("خلصت");
      else if (Number(p.min) > 0 && s <= Number(p.min)) w.push(`باقي ${Math.round(s * 1000) / 1000} ${u}`);
    }
    if (p.expiry) { const d = days(p.expiry); if (d < 0) w.push(`انتهت ${p.expiry}`); else if (d <= 30) w.push(`تنتهي ${p.expiry}`); }
    if (w.length) out.push(`  • ${p.name}: ${w.join("، ")}`);
  }
  return out;
}

const BAGHDAD = 3 * 3600e3;
const isoDay = ms => new Date(ms + BAGHDAD).toISOString().slice(0, 10);

// End-of-day report. The job runs at 02:00 Baghdad time, so before noon it reports the day that just ended;
// a manual run in the afternoon reports today so far. Counts what was recorded that day (createdAt).
function reportDay(now) {
  const local = new Date(now.getTime() + BAGHDAD);
  return isoDay(now.getTime() - (local.getUTCHours() < 12 ? 24 * 3600e3 : 0));
}
function daySummary(customers, txns, settings, now, sales = [], products = [], shifts = []) {
  const day = reportDay(now);
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
  const pos = salesSummary(sales, ms => isoDay(ms) === day);
  if (pos.n) {
    lines.push(salesLine(pos));
    if (profitLine(pos)) lines.push(profitLine(pos));
    if (pos.discount) lines.push(`🏷 خصومات: ${fmt(pos.discount)} د.ع`);
    if (pos.top.length) lines.push("أكثر المواد مبيعاً:", ...pos.top.map(([n, x]) => `  • ${n}: ${fmt(x.total)}`));
    lines.push("");
  }
  // Shifts closed that day (cashier Z reports): how the drawer counted against what it should hold.
  const closed = shifts.filter(x => x.status === "closed" && x.closedAt && isoDay(Number(x.closedAt)) === day).sort((a, b) => a.closedAt - b.closedAt);
  if (closed.length) {
    const dt = d => d === 0 ? "مضبوط ✅" : d > 0 ? `زايد ${fmt(d)}` : `ناقص ${fmt(-d)} ⚠️`;
    lines.push("🔒 الورديات:", ...closed.map(x => `  • ${x.openedBy || "؟"} ${hm(Number(x.openedAt))} إلى ${hm(Number(x.closedAt))}: مبيعات ${fmt((x.z && x.z.total) || 0)}، الدرج ${dt(Number(x.diff) || 0)}`), "");
  }
  if (!done.length && !newCust) lines.push("ما انسجلت أي حركة ديون بهذا اليوم.");
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
  const alerts = stockAlerts(products, isoDay(now.getTime()));
  if (alerts.length) lines.push("", "📦 تنبيهات المخزن:", ...alerts.slice(0, 15), ...(alerts.length > 15 ? [`  … و ${alerts.length - 15} غيرها (تبويب المواد بالكاشير)`] : []));
  return lines.join("\n");
}

// Baghdad wall-clock helpers (UTC+3, no DST).
const hm = ms => { const d = new Date(ms + BAGHDAD); let h = d.getUTCHours(); const ap = h < 12 ? "ص" : "م"; h = h % 12 || 12; return `${h}:${String(d.getUTCMinutes()).padStart(2, "0")} ${ap}`; };
const isSup = (byId, id) => (byId.get(id) || {}).kind === "supplier";

// One line per activity entry, worded like the app's activity log.
function actText(a) {
  const amt = a.amount ? ` ${fmt(a.amount)}` : "", c = a.customerName || "";
  const k = a.kind;
  switch (a.what) {
    case "debt": return a.sup ? (k === "add" ? `فاتورة شراء${amt} من ${c}` : k === "edit" ? `عدّل فاتورة ${c}${a.detail ? " (" + a.detail + ")" : ""}` : `حذف فاتورة${amt} من ${c}`)
      : (k === "add" ? `دين${amt} على ${c}` : k === "edit" ? `عدّل دين ${c}${a.detail ? " (" + a.detail + ")" : ""}` : `حذف دين${amt} من ${c}`);
    case "pay": return a.sup ? (k === "add" ? `دفعة${amt} للمورد ${c}` : k === "edit" ? `عدّل دفعة ${c}` : `حذف دفعة${amt} من ${c}`)
      : (k === "add" ? `تسديد${amt} من ${c}` : k === "edit" ? `عدّل تسديد ${c}${a.detail ? " (" + a.detail + ")" : ""}` : `حذف تسديد${amt} من ${c}`);
    case "customer": return k === "add" ? `حساب جديد: ${c}` : k === "edit" ? `عدّل حساب ${c}${a.detail ? " (" + a.detail + ")" : ""}` : `حذف حساب ${c}`;
    case "remind": return `تذكير واتساب إلى ${c}`;
    default: return a.detail || "";
  }
}
const ICON = { add: "➕", edit: "✏️", delete: "🗑", remind: "💬" };

// Two-hour report. The window is the two-hour slot that just closed (even UTC hours), so a late GitHub run
// neither skips nor repeats entries; a manual run reports the last two hours.
function periodicReport(customers, txns, activity, settings, now, manual, sales = []) {
  const end = manual ? now.getTime() : Math.floor(now.getTime() / 7200e3) * 7200e3, start = end - 7200e3;
  const byId = new Map(customers.map(c => [c.id, c]));
  const inWin = ms => ms >= start && ms < end;
  const acts = activity.filter(a => a.kind !== "login" && inWin(Number(a.at) || 0)).sort((a, b) => a.at - b.at);
  const made = txns.filter(t => inWin(Number(t.createdAt) || 0));
  const sum = (type, sup) => made.filter(t => t.type === type && isSup(byId, t.customerId) === sup).reduce((a, t) => ({ n: a.n + 1, v: a.v + (Number(t.amount) || 0) }), { n: 0, v: 0 });
  const debt = sum("debt", false), pay = sum("pay", false), buy = sum("debt", true), paySup = sum("pay", true);
  const shop = settings.shopName || "ماركت الشهم";
  const lines = [`🕑 تحديث ${shop}: من ${hm(start)} إلى ${hm(end)}`, ""];
  const pos = salesSummary(sales, inWin);
  if (pos.n) lines.push(salesLine(pos));
  if (!acts.length && !made.length && !pos.n) lines.push("ما صار شي بهالساعتين.");
  else if (acts.length || made.length) {
    if (debt.n) lines.push(`🔴 ديون: ${fmt(debt.v)} د.ع (${debt.n})`);
    if (pay.n) lines.push(`🟢 واصل: ${fmt(pay.v)} د.ع (${pay.n})`);
    if (buy.n || paySup.n) lines.push(`🚚 الموردين: مشتريات ${fmt(buy.v)} · دفعات ${fmt(paySup.v)}`);
    const edits = acts.filter(a => a.kind === "edit").length, dels = acts.filter(a => a.kind === "delete").length;
    if (edits || dels) lines.push(`⚠️ ${edits ? edits + " تعديل" : ""}${edits && dels ? " و " : ""}${dels ? dels + " حذف" : ""}`);
    lines.push("", "شنو صار:");
    const MAX = 40;
    for (const a of acts.slice(0, MAX)) lines.push(`${ICON[a.kind] || "•"} ${hm(a.at)} · ${actText(a)}${a.by ? " · " + a.by : ""}`);
    if (acts.length > MAX) lines.push(`… و ${acts.length - MAX} غيرها (كلها بالنسخة المرفقة)`);
  }
  // Still pending: promises due today (or overdue) that have not been paid yet.
  const today = isoDay(now.getTime());
  const bal = new Map();
  for (const t of txns) bal.set(t.customerId, (bal.get(t.customerId) || 0) + (t.type === "debt" ? t.amount : -t.amount));
  const waiting = customers.filter(c => c.kind !== "supplier" && c.promise && c.promise.date && c.promise.date <= today && (bal.get(c.id) || 0) > 0)
    .map(c => `  • ${c.name}${c.promise.amount ? ": " + fmt(c.promise.amount) : ""}${c.promise.date < today ? " (فات موعده)" : ""}`);
  if (waiting.length) lines.push("", "🤝 ما صار بعد: وعدوا يدفعون وما دفعوا", ...waiting.slice(0, 20), ...(waiting.length > 20 ? [`  … و ${waiting.length - 20} غيرهم`] : []));
  return { text: lines.join("\n").slice(0, 4000), changed: acts.length > 0 || made.length > 0 || pos.n > 0, start, end, stamp: `${today}-${hm(end).replace(/[:\s]/g, "")}` };
}

async function tg(method, body) {
  const isForm = body instanceof FormData;
  const r = await fetch(`${TG_URL}/bot${env("TELEGRAM_TOKEN")}/${method}`, { method: "POST", ...(isForm ? { body } : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  const j = await r.json();
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.description}`);
}
async function sendFile(name, data, type, caption, quiet) {
  const form = new FormData();
  form.append("chat_id", env("TELEGRAM_CHAT_ID"));
  if (caption) form.append("caption", caption.slice(0, 1000));
  if (quiet) form.append("disable_notification", "true");
  form.append("document", new Blob([data], { type }), name);
  await tg("sendDocument", form);
}

async function main() {
  const mode = (process.env.MODE || "daily").trim();
  const token = await signIn();
  const [customers, txns, activity, settings, sales, products, shifts] = await Promise.all([
    readAll(token, "customers"), readAll(token, "txns"), readAll(token, "activity"), readDoc(token, "settings/main"),
    readOptional(token, "sales"), readOptional(token, "products"), readOptional(token, "shifts"),
  ]);
  const now = new Date();
  const day = isoDay(now.getTime());
  const shop = settings.shopName || "ماركت الشهم";
  const slug = shop.replace(/\s+/g, "-");
  const backup = { app: "shahm-debts", version: 3, exportedAt: now.toISOString(), source: mode === "periodic" ? "telegram-2h" : "daily-telegram", settings, customers, txns, accounts: [], activity, products, sales, shifts };
  const backupJson = JSON.stringify(backup);
  const chat = env("TELEGRAM_CHAT_ID");

  if (mode === "periodic") {
    const rep = periodicReport(customers, txns, activity, settings, now, process.env.MANUAL === "true", sales);
    // Quiet slots (usually at night) get a silent one-line message; the last backup is still current.
    await tg("sendMessage", { chat_id: chat, text: rep.text, ...(rep.changed ? {} : { disable_notification: true }) });
    if (rep.changed) {
      await sendFile(`نسخة-${slug}-${rep.stamp}.json`, backupJson, "application/json", "💾 نسخة احتياطية بعد آخر تحديث");
      const file = await windowPdf({ start: rep.start, end: rep.end, customers, txns, activity, settings, fmt, isoDay, hm });
      if (file) await sendFile(file.name, file.data, file.type, `📄 حركات من ${hm(rep.start)} إلى ${hm(rep.end)}`);
    }
    console.log(`Sent 2-hour report (${rep.changed ? "with" : "no"} changes).`);
    return;
  }

  const bal = new Map();
  for (const t of txns) bal.set(t.customerId, (bal.get(t.customerId) || 0) + (t.type === "debt" ? t.amount : -t.amount));
  let owed = 0, owing = 0;
  for (const c of customers) if (c.kind !== "supplier") { const b = bal.get(c.id) || 0; if (b > 0) { owed += b; owing++; } }
  const caption = [
    `💾 نسخة احتياطية يومية: ${shop}`,
    `📅 ${day}`,
    `👥 ${customers.length} حساب · ${txns.length} حركة`,
    `💰 مجموع الديون: ${fmt(owed)} د.ع (${owing} زبون)`,
    `للاستعادة: الإعدادات ← النسخ الاحتياطي ← اختيار ملف النسخة`,
  ].join("\n");
  await sendFile(`نسخة-ديون-${slug}-${day}.json`, backupJson, "application/json", caption);
  console.log(`Sent backup: ${customers.length} accounts, ${txns.length} transactions, ${activity.length} activity entries.`);

  await tg("sendMessage", { chat_id: chat, text: daySummary(customers, txns, settings, now, sales, products, shifts).slice(0, 4000) });
  console.log("Sent end-of-day summary.");

  // Every transaction of the reported day in one PDF (CSV if no browser is available to print it).
  const rDay = reportDay(now);
  const file = await dayPdf({ day: rDay, customers, txns, activity, settings, fmt, isoDay, hm });
  if (file) { await sendFile(file.name, file.data, file.type, `📄 كل حركات يوم ${rDay}`); console.log("Sent day file:", file.type); }
}

main().catch(async e => {
  console.error(e.message);
  // Tell the owner on Telegram too, so a broken backup does not go unnoticed.
  const tok = process.env.TELEGRAM_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (tok && chat) {
    try { await fetch(`${TG_URL}/bot${tok}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chat, text: (process.env.MODE === "periodic" ? "⚠️ فشل تقرير الساعتين: " : "⚠️ فشلت النسخة الاحتياطية اليومية: ") + e.message }) }); } catch {}
  }
  process.exit(1);
});
