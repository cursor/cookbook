#!/usr/bin/env bash
# List the EC2 instances currently backing sessions on the capacity provider.
#
# There is no API that lists sessions, so this is the closest substitute. AgentCore launches
# EC2 *managed* instances, which are hidden from the default console and API list views, so
# --include-managed-resources is required. The session ID to pass to delete-session is the
# tag bedrock-agentcore:runtime-session-id — that value is often a bare UUID, not the
# cursor-worker-<uuid> string start-session printed.
#
# Usage:
#   scripts/list-instances.sh
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

export AWS_PAGER=""

# shellcheck disable=SC2016 # the backticks are JMESPath literals, not shell substitution
aws_cli ec2 describe-instances \
  --include-managed-resources \
  --filters \
    "Name=tag-key,Values=bedrock-agentcore:capacity-provider-id" \
    "Name=instance-state-name,Values=pending,running,shutting-down,stopping,stopped" \
  --query 'Reservations[].Instances[].{
    InstanceId: InstanceId,
    State: State.Name,
    InstanceType: InstanceType,
    LaunchTime: LaunchTime,
    RuntimeSessionId: Tags[?Key==`bedrock-agentcore:runtime-session-id`]|[0].Value,
    CapacityProviderId: Tags[?Key==`bedrock-agentcore:capacity-provider-id`]|[0].Value
  }' \
  --output json

echo >&2
echo "Delete each RuntimeSessionId (the EC2 tag, not AGENTCORE_SESSION_ID unless they match):" >&2
echo "  make agentcore-delete-session SESSION_ID=<RuntimeSessionId>" >&2
echo "Or all of them: make agentcore-delete-listed-sessions" >&2
