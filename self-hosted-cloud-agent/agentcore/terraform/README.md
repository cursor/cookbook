# AgentCore Implementation Guide

This is the implementation runbook for the Amazon Bedrock AgentCore Runtime **Instances** approach.

For the architecture, operating model, validation expectations, and troubleshooting guide, see [`../README.md`](../README.md). For the design rationale, citations, and open questions, see [`../REQUIREMENTS.md`](../REQUIREMENTS.md).

Run all commands from `self-hosted-cloud-agent/agentcore`. This target is self-contained and does not read the parent `.env` or `Makefile`.

**This runbook has not been executed against a live AWS account.** Steps 1 through 4 have been validated locally. Steps 5 onward create real resources and are written from the AWS documentation; treat the first run as a validation exercise and expect to resolve the open questions in [`../REQUIREMENTS.md`](../REQUIREMENTS.md) along the way.

## 1. Confirm Prerequisites

Confirm the customer has:

- Cursor Enterprise with Self-Hosted Cloud Agents enabled.
- A Cursor **service account** API key for pool workers. Member, user, team, personal, and organization keys do not work.
- The Cursor GitHub App installed for the target repo owner and repository, and the GitHub integration connected at the team level.
- AWS permissions to create Bedrock AgentCore, EC2, ECR, IAM, and Secrets Manager resources.
- A region where AgentCore Runtime Instances is available: us-east-1, us-east-2, us-west-2, eu-central-1, eu-west-1, ap-south-1, ap-southeast-1, ap-southeast-2, or ap-northeast-1.
- A VPC and subnets with outbound internet access to Cursor, ECR, and Secrets Manager. Private subnets need NAT or equivalent egress.

Install local tools:

```bash
brew install awscli terraform
```

Docker must be running locally because the worker image is built and pushed from your machine. `buildx` is required for the cross-architecture build.

Check the AWS CLI version:

```bash
aws --version
```

Capacity providers are a recent addition. Confirm your CLI knows about them:

```bash
aws bedrock-agentcore-control help | grep capacity-provider
```

If that prints nothing, upgrade with `brew upgrade awscli`. Terraform reaches the API through Cloud Control and does not need those commands, but the validation steps below do.

Also confirm the service-linked role exists, or that you can create it. AgentCore uses `AWSServiceRoleForBedrockAgentCoreRuntimeInstances` to manage the EC2 instances; its policy is not restricted by service control policies.

Authenticate to AWS and confirm the account:

```bash
aws login --profile default
aws sts get-caller-identity --profile default
```

## 2. Configure `.env`

Copy the example file:

```bash
cp .env.example .env
```

Fill in the values:

```bash
AWS_PROFILE=default
AWS_REGION=us-west-2
AWS_ACCOUNT_ID=<aws-account-id>

CURSOR_API_KEY=<cursor-service-account-api-key>
CURSOR_WORKER_POOL_NAME=agentcore-platform-agents
CURSOR_WORKER_IDLE_RELEASE_TIMEOUT=600
CURSOR_API_KEY_SECRET_NAME=cursor-agentcore-worker-api-key

ECR_REPOSITORY_NAME=cursor-agentcore-worker
WORKER_IMAGE_TAG=latest
WORKER_PLATFORM=linux/arm64
WORKER_REPOSITORY_URL=https://github.com/OWNER/REPO.git

AGENTCORE_CAPACITY_PROVIDER_NAME=cursor_worker_lab
AGENTCORE_RUNTIME_NAME=cursor_worker
AGENTCORE_OPERATING_SYSTEM=LINUX_ARM64
AGENTCORE_INSTANCE_TYPES=m7g.large,m7g.xlarge,c7g.large
AGENTCORE_WORKSPACE_VOLUME_SIZE_GIB=100
AGENTCORE_MAX_LIFETIME=1209600
AGENTCORE_IDLE_INSTANCE_TIMEOUT=900
```

Use a Cursor **service account API key**. `CURSOR_API_KEY` is used only to upload the value to Secrets Manager and for the optional live contract check; it never reaches Terraform state.

Use an AgentCore-specific pool name so the worker is easy to identify in Cursor Cloud Agents.

`WORKER_REPOSITORY_URL` should point at the repository Cloud Agents will work on. If it is empty, the Makefile defaults to the local git remote origin. The worker cannot register without it.

Capacity provider and runtime names take letters, digits, and underscores only, and must start with a letter. Hyphens are rejected.

`WORKER_PLATFORM` and `AGENTCORE_OPERATING_SYSTEM` must agree: `linux/arm64` with `LINUX_ARM64`, or `linux/amd64` with `LINUX_X86_64`. Keep arm64 unless you have verified that x86_64 images are accepted — see OQ-1 in [`../REQUIREMENTS.md`](../REQUIREMENTS.md).

