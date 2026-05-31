# ECS Implementation Guide

This is the step-by-step implementation guide for the ECS/Fargate approach. For the high-level architecture, autoscaling model, validation checks, and troubleshooting guide, see [`../README.md`](../README.md).

Run all commands from the repository root unless noted otherwise.

Use this guide when you are ready to build or operate the ECS path. It intentionally includes concrete commands for Terraform, Secrets Manager, ECR image publishing, service validation, autoscaling validation, key rotation, and cleanup.

## 1. Configure Local Prerequisites

Install local tools:

```bash
brew install awscli terraform
```

Docker must be running locally because the worker image is built and pushed from your machine.

Authenticate to AWS:

```bash
aws login --profile default
aws sts get-caller-identity --profile default
```

Confirm the customer has:

- Cursor Enterprise with Self-Hosted Cloud Agents enabled.
- A Cursor service account API key for pool workers.
- The Cursor GitHub App installed for the target repo owner and repository.
- AWS permissions to create ECS, ECR, IAM, Lambda, EventBridge, CloudWatch, Secrets Manager, and security group resources.
- A VPC with outbound internet access. The default lab path uses public subnets with `ECS_ASSIGN_PUBLIC_IP=true`; private subnets need NAT or equivalent egress.

## 2. Configure `.env`

Copy the example file:

```bash
cp .env.example .env
```

Fill in at least:

```bash
AWS_PROFILE=default
AWS_REGION=us-east-1
AWS_ACCOUNT_ID=<aws-account-id>
CURSOR_API_KEY=<cursor-service-account-api-key>
CURSOR_WORKER_POOL_NAME=<base-pool-name>
ECS_WORKER_POOL_NAME=ecs-<base-pool-name>
WORKER_ENVIRONMENT_LABEL=lab
WORKER_OWNER_LABEL=platform-team
ECS_WORKER_INFRASTRUCTURE_LABEL=ecs
CURSOR_API_KEY_SECRET_NAME=cursor/ecs-service-account-key
ECS_CLUSTER_NAME=cursor-agents
ECS_SERVICE_NAME=cursor-worker-service
ECS_TASK_FAMILY=cursor-self-hosted-worker
WORKER_REPOSITORY_URL=https://github.com/OWNER/REPO.git
```

Use a Cursor **service account API key**. Normal member, user, team, personal, or organization API keys do not work for pool workers.

Use an ECS-specific pool name, such as `ecs-platform-agents`, so the worker is easy to identify in the Cursor Cloud Agents dashboard. The ECS task also passes labels through `CURSOR_WORKER_LABELS_JSON`, so Cursor should show labels like `infrastructure=ecs`, `runtime=ecs-fargate`, `environment=lab`, and `owner=platform-team`.

Size the worker like a CI runner for the repository:

```bash
ECS_TASK_CPU=1024
ECS_TASK_MEMORY=2048
ECS_MIN_CAPACITY=1
ECS_MAX_CAPACITY=5
ECS_TARGET_IDLE_WORKERS=1
ECS_TARGET_UTILIZATION_PERCENT=75
```

For Graviton/Fargate ARM, also set:

```bash
WORKER_PLATFORM=linux/arm64
ECS_TASK_CPU_ARCHITECTURE=ARM64
```

## 3. Review The Terraform Plan

Initialize Terraform:

```bash
terraform -chdir=ecs/terraform init
```

Review the plan:

```bash
tmpfile="$(mktemp)"
aws configure export-credentials --profile "$AWS_PROFILE" --format env-no-export > "$tmpfile"
set -a
source "$tmpfile"
set +a
rm -f "$tmpfile"

terraform -chdir=ecs/terraform plan \
  -var "aws_profile=" \
  -var "aws_region=$AWS_REGION" \
  -var "ecs_cluster_name=$ECS_CLUSTER_NAME" \
  -var "ecs_service_name=$ECS_SERVICE_NAME" \
  -var "ecs_task_family=$ECS_TASK_FAMILY" \
  -var "worker_pool_name=$ECS_WORKER_POOL_NAME" \
  -var "worker_repository_url=$WORKER_REPOSITORY_URL" \
  -var "cursor_api_key_secret_name=$CURSOR_API_KEY_SECRET_NAME" \
  -var "min_capacity=$ECS_MIN_CAPACITY" \
  -var "max_capacity=$ECS_MAX_CAPACITY" \
  -var "target_idle_workers=$ECS_TARGET_IDLE_WORKERS"
```

Confirm the plan creates only the expected resources:

- ECS cluster, unless `create_ecs_cluster=false`.
- ECR repository, unless `create_ecr_repository=false`.
- Secrets Manager secret container for the Cursor service account key.
- ECS task execution role and task role.
- Fargate task definition and ECS service.
- Security group with no inbound rules and outbound HTTPS/DNS.
- CloudWatch log groups for worker and metrics publisher logs.
- Scheduled Lambda metrics publisher for service-scoped Cursor worker utilization and dynamic scale-out.
- Application Auto Scaling target, target-tracking policy, and fast step-scaling backup alarm.

Terraform creates the Secrets Manager secret container, but it does not store the Cursor API key value in state.

## 4. Apply Infrastructure

Apply once the customer approves the plan:

```bash
terraform -chdir=ecs/terraform apply \
  -var "aws_profile=" \
  -var "aws_region=$AWS_REGION" \
  -var "ecs_cluster_name=$ECS_CLUSTER_NAME" \
  -var "ecs_service_name=$ECS_SERVICE_NAME" \
  -var "ecs_task_family=$ECS_TASK_FAMILY" \
  -var "worker_pool_name=$ECS_WORKER_POOL_NAME" \
  -var "worker_repository_url=$WORKER_REPOSITORY_URL" \
  -var "cursor_api_key_secret_name=$CURSOR_API_KEY_SECRET_NAME" \
  -var "min_capacity=$ECS_MIN_CAPACITY" \
  -var "max_capacity=$ECS_MAX_CAPACITY" \
  -var "target_idle_workers=$ECS_TARGET_IDLE_WORKERS"
```

The ECS service may start before the worker image or secret value exists. That is expected during first setup; upload the secret, push the image, and force a new deployment in the later steps.

## 5. Upload The Cursor Service Account Key

Upload the key from `.env` into Secrets Manager:

```bash
aws secretsmanager put-secret-value \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" \
  --secret-id "$CURSOR_API_KEY_SECRET_NAME" \
  --secret-string "$CURSOR_API_KEY"
```

The ECS task execution role reads this secret at task startup and injects it as `CURSOR_API_KEY`.

## 6. Build And Push The Worker Image

Build and push the Docker image to ECR:

```bash
make ecr-build-push
```

Confirm `WORKER_PLATFORM` matches `ECS_TASK_CPU_ARCHITECTURE`: use `linux/amd64` with `X86_64`, or `linux/arm64` with `ARM64`.

If the ECS service started before the secret or image existed, force a new deployment:

```bash
aws ecs update-service \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" \
  --cluster "$ECS_CLUSTER_NAME" \
  --service "$ECS_SERVICE_NAME" \
  --force-new-deployment
```

## 7. Validate The Worker

Check service state:

```bash
aws ecs describe-services \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" \
  --cluster "$ECS_CLUSTER_NAME" \
  --services "$ECS_SERVICE_NAME" \
  --query "services[0].{desired:desiredCount,running:runningCount,pending:pendingCount,taskDefinition:taskDefinition,events:events[0:5]}"
```

Check the running task:

```bash
TASKS="$(aws ecs list-tasks \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" \
  --cluster "$ECS_CLUSTER_NAME" \
  --service-name "$ECS_SERVICE_NAME" \
  --desired-status RUNNING \
  --query 'taskArns[]' \
  --output text)"

aws ecs describe-tasks \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" \
  --cluster "$ECS_CLUSTER_NAME" \
  --tasks $TASKS \
  --query "tasks[].{lastStatus:lastStatus,healthStatus:healthStatus,taskDefinitionArn:taskDefinitionArn,containers:containers[].{name:name,lastStatus:lastStatus,healthStatus:healthStatus,reason:reason}}"
```

Tail worker logs:

```bash
aws logs tail "${ECS_WORKER_LOG_GROUP_NAME:-/ecs/$ECS_SERVICE_NAME}" \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" \
  --follow
```

A healthy worker shows:

```text
Worker is now running
Registering to worker pool
Repo: <owner>/<repo>
Pool: <ecs-pool-name>
```

Confirm the worker appears in the Cursor Cloud Agents dashboard under `ECS_WORKER_POOL_NAME`, then start a test Cloud Agent run with that pool selected.

## 8. Validate Autoscaling Metrics

The metrics publisher lists running ECS tasks, matches their private IPs to Cursor workers, and publishes these service-scoped CloudWatch metrics under `Cursor/SelfHostedWorkers`:

- `Connected`
- `InUse`
- `Idle`
- `UtilizationPercent`
- `DesiredCount`
- `RunningTasks`
- `RecommendedCapacity`
- `TargetIdleWorkers`

It also performs dynamic scale-out from these same metrics. When `Idle` is lower than `ECS_TARGET_IDLE_WORKERS`, it requests a higher ECS desired count up to `ECS_MAX_CAPACITY`. It does not scale in directly; Application Auto Scaling target tracking handles scale-in after the longer cooldown.

The dynamic scale-out path is intentionally based only on the available Cursor worker metrics:

```text
idle_workers = Connected - InUse
recommended_capacity = current_capacity + max(ECS_TARGET_IDLE_WORKERS - idle_workers, 0)
```

This means the scaler reacts when workers become active. The metrics do not expose queued sessions that failed to claim a worker, so `ECS_MIN_CAPACITY` is still the control for no-wait burst capacity.

### How The Scheduled Publisher Works

Terraform packages `metrics_publisher.py` into a Lambda zip with the `archive` provider. EventBridge invokes that Lambda on `metrics_publish_schedule_expression`, which defaults to:

```text
rate(1 minute)
```

On each run, the Lambda:

1. Reads the Cursor service account key from Secrets Manager.
2. Calls ECS `ListTasks` and `DescribeTasks` for `ECS_CLUSTER_NAME` and `ECS_SERVICE_NAME`.
3. Extracts each running task's private IP address.
4. Calls Cursor's `/v0/private-workers` worker list endpoint.
5. Matches Cursor worker names to ECS task private IPs.
6. Publishes the ECS-service-scoped metrics to CloudWatch.
7. Calls ECS `UpdateService` when the service has fewer idle workers than `ECS_TARGET_IDLE_WORKERS`.

New workers are created by ECS, not by the Lambda directly. The Lambda only changes the ECS service desired count. ECS then starts another Fargate task from the task definition, and the task registers as another Cursor worker after the container starts.

### Production Readiness Notes

The ECS overview explains the control-loop trade-offs in more detail. For this implementation, confirm the metrics publisher is running and then apply the hardening checklist later in this guide before production rollout.

Confirm the metrics publisher is running:

```bash
aws logs tail "/aws/lambda/${ECS_METRICS_PUBLISHER_NAME:-$ECS_SERVICE_NAME-metrics-publisher}" \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" \
  --since 15m
```

Check CloudWatch for utilization:

