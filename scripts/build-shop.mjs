// Builds the debt book for another shop (a copy sold to a buyer): node scripts/build-shop.mjs shops/<slug>.json <out dir>
// The copy is web/ without the cashier, with the shop's name, its own Firebase project and its own icon
// (shops/<slug>/icon.png, 1024x1024; made by scripts/shop-icon.mjs or the shop's own logo). See shops/README.md.
// Besides the site in <out dir>, it writes <out dir>-assets/ (Android icon + splash) and <out dir>-capacitor.json.
import fs from "fs";
import path from "path";
import sharp from "sharp";

const [file, out] = process.argv.slice(2);
if (!file || !out) { console.error("usage: node scripts/build-shop.mjs shops/<slug>.json <out dir>"); process.exit(1); }
const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
const fail = m => { console.error(`${file}: ${m}`); process.exit(1); };

// Checks: the values go into HTML/JS text, so names may not carry quotes or markup.
const slug = cfg.slug;
if (!/^[a-z][a-z0-9]{1,24}$/.test(slug || "")) fail("slug: 2-25 lowercase letters/digits, starting with a letter");
if (path.basename(file, ".json") !== slug) fail("the file name must be <slug>.json");
const plain = (k, max) => { const v = cfg[k]; if (typeof v !== "string" || !v.trim() || v.length > max || /["'`<>\\]/.test(v)) fail(`${k}: required, up to ${max} characters, no quotes or < >`); return v.trim(); };
const name = plain("name", 40), short = plain("short", 20), letter = plain("letter", 2);
const fb = cfg.firebase || {};
for (const k of ["apiKey", "authDomain", "projectId", "appId"]) if (typeof fb[k] !== "string" || !/^[\w.:\-]+$/.test(fb[k])) fail(`firebase.${k}: copy it from the Firebase web app settings`);
const url = cfg.url || `https://debts-${slug}.pages.dev/`;
if (!/^https:\/\/[a-z0-9.-]+\/$/.test(url)) fail("url: https://host/ with the trailing slash");
const aiUrl = cfg.aiUrl || "";
if (aiUrl && !/^https:\/\/[a-z0-9.-]+\/?$/.test(aiUrl)) fail("aiUrl: https://host");

// 1. Copy web/ without the cashier, the old printable PDF (it carries the Shahm name), any downloaded APKs and the
//    Google Play privacy and account-deletion pages (the in-app link always points at the main site).
const skip = new Set(["pos", "dl", "daily-sheet.pdf", "privacy.html", "delete-account.html"]); // the Play pages belong to the main app
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync("web", out, { recursive: true, filter: src => !skip.has(path.relative("web", src).split(path.sep)[0]) });

// 2. Text: every replacement must hit, so a change in web/index.html can't silently leave the Shahm name in a copy.
function edit(rel, pairs) {
  const p = path.join(out, rel);
  let s = fs.readFileSync(p, "utf8");
  for (const [from, to] of pairs) {
    const n = typeof from === "string" ? s.split(from).length - 1 : (s.match(from) || []).length;
    if (!n) fail(`build: "${from}" not found in ${rel}; update scripts/build-shop.mjs`);
    s = typeof from === "string" ? s.split(from).join(to) : s.replace(from, to);
  }
  fs.writeFileSync(p, s);
}
// The header and login mark: the shop's letter in the brand font, in place of the Shahm «ش» drawing.
const mark = `<svg viewBox="0 0 100 100" aria-hidden="true"><text x="50" y="72" text-anchor="middle" font-family="Lalezar, Tajawal, sans-serif" font-size="74" fill="currentColor">${letter}</text></svg>`;
edit("index.html", [
  ["ماركت الشهم", name],
  ["دفتر ديوني", short],
  ['l:"الشهم"', 'l:"الأخضر"'],
  ["const MULTI=true;", "const MULTI=false;"], // a copy is one shop: no «سجّل محلك», no «المحلات»
  ['const WEB_URL="https://shahm-debts.app/";', `const WEB_URL="${url}";`],
  ['const APK_URL="https://shahm-debts.app/dl/shahm-debts.apk";', `const APK_URL="${url}dl/${slug}.apk";`],
  ['const SHEET_URL=WEB_URL+"daily-sheet.pdf";', 'const SHEET_URL=WEB_URL+"sheet.html";'],
  [/<svg viewBox="1\.0 -81\.5 108\.7 108\.7"[^>]*>[\s\S]*?<\/svg>/g, mark],
]);
edit("sheet.html", [["ماركت الشهم", name]]);
const left = (fs.readFileSync(path.join(out, "index.html"), "utf8").match(/[^\n]{0,40}الشهم[^\n]{0,40}/g) || []);
if (left.length) fail("build: the Shahm name is still in index.html:\n" + left.join("\n"));

const man = JSON.parse(fs.readFileSync(path.join(out, "manifest.webmanifest"), "utf8"));
Object.assign(man, { name: `دفتر ديون ${name}`, short_name: short });
fs.writeFileSync(path.join(out, "manifest.webmanifest"), JSON.stringify(man, null, 2) + "\n");

fs.writeFileSync(path.join(out, "config.js"), `// ${name}: Firebase project keys (public by design; the data is protected by firestore.rules and sign-in).
window.FIREBASE_CONFIG = ${JSON.stringify({ apiKey: fb.apiKey, authDomain: fb.authDomain, projectId: fb.projectId, storageBucket: fb.storageBucket || "", messagingSenderId: fb.messagingSenderId || "", appId: fb.appId }, null, 2)};
window.AI_URL = ${JSON.stringify(aiUrl)};
`);

// 3. Icons for the site, and the Android icon + splash (@capacitor/assets reads icon-only.png and splash*.png).
const iconFile = path.join("shops", slug, "icon.png");
if (!fs.existsSync(iconFile)) fail(`${iconFile} is missing: node scripts/shop-icon.mjs ${slug} ${letter}`);
const icon = sharp(iconFile).resize(1024, 1024, { fit: "cover" });
const buf = await icon.png().toBuffer();
for (const [f, size] of [["icon-192.png", 192], ["icon-512.png", 512], ["maskable-512.png", 512], ["apple-touch-icon.png", 180]])
  await sharp(buf).resize(size, size).png().toFile(path.join(out, "icons", f));
const assets = out.replace(/\/$/, "") + "-assets";
fs.rmSync(assets, { recursive: true, force: true });
fs.mkdirSync(assets, { recursive: true });
await sharp(buf).toFile(path.join(assets, "icon-only.png"));
// Adaptive icon layers: the icon as a rounded tile inside the safe zone, on the brand green.
const fg = await sharp(buf).resize(600, 600).composite([{ input: Buffer.from('<svg width="600" height="600"><rect width="600" height="600" rx="130" fill="#fff"/></svg>'), blend: "dest-in" }]).png().toBuffer();
await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: fg, gravity: "center" }]).png().toFile(path.join(assets, "icon-foreground.png"));
await sharp({ create: { width: 1024, height: 1024, channels: 4, background: "#0e5a3a" } }).png().toFile(path.join(assets, "icon-background.png"));
const tile = await sharp(buf).resize(640, 640).composite([{ input: Buffer.from('<svg width="640" height="640"><rect width="640" height="640" rx="140" fill="#fff"/></svg>'), blend: "dest-in" }]).png().toBuffer();
for (const [f, bg] of [["splash.png", "#f4f2ec"], ["splash-dark.png", "#0f1512"]])
  await sharp({ create: { width: 2732, height: 2732, channels: 4, background: bg } }).composite([{ input: tile, gravity: "center" }]).png().toFile(path.join(assets, f));

// 4. The Android app: its own package, name and start page (the live site, like the Shahm apps).
const appId = cfg.appId || `com.shahm.shop.${slug}`;
fs.writeFileSync(out.replace(/\/$/, "") + "-capacitor.json", JSON.stringify({
  appId, appName: short, webDir: out.replace(/\/$/, ""),
  server: { url, errorPath: "index.html" }, android: { adjustMarginsForEdgeToEdge: "force" },
}) + "\n");
console.log(`${slug}: ${name} → ${url} (Firebase ${fb.projectId}, app ${appId})`);
