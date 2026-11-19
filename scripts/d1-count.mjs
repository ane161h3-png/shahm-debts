// Row counts in a D1 SQL dump (wrangler d1 export), so a backup and a restore can be checked against each other.
//   node scripts/d1-count.mjs dump.sql          → {"tables": {"docs": 4630, ...}, "customers": 399, "txns": 4178, "books": 3}
// customers/txns count live records (not marked deleted) across all books; books = distinct book ids.
import { readFileSync } from "node:fs";

export function countDump(sql) {
  const tables = {}, books = new Set();
  let customers = 0, txns = 0;
  const docRe = /^INSERT INTO "docs" \("t","c","id","d","u","del","by"\) VALUES\('((?:[^']|'')*)','((?:[^']|'')*)','(?:[^']|'')*',(?:'(?:[^']|'')*'|NULL),-?\d+,(\d+),/;
  for (const line of sql.split("\n")) {
    const m = /^INSERT INTO "?([A-Za-z_][A-Za-z0-9_]*)"?/.exec(line);
    if (!m) continue;
    tables[m[1]] = (tables[m[1]] || 0) + 1;
    if (m[1] !== "docs") continue;
    const d = docRe.exec(line);
    if (!d) continue;
    books.add(d[1]);
    if (d[3] === "0") { if (d[2] === "customers") customers++; else if (d[2] === "txns") txns++; }
  }
  return { tables, customers, txns, books: books.size };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (!file) { console.error("usage: node scripts/d1-count.mjs dump.sql"); process.exit(2); }
  console.log(JSON.stringify(countDump(readFileSync(file, "utf8"))));
}
