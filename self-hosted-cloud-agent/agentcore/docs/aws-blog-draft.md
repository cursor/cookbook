---
# EDITORIAL METADATA (strip before CMS paste)
status: DRAFT — not published; AgentCore Instances lab in cursor-cookbook is design-complete and not yet applied to a live account
channel: AWS Machine Learning Blog (aws.amazon.com/blogs/machine-learning/)
estimated_read: 12 min
primary_services:
  - Amazon Bedrock AgentCore Runtime (Instances)
  - Amazon Elastic Container Registry
  - AWS Secrets Manager
  - Amazon CloudWatch
  - Amazon Elastic Compute Cloud (managed by AgentCore)
related_posts:
  - https://aws.amazon.com/blogs/machine-learning/securely-launch-and-scale-your-agents-and-tools-on-amazon-bedrock-agentcore-runtime/
  - https://aws.amazon.com/blogs/machine-learning/its-safe-to-close-your-laptop-now-hosting-coding-agents-on-amazon-bedrock-agentcore/
  - https://aws.amazon.com/blogs/machine-learning/amazon-bedrock-agentcore-is-now-generally-available/
customer_story: Mitra (मित्रम्) in https://github.com/skopp002/kaushalavardhanam — Cohort 3 of Kaushalavardhanam
---

# Run Cursor Cloud Agents on Amazon Bedrock AgentCore Runtime Instances to accelerate a robotics codebase

*How a self-hosted Cursor worker pool on AgentCore Instances keeps clone, test, and PR work for Mitra inside your AWS account—without moving the robot’s private speech pipeline to the cloud.*

---

Teams that build with coding agents often want two things that pull in opposite directions: the Cursor Cloud Agents experience (orchestration, models, review UI) and a worker that never leaves the customer VPC. Amazon Bedrock AgentCore Runtime **Instances** is the compute type that fits a CI-shaped worker: sessions up to 14 days, encrypted Elastic Block Store (EBS) volumes that remount when you re-invoke the same session, and EC2 capacity that AgentCore provisions in *your* account.

