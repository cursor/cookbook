---
name: reflect
description: Slice Loop step 6. After human review, turns review feedback and loop friction (retries, misroutes, broken harness steps, wrong assumptions) into small, evidence-backed edits to the project's loop context and overlays under .cursor/loop/, so the next slice runs better. Use for /reflect, after a slice is reviewed, or after a run ends blocked.
---

# /reflect — make the next run better

`/create-loop` shapes the loop from the code. `/reflect` reshapes it from experience. It edits only the project's loop files (`.cursor/loop/context/`, `.cursor/loop/overlays/`, `.cursor/loop/scripts/`, `LOOP.md`), never the plugin's template skills. Ideas for changing the templates go in the report as upstream suggestions.

## Load the loop

1. Read `.cursor/loop/LOOP.md`, and `.cursor/loop/overlays/reflect.md` if it exists.
2. Read the whole run: `<run>/state.json`, `plan.md` (especially **Feedback log** and **Assumptions**), `scaffold.md`, `implement.md`, `validate/report.md`, `validate/verdict.json`, and `validate.prev/` when present.
3. Read the review feedback you were given, verbatim. When reflecting on a blocked run with no review, the run history is the input.

## Steps

### 1. Collect signals

List each one with its evidence (file and line):

- **Review feedback**: anything the reviewer corrected, asked for, or disliked, in the code or in the packet.
- **Retries**: every `implement` iteration after the first, with its failure class.
- **Misroutes**: a failure classified as `impl-bug` that turned out to be a `spec-gap`, or the reverse.
- **Harness friction**: commands that failed, ports that clashed, flaky steps, slow boots.
- **Wrong assumptions**: entries in `LOOP.md` or `plan.md` that turned out false.
- **Packet gaps**: evidence the reviewer had to ask for, or content they ignored.

### 2. Decide what to codify

Codify a signal only when it is likely to recur. Good tests for that:

- It came from the reviewer, or
- It happened twice (in this run, or matching an earlier `reflect.md` in `<dirs.runs>`), or
- It is a fact about the project that the loop got wrong.

Do not codify one-off details of this slice, such as the slice's own business logic. Those belong in the code and its tests.

### 3. Make the edits

Use the smallest edit that would have prevented the problem:

| Signal | Edit |
| --- | --- |
| A fact was wrong or missing | `context/<file>.md` |
| A template step was wrong for this project | `overlays/<skill>.md` (Add / Replace / Skip) |
| A command or harness step was wrong | `LOOP.md` frontmatter or `scripts/*`; re-run it to prove the fix |
| An assumption is now confirmed or refuted | Move it out of `## Assumptions` in `LOOP.md` and into the right file |
| The reviewer wants different evidence | `context/review.md` |

Edit what exists in place; rewriting files loses earlier lessons. Keep every file scannable: if a context file passes about 150 lines, consolidate it.

### 4. Log it

Append one line per edit to `## Changelog` in `LOOP.md`: `YYYY-MM-DD reflect(<slice-id>): <what changed> — <why, citing the signal>`.

Write `<run>/reflect.md`:

```markdown
# Reflect: <slice-id>

## Signals
- <signal> — <evidence>

## Edits
- `<file>`: <change> — <signal it addresses>

## Not codified
- <signal> — <why it is one-off>

## Upstream suggestions
- <template skill>: <change that would help every project, not just this one>
```

## Finish

Commit as `chore(loop): reflect <slice-id>` when running under `implement-slice`, so the edits ship in the same PR as the slice. Update `state.json`: set `phase` to `reflect` and `status` to `done`. Return the list of edits.
