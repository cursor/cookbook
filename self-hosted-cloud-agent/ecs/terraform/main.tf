terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }

    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
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

  cluster_name = var.create_ecs_cluster ? aws_ecs_cluster.worker[0].name : data.aws_ecs_cluster.worker[0].cluster_name
  cluster_arn  = var.create_ecs_cluster ? aws_ecs_cluster.worker[0].arn : data.aws_ecs_cluster.worker[0].arn

  ecr_repository_url = var.create_ecr_repository ? aws_ecr_repository.worker[0].repository_url : data.aws_ecr_repository.worker[0].repository_url
  worker_image       = "${local.ecr_repository_url}:${var.worker_image_tag}"

  cursor_api_key_secret_arn  = var.create_cursor_api_key_secret ? aws_secretsmanager_secret.cursor_api_key[0].arn : data.aws_secretsmanager_secret.cursor_api_key[0].arn
  cursor_api_key_secret_name = var.create_cursor_api_key_secret ? aws_secretsmanager_secret.cursor_api_key[0].name : data.aws_secretsmanager_secret.cursor_api_key[0].name

  subnet_ids    = length(var.subnet_ids) > 0 ? var.subnet_ids : data.aws_subnets.default[0].ids
  vpc_id        = var.vpc_id != null ? var.vpc_id : data.aws_vpc.default[0].id
  desired_count = var.desired_count != null ? var.desired_count : var.min_capacity

  metric_dimensions = {
    PoolName    = var.worker_pool_name
    ClusterName = local.cluster_name
    ServiceName = var.ecs_service_name
  }

  worker_labels = {
    environment    = var.worker_environment_label
    infrastructure = var.worker_infrastructure_label
    runtime        = "ecs-fargate"
    owner          = var.worker_owner_label
  }
}

data "aws_vpc" "default" {
  count   = var.vpc_id == null ? 1 : 0
  default = true
}

data "aws_subnets" "default" {
  count = length(var.subnet_ids) == 0 ? 1 : 0

  filter {
    name   = "vpc-id"
    values = [local.vpc_id]
  }
}

data "aws_ecs_cluster" "worker" {
  count        = var.create_ecs_cluster ? 0 : 1
  cluster_name = var.ecs_cluster_name
}

data "aws_ecr_repository" "worker" {
  count = var.create_ecr_repository ? 0 : 1
  name  = var.ecr_repository_name
}

data "aws_secretsmanager_secret" "cursor_api_key" {
  count = var.create_cursor_api_key_secret ? 0 : 1
  name  = var.cursor_api_key_secret_name
}

data "aws_iam_policy_document" "ecs_tasks_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "task_execution_secret" {
  statement {
    sid       = "ReadCursorApiKey"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [local.cursor_api_key_secret_arn]
  }
}

data "aws_iam_policy_document" "metrics_publisher" {
  statement {
    sid = "WriteLambdaLogs"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents"
    ]
    resources = ["${aws_cloudwatch_log_group.metrics_publisher.arn}:*"]
  }

  statement {
    sid       = "ReadCursorApiKey"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [local.cursor_api_key_secret_arn]
  }

  statement {
    sid       = "PublishCursorWorkerMetrics"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = [var.metrics_namespace]
    }
  }

  statement {
    sid = "ReadEcsServiceTasks"
    actions = [
      "ecs:DescribeServices",
      "ecs:DescribeTasks",
      "ecs:ListTasks",
      "ecs:UpdateService"
    ]
    resources = ["*"]
  }
}

data "archive_file" "metrics_publisher" {
  type        = "zip"
  source_file = "${path.module}/metrics_publisher.py"
  output_path = "${path.module}/.terraform/metrics-publisher.zip"
}

resource "aws_ecr_repository" "worker" {
  count                = var.create_ecr_repository ? 1 : 0
  name                 = var.ecr_repository_name
  image_tag_mutability = "MUTABLE"
  force_delete         = var.force_delete_ecr_repository

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_secretsmanager_secret" "cursor_api_key" {
  count                   = var.create_cursor_api_key_secret ? 1 : 0
  name                    = var.cursor_api_key_secret_name
  description             = "Cursor service account API key for ECS worker demo."
  recovery_window_in_days = var.secret_recovery_window_in_days
}

