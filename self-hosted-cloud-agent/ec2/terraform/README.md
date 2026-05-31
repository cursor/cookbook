# EC2 Implementation Guide

This is the customer-facing implementation runbook for the EC2 + Docker approach.

For the high-level architecture, operating model, validation expectations, and troubleshooting guide, see [`../README.md`](../README.md).

Run all commands from the repository root unless noted otherwise.

## 1. Confirm Prerequisites

Confirm the customer has:

- Cursor Enterprise with Self-Hosted Cloud Agents enabled.
- A Cursor service account API key for pool workers.
- The Cursor GitHub App installed for the target repo owner and repository.
- AWS permissions to create EC2, ECR, IAM, Secrets Manager, security group, and SSM resources.
- A VPC/subnet with outbound internet access to Cursor, ECR, Secrets Manager, SSM, and package repositories.

Install local tools:

```bash
brew install awscli terraform
```

Docker must be running locally because the worker image is built and pushed from your machine.

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

Fill in the EC2 values:

```bash
AWS_PROFILE=default
AWS_REGION=us-east-1
AWS_ACCOUNT_ID=<aws-account-id>

CURSOR_API_KEY=<cursor-service-account-api-key>
CURSOR_WORKER_POOL_NAME=<customer-ec2-pool-name>
CURSOR_WORKER_IDLE_RELEASE_TIMEOUT=600
CURSOR_API_KEY_SECRET_NAME=cursor/ec2-service-account-key

ECR_REPOSITORY_NAME=cursor-self-hosted-worker
WORKER_IMAGE_TAG=latest
WORKER_PLATFORM=linux/amd64
WORKER_REPOSITORY_URL=https://github.com/OWNER/REPO.git

EC2_INSTANCE_TYPE=t3.small
EC2_WORKER_HOST_NAME=cursor-worker-lab
```

Use a Cursor **service account API key**. Normal member, user, team, personal, or organization API keys do not work for pool workers.

Use an EC2-specific pool name, such as `ec2-platform-agents`, so the worker is easy to identify in Cursor Cloud Agents.

`WORKER_REPOSITORY_URL` should point at the repository that Cloud Agents will work on. If it is empty, the Makefile defaults to the local git remote origin.

For Graviton instances, set:

```bash
WORKER_PLATFORM=linux/arm64
EC2_INSTANCE_TYPE=t4g.small
```

Then pass `-var "ami_architecture=arm64"` when running Terraform directly, or add that variable to the EC2 Terraform command in the Makefile for this lab.

## 3. Initialize Terraform

Initialize the EC2 Terraform scaffold:

```bash
make ec2-terraform-init
```

## 4. Review The Terraform Plan

Review the plan:

```bash
make ec2-terraform-plan
```

Confirm the plan creates only the expected resources:

- ECR repository.
- Secrets Manager secret container for the Cursor service account key.
- IAM role, instance profile, and least-privilege inline policy.
- SSM managed instance policy attachment.
- Security group with no inbound rules and outbound HTTPS/DNS.
- EC2 worker host.

Terraform creates the Secrets Manager secret container, but it does not store the Cursor API key value in state.

## 5. Apply Infrastructure

Apply once the customer approves the plan:

```bash
make ec2-terraform-apply
```

The EC2 instance may start before the secret value or worker image exists. The user data script waits for both for several minutes. If that wait expires, upload the secret, push the image, and replace the instance with Terraform or rerun the bootstrap commands through SSM.

## 6. Upload The Cursor Service Account Key

Upload the key from `.env` into Secrets Manager:

```bash
make ec2-put-api-key-secret
```

The EC2 host reads this secret during bootstrap and writes `/etc/cursor/worker.env`.

## 7. Build And Push The Worker Image

Build and push the Docker image to ECR:

```bash
make ecr-build-push
```

By default, this builds `linux/amd64`, which matches the default `t3.small` instance type.

## 8. Validate EC2 And SSM

Get the instance ID from Terraform outputs:

```bash
INSTANCE_ID="$(terraform -chdir=ec2/terraform output -raw worker_instance_id)"
echo "$INSTANCE_ID"
```

Check EC2 status:

```bash
aws ec2 describe-instance-status \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" \
  --instance-ids "$INSTANCE_ID" \
  --include-all-instances
```

Start an SSM session:

```bash
aws ssm start-session \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" \
  --target "$INSTANCE_ID"
```

## 9. Validate The Worker On The Host

In the SSM shell, check bootstrap logs:

```bash
sudo tail -n 200 /var/log/cursor-worker-bootstrap.log
```

Check Docker:

```bash
sudo docker ps --filter name=cursor-worker
sudo docker logs -f cursor-worker
```

A healthy worker shows:

```text
Worker is now running
Registering to worker pool
Repo: <owner>/<repo>
Pool: <pool-name>
```

Then open Cursor Cloud Agents and confirm the self-hosted worker pool is visible and selected for the target repository.

## 10. Replace The Instance If Bootstrap Timed Out

If the first boot happened before the secret value or ECR image was available, create the missing dependency first:

```bash
make ec2-put-api-key-secret
make ecr-build-push
```

Then replace the worker instance with the same Terraform variables used in the apply step:

```bash
terraform -chdir=ec2/terraform apply -replace=aws_instance.worker
```

If your AWS authentication uses `aws login`, export temporary credentials first with `aws configure export-credentials`, as shown in the cleanup step.

## 11. Update The Worker Image

After changing `docker/` or the entrypoint, publish a new image:

```bash
make ecr-build-push
```

Then start an SSM session to the host and recreate the container:

```bash
AWS_REGION=<aws-region>
ECR_WORKER_IMAGE=<account-id>.dkr.ecr.<aws-region>.amazonaws.com/<repository-name>:<tag>

aws ecr get-login-password --region "$AWS_REGION" \
  | sudo docker login --username AWS --password-stdin "${ECR_WORKER_IMAGE%/*}"

sudo docker rm -f cursor-worker
sudo docker pull "$ECR_WORKER_IMAGE"
sudo docker run -d \
  --name cursor-worker \
  --restart unless-stopped \
  --env-file /etc/cursor/worker.env \
  --volume /opt/cursor/worker:/workspace \
  "$ECR_WORKER_IMAGE"
```

## 12. Rotate The Service Account Key

Update `.env`, then upload the new value:

```bash
make ec2-put-api-key-secret
```

Start an SSM session to the host, refresh `/etc/cursor/worker.env`, and recreate the container. A plain `docker restart` does not reload environment variables from `--env-file`.

```bash
AWS_REGION=<aws-region>
CURSOR_API_KEY_SECRET_NAME=<secret-name>
CURSOR_WORKER_POOL_NAME=<customer-ec2-pool-name>
CURSOR_WORKER_IDLE_RELEASE_TIMEOUT=600
ECR_WORKER_IMAGE=<account-id>.dkr.ecr.<aws-region>.amazonaws.com/<repository-name>:<tag>

SECRET_VALUE="$(aws secretsmanager get-secret-value \
  --region "$AWS_REGION" \
  --secret-id "$CURSOR_API_KEY_SECRET_NAME" \
  --query SecretString \
  --output text)"

sudo install -d -m 0700 /etc/cursor
{
  printf 'CURSOR_API_KEY=%s\n' "$SECRET_VALUE"
  printf 'CURSOR_WORKER_POOL_NAME=%s\n' "$CURSOR_WORKER_POOL_NAME"
  printf 'CURSOR_WORKER_IDLE_RELEASE_TIMEOUT=%s\n' "$CURSOR_WORKER_IDLE_RELEASE_TIMEOUT"
  printf 'CURSOR_WORKER_LABELS_FILE=/etc/cursor/labels.json\n'
} | sudo tee /etc/cursor/worker.env >/dev/null
sudo chmod 0600 /etc/cursor/worker.env
unset SECRET_VALUE

sudo docker rm -f cursor-worker
sudo docker run -d \
  --name cursor-worker \
  --restart unless-stopped \
  --env-file /etc/cursor/worker.env \
  --volume /opt/cursor/worker:/workspace \
  "$ECR_WORKER_IMAGE"
```

## 13. Clean Up

Destroy the EC2 demo resources when finished:

```bash
tmpfile="$(mktemp)"
aws configure export-credentials --profile "$AWS_PROFILE" --format env-no-export > "$tmpfile"
set -a
source "$tmpfile"
set +a
rm -f "$tmpfile"

terraform -chdir=ec2/terraform destroy
```

Use the same Terraform variable values from the apply step if Terraform prompts for them during destroy.

The ECR repository is configured with force delete for lab cleanup, so Terraform can remove it even if it contains demo images.

## Safety Notes

- Do not put real service account API keys in Terraform variables or state.
- Do not commit `.env`, Terraform state, AWS credentials, or private keys.
- Rotate the service account key if it is exposed in logs, shell history, or SSM command output.