Size the instance types like a CI runner for the target repository. A worker clones the repo, runs builds, and runs tests.

Leave `AGENTCORE_VPC_ID` and `AGENTCORE_SUBNET_IDS` empty to use the account default VPC and all of its subnets.

## 3. Build The Worker Image Locally

```bash
make agentcore-docker-build
```

This builds `linux/arm64` by default. On an Intel Mac the build runs under emulation and is slow; that is expected.

Confirm the image is under the 2 GB limit and under 53 layers:

```bash
docker image inspect cursor-agentcore-worker:local \
  --format 'size={{.Size}} layers={{len .RootFS.Layers}}'
```

## 4. Check The AgentCore Contract Locally

Before creating any AWS resources, confirm the adapter satisfies the container contract:

```bash
make agentcore-contract-test
```

This asserts that `GET /ping` answers 200 with a status of exactly `Healthy` or `HealthyBusy`, that `time_of_last_update` does not advance while the status is unchanged, and that `POST /invocations` reports worker state. With a real `CURSOR_API_KEY` in `.env` it also waits for the status to reach `HealthyBusy`, which proves the worker registered with Cursor.

Both timestamp behaviors matter. A status that never reaches `HealthyBusy` means the session dies at the 15-minute idle timeout. A `time_of_last_update` that advances on every ping means the idle timeout never fires and sessions leak until `MaxLifetime`.

## 5. Initialize Terraform

```bash
make agentcore-terraform-init
make agentcore-terraform-validate
```

## 6. Review The Terraform Plan

```bash
make agentcore-terraform-plan
```

Confirm the plan creates only the expected resources:

- ECR repository.
- Secrets Manager secret container for the Cursor service account key.
- Capacity provider operator IAM role, with `BedrockAgentCoreRuntimeInstancesOperatorRolePolicy` attached.
- Instance IAM role and instance profile, with `BedrockAgentCoreRuntimeInstancesInstanceRolePolicy` attached.
- Runtime execution IAM role with a least-privilege inline policy.
- Security group with no inbound rules and outbound HTTPS/DNS.
- `AWS::BedrockAgentCore::CapacityProvider` via Cloud Control.
- `AWS::BedrockAgentCore::Runtime` via Cloud Control.

Read the two Cloud Control `desired_state` blocks in the plan output carefully. They are JSON strings, so Terraform cannot type-check them; a typo in a property name surfaces as an API error at apply time rather than a plan error. Every property here was checked against the live CloudFormation schemas, but those schemas move.

Two things the plan will not tell you:

- The runtime carries no `MetadataConfiguration`, because the property is absent from the CloudFormation Runtime schema and from `CreateAgentRuntime`. If the first invocation is rejected, see OQ-10 in [`../REQUIREMENTS.md`](../REQUIREMENTS.md) for the `update-agent-runtime` follow-up.
- If you left the VPC variables empty and the default VPC has more than 16 subnets, the plan fails on a precondition rather than mid-apply. Set `AGENTCORE_SUBNET_IDS` to a shorter list.

Terraform creates the Secrets Manager secret container, but it does not store the Cursor API key value in state.

Terraform does not create a session. The worker starts in step 9.

## 7. Apply Infrastructure

```bash
make agentcore-terraform-apply
```

The capacity provider is created first and must reach `READY` before the runtime can reference it. Cloud Control waits for stabilization, so expect this step to take several minutes.

Confirm both resources:

```bash
CAPACITY_PROVIDER_ID="$(terraform -chdir=terraform output -raw capacity_provider_id)"

aws bedrock-agentcore-control get-capacity-provider \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" \
  --capacity-provider-id "$CAPACITY_PROVIDER_ID"

aws bedrock-agentcore-control get-agent-runtime \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" \
  --agent-runtime-arn "$(terraform -chdir=terraform output -raw agent_runtime_arn)"
```

If `get-capacity-provider` is not a recognized command, upgrade the AWS CLI as described in step 1.

## 8. Upload The Cursor Service Account Key And Push The Image

Both must exist before the first invocation. The adapter reads the secret at startup and AgentCore pulls the image when the session's instance launches.

```bash
make agentcore-put-api-key-secret
make agentcore-ecr-build-push
```

Confirm the image landed on the tag the runtime expects:

```bash
terraform -chdir=terraform output -raw worker_image_uri
```

## 9. Start A Worker Session

```bash
make agentcore-start-session
```

This invokes the runtime with a generated session ID, which provisions an EC2 instance, pulls the image, and starts the adapter. A cold start takes several minutes, so the read timeout is disabled rather than guessed.

**Record the session ID it prints.** Sessions come into existence only when you invoke them, and there is no API that lists the sessions on a capacity provider. Put the ID in `.env`:

```bash
AGENTCORE_SESSION_ID=cursor-worker-<uuid>
```

