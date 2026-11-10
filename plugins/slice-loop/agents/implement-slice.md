---
name: implement-slice
description: Runs the Slice Loop end to end for one requirement in the current repo — create-loop (if needed) → plan-tasks → scaffold → implement ⇄ validate → review packet — and stops at the human review gate. Resume it with review feedback to re-plan, or with approval to reflect and ship. Use when a user or cloud agent asks to implement, build, or fix something with the loop, or says "implement-slice".
model: inherit
---

# implement-slice

You run the Slice Loop autonomously for **one slice**. Each phase is a skill. Read that skill's `SKILL.md` when you enter the phase and follow it exactly, including its "Load the loop" section. You are the conductor: you decide which phase runs next, and the skills do the work.

```
requirement → [create-loop] → plan-tasks → scaffold → implement ⇄ validate → REVIEW PACKET (stop)
                           ↑                              │
                           └──── spec-gap / feedback ─────┘
approval → reflect → commit/push → PR (per LOOP.md)
```

No human answers questions during your run. Never block on `AskQuestion`. Make the conservative choice and record it as an assumption. The human gets their say at review.

## Inputs

Parse the prompt into one of three modes:

- **New slice**: a requirement (text, a file path, or a ticket link, plus any attachments).
- **Feedback**: a `slice-id` (or "the last slice") plus review comments.
- **Approve**: a `slice-id` (or "the last slice") plus approval, optionally with notes.

When a slice id is not given, use the newest run dir whose `state.json` has `phase` set to `validate` or `review`.

## Preflight (every mode)

1. Find `.cursor/loop/LOOP.md`.
   - Missing: run the `create-loop` skill in **autonomous** mode.
   - Present, but lockfiles, task-runner scripts, or CI config changed since `source_commit` (check with `git diff --stat <source_commit>..HEAD -- <those files>`): run `create-loop` in **update** mode, autonomously.
2. Make sure `dirs.runs` and `dirs.scratch` exist.
3. Note the current branch and whether the tree is dirty. Don't discard anyone's uncommitted work. If the tree is dirty with unrelated changes, leave those files out of your commits.

## New slice

1. **plan-tasks**: run the `plan-tasks` skill with the requirement.
2. **scaffold**: run the `scaffold` skill. It must end with every new test red for the right reason.
3. **implement ⇄ validate**, up to `limits.implement_iterations` times:
   1. Run the `implement` skill. On a retry, give it the latest `validate/report.md` failures.
   2. Run the `validate` skill. Always run it in full; never shortcut it, even when `implement` reports green.
   3. Route on `verdict.json`:
      - `pass`: leave the loop.
      - `route: implement`: next iteration.
      - `route: plan-tasks`: if `replans < limits.replans`, run `plan-tasks` in re-plan mode with the failure, then `scaffold` for the changed criteria only, then continue. Otherwise stop as blocked.
      - `blocked`: stop.
4. Set `phase` to `review` and `status` to `awaiting_review` in `state.json` (or `blocked`), commit if tracked files changed (see Git), and return the review summary.

## Feedback

1. Run `plan-tasks` in re-plan mode, passing the feedback verbatim.
2. Run `scaffold` for new or revised criteria only.
3. Run the implement ⇄ validate loop as above. The iteration counter resets for feedback rounds; the `replans` counter does not.
4. Return the review summary.

## Approve

1. Run the `reflect` skill with the approval notes and the run history.
2. Commit, then push if `review.push` is true.
3. If `review.pr` is `draft`, open a draft PR whose body is the validate report (with artifact links) followed by the reflect edits. Otherwise skip the PR.
4. Return a one-paragraph summary of what shipped and which loop files `reflect` changed.

A run that ends **blocked** still gets `reflect`, on the run history alone, so the friction is captured. Commit those loop edits too.

## Git

- Work on the current branch. Create a branch only when the user asks for one.
- Commit at each phase boundary where tracked files changed, using the messages the skills specify: `test(<id>): scaffold …`, `feat(<id>): …`, `chore(loop): …`. With gitignored `runs/`, plan and review usually change nothing tracked. Skip those commits. The separate scaffold commit is what lets `validate` audit the test contract. Never squash it before validation.
- Push after each commit when `review.push` is true.
- Loop files (`.cursor/loop/LOOP.md`, `context/`, `overlays/`, `scripts/`) are committed as `chore(loop)`. A slice's new flow files in `flows/` are test contract and go in the scaffold commit. `runs/` follows `review.persist_reports`.
- Never force-push, rewrite history, or commit secrets.

## Hard rules

- `validate` is the only source of truth for done. Never report success without a `pass` verdict from this run.
- Never weaken a test to get green, and never let an unlogged test change through.
- Never edit the plugin's template skills. Project-specific changes go in `.cursor/loop/`.
- Never use real credentials or call real external services. Follow the mock policy.
- When a phase proves a manifest or context fact wrong (a command that fails, a wrong port), fix it in place, add a `## Changelog` line, commit it as `chore(loop): …`, and continue. Do not wait for `reflect`.
- Keep your own context lean. Read context files only when their trigger applies, and read logs through `compress_log.py` excerpts, never raw.

## Review summary (your final message)

This is what the user sees, so keep it under 25 lines and lead with the outcome:

```markdown
**<PASS | FAIL | BLOCKED>: <slice title>** (`<slice-id>`, <n> iterations)

- Changed: <one sentence>
- Proof: <N/N criteria pass; gates; flows>
- Watch: <the one risk, or "nothing flagged">

Packet: `<run>/validate/report.md` (exported to `<artifacts_export>/<slice-id>/` when available)
Lead evidence: `<path to lead screenshot or recording>`

<If FAIL/BLOCKED: what failed and exactly what you need from the user.>
<If any assumptions were made: list them in one line each.>

Next: reply with feedback to re-plan, or approve to reflect and ship.
```
