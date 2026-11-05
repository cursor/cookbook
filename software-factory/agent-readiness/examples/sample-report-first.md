# Agent readiness: monorepo-mixed

## 1. Where am I now

**Level 0 of 4, not bootable.**

**Agents can't pass the tests in api from a clean checkout because its tests need a service on port 5432 running, which the setup doesn't start, and 56% of recent changes land there.**

> **Next move, step 2:** Set up the service the tests expect on port 5432 for agents in api. Takes api to Level 1, covering 56% of recent changes. Agents can run api's checks before they push, so fewer agent PRs fail CI the first time. Effort and owner: Small: setup scripts and environment config, no source changes. Repo maintainer. Decision: Approve committing the setup files.

Level ladder: **[0 Not bootable]** → 1 Bootable → 2 Verifiable → 3 Delegable → 4 Scalable

Level 0 means: a clean checkout can't install, build and pass its tests. Level 1 needs: installs from the lockfile in a clean container, builds in a clean container and passes every test in a clean container. Levels 3 and 4 are experimental: they measure agent PR outcomes, and this version doesn't yet validate them end to end. Level 2 is the proven top of this version.

- **Components ready for agents:** 0 of 3. Level 2 needs 3 of 3.
- **Agent PRs that pass CI the first time:** 33% (3 of 9). Other PRs: 71% (29 of 41), Sep 27 to Oct 27, 2026.
- **Recent changes in components below Level 2:** 98%. Level 2 needs 0%, counting the last 90 days.

| Component | Level | Ladder 0 to 4 | Share of changes | Trend | What holds it |
|---|---|---|---|---|---|
| `api` | Level 0 | ●○○○○ | 56% | first audit | passes every test in a clean container: test failed: connection refused on port 5432 (1 of 1 tests failed) (step 2) |
| `worker` | Level 1 | ○●○○○ | 27% | first audit | tests catch planted faults: caught 0 of 5 planted faults (step 5) |
| `shared` | Level 1 | ○●○○○ | 15% | first audit | agent instructions are accurate: 3 of 7 instruction items are wrong (step 3) |
| `infra` | not assessed: Terraform isn't supported yet | | 2% | | |

Share of changes: the component's share of changed files over the last 90 days.

- **Not assessed:** 2% of recent changes aren't assessed: infra (2%), because Terraform isn't supported yet. What the audit supports: [supported.md](../skill/agent-readiness/references/supported.md).

## 2. Have I improved

This is the first audit, so there is nothing to compare yet. Rerun the audit after your first fix to see what changed here.

## 3. What moves the needle next

> **Recommendation:** Decision needed: approve committing the setup files. Also name an owner for agent readiness.

Next: Level 1, bootable. Met: installs from the lockfile in a clean container. Not yet: api passes every test in a clean container.

1. **Set up the service the tests expect on port 5432 for agents in api.** Blocks Level 1 for api.
2. **Fix the stale agent instructions.** Blocks Level 2 for shared.
3. **Make worker's tests catch wrong behavior.** Blocks Level 2 for worker.

### Step 2: Set up the service the tests expect on port 5432 for agents in api (do first)

- **How it moves the needle:** Takes api to Level 1, covering 56% of recent changes. Agents can run api's checks before they push, so fewer agent PRs fail CI the first time.
- **Why it matters:** In a clean container, api's tests fail because nothing starts the service the tests expect on port 5432: the connection was refused.
- **Effort and owner:** Small: setup scripts and environment config, no source changes. Repo maintainer.
- **Decision needed:** Approve committing the setup files.
- **Evidence:** `ev-011`

### Step 3: Fix the stale agent instructions (then)

- **How it moves the needle:** Takes shared to Level 2, covering 15% of recent changes. Agents stop following stale steps, such as running pnpm in a repo that doesn't use it.
- **Why it matters:** 3 instructions agents would follow are wrong: npm run changelog (no "changelog" script in package.json), pnpm test (uses pnpm, but the repo uses npm).
- **Effort and owner:** Small: 2 instruction files. Repo maintainer.
- **Evidence:** `ev-001`, `ev-002`, `ev-003`

