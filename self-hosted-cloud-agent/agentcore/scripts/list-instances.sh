#!/usr/bin/env bash
# List the EC2 instances currently backing sessions on the capacity provider.
#
# There is no API that lists sessions, so this is the closest substitute. AgentCore launches
# EC2 *managed* instances, which are hidden from the default console and API list views, so
# --include-managed-resources is required. The docs say to identify them by the Operator
# field and the AgentCore capacity-provider tag; the AgentCore tags are printed in full
# rather than filtered to a specific key, because the per-session tag key is not documented.
#
# Usage:
#   scripts/list-instances.sh
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# shellcheck disable=SC2016 # the backticks are JMESPath literals, not shell substitution
aws_cli ec2 describe-instances \
  --include-managed-resources \
  --filters "Name=tag-key,Values=bedrock-agentcore:capacity-provider-id" \
  --query 'Reservations[].Instances[].{
    InstanceId: InstanceId,
    State: State.Name,
    InstanceType: InstanceType,
    LaunchTime: LaunchTime,
    Operator: Operator.Principal,
    AgentCoreTags: Tags[?starts_with(Key, `bedrock-agentcore`)]
  }' \
  --output json