resource "aws_ecs_cluster" "worker" {
  count = var.create_ecs_cluster ? 1 : 0
  name  = var.ecs_cluster_name

  setting {
    name  = "containerInsights"
    value = var.enable_container_insights ? "enabled" : "disabled"
  }
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = var.worker_log_group_name
  retention_in_days = var.log_retention_in_days
}

resource "aws_cloudwatch_log_group" "metrics_publisher" {
  name              = "/aws/lambda/${var.metrics_publisher_name}"
  retention_in_days = var.log_retention_in_days
}

resource "aws_iam_role" "task_execution" {
  name               = "${var.ecs_task_family}-execution-role"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume_role.json
}

resource "aws_iam_role_policy_attachment" "task_execution" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "task_execution_secret" {
  name   = "${var.ecs_task_family}-secret-policy"
  role   = aws_iam_role.task_execution.id
  policy = data.aws_iam_policy_document.task_execution_secret.json
}

resource "aws_iam_role" "task" {
  name               = "${var.ecs_task_family}-task-role"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume_role.json
}

resource "aws_iam_role" "metrics_publisher" {
  name               = "${var.metrics_publisher_name}-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_role_policy" "metrics_publisher" {
  name   = "${var.metrics_publisher_name}-policy"
  role   = aws_iam_role.metrics_publisher.id
  policy = data.aws_iam_policy_document.metrics_publisher.json
}

resource "aws_security_group" "worker" {
  name        = "${var.ecs_service_name}-sg"
  description = "No-inbound ECS worker tasks with outbound HTTPS and DNS."
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

resource "aws_ecs_task_definition" "worker" {
  family                   = var.ecs_task_family
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([
    {
      name      = "worker"
      image     = local.worker_image
      essential = true
      environment = [
        {
          name  = "CURSOR_WORKER_POOL_NAME"
          value = var.worker_pool_name
        },
        {
          name  = "CURSOR_WORKER_IDLE_RELEASE_TIMEOUT"
          value = tostring(var.worker_idle_release_timeout)
        },
        {
          name  = "CURSOR_WORKER_MANAGEMENT_ADDR"
          value = var.cursor_worker_management_addr
        },
        {
          name  = "WORKER_REPOSITORY_URL"
          value = var.worker_repository_url
        },
        {
          name  = "CURSOR_WORKER_DIR"
          value = "/workspace"
        },
        {
          name  = "CURSOR_WORKER_LABELS_JSON"
          value = jsonencode(local.worker_labels)
        }
      ]
      secrets = [
        {
          name      = "CURSOR_API_KEY"
          valueFrom = local.cursor_api_key_secret_arn
        }
      ]
      portMappings = [
        {
          name          = "management"
          containerPort = 8080
          hostPort      = 8080
          protocol      = "tcp"
        }
      ]
      healthCheck = {
        command     = ["CMD-SHELL", "curl -fsS http://127.0.0.1:8080/healthz || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 60
      }
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.worker.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "worker"
        }
      }
    }
  ])

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.task_cpu_architecture
  }
}

