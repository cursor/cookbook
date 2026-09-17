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

# Reads CAPACITY_PROVIDER_ID from the environment, falling back to Terraform state.
require_capacity_provider_id() {
  if [[ -z "${CAPACITY_PROVIDER_ID:-}" ]]; then
    CAPACITY_PROVIDER_ID="$(terraform_output capacity_provider_id)"
  fi

  if [[ -z "${CAPACITY_PROVIDER_ID}" ]]; then
    echo "CAPACITY_PROVIDER_ID is not set and could not be read from ${TERRAFORM_DIR}." >&2
    echo "Run 'make agentcore-terraform-apply', or export CAPACITY_PROVIDER_ID yourself." >&2
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

# Load AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN for a signed REST call.
export_aws_credentials() {
  local tmpfile
  tmpfile="$(mktemp)"
  aws configure export-credentials --profile "${AWS_PROFILE}" --format env-no-export >"${tmpfile}"
  set -a
  # shellcheck disable=SC1090
  source "${tmpfile}"
  set +a
  rm -f "${tmpfile}"
  export AWS_REGION
}

# DeleteCapacityProviderSession. Newer AWS CLIs expose the operation; older ones
# (common on the machine that already talks to AgentCore) do not, so fall back to
# a SigV4 DELETE against the data-plane endpoint. ResourceNotFound means this ID
# is already gone — leftover EC2 boxes use a different runtime-session-id tag.
delete_capacity_provider_session() {
  local provider_id="$1"
  local session_id="$2"
  local out rc=0

  run_delete() {
    if AWS_PAGER="" aws_cli bedrock-agentcore delete-capacity-provider-session help >/dev/null 2>&1; then
      aws_cli bedrock-agentcore delete-capacity-provider-session \
        --capacity-provider-id "${provider_id}" \
        --session-id "${session_id}"
      return
    fi
    if AWS_PAGER="" aws_cli bedrock-agentcore-control delete-capacity-provider-session help >/dev/null 2>&1; then
      aws_cli bedrock-agentcore-control delete-capacity-provider-session \
        --capacity-provider-id "${provider_id}" \
        --session-id "${session_id}"
      return
    fi
    echo "This AWS CLI does not know delete-capacity-provider-session; signing the REST call."
    export_aws_credentials
    python3 "${SCRIPT_DIR}/delete_capacity_provider_session.py" "${provider_id}" "${session_id}"
  }

  set +e
  out="$(run_delete 2>&1)"
  rc=$?
  set -e
  printf '%s\n' "${out}"

  if [[ "${rc}" -ne 0 ]]; then
    if printf '%s\n' "${out}" | grep -qi 'ResourceNotFoundException\|HTTP 404'; then
      echo "CapacityProviderSession ${session_id} is already gone. Leftover instances use a different RuntimeSessionId tag — see make agentcore-list-instances."
      return 0
    fi
    return "${rc}"
  fi
}
