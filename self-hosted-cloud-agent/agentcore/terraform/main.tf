terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region  = var.aws_region
  profile = var.aws_profile != "" ? var.aws_profile : null

  default_tags {
    tags = local.common_tags
  }
}

locals {
  common_tags = {
    Project     = "self-hosted-cloud-agents-lab"
    Environment = "lab"
    ManagedBy   = "terraform"
  }

  # AgentCore has no native secret injection, so the adapter reads the key with the runtime
  # execution role. This is the env var name the adapter looks for.
  secret_id_env_name = "CURSOR_API_KEY_SECRET_ID"

  vpc_id     = var.vpc_id != null ? var.vpc_id : data.aws_vpc.default[0].id
  subnet_ids = var.subnet_ids != null ? var.subnet_ids : data.aws_subnets.default[0].ids

  worker_labels = {
    environment    = var.worker_environment_label
    infrastructure = "agentcore"
    runtime        = "agentcore-instances"
    owner          = var.worker_owner_label
  }

  worker_image = "${aws_ecr_repository.worker.repository_url}:${var.worker_image_tag}"

  # The capacity provider defines the volume; the runtime mounts it by logical name.
  workspace_volume_name = "workspace"
  workspace_mount_path  = "/mnt/workspace"

  cursor_api_key_secret_arn = aws_secretsmanager_secret.cursor_api_key.arn

  # Instances runtimes must NOT receive networkConfiguration. They inherit networking from
  # the capacity provider's vpcConfiguration, and passing both fails with ValidationException.
  agent_runtime_desired_state = merge(
    {
      AgentRuntimeName = var.agent_runtime_name
      Description      = "Cursor self-hosted pool worker on AgentCore Runtime Instances."
      RoleArn          = aws_iam_role.runtime_execution.arn

      AgentRuntimeArtifact = {
        ContainerConfiguration = {
          ContainerUri = local.worker_image
        }
      }

      CapacityProviderConfiguration = {
        CapacityProviderArn = jsondecode(
          aws_cloudcontrolapi_resource.capacity_provider.properties
        ).Arn
      }

      # A bare string, not an object. The live CloudFormation schema types this as
      # enum ["MCP","HTTP","A2A","AGUI"], unlike the API shape.
      ProtocolConfiguration = "HTTP"

      # Must be <= the capacity provider maxLifetime or CreateAgentRuntime fails. The
      # default is 28800s (8h), so a long-lived worker has to raise it explicitly.
      LifecycleConfiguration = {
        IdleRuntimeSessionTimeout = var.runtime_idle_session_timeout
        MaxLifetime               = var.runtime_max_lifetime
      }

      FilesystemConfigurations = [{
        CapacityProviderVolume = {
          VolumeName = local.workspace_volume_name
          MountPath  = local.workspace_mount_path
        }
      }]

      EnvironmentVariables = {
        CURSOR_WORKER_POOL_NAME            = var.worker_pool_name
        CURSOR_WORKER_IDLE_RELEASE_TIMEOUT = tostring(var.worker_idle_release_timeout)
        CURSOR_WORKER_DIR                  = local.workspace_mount_path
        CURSOR_WORKER_LABELS_JSON          = jsonencode(local.worker_labels)
        WORKER_REPOSITORY_URL              = var.worker_repository_url
        AGENTCORE_WORKER_MAX_RESTARTS      = tostring(var.worker_max_restarts)
        (local.secret_id_env_name)         = local.cursor_api_key_secret_arn
      }
    },
    # MetadataConfiguration is NOT in the live AWS::BedrockAgentCore::Runtime schema, and
    # CreateAgentRuntime does not accept it either — only UpdateAgentRuntime does, where the
    # CLI describes it as microVM Metadata Service configuration. So it cannot be set at
    # create time through Cloud Control, and sending it makes the create handler reject the
    # whole desired state. Defaults to off for that reason; flip require_mmdsv2 to true once
    # the schema carries the property. See OQ-10 in ../REQUIREMENTS.md.
    var.require_mmdsv2 ? {
      MetadataConfiguration = {
        RequireMMDSV2 = true
      }
    } : {}
  )
}

data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

data "aws_vpc" "default" {
  count   = var.vpc_id == null ? 1 : 0
  default = true
}

data "aws_subnets" "default" {
  count = var.subnet_ids == null ? 1 : 0

  filter {
    name   = "vpc-id"
    values = [local.vpc_id]
  }
}

# ---------------------------------------------------------------------------
# Worker image and secret
# ---------------------------------------------------------------------------

resource "aws_ecr_repository" "worker" {
  name                 = var.ecr_repository_name
  image_tag_mutability = "MUTABLE"
  force_delete         = var.force_delete_ecr_repository

  image_scanning_configuration {
    scan_on_push = true
  }
}

# Terraform creates only the secret container. Upload the value out of band so the service
# account key never enters Terraform state.
resource "aws_secretsmanager_secret" "cursor_api_key" {
  name                    = var.cursor_api_key_secret_name
  description             = "Cursor service account API key for the AgentCore worker demo."
  recovery_window_in_days = var.secret_recovery_window_in_days
}