resource "aws_ecs_service" "worker" {
  name                    = var.ecs_service_name
  cluster                 = local.cluster_arn
  task_definition         = aws_ecs_task_definition.worker.arn
  desired_count           = local.desired_count
  launch_type             = "FARGATE"
  enable_execute_command  = var.enable_execute_command
  enable_ecs_managed_tags = true
  propagate_tags          = "SERVICE"

  network_configuration {
    assign_public_ip = var.assign_public_ip
    security_groups  = [aws_security_group.worker.id]
    subnets          = local.subnet_ids
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  lifecycle {
    ignore_changes = [desired_count]
  }

  depends_on = [
    aws_iam_role_policy.task_execution_secret,
    aws_iam_role_policy_attachment.task_execution
  ]
}

resource "aws_appautoscaling_target" "worker" {
  max_capacity       = var.max_capacity
  min_capacity       = var.min_capacity
  resource_id        = "service/${local.cluster_name}/${aws_ecs_service.worker.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "worker_utilization" {
  name               = "${var.ecs_service_name}-cursor-utilization"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.worker.resource_id
  scalable_dimension = aws_appautoscaling_target.worker.scalable_dimension
  service_namespace  = aws_appautoscaling_target.worker.service_namespace

  target_tracking_scaling_policy_configuration {
    target_value       = var.target_utilization_percent
    scale_in_cooldown  = var.scale_in_cooldown_seconds
    scale_out_cooldown = var.scale_out_cooldown_seconds

    customized_metric_specification {
      metric_name = "UtilizationPercent"
      namespace   = var.metrics_namespace
      statistic   = "Average"
      unit        = "Percent"

      dimensions {
        name  = "PoolName"
        value = var.worker_pool_name
      }

      dimensions {
        name  = "ClusterName"
        value = local.cluster_name
      }

      dimensions {
        name  = "ServiceName"
        value = var.ecs_service_name
      }
    }
  }
}

resource "aws_appautoscaling_policy" "worker_fast_scale_out" {
  name               = "${var.ecs_service_name}-cursor-fast-scale-out"
  policy_type        = "StepScaling"
  resource_id        = aws_appautoscaling_target.worker.resource_id
  scalable_dimension = aws_appautoscaling_target.worker.scalable_dimension
  service_namespace  = aws_appautoscaling_target.worker.service_namespace

  step_scaling_policy_configuration {
    adjustment_type         = "ChangeInCapacity"
    cooldown                = var.scale_out_cooldown_seconds
    metric_aggregation_type = "Average"

    step_adjustment {
      metric_interval_lower_bound = 0
      scaling_adjustment          = 1
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "worker_fast_scale_out" {
  alarm_name          = "${var.ecs_service_name}-cursor-fast-scale-out"
  alarm_description   = "Adds ECS worker capacity quickly when all service-scoped Cursor workers are busy."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "UtilizationPercent"
  namespace           = var.metrics_namespace
  period              = 60
  statistic           = "Average"
  threshold           = var.target_utilization_percent
  treat_missing_data  = "notBreaching"
  unit                = "Percent"

  dimensions = local.metric_dimensions
  alarm_actions = [
    aws_appautoscaling_policy.worker_fast_scale_out.arn
  ]
}

resource "aws_lambda_function" "metrics_publisher" {
  function_name    = var.metrics_publisher_name
  description      = "Publishes Cursor self-hosted worker fleet utilization to CloudWatch."
  role             = aws_iam_role.metrics_publisher.arn
  handler          = "metrics_publisher.handler"
  runtime          = "python3.12"
  filename         = data.archive_file.metrics_publisher.output_path
  source_code_hash = data.archive_file.metrics_publisher.output_base64sha256
  timeout          = var.metrics_publisher_timeout_seconds
  memory_size      = 128

  environment {
    variables = {
      CURSOR_API_KEY_SECRET_ARN = local.cursor_api_key_secret_arn
      CURSOR_WORKERS_URL        = var.cursor_workers_url
      ECS_CLUSTER_NAME          = local.cluster_name
      ECS_SERVICE_NAME          = var.ecs_service_name
      ENABLE_DYNAMIC_SCALE_OUT  = tostring(var.enable_dynamic_scale_out)
      MAX_CAPACITY              = tostring(var.max_capacity)
      MIN_CAPACITY              = tostring(var.min_capacity)
      METRICS_NAMESPACE         = var.metrics_namespace
      METRIC_DIMENSIONS         = jsonencode(local.metric_dimensions)
      TARGET_IDLE_WORKERS       = tostring(var.target_idle_workers)
    }
  }

  depends_on = [aws_iam_role_policy.metrics_publisher]
}

resource "aws_cloudwatch_event_rule" "metrics_publisher" {
  name                = "${var.metrics_publisher_name}-schedule"
  description         = "Publishes Cursor worker utilization metrics for ECS Service Auto Scaling."
  schedule_expression = var.metrics_publish_schedule_expression
}

resource "aws_cloudwatch_event_target" "metrics_publisher" {
  rule      = aws_cloudwatch_event_rule.metrics_publisher.name
  target_id = "metrics-publisher"
  arn       = aws_lambda_function.metrics_publisher.arn
}

resource "aws_lambda_permission" "allow_eventbridge" {
  statement_id  = "AllowExecutionFromEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.metrics_publisher.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.metrics_publisher.arn
}