In this post, we show how to host a **Cursor self-hosted pool worker** on AgentCore Runtime Instances, and how to point that pool at a real product: **Mitra**, a Sanskrit-speaking Reachy Mini robot in the [Kaushalavardhanam](https://github.com/skopp002/kaushalavardhanam) open-source cohort repo. We also draw a hard line that is easy to miss: Mitra’s *runtime* agent (Strands + local Qwen3-VL) stays on the host Mac; AgentCore hosts the *developer* agent that improves that code.

> **Note:** A companion AWS post, [It’s safe to close your laptop now: Hosting coding agents on Amazon Bedrock AgentCore](https://aws.amazon.com/blogs/machine-learning/its-safe-to-close-your-laptop-now-hosting-coding-agents-on-amazon-bedrock-agentcore/), covers coding harnesses (including Cursor CLI) on AgentCore **microVMs**. This post is about Cursor **Cloud Agents team pools** on Runtime **Instances**—a different contract (outbound worker vs inbound HTTP agent) and a different compute type (managed EC2 + EBS vs Firecracker microVMs).

## The two agents (do not collapse them)

| | Mitra product agent | Cursor Cloud Agent on AgentCore |
| --- | --- | --- |
| Job | Wake on “mitra”, see objects, reply in spoken Sanskrit | Clone the repo, edit files, run tests, open PRs |
| Framework | Strands Agents SDK on the Mac | Cursor Cloud Agents control plane + `agent worker` |
| Where it runs | USB-tethered Reachy Mini + M1 Max host | Customer VPC, AgentCore-managed EC2 |
| Privacy | Wake/ASR/TTS stay local; raw audio never leaves the host ([Mitra REQUIREMENTS](https://github.com/skopp002/kaushalavardhanam/blob/main/mitra/REQUIREMENTS.md) FR-1.2) | Worker dials Cursor over HTTPS; no inbound path to the instance |
| Cloud option | Optional Strands provider swap to Amazon Bedrock (Option B)—still not this post | This post |

Mitra’s design already documents Option B as a one-line model-provider change (`OllamaModel` → `BedrockModel`) while keeping speech on-box. That is a *product* inference path. Putting Cursor workers on AgentCore is a *software delivery* path. Mixing them produces the wrong architecture: you would either stream microphone audio into AgentCore (violating Mitra’s privacy boundary) or try to nod a robot from a session that has no USB.

The integration we recommend is: **Cursor Cloud Agents, self-hosted pool, worker image on AgentCore Instances, `WORKER_REPOSITORY_URL` = `https://github.com/skopp002/kaushalavardhanam.git`, GitHub App granted on that repo, prompts scoped to `mitra/`.**

## Why Instances instead of microVMs for this worker

Cursor pool workers are long-lived processes. They register to a pool and wait for Cloud Agent sessions. They clone repositories, install Python toolchains, and keep pytest caches. AgentCore microVMs cap sessions at eight hours and offer on the order of 1 GB of session storage. Instances support:

- Session duration up to **14 days**
- Persistent **EBS** volumes (mounted under `/mnt` with a single subdirectory, for example `/mnt/workspace`)
- Capacity in the **customer account** (Savings Plans and On-Demand Capacity Reservations apply to the EC2)
- **VPC-only** networking (no public network mode)

That matches a robotics repo: `mitra/` carries design docs, a Strands tool surface, a SQLite lexicon, and a pytest tree. Cold-cloning and re-downloading models on every task would waste both time and quota.

For the HTTP contract and keepalive behavior, see the [AgentCore Runtime HTTP protocol contract](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-http-protocol-contract.html). A session that reports `Healthy` for 15 minutes is terminated. A session that reports `HealthyBusy` stays alive. That status **is** the keepalive; there is no separate keepalive API.

## Solution overview

The shapes do not match, so a small adapter is the whole design.

- A **Cursor pool worker** is outbound-only: `agent worker --pool … start`. It never serves HTTP.
- An **AgentCore Runtime** container must listen on `0.0.0.0:8080` for `GET /ping` and `POST /invocations`, and is created only when you call `InvokeAgentRuntime`.

The lab in [cursor-cookbook `self-hosted-cloud-agent/agentcore`](https://github.com/skopp002/cursor-cookbook/tree/main/self-hosted-cloud-agent/agentcore) runs a standard-library Python adapter as PID 1. The adapter:

1. Starts the HTTP server **before** the worker so `/ping` answers immediately (a blocked ping thread is a documented cause of 15-minute session death).
2. Loads the Cursor **service account** API key from AWS Secrets Manager using the runtime execution role. AgentCore has no ECS-style `valueFrom` secret injection.
3. Initializes `/mnt/workspace` as a git repo with `origin` set to the Mitra cohort remote, idempotently (the volume survives stop/start).
4. Forks `agent worker` with options **before** the `start` subcommand.
5. Reports `HealthyBusy` while the child is alive, and advances `time_of_last_update` **only on a real status transition**. A timestamp that moves on every ping prevents idle timeout and can exhaust session quota.

Terraform creates an Amazon Elastic Container Registry (Amazon ECR) repository, a Secrets Manager secret *container* (value uploaded out of band), IAM roles, a security group with **no inbound rules** and HTTPS/DNS egress, an AgentCore **capacity provider**, and an AgentCore **agent runtime**. Sessions are not Terraform resources; you invoke them.

```
Cursor Cloud Agents  ── outbound HTTPS (worker dials out) ──┐
                                                            │
Operator ── InvokeAgentRuntime ──▶ AgentCore Runtime        │
                                     │                      │
                                     ▼                      │
                           Capacity provider                │
                                     │                      │
              ┌──────────────────────▼──────────────────────┴──┐
              │  Managed EC2 (your account, your VPC)          │
              │  adapter :8080  →  agent worker --pool start   │
              │  /mnt/workspace  ← persistent EBS (kaushala…)  │
              └────────────────────────────────────────────────┘
```

**Important:** Hashicorp AWS providers do not yet express capacity providers plus `CapacityProviderConfiguration` on the runtime. The lab uses `aws_cloudcontrolapi_resource` against the live CloudFormation types `AWS::BedrockAgentCore::CapacityProvider` and `AWS::BedrockAgentCore::Runtime`.

## Prerequisites

- Cursor **Enterprise**, with Self-Hosted Cloud Agents enabled. Team admin: Dashboard → Cloud Agents → Self-Hosted → allow (or require) self-hosted machines. Connect the Cursor GitHub App at the **team** level and grant [skopp002/kaushalavardhanam](https://github.com/skopp002/kaushalavardhanam).
- A Cursor **service account** API key. Pool workers reject user, member, team, personal, and organization keys.
  1. Dashboard → Settings → API Keys → [Service Accounts](https://cursor.com/docs/account/enterprise/service-accounts)
  2. **New Service Account** (name it after the pool, for example `mitra-agentcore-pool`)
  3. Copy the key once; store it in Secrets Manager, not in git
- AWS account in a region where Runtime **Instances** is available (for example `us-west-2`). Permissions for AgentCore, Amazon Elastic Compute Cloud (Amazon EC2), Amazon ECR, IAM, and Secrets Manager.
- A VPC whose subnets can reach Cursor, Amazon ECR, and Secrets Manager on 443 (NAT for private subnets).
- Docker Buildx (linux/arm64), Terraform ≥ 1.6, AWS CLI ≥ 2.36.18 (capacity-provider commands; Terraform itself talks Cloud Control).
- `WORKER_REPOSITORY_URL=https://github.com/skopp002/kaushalavardhanam.git`

## Walkthrough: integrate Mitra

### 1. Treat `mitra/` as the agent’s working contract

Point Cloud Agent prompts at the documents the cohort already maintains:

- [`mitra/README.md`](https://github.com/skopp002/kaushalavardhanam/blob/main/mitra/README.md) — local-first architecture
- [`mitra/REQUIREMENTS.md`](https://github.com/skopp002/kaushalavardhanam/blob/main/mitra/REQUIREMENTS.md) — FR/NFR, privacy, latency budgets
- [`mitra/DESIGN.md`](https://github.com/skopp002/kaushalavardhanam/blob/main/mitra/DESIGN.md) — Strands tools, orchestrator, Option B
- [`mitra/CLAUDE.md`](https://github.com/skopp002/kaushalavardhanam/blob/main/mitra/CLAUDE.md) — contributor instructions

Add a Cursor rule or skill in the repo (optional but high leverage) that says: do not move ASR/TTS off-box; do not call `strands-robots` `Robot`/`Policy`; hardware tests under `tests/hw/` stay skipped in CI; lexicon verified rows always win.

### 2. Pick work the cloud worker is good at

High-value, laptop-lid-safe tasks for a persistent `/mnt/workspace`:

- Expand the verified Sanskrit lexicon and the `mitra-lexicon review` path (FR-2.5, FR-2.6)
- Validator property tests (Devanagari ratio, length, English-explain waiver for FR-3.2)
- Orchestrator table-driven tests with `FakeReachy`
- Sanskrit quality harness + scoring sheet for the Phase 3 bake-off
- Safety envelope clamps on head motion (called out in DESIGN.md vs tiny-the-reachy)
- A **design-only** PR for Option B (`BedrockModel`) that does not enable cloud fallback by default

Leave on the Mac: openWakeWord false-accept tuning with live mics, USB smoke tests, Indic Parler-TTS listening checks.

### 3. Build and publish the worker image

From `self-hosted-cloud-agent/agentcore` in the cookbook (or a fork you maintain for the cohort):

```bash
cp .env.example .env
# set CURSOR_API_KEY, AWS_REGION, WORKER_REPOSITORY_URL, CURSOR_WORKER_POOL_NAME=mitra-platform-agents

make agentcore-docker-build
make agentcore-contract-test   # /ping shape + stable time_of_last_update
make agentcore-terraform-apply
make agentcore-put-api-key-secret
make agentcore-ecr-build-push
make agentcore-start-session   # save AGENTCORE_SESSION_ID (≥ 33 characters)
```

Watch CloudWatch for:

```text
Worker is now running
Registering to worker pool
Repo: skopp002/kaushalavardhanam
Pool: mitra-platform-agents
```

Then in Cursor Cloud Agents, select the **Self-Hosted** pool and dispatch a task such as: “In `mitra/`, add a pytest for validator Devanagari ratio; do not change robot SDK calls.”

### 4. Operate sessions like capacity, not like a service

AgentCore has no ECS service desired count. **N workers = N session IDs.** Sessions cannot be listed; record `AGENTCORE_SESSION_ID`. Re-invoking the same ID remounts the EBS volume (clone and caches survive). `session-status` will wake a stopped session—use it only when you intend that.

Scale-out for a hackathon weekend: start two sessions (two instance types in the capacity provider allow-list, for example `m7g.large` and `c7g.large`). Scale-in: `make agentcore-stop-session`. Destroying the capacity provider deletes sessions **and** their volumes.

### 5. Optional: ticket-to-agent without a human laptop

Service accounts can call the [Cloud Agents API](https://cursor.com/docs/account/enterprise/service-accounts). A GitHub Action or Lambda on `issues.labeled: agent` can `POST https://api.cursor.com/agents` with `repo: skopp002/kaushalavardhanam` and a prompt that includes `Work only under mitra/`. The worker that claims the job is the AgentCore session, not a volunteer’s Mac.

## Security considerations

- **One worker per session.** Instances allow up to 20 agents per session; they share filesystem and credentials. Do not co-locate untrusted agents.
- **No inbound security group rules.** Egress is 443 and DNS only.
- **Secrets.** Terraform never sees the Cursor key. Rotate from the Cursor dashboard, then `make agentcore-put-api-key-secret`, then start a **new** session so the adapter re-fetches.
- **Execution role** pulls one ECR repo, reads one secret, writes `/aws/bedrock-agentcore/runtimes/*`, and publishes metrics only in the `bedrock-agentcore` namespace.
- **Mitra privacy** is unchanged: Cloud Agents never receive microphone audio. If you later implement Option B, send session *text* and explicit camera stills only, per DESIGN.md §1.5.

## Cost and operations notes

You pay for the managed EC2 (and EBS) while a session is running, plus AgentCore control-plane usage. Because `HealthyBusy` holds the session past idle timeout, **stop sessions you are not using**. A ping handler that stamps `time_of_last_update` every time will hold instances until `MaxLifetime` (up to 14 days) and can exhaust account session quota.

Image architecture: build **linux/arm64** and set the capacity provider `operatingSystem` to `LINUX_ARM64` unless you have verified x86_64 images against the Instances contract (container-contract pages still state ARM64 without a carve-out).

## Cleanup

```bash
make agentcore-stop-session          # each session ID you created
make agentcore-terraform-destroy     # deletes volumes; irreversible
make agentcore-list-instances        # managed EC2 is hidden from default views
```

Archive the Cursor service account if the lab is over.

## Conclusion

Cursor Cloud Agents can improve Mitra without putting Mitra *on* AgentCore. The robot’s Strands loop and speech stack stay on the Reachy Mini host, which is what the privacy and latency requirements demand. AgentCore Runtime **Instances** host the outbound Cursor pool worker: same Cloud Agents UI, worker compute and git workspace in your VPC, persistent EBS for a Python robotics tree.

If you are standardizing agent hosting on AgentCore and already run other agents there, this is the path that keeps Cursor workers on the same control plane, IAM model, and CloudWatch log groups. If you instead need an autoscaling *fleet* of warm workers, Amazon Elastic Container Service (Amazon ECS) on AWS Fargate remains the better abstraction—the cookbook documents that target separately.

## Next steps

- Apply the [AgentCore Instances lab](../README.md) in `us-west-2` and run the 15-minute keepalive check.
- Grant the Cursor GitHub App on `skopp002/kaushalavardhanam` and dispatch one scoped `mitra/` PR.
- Keep Option B (Bedrock for Mitra *inference*) as a separate change set from this worker hosting design.

## About the authors

**[Author name]** is a [role] at [organization]. [Two to three sentences: what they work on, why this customer story.] In their spare time, [personal line].

**[Author name]** is a [role] at AWS. [Solutions architecture / specialist blurb.] Connect on LinkedIn.

---

### Appendix A — Sample Cloud Agent prompt (Mitra)

```text
Repository: skopp002/kaushalavardhanam
Working directory: mitra/

Read REQUIREMENTS.md and DESIGN.md before editing.

Task: Add pytest coverage for validator.py Devanagari-ratio and max-length
rules. Do not enable cloud_fallback. Do not modify src/robot/reachy.py.
Skip tests/hw. Open a PR with a short summary that cites FR-3.2 for the
English-explain waiver (do not weaken the default Sanskrit path).
```

### Appendix B — Service account (operators)

Pool authentication is documented at [Cursor Service Accounts](https://cursor.com/docs/account/enterprise/service-accounts) and [Team Pools](https://cursor.com/docs/cloud-agent/self-hosted/pool). Enterprise plan required. Copy the key at create time; rotation invalidates the previous key immediately—update Secrets Manager before the next `InvokeAgentRuntime`.
