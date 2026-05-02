# Code Reviewer

A minimal Cursor SDK example that turns a git diff into a structured code review. Streams a Claude agent over `git diff <base>...<head>`, parses the JSON response, and prints either a human report or machine-readable JSON for CI.

## What it does

- Resolves a three-dot diff (`base...head`) so it reviews only the work on `head`, just like a GitHub PR view.
- Sends the diff to a Cursor SDK agent with a strict JSON output contract (`summary` + `comments[]`).
- Validates the agent's response against a known schema before printing.
- Exits non-zero when a comment meets `--fail-on` severity, so it can gate CI.

## Getting Started

Use Node.js 22 or newer.

Install dependencies:

```bash
pnpm install
```

Set a Cursor API key:

```bash
export CURSOR_API_KEY="crsr_..."
```

Review the changes on the current branch since `main`:

```bash
pnpm dev
```

Build and run the compiled example:

```bash
pnpm build
pnpm start
```

## Options

| Flag | Default | Notes |
|------|---------|-------|
| `--base <ref>` | `main` | Base ref for the three-dot diff. |
| `--head <ref>` | `HEAD` | Head ref. |
| `--json` | off | Emit JSON to stdout instead of a human report. |
| `--max-diff-bytes <N>` | `100000` | Refuse diffs larger than N bytes. |
| `--model <id>` | `$CURSOR_MODEL` or `claude-4.6-sonnet-high` | Any Cursor model id. |
| `--fail-on <severity>` | `high` | Exit non-zero on this severity or higher (`low`, `medium`, `high`, `critical`). |
| `--cwd <path>` | `process.cwd()` | Working directory for `git` and the agent. |

Examples:

```bash
# Review the current branch against origin/main and gate on critical findings only
pnpm dev -- --base origin/main --fail-on critical

# Review the last 5 commits and pipe JSON into jq
pnpm dev -- --base HEAD~5 --json | jq '.comments[] | select(.severity == "high")'

# Review a feature branch from a CI checkout
pnpm dev -- --base main --head feature/payments --cwd "$GITHUB_WORKSPACE"
```

## Output schema

`--json` emits a single object:

```json
{
  "summary": "Refactors login to async; one missing null guard.",
  "comments": [
    {
      "file": "src/auth.ts",
      "line": 42,
      "severity": "high",
      "category": "bug",
      "comment": "user.email may be undefined when SSO is disabled, causing .toLowerCase() to throw.",
      "suggestion": "if (!user?.email) throw new ValidationError('email required')"
    }
  ]
}
```

`severity` is one of `low | medium | high | critical`, `category` is one of `bug | security | performance | style | design | test`, and `line` refers to the line in the post-change file (or `null` for file-level comments).

## Notes

- The agent sees the diff text only — it does not browse the rest of the repo. For deeper review, raise `--max-diff-bytes` or run from a workspace where the agent can read context.
- Override the default model with `CURSOR_MODEL` or `--model`. The SDK accepts ids like `claude-4.6-sonnet-high`, `claude-4.6-opus-max`, `composer-2`, and `gpt-5.3-codex`.
- For a more interactive review experience with model picking and a TUI, see [Coding Agent CLI](../coding-agent-cli).
