#!/usr/bin/env bash
# Stop one worker session.
#
# StopRuntimeSession ends the session and releases its instance. The persistent EBS volume
# survives, so invoking the same session ID again re-attaches the workspace. To reclaim the
# volume as well, destroy the capacity provider.
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
  --runtime-session-id "${SESSION_ID}"

echo "Requested stop for session ${SESSION_ID}."
echo "Confirm the instance is gone with: make agentcore-list-instances"
