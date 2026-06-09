#!/usr/bin/env bash

BLOCKED_REPO_NAMES=(
  "example"
)

MODEL_BLOCKLIST=(
  "example"
)

allow() {
  printf '{"continue":true}\n'
}

deny() {
  local model="$1"
  local repo="$2"

  printf '{"continue":false,"user_message":"%s model is not allowed to be used on %s"}\n' "$model" "$repo"
}

lowercase() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

model_from_payload() {
  local payload="$1"

  printf '%s' "$payload" \
    | tr '\n' ' ' \
    | sed -nE 's/.*"model"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/p'
}

repo_name_from_origin() {
  local origin="$1"
  local repo_name="${origin%/}"
  repo_name="${repo_name##*/}"
  repo_name="${repo_name%.git}"
  printf '%s' "$repo_name" | tr '[:upper:]' '[:lower:]'
}

blocked_repo_match() {
  local repo_name="$1"
  local blocked_name

  for blocked_name in "${BLOCKED_REPO_NAMES[@]}"; do
    blocked_name="$(lowercase "$blocked_name")"
    if [[ "$repo_name" == *"$blocked_name"* ]]; then
      printf '%s' "$blocked_name"
      return 0
    fi
  done

  return 1
}

blocked_model_match() {
  local model="$1"
  local blocked_model

  for blocked_model in "${MODEL_BLOCKLIST[@]}"; do
    blocked_model="$(lowercase "$blocked_model")"
    if [[ "$model" == *"$blocked_model"* ]]; then
      printf '%s' "$blocked_model"
      return 0
    fi
  done

  return 1
}

payload="$(</dev/stdin)"
model="$(lowercase "$(model_from_payload "$payload")")"

if [[ -z "$model" ]] || ! matched_model="$(blocked_model_match "$model")"; then
  allow
  exit 0
fi

origin="$(git remote get-url origin 2>/dev/null || true)"
if [[ -z "$origin" ]]; then
  allow
  exit 0
fi

repo_name="$(repo_name_from_origin "$origin")"

if [[ -n "$repo_name" ]] && matched_repo="$(blocked_repo_match "$repo_name")"; then
  deny "$matched_model" "$matched_repo"
  exit 0
fi

allow
