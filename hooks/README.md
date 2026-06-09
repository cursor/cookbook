# Cursor Hooks Examples

This folder is a guided [Cursor Hooks](https://cursor.com/docs/hooks) example. It follows a project-style layout: one hook configuration file and a shared scripts directory that demonstrate multiple hook patterns together.

## Project Layout

```sh
hooks/
├── README.md
└── .cursor/
    ├── hooks.json
    └── hooks/
        ├── audit-log.sh
        ├── block-models-by-repo-origin.sh
        ├── sensitive-prompt-guard.sh
        └── update-skills-on-stop.mjs
```

## What It Shows

### Additional logging

`audit-log.sh` writes a JSONL audit trail for prompt submissions, shell commands, shell results, and file edits. By default, logs are written to `.cursor/hook-logs/audit.jsonl` from the project root.

The destination does not have to be a local JSONL file. The same pattern can send records to a personal logging script, an internal company audit service, a SIEM, or any other logging tool your team owns.

### Sensitive prompt guard

`sensitive-prompt-guard.sh` blocks prompts that appear to contain secrets or sensitive data. `beforeSubmitPrompt` can prevent submission to Cursor's backend systems and models, but it cannot rewrite or redact prompt text in place.

A similar hook can also hand the prompt to a DLP service, secret scanner, or other internal security tool and block submission when that system returns a sensitive finding.

### Model/repo prompt blocking

`block-models-by-repo-origin.sh` blocks prompt submissions when both the selected model and the git origin repo name match configured substring lists. The hook reads `model` from the `beforeSubmitPrompt` payload, runs `git remote get-url origin` from the project root, extracts the repo name from the URL, and uses broad substring matching against `MODEL_BLOCKLIST` and `BLOCKED_REPO_NAMES`. The sample values use `example` for both lists, so an `example` model is blocked on repos like `git@github.com:{org}/example.git` or `https://github.com/{org}/example-app.git`.

The matching is intentionally broad: conceptually, it behaves like checking whether a blocked repo string appears anywhere in the repo name returned from the git remote. This may match more than an exact repository name. The sample hook is configured with `failClosed: true`, so crashes, timeouts, or invalid JSON fail closed, but the script intentionally returns `continue: true` when no git `origin` remote exists.

### Skill update follow-up

`update-skills-on-stop.mjs` runs on `stop`, checks changed files, and asks the agent to update related `.cursor/skills/*/SKILL.md` files when configured code areas changed.

This can be used as a way for skills to be self-maintaining over time.

## Using These Examples

Copy the `hooks/` folder into your project, then merge `hooks/.cursor/hooks.json` into your project hook configuration at `.cursor/hooks.json`. The sample commands assume the scripts remain at `hooks/.cursor/hooks/*` and run from the project root:

```json
{
  "version": 1,
  "hooks": {
    "beforeSubmitPrompt": [
      {
        "command": "hooks/.cursor/hooks/sensitive-prompt-guard.sh",
        "matcher": "UserPromptSubmit",
        "failClosed": true
      }
    ]
  }
}
```

If you prefer Cursor's conventional project-hook location, move the scripts into `.cursor/hooks/` and update the command paths to match.

You can comment out or remove any hooks you do not want to enable.

## Customization

- Edit `BLOCKED_REPO_NAMES` and `MODEL_BLOCKLIST` in `block-models-by-repo-origin.sh` to block specific model/repository substring combinations.
- Edit the patterns in `sensitive-prompt-guard.sh` to tune prompt blocking.
- Edit `SKILL_MAPPINGS` in `update-skills-on-stop.mjs` to map code paths to your own skills.
- Set `CURSOR_HOOK_LOG_DIR` to change the audit log directory.
- Set `CURSOR_HOOK_LOG_VERBOSE=1` to include shell output previews in audit logs.

## Notes

- Project hooks run from the project root.
- Trusted workspaces automatically load project hooks from `.cursor/hooks.json`. Similarly, you can define these hooks at a user level `~/.cursor` or organizational level (on cursor.com/dashboard).
- `audit-log.sh` uses `bash` and `jq`; verify those are available in the hook environment before enabling it.
- `block-models-by-repo-origin.sh` uses `git` and `bash`; verify those are available in the hook environment before enabling it.
- `sensitive-prompt-guard.sh` uses `bash` and `jq`; verify those are available in the hook environment before enabling it.
- `beforeSubmitPrompt` can block local prompt submission, but it is not available for cloud agents because the prompt is submitted before the cloud VM exists.
- Use an additional `subagentStart` hook if you also need to block subagents by model; `beforeSubmitPrompt` only covers the prompt submission that starts the main request.
- Logging hooks can capture sensitive information. Review what this example records before enabling it in a real repository.

