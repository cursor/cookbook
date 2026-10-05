---
name: plan-tasks
description: Slice Loop step 1. Turns a requirement into a one-page slice plan with testable acceptance criteria, each mapped to the verification that will prove it. Use for /plan-tasks, when starting a loop slice, or when re-planning after review feedback or a spec-level validation failure.
---

# /plan-tasks — requirement → testable slice

## Load the loop

1. Read `.cursor/loop/LOOP.md`. If it is missing, run the `create-loop` skill first. Use autonomous mode when no human is present.
2. If `.cursor/loop/overlays/plan-tasks.md` exists, apply its Skip, Replace, and Add entries to the steps below, matched by heading.
3. Read the context files whose trigger in the manifest's Context index applies. `context/architecture.md` always applies here.
4. Run dir: `<dirs.runs>/<slice-id>/`. Name new slices `YYYYMMDD-<kebab-slug>`. Create `state.json` if it is absent (schema at the end of this file).

## Steps

### 1. Capture the requirement

Write the requirement verbatim to `<run>/slice.md`, with links and attachments listed. If it references a spec, ticket, or design, read the matching digest in `context/sources/`, or create one.

### 2. Read the code you will touch

Find the entrypoints, the nearest existing feature that behaves the way this one should, and the tests that cover it. A plan written without reading the code is a guess.

### 3. Cut the slice

One slice is the smallest change a user or caller can observe, sized per the manifest. If the requirement is bigger, plan the first slice only, and list the rest under **Later slices**. Do not plan them.

### 4. Write acceptance criteria

Every criterion gets:

- An ID: `AC-1`, `AC-2`, and so on.
- Given / When / Then wording in terms the user or caller observes. Avoid implementation terms.
- **Proof**: `unit`, `integration`, `e2e`, or `visual`, plus the test file or flow name that will prove it.

Include at least one unhappy-path criterion (invalid input, empty state, failure, or permission denied) unless the slice truly has none. If so, say why.

For UI slices, name the screens and states to capture: empty, loading, error, populated, and mobile when it matters.

### 5. Plan the evidence

List the E2E flows `validate` will run: the new flow or flows, plus the canonical regression flows from `context/validation.md` that the slice could break.

### 6. Write the plan

Fill `templates/plan.md` into `<run>/plan.md`. Keep it to one page; the reviewer reads it first.

Unknowns: in interactive mode, ask with `AskQuestion` (at most 3 questions, with options pre-filled). In autonomous mode, choose the conservative option and list it under **Assumptions**.

### 7. Re-planning

When called with review feedback or a `validate` verdict of `spec-gap`:

- Edit the existing `plan.md`. Do not start a new one. Mark changed criteria `(revised)` and new ones `(new)`.
- Append the feedback verbatim under **Feedback log**.
- Increment `replans` in `state.json`. If it now exceeds `limits.replans`, stop and report instead of looping.

## Finish

Update `state.json`: set `phase` to `plan-tasks` and `status` to `done`, and append to `history`. Return the path to `plan.md` and the AC list.

## state.json schema

```json
{
  "slice_id": "20261005-add-csv-export",
  "phase": "plan-tasks | scaffold | implement | validate | review | reflect",
  "status": "in_progress | done | awaiting_review | approved | failed | blocked",
  "iteration": 0,
  "replans": 0,
  "verdict": null,
  "history": [{ "phase": "plan-tasks", "status": "done", "at": "ISO-8601", "note": "" }]
}
```
