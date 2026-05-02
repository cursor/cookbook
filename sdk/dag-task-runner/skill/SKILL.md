---
name: dag-task-runner
description: Decompose a user's task into a DAG of subtasks and execute them with Cursor SDK local subagents in topological order, rendering live streaming status to a canvas. Each task has a complexity (HIGH/MED/LOW) that maps to a model. Use when the user asks to fan out work, decompose a task into a DAG, run subagents in parallel, or break a large task into a dependency graph.
---

# DAG Task Runner

Decomposes a user-described task into a JSON DAG, then runs each node as a Cursor SDK local subagent (with parents' outputs stitched into the child's prompt). Live DAG state — including each running subagent's streaming output — is rendered into a `.canvas.tsx` that the runner rewrites on every status transition; the IDE hot-recompiles so the user sees subagents move through `PENDING -> RUNNING -> FINISHED/ERROR` in real time.

This skill can run from either a project skill (`.cursor/skills/dag-task-runner`) or a personal skill (`~/.cursor/skills/dag-task-runner`). The installed runner entry point is `scripts/run_dag.ts` inside the skill directory. Set `DAG_RUNNER_DIR` to override the auto-detected `scripts` directory.

## When to use

Trigger when the user says any of:

- "decompose this task", "break this into a DAG", "fan out subagents"
- "run this as a graph of subtasks"
- a multi-step request where some steps clearly depend on others and others can run in parallel

Skip when the task is a single-shot edit, a quick question, or already linear enough that one agent turn would handle it.

## Workflow

### Step 1 — Generate a DAG JSON

You (the parent agent) author the DAG inline using your understanding of the user's task. Schema:

```json
{
  "title": "<short human-readable title for the run>",
  "models": {
    "HIGH": "gpt-5.3-codex",
    "MED": "composer-2",
    "LOW": "auto-low"
  },
  "tasks": [
    {
      "id": "<unique kebab-case id>",
      "depends_on": ["<id>", "..."],
      "complexity": "HIGH | MED | LOW",
      "subtask_prompt": "<self-contained prompt for the subagent>"
    }
  ]
}
```

Rules:

- Every `depends_on` entry must reference another task's `id`.
- No cycles. The runner rejects cyclic DAGs at parse time.
- `complexity` controls the model the subagent uses (see table below). Pick `HIGH` for novel/complex reasoning, `MED` for typical implementation, `LOW` for mechanical/lookup tasks.
- Optional top-level `models` can override the default complexity → model map for this DAG.
- `subtask_prompt` should read like a standalone request — the runner automatically prepends a short summary of upstream task outputs, so you do not need to repeat them.
- Do **not** put two tasks that write to the same file in the same rank (siblings within a rank run concurrently and would race).

#### Maximize parallelism — this is the whole point of the runner

The runner executes tasks within a rank **concurrently** via `Promise.all`. A linear `A → B → C → D` DAG wastes that capability. Before finalizing the DAG, actively decompose the problem to surface independent work:

1. **Default to no dependencies.** Add a `depends_on` entry **only** when the child task literally cannot start without the parent's output. "Logically follows" is not a dependency.
2. **Split read-only research and discovery into a wide first rank.** Codebase grepping, doc reading, dependency scans, schema lookups, test inventory — these almost always share rank 1 with no edges between them.
3. **Fan out post-implementation work.** Tests, docs, changelog entries, type updates, lint fixes typically all depend on the same implementation task and on nothing else — put them in one rank, not a chain.
4. **Use diamonds, not lines.** If two tasks both feed into a third, model that explicitly: rank 1 has the two parents, rank 2 is the merge.
5. **Same-rank file-write safety.** The one hard constraint: don't put two tasks in the same rank if they would write the same file. Either serialize them with a `depends_on`, or merge them into one task.

Quality bar: when you sketch the rank structure (rank 1 → rank 2 → …), at least one rank should contain more than one task in any non-trivial problem. If your DAG is a single chain of 1-task ranks, you almost certainly missed parallelism — go back and look again.

The example shipped with the runner (`examples/example_dag.json`) demonstrates the pattern: rank 1 fans out to two read-only research tasks, rank 2 merges them into a design, rank 3 implements, and rank 4 fans out again to tests + docs.

Write the JSON to a temp file **and immediately generate the initial canvas** so the user can open it while subagents spin up. Run all of the following in a single shell block:

