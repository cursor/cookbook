---
loop_version: 1
generated_by: nudge
generated_at: 2026-10-05
source_commit: 8a6c764
mode: autonomous
surfaces: [web-ui, http-api]
commands:
  install: { run: null, status: verified } # no dependencies; `npm install` would only create a lockfile
  lint: { run: "npm run lint", status: verified }
  typecheck: { run: null, status: verified } # plain JS, no type checker
  test: { run: "node --test test/*.test.js", status: verified } # `npm test` (node --test test/) fails on Node 22: see Assumptions
  test_single: { run: "node --test {file}", status: verified }
  e2e: { run: "node <validate-skill>/scripts/run_flow.mjs .cursor/loop/flows/{flow}.mjs --base-url http://127.0.0.1:4319 --out <out-dir> --scratch /tmp/slice-loop", status: verified }
  build: { run: null, status: verified } # no build step; static files served as-is
boot:
  start: .cursor/loop/scripts/boot.sh
  stop: .cursor/loop/scripts/teardown.sh
  url: http://127.0.0.1:4319
  health: http://127.0.0.1:4319/api/tasks
  timeout_s: 30
  seed: null # the server seeds two fixed tasks in memory at boot; restarting resets data
dirs:
  runs: .cursor/loop/runs
  scratch: /tmp/slice-loop
  artifacts_export: /opt/cursor/artifacts
limits:
  implement_iterations: 3
  replans: 1
  report_max_lines: 150
  video_max_seconds: 60
gates: [lint, test, e2e]
review:
  persist_reports: ignore
  push: false
  pr: none
off_limits: []
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
| `context/review.md` | writing the review packet |

## Overlays

None. The template steps apply as written; `typecheck` and `build` have no command and are left out of `gates`.

## Mock policy

- External services: none exist. The app uses only the Node standard library.
- Auth: none. The app has no auth.
- Data: in-memory store seeded with two fixed tasks at boot (`SEED=0` boots empty). Restart the server to reset.

## Assumptions

- Boot on fixed port 4319 instead of the app's default 4317, so the loop never collides with a developer's `npm start`. Say so if 4317 should be used.
- Gates are `lint`, `test`, `e2e` (every gate that ran green during discovery). Add a gate if CI ever exists.
- E2E runs through `run_flow.mjs` with flow modules in `.cursor/loop/flows/`, because the project has no E2E tooling. Playwright lives in `/tmp/slice-loop/node_modules`, never in the project.
- New tests follow the existing convention: `node:test` files in `test/`, named `*.test.js`.
- Evidence: screenshots plus one short recording per new UI flow, and curl transcripts for API criteria.
- Reports stay in gitignored `runs/` and are exported to `/opt/cursor/artifacts`. Say "commit" to persist them in git.
- `review.push: false` because the repo has no remote; flip it once one exists. PR policy: none.
- Off-limits: nothing; the repo has no generated files, lockfiles, or migrations.
- Slice size: one user-visible behavior plus its tests.
- Iterations: 3 implement retries, 1 re-plan.
- `commands.test` is `node --test test/*.test.js`, not `npm test`: on Node 22 `node --test test/` resolves `test/` as a module and fails with `Cannot find module` (fails on the initial commit too). The loop does not fix `package.json` on its own; say so to schedule that fix as a slice.

## Harness status

| Check | Result | Notes |
| --- | --- | --- |
| boot + health | pass | `boot.sh` → `GET /api/tasks` 200; `teardown.sh` freed port 4319 |
| test_single | pass | `node --test test/tasks.test.js`: 2 passed |
| test (full) | pass | `node --test test/*.test.js` runs every file; `npm test` fails on Node 22 (pre-existing) |
| screenshot | pass | `flows/create-task.mjs` via `run_flow.mjs`: 4/4 steps, landing screenshot captured, video recorded |

## Changelog

- 2026-10-05 nudge (autonomous): generated.
- 2026-10-05 implement-slice (scaffold of `20261005-reject-blank-titles`): `commands.test` switched from `npm test` (broken on Node 22, never actually run during nudge) to `node --test test/*.test.js`; `context/testing.md` now forbids hard-coded test ports.
