#!/usr/bin/env bash
# Puts a D1 backup (the daily shahm-db-YYYY-MM-DD.sql.gz from Telegram) into a database and checks every table's row count
# against the file. By default into a NEW database (shahm-db-restore-<time>), so the live one is never touched: look at it,
# then switch (MAINTENANCE.md). Into the name shahm-db only when that database is missing or empty (after a loss).
#   scripts/d1-restore.sh shahm-db-2026-11-19.sql.gz                 # new database on Cloudflare
#   scripts/d1-restore.sh shahm-db-2026-11-19.sql.gz --name shahm-db # rebuild a lost shahm-db
#   scripts/d1-restore.sh shahm-db-2026-11-19.sql.gz --local DIR     # into a local copy (a drill, no account needed)
# Env (Cloudflare): CLOUDFLARE_API_TOKEN (D1 edit). For a small mistake in the last 7 days (30 on Workers Paid) prefer Time Travel:
#   npx wrangler d1 time-travel restore shahm-db --timestamp=2026-11-19T10:00:00+03:00
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
W=${WRANGLER:-npx --yes wrangler@4}
SRC=${1:?"usage: scripts/d1-restore.sh <dump.sql[.gz]> [--name NAME] [--local DIR]"}; shift
NAME="shahm-db-restore-$(date +%Y%m%d-%H%M)"; LOCAL=""
while [ $# -gt 0 ]; do case "$1" in
  --name) NAME=$2; shift 2;;
  --local) LOCAL=$2; shift 2;;
  *) echo "unknown option $1"; exit 2;;
esac; done

WORK=$(mktemp -d); SQL="$WORK/dump.sql"
case "$SRC" in *.gz) gunzip -c "$SRC" > "$SQL";; *) cp "$SRC" "$SQL";; esac
WANT=$(node "$ROOT/scripts/d1-count.mjs" "$SQL")
echo "الملف: $WANT"

if [ -n "$LOCAL" ]; then
  mkdir -p "$LOCAL"; CFG="$LOCAL"; FLAG="--local"
  # A drill directory already used keeps its database: name it from there (and refuse it below if it holds data).
  [ -f "$CFG/wrangler.toml" ] && NAME=$(grep -m1 database_name "$CFG/wrangler.toml" | cut -d'"' -f2)
  [ -f "$CFG/wrangler.toml" ] || printf 'name = "d1-restore"\n\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "%s"\ndatabase_id = "local-restore"\n' "$NAME" > "$CFG/wrangler.toml"
else
  : "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN (Cloudflare token with D1 edit)}"
  export CLOUDFLARE_ACCOUNT_ID=${CLOUDFLARE_ACCOUNT_ID:-$(grep -m1 '^account_id' "$ROOT/worker/wrangler.toml" | cut -d'"' -f2)}
  FLAG="--remote"
  id=$($W d1 list --json | jq -r --arg n "$NAME" '.[] | select(.name == $n) | .uuid' | head -n1)
  if [ -z "$id" ]; then
    $W d1 create "$NAME" >/dev/null
    id=$($W d1 list --json | jq -r --arg n "$NAME" '.[] | select(.name == $n) | .uuid' | head -n1)
  fi
  CFG="$WORK/cfg"; mkdir -p "$CFG"
  printf 'name = "d1-restore"\naccount_id = "%s"\n\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "%s"\ndatabase_id = "%s"\n' "$CLOUDFLARE_ACCOUNT_ID" "$NAME" "$id" > "$CFG/wrangler.toml"
fi

# Never pour a backup over data: the target must have no records yet.
have=$(cd "$CFG" && $W d1 execute "$NAME" $FLAG --json --command "SELECT name FROM sqlite_master WHERE type='table' AND name='docs'" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s)[0].results.length)}catch(e){console.log(0)}})')
if [ "$have" != "0" ]; then echo "القاعدة $NAME بيها بيانات. اختار اسم جديد (--name) حتى ما تنكتب فوقها."; exit 1; fi

(cd "$CFG" && $W d1 execute "$NAME" $FLAG --file "$SQL" -y) >/dev/null

# Check: every table in the file has the same number of rows in the database.
TABLES=$(node -e 'console.log(Object.keys(JSON.parse(process.argv[1]).tables).join(" "))' "$WANT")
bad=0
for t in $TABLES; do
  want=$(node -e 'console.log(JSON.parse(process.argv[1]).tables[process.argv[2]])' "$WANT" "$t")
  got=$(cd "$CFG" && $W d1 execute "$NAME" $FLAG --json --command "SELECT COUNT(*) AS n FROM \"$t\"" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0].results[0].n))')
  if [ "$want" = "$got" ]; then echo "✓ $t: $got"; else echo "✗ $t: الملف $want، القاعدة $got"; bad=1; fi
done
live=$(cd "$CFG" && $W d1 execute "$NAME" $FLAG --json --command "SELECT c, COUNT(*) AS n FROM docs WHERE del = 0 GROUP BY c" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0].results.map(r=>r.c+"="+r.n).join(" ")))')
echo "السجلات الحية: $live"
[ $bad = 0 ] && echo "تم الاسترجاع لـ $NAME ومطابق للملف." || { echo "الاسترجاع ما طابق الملف."; exit 1; }
