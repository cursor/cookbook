# EKS Customer Implementation Guide

Use this guide to stand up Cursor self-hosted Cloud Agent workers on Amazon EKS from scratch.

This path uses the shared worker image in `docker/`, pushes that image to ECR, installs the official Cursor worker-set controller Helm chart, and applies a generated `WorkerDeployment`. The Helm values, manifests, labels, and helper scripts live in `eks/helm/`.

## Architecture

The deployed flow is:

1. Cursor Cloud Agents schedules work for a repo and self-hosted pool.
2. The Cursor worker-set controller runs in EKS and keeps the requested number of worker pods ready.
3. Each worker pod runs the shared Cursor worker image from ECR.
4. The controller manages the worker auth token from a Kubernetes secret backed by the Cursor service account API key.
5. Workers connect outbound to Cursor over HTTPS. No inbound access to worker pods is required.

## Prerequisites

Install local tools:

```bash
brew install awscli eksctl kubectl helm
```

You also need:

- Docker running locally.
- An AWS account with permission to create EKS, IAM, VPC, node groups, and ECR resources.
- A Cursor Enterprise workspace with Self-Hosted Cloud Agents enabled.
- A Cursor **service account API key** for pool workers.
- The Cursor GitHub App installed with access to the target repository.

Pool workers reject personal, member, team, and general organization API keys.

## Step 1: Configure Local Environment

Copy the example environment file:

```bash
cp .env.example .env
```

Set these values in `.env`:

```bash
AWS_PROFILE=default
AWS_REGION=us-east-1
AWS_ACCOUNT_ID=<your-aws-account-id>
ECR_REPOSITORY_NAME=cursor-self-hosted-worker

CURSOR_API_KEY=<cursor-service-account-api-key>
CURSOR_WORKER_POOL_NAME=<customer-or-team>-eks-worker-pool
CURSOR_WORKER_IDLE_RELEASE_TIMEOUT=600

K8S_NAMESPACE=<customer-or-team>-eks-worker-pool
WORKER_DEPLOYMENT_NAME=<customer-or-team>-eks-worker-deployment
WORKER_READY_REPLICAS=2
CURSOR_API_KEY_SECRET_NAME=my-workers-api-key
K8S_WORKER_LABELS_FILE=eks/helm/labels.json
```

Use a pool name that includes `eks`, such as `acme-eks-worker-pool`, so the pool is easy to identify in Cursor's Self-Hosted picker.

Set `WORKER_REPOSITORY_URL` if the local repo remote is not the customer repo that Cloud Agents should work on:

```bash
WORKER_REPOSITORY_URL=https://github.com/<owner>/<repo>.git
```

## Step 2: Authenticate AWS

Authenticate the AWS CLI:

```bash
aws sso login --profile "$AWS_PROFILE"
aws sts get-caller-identity --profile "$AWS_PROFILE"
```

If you do not use AWS IAM Identity Center, configure credentials with your normal AWS process and confirm `aws sts get-caller-identity` works. If your environment supports `aws login`, that is fine too.

## Step 3: Create An EKS Cluster

Set a cluster name in your shell:

```bash
export EKS_CLUSTER_NAME=cursor-agents-lab
```

Create a managed-node EKS cluster:

```bash
eksctl create cluster \
  --name "$EKS_CLUSTER_NAME" \
  --region "$AWS_REGION" \
  --profile "$AWS_PROFILE" \
  --nodes 2 \
  --node-type t3.large \
  --managed
```

This command creates the VPC, EKS control plane, managed node group, and node IAM role. For private clusters, make sure worker nodes have outbound HTTPS through NAT or another approved egress path.

Update kubeconfig and verify access:

```bash
aws eks update-kubeconfig \
  --region "$AWS_REGION" \
  --name "$EKS_CLUSTER_NAME" \
  --profile "$AWS_PROFILE"

kubectl config current-context
kubectl get nodes
```

## Step 4: Create Or Reuse The ECR Repository

Create the ECR repository if it does not already exist:

```bash
aws ecr describe-repositories \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" \
  --repository-names "$ECR_REPOSITORY_NAME" >/dev/null 2>&1 \
  || aws ecr create-repository \
    --profile "$AWS_PROFILE" \
    --region "$AWS_REGION" \
    --repository-name "$ECR_REPOSITORY_NAME"
```

Build and push the worker image:

```bash
make ecr-build-push
```

The default `WORKER_PLATFORM=linux/amd64` matches the `t3.large` node type above. If you use Graviton nodes, set `WORKER_PLATFORM=linux/arm64` before building and pushing.

Set the Kubernetes image to the ECR image in `.env`:

```bash
K8S_WORKER_IMAGE=<aws-account-id>.dkr.ecr.<region>.amazonaws.com/cursor-self-hosted-worker:latest
```

Values loaded from `.env` are exported by the Makefile. You can also pass the image per command with `K8S_WORKER_IMAGE="..." make helm-apply`.

## Step 5: Install The Cursor Controller

Install the official Cursor worker-set controller Helm chart:

```bash
make helm-install-controller
```

Confirm the controller rolled out:

```bash
kubectl rollout status deployment/worker-set-controller -n "$K8S_NAMESPACE" --timeout=120s
kubectl get pods -n "$K8S_NAMESPACE"
```

## Step 6: Create The API Key Secret

Create or update the Kubernetes secret from `CURSOR_API_KEY`:

```bash
make helm-create-api-key-secret
```

Confirm the secret exists without printing the secret value:

```bash
kubectl get secret "$CURSOR_API_KEY_SECRET_NAME" -n "$K8S_NAMESPACE"
```

## Step 7: Render And Apply The WorkerDeployment

Review the generated deployment:

```bash
make helm-render
```

Apply it:

```bash
make helm-apply
```

Wait for the worker deployment:

```bash
kubectl get workerdeployments -n "$K8S_NAMESPACE"
kubectl get pods -n "$K8S_NAMESPACE" -l app=cursor-self-hosted-worker
```

## Step 8: Validate Worker Registration

Inspect worker logs:

```bash
kubectl logs -n "$K8S_NAMESPACE" -l app=cursor-self-hosted-worker -c worker --since=5m
```

A healthy worker log includes:

```text
Worker is now running
Registering to worker pool
Repo: <owner>/<repo>
Pool: <pool-name>
```

Then open Cursor Cloud Agents, choose **Self-Hosted**, and start a test job against the repo that matches `WORKER_REPOSITORY_URL`.

## Step 9: Update Or Scale Workers

To change the worker image:

```bash
make ecr-build-push
make helm-apply
```

To change the number of ready workers:

```bash
WORKER_READY_REPLICAS=2 make helm-apply
kubectl get workerdeployments -n "$K8S_NAMESPACE"
```

Set `WORKER_READY_REPLICAS` to at least the number of concurrent Cloud Agent sessions you want the pool to handle. A single worker can only take one active job at a time, so start customer demos at `WORKER_READY_REPLICAS=2` and scale up if more simultaneous sessions are expected.

To scale the same pool to 5 ready workers:

```bash
WORKER_READY_REPLICAS=5 make helm-apply
kubectl get workerdeployments -n "$K8S_NAMESPACE"
kubectl get pods -n "$K8S_NAMESPACE" -l app=cursor-self-hosted-worker
```

If 5 workers should be the steady state, update `WORKER_READY_REPLICAS=5` in `.env` after confirming the cluster has enough capacity.

To scale automatically from Cursor worker metrics, install the Prometheus-based scaler:

```bash
make helm-install-autoscaling
```

This installs Prometheus without persistent storage, creates a `cursor-worker-metrics` Service for the worker `/metrics` endpoint, and runs a scaler CronJob. The CronJob reads `cursor_self_hosted_worker_connected` and `cursor_self_hosted_worker_session_active`, then patches `WorkerDeployment.spec.readyReplicas` between `WORKER_MIN_REPLICAS=2` and `WORKER_MAX_REPLICAS=5`.