### Step 5: Make worker's tests catch wrong behavior (then)

- **How it moves the needle:** Takes shared to Level 2, worker to Level 2 together with Fix the stale agent instructions. Changes in worker get a real pass-or-fail signal, so reviewers catch less by hand.
- **Why it matters:** The audit planted 5 faults in worker in a throwaway copy, and the tests caught 0.
- **Effort and owner:** Medium: tests in worker only. Component owner.
- **Decision needed:** What the untested behavior in packages/worker/src/retry.js should be.
- **Evidence:** `ev-017`

## 4. Roadmap to the max level

0 of 6 steps done. Kept in `.agent-readiness/roadmap.json`.

### Level 1, bootable (next)

Level 1 needs: installs from the lockfile in a clean container, builds in a clean container and passes every test in a clean container.

- [ ] Step 2: Set up the service the tests expect on port 5432 for agents in api: unlocks api to Level 1 (next, alongside step 1)

### Level 2, verifiable (later)

Level 2 needs: build, lint, type-check and test commands pass, tests catch planted faults, agent instructions are accurate and normal work needs no production access.

- [ ] Step 3: Fix the stale agent instructions: unlocks shared to Level 2 (next, alongside step 1)
- [ ] Step 4: Check api's tests with planted faults: unlocks nothing on its own; first needs Set up the service the tests expect on port 5432 for agents in api (waiting on step 2)
- [ ] Step 5: Make worker's tests catch wrong behavior: unlocks shared to Level 2, worker to Level 2 together with Fix the stale agent instructions (next, alongside step 1)

### Level 3, delegable (later, experimental)

Level 3 means: agent PRs meet the outcome targets your team set, over at least 20 agent PRs in the window (never fewer than 10).

- [ ] Step 6: Set your Level 3 targets: unlocks a definition of Level 3 for this repo (later)

### Level 4, scalable (later, experimental)

Level 4 means: those targets held over two back-to-back windows while agent PR volume at least doubled.

Its steps are added once the level below it is reached.

### For every level

- [ ] Step 1: Name an owner for agent readiness: unlocks a named owner for approvals, targets and the weekly recheck (next)

## 5. Audit details: exact steps and everything we checked

### Measures

Confidence: high (every check that decides the level ran).

- **Components ready for agents:** 0 of 3. Level 2 needs 3 of 3.
- **Agent PRs that pass CI the first time:** 33% (3 of 9). Other PRs: 71% (29 of 41), Sep 27 to Oct 27, 2026.
- **Recent changes in components below Level 2:** 98%. Level 2 needs 0%, counting the last 90 days.

