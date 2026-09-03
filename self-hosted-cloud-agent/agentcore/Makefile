SHELL := /bin/bash

# This target is self-contained. Run make from the agentcore directory; the parent
# ../.env is not read.
-include .env
export

CURSOR_WORKER_POOL_NAME ?= agentcore-platform-agents
CURSOR_WORKER_IDLE_RELEASE_TIMEOUT ?= 600
CURSOR_API_KEY_SECRET_NAME ?= cursor-agentcore-worker-api-key
WORKER_REPOSITORY_URL ?= $(shell git config --get remote.origin.url 2>/dev/null)

AWS_PROFILE ?= default
AWS_REGION ?= us-west-2
ECR_REPOSITORY_NAME ?= cursor-agentcore-worker
WORKER_IMAGE_TAG ?= latest

WORKER_IMAGE ?= cursor-agentcore-worker:local
WORKER_PLATFORM ?= linux/arm64

# Docker Desktop is optional. Finch at /usr/local/bin/finch is enough to build and push.
CONTAINER_CLI ?= $(shell command -v docker 2>/dev/null || command -v finch 2>/dev/null || echo /usr/local/bin/finch)

AGENTCORE_CAPACITY_PROVIDER_NAME ?= cursor_worker_lab
AGENTCORE_RUNTIME_NAME ?= cursor_worker
AGENTCORE_OPERATING_SYSTEM ?= LINUX_ARM64
AGENTCORE_INSTANCE_TYPES ?= m7g.large,m7g.xlarge,c7g.large
AGENTCORE_WORKSPACE_VOLUME_SIZE_GIB ?= 100
AGENTCORE_MAX_LIFETIME ?= 1209600
AGENTCORE_IDLE_INSTANCE_TIMEOUT ?= 900

AWS_ACCOUNT_ID_RESOLVED := $(if $(AWS_ACCOUNT_ID),$(AWS_ACCOUNT_ID),$(shell aws sts get-caller-identity --profile "$(AWS_PROFILE)" --query Account --output text 2>/dev/null))
ECR_REGISTRY := $(AWS_ACCOUNT_ID_RESOLVED).dkr.ecr.$(AWS_REGION).amazonaws.com
ECR_WORKER_IMAGE := $(ECR_REGISTRY)/$(ECR_REPOSITORY_NAME):$(WORKER_IMAGE_TAG)

# Terraform takes list variables as HCL, so the comma-separated .env values are rewritten
# into ["a","b"] form.
comma := ,
quote := "
INSTANCE_TYPES_HCL := [$(quote)$(subst $(comma),$(quote)$(comma)$(quote),$(strip $(AGENTCORE_INSTANCE_TYPES)))$(quote)]
SUBNET_IDS_HCL := [$(quote)$(subst $(comma),$(quote)$(comma)$(quote),$(strip $(AGENTCORE_SUBNET_IDS)))$(quote)]

AGENTCORE_TERRAFORM_VARS := \
	-var "aws_profile=" \
	-var "aws_region=$(AWS_REGION)" \
	-var "capacity_provider_name=$(AGENTCORE_CAPACITY_PROVIDER_NAME)" \
	-var "agent_runtime_name=$(AGENTCORE_RUNTIME_NAME)" \
	-var "operating_system=$(AGENTCORE_OPERATING_SYSTEM)" \
	-var 'allowed_instance_types=$(INSTANCE_TYPES_HCL)' \
	-var "workspace_volume_size_gib=$(AGENTCORE_WORKSPACE_VOLUME_SIZE_GIB)" \
	-var "idle_instance_timeout=$(AGENTCORE_IDLE_INSTANCE_TIMEOUT)" \
	-var "capacity_provider_max_lifetime=$(AGENTCORE_MAX_LIFETIME)" \
	-var "runtime_max_lifetime=$(AGENTCORE_MAX_LIFETIME)" \
	-var "ecr_repository_name=$(ECR_REPOSITORY_NAME)" \
	-var "worker_image_tag=$(WORKER_IMAGE_TAG)" \
	-var "worker_pool_name=$(CURSOR_WORKER_POOL_NAME)" \
	-var "worker_idle_release_timeout=$(CURSOR_WORKER_IDLE_RELEASE_TIMEOUT)" \
	-var "worker_repository_url=$(WORKER_REPOSITORY_URL)" \
	-var "cursor_api_key_secret_name=$(CURSOR_API_KEY_SECRET_NAME)"

# Omitted rather than passed as null when unset, so the Terraform defaults resolve the
# account default VPC.
ifneq ($(strip $(AGENTCORE_VPC_ID)),)
AGENTCORE_TERRAFORM_VARS += -var "vpc_id=$(AGENTCORE_VPC_ID)"
endif
ifneq ($(strip $(AGENTCORE_SUBNET_IDS)),)
AGENTCORE_TERRAFORM_VARS += -var 'subnet_ids=$(SUBNET_IDS_HCL)'
endif

# Terraform reads credentials from the environment rather than the profile, matching the
# sibling targets, so a plan works with SSO and assumed roles alike.
define with_aws_credentials
	tmpfile="$$(mktemp)"; \
	aws configure export-credentials --profile "$(AWS_PROFILE)" --format env-no-export > "$$tmpfile"; \
	set -a; source "$$tmpfile"; set +a; rm -f "$$tmpfile";
endef

.PHONY: help agentcore-docker-build agentcore-contract-test agentcore-ecr-login \
	agentcore-ecr-build-push agentcore-put-api-key-secret agentcore-terraform-init \
	agentcore-terraform-fmt agentcore-terraform-validate agentcore-terraform-plan \
	agentcore-terraform-apply agentcore-terraform-destroy agentcore-start-session \
	agentcore-session-status agentcore-stop-session agentcore-list-instances agentcore-logs

