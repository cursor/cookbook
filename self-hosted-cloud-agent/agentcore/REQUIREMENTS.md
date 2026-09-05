# AgentCore Runtime Requirements

Requirements for running Cursor self-hosted cloud agent pool workers on Amazon Bedrock AgentCore
Runtime using the **Instances** compute type.

Every AWS behavior asserted here is cited to a documentation page. Claims that the documentation does
not settle are collected in [Open Questions](#open-questions) rather than guessed at. Do not treat an
open question as a detail — two of them can change the deployment shape.

## 1. Goal

Add `agentcore/` as a fourth deployment target alongside `ec2/`, `ecs/`, and `eks/`. Cursor continues
to own orchestration, model inference, and the Cloud Agents experience. The worker runs inside the
customer's AWS account on EC2 instances that AgentCore provisions and operates, so repository code,
build output, and internal network access stay in the customer account.

## 2. The Central Design Problem

The two contracts do not match, and this is the whole reason the target needs an adapter.

| | Cursor self-hosted worker | AgentCore Runtime |
| --- | --- | --- |
| Direction | Outbound only. Dials Cursor and waits for work. | Inbound. Expects an HTTP server. |
| Interface | `agent worker --pool ... start`, a long-lived process | `GET /ping` and `POST /invocations` on port 8080 |
| Lifetime | Runs until stopped | Session terminated after 15 minutes idle |
| Entry | Process starts with the container | Session exists only after `InvokeAgentRuntime` |

A worker waiting for work performs no HTTP request/response cycle at all, so a naive port of the
sibling containers would be reaped after 15 minutes.

### The Resolution

AgentCore documents the exact mechanism needed. `GET /ping` returns one of two statuses, and the
second one keeps the session alive:

> `HealthyBusy` — System is operational but currently busy with async tasks. While the status is
> `HealthyBusy`, the runtime session is considered active and is kept alive.
>
> — [runtime-http-protocol-contract](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-http-protocol-contract.html)

> A session in idle state (`"Healthy"`) for 15 minutes gets automatically terminated. A session
> returning `"HealthyBusy"` remains alive beyond the idle timeout.
>
> — [runtime-long-run](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-long-run.html)

So the container runs a supervising adapter as PID 1. The adapter satisfies the HTTP contract, forks
`agent worker` as a child, and reports `HealthyBusy` for as long as that child is alive. The ping
status is the keepalive. There is no separate keepalive API.

This is a supported pattern, not a workaround: AgentCore lists "Background task handling for
operations that exceed request/response cycles" and "Automatic status tracking via the `/ping`
endpoint" as Runtime features.

## 3. Why Instances And Not microVMs

| Characteristic | microVMs | Instances |
| --- | --- | --- |
| Maximum session duration | 8 hours | **14 days** |
| Operating systems | Linux containers (`arm64`) | Linux (`x86_64` and `arm64`) |
| Networking | `PUBLIC` or VPC | **VPC only** |
| Agents per session | 1:1 | 1:N (max 20) |
| Persistent storage across restarts | Session storage, 1 GB | **EBS volumes, up to 5, 65536 GiB each** |
| GPU | Not supported | `g4dn`, `g5`, `g6`, `g6e`, `gr6`, `g6f`, `gr6f`, `g7e`, `inf2` |
| Pricing | Billed by AgentCore | EC2 in your account; Savings Plans and ODCRs apply |

Source: [runtime-instances-how-it-works](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-instances-how-it-works.html)

An 8-hour ceiling and 1 GB of session storage do not suit a CI-runner-shaped workload that clones
repositories and caches dependencies. Instances is the only compute type that fits.

## 4. Functional Requirements

### 4.1 Adapter

- **FR-1** Serve `GET /ping` on `0.0.0.0:8080` returning HTTP 200 and `{"status": ...}`.
- **FR-2** Report `HealthyBusy` while the supervised worker process is alive, and `Healthy` once it
  has permanently stopped, so an abandoned session becomes idle-eligible and is reaped.
- **FR-3** Set `time_of_last_update` **only on an actual status transition**. The documentation is
  explicit that getting this wrong leaks money:

  > A timestamp that advances on every ping signals a continuous status change, which prevents the
  > idle session timeout from ever firing — sessions then persist until `MaxLifetime` and can exhaust
  > your session quota.

- **FR-4** Never block the ping path. Health state must be served from cached state, with the child
  process supervised on a separate thread. The documented failure mode is a session terminated at 15
  minutes because "the application is single threaded and the ping thread is blocked."
- **FR-5** Serve `POST /invocations`. It is required by the contract and cannot be omitted. It returns
  worker status and supports explicit `status`, `restart`, and `stop` actions.
- **FR-6** Read session identity from the `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` request
  header. No environment variable carries it.
- **FR-7** Supervise the worker: restart it with backoff on unexpected exit, up to a configured limit.
  Once that budget is spent, stop reporting busy so the session becomes idle-eligible and is reaped,
  rather than holding an instance that does no work. Reporting HTTP 503 instead is available behind
  `AGENTCORE_UNHEALTHY_ON_FAILURE` but is off by default, because the unhealthy threshold is
  undocumented — see [OQ-8](#oq-8-ping-frequency-and-unhealthy-threshold).
- **FR-8** Run `agent worker` with options **before** the `start` subcommand, matching
  `docker/entrypoint.sh` and the failure mode documented at `ec2/README.md:140`.

### 4.2 Worker Configuration

- **FR-9** Accept the same environment contract as the sibling targets: `CURSOR_API_KEY`,
  `CURSOR_WORKER_POOL_NAME`, `CURSOR_WORKER_IDLE_RELEASE_TIMEOUT`, `CURSOR_WORKER_DIR`,
  `CURSOR_WORKER_LABELS_FILE`, `CURSOR_WORKER_LABELS_JSON`, `WORKER_REPOSITORY_URL`.
- **FR-10** Default `CURSOR_WORKER_DIR` to `/mnt/workspace`, not `/workspace`. Mount paths for
  capacity provider volumes "must be under `/mnt` with exactly one subdirectory level."
- **FR-11** When `WORKER_REPOSITORY_URL` is set, initialize `/mnt/workspace` as a git
  repository, set `origin` to that URL, **fetch the remote, and check out origin's default
  branch**. An empty `git init` with only a remote is not enough: the worker then reports
  `Repo: (repo unavailable)` and Cloud Agents cannot open PRs against the GitHub repo.
  The setup must be idempotent because the volume persists across session restarts.

### 4.3 Secrets

- **FR-12** Fetch `CURSOR_API_KEY` from Secrets Manager at startup using the runtime execution role.
  AgentCore has **no** native secret injection — there is no ECS-style `valueFrom` or `secrets` field
  on `CreateAgentRuntime`. Environment variables are the only direct injection path and the docs do
  not describe them as secret or encrypted at rest.
- **FR-13** Never place the key in Terraform variables or state. Terraform creates only the secret
  container; the value is uploaded out of band. This matches the existing house rule at
  `ec2/terraform/README.md` and `ecs/terraform/README.md`.

### 4.4 Infrastructure

- **FR-14** Create a capacity provider defining OS, allowed instance types, VPC subnets and security
  groups, a persistent EBS volume, and lifecycle timers.
- **FR-15** Create an agent runtime with `capacityProviderConfiguration` and a
  `filesystemConfigurations` entry mounting the capacity provider volume.
- **FR-16** Do **not** pass `networkConfiguration` on the runtime. An Instances runtime inherits
  networking from the capacity provider, and specifying both fails with `ValidationException`.
- **FR-17** ~~Set `metadataConfiguration.requireMMDSV2 = true`.~~ **Cannot be satisfied at create
  time.** The docs state that as of June 30, 2026 the service "rejects invocations targeting runtimes
  without `metadataConfiguration` set, or with `requireMMDSV2` set to `false` or `null`", and that
  date has passed. But the property is absent from the live `AWS::BedrockAgentCore::Runtime`
  CloudFormation schema, and `CreateAgentRuntime` does not accept it either — only
  `UpdateAgentRuntime` does, where the CLI documents it as *microVM* Metadata Service configuration.
  The likeliest reading is that the requirement applies to microVM runtimes and not to Instances,
  where the EC2 IMDSv2 setting is the analogue. The Terraform sends the property only when
  `require_mmdsv2 = true`, which now defaults to **false** so the create handler accepts the desired
  state. See [OQ-10](#oq-10-mmdsv2-on-an-instances-runtime) — this is a first-run risk.
- **FR-18** Keep runtime `maxLifetime` less than or equal to the capacity provider's `maxLifetime`, or
  `CreateAgentRuntime` fails. The runtime default is 28800s, so it must be raised explicitly for
  long-lived workers.
- **FR-19** Provide scripts to start, inspect, and delete sessions, because sessions are created only
  by invocation and **cannot be listed**: "Session IDs are values that you supply on invocation, and
  there is no operation that lists the sessions on a capacity provider."

## 5. Non-Functional Requirements

- **NFR-1 Architecture.** Build `linux/arm64`. See [OQ-1](#oq-1-container-image-architecture) — this
  is the only choice safe under both readings of the docs.
- **NFR-2 Image size.** Stay under the 2 GB image limit. Keep the image under 53 layers, or use a
  numeric `USER` directive; more than 53 layers combined with a non-numeric `USER` causes an HTTP 424
  overlay mount failure.
- **NFR-3 One worker per session.** Instances allows up to 20 agents per session, but agents on an
  instance share a filesystem and credentials: "Any code running on the instance can read the
  credentials available to it" and "All agents that share an instance must be mutually trusted." Run
  one worker per session so a Cursor agent task cannot read another's credentials or workspace.
- **NFR-4 No inbound access.** The security group has no inbound rules. Egress is HTTPS and DNS only.
- **NFR-5 Encryption.** EBS volumes are encrypted; `encrypted` defaults to `true`. Encryption
  configuration is fixed at volume creation.
- **NFR-6 Region.** Default `us-west-2`. Instances is **not** available in every region — see
  [§8](#8-region-availability).

## 6. Architecture

```text
Cursor Cloud Agents  ──── outbound HTTPS (worker dials out) ────┐
                                                               │
Operator ── InvokeAgentRuntime ──▶ AgentCore Runtime           │
                                        │                      │
                                        ▼                      │
                              Capacity Provider                │
                                        │                      │
                  ┌─────────────────────▼──────────────────────┴──┐
                  │  EC2 managed instance (customer account, VPC)  │
                  │                                               │
                  │   adapter (PID 1) ── 0.0.0.0:8080             │
                  │     ├── GET  /ping  -> HealthyBusy            │
                  │     ├── POST /invocations -> status           │
                  │     └── child: agent worker --pool ... start   │
                  │                                               │
                  │   /mnt/workspace  <- persistent EBS volume     │
                  └───────────────────────────────────────────────┘
```

Invocation flow, from
[runtime-instances-how-it-works](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-instances-how-it-works.html):

1. Operator calls `InvokeAgentRuntime` with the runtime ARN and a `runtimeSessionId` of at least 33
   characters.
2. No session exists for that ID, so AgentCore provisions an EC2 instance from the capacity provider
   and launches the container. This first call is slow because it includes instance provisioning.
3. The adapter starts, fetches the API key, initializes the workspace, and forks `agent worker`.
4. The worker registers with the Cursor pool over outbound HTTPS.
5. The adapter answers `/ping` with `HealthyBusy`, so the session is kept alive past the 15-minute
   idle timeout, up to `maxLifetime`.
6. Cursor dispatches agent tasks to the worker. No further `InvokeAgentRuntime` calls are needed.

## 7. IAM

Four roles are involved. Only the execution role grants permissions to agent code.

| Role | Field | Purpose | AWS managed policy |
| --- | --- | --- | --- |
| Capacity provider operator | `permissionsConfiguration.capacityProviderOperatorRoleArn` | AgentCore assumes it to launch, tag, and terminate instances and ENIs | `BedrockAgentCoreRuntimeInstancesOperatorRolePolicy` |
| Instance profile | `launchParameters.instanceProfileArn` | System log collection only. Grants nothing to agent code | `BedrockAgentCoreRuntimeInstancesInstanceRolePolicy` |
| Runtime execution | `--role-arn` | The credentials agent code runs with | none; inline policy required |
| Service-linked | n/a | Deletion and cleanup. Not restricted by SCPs | `BedrockAgentCoreRuntimeInstancesServiceRolePolicy` |

The operator role policy is tightly scoped by AWS: EC2 creation is gated on the
`bedrock-agentcore:capacity-provider-id` request tag, management on the `ec2:ManagedResourceOperator`
condition key, Auto Scaling on the `agentcore-managed-instances-` name prefix, and EventBridge on the
`agentcore-lifecycle-events-` prefix. Instances launch only from Amazon-owned AMIs.

Execution role trust policy, verbatim from
[runtime-permissions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-permissions.html):

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "AssumeRolePolicy",
    "Effect": "Allow",
    "Principal": { "Service": "bedrock-agentcore.amazonaws.com" },
    "Action": "sts:AssumeRole",
    "Condition": {
      "StringEquals": { "aws:SourceAccount": "123456789012" },
      "ArnLike": { "aws:SourceArn": "arn:aws:bedrock-agentcore:us-east-1:123456789012:*" }
    }
  }]
}
```

The execution role needs CloudWatch Logs on `/aws/bedrock-agentcore/runtimes/*`, ECR pull on the
worker repository, X-Ray, `cloudwatch:PutMetricData` scoped to the `bedrock-agentcore` namespace, and
— added for this target — `secretsmanager:GetSecretValue` on the Cursor API key secret only.

## 8. Region Availability

Instances is supported in: us-east-1, us-east-2, us-west-2, eu-central-1, eu-west-1, ap-south-1,
ap-southeast-1, ap-southeast-2, ap-northeast-1.

It is **not** supported in: us-west-1, eu-west-2, eu-south-1, eu-west-3, eu-south-2, eu-north-1,
ap-southeast-5, ap-south-2, ap-southeast-7, ap-northeast-2, ca-central-1, sa-east-1, or GovCloud.

Source: [agentcore-regions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-regions.html)

us-east-1 and us-west-2 additionally carry a 5,000 active-session quota versus 2,500 elsewhere.

## 9. Quotas

| Quota | Value | Adjustable |
| --- | --- | --- |
| Capacity providers per account | 1,000 | No |
| Agents per capacity provider session | 20 | No |
| Active session workloads per account | 5,000 (us-east-1, us-west-2) / 2,500 | Yes |
| Docker image size | 2 GB | No |
| Environment variables per runtime | 50, value ≤ 5000 chars | No |
| Allowed instance types per capacity provider | 30 | No |
| Persistent volumes per capacity provider | 5 | No |
| New session creation rate | 25 TPS | Yes |
| Request timeout | 15 minutes | No |
| Streaming maximum duration | 60 minutes | No |

Instances also consumes the account's own EC2, EBS, VPC, and EC2 Auto Scaling quotas. The Auto
Scaling API quota is not exposed in the Service Quotas console and needs a support case to raise.

## 10. Infrastructure As Code

Neither Terraform provider can express this deployment today. Verified against the live registry and
provider sources:

| Path | Capacity provider | Runtime → capacity provider link |
| --- | --- | --- |
| `hashicorp/aws` native | Absent | Absent; no `capacity_provider_configuration` argument |
| `hashicorp/awscc` | `awscc_bedrockagentcore_capacity_provider` (≥ 1.97.0) | Absent; runtime schema is stale and wrongly requires `network_configuration` |
| `aws_cloudcontrolapi_resource` | Yes | **Yes** — `CapacityProviderConfiguration` |

Both `AWS::BedrockAgentCore::CapacityProvider` and `AWS::BedrockAgentCore::Runtime` are `PUBLIC` and
`LIVE` in the CloudFormation registry with all five handlers, and the live Runtime schema contains
`CapacityProviderConfiguration`. Cloud Control API therefore reaches the current schema at apply time
without waiting on provider codegen.

Every property in both `desired_state` blocks was checked against the live schemas with
`aws cloudformation describe-type`. Three things that reading the API reference alone would have got
wrong:

- `ProtocolConfiguration` on the Runtime is a **bare string** with enum `["MCP","HTTP","A2A","AGUI"]`,
  not an object with a `ServerProtocol` member as the API shape suggests.
- `MetadataConfiguration` does **not exist** on the Runtime type. See
  [FR-17](#44-infrastructure) and [OQ-10](#oq-10-mmdsv2-on-an-instances-runtime).
- `vpcConfiguration.subnets` caps at **16**, and `securityGroups` at 16. A default VPC in a region
  with many Availability Zones can exceed the subnet cap, so the capacity provider carries a
  `lifecycle.precondition` on the resolved subnet count rather than letting it fail mid-apply.

Read-only properties are `Arn` and `CapacityProviderId` on the capacity provider, and
`AgentRuntimeArn`, `AgentRuntimeId`, `AgentRuntimeVersion`, `Status`, `WorkloadIdentityDetails`, and
`FailureReason` on the runtime. The outputs read those names, wrapped in `try()` so a schema change
cannot fail an otherwise good apply at output time.

**Decision.** Native `aws_*` resources for VPC lookup, security groups, IAM, ECR, and Secrets
Manager. `aws_cloudcontrolapi_resource` for the two AgentCore resources. No `local-exec`, no third
provider. Revisit when `awscc_bedrockagentcore_runtime` regains the field.

Two ordering and mutability constraints must be encoded:

- The capacity provider must reach `READY` before the runtime is created.
- `ComputeConfiguration` is create-only. Changing instance types, networking, or storage **replaces**
  the capacity provider, which cascades to the runtime and destroys all sessions and their persistent
  volumes. Only `Description` and `Tags` update in place.

## 11. Lifecycle Configuration

Two similarly named structures exist. Confusing them is a likely source of bugs.

| | Capacity provider `ec2Configuration.lifecycleConfiguration` | Agent runtime `lifecycleConfiguration` |
| --- | --- | --- |
| Idle field | `idleInstanceTimeout` — default 900s; idle means all agents idle | `idleRuntimeSessionTimeout` — default 900s |
| Max field | `maxLifetime` — default 28800s, max 1209600s | `maxLifetime` — 60–1209600s on Instances |

For long-lived pool workers, set both `maxLifetime` values to the 14-day maximum and leave the idle
timeouts at their defaults. Because the adapter reports `HealthyBusy` while the worker lives, the idle
timeout fires only when the worker has permanently stopped — which is exactly the desired automatic
cleanup for a broken session.

## 12. Divergences From The Sibling Targets

Call these out in review; they are deliberate.

| Aspect | ec2 / ecs | agentcore | Reason |
| --- | --- | --- | --- |
| Worker directory | `/workspace` | `/mnt/workspace` | Volume mount paths must be under `/mnt` |
| Container entrypoint | `agent worker` directly | adapter supervises it | HTTP contract must be satisfied |
| Secret delivery | `--env-file` / task `secrets` | fetched at startup via execution role | No native secret injection |
| Workspace persistence | none | EBS volume across session restarts | Instances capability |
| Scaling | ECS Service Auto Scaling | one session per worker, invoked explicitly | No service abstraction exists |
| Start trigger | service/host boot | `InvokeAgentRuntime` | Sessions exist only after invocation |
| Architecture | `linux/amd64` default | `linux/arm64` | See OQ-1 |
| Terraform resources | native `aws_*` | plus `aws_cloudcontrolapi_resource` | Provider gap |

## 13. Acceptance Criteria

1. `make agentcore-docker-build` produces a `linux/arm64` image under 2 GB.
2. The adapter passes local contract checks: `GET /ping` returns 200 with a valid status, and
   `POST /invocations` returns worker status.
3. `/ping` reports `HealthyBusy` while the worker child is alive, and `time_of_last_update` does not
   advance between pings when the status has not changed.
4. `terraform apply` creates the capacity provider, waits for `READY`, and creates the runtime.
5. Invoking the runtime with a fresh 33-character session ID provisions an instance and the worker
   logs the canonical success signal:

   ```text
   Worker is now running
   Registering to worker pool
   Repo: <owner>/<repo>
   Pool: <pool-name>
   ```

6. The pool is visible and selectable in the Cursor Cloud Agents dashboard under **Self-Hosted**.
7. A Cursor agent task dispatched to the pool clones the repo and runs a command.
8. The session survives more than 15 minutes idle, proving the `HealthyBusy` keepalive.
9. Stopping and re-invoking the same session ID re-attaches the volume with the workspace intact.
10. Teardown removes the session, runtime, capacity provider, and EBS volumes, leaving no managed
    instances behind.

Criteria 4–10 require an AWS account and have not been executed. See
[§15](#15-validation-status).

## 14. Open Questions

### OQ-1 Container Image Architecture

**The most consequential open question.** The Instances page and release notes say Instances supports
Linux `x86_64` and `arm64`, and the capacity provider accepts `operatingSystem: LINUX_X86_64`. But
four container-contract pages still state ARM64 is required, unqualified and with no Instances
carve-out, and one says AgentCore "validates the architecture of all `.node` and `.so` files" and
fails with `CREATE_FAILED`. **No page states that image architecture must match the capacity
provider's `operatingSystem`.**

*Mitigation:* build `linux/arm64` and set `LINUX_ARM64`. This is consistent under both readings.
Test `x86_64` empirically before relying on it.

### OQ-2 Do Invocation Limits Apply To Instances

The 15-minute request timeout, 100 MB payload, 60-minute streaming, and 8-hour asynchronous job
limits are published without compute-type qualification, while the Instances pages redefine only
*session* duration as 14 days. Whether the 8-hour asynchronous ceiling caps a `HealthyBusy` session on
Instances is unresolved.

*Impact:* if the 8-hour limit does apply, effective worker lifetime is 8 hours rather than 14 days.
*Mitigation:* the adapter's restart supervision and idle-based cleanup make a shorter ceiling
survivable, but measure actual session lifetime during validation.

### OQ-3 Maximum Hardware Allocation

The quotas page lists "Maximum hardware allocation per session: 2 vCPU / 8 GB — not adjustable"
without qualifying it by compute type. If that applies to Instances it would contradict the point of
selecting instance types. It most likely describes microVMs.

*Impact:* selecting a large instance type may not deliver its full capacity.
*Mitigation:* verify with a compute-heavy build before sizing a real pool.

### OQ-4 Operator Role And Instance Profile Trust Policies

Only the *execution* role trust policy is published. The trust policies for the capacity provider
operator role and the instance profile are not documented anywhere findable, and the prerequisites
page that the getting-started guides reference for "role configuration steps" redirects away.

*Mitigation:* the Terraform infers `bedrock-agentcore.amazonaws.com` with a `SourceAccount`
condition, consistent with the documented execution role. Prefer console-created default roles if
`CreateCapacityProvider` rejects these.

### OQ-5 Where Instance System Logs Land

The instance profile grants `bedrock-agentcore:PutSystemLogEvents`, but no log group name, retention,
or console location is documented, and no Instances observability page exists.

### OQ-6 Egress And VPC Endpoints For Instances

No Instances-specific statement exists on whether public egress requires NAT, and no
Instances-specific VPC endpoint list is published. The runtime-wide guidance recommends endpoints for
ECR (`dkr`, `api`), S3 gateway, and CloudWatch Logs.

*Mitigation:* default to a VPC with existing egress; document the endpoint list as the private-subnet
path.

### OQ-7 Cold Start Time

No documented provisioning time for a new Instances session and no warm-pool or pre-provisioning
behavior. The first invocation is documented only as "takes longer."

*Impact:* unknown time-to-first-worker, which matters for burst capacity planning.

### OQ-8 Ping Frequency And Unhealthy Threshold

Neither the `/ping` poll interval, the per-ping response budget, nor the number of consecutive
failures before a session is deemed unhealthy is documented. Whether an unhealthy container is
restarted or the session destroyed is also unstated.

*Mitigation:* keep the ping handler allocation-free and non-blocking, and treat any ping slower than a
few milliseconds as a defect.

### OQ-9 Cloud Control Round-Trip Behavior

`aws_cloudcontrolapi_resource` was not applied against these types. Every property was validated
against the live schemas, but drift detection on the read handler — and whether
`CapacityProviderConfiguration` and `FilesystemConfigurations` round-trip cleanly — is untested.

*Mitigation:* the outputs decode `properties` through `try()`, so an unexpected read-handler shape
does not fail the apply.

### OQ-10 MMDSv2 On An Instances Runtime

The docs say the service rejects invocations for runtimes without `metadataConfiguration` as of
June 30, 2026, but the property cannot be set at create time: it is absent from the live
`AWS::BedrockAgentCore::Runtime` schema, and `CreateAgentRuntime` has no such parameter.
`UpdateAgentRuntime` does have `--metadata-configuration`, and the CLI describes it as *microVM*
Metadata Service configuration.

Two readings:

1. The requirement applies to microVM runtimes only. Instances runtimes are governed by EC2 IMDSv2,
   which AgentCore configures on the managed instance. Nothing needs to be set. This is the likelier
   reading, given the parameter's absence from the create API.
2. The requirement applies to all runtimes, and the create path expects the property to be set with a
   follow-up `UpdateAgentRuntime` call.

*Impact if reading 2 is correct:* the first `InvokeAgentRuntime` fails and no session ever starts.

*Mitigation:* `require_mmdsv2` defaults to `false` so the create succeeds. If invocations are rejected,
set it after apply:

```bash
aws bedrock-agentcore-control update-agent-runtime \
  --agent-runtime-id "$(terraform -chdir=terraform output -raw agent_runtime_arn | cut -d/ -f2)" \
  --metadata-configuration 'requireMMDSV2=true'
```

Resolve this on the first live apply and record the answer here.

## 15. Validation Status

Documentation research is complete and cited. **Nothing in this target has been deployed.** No AWS
resources were created, no image was built, and no session was invoked.

What has been checked:

- `terraform fmt -check` and `terraform validate` are clean against `hashicorp/aws` 5.100.0.
- Every property in both Cloud Control `desired_state` blocks was verified against the live
  CloudFormation schemas with `aws cloudformation describe-type`. That found and fixed two real
  mismatches — the `ProtocolConfiguration` shape and the absent `MetadataConfiguration` — and produced
  [OQ-10](#oq-10-mmdsv2-on-an-instances-runtime).
- `stop-runtime-session` and `invoke-agent-runtime` parameter shapes, and the 33-character session ID
  minimum, were verified against the installed CLI.
- `python3 -m py_compile` on the adapter and `bash -n` on every script pass. `shellcheck` reports only
  the expected `SC1091` for the sourced library.

Blockers to validation, in order:

1. **Docker is not installed** on the workstation, so the image cannot be built or contract-tested.
2. **AWS CLI is 2.36.1**, which has no capacity provider commands at all —
   `aws bedrock-agentcore-control help | grep capacity-provider` returns nothing. Terraform reaches the
   API through Cloud Control and does not need them, but the validation steps in
   `terraform/README.md` do. Upgrade to **≥ 2.36.18**.
3. **A Cursor service account API key** is required. It must be a service account key — user, member,
   team, personal, and organization keys are rejected for pool workers.
4. **The Cursor GitHub App** must be installed for the target repository owner and repository, and the
   GitHub integration connected at the team level, or the worker registers and then fails to clone.
5. **Permission to create AWS resources** in the target account has not been granted, so no
   `terraform apply` was run.

The adapter's own contract behavior is testable without AWS once Docker is present, using
`scripts/local-contract-test.sh`.
