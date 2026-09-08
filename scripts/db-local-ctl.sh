#!/usr/bin/env bash
# Start/stop/status the local dev Postgres cluster (Homebrew postgresql@17).
#
# Runs on port 5544, NOT 5432: this Mac already has EDB PostgreSQL 15/16/17
# servers on 5432-5434 as the system `postgres` user. A dedicated port means the
# dev database can never collide with those or need their password.
#
# LC_ALL is load-bearing on macOS: without a valid locale the postmaster dies
# with "postmaster became multithreaded during startup".
set -euo pipefail
export LC_ALL=${LC_ALL:-en_US.UTF-8} LANG=${LANG:-en_US.UTF-8}
DATA=/opt/homebrew/var/postgresql@17
LOG=/opt/homebrew/var/log/postgresql@17.log
PORT=5544

case "${1:-status}" in
  start)
    pg_ctl -D "$DATA" -l "$LOG" status >/dev/null 2>&1 && { echo "already running"; exit 0; }
    mkdir -p "$(dirname "$LOG")"
    pg_ctl -D "$DATA" -l "$LOG" start
    sleep 3
    psql -w -h 127.0.0.1 -p "$PORT" -d postgres -tAc 'select version()' | head -1
    ;;
  stop)   pg_ctl -D "$DATA" stop ;;
  status)
    pg_ctl -D "$DATA" status || true
    psql -w -h 127.0.0.1 -p "$PORT" -d storemink_local -tAc \
      "select 'storemink_local: '||(select count(*) from information_schema.tables where table_schema='public')||' public tables'" 2>/dev/null \
      || echo "storemink_local not reachable (run: npm run db:local:sync)"
    ;;
  psql)   shift; exec psql -w -h 127.0.0.1 -p "$PORT" -d storemink_local "$@" ;;
  *) echo "usage: $0 {start|stop|status|psql}"; exit 1 ;;
esac
