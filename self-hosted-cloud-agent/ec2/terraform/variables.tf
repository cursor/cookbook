variable "aws_region" {
  description = "AWS region for EC2 and ECR resources."
  type        = string
  default     = "us-east-1"
}

variable "aws_profile" {
  description = "Local AWS CLI profile to use while experimenting."
  type        = string
  default     = "default"
}

variable "worker_host_name" {
  description = "Name for the EC2 worker host and related IAM resources."
  type        = string
  default     = "cursor-worker-lab"
}

variable "instance_type" {
  description = "EC2 instance type for the worker host. Use an x86 type with the default AMI architecture."
  type        = string
  default     = "t3.small"
}

variable "worker_pool_name" {
  description = "Cursor worker pool name for EC2 experiments."
  type        = string
  default     = "lab"
}

variable "ecr_repository_name" {
  description = "ECR repository name for the self-hosted worker image."
  type        = string
  default     = "cursor-self-hosted-worker"
}

variable "worker_image_tag" {
  description = "Image tag that the EC2 host pulls from ECR."
  type        = string
  default     = "latest"
}

variable "worker_repository_url" {
  description = "Git origin URL used to initialize the worker workspace."
  type        = string
}

variable "cursor_api_key_secret_name" {
  description = "Secrets Manager secret name that stores the Cursor service account API key."
  type        = string
  default     = "cursor/service-account-api-key"
}

variable "worker_idle_release_timeout" {
  description = "Cursor worker idle release timeout in seconds."
  type        = number
  default     = 600
}

variable "cursor_worker_management_addr" {
  description = "Optional management address passed to the worker container. Leave empty for no management listener."
  type        = string
  default     = ""
}

variable "ami_architecture" {
  description = "Amazon Linux 2023 AMI architecture suffix. Use x86_64 for t3/t3a or arm64 for t4g."
  type        = string
  default     = "x86_64"

  validation {
    condition     = contains(["x86_64", "arm64"], var.ami_architecture)
    error_message = "ami_architecture must be either x86_64 or arm64."
  }
}

variable "vpc_id" {
  description = "Optional VPC ID. Defaults to the account's default VPC in aws_region."
  type        = string
  default     = null
  nullable    = true
}

variable "subnet_id" {
  description = "Optional subnet ID. Defaults to the first subnet in the selected/default VPC."
  type        = string
  default     = null
  nullable    = true
}

variable "root_volume_size_gb" {
  description = "Root EBS volume size in GiB."
  type        = number
  default     = 30
}

variable "force_delete_ecr_repository" {
  description = "Whether Terraform can delete the ECR repository even when it contains images."
  type        = bool
  default     = true
}

variable "secret_recovery_window_in_days" {
  description = "Secrets Manager recovery window. Use 0 for a disposable lab secret."
  type        = number
  default     = 0
}