The CronJob version is intentionally simple, but it is not instant. Kubernetes CronJobs run on minute boundaries, so scale-up can take up to about 60 seconds plus worker pod startup time. When every current worker is busy, the scaler opens the pool to `WORKER_MAX_REPLICAS`; when active sessions return to zero, it scales back down to `WORKER_MIN_REPLICAS`. If a customer needs sub-minute reaction time, replace the CronJob with a tiny always-running scaler Deployment that polls Prometheus every 10-15 seconds and uses the same patch logic.

To rotate the Cursor service account key:

```bash
make helm-create-api-key-secret
kubectl delete pod -n "$K8S_NAMESPACE" -l app=cursor-self-hosted-worker
```

The controller recreates the worker pod and mounts fresh auth material.

## Troubleshooting

### `helm` Or `kubectl` Is Missing

Install the required tools:

```bash
brew install awscli eksctl kubectl helm
```

Then rerun `helm version --short` and `kubectl version --client=true`.

### `kubectl` Has No Cluster Context

If `kubectl config current-context` fails or `kubectl cluster-info` tries `localhost:8080`, update kubeconfig:

```bash
aws eks update-kubeconfig \
  --region "$AWS_REGION" \
  --name "$EKS_CLUSTER_NAME" \
  --profile "$AWS_PROFILE"
```

### Worker Pods Show `ImagePullBackOff`

Confirm `K8S_WORKER_IMAGE` points at the pushed ECR image:

```bash
echo "$K8S_WORKER_IMAGE"
aws ecr describe-images \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" \
  --repository-name "$ECR_REPOSITORY_NAME"
```

Also confirm the node IAM role can pull from ECR. Managed node groups created by `eksctl` usually include ECR read permissions.

### Pod Fails With `exec format error`

The worker image architecture does not match the node architecture. Use `WORKER_PLATFORM=linux/amd64` for x86 nodes or `WORKER_PLATFORM=linux/arm64` for Graviton nodes, then rerun `make ecr-build-push` and `make helm-apply`.

### WorkerDeployment Kind Is Not Recognized

The controller chart did not install its CRD, or `helm-install-controller` did not finish successfully:

```bash
make helm-install-controller
kubectl get crd | rg workers.cursor.com
```

### Worker Logs Say The API Key Is Invalid

Create a Cursor service account API key from Cursor's Service Accounts settings. Update `CURSOR_API_KEY` in `.env`, then rerun:

```bash
make helm-create-api-key-secret
kubectl delete pod -n "$K8S_NAMESPACE" -l app=cursor-self-hosted-worker
```

### Worker Is Running But Jobs Do Not Start

Check that the pool name in Cursor matches `CURSOR_WORKER_POOL_NAME`, the repo in the worker logs matches the intended repo, and the Cursor GitHub App has access to that repo.

If the first job starts but a second concurrent job waits or fails to assign, check `kubectl get workerdeployments -n "$K8S_NAMESPACE"`. Increase `WORKER_READY_REPLICAS` when `READY` is lower than the number of concurrent sessions you expect.

### Pool Does Not Automatically Grow From 2 To 5

`WORKER_READY_REPLICAS=2` means the controller keeps 2 ready workers. To make the pool grow automatically, install the metrics scaler:

```bash
make helm-install-autoscaling
```

You can still scale manually when you expect more concurrent jobs:

```bash
WORKER_READY_REPLICAS=5 make helm-apply
kubectl get workerdeployments -n "$K8S_NAMESPACE"
```

EKS cluster autoscaling, Karpenter, or Cluster Autoscaler only add nodes when Kubernetes has unschedulable pods. They do not increase the `WorkerDeployment` replica target by themselves.

### Metrics Autoscaler Does Not Scale

Confirm Prometheus is scraping the workers:

```bash
kubectl exec -n prometheus deploy/prometheus-server -c prometheus-server -- \
  wget -qO- 'http://localhost:9090/api/v1/query?query=sum(cursor_self_hosted_worker_connected{namespace="'$K8S_NAMESPACE'"})'

kubectl exec -n prometheus deploy/prometheus-server -c prometheus-server -- \
  wget -qO- 'http://localhost:9090/api/v1/query?query=sum(cursor_self_hosted_worker_session_active{namespace="'$K8S_NAMESPACE'"})'
```

