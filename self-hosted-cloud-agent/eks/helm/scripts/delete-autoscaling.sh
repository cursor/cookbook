#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="${K8S_NAMESPACE:-cursord}"
DEPLOYMENT_NAME="${WORKER_DEPLOYMENT_NAME:-my-workers}"
METRICS_SERVICE_NAME="${K8S_WORKER_METRICS_SERVICE_NAME:-cursor-worker-metrics}"
SCALER_NAME="${WORKER_AUTOSCALER_NAME:-cursor-worker-metrics-scaler}"

kubectl delete cronjob "${SCALER_NAME}" \
  --namespace "${NAMESPACE}" \
  --ignore-not-found

kubectl delete configmap "${SCALER_NAME}" \
  --namespace "${NAMESPACE}" \
  --ignore-not-found

kubectl delete rolebinding "${SCALER_NAME}" \
  --namespace "${NAMESPACE}" \
  --ignore-not-found

kubectl delete role "${SCALER_NAME}" \
  --namespace "${NAMESPACE}" \
  --ignore-not-found

kubectl delete serviceaccount "${SCALER_NAME}" \
  --namespace "${NAMESPACE}" \
  --ignore-not-found

kubectl delete scaledobject.keda.sh "${DEPLOYMENT_NAME}-cursor-utilization" \
  --namespace "${NAMESPACE}" \
  --ignore-not-found 2>/dev/null || true

kubectl delete service "${METRICS_SERVICE_NAME}" \
  --namespace "${NAMESPACE}" \
  --ignore-not-found
