#!/bin/sh
# コンテナの起動スクリプト。
# LITESTREAM_BUCKET が設定されていれば、起動時にバックアップから DB を復元し、
# 実行中は変更を常時バックアップする(無料ホスティングのように再起動でディスクが消える環境向け)。
set -e

export DB_FILE="${DB_FILE:-${DATA_DIR:-/data}/groupchat.db}"
APP="node --disable-warning=ExperimentalWarning src/server.js"
CONFIG="${LITESTREAM_CONFIG:-/app/litestream.yml}"

if [ -z "$LITESTREAM_BUCKET" ]; then
  echo "LITESTREAM_BUCKET が未設定のため、バックアップなしで起動します"
  exec $APP
fi

mkdir -p "$(dirname "$DB_FILE")"
echo "バックアップからデータベースを復元しています…"
if ! litestream restore -config "$CONFIG" -if-db-not-exists -if-replica-exists "$DB_FILE"; then
  echo "[エラー] バックアップ先に接続できません。LITESTREAM_BUCKET / LITESTREAM_ENDPOINT / LITESTREAM_REGION / キーの設定を確認してください" >&2
  exit 1
fi
echo "常時バックアップを有効にして起動します"
exec litestream replicate -config "$CONFIG" -exec "$APP"
