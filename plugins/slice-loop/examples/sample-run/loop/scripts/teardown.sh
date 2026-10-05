#!/usr/bin/env bash
# Stop the server boot.sh started, and anything left listening on the loop port. Safe to run twice.
set -uo pipefail

PORT=${LOOP_PORT:-4319}
STATE=${SLICE_LOOP_SCRATCH:-/tmp/slice-loop}/.boot

if [[ -f "$STATE/server.pid" ]]; then
  pid=$(cat "$STATE/server.pid")
  kill "$pid" 2>/dev/null && echo "teardown: stopped pid $pid"
  rm -f "$STATE/server.pid"
fi

if command -v lsof >/dev/null 2>&1; then
  for pid in $(lsof -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null); do
    kill "$pid" 2>/dev/null && echo "teardown: stopped stray pid $pid on $PORT"
  done
elif command -v fuser >/dev/null 2>&1; then
  fuser -k -TERM "$PORT/tcp" >/dev/null 2>&1 || true
fi

for _ in $(seq 1 20); do
  curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null || exit 0
  sleep 0.25
done
echo "teardown: port $PORT still answering" >&2
exit 1
