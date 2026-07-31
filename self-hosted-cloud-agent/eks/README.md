# EKS + Helm

The Kubernetes path, including EKS, is documented in the official Cursor guide:

**[Deploying with Kubernetes](https://cursor.com/docs/cloud-agent/self-hosted-guides/kubernetes)**

It covers installing the Cursor worker-set controller with Helm, creating the auth secret, defining `WorkerDeployment` resources, scaling, rolling updates, and health checks. The controller runs the same worker image built in [`../docker`](../docker) and works on any Kubernetes cluster, so there is nothing EKS-specific to duplicate here.

For the AWS-native, non-Kubernetes options, see [`../ec2`](../ec2) and [`../ecs`](../ecs).
