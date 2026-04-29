# DAG Task Runner

Decompose a task into a JSON DAG, run each node as a Cursor SDK local subagent in topological order, and stream live status into a [Cursor Canvas](https://cursor.com/docs/canvases) that hot-reloads on every state change.

![Live DAG Canvas preview](docs/demo_vid_dag.gif)

> Recorded run of the canvas. The IDE re-renders the canvas every time the runner writes new state to disk, so you watch tasks march through `PENDING → RUNNING → FINISHED/ERROR` in real time.

## What it does

- **Authors a DAG** of subtasks with explicit `depends_on` edges and per-task `complexity` (HIGH / MED / LOW), which the runner maps to Cursor models via configurable defaults.
- **Topo-sorts** the DAG into ranks (Kahn's algorithm) and runs each rank concurrently with `Promise.all`, so independent work fans out automatically.
- **Stitches upstream output** into each child's prompt — children get a 2,000-char snippet of every parent's result without you re-describing it.
- **Streams live** to a `.canvas.tsx` file. Cursor recompiles the canvas on every write, so you see token-by-token output land in each task card.
- **Fails safe**: timeouts mark a task `ERROR` instead of hanging, downstream dependents auto-skip, and SIGINT/SIGTERM cancel in-flight subagents and finalize the canvas before exit.

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

Render the initial canvas (no API key required) so you can open it before kicking off the run:

```bash
pnpm init-canvas
open .canvas/dag-example.canvas.tsx
```

Run the included example DAG end-to-end:

```bash
pnpm example
```

The example builds a tiny single-file CLI todo app. Tasks run against `process.cwd()` by default, so use a scratch directory if you don't want files written into the cookbook:

```bash
mkdir -p /tmp/dag-demo && cd /tmp/dag-demo
CURSOR_API_KEY="crsr_..." \
  pnpm --dir ~/Code/cookbook/sdk/dag-task-runner \
  dev -- --dag examples/example_dag.json --canvas-path "$PWD/dag-example.canvas.tsx" --cwd "$PWD"
```

Watch [`dag-example.canvas.tsx`](./examples/example_dag.json) refresh as each rank moves through:

```
[dag-runner] DAG "Build a tiny CLI todo app" — 6 tasks across 4 rank(s)
[dag-runner] rank 1/4: research-stack, research-cli-conventions
[dag-runner] rank 2/4: design
[dag-runner] rank 3/4: implement
[dag-runner] rank 4/4: tests, docs
[dag-runner] done — 6/6 succeeded in 1m 47s
```

## DAG schema

```json
{
  "title": "Build a tiny CLI todo app",
  "models": {
    "HIGH": "gpt-5.3-codex",
    "MED": "composer-2",
    "LOW": "composer-2-fast"
  },
  "tasks": [
    {
      "id": "research-stack",
      "depends_on": [],
      "complexity": "LOW",
      "subtask_prompt": "Sketch the smallest reasonable design …"
    }
  ]
}
```

| Field            | Required | Notes                                                                 |
|------------------|----------|-----------------------------------------------------------------------|
| `id`             | yes      | Unique kebab-case identifier referenced by other tasks' `depends_on`. |
| `depends_on`     | yes      | Array of `id`s. Empty for rank-1 tasks. Cycles rejected at parse.     |
| `complexity`     | yes      | `HIGH`, `MED`, or `LOW`. Resolved through the model map below.        |
| `subtask_prompt` | yes      | Self-contained prompt — the runner prepends a summary of upstream output. |
| `models`         | no       | Top-level partial complexity → model override map.                    |

See [`examples/example_dag.json`](./examples/example_dag.json) for a worked example.

## Complexity model map

By default, complexities map to:

| Complexity | Default model      |
|------------|--------------------|
| `HIGH`     | `gpt-5.3-codex`    |
| `MED`      | `composer-2`       |
| `LOW`      | `composer-2-fast`  |

Override any subset inline in the DAG with a top-level `models` object, or keep reusable profiles in a JSON file:

```json
{
  "HIGH": "gpt-5.3-codex",
  "MED": "composer-2-fast",
  "LOW": "composer-2-fast"
}
```

Then run with:

```bash
pnpm dev -- --dag examples/example_dag.json --models-file ./models.fast.json --canvas-path "$PWD/.canvas/dag-example.canvas.tsx"
```

Precedence is defaults < DAG `models` < `--models-file`.

## CLI options

| Flag                        | Default              | Notes                                                                              |
|-----------------------------|----------------------|------------------------------------------------------------------------------------|
| `--dag`                     | required             | Path to the DAG JSON file.                                                         |
| `--canvas-path`             | composed             | Full absolute path to the canvas file. Preferred for the parent-managed flow.       |
| `--canvas`                  | —                    | Canvas filename stem (no `.canvas.tsx`). Used only if `--canvas-path` is omitted.   |
| `--canvases-dir`            | per-workspace        | Override the canvases output directory. Used only with `--canvas`.                  |
| `--cwd`                     | `process.cwd()`      | Working dir each subagent operates in.                                              |
| `--models-file`             | —                    | JSON file containing a partial complexity → model override map.                     |
| `--init-only`               | `false`              | Write the initial all-`PENDING` canvas and exit. No `CURSOR_API_KEY` required.      |
| `--debounce`                | `200` ms             | Canvas write debounce interval.                                                     |
| `--task-timeout-ms`         | `1200000` (20 min)   | Marks a task `ERROR` if it exceeds this duration.                                  |
| `--stream-publish-ms`       | `500` ms             | Throttles live canvas streaming writes.                                             |
| `--stream-idle-timeout-ms`  | `300000` (5 min)     | Marks a task `ERROR` if no stream events arrive within this window.                |

## Install as a Cursor skill

The runner ships with a [SKILL.md](./skill/SKILL.md) so the Cursor agent can invoke it automatically when a user asks to "decompose this task as a DAG", "fan out subagents", etc.

Install it as a personal skill (available across every workspace):

```bash
./scripts/install-skill.sh
```

This copies `skill/SKILL.md`, `examples/`, and the runner sources into `~/.cursor/skills/dag-task-runner/`, then `pnpm install`s the runner's dependencies. To install at a custom location:

```bash
DEST=~/work/skills/dag-task-runner ./scripts/install-skill.sh
export DAG_RUNNER_DIR="$HOME/work/skills/dag-task-runner/scripts"
```

To install as a project-scoped skill instead, copy the same files into `<your-project>/.cursor/skills/dag-task-runner/`.

## Project layout

```
sdk/dag-task-runner/
├── README.md                     # this file
├── package.json                  # @cursor/sdk ^1.0.9, tsx, typescript
├── tsconfig.json
├── pnpm-workspace.yaml
├── src/
│   ├── run_dag.ts                # entry point + per-task lifecycle
│   ├── dag.ts                    # parse, validate, cycle-check, topo-sort
│   └── canvas_writer.ts          # debounced .canvas.tsx renderer
├── examples/
│   └── example_dag.json          # 6-task "tiny CLI todo app" demo DAG
├── docs/
│   ├── dag-canvas-preview.png    # canvas screenshot
│   └── demo_vid_dag.gif          # animated canvas demo used in this README
├── skill/
│   └── SKILL.md                  # personal-skill entry, copied by install-skill.sh
└── scripts/
    └── install-skill.sh          # one-shot installer for ~/.cursor/skills/
```

## Notes

- The runner uses the local Cursor SDK runtime — every subagent runs against `--cwd` (defaults to wherever you invoke the runner).
- Sibling tasks in the same rank run in parallel; do not let them write the same files.
- Per-task streamed text is capped at 4,000 chars and upstream context passed to children is capped at 2,000 chars per parent, to keep the canvas file modest.
- For a deeper API tour, see the [Cursor SDK TypeScript docs](https://cursor.com/docs/api/sdk/typescript) and the sibling [Quickstart](../quickstart) example.
