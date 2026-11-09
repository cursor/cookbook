# Cursor self-hosted worker packaged for Amazon Bedrock AgentCore Runtime (Instances).
#
# Differences from ../../docker/Dockerfile, all required by the AgentCore contract:
#   - The adapter is the entrypoint, not `agent worker`. AgentCore requires an HTTP server
#     on 0.0.0.0:8080 serving GET /ping and POST /invocations.
#   - The worker directory defaults to /mnt/workspace. Capacity provider volume mount paths
#     must be under /mnt with exactly one subdirectory level.
#   - Build linux/arm64. See OQ-1 in ../REQUIREMENTS.md: the Instances docs say x86_64 and
#     arm64 are supported, but the container contract pages still state ARM64 unconditionally
#     and nothing states that image architecture may differ from the capacity provider OS.
#     arm64 is the only choice that is safe under both readings.
#
# The build context is this agentcore/ directory, so the target is fully self-contained:
#   docker buildx build --platform linux/arm64 -f docker/Dockerfile .
#
# Keep the layer count under 53. More than 53 layers combined with a non-numeric USER
# directive causes an HTTP 424 overlay mount failure at session start.

FROM ubuntu:24.04

ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH="/root/.cursor/bin:/root/.local/bin:/usr/local/bin:${PATH}"

# The adapter reads these at startup; Terraform overrides them via environmentVariables.
ENV CURSOR_WORKER_DIR=/mnt/workspace
ENV AGENTCORE_ADAPTER_PORT=8080

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        git \
        jq \
        less \
        openssh-client \
        python3 \
        unzip \
    && rm -rf /var/lib/apt/lists/*

RUN case "${TARGETARCH}" in \
        "amd64") aws_arch="x86_64" ;; \
        "arm64") aws_arch="aarch64" ;; \
        *) echo "Unsupported Docker target architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${aws_arch}.zip" -o /tmp/awscliv2.zip \
    && unzip -q /tmp/awscliv2.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/aws /tmp/awscliv2.zip

# Installs the Cursor agent CLI. Pin this once you settle on a version for repeatable runs.
RUN curl -fsSL https://cursor.com/install | bash

# The mount point for the capacity provider volume. AgentCore mounts over this directory, so
# creating it here only matters when running the image locally without a volume.
RUN mkdir -p /mnt/workspace

COPY config/labels.json /etc/cursor/labels.json
COPY adapter/worker_adapter.py /usr/local/bin/cursor-worker-adapter

RUN chmod +x /usr/local/bin/cursor-worker-adapter

WORKDIR /mnt/workspace

EXPOSE 8080

ENTRYPOINT ["python3", "/usr/local/bin/cursor-worker-adapter"]
