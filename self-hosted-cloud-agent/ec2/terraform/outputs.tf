output "worker_host_name" {
  description = "EC2 worker host name."
  value       = var.worker_host_name
}

output "instance_type" {
  description = "EC2 worker host instance type."
  value       = var.instance_type
}

output "worker_pool_name" {
  description = "Cursor worker pool name for this EC2 lab."
  value       = var.worker_pool_name
}

output "ecr_repository_name" {
  description = "ECR repository name for the worker image."
  value       = var.ecr_repository_name
}

output "ecr_repository_url" {
  description = "ECR repository URL for build and push commands."
  value       = aws_ecr_repository.worker.repository_url
}

output "worker_image" {
  description = "Full worker image URI that EC2 pulls on boot."
  value       = local.worker_image
}

output "cursor_api_key_secret_name" {
  description = "Secrets Manager secret name to populate with CURSOR_API_KEY."
  value       = aws_secretsmanager_secret.cursor_api_key.name
}

output "worker_instance_id" {
  description = "EC2 worker instance ID."
  value       = aws_instance.worker.id
}

output "worker_public_ip" {
  description = "Public IP assigned to the worker host. No inbound security group rules are opened."
  value       = aws_instance.worker.public_ip
}

output "ssm_start_session_command" {
  description = "Command for connecting to the worker host through SSM Session Manager."
  value       = var.aws_profile != "" ? "aws ssm start-session --profile ${var.aws_profile} --region ${var.aws_region} --target ${aws_instance.worker.id}" : "aws ssm start-session --region ${var.aws_region} --target ${aws_instance.worker.id}"
}
