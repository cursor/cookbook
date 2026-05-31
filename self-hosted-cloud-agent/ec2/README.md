# EC2 + Docker Guide

Use this README to understand the EC2 architecture, operating model, validation expectations, and troubleshooting paths. Use [`terraform/README.md`](terraform/README.md) for the customer-facing setup runbook with step-by-step commands.

## When To Use EC2

The EC2 + Docker path is the smallest AWS footprint in this lab. It is a good fit for demos, proofs of concept, and customers that want one self-hosted Cursor worker before adopting ECS, EKS, or Kubernetes.

Use ECS or Kubernetes instead when the customer needs autoscaling, multiple warm workers, rolling updates, cluster-level scheduling, or stronger separation between teams and workloads.

## Documentation Map

- This README: architecture, resource summary, security model, operations, validation, and troubleshooting.
- [`terraform/README.md`](terraform/README.md): customer prerequisites, `.env` setup, Terraform commands, image publishing, worker validation, updates, key rotation, and cleanup.

## What Gets Created

Terraform creates:

- One EC2 worker host.
- One ECR repository for the worker image.
- One Secrets Manager secret container for the Cursor service account key.
- One IAM role and instance profile for ECR image pulls, Secrets Manager reads, and SSM access.
- One security group with no inbound rules and outbound HTTPS/DNS.

Terraform creates only the Secrets Manager secret metadata. The service account key value is uploaded separately so it does not land in Terraform state.

## Architecture

The EC2 host runs one Docker container named `cursor-worker`. The container uses the shared worker image from ECR and connects outbound to Cursor over HTTPS. No inbound ports are required for Cursor Cloud Agents.

The worker workspace lives on the host at `/opt/cursor/worker` and is mounted into the container at `/workspace`. During bootstrap, the host initializes that directory as a minimal git repository and sets `origin` to `WORKER_REPOSITORY_URL` so Cursor can derive the repository label.

Secrets are handled outside Terraform state. The host reads the Cursor service account key from Secrets Manager during bootstrap, writes `/etc/cursor/worker.env`, and passes that file to Docker with `--env-file`.

The default image platform is `linux/amd64`, which matches `t3` and `t3a` instance types. For `t4g` instances, build `linux/arm64` images and set Terraform's `ami_architecture` variable to `arm64`.

## Bootstrap Flow

On first boot, `user_data.sh.tpl` runs on the EC2 host and:

1. Installs Docker, Git, and the AWS CLI.
2. Starts Docker.
3. Logs Docker into ECR with the instance role.
4. Fetches the Cursor service account key from Secrets Manager.
5. Writes `/etc/cursor/worker.env`.
6. Initializes `/opt/cursor/worker` as a git repo and sets the GitHub origin.
7. Pulls the worker image from ECR.
8. Starts `cursor-worker` and mounts `/opt/cursor/worker` as `/workspace`.

The worker process reads `CURSOR_API_KEY` from the Docker environment, not from a `.env` file inside the container.

## Network And Security Model

- The worker connects outbound to Cursor over HTTPS.
- The security group has no inbound rules.
- SSM Session Manager is used for administrative shell access; SSH is not required.
- The EC2 root volume is encrypted.
- IMDSv2 is required.
- The instance role can pull from the worker ECR repository, read only the configured Cursor API key secret, and use SSM.

For private subnets, make sure the subnet has NAT or equivalent egress to reach Cursor, ECR, Secrets Manager, SSM, and package repositories during bootstrap.

## Operating Model

This path runs one worker container on one EC2 instance. There is no autoscaling loop in the EC2 implementation.

After changing Docker files or the entrypoint, publish a new image and recreate the container so the host pulls the latest image. After rotating the service account key, upload the new value to Secrets Manager, refresh `/etc/cursor/worker.env`, and recreate the container. A plain `docker restart` does not reload values from `--env-file`.

## Validation

A healthy deployment has:

