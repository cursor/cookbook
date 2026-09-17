#!/usr/bin/env bash
# Stop the agent runtime inside one session.
#
# StopRuntimeSession does **not** terminate the managed EC2 instance. On AgentCore
# Instances the box stays until IdleInstanceTimeout (900s in this lab) or until you
# delete the capacity-provider session. The persistent EBS volume survives a stop, so
# invoking the same session ID again re-attaches the workspace.
#
# To kill the instance now (and destroy the volume), run:
#   make agentcore-delete-session SESSION_ID=<session-id>
#
# Usage:
#   scripts/stop-session.sh [session-id]
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_runtime_arn

SESSION_ID="${1:-${AGENTCORE_SESSION_ID:-}}"
require_session_id "${SESSION_ID}"

aws_cli bedrock-agentcore stop-runtime-session \
  --agent-runtime-arn "${AGENT_RUNTIME_ARN}" \
  --runtime-session-id "${SESSION_ID}" \
  --qualifier DEFAULT

echo "Requested StopRuntimeSession for ${SESSION_ID}."
echo
echo "That stops the worker process. It does not terminate the EC2 instance."
echo "make agentcore-list-instances will still show the box until IdleInstanceTimeout"
echo "(${AGENTCORE_IDLE_INSTANCE_TIMEOUT:-900}s) or until you delete the session:"
echo
echo "  make agentcore-delete-session SESSION_ID=${SESSION_ID}"
