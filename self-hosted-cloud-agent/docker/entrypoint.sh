#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${CURSOR_API_KEY:-}" ]]; then
  echo "CURSOR_API_KEY must be set to a Cursor service account API key." >&2
  exit 1
fi

WORKER_DIR="${CURSOR_WORKER_DIR:-/workspace}"
POOL_NAME="${CURSOR_WORKER_POOL_NAME:-lab}"
IDLE_TIMEOUT="${CURSOR_WORKER_IDLE_RELEASE_TIMEOUT:-600}"
LABELS_FILE="${CURSOR_WORKER_LABELS_FILE:-/etc/cursor/labels.json}"

mkdir -p "${WORKER_DIR}"

if [[ ! -d "${WORKER_DIR}/.git" && -n "${WORKER_REPOSITORY_URL:-}" ]]; then
  git -C "${WORKER_DIR}" init --initial-branch=main >/dev/null
  git -C "${WORKER_DIR}" remote add origin "${WORKER_REPOSITORY_URL}"
fi

if [[ -n "${CURSOR_WORKER_LABELS_JSON:-}" ]]; then
  LABELS_FILE="/tmp/cursor-worker-labels.json"
  printf '%s\n' "${CURSOR_WORKER_LABELS_JSON}" >"${LABELS_FILE}"
fi

args=(
  worker
  --pool
  --pool-name "${POOL_NAME}"
  --worker-dir "${WORKER_DIR}"
  --idle-release-timeout "${IDLE_TIMEOUT}"
)

if [[ -f "${LABELS_FILE}" ]]; then
  args+=(--labels-file "${LABELS_FILE}")
fi

if [[ -n "${CURSOR_WORKER_MANAGEMENT_ADDR:-}" ]]; then
  args+=(--management-addr "${CURSOR_WORKER_MANAGEMENT_ADDR}")
fi

args+=(start)

exec agent "${args[@]}"
