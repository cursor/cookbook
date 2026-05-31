#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="${K8S_NAMESPACE:-cursord}"
LABELS_CONFIG_MAP="${K8S_WORKER_LABELS_CONFIG_MAP:-cursor-worker-labels}"
LABELS_FILE="${K8S_WORKER_LABELS_FILE:-config/labels.json}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../../.." && pwd)"

if [[ "${LABELS_FILE}" != /* ]]; then
  LABELS_FILE="${REPO_ROOT}/${LABELS_FILE}"
fi

if [[ ! -f "${LABELS_FILE}" && "${LABELS_FILE}" == "${REPO_ROOT}/helm/"* ]]; then
  LABELS_FILE="${REPO_ROOT}/eks/${LABELS_FILE#"${REPO_ROOT}/"}"
fi

if [[ ! -f "${LABELS_FILE}" ]]; then
  echo "K8S_WORKER_LABELS_FILE does not exist: ${LABELS_FILE}" >&2
  exit 1
fi

if ! kubectl get namespace "${NAMESPACE}" >/dev/null 2>&1; then
  kubectl create namespace "${NAMESPACE}"
fi

kubectl create configmap "${LABELS_CONFIG_MAP}" \
  --from-file=labels.json="${LABELS_FILE}" \
  --namespace "${NAMESPACE}" \
  --dry-run=client \
  -o yaml | kubectl apply -f -

"${SCRIPT_DIR}/render-worker-deployment.sh" | kubectl apply -f -
