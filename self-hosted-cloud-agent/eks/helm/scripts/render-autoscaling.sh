#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="${K8S_NAMESPACE:-cursord}"
DEPLOYMENT_NAME="${WORKER_DEPLOYMENT_NAME:-my-workers}"
METRICS_SERVICE_NAME="${K8S_WORKER_METRICS_SERVICE_NAME:-cursor-worker-metrics}"
PROMETHEUS_SERVER_ADDRESS="${WORKER_AUTOSCALER_PROMETHEUS_SERVER_ADDRESS:-http://prometheus-server.prometheus.svc.cluster.local}"
MIN_REPLICAS="${WORKER_MIN_REPLICAS:-2}"
MAX_REPLICAS="${WORKER_MAX_REPLICAS:-5}"
TARGET_UTILIZATION_PERCENT="${WORKER_TARGET_UTILIZATION_PERCENT:-75}"
SCALER_NAME="${WORKER_AUTOSCALER_NAME:-cursor-worker-metrics-scaler}"
SCALER_IMAGE="${WORKER_AUTOSCALER_IMAGE:-python:3.12-alpine}"
SCALER_SCHEDULE="${WORKER_AUTOSCALER_SCHEDULE:-* * * * *}"

for value_name in MIN_REPLICAS MAX_REPLICAS TARGET_UTILIZATION_PERCENT; do
  value="${!value_name}"
  if [[ ! "${value}" =~ ^[0-9]+$ ]]; then
    echo "${value_name} must be a non-negative integer." >&2
    exit 1
  fi
done

if (( MIN_REPLICAS < 1 )); then
  echo "WORKER_MIN_REPLICAS must be at least 1." >&2
  exit 1
fi

if (( MAX_REPLICAS < MIN_REPLICAS )); then
  echo "WORKER_MAX_REPLICAS must be greater than or equal to WORKER_MIN_REPLICAS." >&2
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
apiVersion: v1
kind: Service
metadata:
  name: $(yaml_quote "${METRICS_SERVICE_NAME}")
  namespace: $(yaml_quote "${NAMESPACE}")
  labels:
    app: "cursor-self-hosted-worker"
  annotations:
    prometheus.io/scrape: "true"
    prometheus.io/path: "/metrics"
    prometheus.io/port: "8080"
spec:
  selector:
    app: "cursor-self-hosted-worker"
  ports:
    - name: "management"
      port: 8080
      targetPort: "management"
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: $(yaml_quote "${SCALER_NAME}")
  namespace: $(yaml_quote "${NAMESPACE}")
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: $(yaml_quote "${SCALER_NAME}")
  namespace: $(yaml_quote "${NAMESPACE}")
