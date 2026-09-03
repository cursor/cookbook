#!/usr/bin/env bash
# Start one Cursor worker session on the AgentCore runtime.
#
# A session comes into existence only when you invoke it, and there is no API that lists the
# sessions on a capacity provider. Record the session ID this prints: it is the only handle
# you have for inspecting or stopping the session later.
#
# Usage:
#   scripts/start-session.sh [session-id]
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_runtime_arn

SESSION_ID="${1:-${AGENTCORE_SESSION_ID:-$(new_session_id)}}"
require_session_id "${SESSION_ID}"

echo "Runtime:  ${AGENT_RUNTIME_ARN}"
echo "Session:  ${SESSION_ID}"
echo
echo "Invoking. A cold start provisions an EC2 instance and pulls the image, so the first"
echo "invocation of a session can take several minutes."
echo

invoke_runtime "${SESSION_ID}" '{"action":"status"}'

echo
echo "Session started. Save this session ID:"
echo
echo "  export AGENTCORE_SESSION_ID=${SESSION_ID}"
echo
echo "The worker registers with Cursor over outbound HTTPS. Watch the runtime logs for the"
echo "success signal ('Worker is now running' / 'Registering to worker pool'):"
echo
echo "  make agentcore-logs"
