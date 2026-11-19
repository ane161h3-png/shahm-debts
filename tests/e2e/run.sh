#!/usr/bin/env bash
# Browser tests of the real app on a full local copy: Firebase emulators (auth 9099, firestore 8080) with this repo's
# firestore.rules, the worker under wrangler dev (5077, local D1 + KV), and web/ served on 5075 pointed at both.
# Nothing touches the live project. Needs: tests/node_modules (cd tests && npm i), worker/node_modules (cd worker && npm ci),
# Java (for the emulator), python3, and Playwright's Chromium (CHROME=path, or the one Playwright installed).
#   bash tests/e2e/run.sh                 # every test below
#   bash tests/e2e/run.sh cu eye          # some
set -u
E=$(cd "$(dirname "$0")" && pwd); R=$(cd "$E/../.." && pwd); T="$E/.work"
TESTS=${*:-"posd1 tc cu eye acc stmsg shopall more login-forgot"}
export PW=${PW:-$R/tests/node_modules/playwright/index.mjs}
PIDS=()
stop() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; pkill -P "$p" 2>/dev/null; done; }
trap stop EXIT
rm -rf "$T"; mkdir -p "$T/wk"

cp "$R/firestore.rules" "$T/"
echo '{"firestore":{"rules":"firestore.rules"},"emulators":{"auth":{"port":9099,"host":"127.0.0.1"},"firestore":{"port":8080,"host":"127.0.0.1"},"ui":{"enabled":false}}}' > "$T/firebase.json"
(cd "$T" && exec "$R/tests/node_modules/.bin/firebase" emulators:start --only auth,firestore --project shahm-demo > emu.log 2>&1) & PIDS+=($!)

cp -r "$R/worker/src" "$R/worker/package.json" "$T/wk/"; ln -s "$R/worker/node_modules" "$T/wk/node_modules"
sed -e 's/^FIREBASE_PROJECT = .*/FIREBASE_PROJECT = "shahm-demo"/' -e 's/^FIREBASE_API_KEY = .*/FIREBASE_API_KEY = "k"/' \
  -e '/^\[triggers\]/,$d' "$R/worker/wrangler.toml" > "$T/wk/wrangler.toml"
printf '\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "shahm-db"\ndatabase_id = "local"\n\n[[kv_namespaces]]\nbinding = "BK"\nid = "local"\n' >> "$T/wk/wrangler.toml"
(cd "$T/wk" && exec node_modules/.bin/wrangler dev --local --port 5077 --ip 127.0.0.1 \
  --var AUTH_URL:http://127.0.0.1:9099/identitytoolkit.googleapis.com --var FIRESTORE_URL:http://127.0.0.1:8080 \
  --var BK_SECRET:MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY= > wk.log 2>&1) & PIDS+=($!)

cp -r "$R/web" "$T/site"
cat > "$T/site/config.js" <<'C'
window.FIREBASE_CONFIG={apiKey:"k",authDomain:"x",projectId:"shahm-demo",appId:"x"};
window.FIREBASE_EMULATOR=true;
window.AI_URL="http://127.0.0.1:5077";
C
for f in "$T/site/index.html" "$T/site/pos/index.html" "$T/site/admin/index.html"; do
  sed -i "s#connect-src 'self'#connect-src 'self' http://127.0.0.1:9099 http://127.0.0.1:8080 http://127.0.0.1:5077 ws://127.0.0.1:5077 ws://127.0.0.1:8080#" "$f"
done
(exec python3 -m http.server 5075 --bind 127.0.0.1 -d "$T/site" > "$T/http.log" 2>&1) & PIDS+=($!)

for i in $(seq 1 90); do
  curl -s 127.0.0.1:5077/health >/dev/null && curl -s 127.0.0.1:8080 >/dev/null && curl -s 127.0.0.1:9099 >/dev/null && curl -s 127.0.0.1:5075 >/dev/null && break
  sleep 2
done
cd "$T"
node "$E/seed.mjs" > seed.log 2>&1 || { echo "seed failed"; cat seed.log; exit 1; }
fail=0
for t in $TESTS; do
  timeout 300 node "$E/$t.mjs" > "out-$t.log" 2>&1; rc=$?
  x=$(grep -c "  XX " "out-$t.log"); o=$(grep -c "  ok " "out-$t.log")
  if [ $rc = 0 ] && [ "$x" = 0 ]; then echo "✓ $t ($o checks)"; else echo "✗ $t (rc=$rc, $x failed)"; cat "out-$t.log"; fail=1; fi
done
[ $fail = 0 ] && echo "All browser tests passed." || { echo "--- worker log tail"; tail -40 wk/wk.log; }
exit $fail