rules:
  - apiGroups: ["workers.cursor.com"]
    resources: ["workerdeployments/scale"]
    verbs: ["get", "update", "patch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: $(yaml_quote "${SCALER_NAME}")
  namespace: $(yaml_quote "${NAMESPACE}")
subjects:
  - kind: "ServiceAccount"
    name: $(yaml_quote "${SCALER_NAME}")
    namespace: $(yaml_quote "${NAMESPACE}")
roleRef:
  apiGroup: "rbac.authorization.k8s.io"
  kind: "Role"
  name: $(yaml_quote "${SCALER_NAME}")
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: $(yaml_quote "${SCALER_NAME}")
  namespace: $(yaml_quote "${NAMESPACE}")
data:
  scale.py: |
    import json
    import math
    import os
    import ssl
    import urllib.parse
    import urllib.request

    namespace = os.environ["K8S_NAMESPACE"]
    deployment_name = os.environ["WORKER_DEPLOYMENT_NAME"]
    metrics_service_name = os.environ["K8S_WORKER_METRICS_SERVICE_NAME"]
    prometheus_url = os.environ["PROMETHEUS_SERVER_ADDRESS"].rstrip("/")
    min_replicas = int(os.environ["WORKER_MIN_REPLICAS"])
    max_replicas = int(os.environ["WORKER_MAX_REPLICAS"])
    target_utilization_percent = int(os.environ["WORKER_TARGET_UTILIZATION_PERCENT"])

    token_path = "/var/run/secrets/kubernetes.io/serviceaccount/token"
    ca_path = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"

    with open(token_path, "r", encoding="utf-8") as token_file:
      token = token_file.read().strip()

    ssl_context = ssl.create_default_context(cafile=ca_path)

    def prometheus_query(query):
      encoded_query = urllib.parse.urlencode({"query": query})
      url = f"{prometheus_url}/api/v1/query?{encoded_query}"
      with urllib.request.urlopen(url, timeout=10) as response:
        payload = json.loads(response.read().decode("utf-8"))
      result = payload.get("data", {}).get("result", [])
      if not result:
        return 0.0
      return float(result[0]["value"][1])

    def kube_request(method, url, body=None):
      request = urllib.request.Request(
        url,
        method=method,
        data=json.dumps(body).encode("utf-8") if body is not None else None,
        headers={
          "Authorization": f"Bearer {token}",
          "Content-Type": "application/json",
        },
      )
      with urllib.request.urlopen(request, context=ssl_context, timeout=10) as response:
        return json.loads(response.read().decode("utf-8"))

    connected_metric = prometheus_query(
      'sum('
      f'cursor_self_hosted_worker_connected{{namespace="{namespace}"}} '
      '* on(instance) '
      f'up{{service="{metrics_service_name}"}}'
      ')'
    )
    active = prometheus_query(
      'sum('
      f'cursor_self_hosted_worker_session_active{{namespace="{namespace}"}} '
      '* on(instance) '
      f'up{{service="{metrics_service_name}"}}'
      ')'
    )

    scale_url = (
      "https://kubernetes.default.svc/apis/workers.cursor.com/v1/"
      f"namespaces/{namespace}/workerdeployments/{deployment_name}/scale"
    )
    scale = kube_request("GET", scale_url)
    current_replicas = int(scale["spec"]["replicas"])
    current_capacity = max(current_replicas, 1)

    if active <= 0:
      desired_replicas = min_replicas
    else:
      desired_replicas = math.ceil(active * 100 / target_utilization_percent)
      if active >= current_capacity and current_replicas < max_replicas:
        # Cursor does not expose queued session demand here. If every current
        # worker is busy, assume there may be hidden demand and open the pool up.
        desired_replicas = max_replicas
      elif desired_replicas < current_replicas:
        # Do not shed warm capacity while jobs are still active. Queued sessions
        # can claim newly-created workers shortly after the next heartbeat.
        desired_replicas = current_replicas

    desired_replicas = max(min_replicas, min(max_replicas, desired_replicas))

    utilization = active / current_capacity * 100
    print(
      "cursor worker autoscale: "
      f"connected_metric={connected_metric:.0f} active={active:.0f} "
      f"utilization={utilization:.1f}% current={current_replicas} "
      f"capacity={current_capacity} desired={desired_replicas}"
    )

    if desired_replicas != current_replicas:
      scale["spec"]["replicas"] = desired_replicas
      kube_request("PUT", scale_url, scale)
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: $(yaml_quote "${SCALER_NAME}")
  namespace: $(yaml_quote "${NAMESPACE}")
spec:
  schedule: $(yaml_quote "${SCALER_SCHEDULE}")
  concurrencyPolicy: "Forbid"
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      backoffLimit: 1
      template:
        spec:
          serviceAccountName: $(yaml_quote "${SCALER_NAME}")
          restartPolicy: "Never"
          containers:
            - name: "scaler"
              image: $(yaml_quote "${SCALER_IMAGE}")
              command: ["python", "/scripts/scale.py"]
              env:
                - name: "K8S_NAMESPACE"
                  value: $(yaml_quote "${NAMESPACE}")
                - name: "WORKER_DEPLOYMENT_NAME"
                  value: $(yaml_quote "${DEPLOYMENT_NAME}")
                - name: "K8S_WORKER_METRICS_SERVICE_NAME"
                  value: $(yaml_quote "${METRICS_SERVICE_NAME}")
                - name: "PROMETHEUS_SERVER_ADDRESS"
                  value: $(yaml_quote "${PROMETHEUS_SERVER_ADDRESS}")
                - name: "WORKER_MIN_REPLICAS"
                  value: $(yaml_quote "${MIN_REPLICAS}")
                - name: "WORKER_MAX_REPLICAS"
                  value: $(yaml_quote "${MAX_REPLICAS}")
                - name: "WORKER_TARGET_UTILIZATION_PERCENT"
                  value: $(yaml_quote "${TARGET_UTILIZATION_PERCENT}")
              volumeMounts:
                - name: "scaler-script"
                  mountPath: "/scripts"
                  readOnly: true
          volumes:
            - name: "scaler-script"
              configMap:
                name: $(yaml_quote "${SCALER_NAME}")
YAML
