#!/usr/bin/env bash
set -euo pipefail

MAX_PREVIEW_CHARS="${CURSOR_HOOK_LOG_PREVIEW_CHARS:-240}"
if ! [[ "$MAX_PREVIEW_CHARS" =~ ^[0-9]+$ ]]; then
  MAX_PREVIEW_CHARS=240
fi

LOG_DIR="${CURSOR_HOOK_LOG_DIR:-.cursor/hook-logs}"
LOG_FILE="${LOG_DIR%/}/audit.jsonl"
VERBOSE=false
if [[ "${CURSOR_HOOK_LOG_VERBOSE:-}" == "1" ]]; then
  VERBOSE=true
fi

if ! command -v jq >/dev/null 2>&1; then
  printf 'audit-log.sh requires jq on PATH\n' >&2
  exit 1
fi

payload="$(cat)"
if [[ -z "${payload//[[:space:]]/}" ]]; then
  payload="{}"
fi

timestamp="$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"

record="$(
  jq -c \
    --arg timestamp "$timestamp" \
    --argjson max_preview_chars "$MAX_PREVIEW_CHARS" \
    --argjson verbose "$VERBOSE" \
    '
      def preview($max):
        if type != "string" or length == 0 then
          null
        else
          (gsub("\\s+"; " ") | sub("^\\s+"; "") | sub("\\s+$"; "")) as $normalized
          | if ($normalized | length) <= $max then
              $normalized
            else
              ($normalized[0:$max] + "...")
            end
        end;

      def infer_event:
        if (.hook_event_name? | type) == "string" then
          .hook_event_name
        elif (.prompt? | type) == "string" then
          "beforeSubmitPrompt"
        elif (.command? | type) == "string" and (.output? | type) == "string" then
          "afterShellExecution"
        elif (.command? | type) == "string" then
          "beforeShellExecution"
        elif (.file_path? | type) == "string" and (.edits? | type) == "array" then
          "afterFileEdit"
        else
          "unknown"
        end;

      (infer_event) as $event
      | {
          timestamp: $timestamp,
          event: $event
        }
        + (if .cwd then {cwd: .cwd} else {} end)
        + (if (.command? | type) == "string" then {command: .command} else {} end)
        + (if (.prompt? | type) == "string" then
            {prompt_length: (.prompt | length)}
            + ((.prompt | preview($max_preview_chars)) as $preview
              | if $preview == null then {} else {prompt_preview: $preview} end)
          else
            {}
          end)
        + (if (.attachments? | type) == "array" then {attachments_count: (.attachments | length)} else {} end)
        + (if (.file_path? | type) == "string" then {file_path: .file_path} else {} end)
        + (if (.edits? | type) == "array" then {edits_count: (.edits | length)} else {} end)
        + (if (.duration? | type) == "number" then {duration_ms: .duration} else {} end)
        + (if (.output? | type) == "string" then
            {output_length: (.output | length)}
            + (if $verbose then
                ((.output | preview($max_preview_chars)) as $preview
                | if $preview == null then {} else {output_preview: $preview} end)
              else
                {}
              end)
          else
            {}
          end)
        + (if (.sandbox? | type) == "boolean" then {sandbox: .sandbox} else {} end)
    ' <<<"$payload"
)"

mkdir -p "$LOG_DIR"
printf '%s\n' "$record" >>"$LOG_FILE"

event="$(jq -r '.event' <<<"$record")"
case "$event" in
  beforeSubmitPrompt)
    printf '{"continue":true}\n'
    ;;
  beforeShellExecution)
    printf '{"permission":"allow"}\n'
    ;;
  *)
    printf '{}\n'
    ;;
esac
