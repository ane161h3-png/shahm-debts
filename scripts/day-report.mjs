// End-of-day file for Telegram: every transaction recorded on one Baghdad day, as a branded PDF.
// The page is plain HTML printed by headless Chrome (preinstalled on GitHub's Ubuntu runners), so Arabic
// shapes correctly with the app's own fonts. If no browser is found, a CSV (opens in Excel) is sent instead.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const FONTS = pathToFileURL(fileURLToPath(new URL("../web/vendor/fonts/fonts.css", import.meta.url))).href;
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function findChrome() {
  const list = [process.env.CHROME_BIN, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return list.find(p => p && existsSync(p));
}

export async function dayPdf({ day, customers, txns, activity, settings, fmt, isoDay, hm }) {
  const byId = new Map(customers.map(c => [c.id, c]));
  const sup = id => (byId.get(id) || {}).kind === "supplier";
  const rows = txns.filter(t => t.createdAt && isoDay(Number(t.createdAt)) === day).sort((a, b) => a.createdAt - b.createdAt);
  const changes = activity.filter(a => (a.kind === "edit" || a.kind === "delete") && (a.what === "debt" || a.what === "pay") && a.at && isoDay(Number(a.at)) === day)
    .sort((a, b) => a.at - b.at);
  if (!rows.length && !changes.length) return null;

  const op = t => sup(t.customerId) ? (t.type === "debt" ? "فاتورة شراء" : "دفعة للمورد") : (t.type === "debt" ? "دين" : "تسديد");
  const tot = (type, s) => rows.filter(t => t.type === type && sup(t.customerId) === s).reduce((a, t) => a + (Number(t.amount) || 0), 0);
  const debt = tot("debt", false), pay = tot("pay", false), buy = tot("debt", true), paySup = tot("pay", true);
  const shop = settings.shopName || "ماركت الشهم";
  const slug = shop.replace(/\s+/g, "-");

  const chrome = findChrome();
  if (!chrome) {
    const csv = "﻿" + [["الوقت", "الحساب", "العملية", "المبلغ", "ملاحظة", "بواسطة"].join(","),
      ...rows.map(t => [hm(t.createdAt), (byId.get(t.customerId) || {}).name || "", op(t), t.amount, t.note || "", t.by || ""]
        .map(v => `"${String(v).replace(/"/g, '""')}"`).join(","))].join("\n");
    return { name: `حركات-${slug}-${day}.csv`, data: csv, type: "text/csv" };
  }

  // Colours are the printed brand palette (BRAND.md / PDFC in web/index.html).
  const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><link rel="stylesheet" href="${FONTS}">
<style>
@page{size:A4;margin:12mm 0 14mm}
@page :first{margin-top:0}
*{box-sizing:border-box}
body{margin:0;padding:0 12mm;font-family:"IBM Plex Sans Arabic",Tahoma,sans-serif;color:#1c2421;font-size:10.5pt;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.bar{height:5mm;background:#0e5a3a;border-bottom:1.8mm solid #f39a1e;margin:0 -12mm 8mm}
header{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:.4mm solid #e3ded3;padding-bottom:3mm;margin-bottom:4mm}
h1{margin:0;font-family:"Lalezar","Tajawal",sans-serif;font-weight:400;font-size:24pt;color:#0e5a3a;line-height:1.2}
.sub{color:#5e6660;font-size:11pt}
.date{text-align:left;color:#5e6660}
.date b{display:block;color:#1c2421;font-family:"Tajawal",sans-serif;font-size:13pt}
.sums{display:grid;grid-template-columns:repeat(4,1fr);gap:3mm;margin-bottom:5mm}
.sum{border:.3mm solid #e3ded3;border-radius:3mm;padding:2.5mm 3mm}
.sum span{display:block;color:#5e6660;font-size:9pt}
.sum b{font-family:"Tajawal",sans-serif;font-size:14pt;unicode-bidi:isolate}
.sum small{display:block;font-size:9.5pt;color:#5e6660}
.sum small b{font-size:11pt;color:#1c2421}
.debt{color:#c2301e}.paid{color:#4a7f12}
table{width:100%;border-collapse:collapse}
th{background:#f4f2ec;color:#5e6660;font-weight:700;font-size:9pt;text-align:right;padding:2mm}
td{padding:1.8mm 2mm;border-bottom:.25mm solid #ece8df;vertical-align:top}
tr:nth-child(even) td{background:#f8f6f1}
td.n,td.t{color:#5e6660;white-space:nowrap}
td.a{white-space:nowrap;font-weight:700;direction:ltr;text-align:right}
td.o{font-weight:700;white-space:nowrap}
h2{font-family:"Tajawal",sans-serif;font-size:12pt;margin:6mm 0 2mm}
thead{display:table-header-group}
tr{break-inside:avoid}
</style></head><body>
<div class="bar"></div>
<header><div><h1>${esc(shop)}</h1><div class="sub">كل حركات اليوم · ${rows.length} حركة</div></div>
<div class="date">التاريخ<b>${esc(day)}</b></div></header>
<div class="sums">
<div class="sum"><span>الديون</span><b class="debt">${fmt(debt)}</b></div>
<div class="sum"><span>الواصل</span><b class="paid">${fmt(pay)}</b></div>
<div class="sum"><span>صافي الديون</span><b class="${debt - pay > 0 ? "debt" : "paid"}">${debt - pay > 0 ? "زادت " : debt - pay < 0 ? "نقصت " : ""}${fmt(Math.abs(debt - pay))}</b></div>
<div class="sum"><span>الموردين</span><small>مشتريات: <b>${fmt(buy)}</b></small><small>دفعات: <b>${fmt(paySup)}</b></small></div>
</div>
${rows.length ? `<table><thead><tr><th>ت</th><th>الوقت</th><th>الحساب</th><th>العملية</th><th>المبلغ (د.ع)</th><th>ملاحظة</th><th>بواسطة</th></tr></thead><tbody>
${rows.map((t, i) => `<tr><td class="n">${i + 1}</td><td class="t">${esc(hm(t.createdAt))}</td><td>${esc((byId.get(t.customerId) || {}).name || "حساب محذوف")}</td>
<td class="o ${t.type === "debt" ? "debt" : "paid"}">${op(t)}</td><td class="a ${t.type === "debt" ? "debt" : "paid"}">${fmt(t.amount)}</td><td>${esc(t.note || "")}${t.source === "photo" ? " 📷" : ""}</td><td class="t">${esc(t.by || "")}</td></tr>`).join("\n")}
</tbody></table>` : `<p class="sub">ما انسجلت حركات جديدة بهذا اليوم.</p>`}
${changes.length ? `<h2>التعديلات والحذف بهذا اليوم</h2><table><thead><tr><th>الوقت</th><th>شنو صار</th><th>بواسطة</th></tr></thead><tbody>
${changes.map(a => `<tr><td class="t">${esc(hm(a.at))}</td><td>${a.kind === "delete" ? "حذف" : "تعديل"} ${a.what === "debt" ? (a.sup ? "فاتورة" : "دين") : (a.sup ? "دفعة" : "تسديد")}${a.amount ? " " + fmt(a.amount) : ""} · ${esc(a.customerName || "")}${a.detail ? " (" + esc(a.detail) + ")" : ""}</td><td class="t">${esc(a.by || "")}</td></tr>`).join("\n")}
</tbody></table>` : ""}
</body></html>`;

  const dir = mkdtempSync(join(tmpdir(), "shahm-"));
  const page = join(dir, "day.html"), out = join(dir, "day.pdf");
  writeFileSync(page, html);
  execFileSync(chrome, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-pdf-header-footer", "--virtual-time-budget=8000",
    `--print-to-pdf=${out}`, pathToFileURL(page).href], { stdio: "ignore", timeout: 120000 });
  return { name: `حركات-${slug}-${day}.pdf`, data: readFileSync(out), type: "application/pdf" };
}
