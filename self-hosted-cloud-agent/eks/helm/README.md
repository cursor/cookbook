# EKS Helm Assets

Use this README when you already have a Kubernetes cluster and need to understand the Helm targets, generated manifests, and local smoke-test flow. For the end-to-end EKS customer runbook, start with [`../README.md`](../README.md).

The Helm path installs the official Cursor worker-set controller and applies a generated Kubernetes `WorkerDeployment` for the shared worker image.

## What Gets Installed

The workflow installs:

- The official Cursor worker-set controller Helm chart.
- A `cursord` namespace by default.
- A Kubernetes secret containing the Cursor service account API key.
- A labels ConfigMap mounted into the worker container.
- One example `WorkerDeployment` that runs the shared worker image.

The controller chart is configured by `values.yaml`. The default chart reference is:

```text
oci://public.ecr.aws/j6w0t2f5/cursor/worker-set-controller-chart
```

## End-To-End Flow

Set `.env` values first. For a remote cluster, `K8S_WORKER_IMAGE` must point at an image the cluster can pull, such as an ECR, GHCR, or other registry image.

```bash
make docker-build
make helm-install-controller
make helm-create-api-key-secret
make helm-render
make helm-apply
```

For an EKS-style demo using the same ECR image as the EC2 path:

```bash
make ecr-build-push
K8S_WORKER_IMAGE="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPOSITORY_NAME:$WORKER_IMAGE_TAG" make helm-apply
```

`helm-render` prints the generated `WorkerDeployment` so you can review the exact Kubernetes object before applying it.

## Local Kind Smoke Test

For local validation, use `kind` with the official Cursor controller chart and the local worker image.

If `helm` or `kind` are missing:

```bash
brew install helm kind
```

Create a local cluster, build the image, and load it into the kind node:

```bash
kind create cluster --name cursor-helm-lab
make docker-build
kind load docker-image cursor-self-hosted-worker:local --name cursor-helm-lab
```

Then deploy the controller and worker:

```bash
make helm-install-controller
make helm-create-api-key-secret
make helm-apply
```

Validate the local deployment:

```bash
kubectl get pods -n "$K8S_NAMESPACE"
kubectl get workerdeployments -n "$K8S_NAMESPACE"
kubectl logs -n "$K8S_NAMESPACE" -l app=cursor-self-hosted-worker -c worker --since=5m
```

Expected healthy output:

```text
Worker is now running
Registering to worker pool
Repo: <owner>/<repo>
Pool: <pool-name>
```

## How The Worker Starts

`make helm-install-controller` runs `helm upgrade --install` against the official controller chart and enables auth management through `values.yaml`.

`make helm-create-api-key-secret` creates the API key secret from `CURSOR_API_KEY` and labels it for the `WorkerDeployment`. This keeps the secret value out of checked-in YAML.

`make helm-apply` creates the namespace, applies the labels ConfigMap from `eks/helm/labels.json`, and applies a generated `WorkerDeployment`. The pod has:

1. An init container that initializes `/workspace` as a git repo and sets `origin` to `WORKER_REPOSITORY_URL`.
2. A worker container that starts `agent worker --pool --pool-name "$CURSOR_WORKER_POOL_NAME"`.
3. A management port on `0.0.0.0:8080` for the controller.
4. A token file at `/var/run/cursor/token` that is managed by the controller from the API key secret.

The checked-in `manifests/worker-deployment.yaml` is a static example. The Make target uses `scripts/render-worker-deployment.sh` so local `.env` values are reflected without editing YAML by hand.

## Validation

Check the controller:

```bash
kubectl get pods -n "$K8S_NAMESPACE"
kubectl get deploy -n "$K8S_NAMESPACE"
kubectl logs -n "$K8S_NAMESPACE" -l app.kubernetes.io/name=worker-set-controller --since=5m
```

Check the worker deployment:

```bash
kubectl get workerdeployments -n "$K8S_NAMESPACE"
kubectl get pods -n "$K8S_NAMESPACE" -l app=cursor-self-hosted-worker
kubectl logs -n "$K8S_NAMESPACE" -l app=cursor-self-hosted-worker -c worker -f
```

A healthy worker log includes:

```text
Worker is now running
Registering to worker pool
Repo: <owner>/<repo>
Pool: <pool-name>
```

## Updating The Worker

After changing Docker files or the entrypoint, build and push a new image, then apply the generated worker deployment again:

```bash
make ecr-build-push
K8S_WORKER_IMAGE="<registry>/<repo>:<tag>" make helm-apply
```

To support multiple concurrent Cloud Agent sessions, set `WORKER_READY_REPLICAS` to at least the desired concurrency:

```bash
WORKER_READY_REPLICAS=2 make helm-apply
kubectl get workerdeployments -n "$K8S_NAMESPACE"
```

A single worker can only take one active job at a time. Start customer demos at `WORKER_READY_REPLICAS=2`, then scale higher when the customer expects more simultaneous sessions:

```bash
WORKER_READY_REPLICAS=5 make helm-apply
kubectl get workerdeployments -n "$K8S_NAMESPACE"
```

