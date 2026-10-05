#!/usr/bin/env bash
# Start tasks-app on the loop's fixed port and wait for health. Idempotent.
#   SEED=0 boot.sh   # boot with an empty task list
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
PORT=${LOOP_PORT:-4319}
HEALTH="http://127.0.0.1:$PORT/api/tasks"
STATE=${SLICE_LOOP_SCRATCH:-/tmp/slice-loop}/.boot
TIMEOUT=${BOOT_TIMEOUT_S:-30}
mkdir -p "$STATE"

if [[ -f "$STATE/server.pid" ]] && kill -0 "$(cat "$STATE/server.pid")" 2>/dev/null \
  && curl -fsS -o /dev/null "$HEALTH"; then
  echo "boot: already running (pid $(cat "$STATE/server.pid")) on $PORT"
  exit 0
fi

if curl -fsS -o /dev/null "$HEALTH" 2>/dev/null; then
  echo "boot: port $PORT is served by an unknown process; run teardown.sh first" >&2
  exit 1
fi

cd "$ROOT"
PORT=$PORT nohup node server.js > "$STATE/server.log" 2>&1 &
echo $! > "$STATE/server.pid"

for ((i = 0; i < TIMEOUT * 4; i++)); do
  if curl -fsS -o /dev/null "$HEALTH" 2>/dev/null; then
    echo "boot: up (pid $(cat "$STATE/server.pid")) at http://127.0.0.1:$PORT"
    exit 0
  fi
  kill -0 "$(cat "$STATE/server.pid")" 2>/dev/null || break
  sleep 0.25
done

echo "boot: server did not become healthy; last log lines:" >&2
tail -n 20 "$STATE/server.log" >&2 || true
exit 1
