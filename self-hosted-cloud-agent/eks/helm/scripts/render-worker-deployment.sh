#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="${K8S_NAMESPACE:-cursord}"
DEPLOYMENT_NAME="${WORKER_DEPLOYMENT_NAME:-my-workers}"
SECRET_NAME="${CURSOR_API_KEY_SECRET_NAME:-my-workers-api-key}"
WORKER_IMAGE="${K8S_WORKER_IMAGE:-${WORKER_IMAGE:-}}"
POOL_NAME="${CURSOR_WORKER_POOL_NAME:-lab}"
IDLE_TIMEOUT="${CURSOR_WORKER_IDLE_RELEASE_TIMEOUT:-600}"
READY_REPLICAS="${WORKER_READY_REPLICAS:-1}"
LABELS_CONFIG_MAP="${K8S_WORKER_LABELS_CONFIG_MAP:-cursor-worker-labels}"
MANAGEMENT_ADDR="${CURSOR_WORKER_MANAGEMENT_ADDR:-0.0.0.0:8080}"
WORKER_REPOSITORY_URL="${WORKER_REPOSITORY_URL:-}"

if [[ -z "${WORKER_REPOSITORY_URL}" ]]; then
  WORKER_REPOSITORY_URL="$(git config --get remote.origin.url 2>/dev/null || true)"
fi

if [[ -z "${WORKER_IMAGE}" ]]; then
  echo "WORKER_IMAGE or K8S_WORKER_IMAGE must be set to an image your cluster can pull." >&2
  exit 1
fi

if [[ -z "${WORKER_REPOSITORY_URL}" ]]; then
  echo "WORKER_REPOSITORY_URL must be set or derivable from git remote origin." >&2
  exit 1
fi

if [[ ! "${READY_REPLICAS}" =~ ^[0-9]+$ ]]; then
  echo "WORKER_READY_REPLICAS must be a non-negative integer." >&2
  exit 1
fi

yaml_quote() {
  local value="${1:-}"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  printf '"%s"' "${value}"
}

cat <<YAML
apiVersion: workers.cursor.com/v1
kind: WorkerDeployment
metadata:
  name: $(yaml_quote "${DEPLOYMENT_NAME}")
  namespace: $(yaml_quote "${NAMESPACE}")
spec:
  auth:
    apiKeySecretRef:
      name: $(yaml_quote "${SECRET_NAME}")
      key: "api-key"
    workerContainerName: "worker"
  readyReplicas: ${READY_REPLICAS}
  template:
    metadata:
      labels:
        app: "cursor-self-hosted-worker"
    spec:
      initContainers:
        - name: "prepare-workspace"
          image: $(yaml_quote "${WORKER_IMAGE}")
          command: ["/bin/bash", "-lc"]
          env:
            - name: "WORKER_REPOSITORY_URL"
              value: $(yaml_quote "${WORKER_REPOSITORY_URL}")
          args:
            - |
              set -euo pipefail
              git config --global --add safe.directory /workspace
              if [[ ! -d /workspace/.git ]]; then
                git init /workspace
              fi
              cd /workspace
              git remote remove origin 2>/dev/null || true
              git remote add origin "\${WORKER_REPOSITORY_URL}"
          volumeMounts:
            - name: "workspace"
              mountPath: "/workspace"
      containers:
        - name: "worker"
          image: $(yaml_quote "${WORKER_IMAGE}")
          command: ["agent"]
          args:
            - "worker"
            - "--pool"
            - "--pool-name"
            - $(yaml_quote "${POOL_NAME}")
            - "--idle-release-timeout"
            - $(yaml_quote "${IDLE_TIMEOUT}")
            - "--worker-dir"
            - "/workspace"
            - "--auth-token-file"
            - "/var/run/cursor/token"
            - "--management-addr"
            - $(yaml_quote "${MANAGEMENT_ADDR}")
            - "--labels-file"
            - "/etc/cursor/labels.json"
            - "start"
          ports:
            - name: "management"
              containerPort: 8080
          volumeMounts:
            - name: "worker-labels"
              mountPath: "/etc/cursor"
              readOnly: true
            - name: "workspace"
              mountPath: "/workspace"
      volumes:
        - name: "worker-labels"
          configMap:
            name: $(yaml_quote "${LABELS_CONFIG_MAP}")
        - name: "workspace"
          emptyDir: {}
YAML
