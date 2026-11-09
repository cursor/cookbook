#!/usr/bin/env bash
# Delete every capacity-provider session that still has a managed EC2 instance
# FOR THIS STACK's capacity provider (CAPACITY_PROVIDER_ID). Instances belonging to
# a different or replaced provider are intentionally left alone — deleting their
# sessions against this provider id returns ResourceNotFound and would falsely
# report them as cleaned up while they keep running and billing.
#
# Reads bedrock-agentcore:runtime-session-id off the instances. That tag is the
# DeleteCapacityProviderSession id; it is often a bare UUID from an earlier invoke,
# not the cursor-worker-<uuid> value in .env.
#
# Usage:
#   scripts/delete-listed-sessions.sh
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_capacity_provider_id

export AWS_PAGER=""

# shellcheck disable=SC2016
session_ids="$(
  aws_cli ec2 describe-instances \
    --include-managed-resources \
    --filters \
      "Name=tag:bedrock-agentcore:capacity-provider-id,Values=${CAPACITY_PROVIDER_ID}" \
      "Name=instance-state-name,Values=pending,running,shutting-down,stopping,stopped" \
    --query 'Reservations[].Instances[].Tags[?Key==`bedrock-agentcore:runtime-session-id`].Value' \
    --output text \
  | tr '\t' '\n' \
  | awk 'NF && !seen[$0]++'
)"

if [[ -z "${session_ids}" ]]; then
  echo "No live managed instances tagged for capacity provider ${CAPACITY_PROVIDER_ID}."
  echo "Instances tagged for a different or replaced provider are NOT handled here —"
  echo "list them with: make agentcore-list-instances (then delete via their own provider)."
  exit 0
fi

echo "Deleting capacity-provider session(s) tagged on live instances:"
echo "${session_ids}" | sed 's/^/  /'
echo

failed=0
while IFS= read -r session_id; do
  [[ -z "${session_id}" ]] && continue
  echo "=== ${session_id} ==="
  if ! delete_capacity_provider_session "${CAPACITY_PROVIDER_ID}" "${session_id}"; then
    failed=1
  fi
  echo
done <<< "${session_ids}"

echo "Done. Confirm with: make agentcore-list-instances"
exit "${failed}"
