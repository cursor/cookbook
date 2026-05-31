SHELL := /bin/bash

-include .env
export

WORKER_IMAGE ?= cursor-self-hosted-worker:local
K8S_WORKER_IMAGE ?= $(WORKER_IMAGE)
K8S_NAMESPACE ?= cursord
WORKER_DEPLOYMENT_NAME ?= my-workers
CURSOR_API_KEY_SECRET_NAME ?= my-workers-api-key
K8S_WORKER_LABELS_FILE ?= eks/helm/labels.json
K8S_WORKER_LABELS_CONFIG_MAP ?= cursor-worker-labels
AWS_PROFILE ?= default
AWS_REGION ?= us-east-1
ECR_REPOSITORY_NAME ?= cursor-self-hosted-worker
EC2_INSTANCE_TYPE ?= t3.small
EC2_WORKER_HOST_NAME ?= cursor-worker-lab
WORKER_IMAGE_TAG ?= latest
WORKER_PLATFORM ?= linux/amd64
WORKER_REPOSITORY_URL ?= $(shell git config --get remote.origin.url 2>/dev/null)
AWS_ACCOUNT_ID_RESOLVED := $(if $(AWS_ACCOUNT_ID),$(AWS_ACCOUNT_ID),$(shell aws sts get-caller-identity --profile "$(AWS_PROFILE)" --query Account --output text 2>/dev/null))
ECR_REGISTRY := $(AWS_ACCOUNT_ID_RESOLVED).dkr.ecr.$(AWS_REGION).amazonaws.com
ECR_WORKER_IMAGE := $(ECR_REGISTRY)/$(ECR_REPOSITORY_NAME):$(WORKER_IMAGE_TAG)
EC2_TERRAFORM_VARS := \
	-var "aws_profile=" \
	-var "aws_region=$(AWS_REGION)" \
	-var "instance_type=$(EC2_INSTANCE_TYPE)" \
	-var "worker_host_name=$(EC2_WORKER_HOST_NAME)" \
	-var "worker_pool_name=$(CURSOR_WORKER_POOL_NAME)" \
	-var "worker_idle_release_timeout=$(CURSOR_WORKER_IDLE_RELEASE_TIMEOUT)" \
	-var "ecr_repository_name=$(ECR_REPOSITORY_NAME)" \
	-var "worker_image_tag=$(WORKER_IMAGE_TAG)" \
	-var "worker_repository_url=$(WORKER_REPOSITORY_URL)" \
	-var "cursor_api_key_secret_name=$(CURSOR_API_KEY_SECRET_NAME)"

.PHONY: help docker-build docker-run ecr-login ecr-build-push ec2-put-api-key-secret helm-install-controller helm-create-api-key-secret helm-render helm-apply helm-install-autoscaling helm-render-autoscaling helm-delete-autoscaling helm-delete k8s-create-api-key-secret k8s-apply k8s-delete ec2-terraform-init ec2-terraform-plan ec2-terraform-apply terraform-init terraform-plan

help:
	@echo "Targets:"
	@echo "  docker-build                  Build the shared worker image"
	@echo "  docker-run                    Run one worker locally with Docker"
	@echo "  ecr-login                     Authenticate Docker to ECR"
	@echo "  ecr-build-push                Build and push the worker image to ECR"
	@echo "  ec2-put-api-key-secret        Upload CURSOR_API_KEY to the EC2 Secrets Manager secret"
	@echo "  helm-install-controller       Install or upgrade the Cursor worker controller"
	@echo "  helm-create-api-key-secret    Create the Cursor service account API key secret"
	@echo "  helm-render                   Render the example WorkerDeployment"
	@echo "  helm-apply                    Apply Helm approach manifests"
	@echo "  helm-install-autoscaling      Install Prometheus and apply metrics autoscaling"
	@echo "  helm-render-autoscaling       Render autoscaling manifests"
	@echo "  helm-delete-autoscaling       Delete autoscaling manifests"
	@echo "  helm-delete                   Delete the example WorkerDeployment"
	@echo "  ec2-terraform-init            Initialize the EC2 Terraform scaffold"
	@echo "  ec2-terraform-plan            Plan the EC2 Terraform deployment"
	@echo "  ec2-terraform-apply           Apply the EC2 Terraform deployment"

docker-build:
	docker build -f docker/Dockerfile -t "$(WORKER_IMAGE)" .

docker-run:
	docker run --rm \
		--env CURSOR_API_KEY \
		--env CURSOR_WORKER_POOL_NAME \
		--env CURSOR_WORKER_IDLE_RELEASE_TIMEOUT \
		"$(WORKER_IMAGE)"

ecr-login:
	@if [[ -z "$(AWS_ACCOUNT_ID_RESOLVED)" ]]; then echo "AWS_ACCOUNT_ID or AWS CLI auth is required."; exit 1; fi
	aws ecr get-login-password --profile "$(AWS_PROFILE)" --region "$(AWS_REGION)" \
		| docker login --username AWS --password-stdin "$(ECR_REGISTRY)"

ecr-build-push: ecr-login
	docker buildx build \
		--platform "$(WORKER_PLATFORM)" \
		-f docker/Dockerfile \
		-t "$(ECR_WORKER_IMAGE)" \
		--push \
		.

ec2-put-api-key-secret:
	@if [[ -z "$${CURSOR_API_KEY:-}" ]]; then echo "CURSOR_API_KEY must be set in .env or the shell."; exit 1; fi
	aws secretsmanager put-secret-value \
		--profile "$(AWS_PROFILE)" \
		--region "$(AWS_REGION)" \
		--secret-id "$(CURSOR_API_KEY_SECRET_NAME)" \
		--secret-string "$${CURSOR_API_KEY}" >/dev/null
	@echo "Updated Secrets Manager value for $(CURSOR_API_KEY_SECRET_NAME)."

helm-install-controller:
	./eks/helm/scripts/install-controller.sh

helm-create-api-key-secret:
	./eks/helm/scripts/create-api-key-secret.sh

helm-render:
	@./eks/helm/scripts/render-worker-deployment.sh

helm-apply:
	./eks/helm/scripts/apply-worker-deployment.sh

helm-install-autoscaling:
	./eks/helm/scripts/install-autoscaling.sh

helm-render-autoscaling:
	@./eks/helm/scripts/render-autoscaling.sh

helm-delete-autoscaling:
	./eks/helm/scripts/delete-autoscaling.sh

helm-delete:
	./eks/helm/scripts/delete-worker-deployment.sh

k8s-create-api-key-secret: helm-create-api-key-secret

k8s-apply: helm-apply

k8s-delete: helm-delete

ec2-terraform-init:
	terraform -chdir=ec2/terraform init

ec2-terraform-plan:
	@tmpfile="$$(mktemp)"; \
	aws configure export-credentials --profile "$(AWS_PROFILE)" --format env-no-export > "$$tmpfile"; \
	set -a; source "$$tmpfile"; set +a; rm -f "$$tmpfile"; \
	terraform -chdir=ec2/terraform plan $(EC2_TERRAFORM_VARS)

ec2-terraform-apply:
	@tmpfile="$$(mktemp)"; \
	aws configure export-credentials --profile "$(AWS_PROFILE)" --format env-no-export > "$$tmpfile"; \
	set -a; source "$$tmpfile"; set +a; rm -f "$$tmpfile"; \
	terraform -chdir=ec2/terraform apply $(EC2_TERRAFORM_VARS)

terraform-init: ec2-terraform-init

terraform-plan: ec2-terraform-plan
