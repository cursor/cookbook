#!/usr/bin/env bash
set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
  printf 'sensitive-prompt-guard.sh requires jq on PATH\n' >&2
  exit 1
fi

payload="$(cat)"
if [[ -z "${payload//[[:space:]]/}" ]]; then
  payload="{}"
fi

prompt="$(jq -r '.prompt // ""' <<<"$payload")"
prompt_lower="$(printf '%s' "$prompt" | tr '[:upper:]' '[:lower:]')"
matches=()

add_match() {
  local name="$1"
  matches+=("$name")
}

if [[ "$prompt_lower" =~ -----begin\ (rsa\ |dsa\ |ec\ |openssh\ |pgp\ )?private\ key----- ]]; then
  add_match "private key"
fi

if [[ "$prompt" =~ (^|[^[:alnum:]_-])crsr_[A-Za-z0-9_-]{20,}([^[:alnum:]_-]|$) ]]; then
  add_match "Cursor API key"
fi

if [[ "$prompt" =~ (^|[^[:alnum:]_])(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{30,}([^[:alnum:]_]|$) ]]; then
  add_match "GitHub token"
fi

if [[ "$prompt" =~ (^|[^[:alnum:]_-])xox[baprs]-[A-Za-z0-9-]{20,}([^[:alnum:]_-]|$) ]]; then
  add_match "Slack token"
fi

if [[ "$prompt" =~ (^|[^[:alnum:]_-])sk-[A-Za-z0-9_-]{32,}([^[:alnum:]_-]|$) ]]; then
  add_match "OpenAI API key"
fi

if [[ "$prompt" =~ (^|[^[:alnum:]_])(AKIA|ASIA)[A-Z0-9]{16}([^[:alnum:]_]|$) ]]; then
  add_match "AWS access key ID"
fi

if [[ "$prompt" =~ (^|[^[:alnum:]_-])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}([^[:alnum:]_-]|$) ]]; then
  add_match "JWT-like token"
fi

if [[ "$prompt" =~ (^|[^0-9])([0-9][\ -]*){13,19}([^0-9]|$) ]]; then
  add_match "credit card-like number"
fi

if ((${#matches[@]} > 0)); then
  match_list="${matches[0]}"
  for match in "${matches[@]:1}"; do
    match_list+=", ${match}"
  done
  message="This prompt appears to contain sensitive data (${match_list}). Remove or replace the sensitive value before resubmitting."
  jq -cn --arg message "$message" '{"continue":false,"user_message":$message}'
else
  printf '{"continue":true}\n'
fi
