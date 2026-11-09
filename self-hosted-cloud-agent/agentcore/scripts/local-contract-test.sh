#!/usr/bin/env bash
# Check the adapter against the AgentCore container contract, locally, with no AWS resources.
#
# What it asserts:
#   1. GET /ping answers 200 quickly, before and while the worker is starting.
#   2. The status field is exactly "Healthy" or "HealthyBusy" — no other value is accepted by
#      the service.
#   3. time_of_last_update does NOT advance between pings when the status has not changed. A
#      timestamp that moves on every ping stops the idle timeout from ever firing, so sessions
#      live until MaxLifetime and can exhaust the session quota.
#   4. POST /invocations returns the worker status.
#
# With a real Cursor service account key in CURSOR_API_KEY it also waits for the status to
# reach HealthyBusy, which is what keeps a long-lived session alive. Without a key the worker
# cannot register, so the run stops after the shape checks.
#
# Usage:
#   scripts/local-contract-test.sh
#
# Environment:
#   WORKER_IMAGE             image to test (default cursor-agentcore-worker:local)
#   AGENTCORE_TEST_PORT      host port to publish (default 8080)
#   CURSOR_API_KEY           optional; enables the HealthyBusy check
#   WORKER_REPOSITORY_URL    optional; git remote for the workspace
#   CONTAINER_CLI            docker or finch binary (default: auto-detect)
set -euo pipefail

WORKER_IMAGE="${WORKER_IMAGE:-cursor-agentcore-worker:local}"
PORT="${AGENTCORE_TEST_PORT:-8080}"
CONTAINER_NAME="cursor-agentcore-contract-test"
BASE_URL="http://127.0.0.1:${PORT}"
CONTAINER_CLI="${CONTAINER_CLI:-}"

if [[ -z "${CONTAINER_CLI}" ]]; then
  if command -v docker >/dev/null 2>&1; then
    CONTAINER_CLI="$(command -v docker)"
  elif command -v finch >/dev/null 2>&1; then
    CONTAINER_CLI="$(command -v finch)"
  elif [[ -x /usr/local/bin/finch ]]; then
    CONTAINER_CLI="/usr/local/bin/finch"
  else
    echo "docker or finch is required but not installed." >&2
    exit 1
  fi
fi

for tool in curl python3; do
  if ! command -v "${tool}" >/dev/null 2>&1; then
    echo "${tool} is required but not installed." >&2
    exit 1
  fi
done

if ! "${CONTAINER_CLI}" image inspect "${WORKER_IMAGE}" >/dev/null 2>&1; then
  echo "Image ${WORKER_IMAGE} not found. Build it first: make agentcore-docker-build" >&2
  exit 1
fi

cleanup() {
  "${CONTAINER_CLI}" rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  echo
  echo "--- container logs ---" >&2
  "${CONTAINER_CLI}" logs "${CONTAINER_NAME}" 2>&1 | tail -40 >&2
  exit 1
}

# Reads one JSON field from stdin without depending on jq being installed on the host.
json_field() {
  python3 -c 'import json,sys; print(json.load(sys.stdin).get(sys.argv[1], ""))' "$1"
}

cleanup

echo "Starting ${WORKER_IMAGE} as ${CONTAINER_NAME} on port ${PORT}."
"${CONTAINER_CLI}" run --detach \
  --name "${CONTAINER_NAME}" \
  --publish "${PORT}:8080" \
  --env "CURSOR_API_KEY=${CURSOR_API_KEY:-local-contract-test-placeholder}" \
  --env "CURSOR_WORKER_POOL_NAME=${CURSOR_WORKER_POOL_NAME:-agentcore-contract-test}" \
  --env "WORKER_REPOSITORY_URL=${WORKER_REPOSITORY_URL:-}" \
  --env "AGENTCORE_WORKER_MAX_RESTARTS=0" \
  "${WORKER_IMAGE}" >/dev/null

# 1. /ping must answer almost immediately. The adapter starts the HTTP server before the
#    worker for exactly this reason: a blocked ping thread is the documented cause of sessions
#    dying at the 15-minute mark.
echo -n "1. GET /ping answers: "
ping_body=""
for _ in $(seq 1 30); do
  if ping_body="$(curl -fsS --max-time 2 "${BASE_URL}/ping" 2>/dev/null)"; then
    break
  fi
  ping_body=""
  sleep 1
done
[[ -n "${ping_body}" ]] || fail "/ping did not return 200 within 30 seconds"
echo "ok"

# 2. The status string is a closed set.
echo -n "2. Status is Healthy or HealthyBusy: "
status="$(printf '%s' "${ping_body}" | json_field status)"
case "${status}" in
  Healthy | HealthyBusy) echo "ok (${status})" ;;
  *) fail "status was '${status}', expected exactly Healthy or HealthyBusy" ;;
esac

# 3. time_of_last_update must be stable while the status is unchanged.
echo -n "3. time_of_last_update is stable across pings: "
first_status="${status}"
first_stamp="$(printf '%s' "${ping_body}" | json_field time_of_last_update)"
[[ -n "${first_stamp}" ]] || fail "/ping response has no time_of_last_update field"
sleep 3
second_body="$(curl -fsS --max-time 2 "${BASE_URL}/ping")"
second_status="$(printf '%s' "${second_body}" | json_field status)"
second_stamp="$(printf '%s' "${second_body}" | json_field time_of_last_update)"

if [[ "${first_status}" == "${second_status}" && "${first_stamp}" != "${second_stamp}" ]]; then
  fail "status stayed ${first_status} but time_of_last_update moved ${first_stamp} -> ${second_stamp}"
fi
echo "ok"

# 4. /invocations is the operator-facing control plane for a session.
echo -n "4. POST /invocations returns status: "
invoke_body="$(curl -fsS --max-time 5 \
  -H 'Content-Type: application/json' \
  -H 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: cursor-worker-local-contract-test-000000' \
  -d '{"action":"status"}' \
  "${BASE_URL}/invocations")"
invoke_status="$(printf '%s' "${invoke_body}" | json_field status)"
[[ -n "${invoke_status}" ]] || fail "/invocations response has no status field: ${invoke_body}"
echo "ok (${invoke_status})"

# 5. HealthyBusy is the keepalive. Only reachable with a real service account key.
if [[ -z "${CURSOR_API_KEY:-}" ]]; then
  echo
  echo "Contract shape checks passed."
  echo "Set CURSOR_API_KEY to a Cursor service account key to also verify that the worker"
  echo "registers and the status reaches HealthyBusy."
  exit 0
fi

echo -n "5. Status reaches HealthyBusy: "
for _ in $(seq 1 60); do
  status="$(curl -fsS --max-time 2 "${BASE_URL}/ping" | json_field status)"
  if [[ "${status}" == "HealthyBusy" ]]; then
    echo "ok"
    echo
    echo "All contract checks passed."
    exit 0
  fi
  sleep 2
done

fail "status never reached HealthyBusy; the worker did not register with Cursor"
