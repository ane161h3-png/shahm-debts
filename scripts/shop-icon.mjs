// Draws a shop's app icon (shops/<slug>/icon.png, 1024x1024): its first letter in the brand font on the brand green.
// Run once per shop on a machine with Playwright: node scripts/shop-icon.mjs <slug> <letter>
// A shop with its own logo puts that square PNG at shops/<slug>/icon.png instead.
import fs from "fs";
import path from "path";

const [slug, letter] = process.argv.slice(2);
if (!/^[a-z][a-z0-9]{1,24}$/.test(slug || "") || !letter) { console.error("usage: node scripts/shop-icon.mjs <slug> <letter>"); process.exit(1); }
let chromium;
try { ({ chromium } = await import(process.env.PLAYWRIGHT || "playwright")); } catch (e) { console.error("needs Playwright (npm i -g playwright)"); process.exit(1); }
const font = "data:font/woff2;base64," + fs.readFileSync("node_modules/@fontsource/lalezar/files/lalezar-arabic-400-normal.woff2").toString("base64");
const html = `<!doctype html><html><head><style>@font-face{font-family:L;src:url(${font}) format("woff2")}</style></head><body></body></html>`;
const b = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const p = await b.newPage();
await p.setContent(html);
// Drawn on a canvas so the glyph's own ink box is centred (font line boxes would leave it low).
const png = await p.evaluate(async ch => {
  await document.fonts.load("600px L", ch);
  const c = document.createElement("canvas"); c.width = c.height = 1024;
  const x = c.getContext("2d");
  x.fillStyle = "#0e5a3a"; x.fillRect(0, 0, 1024, 1024);
  x.font = "600px L"; x.fillStyle = "#fff7e8"; x.direction = "rtl";
  const m = x.measureText(ch), w = m.actualBoundingBoxLeft + m.actualBoundingBoxRight, h = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
  const k = Math.min(1, 560 / Math.max(w, h));
  x.setTransform(k, 0, 0, k, 512 - k * (m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2, 512 + k * (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2);
  x.fillText(ch, 0, 0);
  return c.toDataURL("image/png").split(",")[1];
}, letter);
fs.mkdirSync(path.join("shops", slug), { recursive: true });
fs.writeFileSync(path.join("shops", slug, "icon.png"), Buffer.from(png, "base64"));
await b.close();
console.log(`shops/${slug}/icon.png`);
