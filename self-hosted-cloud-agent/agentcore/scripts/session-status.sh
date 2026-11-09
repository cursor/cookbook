#!/usr/bin/env bash
# Inspect one worker session.
#
# This calls POST /invocations on the adapter, which reports the supervised worker's state
# from inside the session. Invoking an existing session ID routes to the same instance; a
# stopped session is restarted, so use this only on sessions you want running.
#
# Usage:
#   scripts/session-status.sh [session-id]
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_runtime_arn

SESSION_ID="${1:-${AGENTCORE_SESSION_ID:-}}"
require_session_id "${SESSION_ID}"

invoke_runtime "${SESSION_ID}" '{"action":"status"}'
