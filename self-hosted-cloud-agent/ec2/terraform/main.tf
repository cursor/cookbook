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

  vpc_id          = var.vpc_id != null ? var.vpc_id : data.aws_vpc.default[0].id
  subnet_id       = var.subnet_id != null ? var.subnet_id : sort(data.aws_subnets.default[0].ids)[0]
  worker_image    = "${aws_ecr_repository.worker.repository_url}:${var.worker_image_tag}"
  secret_env_name = "CURSOR_API_KEY"
}

data "aws_vpc" "default" {
  count   = var.vpc_id == null ? 1 : 0
  default = true
}

data "aws_subnets" "default" {
  count = var.subnet_id == null ? 1 : 0

  filter {
    name   = "vpc-id"
    values = [local.vpc_id]
  }
}

data "aws_ssm_parameter" "al2023_ami" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-${var.ami_architecture}"
}

data "aws_iam_policy_document" "worker_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "worker" {
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
      "ecr:GetDownloadUrlForLayer"
    ]
    resources = [aws_ecr_repository.worker.arn]
  }

  statement {
    sid       = "ReadCursorApiKey"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.cursor_api_key.arn]
  }
}

resource "aws_ecr_repository" "worker" {
  name                 = var.ecr_repository_name
  image_tag_mutability = "MUTABLE"
  force_delete         = var.force_delete_ecr_repository

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_secretsmanager_secret" "cursor_api_key" {
  name                    = var.cursor_api_key_secret_name
  description             = "Cursor service account API key for EC2 worker demo."
  recovery_window_in_days = var.secret_recovery_window_in_days
}

resource "aws_iam_role" "worker" {
  name               = "${var.worker_host_name}-role"
  assume_role_policy = data.aws_iam_policy_document.worker_assume_role.json
}

resource "aws_iam_role_policy" "worker" {
  name   = "${var.worker_host_name}-policy"
  role   = aws_iam_role.worker.id
  policy = data.aws_iam_policy_document.worker.json
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.worker.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "worker" {
  name = "${var.worker_host_name}-profile"
  role = aws_iam_role.worker.name
}

resource "aws_security_group" "worker" {
  name        = "${var.worker_host_name}-sg"
  description = "No-inbound worker host with outbound HTTPS and DNS."
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

resource "aws_instance" "worker" {
  ami                         = data.aws_ssm_parameter.al2023_ami.value
  instance_type               = var.instance_type
  subnet_id                   = local.subnet_id
  associate_public_ip_address = true
  iam_instance_profile        = aws_iam_instance_profile.worker.name
  vpc_security_group_ids      = [aws_security_group.worker.id]
  user_data_replace_on_change = true

  user_data = templatefile("${path.module}/user_data.sh.tpl", {
    aws_region                    = var.aws_region
    ecr_repository_url            = aws_ecr_repository.worker.repository_url
    worker_image                  = local.worker_image
    worker_pool_name              = var.worker_pool_name
    worker_idle_release_timeout   = var.worker_idle_release_timeout
    worker_repository_url         = var.worker_repository_url
    cursor_api_key_secret_id      = aws_secretsmanager_secret.cursor_api_key.id
    cursor_api_key_env_name       = local.secret_env_name
    cursor_worker_management_addr = var.cursor_worker_management_addr
  })

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required"
  }

  root_block_device {
    encrypted   = true
    volume_size = var.root_volume_size_gb
    volume_type = "gp3"
  }

  tags = {
    Name = var.worker_host_name
  }

  depends_on = [
    aws_iam_role_policy.worker,
    aws_iam_role_policy_attachment.ssm
  ]
}
