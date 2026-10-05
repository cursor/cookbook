---
name: create-loop
description: Onboard the Slice Loop into the current codebase. Discovers the stack, commands, surfaces, and validation harness; asks the user only what the code cannot answer (via AskQuestion); then writes the project-specific loop under .cursor/loop/ (LOOP.md manifest, domain context files, per-skill overlays, scratch dirs, harness scripts). Use for /create-loop, "set up the loop", "adapt the loop to this repo", or when another loop skill finds .cursor/loop/LOOP.md missing or stale.
---

# /create-loop — morph the loop to this project

The loop skills (`plan-tasks`, `scaffold`, `implement`, `validate`, `reflect`) are templates. They are generic on purpose. `/create-loop` makes them specific to this codebase **without editing the templates**. It writes project files the templates are required to read:

```
.cursor/loop/
├── LOOP.md                 # manifest: commands, surfaces, boot, gates, dirs, limits. Every skill reads this first.
├── context/                # bespoke knowledge the skills must know ahead of time
│   ├── architecture.md     # codebase map, entrypoints, conventions
│   ├── testing.md          # test frameworks, layout, fixtures, mock policy
│   ├── validation.md       # how to boot, seed, drive, and capture the app; the canonical E2E flows
│   ├── domain.md           # business rules, glossary, invariants (only if there is real domain content)
│   ├── review.md           # what the reviewer wants to see in a packet
│   └── sources/            # digests of attached docs, specs, tickets, design files
├── overlays/               # per-skill perturbations: <skill>.md with Add / Replace / Skip sections
├── scripts/                # project harness: boot.sh, teardown.sh, seed.sh
├── flows/                  # E2E flow modules for run_flow.mjs (only when the project has no E2E suite)
└── runs/                   # per-slice working state (gitignored by default)
```

Rule of thumb: **facts go in `context/`, behavior changes go in `overlays/`.** If the template step is right but needs project knowledge, write context. Write an overlay only when a template step is wrong, missing, or inapplicable for this project.

## 0. Pick the mode

- **Interactive** (default when a human is in the chat): ask gap questions with the `AskQuestion` tool.
- **Autonomous** (cloud agent with no human in the loop, invoked by the `implement-slice` subagent, or the user says "don't ask"): never block. Decide every gap with the most conservative default, and record each one under `## Assumptions` in `LOOP.md` with what the user could tell you instead.
- **Update**: `.cursor/loop/LOOP.md` already exists. Re-run discovery and diff it against the manifest. Preserve anything a human or `/reflect` wrote (look at `## Changelog`). Ask only about new gaps. Append a changelog entry. Never regenerate a file from scratch when an edit will do.

## 1. Discover (read before you ask)

Work through `references/discovery.md`. For every fact, record where it came from and whether you **verified** it by running something or only **inferred** it from files. CI config beats README; a command you ran beats both.

Also ingest everything the user attached or linked: specs, tickets, design docs, screenshots, API contracts. Write one digest per source to `context/sources/<slug>.md` (what it says, what it constrains, open questions). Never paste whole documents; summarize what a skill needs to act.

Run the cheap commands now (install if needed, lint, typecheck, one fast test file). Do not run the full suite or deploy anything during discovery.

## 2. Find the gaps

List every unknown that would change how the loop plans, mocks, or validates. Rank by impact on `validate`: the boot command, the E2E surface, test commands, secrets and external services, and the reviewer's evidence preferences matter most. Throw away gaps that you can close by running or reading something.

## 3. Ask (interactive mode)

Use `references/question-bank.md`. Rules:

- Use `AskQuestion`. Batch up to 5 questions per call, at most 3 rounds.
- Every question is **indicative**: options are pre-filled from discovery ("We found `pnpm test` in CI and `npm test` in the README — which is canonical?"). Always include an escape option for free-text.
- Never ask what you could observe. Never ask for secret values; ask only *whether* a secret exists and how the loop should mock it.
- If an answer contradicts something you verified, say so and ask once more. Do not silently pick one.

## 4. Generate

Copy from `templates/` and fill in. Delete any placeholder section that has no real content. An empty context file is worse than a missing one.

1. `LOOP.md` from `templates/LOOP.md`. Fill every frontmatter key. Mark each command `verified` or `inferred`.
2. `context/*.md` from `templates/context/`. Write only the files that have real content. `architecture.md`, `testing.md`, and `validation.md` are almost always needed. Write `review.md` only from stated preferences (the user's answers, or repo docs), never from assumptions alone; autonomous defaults for evidence go in `LOOP.md` under `## Assumptions`. Small repos often need no overlays at all.
3. `overlays/<skill>.md` from `templates/overlay.md`, only where a template step must change. Typical triggers:
   - No unit-test framework, and the project tests through E2E only → `scaffold` overlay.
   - A backend with no UI → `validate` overlay that Skips browser capture and Adds API transcript capture.
   - Generated code, migrations, or codegen steps → `implement` overlay that Adds the regen step.
   - A monorepo → overlays that scope commands to the touched package.
4. Directories. Create `runs/` and the scratch dir named in `LOOP.md`. Add `.cursor/loop/runs/` to `.gitignore` unless the user chose `persist_reports: commit`. Never gitignore `LOOP.md`, `context/`, `overlays/`, or `scripts/`.
5. Harness scripts in `scripts/`, only when the project lacks them:
   - `boot.sh` starts every process the app needs on a fixed uncommon port that differs from the app's default (so a developer's running copy never collides), waits for the health URL, and writes PIDs to `<dirs.scratch>/.boot/`. Pair it with `teardown.sh`, which stops exactly those PIDs.
   - `seed.sh` resets and loads deterministic fixture data, so every flow starts from the same state.
   - When the project has no E2E tooling: flow modules in `.cursor/loop/flows/` for the canonical flows, run by `run_flow.mjs` from the `validate` skill's scripts directory (see that skill's surfaces reference). Install Playwright into the scratch dir, not the project.
   Make scripts idempotent, executable, and safe to run twice.

## 5. Smoke the harness

Prove the loop can actually validate before anyone relies on it:

1. Run `boot`, hit the health URL, then run `teardown`.
2. Run one existing test with the `test_single` command.
3. Run the full `commands.test` once. If it would clearly take more than a few minutes, skip it and leave `test` as `inferred`.
4. Web UI only: write the first canonical flow module, run it with `run_flow.mjs` (pass `--scratch <dirs.scratch>`), and confirm its capture is a real screenshot of the landing route.

Promote a command to `verified` only when it ran green here. Record each outcome under `## Harness status` in `LOOP.md`: pass, fail with the reason, or skipped. A failed smoke step is not fatal, but it must be visible. `validate` reads this section and will not trust a gate that never passed.

## 6. Hand off

When invoked by `implement-slice`, return three lines (ready or blocked, files generated, assumption count) and let it continue. Otherwise reply with:

- One line saying the loop is ready, or listing what blocks it.
- Generated files, one line each.
- Assumptions made (autonomous mode) or answers recorded (interactive mode).
- Harness smoke results.
- How to run it: "Ask the `implement-slice` subagent to implement <requirement>", or run the skills one at a time (`/plan-tasks`, `/scaffold`, `/implement`, `/validate`).

Do not commit unless the user asks, or unless you were invoked by `implement-slice` (which commits as part of its run).