```bash
# 0. Locate the runner and pick a canvas path
resolve_runner_dir() {
  if [ -n "${DAG_RUNNER_DIR:-}" ] && [ -f "$DAG_RUNNER_DIR/run_dag.ts" ]; then
    printf '%s\n' "$DAG_RUNNER_DIR"
    return 0
  fi

  git_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  for dir in \
    "$PWD/.cursor/skills/dag-task-runner/scripts" \
    "${git_root:+$git_root/.cursor/skills/dag-task-runner/scripts}" \
    "$HOME/.cursor/skills/dag-task-runner/scripts"
  do
    if [ -n "$dir" ] && [ -f "$dir/run_dag.ts" ]; then
      printf '%s\n' "$dir"
      return 0
    fi
  done

  echo "Could not find dag-task-runner/scripts. Copy .cursor/skills/dag-task-runner into this project, install it under ~/.cursor/skills, or set DAG_RUNNER_DIR." >&2
  return 1
}

RUNNER_DIR="$(resolve_runner_dir)"
CANVAS_PATH="$HOME/.cursor/projects/<workspace-slug>/canvases/dag-<slug>.canvas.tsx"

# 1. Write the DAG JSON
cat > /tmp/dag-<slug>.json <<'JSON'
{ "title": "...", "tasks": [ ... ] }
JSON

# 2. Ensure deps are installed (skips if already present)
[ -x "$RUNNER_DIR/node_modules/.bin/tsx" ] || \
  (cd "$RUNNER_DIR" && (pnpm install --silent || npm install --silent))

# 3. Generate the initial all-PENDING canvas (no CURSOR_API_KEY needed)
"$RUNNER_DIR/node_modules/.bin/tsx" "$RUNNER_DIR/run_dag.ts" \
  --init-only \
  --dag /tmp/dag-<slug>.json \
  --canvas-path "$CANVAS_PATH"

# 4. Best-effort auto-open of the canvas file; ignore failure in headless/non-macOS environments
open "$CANVAS_PATH" >/dev/null 2>&1 || true
```

The canvas path is:

```
~/.cursor/projects/<workspace-slug>/canvases/dag-<slug>.canvas.tsx
```

`<workspace-slug>` is derived from the cwd's absolute path with `/` and other special chars replaced by `-`. To compute it, take `pwd`, strip the leading `/`, and replace each remaining `/` with `-`. Example: cwd `/Users/me/Code/myapp` → slug `Users-me-Code-myapp`. Use the same `<slug>` you used for the DAG JSON filename so they're easy to correlate.

### Step 2 — Surface the canvas link in chat

Now that the file exists on disk, post a Markdown hyperlink with the exact text `Open Canvas` and a `file://` URL, plus the absolute path for fallback:

> I created a live canvas: [Open Canvas](file:///Users/<user>/.cursor/projects/<workspace-slug>/canvases/dag-<slug>.canvas.tsx)
> Fallback path: `/Users/<user>/.cursor/projects/<workspace-slug>/canvases/dag-<slug>.canvas.tsx`

Always use the link text `Open Canvas`. Use the absolute path in both the `file://` URL and fallback path, never `~/`. Do this **before** Step 3 so the user can open the canvas while subagents are still spinning up. The Step 1 shell block already attempts to auto-open the canvas with `open`; if that fails, continue and rely on the chat link.

### Step 3 — Run the DAG

Ensure `CURSOR_API_KEY` is set (the runner fails fast if missing), then launch:

```bash
[ -n "$CURSOR_API_KEY" ] || { [ -f .env ] && set -a && source .env && set +a; }

"$RUNNER_DIR/node_modules/.bin/tsx" "$RUNNER_DIR/run_dag.ts" \
  --dag /tmp/dag-<slug>.json \
  --canvas-path "$CANVAS_PATH"
```

Same `--canvas-path` as Step 1. The runner:

1. Validates the DAG and reuses the existing canvas file.
2. For each rank (Kahn topo-sort), launches ready tasks concurrently as local Cursor SDK agents and rewrites the canvas as each one transitions, streaming assistant text into each task card live.
3. Automatically skips tasks whose upstream dependencies failed (marks them `ERROR` with a "Skipped: upstream task(s) … failed" message).
4. Captures each subagent's final assistant text, status, token usage, and duration.
5. Writes a final canvas with summary stats.
6. On SIGINT/SIGTERM/SIGHUP, cancels all in-flight subagents before finalizing the canvas.

#### CLI knobs

| Flag | Default | Purpose |
|------|---------|---------|
| `--models-file <path>` | — | JSON file containing a partial complexity → model override map. |
| `--task-timeout-ms <ms>` | `1200000` (20 min) | Marks a task `ERROR` if it runs too long. |
| `--stream-publish-ms <ms>` | `500` | Throttles live canvas streaming writes. |
| `--stream-idle-timeout-ms <ms>` | `300000` (5 min) | Marks a task `ERROR` if no stream events arrive. |
| `--debounce <ms>` | `200` | Canvas write debounce interval. |

### Step 4 — Summarize

After the runner exits, briefly summarize what completed/failed and re-link the canvas with the exact text `[Open Canvas](file:///Users/<user>/.cursor/projects/<workspace-slug>/canvases/dag-<slug>.canvas.tsx)` so the user can scroll back to it. Include the absolute fallback path only if useful.

## Complexity → model

| Complexity | Model              |
|------------|--------------------|
| HIGH       | `gpt-5.3-codex`   |
| MED        | `composer-2`       |
| LOW        | `auto-low`         |

Override any subset inline with top-level DAG `models`, or pass a reusable profile with `--models-file <path>`. Precedence is defaults < DAG `models` < `--models-file`. The Cursor SDK model catalog can vary by account; use `Cursor.models.list()` from the SDK docs to confirm available IDs.

## Auth

The runner reads `CURSOR_API_KEY` from the environment. Set it however you usually manage secrets:

```bash
export CURSOR_API_KEY=crsr_...
```

If the current workspace has a `.env` containing it, source that first:

```bash
set -a && source .env && set +a
```

## CLI options

| Flag                        | Default              | Notes                                                                              |
|-----------------------------|----------------------|------------------------------------------------------------------------------------|
| `--dag`                     | required             | Path to the DAG JSON file.                                                         |
| `--canvas-path`             | composed from below  | Full absolute path to the canvas file. Preferred — used by the parent-managed flow.|
| `--canvas`                  | —                    | Canvas filename stem (no `.canvas.tsx`). Used only if `--canvas-path` is omitted.   |
| `--canvases-dir`            | derived from cwd     | Override the canvases output directory. Used only with `--canvas`.                 |
| `--cwd`                     | `process.cwd()`      | Working dir each subagent operates in.                                             |
| `--models-file`             | —                    | JSON file containing a partial complexity → model override map.                    |
| `--debounce`                | `200` (ms)           | Canvas write debounce interval.                                                    |
| `--init-only`               | `false`              | Write the initial all-`PENDING` canvas and exit. No `CURSOR_API_KEY` required.     |
| `--task-timeout-ms`         | `1200000` (20 min)   | Marks a task `ERROR` if it exceeds this duration.                                  |
| `--stream-publish-ms`       | `500` (ms)           | Throttles live canvas streaming writes to avoid excessive cloning.                 |
| `--stream-idle-timeout-ms`  | `300000` (5 min)     | Marks a task `ERROR` if no stream events arrive within this window.                |

## Caveats

- Local runtime only — every subagent runs against `--cwd` (defaults to wherever you invoke the runner).
- Sibling tasks in the same rank run in parallel; do not let them write the same files.
- Inline MCP servers and sub-sub-agents are not configured by this runner.
- A failed task automatically skips all downstream dependents (they are marked `ERROR` with a "Skipped: upstream task(s) … failed" message). This prevents wasted API calls on tasks whose inputs are missing.
- Per-task streamed text is capped at `STREAM_CAP = 4000` chars to keep the canvas file modest. Upstream context passed to child tasks is capped at 2000 chars per parent.
- Timed-out tasks are marked `ERROR` instead of staying indefinitely in `RUNNING`.
- SIGINT/SIGTERM/SIGHUP gracefully cancel all in-flight subagents and finalize the canvas before exiting.
- Unexpected unhandled rejections from SDK internals are suppressed to prevent runner crashes; uncaught exceptions are logged and trigger a clean shutdown.

## Reference

- DAG schema example: `examples/example_dag.json` (sibling of this skill after install)
- Runner entry point after install: `run_dag.ts` inside `$RUNNER_DIR`
- Cursor SDK docs: https://cursor.com/docs/api/sdk/typescript
