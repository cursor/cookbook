---
name: implement
description: Slice Loop step 3 (TDD green). Writes the smallest production change that turns the scaffolded tests green while following project conventions; never weakens the contract. Use for /implement, after /scaffold, or when /validate sends a slice back with failures.
---

# /implement — make it green, honestly

## Load the loop

1. Read `.cursor/loop/LOOP.md`. If it is missing, run the `create-loop` skill first.
2. If `.cursor/loop/overlays/implement.md` exists, apply its Skip, Replace, and Add entries to the steps below, matched by heading.
3. Read `context/architecture.md`, plus `context/domain.md` when the slice touches business rules.
4. Read `<run>/plan.md`, `<run>/scaffold.md`, and `<run>/state.json`. On a retry, also read the latest `<run>/validate/report.md`. Its **Failures** section is your work list.

## Steps

### 1. Pick the next red test

Work one AC at a time, in plan order. On a retry, work the failures that `validate` reported, and nothing else.

### 2. Write the smallest change

- Follow the pattern file the plan named. Match the surrounding naming, error handling, and style.
- Respect `off_limits` and the "not editable" list in `context/architecture.md`. If generated code needs to change, edit its source and run the generator.
- No speculative abstractions, config switches, or features outside the plan.

### 3. Run the tight loop

After each change, run `commands.test_single` on the AC's test. For an AC proven by a flow, boot, seed, run the flow (with a short `--timeout`), and tear down. Move on when it is green. Run lint and typecheck on the touched files before leaving the step.

### 4. Never weaken the contract

Do not edit, skip, or delete scaffolded tests or flow files to get green. If a test is genuinely wrong (it contradicts the plan or asserts the impossible):

1. Fix it minimally.
2. Log it in `<run>/implement.md` under **Test changes**, with the AC, the diff summary, and why.

`validate` diffs the test files against the scaffold commit and fails any change that isn't logged.

### 5. Finish the slice

When all AC tests pass, run the full `commands.test` once. Fix any regressions you caused. If a pre-existing test was already failing before your change, note it; don't fix it unless the plan says to.

## Retry bookkeeping

Append to `<run>/implement.md` for every pass:

```markdown
## Iteration <n>
- Fixed: AC-2 (empty title not rejected — added guard in `createTask`)
- Remaining: none
- Test changes: none
```

Increment `iteration` in `state.json`. If `iteration` now exceeds `limits.implement_iterations`, set `status` to `blocked` with the reason and stop. Repeating a failing approach is worse than reporting it.

## Finish

Commit as `feat(<slice-id>): <summary>` when running under `implement-slice`. Update `state.json`: set `phase` to `implement` and `status` to `done`. Return the list of files changed.