To run a specific ID instead, pass it explicitly:

```bash
make agentcore-start-session SESSION_ID=cursor-worker-my-own-identifier-0001
```

Session IDs must be at least 33 characters.

## 10. Validate The Worker

Confirm the instance is running:

```bash
make agentcore-list-instances
```

Managed instances are hidden from default EC2 console and API list views, which is why that target passes `--include-managed-resources`.

Ask the adapter what the worker is doing:

```bash
make agentcore-session-status
```

A healthy response has `"status": "HealthyBusy"` and `worker.running: true`.

Tail the logs:

```bash
make agentcore-logs
```

A healthy worker shows:

```text
Worker is now running
Registering to worker pool
Repo: <owner>/<repo>
Pool: <pool-name>
```

Then open Cursor Cloud Agents and confirm the self-hosted worker pool is visible and selected for the target repository. Dispatch one task to the pool and confirm the worker clones the repo and runs a command.

## 11. Prove The Keepalive

The `HealthyBusy` mechanism is the load-bearing part of this design, and only time proves it. Leave the session idle for more than 15 minutes, then check that it is still alive:

```bash
make agentcore-list-instances
make agentcore-session-status
```

If the instance is gone, the session hit the idle timeout, which means the ping status was not `HealthyBusy`. Check whether the worker exited: `make agentcore-session-status` reports `worker.last_exit_code` and `worker.last_error` when it can still be reached, and the runtime logs retain the adapter's status transitions either way.

## 12. Verify The Persistent Workspace

Stop the session and start it again with the same ID:

```bash
make agentcore-stop-session
make agentcore-start-session SESSION_ID="$AGENTCORE_SESSION_ID"
```

The EBS volume is re-attached, so the git clone and any build caches are still at `/mnt/workspace`. The adapter's workspace setup is idempotent for exactly this reason: on the second start the directory is already a git repository, and the adapter removes and re-adds `origin` so a stale remote converges.

## 13. Update The Worker Image

After changing `adapter/` or `docker/`, publish a new image:

```bash
make agentcore-ecr-build-push
```

A running session does not pull a new image. Start a fresh session to pick it up:

```bash
make agentcore-stop-session
make agentcore-start-session
```

Reusing the same session ID keeps the workspace; using a new one gets a clean volume.

If you change the image **tag** rather than overwriting one, run `make agentcore-terraform-apply` as well so the runtime points at the new tag.

## 14. Rotate The Service Account Key

Update `CURSOR_API_KEY` in `.env`, then upload the new value:

```bash
make agentcore-put-api-key-secret
```

The adapter reads the secret only at startup, so restart the worker. Either restart it in place:

```bash
AGENT_RUNTIME_ARN="$(terraform -chdir=terraform output -raw agent_runtime_arn)"
payload="$(mktemp)"
printf '%s' '{"action":"restart"}' > "$payload"

aws bedrock-agentcore invoke-agent-runtime \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" \
  --agent-runtime-arn "$AGENT_RUNTIME_ARN" \
  --runtime-session-id "$AGENTCORE_SESSION_ID" \
  --content-type application/json \
  --payload "fileb://$payload" \
  /dev/stdout

rm -f "$payload"
```

or stop and start the session, which is simpler and also picks up any image change.

## 15. Changing Instance Types, Networking, Or Storage

`ComputeConfiguration` on a capacity provider is **create-only**. Only `Description` and `Tags` update in place. Changing instance types, subnets, security groups, or volumes replaces the capacity provider, which cascades to the runtime and destroys the sessions and their persistent volumes.

Plan those changes as migrations. Confirm the plan shows a replacement before approving it, and copy anything you need off `/mnt/workspace` first.

## 16. Clean Up

Stop each session you started, then destroy:

```bash
make agentcore-stop-session SESSION_ID=<session-id>
make agentcore-terraform-destroy
```

Destroying the capacity provider stops and deletes its sessions **and their persistent storage**. That is the only way to reclaim the workspace volumes, and it is not reversible.

Confirm nothing is left behind, because managed instances remain billable while they run and are hidden from default EC2 views:

```bash
make agentcore-list-instances
```

The ECR repository is configured with force delete for lab cleanup, so Terraform can remove it even if it contains demo images.

## Safety Notes

- Do not put real service account API keys in Terraform variables or state. Terraform creates only the secret container; the value is uploaded out of band.
- Do not commit `.env`, Terraform state, AWS credentials, or private keys.
- Rotate the service account key if it is exposed in logs, shell history, or invocation output.
- Run one worker per session. Agents that share an instance share a filesystem and credentials, so a second agent on the same instance can read the first one's key and workspace.
- Verify the session count before leaving a lab running. Sessions cannot be listed, the default `maxLifetime` here is 14 days, and the instances are billed to your account.
