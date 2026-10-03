#!/usr/bin/env bash
# ローカル PostgreSQL（16 以上）でマイグレーションと RLS シナリオテストを実行する
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
WORK="$(mktemp -d /var/tmp/cocos-pg.XXXX)"
RUN=""; [ "$(id -u)" = 0 ] && { chown postgres "$WORK"; RUN="su postgres -c"; }
run() { if [ -n "$RUN" ]; then $RUN "$*"; else bash -c "$*"; fi; }
cleanup() { run "$PGBIN/pg_ctl -D $WORK/data -m immediate stop" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
run "$PGBIN/initdb -D $WORK/data -A trust -E UTF8 --locale=C.UTF-8" >/dev/null
run "$PGBIN/pg_ctl -D $WORK/data -o '-p 54329 -k $WORK' -l $WORK/pg.log -w start" >/dev/null
PSQL="psql -X -q -h $WORK -p 54329 -U postgres -v ON_ERROR_STOP=1"
$PSQL -c 'create database cocos_test' >/dev/null
$PSQL -d cocos_test -f "$ROOT/supabase/tests/supabase_stub.sql" >/dev/null
for f in "$ROOT"/supabase/migrations/*.sql; do $PSQL -d cocos_test -f "$f" >/dev/null; done
# クエリ結果は捨て、NOTICE（ok/FAIL）だけを表示する
$PSQL -d cocos_test -o /dev/null -f "$ROOT/supabase/tests/rls_scenarios.sql" 2>&1 | sed 's/^psql:[^ ]* NOTICE:  //'
exit "${PIPESTATUS[0]}"
