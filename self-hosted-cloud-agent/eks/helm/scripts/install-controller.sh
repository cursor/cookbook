#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="${K8S_NAMESPACE:-cursord}"
RELEASE_NAME="${CURSOR_CONTROLLER_RELEASE_NAME:-worker-set-controller}"
CHART="${CURSOR_CONTROLLER_CHART:-oci://public.ecr.aws/j6w0t2f5/cursor/worker-set-controller-chart}"
CHART_VERSION="${CURSOR_CONTROLLER_CHART_VERSION:-0.1.0-6c804a0}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
HELM_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

helm upgrade --install "${RELEASE_NAME}" "${CHART}" \
  --namespace "${NAMESPACE}" \
  --create-namespace \
  --version "${CHART_VERSION}" \
  -f "${HELM_DIR}/values.yaml"
