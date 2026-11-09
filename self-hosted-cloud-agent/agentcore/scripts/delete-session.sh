#!/usr/bin/env bash
# Delete a capacity-provider session and deprovision its EC2 instance and EBS volume.
#
# StopRuntimeSession (make agentcore-stop-session) only stops the agent runtime inside
# the session. On Instances, the EC2 instance stays until IdleInstanceTimeout or until
# this call. DeleteCapacityProviderSession tears down the instance, ENI, and persistent
# volume. The session ID cannot be reused afterwards.
#
# Usage:
#   scripts/delete-session.sh [session-id]
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_capacity_provider_id

SESSION_ID="${1:-${AGENTCORE_SESSION_ID:-}}"
require_session_id "${SESSION_ID}"

echo "Deleting capacity-provider session ${SESSION_ID}"
echo "Capacity provider: ${CAPACITY_PROVIDER_ID}"
echo "This terminates the managed EC2 instance and deletes the persistent workspace volume."
echo

delete_capacity_provider_session "${CAPACITY_PROVIDER_ID}" "${SESSION_ID}"

echo
echo "Delete requested (asynchronous). The instance may sit in shutting-down for a minute."
echo "Confirm with: make agentcore-list-instances"
echo "If other instances remain, they belong to other session IDs — delete each one, or"
echo "run make agentcore-terraform-destroy to deprovision every session on this provider."
