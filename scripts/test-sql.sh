#!/usr/bin/env bash
# Test supabase/migrations against a throwaway Postgres 16.
#
#   scripts/test-sql.sh            # from anywhere; exit code 0 = all assertions passed
#   KEEP=1 scripts/test-sql.sh     # keep the cluster directory afterwards (it is stopped either way)
#
# Steps: initdb a fresh cluster under $HIVE_PG_TEST_DIR (default /tmp/hive-pg-test) listening on a
# free port (127.0.0.1 + a private unix socket dir), emulate Supabase (roles anon / authenticated /
# service_role, its default grants, publication supabase_realtime), apply every migration TWICE in order
# (re-run safety), run supabase/tests/[0-9][0-9]_*.sql (assertions raise on failure; 40_cleanup.sql runs
# supabase/cleanup-fake-data.sql twice), then race claim_cell, claim_live_cell and try_lock from
# parallel connections.
#
# Postgres refuses to run as root: when invoked as root the cluster is owned by the OS user
# $PG_OS_USER (default: postgres) via runuser/su, while psql connects from the current user over the
# socket with trust auth (the cluster is local, throwaway and never listens beyond 127.0.0.1).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
BASE="${HIVE_PG_TEST_DIR:-/tmp/hive-pg-test}"
DATA="$BASE/data"
SOCK="$BASE/sock"
LOG="$BASE/postgres.log"
DB=hive_test
SU=postgres # database superuser created by initdb

[ -x "$PGBIN/initdb" ] || { echo "Postgres binaries not found in $PGBIN (set PGBIN)" >&2; exit 2; }
PSQL_BIN="$PGBIN/psql"
[ -x "$PSQL_BIN" ] || PSQL_BIN="$(command -v psql)"

if [ "$(id -u)" -eq 0 ]; then
  OSUSER="${PG_OS_USER:-postgres}"
  id "$OSUSER" >/dev/null 2>&1 || { echo "Running as root: Postgres needs a non-root OS user to own the cluster. Create '$OSUSER' or set PG_OS_USER." >&2; exit 2; }
  if command -v runuser >/dev/null 2>&1; then
    as_pg() { runuser -u "$OSUSER" -- "$@"; }
  else
    as_pg() { su -s /bin/sh "$OSUSER" -c "$(printf '%q ' "$@")"; }
  fi
else
  OSUSER="$(id -un)"
  as_pg() { "$@"; }
fi

stop_cluster() {
  if [ -f "$DATA/postmaster.pid" ]; then
    as_pg "$PGBIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true
  fi
}
cleanup() {
  local code=$?
  if [ $code -ne 0 ] && [ -f "$LOG" ]; then
    echo "---- postgres log (tail) ----" >&2
    tail -n 30 "$LOG" >&2 || true
  fi
  stop_cluster
  if [ "${KEEP:-0}" != 1 ]; then rm -rf "$BASE"; fi
  exit $code
}

# a stale cluster from an interrupted run
stop_cluster
rm -rf "$BASE"
mkdir -p "$SOCK"
chmod 700 "$BASE"
[ "$(id -u)" -eq 0 ] && chown -R "$OSUSER" "$BASE"
trap cleanup EXIT

port_in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
PORT=""
for p in $(seq 54329 54429); do
  if ! port_in_use "$p"; then PORT=$p; break; fi
done
[ -n "$PORT" ] || { echo "no free port in 54329-54429" >&2; exit 2; }

as_pg "$PGBIN/initdb" -D "$DATA" -U "$SU" --auth=trust -E UTF8 --locale=C --no-sync >"$BASE/initdb.log" 2>&1 \
  || { cat "$BASE/initdb.log" >&2; exit 1; }
as_pg "$PGBIN/pg_ctl" -D "$DATA" -l "$LOG" -w -t 30 \
  -o "-p $PORT -k $SOCK -c listen_addresses=127.0.0.1 -c wal_level=logical -c fsync=off -c synchronous_commit=off -c full_page_writes=off" \
  start >/dev/null
echo "postgres 16 up on port $PORT (data: $DATA, os user: $OSUSER)"

export PGHOST="$SOCK" PGPORT="$PORT" PGUSER="$SU"
"$PSQL_BIN" -X -q -v ON_ERROR_STOP=1 -d postgres -c "create database $DB" >/dev/null
psql_db() { "$PSQL_BIN" -X -q -v ON_ERROR_STOP=1 -v VERBOSITY=terse -d "$DB" "$@"; }

PASSED=0
run_sql() {
  local f="$1" out
  echo "== ${f#"$ROOT"/}"
  if ! out="$(psql_db -o /dev/null -f "$f" 2>&1)"; then
    echo "$out" >&2
    echo "FAILED in ${f#"$ROOT"/}" >&2
    exit 1
  fi
  local n
  n="$(printf '%s\n' "$out" | grep -c 'NOTICE:  ok - ' || true)"
  PASSED=$((PASSED + n))
  # show warnings / unexpected notices, but not "already exists, skipping" chatter from re-runs
  printf '%s\n' "$out" | grep -v -e 'NOTICE:  ok - ' -e 'already exists, skipping' -e 'does not exist, skipping' | sed '/^$/d' | sed 's/^/   /' || true
  [ "$n" -gt 0 ] && echo "   $n assertions passed"
  return 0
}

run_sql "$ROOT/supabase/tests/00_supabase_emulation.sql"
for m in "$ROOT"/supabase/migrations/*.sql; do run_sql "$m"; done
echo "-- re-running migrations (must be idempotent)"
for m in "$ROOT"/supabase/migrations/*.sql; do run_sql "$m"; done
for t in "$ROOT"/supabase/tests/[0-9][0-9]_*.sql; do
  case "$(basename "$t")" in 00_*) continue ;; esac
  run_sql "$t"
done

# ---------- races from parallel connections: exactly one winner each
race() {
  local what="$1" sql="$2" n=12 i wins
  for i in $(seq 1 $n); do
    psql_db -tA -c "$(printf "$sql" "$i")" >"$BASE/race.$i" 2>&1 &
  done
  wait
  wins="$(cat "$BASE"/race.* | grep -c '^t$' || true)"
  if [ "$wins" != 1 ]; then
    echo "FAIL: $what: $wins winners out of $n" >&2
    cat "$BASE"/race.* >&2
    exit 1
  fi
  rm -f "$BASE"/race.*
  echo "   ok - $what: 1 winner out of $n parallel calls"
  PASSED=$((PASSED + 1))
}
echo "== races"
race "claim_cell on one cell" "select public.claim_cell(40, 40, 'race-%s', now() + interval '10 minutes')"
race "try_lock on one name" "select public.try_lock('race', now() + interval '1 minute') -- caller %s"
# a cell held by a preview launch: every live launch may take it over, but only one gets it
psql_db -c "insert into public.launches (id, mode, state, owner, payload, queen_wallet, mint_pubkey, mint_secret_enc, cell_q, cell_r, lamports, expires_at) values ('race-mock', 'mock', 'reserved', 'o', '{}', 'race-q', 'race-m', 'v1.x.x.x', 41, 41, 0, now() + interval '10 minutes'); select public.claim_cell(41, 41, 'race-mock', now() + interval '10 minutes')" >/dev/null
race "claim_live_cell on a preview launch's cell" "select public.claim_live_cell(41, 41, 'race-live-%s', now() + interval '10 minutes')"

echo "ALL SQL TESTS PASSED ($PASSED assertions)"
