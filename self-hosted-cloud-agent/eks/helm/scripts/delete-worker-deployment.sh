#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="${K8S_NAMESPACE:-cursord}"
DEPLOYMENT_NAME="${WORKER_DEPLOYMENT_NAME:-my-workers}"
LABELS_CONFIG_MAP="${K8S_WORKER_LABELS_CONFIG_MAP:-cursor-worker-labels}"

kubectl delete workerdeployment.workers.cursor.com "${DEPLOYMENT_NAME}" \
  --namespace "${NAMESPACE}" \
  --ignore-not-found

kubectl delete configmap "${LABELS_CONFIG_MAP}" \
  --namespace "${NAMESPACE}" \
  --ignore-not-found