To automate that scaling from Cursor worker metrics, install the Prometheus-based scaler:

```bash
make helm-install-autoscaling
```

This creates a `cursor-worker-metrics` Service for the worker `/metrics` endpoint, installs Prometheus, and runs a scaler CronJob. The customer-facing behavior and tuning guidance live in [`../README.md`](../README.md).

After rotating the service account key:

```bash
make helm-create-api-key-secret
kubectl delete pod -n "$K8S_NAMESPACE" -l app=cursor-self-hosted-worker
```

If the controller recreates pods automatically after the secret update, a manual restart is not needed.

## Common Blockers

### Helm Or Kind Is Missing

Install both tools for local smoke tests:

```bash
brew install helm kind
```

For an existing remote cluster, `kind` is optional, but `helm` is required for `make helm-install-controller`.

### No Kubernetes Context Is Set

If `kubectl config current-context` fails or `kubectl cluster-info` tries `localhost:8080`, kubeconfig is not pointed at a cluster. For local validation, create a kind cluster:

```bash
kind create cluster --name cursor-helm-lab
kubectl config current-context
```

For EKS or another remote cluster, update kubeconfig before running the Helm targets.

### Cluster Cannot Pull The Image

The default `cursor-self-hosted-worker:local` image only works when your local Kubernetes runtime can see that image, such as a local kind/minikube setup after loading it into the cluster. Remote clusters need `K8S_WORKER_IMAGE` set to a registry image.

For kind:

```bash
make docker-build
kind load docker-image cursor-self-hosted-worker:local --name cursor-helm-lab
```

### Worker Directory Is Not A Git Repo

Cursor derives the repo label from the worker directory's git remote. The generated Helm example handles this with an init container that runs `git init` in `/workspace` and sets the remote from `WORKER_REPOSITORY_URL`.

### API Key Is Invalid

Pool workers require a Cursor **service account API key**. Normal user, member, team, personal, or organization API keys are rejected.

Create the key from Cursor's Service Accounts settings, update `.env`, and rerun `make helm-create-api-key-secret`.

### CRD Is Missing

If `kubectl apply` reports that `WorkerDeployment` is not recognized, the controller chart did not finish installing its CRDs. Rerun:

```bash
make helm-install-controller
kubectl get crd | rg workers.cursor.com
```

### Scaling Does Not Reach The Desired Worker Count

If `WORKER_READY_REPLICAS=5 make helm-apply` does not result in `READY 5`, inspect the worker pods and events:

```bash
kubectl get workerdeployments -n "$K8S_NAMESPACE"
kubectl get pods -n "$K8S_NAMESPACE" -l app=cursor-self-hosted-worker -o wide
kubectl get events -n "$K8S_NAMESPACE" --sort-by=.lastTimestamp
```

Typical blockers are node CPU or memory capacity, VPC CNI IP exhaustion on EKS, image pull errors, node taints, and missing cluster autoscaling. Add capacity or enable autoscaling before increasing the ready worker target for sustained use.

If the pool remains at `READY 2`, confirm the `WorkerDeployment` desired count changed. Cluster autoscaling only adds Kubernetes nodes for unschedulable pods; it does not change `readyReplicas` from 2 to 5 automatically.

### Metrics Autoscaler Does Not Scale

Confirm Prometheus is scraping the workers:

```bash
kubectl exec -n prometheus deploy/prometheus-server -c prometheus-server -- \
  wget -qO- 'http://localhost:9090/api/v1/query?query=sum(cursor_self_hosted_worker_connected{namespace="'$K8S_NAMESPACE'"})'
```

Confirm the scaler CronJob is running:

```bash
kubectl get cronjob -n "$K8S_NAMESPACE" cursor-worker-metrics-scaler
kubectl get jobs -n "$K8S_NAMESPACE" | rg cursor-worker-metrics-scaler
```

If Prometheus is pending with an unbound PVC, install with the repo helper. It disables Prometheus persistence for the lab so EKS clusters without a default StorageClass still work. If the scaler logs show `active=0` while sessions are running, check that workers are started with `--management-addr 0.0.0.0:8080` and that the `cursor-worker-metrics` Service has endpoints.

Do not use a plain HPA or KEDA `ScaledObject` directly against `WorkerDeployment` without validating it first. The customer guide explains the CRD scale limitations and the CronJob scaler behavior.

### Initial Kind Scheduling Warning

On a single-node kind cluster, events may briefly show `FailedScheduling` for the controller because the control-plane taint has not been tolerated yet. In the live run this resolved within a few seconds and the controller rolled out normally.

## Cleanup

Remove the example worker deployment and labels ConfigMap:

```bash
make helm-delete
```

Remove the controller release and namespace:

```bash
helm uninstall "$CURSOR_CONTROLLER_RELEASE_NAME" -n "$K8S_NAMESPACE"
kubectl delete namespace "$K8S_NAMESPACE"
```

If you created the local kind cluster, delete it too:

```bash
kind delete cluster --name cursor-helm-lab
```