```bash
aws cloudwatch get-metric-statistics \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" \
  --namespace "${ECS_METRICS_NAMESPACE:-Cursor/SelfHostedWorkers}" \
  --metric-name "UtilizationPercent" \
  --dimensions Name=PoolName,Value="${ECS_WORKER_POOL_NAME:-ecs-$CURSOR_WORKER_POOL_NAME}" Name=ClusterName,Value="$ECS_CLUSTER_NAME" Name=ServiceName,Value="$ECS_SERVICE_NAME" \
  --start-time "$(date -u -v-15M +%Y-%m-%dT%H:%M:%SZ)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --period 60 \
  --statistics Average
```

ECS Service Auto Scaling target-tracks `UtilizationPercent`. Keep `ECS_MIN_CAPACITY` above zero unless you add a separate scale-from-zero signal.

This Terraform root also creates a fast step-scaling alarm as a backup CloudWatch path. Target tracking is useful for steady-state control, but AWS evaluates its generated high alarm over multiple one-minute periods. The fast alarm adds one worker after a single saturated datapoint, while the metrics publisher's dynamic scale-out reacts as soon as the scheduled publisher observes no idle capacity.

If a second Cloud Agent session is blocked while ECS still shows one desired task, invoke the metrics publisher and confirm the denominator is scoped to this ECS service:

```bash
aws lambda invoke \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" \
  --function-name "${ECS_METRICS_PUBLISHER_NAME:-$ECS_SERVICE_NAME-metrics-publisher}" \
  --cli-binary-format raw-in-base64-out \
  --payload '{}' \
  /tmp/cursor-ecs-metrics-response.json

cat /tmp/cursor-ecs-metrics-response.json
```

For one busy ECS task, `connected` should be `1`, `inUse` should be `1`, and `utilizationPercent` should be `100.0`. If `connected` includes other team workers, apply the current Terraform so the Lambda uses ECS task private IP matching instead of Cursor's team-wide summary endpoint.

## 9. Update The Worker Image

After changing `docker/` or the entrypoint:

```bash
make ecr-build-push
```

Then force a fresh ECS deployment:

```bash
aws ecs update-service \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" \
  --cluster "$ECS_CLUSTER_NAME" \
  --service "$ECS_SERVICE_NAME" \
  --force-new-deployment
```

## 10. Rotate The Service Account Key

Update `.env`, then upload the new value:

```bash
aws secretsmanager put-secret-value \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" \
  --secret-id "$CURSOR_API_KEY_SECRET_NAME" \
  --secret-string "$CURSOR_API_KEY"
```

Force a fresh ECS deployment so new tasks read the new secret value:

```bash
aws ecs update-service \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" \
  --cluster "$ECS_CLUSTER_NAME" \
  --service "$ECS_SERVICE_NAME" \
  --force-new-deployment
```

## 11. Production Hardening Checklist

Before production rollout, decide:

- Whether to use private subnets with NAT or VPC endpoints instead of public task ENIs.
- Whether each repo, team, or environment should get a separate pool and ECS service.
- Whether `ECS_MIN_CAPACITY` should be `2` or higher for warm standby capacity.
- Whether `ECS_TARGET_IDLE_WORKERS` should be higher than `1` for teams that regularly start several sessions at once.
- Whether workers need ECS on EC2 instead of Fargate for privileged Docker, host caches, GPUs, larger local disks, or custom AMIs.
- Whether to add customer-standard alarms for failed ECS deployments, stopped tasks, Lambda errors, missing metrics, high utilization, and worker connection failures.

## 12. Clean Up

Destroy the ECS demo resources when finished:

```bash
terraform -chdir=ecs/terraform destroy
```

This deletes the ECS service, task definition resources, ECR repository, IAM roles, log groups, Lambda metrics publisher, EventBridge schedule, security group, and secret container managed by this Terraform root.

The ECR repository is configured with force delete for lab cleanup, so Terraform can remove it even if it contains demo images.

## Safety Notes

- Do not put real service account API keys in Terraform variables or state.
- Do not commit `.env`, Terraform state, AWS credentials, or private keys.
- Rotate the service account key if it is exposed in logs, shell history, or command output.
