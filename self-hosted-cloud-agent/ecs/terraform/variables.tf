variable "aws_region" {
  description = "AWS region for ECS, ECR, Lambda, and CloudWatch resources."
  type        = string
  default     = "us-east-1"
}

variable "aws_profile" {
  description = "Local AWS CLI profile to use while experimenting."
  type        = string
  default     = "default"
}

variable "ecs_cluster_name" {
  description = "ECS cluster name for the worker service."
  type        = string
  default     = "cursor-agents-lab"
}

variable "create_ecs_cluster" {
  description = "Whether Terraform should create the ECS cluster. Set false to use an existing cluster by name."
  type        = bool
  default     = true
}

variable "ecs_service_name" {
  description = "ECS service name for the Cursor worker tasks."
  type        = string
  default     = "cursor-worker-service"
}

variable "ecs_task_family" {
  description = "ECS task definition family for Cursor worker tasks."
  type        = string
  default     = "cursor-self-hosted-worker"
}

variable "task_cpu" {
  description = "Fargate task CPU units."
  type        = string
  default     = "1024"
}

variable "task_memory" {
  description = "Fargate task memory in MiB."
  type        = string
  default     = "2048"
}

variable "task_cpu_architecture" {
  description = "Fargate CPU architecture. Use X86_64 for linux/amd64 images or ARM64 for linux/arm64 images."
  type        = string
  default     = "X86_64"

  validation {
    condition     = contains(["X86_64", "ARM64"], var.task_cpu_architecture)
    error_message = "task_cpu_architecture must be either X86_64 or ARM64."
  }
}

variable "worker_pool_name" {
  description = "Cursor worker pool name for ECS experiments."
  type        = string
  default     = "lab"
}

variable "worker_idle_release_timeout" {
  description = "Cursor worker idle release timeout in seconds."
  type        = number
  default     = 600
}

variable "worker_environment_label" {
  description = "Cursor worker environment label value."
  type        = string
  default     = "lab"
}

variable "worker_infrastructure_label" {
  description = "Cursor worker infrastructure label value."
  type        = string
  default     = "ecs"
}

variable "worker_owner_label" {
  description = "Cursor worker owner label value."
  type        = string
  default     = "local-experiment"
}

variable "cursor_worker_management_addr" {
  description = "Management address passed to the worker container for health and metrics."
  type        = string
  default     = "0.0.0.0:8080"
}

variable "worker_repository_url" {
  description = "Git origin URL used to initialize the worker workspace in Fargate."
  type        = string
}

variable "ecr_repository_name" {
  description = "ECR repository name for the self-hosted worker image."
  type        = string
  default     = "cursor-self-hosted-worker"
}

variable "create_ecr_repository" {
  description = "Whether Terraform should create the ECR repository. Set false to use an existing repository by name."
  type        = bool
  default     = true
}

variable "worker_image_tag" {
  description = "Image tag that ECS pulls from ECR."
  type        = string
  default     = "latest"
}

variable "force_delete_ecr_repository" {
  description = "Whether Terraform can delete the ECR repository even when it contains images."
  type        = bool
  default     = true
}

variable "cursor_api_key_secret_name" {
  description = "Secrets Manager secret name that stores the Cursor service account API key."
  type        = string
  default     = "my-workers-api-key"
}

variable "create_cursor_api_key_secret" {
  description = "Whether Terraform should create the Secrets Manager secret container. Set false to use an existing secret by name."
  type        = bool
  default     = true
}

variable "secret_recovery_window_in_days" {
  description = "Secrets Manager recovery window. Use 0 for a disposable lab secret."
  type        = number
  default     = 0
}

variable "vpc_id" {
  description = "Optional VPC ID. Defaults to the account's default VPC in aws_region."
  type        = string
  default     = null
  nullable    = true
}

variable "subnet_ids" {
  description = "Optional subnet IDs for Fargate tasks. Defaults to all default VPC subnets."
  type        = list(string)
  default     = []
}

variable "assign_public_ip" {
  description = "Whether Fargate tasks get public IPs. Keep true for the default VPC demo path without NAT gateways."
  type        = bool
  default     = true
}

variable "enable_execute_command" {
  description = "Whether to enable ECS Exec for worker tasks."
  type        = bool
  default     = true
}

variable "enable_container_insights" {
  description = "Whether to enable ECS Container Insights on a newly created cluster."
  type        = bool
  default     = true
}

variable "worker_log_group_name" {
  description = "CloudWatch log group name for worker container logs."
  type        = string
  default     = "/ecs/cursor-worker-service"
}

variable "log_retention_in_days" {
  description = "CloudWatch log retention for worker and metrics publisher logs."
  type        = number
  default     = 14
}

variable "desired_count" {
  description = "Initial ECS service desired count. Defaults to min_capacity when null."
  type        = number
  default     = null
  nullable    = true
}

variable "min_capacity" {
  description = "Minimum ECS service desired count managed by Application Auto Scaling."
  type        = number
  default     = 1
}

variable "max_capacity" {
  description = "Maximum ECS service desired count managed by Application Auto Scaling."
  type        = number
  default     = 5
}

variable "target_idle_workers" {
  description = "Number of idle connected ECS workers to keep available when dynamic scale-out runs."
  type        = number
  default     = 1
}

variable "enable_dynamic_scale_out" {
  description = "Whether the metrics publisher should directly request ECS scale-out when no idle workers are available."
  type        = bool
  default     = true
}

variable "target_utilization_percent" {
  description = "Target Cursor worker utilization percentage for ECS Service Auto Scaling."
  type        = number
  default     = 75
}

variable "scale_out_cooldown_seconds" {
  description = "Cooldown in seconds after scale-out before another scale-out can occur."
  type        = number
  default     = 60
}

variable "scale_in_cooldown_seconds" {
  description = "Cooldown in seconds after scale-in before another scale-in can occur."
  type        = number
  default     = 900
}

variable "metrics_namespace" {
  description = "CloudWatch namespace for Cursor worker utilization metrics."
  type        = string
  default     = "Cursor/SelfHostedWorkers"
}

variable "metrics_publisher_name" {
  description = "Lambda function name for the Cursor fleet metrics publisher."
  type        = string
  default     = "cursor-worker-metrics-publisher"
}

variable "metrics_publish_schedule_expression" {
  description = "EventBridge schedule expression for the metrics publisher."
  type        = string
  default     = "rate(1 minute)"
}

variable "metrics_publisher_timeout_seconds" {
  description = "Lambda timeout for publishing Cursor fleet metrics."
  type        = number
  default     = 30
}

variable "cursor_workers_url" {
  description = "Cursor worker list API endpoint used by the metrics publisher."
  type        = string
  default     = "https://api.cursor.com/v0/private-workers"
}
