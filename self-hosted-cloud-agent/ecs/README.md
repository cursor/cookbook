# ECS/Fargate Guide

Use this approach to run Cursor self-hosted workers as ECS tasks, either on Fargate or on an ECS cluster backed by EC2 capacity.

Use this guide for architecture, autoscaling behavior, validation expectations, operational trade-offs, and common troubleshooting paths. Use [`terraform/README.md`](terraform/README.md) for the step-by-step implementation runbook.

## Current Status

This folder includes a Fargate-first Terraform deployment and a task definition example. The Terraform path creates an ECS service, ECR repository, Secrets Manager secret container, CloudWatch logs, and an autoscaling signal path for Cursor worker utilization.

## Intended Shape

- Build and publish the shared worker image from `docker/` to ECR.
- Store the Cursor service account API key in Secrets Manager.
- Run the worker as an ECS service where each task is one Cursor worker.
- Give the task outbound HTTPS access to Cursor APIs, Cursor downloads, and Cursor cloud-agent artifacts.
- Publish service-scoped Cursor worker utilization into CloudWatch, dynamically request scale-out when idle workers run out, and let ECS Service Auto Scaling handle steady-state scaling.

Fargate is the default recommendation for teams that do not need privileged Docker, host-mounted caches, GPUs, or custom AMIs. Use ECS on EC2 when agents need CI-runner-style host control or specialized hardware. ECS on EC2 adds a second scaling loop because you must scale both the ECS service desired count and the underlying EC2 capacity provider.

## Autoscaling Model

Do not autoscale the worker service directly on CPU or memory. Idle workers can have low CPU while still representing useful warm capacity, and busy workers may be blocked on network or build steps rather than CPU.

The Cursor metrics that matter are:

- `cursor_self_hosted_worker_connected`: `1` when a worker has an active outbound connection to Cursor. Treat this as connected capacity and health.
- `cursor_self_hosted_worker_session_active`: `1` when a worker is claimed by a Cloud Agent session. Treat this as used capacity and demand.
- `cursor_self_hosted_worker_last_activity_unix_seconds`: useful for stale connection alerts.
- `cursor_self_hosted_worker_session_ends_total{reason=...}`: useful for reliability alerts, especially `session_error`, `connection_timeout`, and `session_aborted`.

For autoscaling, use worker occupancy:

```text
idle_workers = connected_workers - active_sessions
utilization_percent = active_sessions / connected_workers * 100
recommended_capacity = connected_workers + max(target_idle_workers - idle_workers, 0)
```

Do not scale out on `connected` alone. More connected workers means more capacity, so scaling up when `connected` increases creates a feedback loop. Use `connected` as the denominator for utilization and as an alert when ECS tasks are running but workers are not connected.

This lab uses a scheduled Lambda metrics publisher instead of scraping every Fargate task. The publisher lists the ECS service's running task private IPs, calls Cursor's worker list API, matches Cursor workers whose names contain those task IPs, writes `Connected`, `InUse`, `Idle`, and `UtilizationPercent` to CloudWatch, and ECS Service Auto Scaling target-tracks `UtilizationPercent`.

The Cursor summary endpoint is team-wide, so it should not be used directly when multiple self-hosted pools share the same Cursor team. A team-wide denominator can hide saturation in the ECS pool and prevent scale-out.

The publisher also performs dynamic scale-out from the same metrics. When `Idle` falls below `ECS_TARGET_IDLE_WORKERS`, it calls `ecs:UpdateService` to increase desired count up to `max_capacity`. It only scales out; target tracking and the long scale-in cooldown handle scale-in after workers are idle.

Good starting defaults:

- `min_capacity`: `1` for demos, `2` for teams that need less cold-start latency.
- `max_capacity`: `5` by default, bounded by the Cursor team worker limit and cost policy.
- `target_idle_workers`: `1`, so the service tries to keep one warm worker available.
- `target_utilization_percent`: `75`.
- Scale out cooldown: `60` seconds.
- Scale in cooldown: `600` to `900` seconds.
- `CURSOR_WORKER_IDLE_RELEASE_TIMEOUT`: `600`; ECS desired count is still the source of truth for fleet size.