- One running EC2 instance.
- SSM connectivity to the instance.
- One running `cursor-worker` Docker container.
- Worker logs showing registration to the expected pool and repo.
- The self-hosted pool visible and selectable in Cursor Cloud Agents.
- Cursor GitHub App access granted to the target repository.

Useful host checks:

```bash
sudo docker ps --filter name=cursor-worker
sudo docker logs -f cursor-worker
sudo systemctl status docker
sudo tail -f /var/log/cursor-worker-bootstrap.log
```

A healthy worker log includes:

```text
Worker is now running
Registering to worker pool
Repo: <owner>/<repo>
Pool: <pool-name>
```

## Troubleshooting

### Terraform Cannot Use `aws login`

The AWS CLI can authenticate with `aws login`, but some Terraform AWS provider versions cannot read that cached login profile directly.

This repo's Make targets export temporary credentials with `aws configure export-credentials` before running Terraform. If Terraform reports `No valid credential sources found`, refresh local auth and rerun:

```bash
aws login --profile "$AWS_PROFILE"
make ec2-terraform-plan
```

### AMI Lookup Fails

Some provider versions reject `resolve:ssm:/...` AMI values in `aws_instance`.

This repo uses `data "aws_ssm_parameter"` to resolve the latest Amazon Linux 2023 AMI before passing the real AMI ID to EC2.

### Bootstrap Did Not Finish

Check the bootstrap log:

```bash
sudo tail -f /var/log/cursor-worker-bootstrap.log
```

The first boot waits for both the Secrets Manager value and the ECR image. If the secret or image did not exist before the wait expired, upload the secret, push the image, and replace the instance with Terraform or rerun the bootstrap commands through SSM.

### Image Pull Fails

Confirm the image exists in ECR, the tag matches `WORKER_IMAGE_TAG`, and the local build used the same architecture as the EC2 instance.

The default `t3.small` path expects `WORKER_PLATFORM=linux/amd64`. For Graviton, use `WORKER_PLATFORM=linux/arm64` and `ami_architecture=arm64`.

### API Key Is Invalid

Pool workers require a Cursor **service account API key**. Normal user, member, team, personal, or organization API keys are rejected.

Create the key from Cursor's Service Accounts settings, update `.env`, upload the new value to Secrets Manager, and recreate the container.

### Worker CLI Rejects Arguments

The worker options belong before the `start` subcommand. Use:

```bash
agent worker --pool --pool-name "$CURSOR_WORKER_POOL_NAME" start
```

not:

```bash
agent worker start --pool "$CURSOR_WORKER_POOL_NAME"
```

The Docker entrypoint follows the correct ordering.

### Worker Directory Is Not A Git Repo

Cursor derives the repo label from the worker directory's git remote. If `/workspace` is not inside a git repo with `origin`, startup fails.

The EC2 bootstrap initializes `/opt/cursor/worker` as a minimal git repo, sets `origin` to `WORKER_REPOSITORY_URL`, and mounts it into the container at `/workspace`.

### New Secret Value Does Not Take Effect

Docker reads `--env-file` only when the container is created. If you update Secrets Manager or `/etc/cursor/worker.env`, `docker restart` is not enough.

Recreate the container after updating the env file. The implementation guide includes copy-paste commands.

### Cloud Agents Cannot Access The Repo

A connected worker is not enough. Cursor Cloud Agents also needs GitHub App access to the target repository.

Install or update the Cursor GitHub App for the repo owner, grant access to the repository, save the GitHub App settings, and refresh the Cloud Agents page.

### No Job Logs Appear

The worker CLI does not always emit detailed per-job logs at the default log level. First confirm the worker is registered and selected in the Cloud Agents UI. Then inspect:

```bash
sudo docker logs -f cursor-worker
```

and the Cloud Agents dashboard/job UI.

## Cleanup

Destroy the EC2 resources when the demo is done to stop AWS spend. The implementation guide includes the exact cleanup command.

Because this lab sets the ECR repository to force-delete, Terraform can remove the repository even if it contains demo images.