# ---------------------------------------------------------------------------
# Networking
# ---------------------------------------------------------------------------

resource "aws_security_group" "worker" {
  name        = "${var.capacity_provider_name}-sg"
  description = "No-inbound AgentCore worker instances with outbound HTTPS and DNS."
  vpc_id      = local.vpc_id
}

resource "aws_vpc_security_group_egress_rule" "https" {
  security_group_id = aws_security_group.worker.id
  description       = "Allow outbound HTTPS."
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "dns_udp" {
  security_group_id = aws_security_group.worker.id
  description       = "Allow outbound DNS over UDP."
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "udp"
  from_port         = 53
  to_port           = 53
}

resource "aws_vpc_security_group_egress_rule" "dns_tcp" {
  security_group_id = aws_security_group.worker.id
  description       = "Allow outbound DNS over TCP."
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 53
  to_port           = 53
}

# ---------------------------------------------------------------------------
# IAM: capacity provider operator role
# ---------------------------------------------------------------------------

# Execution-role trust (documented). CreateCapacityProvider validates the operator
# role by assuming it; that call does not always present aws:SourceArn, so ArnLike
# there fails with "Role validation failed for the operator role" (OQ-4).
data "aws_iam_policy_document" "agentcore_assume_role" {
  statement {
    sid     = "AssumeRolePolicy"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["bedrock-agentcore.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values = [
        "arn:${data.aws_partition.current.partition}:bedrock-agentcore:${var.aws_region}:${data.aws_caller_identity.current.account_id}:*"
      ]
    }
  }
}

