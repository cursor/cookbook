output "ecs_cluster_name" {
  description = "ECS cluster name for the worker service."
  value       = local.cluster_name
}

output "ecs_service_name" {
  description = "ECS service name for Cursor worker tasks."
  value       = aws_ecs_service.worker.name
}

output "ecs_task_family" {
  description = "ECS task definition family for Cursor worker tasks."
  value       = var.ecs_task_family
}

output "worker_pool_name" {
  description = "Cursor worker pool name for this ECS lab."
  value       = var.worker_pool_name
}

output "ecr_repository_name" {
  description = "ECR repository name for the worker image."
  value       = var.ecr_repository_name
}

output "ecr_repository_url" {
  description = "ECR repository URL for build and push commands."
  value       = local.ecr_repository_url
}

output "worker_image" {
  description = "Full worker image URI that ECS pulls."
  value       = local.worker_image
}

output "cursor_api_key_secret_name" {
  description = "Secrets Manager secret name to populate with CURSOR_API_KEY."
  value       = local.cursor_api_key_secret_name
}

output "worker_log_group_name" {
  description = "CloudWatch log group for worker container logs."
  value       = aws_cloudwatch_log_group.worker.name
}

output "metrics_namespace" {
  description = "CloudWatch namespace for Cursor worker utilization metrics."
  value       = var.metrics_namespace
}

output "metrics_publisher_name" {
  description = "Lambda function name that publishes Cursor worker utilization metrics."
  value       = aws_lambda_function.metrics_publisher.function_name
}

output "describe_service_command" {
  description = "Command for inspecting the ECS service."
  value       = var.aws_profile != "" ? "aws ecs describe-services --profile ${var.aws_profile} --region ${var.aws_region} --cluster ${local.cluster_name} --services ${aws_ecs_service.worker.name}" : "aws ecs describe-services --region ${var.aws_region} --cluster ${local.cluster_name} --services ${aws_ecs_service.worker.name}"
}

output "tail_worker_logs_command" {
  description = "Command for tailing ECS worker logs."
  value       = var.aws_profile != "" ? "aws logs tail ${aws_cloudwatch_log_group.worker.name} --profile ${var.aws_profile} --region ${var.aws_region} --follow" : "aws logs tail ${aws_cloudwatch_log_group.worker.name} --region ${var.aws_region} --follow"
}
