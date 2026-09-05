#!/usr/bin/env bash
# Shared helpers for the AgentCore session scripts. Source this file, do not run it.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TERRAFORM_DIR="${SCRIPT_DIR}/../terraform"

AWS_REGION="${AWS_REGION:-us-west-2}"
AWS_PROFILE="${AWS_PROFILE:-default}"

aws_cli() {
  aws --profile "${AWS_PROFILE}" --region "${AWS_REGION}" "$@"
}

terraform_output() {
  terraform -chdir="${TERRAFORM_DIR}" output -raw "$1" 2>/dev/null || true
}

# Reads AGENT_RUNTIME_ARN from the environment, falling back to Terraform state so the
# scripts work straight after an apply without any copy and paste.
require_runtime_arn() {
  if [[ -z "${AGENT_RUNTIME_ARN:-}" ]]; then
    AGENT_RUNTIME_ARN="$(terraform_output agent_runtime_arn)"
  fi

  if [[ -z "${AGENT_RUNTIME_ARN}" ]]; then
    echo "AGENT_RUNTIME_ARN is not set and could not be read from ${TERRAFORM_DIR}." >&2
    echo "Run 'make agentcore-terraform-apply', or export AGENT_RUNTIME_ARN yourself." >&2
    exit 1
  fi
}

# Session IDs must be at least 33 characters. A UUID suffix keeps that guaranteed and
# keeps two operators from colliding on the same session.
new_session_id() {
  local uuid
  uuid="$(uuidgen | tr '[:upper:]' '[:lower:]')"
  printf 'cursor-worker-%s' "${uuid}"
}

require_session_id() {
  local session_id="$1"

  if [[ -z "${session_id}" ]]; then
    echo "A session ID is required. Pass it as the first argument or set AGENTCORE_SESSION_ID." >&2
    exit 1
  fi

  if (( ${#session_id} < 33 )); then
    echo "Session ID '${session_id}' is ${#session_id} characters; the minimum is 33." >&2
    exit 1
  fi
}

# Sends one payload to the runtime and prints the response body. Cold starts provision an
# EC2 instance and pull the image, so the read timeout is disabled rather than guessed.
invoke_runtime() {
  local session_id="$1"
  local payload="$2"
  local payload_file response_file

  payload_file="$(mktemp)"
  response_file="$(mktemp)"
  # shellcheck disable=SC2064
  trap "rm -f '${payload_file}' '${response_file}'" RETURN

  printf '%s' "${payload}" >"${payload_file}"

  aws_cli bedrock-agentcore invoke-agent-runtime \
    --cli-read-timeout 0 \
    --agent-runtime-arn "${AGENT_RUNTIME_ARN}" \
    --runtime-session-id "${session_id}" \
    --content-type application/json \
    --accept application/json \
    --payload "fileb://${payload_file}" \
    "${response_file}" >/dev/null

  cat "${response_file}"
  printf '\n'
}