The Terraform path also adds a fast step-scaling alarm for bursty demos. AWS target tracking uses multiple evaluation periods, so it can be too slow when the service starts at one worker and several sessions arrive at once. Dynamic scale-out from the publisher is the fastest path; the fast alarm is a backup CloudWatch path, while target tracking still manages normal steady-state scaling and scale-in.

The per-worker `/metrics` endpoint remains useful for dashboards and debugging. Scraping it from Fargate requires service discovery plus Prometheus, ADOT, or CloudWatch Agent plumbing, so it is a secondary path for this lab.

## How Metrics Publishing Works

Terraform packages `terraform/metrics_publisher.py` as a Lambda function. EventBridge invokes it on `metrics_publish_schedule_expression`, which defaults to `rate(1 minute)`.

Each run does four things:

1. Reads the Cursor service account key from Secrets Manager.
2. Lists running ECS tasks for this service and records their private IPs.
3. Calls Cursor's worker list API and matches Cursor workers back to ECS tasks by private IP in the worker name.
4. Publishes service-scoped metrics to CloudWatch under `Cursor/SelfHostedWorkers`.

The Lambda publishes capacity and recommendation metrics:

```text
Connected
InUse
Idle
UtilizationPercent
DesiredCount
RunningTasks
RecommendedCapacity
TargetIdleWorkers
```

When dynamic scale-out is enabled and the service has fewer idle workers than `ECS_TARGET_IDLE_WORKERS`, the Lambda calls `ecs:UpdateService` with a higher desired count, capped by `ECS_MAX_CAPACITY`. ECS then starts new Fargate tasks from the task definition. Those tasks pull the worker image, read the Cursor API key from Secrets Manager, initialize the git workspace, start `agent worker`, and register back into the configured Cursor pool.

The Lambda does not scale in directly. Scale-in remains with Application Auto Scaling and the longer cooldown so active sessions are not interrupted by an aggressive controller.

## Enterprise Guidance

For ECS/Fargate, this scheduled Lambda pattern is a reasonable implementation when a team wants a simple AWS-native control loop without running Prometheus or a separate controller. It keeps secrets in Secrets Manager, metrics in CloudWatch, scaling in ECS/Application Auto Scaling, and the worker service private and outbound-only.

Larger enterprise deployments may prefer a more formal controller pattern:

- On Kubernetes or EKS, use the Cursor worker-set controller with Prometheus scraping worker `/metrics` and a scaler that patches `WorkerDeployment.spec.readyReplicas`. Plain HPA/KEDA can be blocked by CRD scale-selector requirements, so validate the chosen scaler against the Cursor CRD.
- On ECS/Fargate, keep this Lambda pattern but harden it with alarms, dashboards, least-privilege IAM, reserved concurrency only if the account quota supports it, and separate pools/services per team, repo, or environment.
- For very bursty workloads, set `min_capacity` or `ECS_TARGET_IDLE_WORKERS` high enough to keep warm capacity. Cursor's current worker metrics show connected and active workers, but they do not expose queued demand before a session claims a worker.

## Setup Sequence

At a high level, the ECS/Fargate path follows this order. See [`terraform/README.md`](terraform/README.md) for the exact commands and variables.

1. Configure `.env` with AWS defaults, the Cursor service account key, the target repo, and an ECS-specific worker pool name.
2. Apply Terraform to create ECS, ECR, IAM, Secrets Manager metadata, logs, metrics publishing, and autoscaling.
3. Upload the Cursor service account key into Secrets Manager.
4. Build and push the worker image to ECR.
5. Force a new ECS deployment if the service started before the secret or image existed.
6. Select the ECS self-hosted pool in Cursor Cloud Agents.

## Validation

Validate three layers: ECS service health, worker registration, and autoscaling metrics. The implementation guide includes the exact AWS CLI commands for each check.

A healthy worker log includes:

```text
Worker is now running
Registering to worker pool
Repo: <owner>/<repo>
Pool: <pool-name>
```

