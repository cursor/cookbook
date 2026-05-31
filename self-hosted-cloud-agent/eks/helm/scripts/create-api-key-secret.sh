#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${CURSOR_API_KEY:-}" ]]; then
  echo "CURSOR_API_KEY must be set to a Cursor service account API key." >&2
  exit 1
fi

NAMESPACE="${K8S_NAMESPACE:-cursord}"
SECRET_NAME="${CURSOR_API_KEY_SECRET_NAME:-my-workers-api-key}"
WORKER_DEPLOYMENT_NAME="${WORKER_DEPLOYMENT_NAME:-my-workers}"

if ! kubectl get namespace "${NAMESPACE}" >/dev/null 2>&1; then
  kubectl create namespace "${NAMESPACE}"
fi

kubectl create secret generic "${SECRET_NAME}" \
  --from-literal=api-key="${CURSOR_API_KEY}" \
  --namespace "${NAMESPACE}" \
  --dry-run=client \
  -o yaml | kubectl apply -f -

kubectl label secret "${SECRET_NAME}" \
  --namespace "${NAMESPACE}" \
  "workers.cursor.com/worker-deployment=${WORKER_DEPLOYMENT_NAME}" \
  --overwrite
