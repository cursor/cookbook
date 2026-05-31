FROM ubuntu:24.04

ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH="/root/.cursor/bin:/root/.local/bin:/usr/local/bin:${PATH}"

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        git \
        jq \
        less \
        openssh-client \
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

WORKDIR /workspace

COPY config/labels.json /etc/cursor/labels.json
COPY docker/entrypoint.sh /usr/local/bin/cursor-worker-entrypoint

ENTRYPOINT ["/usr/local/bin/cursor-worker-entrypoint"]
