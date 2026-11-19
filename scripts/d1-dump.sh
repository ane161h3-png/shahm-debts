#!/usr/bin/env bash
# Daily full copy of the Cloudflare D1 database (shahm-db: every book's accounts and transactions, statement links,
# support chat) as one gzipped SQL file, sent to the Telegram backup chat with its row counts. Off Cloudflare, so a lost
# account or database still has yesterday's copy. Restore: scripts/d1-restore.sh (see MAINTENANCE.md).
# Runs from .github/workflows/backup.yml. Env: CLOUDFLARE_API_TOKEN, TELEGRAM_TOKEN, TELEGRAM_CHAT_ID.
# Testing: D1_LOCAL_DIR=<dir with a wrangler.toml and .wrangler state> exports that local copy; TELEGRAM_URL points elsewhere.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DB=${D1_NAME:-shahm-db}
TG=${TELEGRAM_URL:-https://api.telegram.org}
W=${WRANGLER:-npx --yes wrangler@4}
STAMP=$(TZ=Asia/Baghdad date +%Y-%m-%d)
OUT=$(mktemp -d)
FILE="$OUT/shahm-db-$STAMP.sql"

alert() {
  curl -sS -m 30 -X POST "$TG/bot$TELEGRAM_TOKEN/sendMessage" --data-urlencode "chat_id=$TELEGRAM_CHAT_ID" \
    --data-urlencode "text=⚠️ نسخة قاعدة Cloudflare (D1) ليوم $STAMP فشلت: $1. النسخة اليومية الثانية وصلت بشكل طبيعي. شوف تشغيل Daily backup بـ GitHub Actions." >/dev/null || true
}
trap 'alert "خطأ بالسطر $LINENO"' ERR

if [ -n "${D1_LOCAL_DIR:-}" ]; then
  (cd "$D1_LOCAL_DIR" && $W d1 export "$DB" --local --output "$FILE") >/dev/null
else
  : "${CLOUDFLARE_API_TOKEN:?missing}"
  export CLOUDFLARE_ACCOUNT_ID=${CLOUDFLARE_ACCOUNT_ID:-$(grep -m1 '^account_id' "$ROOT/worker/wrangler.toml" | cut -d'"' -f2)}
  id=$($W d1 list --json 2>/dev/null | jq -r --arg n "$DB" '.[] | select(.name == $n) | .uuid' | head -n1)
  [ -n "$id" ] || { alert "ما لگيت قاعدة $DB بحساب Cloudflare"; exit 1; }
  CFG=$(mktemp -d)
  printf 'name = "d1-dump"\naccount_id = "%s"\n\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "%s"\ndatabase_id = "%s"\n' "$CLOUDFLARE_ACCOUNT_ID" "$DB" "$id" > "$CFG/wrangler.toml"
  (cd "$CFG" && $W d1 export "$DB" --remote --output "$FILE") >/dev/null
fi

[ -s "$FILE" ] || { alert "الملف طلع فارغ"; exit 1; }
COUNTS=$(node "$ROOT/scripts/d1-count.mjs" "$FILE")
read -r C T B ROWS < <(node -e 'const j=JSON.parse(process.argv[1]);console.log(j.customers,j.txns,j.books,Object.values(j.tables).reduce((a,b)=>a+b,0))' "$COUNTS")
[ "$ROWS" -gt 0 ] || { alert "الملف ما بيه ولا سجل"; exit 1; }
SHA=$(sha256sum "$FILE" | cut -c1-16)
gzip -9 "$FILE"
CAPTION="🗄️ نسخة قاعدة Cloudflare (D1) — $STAMP
الدفاتر: $B · الزبائن: $C · الحركات: $T · كل السجلات: $ROWS
بصمة الملف: $SHA
الاسترجاع: scripts/d1-restore.sh (دليل الصيانة)"
curl -sS -f -m 120 -X POST "$TG/bot$TELEGRAM_TOKEN/sendDocument" -F "chat_id=$TELEGRAM_CHAT_ID" \
  --form-string "caption=$CAPTION" -F "disable_notification=true" -F "document=@$FILE.gz" >/dev/null
echo "D1 dump sent: books=$B customers=$C txns=$T rows=$ROWS ($(du -h "$FILE.gz" | cut -f1))"
echo "$COUNTS" > "$OUT/counts.json"
