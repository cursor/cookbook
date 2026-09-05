locals {
  capacity_provider_properties = jsondecode(aws_cloudcontrolapi_resource.capacity_provider.properties)
  agent_runtime_properties     = jsondecode(aws_cloudcontrolapi_resource.agent_runtime.properties)
  profile_flag                 = var.aws_profile != "" ? " --profile ${var.aws_profile}" : ""

  # Property names come from the live CloudFormation schema. try() keeps a schema change
  # from failing the whole apply at output time.
  agent_runtime_arn = try(
    local.agent_runtime_properties.AgentRuntimeArn,
    local.agent_runtime_properties.Arn,
    "unknown",
  )
  agent_runtime_id = try(local.agent_runtime_properties.AgentRuntimeId, "unknown")
}

output "capacity_provider_arn" {
  description = "ARN of the AgentCore capacity provider."
  value       = local.capacity_provider_properties.Arn
}

output "capacity_provider_id" {
  description = "ID of the AgentCore capacity provider. Needed to delete sessions."
  value       = local.capacity_provider_properties.CapacityProviderId
}

output "agent_runtime_arn" {
  description = "ARN of the agent runtime. Pass this to invoke-agent-runtime."
  value       = local.agent_runtime_arn
}

output "worker_image_uri" {
  description = "Image URI the agent runtime pulls. Build and push this tag before invoking."
  value       = local.worker_image
}

output "cursor_api_key_secret_name" {
  description = "Secrets Manager secret to upload the Cursor service account key into."
  value       = aws_secretsmanager_secret.cursor_api_key.name
}

output "worker_pool_name" {
  description = "Cursor worker pool name to select in the Cloud Agents dashboard."
  value       = var.worker_pool_name
}

output "security_group_id" {
  description = "Security group applied to the worker instances."
  value       = aws_security_group.worker.id
}

output "subnet_ids" {
  description = "Subnets the capacity provider launches instances into."
  value       = local.subnet_ids
}

output "runtime_log_group" {
  description = "CloudWatch log group carrying the adapter and worker stdout for this runtime."
  value       = "/aws/bedrock-agentcore/runtimes/${local.agent_runtime_id}-DEFAULT"
}

output "start_session_command" {
  description = "Start one worker session. The session ID must be at least 33 characters."
  value = join(" ", [
    "aws bedrock-agentcore invoke-agent-runtime${local.profile_flag}",
    "--region ${var.aws_region}",
    "--agent-runtime-arn ${local.agent_runtime_arn}",
    "--runtime-session-id \"$(uuidgen | tr -d '-')cursor-worker-01\"",
    "--payload fileb://payload.json",
    "/dev/stdout",
  ])
}

output "tail_runtime_logs_command" {
  description = "Tail the runtime logs for this agent."
  value = join(" ", [
    "aws logs tail${local.profile_flag}",
    "--region ${var.aws_region}",
    "--follow",
    "/aws/bedrock-agentcore/runtimes/${local.agent_runtime_id}-DEFAULT",
  ])
}

output "list_managed_instances_command" {
  description = "List the EC2 managed instances backing sessions. Managed instances are hidden from default EC2 views."
  value = join(" ", [
    "aws ec2 describe-instances${local.profile_flag}",
    "--region ${var.aws_region}",
    "--include-managed-resources",
    "--filters \"Name=tag-key,Values=bedrock-agentcore:capacity-provider-id\"",
  ])
}
