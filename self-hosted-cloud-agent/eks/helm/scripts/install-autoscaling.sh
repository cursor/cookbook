#!/usr/bin/env bash
set -euo pipefail

PROMETHEUS_NAMESPACE="${PROMETHEUS_NAMESPACE:-prometheus}"
PROMETHEUS_RELEASE_NAME="${PROMETHEUS_RELEASE_NAME:-prometheus}"
NAMESPACE="${K8S_NAMESPACE:-cursord}"
DEPLOYMENT_NAME="${WORKER_DEPLOYMENT_NAME:-my-workers}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

helm repo add prometheus-community https://prometheus-community.github.io/helm-charts >/dev/null
helm repo update >/dev/null

helm upgrade --install "${PROMETHEUS_RELEASE_NAME}" prometheus-community/prometheus \
  --namespace "${PROMETHEUS_NAMESPACE}" \
  --create-namespace \
  --set alertmanager.enabled=false \
  --set prometheus-pushgateway.enabled=false \
  --set server.persistentVolume.enabled=false

kubectl rollout status "deployment/${PROMETHEUS_RELEASE_NAME}-server" \
  --namespace "${PROMETHEUS_NAMESPACE}" \
  --timeout=180s

kubectl delete scaledobject.keda.sh "${DEPLOYMENT_NAME}-cursor-utilization" \
  --namespace "${NAMESPACE}" \
  --ignore-not-found 2>/dev/null || true

"${SCRIPT_DIR}/render-autoscaling.sh" | kubectl apply -f -
