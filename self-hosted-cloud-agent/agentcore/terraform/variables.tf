variable "aws_region" {
  description = "AWS region for the deployment. Must be a region where AgentCore Runtime Instances is available."
  type        = string
  default     = "us-west-2"

  validation {
    condition = contains([
      "us-east-1", "us-east-2", "us-west-2",
      "eu-central-1", "eu-west-1",
      "ap-south-1", "ap-southeast-1", "ap-southeast-2", "ap-northeast-1",
    ], var.aws_region)
    error_message = "aws_region must be a region where AgentCore Runtime Instances is supported."
  }
}

variable "aws_profile" {
  description = "AWS CLI profile to use. Leave empty when credentials come from the environment."
  type        = string
  default     = ""
}

# ---------------------------------------------------------------------------
# Naming
# ---------------------------------------------------------------------------

variable "capacity_provider_name" {
  description = "Capacity provider name. Letters, digits, and underscores only, starting with a letter."
  type        = string
  default     = "cursor_worker_lab"

  validation {
    condition     = can(regex("^[a-zA-Z][a-zA-Z0-9_]{0,47}$", var.capacity_provider_name))
    error_message = "capacity_provider_name must start with a letter, use only letters, digits, and underscores, and be at most 48 characters."
  }
}

variable "agent_runtime_name" {
  description = "Agent runtime name. Letters, digits, and underscores only, starting with a letter."
  type        = string
  default     = "cursor_worker"

  validation {
    condition     = can(regex("^[a-zA-Z][a-zA-Z0-9_]{0,47}$", var.agent_runtime_name))
    error_message = "agent_runtime_name must start with a letter, use only letters, digits, and underscores, and be at most 48 characters."
  }
}

variable "ecr_repository_name" {
  description = "ECR repository holding the AgentCore worker image."
  type        = string
  default     = "cursor-agentcore-worker"
}

variable "worker_image_tag" {
  description = "Image tag the agent runtime pulls. Change this to roll out a new worker image."
  type        = string
  default     = "latest"
}

variable "cursor_api_key_secret_name" {
  description = "Secrets Manager secret name holding the Cursor service account API key. Terraform creates the container only."
  type        = string
  default     = "cursor-agentcore-worker-api-key"
}

# ---------------------------------------------------------------------------
# Compute
# ---------------------------------------------------------------------------

variable "operating_system" {
  description = "Instance operating system. Keep LINUX_ARM64 unless you have verified that x86_64 container images are accepted."
  type        = string
  default     = "LINUX_ARM64"

  validation {
    condition     = contains(["LINUX_ARM64", "LINUX_X86_64"], var.operating_system)
    error_message = "operating_system must be either LINUX_ARM64 or LINUX_X86_64."
  }
}

variable "allowed_instance_types" {
  description = "Instance types the capacity provider may launch. Size these like a CI runner for the repository. Maximum 30 entries."
  type        = list(string)
  default     = ["m7g.large", "m7g.xlarge", "c7g.large"]

  validation {
    condition     = length(var.allowed_instance_types) >= 1 && length(var.allowed_instance_types) <= 30
    error_message = "allowed_instance_types must contain between 1 and 30 instance types."
  }
}

variable "workspace_volume_size_gib" {
  description = "Size of the persistent EBS workspace volume in GiB. This volume survives session stops."
  type        = number
  default     = 100
}

variable "root_volume_free_space_gib" {
  description = "Guaranteed free space on the root volume in GiB. AgentCore adds operating system overhead on top."
  type        = number
  default     = 30
}

# ---------------------------------------------------------------------------
# Networking
# ---------------------------------------------------------------------------

variable "vpc_id" {
  description = "VPC for the worker instances. Leave null to use the account default VPC in the region."
  type        = string
  default     = null
  nullable    = true
}

variable "subnet_ids" {
  description = "Subnets for the worker instances. Leave null to use all subnets in the resolved VPC. Private subnets need NAT or equivalent egress."
  type        = list(string)
  default     = null
  nullable    = true
}

# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------

variable "idle_instance_timeout" {
  description = "Seconds an instance may sit idle before it is stopped. An instance is idle when all of its agents are idle. Range 60 to 1209600."
  type        = number
  default     = 900
}

variable "capacity_provider_max_lifetime" {
  description = "Maximum instance lifetime in seconds. Defaults to the 14-day maximum for long-lived pool workers."
  type        = number
  default     = 1209600

  validation {
    condition     = var.capacity_provider_max_lifetime >= 60 && var.capacity_provider_max_lifetime <= 1209600
    error_message = "capacity_provider_max_lifetime must be between 60 and 1209600 seconds."
  }
}

variable "runtime_idle_session_timeout" {
  description = "Seconds a runtime session may report Healthy before it is terminated. Only fires once the worker has stopped, because a live worker reports HealthyBusy."
  type        = number
  default     = 900
}

variable "runtime_max_lifetime" {
  description = "Maximum runtime session lifetime in seconds. Must be less than or equal to capacity_provider_max_lifetime or CreateAgentRuntime fails."
  type        = number
  default     = 1209600
}

variable "require_mmdsv2" {
  description = "Send MetadataConfiguration.RequireMMDSV2 on the runtime. Defaults to false because the property is absent from the live CloudFormation Runtime schema and from CreateAgentRuntime, so Cloud Control rejects the desired state when it is present. Set true once the schema carries it."
  type        = bool
  default     = false
}

# ---------------------------------------------------------------------------
# Worker configuration
# ---------------------------------------------------------------------------

variable "worker_pool_name" {
  description = "Cursor worker pool name. Use an AgentCore-specific name so the pool is easy to identify in the Cursor dashboard."
  type        = string
  default     = "agentcore-platform-agents"
}

variable "worker_idle_release_timeout" {
  description = "Seconds the Cursor worker stays idle before releasing its claim."
  type        = number
  default     = 600
}

variable "worker_repository_url" {
  description = "Git remote of the application repo Cloud Agents work on (not this cookbook). Sample lab: https://github.com/kaushalavardhanam/kaushalavardhanam.git"
  type        = string
}

variable "worker_environment_label" {
  description = "Value for the Cursor environment label."
  type        = string
  default     = "lab"
}

variable "worker_owner_label" {
  description = "Value for the Cursor owner label."
  type        = string
  default     = "platform-team"
}

variable "worker_max_restarts" {
  description = "How many times the adapter restarts a crashed worker before letting the session go idle."
  type        = number
  default     = 5
}

# ---------------------------------------------------------------------------
# Lab conveniences
# ---------------------------------------------------------------------------

variable "force_delete_ecr_repository" {
  description = "Whether Terraform may delete the ECR repository while it still holds images. Use true for a disposable lab."
  type        = bool
  default     = true
}

variable "secret_recovery_window_in_days" {
  description = "Secrets Manager recovery window. Use 0 for a disposable lab secret."
  type        = number
  default     = 0
}
