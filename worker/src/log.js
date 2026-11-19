// One JSON line per event, so Cloudflare's Workers Logs (wrangler.toml [observability]) can filter by level and event:
//   log("error", "db.failed", { path: "/db/push", err })  →  {"level":"error","event":"db.failed","path":"/db/push","err":"…","stack":"…"}
// People are named by uid, never by e-mail or phone; error stacks stay in the log, never in a response.
export function log(level, event, fields = {}) {
  const out = { level, event };
  for (const [k, v] of Object.entries(fields)) {
    if (v instanceof Error) { out[k] = String(v.message || v).slice(0, 500); if (v.stack) out.stack = String(v.stack).slice(0, 1500); }
    else out[k] = v;
  }
  const line = JSON.stringify(out);
  if (level === "error") console.error(line); else if (level === "warn") console.warn(line); else console.log(line);
}