help:
	@echo "Targets:"
	@echo "  agentcore-docker-build         Build the adapter worker image for $(WORKER_PLATFORM)"
	@echo "  agentcore-contract-test        Check the adapter against the AgentCore HTTP contract locally"
	@echo "  agentcore-ecr-login            Authenticate $(CONTAINER_CLI) to ECR"
	@echo "  agentcore-ecr-build-push       Build and push the worker image to ECR"
	@echo "  agentcore-put-api-key-secret   Upload CURSOR_API_KEY to Secrets Manager"
	@echo "  agentcore-terraform-init       Initialize the Terraform working directory"
	@echo "  agentcore-terraform-fmt        Format the Terraform files"
	@echo "  agentcore-terraform-validate   Validate the Terraform configuration"
	@echo "  agentcore-terraform-plan       Plan the capacity provider and agent runtime"
	@echo "  agentcore-terraform-apply      Apply the capacity provider and agent runtime"
	@echo "  agentcore-terraform-destroy    Destroy everything, including the workspace volumes"
	@echo "  agentcore-start-session        Invoke the runtime to boot one worker session"
	@echo "  agentcore-session-status       Report the worker state inside a session"
	@echo "  agentcore-stop-session         Stop a session and release its instance"
	@echo "  agentcore-list-instances       List the managed instances backing sessions"
	@echo "  agentcore-logs                 Tail the runtime logs"

agentcore-docker-build:
	@if [[ "$(CONTAINER_CLI)" == *finch ]]; then \
		if ! "$(CONTAINER_CLI)" vm status 2>/dev/null | grep -qi running; then \
			echo "Starting Finch VM..."; \
			"$(CONTAINER_CLI)" vm init 2>/dev/null || true; \
			"$(CONTAINER_CLI)" vm start; \
		fi; \
	fi
	"$(CONTAINER_CLI)" build \
		--platform "$(WORKER_PLATFORM)" \
		-f docker/Dockerfile \
		-t "$(WORKER_IMAGE)" \
		.

agentcore-contract-test:
	CONTAINER_CLI="$(CONTAINER_CLI)" scripts/local-contract-test.sh

agentcore-ecr-login:
	@if [[ -z "$(AWS_ACCOUNT_ID_RESOLVED)" ]]; then echo "AWS_ACCOUNT_ID or AWS CLI auth is required."; exit 1; fi
	aws ecr get-login-password --profile "$(AWS_PROFILE)" --region "$(AWS_REGION)" \
		| "$(CONTAINER_CLI)" login --username AWS --password-stdin "$(ECR_REGISTRY)"

agentcore-ecr-build-push: agentcore-ecr-login
	@if [[ "$(CONTAINER_CLI)" == *finch ]]; then \
		if ! "$(CONTAINER_CLI)" vm status 2>/dev/null | grep -qi running; then \
			echo "Starting Finch VM..."; \
			"$(CONTAINER_CLI)" vm init 2>/dev/null || true; \
			"$(CONTAINER_CLI)" vm start; \
		fi; \
	fi
	"$(CONTAINER_CLI)" build \
		--platform "$(WORKER_PLATFORM)" \
		-f docker/Dockerfile \
		-t "$(ECR_WORKER_IMAGE)" \
		.
	"$(CONTAINER_CLI)" push "$(ECR_WORKER_IMAGE)"

agentcore-put-api-key-secret:
	@if [[ -z "$${CURSOR_API_KEY:-}" ]]; then echo "CURSOR_API_KEY must be set in .env or the shell."; exit 1; fi
	aws secretsmanager put-secret-value \
		--profile "$(AWS_PROFILE)" \
		--region "$(AWS_REGION)" \
		--secret-id "$(CURSOR_API_KEY_SECRET_NAME)" \
		--secret-string "$${CURSOR_API_KEY}" >/dev/null
	@echo "Updated Secrets Manager value for $(CURSOR_API_KEY_SECRET_NAME)."

agentcore-terraform-init:
	terraform -chdir=terraform init

agentcore-terraform-fmt:
	terraform -chdir=terraform fmt

agentcore-terraform-validate:
	terraform -chdir=terraform validate

agentcore-terraform-plan:
	@$(with_aws_credentials) \
	terraform -chdir=terraform plan $(AGENTCORE_TERRAFORM_VARS)

agentcore-terraform-apply:
	@$(with_aws_credentials) \
	terraform -chdir=terraform apply $(AGENTCORE_TERRAFORM_VARS)

agentcore-terraform-destroy:
	@echo "This destroys the capacity provider, which stops and deletes its sessions"
	@echo "and their persistent workspace volumes."
	@$(with_aws_credentials) \
	terraform -chdir=terraform destroy $(AGENTCORE_TERRAFORM_VARS)

agentcore-start-session:
	scripts/start-session.sh $(SESSION_ID)

agentcore-session-status:
	scripts/session-status.sh $(SESSION_ID)

agentcore-stop-session:
	scripts/stop-session.sh $(SESSION_ID)

agentcore-list-instances:
	scripts/list-instances.sh

agentcore-logs:
	@log_group="$$(terraform -chdir=terraform output -raw runtime_log_group 2>/dev/null)"; \
	if [[ -z "$$log_group" ]]; then echo "Could not read runtime_log_group. Apply the Terraform first."; exit 1; fi; \
	aws logs tail "$$log_group" --follow --profile "$(AWS_PROFILE)" --region "$(AWS_REGION)"
