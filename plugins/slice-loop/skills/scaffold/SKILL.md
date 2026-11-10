---
name: scaffold
description: Slice Loop step 2 (TDD red). Turns the plan's acceptance criteria into failing tests, mocks, fixtures, E2E flow specs, and compile-only interface stubs, then proves each test fails for the right reason. Use for /scaffold, or after /plan-tasks in a loop slice.
---

# /scaffold — expected behavior, in code, failing

Scaffolding is the contract. `implement` makes it pass; `validate` holds `implement` to it. Write it so that a correct implementation is the only cheap way to turn it green.

## Load the loop

1. Read `.cursor/loop/LOOP.md`. If it is missing, run the `create-loop` skill first.
2. If `.cursor/loop/overlays/scaffold.md` exists, apply its Skip, Replace, and Add entries to the steps below, matched by heading.
3. Read `context/testing.md`. Read `context/validation.md` when the plan has e2e or visual proofs, and `context/domain.md` when criteria encode business rules.
4. Read `<run>/plan.md` and `<run>/state.json`. If the plan is missing, stop and run `plan-tasks` first.

## Steps

### 1. Map criteria to tests

For each `AC-n`, pick the cheapest test level that can actually prove it. That level is usually the one the plan named. Move it down a level only if the cheaper test still exercises the real behavior.

### 2. Write the tests

- Put new tests where `context/testing.md` says they go, and name them so the AC is obvious: `it("AC-2: rejects an empty title")`.
- Assert observable behavior: return values, rendered text, HTTP responses, files written. Never assert private calls or internal state that the user cannot see.
- One behavior per test. Add the unhappy paths the plan listed.

### 3. Mocks and fixtures

Follow the manifest's mock policy exactly:

- Mock at the boundary the policy names (network, SDK client, clock, filesystem). Never mock the unit under test.
- Reuse the existing helpers listed in `context/testing.md` before writing new ones.
- Fixtures are deterministic: fixed IDs, fixed timestamps, seeded randomness. When app state persists across flows in one boot, reset it with `boot.seed` (or reboot) before each flow. Only when no reset exists, use clearly labelled unique values (`"Renew passport [e2e-2]"`, not raw `Date.now()`), so screenshots stay readable.

### 4. E2E flow specs

For each e2e or visual proof, write the flow in the project's E2E tool. If the project has none, write a module in `.cursor/loop/flows/` for `run_flow.mjs`. Flow files are part of the test contract, exactly like test files. Each flow has:

- Steps written as user actions, using stable selectors (roles, labels, or `data-testid`).
- An assertion after each meaningful step.
- Named capture points, such as `capture("AC-1-populated")`. `validate` turns these into screenshots.

### 5. Interface stubs

Add the minimum signatures, types, routes, or components needed for the tests to compile and load. Make them throw or return a sentinel: `throw new Error("not implemented: AC-1")`. No logic.

### 6. Prove red

Run each new test file with `commands.test_single`. For flow proofs: boot (`boot.start`, then `boot.seed`), run each new flow with a short timeout (`--timeout 3000` for `run_flow.mjs`), then tear down. Every new test and flow must **fail**, and fail for the expected reason: the assertion or the not-implemented sentinel. An import error, syntax error, bad fixture, or a stale server on the port does not count. Fix the scaffolding until it fails cleanly.

Run the existing suite once. Scaffolding must not break existing tests, except where the plan says the behavior changes.

### 7. Record the contract

Write `<run>/scaffold.md`:

```markdown
| AC | Test / flow | Red reason (one line) |
| --- | --- | --- |
| AC-1 | `src/foo.test.ts` › "AC-1: ..." | not implemented: AC-1 |
```

Then list the mocks, fixtures, and stubs added, one line each, and the exact commands that reproduce red.

Commit the scaffold, including new flow files, as its own commit (`test(<slice-id>): scaffold AC-1..n`) when running under `implement-slice`. That gives `validate` a clean diff showing which tests `implement` changed later.

## Finish

Update `state.json`: set `phase` to `scaffold` and `status` to `done`. Return the contract table.
