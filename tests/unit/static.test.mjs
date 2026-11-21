// Checks without a browser: every inline <script> in the pages parses, the service worker parses, CACHE has the
// shahm-vN shape, the CSP lets the pages reach the worker, and the backup counter reads a D1 dump right.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { countDump } from "../../scripts/d1-count.mjs";

const R = new URL("../../", import.meta.url);
const read = p => readFileSync(new URL(p, R), "utf8");

for (const page of ["web/index.html", "web/pos/index.html", "web/admin/index.html", "web/s.html"]) {
  test(`${page}: inline scripts parse`, () => {
    const html = read(page);
    const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    assert.ok(scripts.length > 0);
    scripts.forEach((code, i) => assert.doesNotThrow(() => new vm.Script(code), `script #${i}`));
  });
}

test("service worker parses and CACHE looks right", () => {
  const sw = read("web/sw.js");
  assert.doesNotThrow(() => new vm.Script(sw));
  assert.match(sw, /const CACHE = "shahm-v\d+";/);
});

test("CSP of the debt book allows the live worker (https + wss)", () => {
  const csp = /Content-Security-Policy" content="([^"]+)"/.exec(read("web/index.html"))[1];
  assert.match(csp, /connect-src[^;]*https:\/\/shahm-ai\.hydrzyd83\.workers\.dev/);
  assert.match(csp, /connect-src[^;]*wss:\/\/shahm-ai\.hydrzyd83\.workers\.dev/);
});

test("d1-count reads a dump: tables, live records, books", () => {
  const sql = [
    "PRAGMA defer_foreign_keys=TRUE;",
    "CREATE TABLE docs (t TEXT NOT NULL, c TEXT NOT NULL, id TEXT NOT NULL, d TEXT, u INTEGER NOT NULL, del INTEGER NOT NULL DEFAULT 0, by TEXT, PRIMARY KEY (t, c, id)) WITHOUT ROWID;",
    `INSERT INTO "docs" ("t","c","id","d","u","del","by") VALUES('main','customers','c1','{"id":"c1","name":"O''Neil","note":"a'','',9,1,''b"}',1,0,'u1');`,
    `INSERT INTO "docs" ("t","c","id","d","u","del","by") VALUES('main','txns','t1','{"id":"t1"}',2,0,NULL);`,
    `INSERT INTO "docs" ("t","c","id","d","u","del","by") VALUES('shopA','txns','t2','{"id":"t2"}',3,1,'u2');`,
    `INSERT INTO "docs" ("t","c","id","d","u","del","by") VALUES('shopA','customers','c2',NULL,4,1,'u2');`,
    `INSERT INTO "ctr" ("t","u") VALUES('main',2);`,
  ].join("\n");
  assert.deepEqual(countDump(sql), { tables: { docs: 4, ctr: 1 }, customers: 1, txns: 1, books: 2 });
});
