// Copies third-party browser files from node_modules into web/vendor so the app works offline
// (no CDN at runtime). Run after `npm install`: npm run vendor
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";

const out = "web/vendor";
mkdirSync(out + "/fonts", { recursive: true });

for (const f of ["firebase-app-compat.js", "firebase-auth-compat.js", "firebase-firestore-compat.js"])
  copyFileSync("node_modules/firebase/" + f, `${out}/${f}`);
copyFileSync("node_modules/jspdf/dist/jspdf.umd.min.js", `${out}/jspdf.umd.min.js`);
copyFileSync("node_modules/@capacitor/core/dist/capacitor.js", `${out}/capacitor.js`);
copyFileSync("node_modules/qrcode-generator/qrcode.js", `${out}/qrcode.js`);

const RANGES = {
  arabic: "U+0600-06FF,U+0750-077F,U+0870-088E,U+0890-0891,U+0897-08E1,U+08E3-08FF,U+200C-200E,U+2010-2011,U+204F,U+2E41,U+FB50-FDFF,U+FE70-FE74,U+FE76-FEFC,U+102E0-102FB,U+10E60-10E7E,U+10EC2-10EC4,U+10EFC-10EFF,U+1EE00-1EEFF",
  latin: "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
};
const fonts = [
  ["IBM Plex Sans Arabic", "ibm-plex-sans-arabic", [400, 500, 600, 700]],
  // Brand fonts (see BRAND.md): Tajawal for headings and amounts, Lalezar only for the shop name.
  ["Tajawal", "tajawal", [500, 700, 800]],
  ["Lalezar", "lalezar", [400]],
];
let css = "";
for (const [family, pkg, weights] of fonts)
  for (const w of weights)
    for (const subset of ["arabic", "latin"]) {
      const file = `${pkg}-${subset}-${w}-normal.woff2`;
      copyFileSync(`node_modules/@fontsource/${pkg}/files/${file}`, `${out}/fonts/${file}`);
      css += `@font-face{font-family:"${family}";font-style:normal;font-display:swap;font-weight:${w};src:url(./${file}) format("woff2");unicode-range:${RANGES[subset]}}\n`;
    }
writeFileSync(`${out}/fonts/fonts.css`, css);
console.log("vendored into", out);
