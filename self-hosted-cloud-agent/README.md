# Self-Hosted Cloud Agents Lab

This repository demonstrates how to run Cursor Cloud Agents on customer-managed infrastructure with self-hosted worker pools. Cursor still handles orchestration, model inference, and the Cloud Agents experience, while workers run inside your environment to clone repos, run commands, edit files, execute builds/tests, and reach internal services.

Workers connect outbound to Cursor over HTTPS. No inbound access to the worker is required.

## Infrastructure Guides

| Infrastructure | General README | Implementation README |
| --- | --- | --- |
| EC2 + Docker | [`ec2/README.md`](ec2/README.md) | [`ec2/terraform/README.md`](ec2/terraform/README.md) |
| ECS/Fargate | [`ecs/README.md`](ecs/README.md) | [`ecs/terraform/README.md`](ecs/terraform/README.md) |
| EKS + Helm | [`eks/README.md`](eks/README.md) | [`eks/helm/README.md`](eks/helm/README.md) |

Use the general READMEs for architecture, trade-offs, validation expectations, and troubleshooting. Use the implementation READMEs when you need copy-paste setup commands.

- EC2 + Docker is the smallest footprint and runs one worker container on one host.
- ECS/Fargate is the AWS-native service path with CloudWatch metrics and ECS Service Auto Scaling.
- EKS + Helm is the Kubernetes path using Cursor's worker-set controller and `WorkerDeployment` resources.