data "aws_iam_policy_document" "operator_assume_role" {
  statement {
    sid     = "AssumeRolePolicy"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["bedrock-agentcore.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_iam_role" "capacity_provider_operator" {
  name               = "${var.capacity_provider_name}-operator-role"
  description        = "Role AgentCore assumes to provision EC2 instances for the capacity provider."
  assume_role_policy = data.aws_iam_policy_document.operator_assume_role.json
}

# AWS scopes this policy by the bedrock-agentcore:capacity-provider-id request tag, the
# ec2:ManagedResourceOperator condition key, and name prefixes for Auto Scaling and
# EventBridge. Instances launch only from Amazon-owned AMIs.
resource "aws_iam_role_policy_attachment" "capacity_provider_operator" {
  role       = aws_iam_role.capacity_provider_operator.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/BedrockAgentCoreRuntimeInstancesOperatorRolePolicy"
}

# The managed operator policy only allows iam:PassRole on
# AmazonBedrockAgentCoreCapacityProviderDefaultInstanceRole*. A lab-named instance
# role therefore needs an extra PassRole grant or RunInstances fails with UnauthorizedOperation.
data "aws_iam_policy_document" "operator_pass_instance_role" {
  statement {
    sid       = "PassLabInstanceRole"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.instance.arn]

    condition {
      test     = "StringLike"
      variable = "iam:PassedToService"
      values   = ["ec2.amazonaws.com", "ec2.amazonaws.com.cn"]
    }
  }
}

resource "aws_iam_role_policy" "operator_pass_instance_role" {
  name   = "${var.capacity_provider_name}-pass-instance-role"
  role   = aws_iam_role.capacity_provider_operator.id
  policy = data.aws_iam_policy_document.operator_pass_instance_role.json
}

# ---------------------------------------------------------------------------
# IAM: instance profile
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "ec2_assume_role" {
  statement {
    sid     = "Ec2AssumeRole"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

# This role exists only so the instance can ship its own system logs. It grants nothing to
# agent code; the runtime execution role does that.
resource "aws_iam_role" "instance" {
  # Managed operator policy only PassRoles this name prefix.
  name               = "AmazonBedrockAgentCoreCapacityProviderDefaultInstanceRole-lab"
  description        = "Instance role used by AgentCore to collect system logs."
  assume_role_policy = data.aws_iam_policy_document.ec2_assume_role.json
}

resource "aws_iam_role_policy_attachment" "instance" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/BedrockAgentCoreRuntimeInstancesInstanceRolePolicy"
}

resource "aws_iam_instance_profile" "instance" {
  name = "${var.capacity_provider_name}-instance-profile"
  role = aws_iam_role.instance.name
}

# ---------------------------------------------------------------------------
# IAM: runtime execution role
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "runtime_execution" {
  statement {
    sid = "WriteRuntimeLogs"
    actions = [
      "logs:DescribeLogStreams",
      "logs:CreateLogGroup",
    ]
    resources = [
      "arn:${data.aws_partition.current.partition}:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/bedrock-agentcore/runtimes/*",
    ]
  }

  statement {
    sid       = "DescribeLogGroups"
    actions   = ["logs:DescribeLogGroups"]
    resources = ["arn:${data.aws_partition.current.partition}:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:*"]
  }

  statement {
    sid = "PutRuntimeLogEvents"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      "arn:${data.aws_partition.current.partition}:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*",
    ]
  }

  statement {
    sid       = "EcrAuthorization"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "PullWorkerImage"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [aws_ecr_repository.worker.arn]
  }

  # Added for this target: the adapter fetches the Cursor key at startup because AgentCore
  # has no valueFrom-style secret injection. Scoped to this one secret.
  statement {
    sid       = "ReadCursorApiKey"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [local.cursor_api_key_secret_arn]
  }

  statement {
    sid = "PublishTraces"
    actions = [
      "xray:PutTraceSegments",
      "xray:PutTelemetryRecords",
      "xray:GetSamplingRules",
      "xray:GetSamplingTargets",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "PublishAgentCoreMetrics"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["bedrock-agentcore"]
    }
  }

  statement {
    sid = "GetWorkloadAccessToken"
    actions = [
      "bedrock-agentcore:GetWorkloadAccessToken",
      "bedrock-agentcore:GetWorkloadAccessTokenForJWT",
    ]
    resources = [
      "arn:${data.aws_partition.current.partition}:bedrock-agentcore:${var.aws_region}:${data.aws_caller_identity.current.account_id}:workload-identity-directory/default",
      "arn:${data.aws_partition.current.partition}:bedrock-agentcore:${var.aws_region}:${data.aws_caller_identity.current.account_id}:workload-identity-directory/default/workload-identity/${var.agent_runtime_name}-*",
    ]
  }
}

resource "aws_iam_role" "runtime_execution" {
  name               = "${var.agent_runtime_name}-execution-role"
  description        = "Execution role the Cursor worker adapter runs with."
  assume_role_policy = data.aws_iam_policy_document.agentcore_assume_role.json
}

resource "aws_iam_role_policy" "runtime_execution" {
  name   = "${var.agent_runtime_name}-execution-policy"
  role   = aws_iam_role.runtime_execution.id
  policy = data.aws_iam_policy_document.runtime_execution.json
}

# ---------------------------------------------------------------------------
# AgentCore resources
#
# Neither hashicorp/aws nor hashicorp/awscc can express a capacity provider plus the
# runtime linkage today. Both CloudFormation types are PUBLIC and LIVE with all five
# handlers, and the live Runtime schema carries CapacityProviderConfiguration, so Cloud
# Control API reaches the current schema at apply time. See section 10 of
# ../REQUIREMENTS.md.
# ---------------------------------------------------------------------------

resource "aws_cloudcontrolapi_resource" "capacity_provider" {
  type_name = "AWS::BedrockAgentCore::CapacityProvider"

  # vpcConfiguration.subnets caps at 16. A default VPC in a region with many Availability
  # Zones can exceed that, and the failure would otherwise surface as an API error mid-apply.
  lifecycle {
    precondition {
      condition     = length(local.subnet_ids) >= 1 && length(local.subnet_ids) <= 16
      error_message = "The capacity provider takes between 1 and 16 subnets; got ${length(local.subnet_ids)}. Set subnet_ids explicitly."
    }
  }

  desired_state = jsonencode({
    Name        = var.capacity_provider_name
    Description = "EC2 capacity for Cursor self-hosted pool workers."

    PermissionsConfiguration = {
      CapacityProviderOperatorRoleArn = aws_iam_role.capacity_provider_operator.arn
    }

    ComputeConfiguration = {
      Ec2Configuration = {
        LaunchTemplateSource = {
          LaunchParameters = {
            OperatingSystem    = var.operating_system
            InstanceProfileArn = aws_iam_instance_profile.instance.arn

            InstanceRequirements = {
              AllowedInstanceTypes = var.allowed_instance_types
            }
          }
        }

        VpcConfiguration = {
          Subnets        = local.subnet_ids
          SecurityGroups = [aws_security_group.worker.id]
        }

        # Persistent workspace. The volume is created on the session's first launch and
        # re-attached when a stopped session is invoked again, so the git clone and any
        # caches survive session restarts.
        Volumes = [{
          EbsConfiguration = {
            Name       = local.workspace_volume_name
            SizeGiB    = var.workspace_volume_size_gib
            VolumeType = "gp3"
            Encrypted  = true
          }
        }]

        RootVolume = {
          Encrypted    = true
          FreeSpaceGiB = var.root_volume_free_space_gib
        }

        LifecycleConfiguration = {
          IdleInstanceTimeout = var.idle_instance_timeout
          MaxLifetime         = var.capacity_provider_max_lifetime
        }
      }
    }
  })

  depends_on = [
    aws_iam_role_policy_attachment.capacity_provider_operator,
    aws_iam_role_policy.operator_pass_instance_role,
    aws_iam_role_policy_attachment.instance,
  ]
}

resource "aws_cloudcontrolapi_resource" "agent_runtime" {
  type_name     = "AWS::BedrockAgentCore::Runtime"
  desired_state = jsonencode(local.agent_runtime_desired_state)

  # The capacity provider must reach READY before the runtime can reference it. The Cloud
  # Control create handler stabilizes, but the dependency is not expressed in the schema.
  depends_on = [
    aws_cloudcontrolapi_resource.capacity_provider,
    aws_iam_role_policy.runtime_execution,
  ]
}
