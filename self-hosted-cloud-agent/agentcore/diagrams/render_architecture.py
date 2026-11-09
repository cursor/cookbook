#!/usr/bin/env python3
"""Render diagrams/architecture.png with official AWS and GitHub icons.

Requires Graphviz and: pip install diagrams

Two GitHub repositories:
  cursor-cookbook  — factory (adapter, image, Terraform, github/ templates)
  Sample repo      — application the worker clones and pull-requests

Copy, do not generate, the templates:

  github/cursor-agent-in-progress.yml  ->  <sample-repo>/.github/workflows/
  github/kick_cursor_agent.py          ->  <sample-repo>/.github/scripts/kick_cursor_agent.py

agentcore/.env stays on the cookbook checkout. It is not copied into the sample repo.

Run is the outer operating picture. An AWS rectangle inside Run holds the
AgentCore control plane, Secrets Manager, ECR, and the customer VPC.

AgentCore Runtime and its capacity provider are the AWS-managed control plane:
you call InvokeAgentRuntime on them, and they provision and launch the managed
EC2 instance into the customer VPC. They are NOT VPC-resident. Only the managed
instance and its EBS volume live inside the VPC — Instances is VPC-only, and the
runtime inherits networking from the capacity provider (it takes no
networkConfiguration). Cursor Cloud Agents and GitHub Actions stay in Run,
outside AWS. The sample repo sits outside Run as the PR target.

Arrow direction is the direction of the request or artifact:
  secret/image bytes travel toward the managed instance;
  the worker dials Cursor outbound;
  Actions POSTs to Cursor;
  git push uses CURSOR_GIT_TOKEN from the instance;
  Cursor opens the PR (autoCreatePR / GitHub App) on the sample repo.
"""

from __future__ import annotations

from pathlib import Path

from diagrams import Cluster, Diagram, Edge
from diagrams.aws.compute import EC2, EC2ContainerRegistry
from diagrams.aws.general import InternetAlt1
from diagrams.aws.ml import Bedrock
from diagrams.aws.security import SecretsManager
from diagrams.aws.storage import ElasticBlockStoreEBS
from diagrams.onprem.ci import GithubActions
from diagrams.onprem.client import User
from diagrams.onprem.vcs import Github

OUT_DIR = Path(__file__).resolve().parent
OUT_STEM = str(OUT_DIR / "architecture")


def main() -> None:
    graph_attr = {
        "fontsize": "14",
        "bgcolor": "white",
        "pad": "0.65",
        "splines": "spline",
        "nodesep": "1.15",
        "ranksep": "1.35",
        "fontname": "Helvetica",
        "labeljust": "l",
        "compound": "true",
        "newrank": "true",
    }
    node_attr = {"fontsize": "11", "fontname": "Helvetica"}
    edge_attr = {"fontsize": "10", "fontname": "Helvetica", "color": "#545B64"}

    dashed = {"style": "dashed", "color": "#7B8794"}

    with Diagram(
        "Self-hosted Cloud Agents on AgentCore",
        filename=OUT_STEM,
        show=False,
        direction="LR",
        graph_attr=graph_attr,
        node_attr=node_attr,
        edge_attr=edge_attr,
    ):
        operator = User("Operator")
        cookbook = Github("cursor-cookbook")

        with Cluster("Run"):
            with Cluster("AWS"):
                with Cluster("AgentCore control plane (AWS-managed)"):
                    runtime = Bedrock("AgentCore Runtime\n+ Capacity Provider")
                with Cluster("Credentials"):
                    secrets = SecretsManager("Secrets Manager")
                    ecr = EC2ContainerRegistry("Amazon ECR")
                with Cluster("Customer VPC  (egress only)"):
                    instance = EC2("Managed instance")
                    volume = ElasticBlockStoreEBS("EBS /mnt/workspace")
            cursor = InternetAlt1("Cursor Cloud Agents")
            actions = GithubActions("GitHub Actions")

        sample = Github("Sample repo")

        operator >> Edge(label="operate from factory") >> cookbook
        cookbook >> Edge(label="1  copy github/ templates") >> sample
        operator >> Edge(label="2  grant GitHub App") >> sample
        operator >> Edge(label="3  put-secret API key + git token", **dashed) >> secrets
        cookbook >> Edge(label="4  push image", **dashed) >> ecr
        operator >> Edge(label="5  gh secret set", **dashed) >> sample
        operator >> Edge(label="6  InvokeAgentRuntime") >> runtime
        runtime >> Edge(label="7  provision + launch instance in VPC") >> instance
        ecr >> Edge(label="8  image pull") >> instance
        secrets >> Edge(label="9  secret values") >> instance
        volume >> Edge(label="10  mount workspace") >> instance
        instance >> Edge(label="11  worker dials Cursor") >> cursor
        sample >> Edge(label="12  event starts workflow") >> actions
        actions >> Edge(label="13  POST /v1/agents") >> cursor
        instance >> Edge(label="14  git push (CURSOR_GIT_TOKEN)") >> sample
        cursor >> Edge(label="15  autoCreatePR") >> sample


if __name__ == "__main__":
    main()
    png = Path(OUT_STEM + ".png")
    print(f"wrote {png} ({png.stat().st_size} bytes)")