The level covers 3 components and ignores infra (2% of changes, Terraform isn't supported yet). Agent PRs are matched by head branch starting with cursor/.

Effort against impact (impact is the share of recent changes an action unblocks): 1. Set up the service the tests expect on port 5432 for agents in api (Do first: effort small, 56%); 2. Fix the stale agent instructions (Quick fills: effort small, 15%); 3. Make worker's tests catch wrong behavior (Do first: effort medium, 0%).

### Steps for Set up the service the tests expect on port 5432 for agents in api (step 2)

- **What to watch:** Share of agent PRs touching api that pass CI the first time. Now: 20% (1 of 5), Sep 27 to Oct 27, 2026.
- **Done when:** `readiness replay --component api` passes every test.

1. **Ask the agent to fix it.** Say "fix the primary blocker". It drafts install and start scripts and a `.cursor/environment.json` with `readiness draft-env`.
2. **The agent proves it.** `readiness replay --component api` must pass every test before the fix is offered.
3. **Review and merge.** Check that the start script only starts local services and names no production URLs.
4. **Point Cloud Agents at it.** A team admin sets the Cloud Agent environment to read `.cursor/environment.json`; committing the file alone changes no environment.
5. **Re-audit.** The next audit confirms Level 1 and can now plant faults in api.

### Steps for Fix the stale agent instructions (step 3)

- **What to watch:** Agent PRs that add a stray pnpm-lock.yaml. Now: 11% (1 of 9), Sep 27 to Oct 27, 2026.
- **Done when:** `readiness run --instructions` replays every instruction item.

1. **Fix each listed item.** `.cursor/skills/release-notes/SKILL.md:8` `npm run changelog`: no "changelog" script in package.json; `AGENTS.md:7` `pnpm test`: uses pnpm, but the repo uses npm; `AGENTS.md:8` `docs/architecture.md`: docs/architecture.md doesn't exist
2. **Prove it.** `readiness run --instructions` replays every command and checks every path.

### Steps for Make worker's tests catch wrong behavior (step 5)

- **What to watch:** Share of agent PRs touching worker where a reviewer requested changes. Now: 2 of 3 (too few for a rate), Sep 27 to Oct 27, 2026.
- **Done when:** A new audit's fresh planted faults in worker are all caught.

1. **Decide the intended behavior.** For the files named here, write down what correct behavior is, including edge cases.
2. **Write tests that pin it down.** Assert results and edge cases, not just that code runs.
3. **Prove it with fresh faults.** Run a new audit. It plants different faults than this one, so tests aimed at one audit's faults don't help.
4. **Review.** `readiness diff` flags any deleted test or new skip marker, so nothing was weakened to pass.

### Everything we checked, and why

| Check | Why it matters | Result | Evidence |
|---|---|---|---|
| Components and where changes land (`scope.profile`) | Levels follow the work, so the audit finds each package and its share of recent changes. | 4 components found, 3 assessed |  |
| Agent assets in the repo (`scope.agent_assets`) | Shows what agent setup already exists and who maintains it. Not scored. | 3 assets, 3 authors |  |
| Setup works from a clean checkout (`bootstrap.cold_replay`) | Every agent starts from a clean checkout, so setup that only works on a prepared machine breaks every agent run. In the BootstrapAgent study, a reusable, verified setup cut later agents' token use by 25.9% and build time by 22.3%. Measured on the study's benchmark repositories. ([source](https://arxiv.org/abs/2605.15815)) | **failed: api**; passed: shared and worker | `ev-005`, `ev-006`, `ev-007`, `ev-011`, `ev-012`, `ev-013` and 1 more |
| Build, lint, type-check and test commands pass (`verify.canonical_interface`) | Agents need one known way to check their own work. | **failed: api**; passed: shared and worker | `ev-008`, `ev-009`, `ev-010`, `ev-011`, `ev-012`, `ev-013` |
| Tests catch planted faults (`verify.behavioral_oracle`) | Green tests aren't proof that a change is right. OpenAI estimated about 30% of SWE-Bench Pro's 731 public tasks were broken, including low-coverage tests that let incomplete fixes pass. An audit of one benchmark, not of customer repositories. ([source](https://openai.com/index/separating-signal-from-noise-coding-evaluations)) | api: tests must pass before faults can be planted; shared: caught 5 of 5 planted faults; worker: caught 0 of 5 planted faults | `ev-015`, `ev-016`, `ev-017` |
| Agent instructions are accurate (`context.instructions_verified`) | Agents follow AGENTS.md, rules and skills literally, so a stale command costs more than a missing one. No outcome study yet measures how much these files help. | 4 of 7 instruction items check out, 3 wrong | `ev-001`, `ev-002`, `ev-003`, `ev-018`, `ev-019` |
| Normal work needs no production access (`safety.execution_boundary`) | Agents run with whatever access setup gives them, so normal work must never need production credentials. | passed | `ev-004` |

Not assessed by this rubric version, which is different from unknown: whether CI matches the local commands, flaky tests, the quality of error messages, how easily code can be found and outcome checks on held-out tasks.

### Levels by component

Repo shape: monorepo. Each component gets one standard level; scenarios someone added appear under the components they cover.

| Component | Path | Toolchain | Manifest | Lockfile | Share of changes | Level |
|---|---|---|---|---|---|---|
| `api` | `packages/api` | Node | `packages/api/package.json` | none | 56% | 0 Not bootable |
| `shared` | `packages/shared` | Node | `packages/shared/package.json` | none | 15% | 1 Bootable |
| `worker` | `packages/worker` | Node | `packages/worker/package.json` | none | 27% | 1 Bootable |
| `infra` | `infra` | Terraform | `infra/main.tf` | none | 2% | not assessed: Terraform isn't supported yet |

Repo level: 0 Not bootable. The repo level is the lowest level among active components, the assessed components with at least 10% of changes over 90 days; a component joins or leaves that set only after two audits on the same side of the line, except that one the last audit didn't have joins at once; when no assessed component reaches 10%, the largest sets it; and components the audit can't assess never set it.

What holds the repo at Level 0:

- `api`: passes every test in a clean container, not met (test failed: connection refused on port 5432 (1 of 1 tests failed)).

- **Standard level:** Level 1 needs: installs from the lockfile in a clean container, builds in a clean container and passes every test in a clean container. Level 2 needs: build, lint, type-check and test commands pass, tests catch planted faults, agent instructions are accurate and normal work needs no production access.

### Agent PR outcomes

Sep 27 to Oct 27, 2026. Agent PRs are matched by head branch starting with cursor/. Source: a recorded PR file.

| Measure | Agent PRs | Other PRs |
|---|---|---|
| Opened | 9 | 41 |
| Merged | 78% (7 of 9) | 85% (35 of 41) |
| Passed CI the first time | 33% (3 of 9) | 71% (29 of 41) |
| Reviewer requested changes | 44% (4 of 9) | 17% (7 of 41) |
| Median days to merge | 2 | 2 |

| Component | Agent PRs | Passed CI the first time | Changes requested |
|---|---|---|---|
| `api` | 5 | 20% (1 of 5) | 40% (2 of 5) |
| `shared` | 2 | 2 of 2 (too few for a rate) | 0 of 2 (too few for a rate) |
| `worker` | 3 | 1 of 3 (too few for a rate) | 2 of 3 (too few for a rate) |

1 agent PR touched more than one component, so the component rows can add up to more than the total. A baseline, not proof that readiness explains these numbers. Model updates and the mix of tasks move them too.

Matched PRs: #201, #203, #206, #209, #212, #214, #217, #219, #221.

### Agent assets already in the repo

| Asset | Path | Authors | Last changed | Status |
|---|---|---|---|---|
| rules | `.cursor/rules/style.mdc` | Contributor A | Jun 29 | Replays |
| skill | `.cursor/skills/release-notes/SKILL.md` | Contributor A, Contributor C | Sep 17 | 1 stale item |
| agents_md | `AGENTS.md` | Contributor A, Contributor B | Sep 27 | 2 stale items |

Missing: an environment setup and hooks.

### Other signals (informational, not scored)

| Signal | Found | Detail |
|---|---|---|
| CI config | yes | .github/workflows/ci.yml, and it runs tests |
| A way to run one test file | yes | api: node --test takes file paths; shared: node --test takes file paths; worker: node --test takes file paths |
| Sample env file | n/a | the code reads no environment variables of its own |
| Worktree and port isolation | yes | no fixed ports or machine-specific absolute paths in the setup and scripts |
| AGENTS.md length | yes | 42 words |

These don't set a level or add a roadmap step.

### Evidence log

<details><summary>All evidence</summary>

| ID | Check | Component | What ran | Result |
|---|---|---|---|---|
| `ev-001` | `context.instructions_verified` | repo | (read from files) | fail: .cursor/skills/release-notes/SKILL.md:8 `npm run changelog`: no "changelog" script in package.json |
| `ev-002` | `context.instructions_verified` | repo | (read from files) | fail: AGENTS.md:7 `pnpm test`: uses pnpm, but the repo uses npm |
| `ev-003` | `context.instructions_verified` | repo | (read from files) | fail: AGENTS.md:8 `docs/architecture.md`: docs/architecture.md doesn't exist |
| `ev-004` | `safety.execution_boundary` | repo | (read from files) | pass: no blocking findings; 0 items listed for review |
| `ev-005` | `bootstrap.cold_replay` | repo | (read from files) | pass: toolchain pinned in .nvmrc |
| `ev-006` | `bootstrap.cold_replay` | repo | node --version && npm --version (ran in a clean container) | pass: doctor passed |
| `ev-007` | `bootstrap.cold_replay` | repo | npm ci (ran in a clean container) | pass: install passed |
| `ev-008` | `verify.canonical_interface` | api | npm run lint (ran in a clean container) | pass: lint passed |
| `ev-009` | `verify.canonical_interface` | shared | npm run lint (ran in a clean container) | pass: lint passed |
| `ev-010` | `verify.canonical_interface` | worker | npm run lint (ran in a clean container) | pass: lint passed |
| `ev-011` | `bootstrap.cold_replay` | api | npm run test (ran in a clean container) | fail: test failed: connection refused on port 5432 (1 of 1 tests failed) |
| `ev-012` | `bootstrap.cold_replay` | shared | npm run test (ran in a clean container) | pass: test passed (3 of 3 tests) |
| `ev-013` | `bootstrap.cold_replay` | worker | npm run test (ran in a clean container) | pass: test passed (2 of 2 tests) |
| `ev-014` | `bootstrap.cold_replay` | repo | (ran in a clean container) | pass: frozen install reproduced the lockfile |
| `ev-015` | `verify.behavioral_oracle` | api | (not run) | not_run: tests must pass before faults can be planted |
| `ev-016` | `verify.behavioral_oracle` | shared | (ran in a clean container) | pass: caught 5 of 5 planted faults (tried: drop_throw_or_return, change_constant, negate_condition) |
| `ev-017` | `verify.behavioral_oracle` | worker | (ran in a clean container) | fail: caught 0 of 5 planted faults; missed: change_constant at packages/worker/src/retry.js:2, change_constant at packages/worker/src/retry.js:9, change_constant at p |
| `ev-018` | `context.instructions_verified` | repo | npm run lint -w api (ran in a clean container) | pass: .cursor/rules/style.mdc:6 `npm run lint -w api` replays |
| `ev-019` | `context.instructions_verified` | repo | npm run test -w shared (ran in a clean container) | pass: AGENTS.md:6 `npm run test -w shared` replays |

</details>

Evidence strength, weakest to strongest: stated in docs, read from files, ran on host, ran in a clean container, confirmed by outcomes. A check passes only at its required strength.

## About this report

Audited Oct 27, 2026 at 7070f44. Eval run with a pinned seed; not a production result. Outcomes come from a recorded PR file, not GitHub; not a production result. Scripts match the agent-readiness-v0.1.0 manifest bundled with this copy; the published release isn't checked here, and the seal is an unkeyed digest, which shows edits but not who sealed it.

- **Audit:** aud-2026-10-27-7070f44-e101
- **Commit:** 7070f44 (clean tree)
- **Rubric:** 2026-11-alpha
- **Permission tier:** local-exec
- **Seal:** Scripts match the agent-readiness-v0.1.0 manifest bundled with this copy; the published release isn't checked here, and the seal is an unkeyed digest, which shows edits but not who sealed it
- **Skill digest:** a3f4148e45a5
- **Planted faults:** seed pinned (eval run; not a production result)
- **Replay environment:** docker container, node:22-bookworm
- **Stored in:** .agent-readiness/history/audits/aud-2026-10-27-7070f44-e101

---

Generated from `report.json` by the agent-readiness skill; `report.html` is the same report as a page. For signed reports, set SA_READINESS_SEAL_KEY from a CI secret where the audit runs.
