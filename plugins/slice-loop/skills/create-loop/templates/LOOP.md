---
loop_version: 1
generated_by: create-loop
generated_at: YYYY-MM-DD
source_commit: <git sha at generation>
mode: interactive # interactive | autonomous
surfaces: [web-ui] # any of: web-ui, http-api, cli, library, worker, data-job, mobile, infra
commands:
  # status: verified (ran green during create-loop) | inferred (read from files, never run) | n/a (does not exist here).
  # Start everything as inferred; promote to verified only after it actually ran green.
  # e2e: "run_flow" means validate runs .cursor/loop/flows/*.mjs with its bundled run_flow.mjs.
  install: { run: "<cmd>", status: inferred }
  lint: { run: "<cmd>", status: inferred }
  typecheck: { run: "<cmd>", status: inferred }
  test: { run: "<cmd>", status: inferred }
  test_single: { run: "<cmd> {file}", status: inferred }
  e2e: { run: "<cmd> | run_flow", status: inferred }
  build: { run: "<cmd>", status: inferred }
boot:
  start: .cursor/loop/scripts/boot.sh
  stop: .cursor/loop/scripts/teardown.sh
  url: http://127.0.0.1:<port> # fixed, uncommon, and different from the app's default port
  health: http://127.0.0.1:<port>/
  timeout_s: 90
  seed: .cursor/loop/scripts/seed.sh # or null
dirs:
  runs: .cursor/loop/runs
  scratch: /tmp/slice-loop # root: shared tooling (Playwright) and .boot/ PIDs; per-slice subdirs hold raw media, throwaway DBs
  artifacts_export: /opt/cursor/artifacts # copied review packet; skipped when the dir does not exist
limits:
  implement_iterations: 3
  replans: 1
  report_max_lines: 150
  video_max_seconds: 60
gates: [lint, typecheck, test, e2e] # ordered; validate runs these, plus the acceptance-criteria audit
review:
  persist_reports: ignore # ignore | commit
  push: true # push after each commit; false when the repo has no remote
  pr: none # none | draft
off_limits: [] # globs the loop must never edit
---

# Slice Loop manifest

Every loop skill reads this file first. Precedence: `overlays/<skill>.md` > this manifest and `context/` > the template skill.

## Context index

Read a context file when its trigger applies. Do not read them all by default.

| File | Read when |
| --- | --- |
| `context/architecture.md` | planning or implementing anything |
| `context/testing.md` | scaffolding or running tests |
| `context/validation.md` | booting, driving, or capturing the app |
| `context/domain.md` | the slice touches business rules |
| `context/review.md` | writing the review packet |
| `context/sources/*.md` | the slice references a spec, ticket, or design |

## Overlays

| Skill | Overlay | Why |
| --- | --- | --- |
| validate | `overlays/validate.md` | <one line> |

## Mock policy

- External services: <mock at network boundary | emulator | sandbox env vars>
- Auth: <mock session | seeded user | disabled>
- Data: <seed script | fixtures | in-memory>

## Assumptions

Each line: the decision, why, and what the user could say instead.

## Harness status

| Check | Result | Notes |
| --- | --- | --- |
| boot + health | <pass \| fail \| skipped> | |
| test (full, once) | <pass \| fail \| skipped> | |
| test_single | <pass \| fail \| skipped> | |
| screenshot | <pass \| fail \| skipped> | |

## Changelog

- YYYY-MM-DD create-loop: generated.