CloudWatch should show a service-scoped `UtilizationPercent` metric under `Cursor/SelfHostedWorkers` with `PoolName`, `ClusterName`, and `ServiceName` dimensions.

## Cleanup

To stop AWS spend after a demo:

```bash
terraform -chdir=ecs/terraform destroy
```

Because this lab sets the ECR repository to force-delete, Terraform can remove the repository even if it contains demo images.

## Common Blockers

### Fargate Tasks Start Before The Image Or Secret Exists

The ECS service pulls the configured image and injects the Secrets Manager value at task startup. If either is missing, tasks stop quickly. Upload the secret with `aws secretsmanager put-secret-value`, push the image with `make ecr-build-push`, then force a new service deployment.

### ECR Repository Already Exists

If an existing demo repository uses the same `ECR_REPOSITORY_NAME`, either import it into `ecs/terraform` state or set `create_ecr_repository=false` and use the existing repository as a data source. Importing keeps cleanup behavior consistent with the lab.

### Lambda Reserved Concurrency Fails

Some sandbox accounts have a low regional Lambda concurrency quota. This lab does not reserve concurrency for the metrics publisher, because setting even one reserved execution can fail if it would drop the account's unreserved concurrency below AWS's minimum.

### Worker Directory Is Not A Git Repo

Cursor derives the repo label from the worker directory's git remote. Fargate tasks start with empty ephemeral storage, so the shared Docker entrypoint initializes `/workspace` as a minimal git repo when `WORKER_REPOSITORY_URL` is set.

### Fleet API Metrics Are Team-Wide

The summary endpoint returns user and team counts. This ECS path uses the worker list endpoint plus ECS task private IPs to isolate utilization to this service. If the Cursor API later exposes pool labels in list responses, prefer filtering directly by `pool` label.

### ECS Pool Is Full But Autoscaling Does Not Add Tasks

Symptom: one ECS worker is already claimed by a Cloud Agent session, a second session stays blocked, and ECS remains at `desired_count=1`.

First confirm the autoscaling metric is service-scoped. If `connected` includes every self-hosted worker in the Cursor team instead of only this ECS service, utilization can look low even while this pool is saturated. The implementation guide includes the Lambda invocation and expected response shape for checking this.

After the metric is fixed, CloudWatch target-tracking alarms still need multiple fresh datapoints before scaling. For bursty demos, keep the fast step-scaling alarm enabled or temporarily raise the ECS service desired count.

### Burst Sessions Error Before New Tasks Are Ready

The available Cursor metrics show connected workers and active sessions, not queued or blocked sessions. If three users start sessions while the service has only one connected worker, the scaler can only react after that first worker becomes active and the next scheduled metrics publisher run observes `Idle=0`.

For customer demos that need no-wait bursts, set `min_capacity` to the expected simultaneous session count. For cost-conscious defaults, keep `min_capacity=1`, `target_idle_workers=1`, and explain that new Fargate tasks still need time to start, run the container entrypoint, connect to Cursor, and register in the selected pool.

### Dynamic Scale-Out Does Not Reduce Desired Count

The metrics publisher only scales out. This avoids a Lambda racing against Application Auto Scaling and terminating workers while sessions are still active. Scale-in is handled by the target-tracking policy after the longer scale-in cooldown.

If the service remains above the baseline after a burst, inspect the target-tracking low alarm, recent datapoints, and Application Auto Scaling activity history.

### Scaling From Zero Has No Connected Denominator

If `min_capacity` is `0`, there may be no connected worker count to divide by. Keep at least one warm worker unless you add a separate scheduled or queue-based scale-from-zero signal.

### Service Auto Scaling Changes Desired Count

Terraform creates the initial ECS service desired count, then ignores later desired count drift so Application Auto Scaling can manage it. Change `min_capacity`, `max_capacity`, or the scaling policy instead of repeatedly forcing `desired_count` back with Terraform.

## Files

- `task-definition.example.json` shows the worker container command, environment variables, and secret reference expected by ECS.
- `terraform/` provisions the Fargate service and the Cursor utilization metrics publisher.

Replace placeholder ARNs, image names, and CPU/memory values before registering the task definition.