Confirm the scaler CronJob is running and inspect its latest log:

```bash
kubectl get cronjob -n "$K8S_NAMESPACE" cursor-worker-metrics-scaler
kubectl get jobs -n "$K8S_NAMESPACE" | rg cursor-worker-metrics-scaler
kubectl logs -n "$K8S_NAMESPACE" job/<latest-scaler-job-name>
```

If Prometheus is pending with an unbound PVC, reinstall with `make helm-install-autoscaling`; the helper disables Prometheus persistence for this lab. If the scaler logs show `active=0` while sessions are running, check that workers are started with `--management-addr 0.0.0.0:8080` and that `kubectl get endpoints -n "$K8S_NAMESPACE" cursor-worker-metrics` lists worker pod IPs. If the scaler patches replicas but pods stay pending, fix node capacity, subnet IP capacity, or cluster autoscaling.

Do not use a plain HPA or KEDA `ScaledObject` directly against `WorkerDeployment` without validating it first. The Cursor CRD exposes `/scale`, but its scale status does not include a selector, and Kubernetes HPA can reject the target with `selector is required`. The repo helper uses a CronJob scaler that patches the `WorkerDeployment` scale endpoint directly.

Prometheus can briefly retain metrics for deleted worker pods. The scaler logs `connected_metric` for visibility, but uses the Kubernetes `WorkerDeployment` replica count as the capacity denominator so stale Prometheus series do not block scale-out. When every current worker is active, the scaler opens the pool to `WORKER_MAX_REPLICAS`; it only scales back down after active sessions return to zero.

### Scaling To 5 Does Not Create 5 Ready Workers

First confirm the desired count changed:

```bash
kubectl get workerdeployments -n "$K8S_NAMESPACE"
kubectl describe workerdeployment "$WORKER_DEPLOYMENT_NAME" -n "$K8S_NAMESPACE"
```

If `DESIRED` is 5 but `READY` stays lower, inspect pods and events:

```bash
kubectl get pods -n "$K8S_NAMESPACE" -l app=cursor-self-hosted-worker -o wide
kubectl describe pods -n "$K8S_NAMESPACE" -l app=cursor-self-hosted-worker
kubectl get events -n "$K8S_NAMESPACE" --sort-by=.lastTimestamp
```

Common blockers are insufficient node CPU or memory, VPC CNI IP exhaustion, EC2 instance or subnet capacity limits, ECR image pull failures, node taints, and missing cluster autoscaler or Karpenter capacity. If pods are `Pending`, add nodes or enable autoscaling before increasing `WORKER_READY_REPLICAS`. If pods are `ImagePullBackOff`, fix the ECR image URI or node ECR permissions.

### Worker Cannot Reach Cursor

Workers need outbound HTTPS access to Cursor APIs, Cursor downloads, and Cursor cloud-agent artifacts. For private EKS nodes, verify NAT, firewall, proxy, and DNS settings.

### Pods Are Pending

Inspect scheduling events:

```bash
kubectl describe pods -n "$K8S_NAMESPACE" -l app=cursor-self-hosted-worker
kubectl get events -n "$K8S_NAMESPACE" --sort-by=.lastTimestamp
```

Common causes are insufficient CPU or memory, node taints, missing tolerations, or cluster autoscaler limits.

## Cleanup

Delete the example worker and labels ConfigMap:

```bash
make helm-delete
```

Remove the controller:

```bash
helm uninstall "$CURSOR_CONTROLLER_RELEASE_NAME" -n "$K8S_NAMESPACE"
kubectl delete namespace "$K8S_NAMESPACE"
```

Delete the EKS cluster when the demo is complete:

```bash
eksctl delete cluster \
  --name "$EKS_CLUSTER_NAME" \
  --region "$AWS_REGION" \
  --profile "$AWS_PROFILE"
```

Delete the ECR repository if it was created only for the demo:

```bash
aws ecr delete-repository \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" \
  --repository-name "$ECR_REPOSITORY_NAME" \
  --force
```
