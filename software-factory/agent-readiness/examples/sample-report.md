# Agent readiness: monorepo-mixed

## 1. Where am I now

**Level 1 of 4, bootable.** Unchanged since Oct 30; 3 steps closed.

**Agents can build and test worker, but its tests can't yet catch wrong changes, and 25% of recent changes land there. api and shared are already at Level 2.**

> **Next move, step 5:** Make worker's tests catch wrong behavior. Takes worker to Level 2, covering 25% of recent changes. Changes in worker get a real pass-or-fail signal, so reviewers catch less by hand. Effort and owner: Medium: tests in worker only. Component owner. Decision: What the untested behavior in packages/worker/src/retry.js should be.

Level ladder: 0 Not bootable → **[1 Bootable]** → 2 Verifiable → 3 Delegable → 4 Scalable

Level 1 means: a clean checkout installs, builds and passes every test. Level 2 needs: build, lint, type-check and test commands pass, tests catch planted faults, agent instructions are accurate and normal work needs no production access. Levels 3 and 4 are experimental: they measure agent PR outcomes, and this version doesn't yet validate them end to end. Level 2 is the proven top of this version.

Trend: ▁▂▂▂▂▂ Oct 27 Level 0 → Oct 30 Level 1 → Nov 6 Level 1 (recheck) → Nov 13 Level 1 (recheck, failed) → Nov 20 Level 1 (recheck) → Nov 30 Level 1

- **Components ready for agents:** 2 of 3. Level 2 needs 3 of 3; last audit: 2 of 3.
- **Agent PRs that pass CI the first time:** 65% (11 of 17). Other PRs: 71% (27 of 38), Oct 31 to Nov 30, 2026.
- **Recent changes in components below Level 2:** 25%. Level 2 needs 0%; last audit: 27%, counting the last 90 days.

| Component | Level | Ladder 0 to 4 | Share of changes | Trend | What holds it |
|---|---|---|---|---|---|
| `api` | Level 2 | ○○●○○ | 59% | ▁▄▄▄▄▄ | ready for agents |
| `worker` | Level 1 | ○●○○○ | 25% | ▂▂▂▂▂▂ | tests catch planted faults: caught 0 of 5 planted faults (step 5) |
| `shared` | Level 2 | ○○●○○ | 16% | ▂▄▄▂▄▄ | ready for agents |
| `infra` | not assessed: Terraform isn't supported yet | | 0% | | |

Share of changes: the component's share of changed files over the last 90 days.

- **Not assessed:** infra (no recent changes), because Terraform isn't supported yet. What the audit supports: [supported.md](../skill/agent-readiness/references/supported.md).

## 2. Have I improved

Since the audit on Oct 30, 2026:

- **Repo level:** Level 1 to Level 1, no change.
- No component level, condition or check changed.
- **Steps closed:** 2. Set up the service the tests expect on port 5432 for agents in api (Oct 30); 3. Fix the stale agent instructions (Oct 30); 4. Check api's tests with planted faults (Oct 30). Part 5 shows what moved after them.

## 3. What moves the needle next

> **Recommendation:** Decision needed: what the untested behavior in packages/worker/src/retry.js should be.

Next: Level 2, verifiable. Met: lint and test commands pass, agent instructions are accurate and normal work needs no production access. Not yet: worker tests catch planted faults.

1. **Make worker's tests catch wrong behavior.** Blocks Level 2 for worker.

### Step 5: Make worker's tests catch wrong behavior (do first)

- **How it moves the needle:** Takes worker to Level 2, covering 25% of recent changes. Changes in worker get a real pass-or-fail signal, so reviewers catch less by hand.
- **Why it matters:** The audit planted 5 faults in worker in a throwaway copy, and the tests caught 0.
- **Effort and owner:** Medium: tests in worker only. Component owner.
- **Decision needed:** What the untested behavior in packages/worker/src/retry.js should be.
- **Evidence:** `ev-015`

## 4. Roadmap to the max level

4 of 8 steps done. Kept in `.agent-readiness/roadmap.json`. Owner: Platform team.

### Level 1, bootable (reached)

Level 1 needs: installs from the lockfile in a clean container, builds in a clean container and passes every test in a clean container.

- [x] Step 2: Set up the service the tests expect on port 5432 for agents in api: unlocks api to Level 1 (done Oct 30)

### Level 2, verifiable (next)

Level 2 needs: build, lint, type-check and test commands pass, tests catch planted faults, agent instructions are accurate and normal work needs no production access.

- [x] Step 3: Fix the stale agent instructions: unlocks shared to Level 2 (done Oct 30)
- [x] Step 4: Check api's tests with planted faults: unlocks nothing on its own; first needs Set up the service the tests expect on port 5432 for agents in api (done Oct 30)
- [ ] Step 5: Make worker's tests catch wrong behavior: unlocks worker to Level 2 (next)

### Level 3, delegable (later, experimental)

Level 3 means: agent PRs meet the outcome targets your team set, over at least 20 agent PRs in the window (never fewer than 10).

- [ ] Step 6: Set your Level 3 targets: unlocks a definition of Level 3 for this repo (later)
- [ ] Steps 7 to 8: Give agents work in api and shared: unlocks measured agent work in api and shared (in progress)

### Level 4, scalable (later, experimental)

Level 4 means: those targets held over two back-to-back windows while agent PR volume at least doubled.

Its steps are added once the level below it is reached.

### For every level

- [x] Step 1: Name an owner for agent readiness: unlocks a named owner for approvals, targets and the weekly recheck (done Oct 30)

## 5. Audit details: exact steps and everything we checked

### Measures

Confidence: high (every check that decides the level ran).

- **Components ready for agents:** 2 of 3. First audit: 0 of 3; last audit: 2 of 3.
- **Agent PRs that pass CI the first time:** 65% (11 of 17). Other PRs: 71% (27 of 38), Oct 31 to Nov 30, 2026.
- **Recent changes in components below Level 2:** 25%. First audit: 98%; last audit: 27%, counting the last 90 days.

The level covers 3 components and ignores infra (0% of changes, Terraform isn't supported yet). Agent PRs are matched by head branch starting with cursor/.

### Levels over time

| Date | Record | Repo | api | shared | worker |
|---|---|---|---|---|---|
| Oct 27 | audit | 0 | 0 | 1 | 1 |
| Oct 30 | audit | 1 | 2 | 2 | 1 |
| Nov 6 | recheck | 1 | 2 | 2 | 1 |
| Nov 13 | recheck failed, npm run lint failed: src/money.js: remove console.log | 1 | 2 | 1 | 1 |
| Nov 20 | recheck | 1 | 2 | 2 | 1 |
| Nov 30 | audit | 1 | 2 | 2 | 1 |

A failed recheck lowers a level and a later passing recheck restores it. Only an audit can raise a level above the last audit.

### What each closed step was expected to move, and what moved after it

| Step | Closed | Expected | Observed after |
|---|---|---|---|
| 2. Set up the service the tests expect on port 5432 for agents in api | Oct 30 | Agents can run api's checks before they push, so fewer agent PRs fail CI the first time. Watch: Share of agent PRs touching api that pass CI the first time, 20% (1 of 5). | 20% (1 of 5) to 78% (7 of 9) (closed with step 3 and step 4) |
| 3. Fix the stale agent instructions | Oct 30 | Agents stop following stale steps, such as running pnpm in a repo that doesn't use it. Watch: Agent PRs that add a stray pnpm-lock.yaml, 11% (1 of 9). | 11% (1 of 9) to 0% (0 of 17) (closed with step 2 and step 4) |
| 4. Check api's tests with planted faults | Oct 30 | Changes in api get a real pass-or-fail signal, so reviewers catch less by hand. Watch: Share of agent PRs touching api where a reviewer requested changes, 40% (2 of 5). | 40% (2 of 5) to 11% (1 of 9) (closed with step 2 and step 3) |

Movement after a step closed, not proof that the step caused it. Each step shows its own measure; steps closed in the same audit share the window after it, so a change can't be credited to one of them.

No test files changed since the last audit. No test files were deleted. No test cases were removed overall. No skip markers were added. The CI workflow is unchanged. The lockfile is unchanged.

Effort against impact (impact is the share of recent changes an action unblocks): 1. Make worker's tests catch wrong behavior (Do first: effort medium, 25%).

### Steps for Make worker's tests catch wrong behavior (step 5)

- **What to watch:** Share of agent PRs touching worker where a reviewer requested changes. Baseline: 2 of 3 (too few for a rate), Sep 27 to Oct 27, 2026. Now: 50% (3 of 6), Oct 31 to Nov 30, 2026.
- **Done when:** A new audit's fresh planted faults in worker are all caught.

1. **Decide the intended behavior.** For the files named here, write down what correct behavior is, including edge cases.
2. **Write tests that pin it down.** Assert results and edge cases, not just that code runs.
3. **Prove it with fresh faults.** Run a new audit. It plants different faults than this one, so tests aimed at one audit's faults don't help.
4. **Review.** `readiness diff` flags any deleted test or new skip marker, so nothing was weakened to pass.

### Everything we checked, and why

| Check | Why it matters | Result | Evidence |
|---|---|---|---|
| Components and where changes land (`scope.profile`) | Levels follow the work, so the audit finds each package and its share of recent changes. | 4 components found, 3 assessed |  |
| Agent assets in the repo (`scope.agent_assets`) | Shows what agent setup already exists and who maintains it. Not scored. | 5 assets, 3 authors |  |
| Setup works from a clean checkout (`bootstrap.cold_replay`) | Every agent starts from a clean checkout, so setup that only works on a prepared machine breaks every agent run. In the BootstrapAgent study, a reusable, verified setup cut later agents' token use by 25.9% and build time by 22.3%. Measured on the study's benchmark repositories. ([source](https://arxiv.org/abs/2605.15815)) | passed: api, shared and worker | `ev-002`, `ev-003`, `ev-004`, `ev-008`, `ev-009`, `ev-010` and 2 more |
| Build, lint, type-check and test commands pass (`verify.canonical_interface`) | Agents need one known way to check their own work. | passed: api, shared and worker | `ev-005`, `ev-006`, `ev-007`, `ev-009`, `ev-010`, `ev-011` |
| Tests catch planted faults (`verify.behavioral_oracle`) | Green tests aren't proof that a change is right. OpenAI estimated about 30% of SWE-Bench Pro's 731 public tasks were broken, including low-coverage tests that let incomplete fixes pass. An audit of one benchmark, not of customer repositories. ([source](https://openai.com/index/separating-signal-from-noise-coding-evaluations)) | api: caught 5 of 5 planted faults; shared: caught 5 of 5 planted faults; worker: caught 0 of 5 planted faults | `ev-013`, `ev-014`, `ev-015` |
| Agent instructions are accurate (`context.instructions_verified`) | Agents follow AGENTS.md, rules and skills literally, so a stale command costs more than a missing one. No outcome study yet measures how much these files help. | 7 of 7 instruction items check out | `ev-016`, `ev-017`, `ev-018`, `ev-019`, `ev-020` |
| Normal work needs no production access (`safety.execution_boundary`) | Agents run with whatever access setup gives them, so normal work must never need production credentials. | passed; 2 items listed for review | `ev-001` |

Not assessed by this rubric version, which is different from unknown: whether CI matches the local commands, flaky tests, the quality of error messages, how easily code can be found and outcome checks on held-out tasks.

### Levels by component

Repo shape: monorepo. Each component gets one standard level; scenarios someone added appear under the components they cover.

| Component | Path | Toolchain | Manifest | Lockfile | Share of changes | Level |
|---|---|---|---|---|---|---|
| `api` | `packages/api` | Node | `packages/api/package.json` | none | 59% | 2 Verifiable |
| `api` › Bug fixes | | | | | | 2 Verifiable |
| `shared` | `packages/shared` | Node | `packages/shared/package.json` | none | 16% | 2 Verifiable |
| `shared` › Bug fixes | | | | | | 2 Verifiable |
| `worker` | `packages/worker` | Node | `packages/worker/package.json` | none | 25% | 1 Bootable |
| `worker` › Bug fixes | | | | | | 1 Bootable |
| `infra` | `infra` | Terraform | `infra/main.tf` | none | 0% | not assessed: Terraform isn't supported yet |

Repo level: 1 Bootable. The repo level is the lowest level among active components, the assessed components with at least 10% of changes over 90 days; a component joins or leaves that set only after two audits on the same side of the line, except that one the last audit didn't have joins at once; when no assessed component reaches 10%, the largest sets it; and components the audit can't assess never set it.

What holds the repo at Level 1:

- `worker`: tests catch planted faults, not met (caught 0 of 5 planted faults; missed: change_constant at packages/worker/src/retry.js:5, change_constant at packages/worker/src/retry.js:9, change_constant at packages/worker/src/retry.js:2, change_constant at packages/worker/src/retry.js:3, change_constant at packages/worker/src/retry.js:12).

- **Standard level:** Level 1 needs: installs from the lockfile in a clean container, builds in a clean container and passes every test in a clean container. Level 2 needs: build, lint, type-check and test commands pass, tests catch planted faults, agent instructions are accurate and normal work needs no production access.
- **Bug fixes scenario:** Level 2 needs: build, lint, type-check and test commands pass, tests catch planted faults and normal work needs no production access.

### Agent PR outcomes

Oct 31 to Nov 30, 2026. Agent PRs are matched by head branch starting with cursor/. Source: a recorded PR file.

| Measure | Agent PRs | Other PRs | Agent PRs, Sep 27 to Oct 27, 2026 |
|---|---|---|---|
| Opened | 17 | 38 | 9 |
| Merged | 77% (13 of 17) | 87% (33 of 38) | 78% (7 of 9) |
| Passed CI the first time | 65% (11 of 17) | 71% (27 of 38) | 33% (3 of 9) |
| Reviewer requested changes | 24% (4 of 17) | 16% (6 of 38) | 44% (4 of 9) |
| Median days to merge | 1 | 2 | 2 |

| Component | Agent PRs | Passed CI the first time | Changes requested |
|---|---|---|---|
| `api` | 9 | 78% (7 of 9) | 11% (1 of 9) |
| `shared` | 3 | 3 of 3 (too few for a rate) | 0 of 3 (too few for a rate) |
| `worker` | 6 | 33% (2 of 6) | 50% (3 of 6) |

1 agent PR touched more than one component, so the component rows can add up to more than the total. A trend, not attribution. Model updates or a different mix of tasks could account for part of the change.

Matched PRs: #500, #501, #502, #503, #504, #505, #506, #507, #508, #509, #510, #511, #512, #513, #514, #515, #516.

### Agent assets already in the repo

| Asset | Path | Authors | Last changed | Status |
|---|---|---|---|---|
| environment | `.cursor/environment.json` | Contributor B | Oct 29 | Present |
| rules | `.cursor/rules/style.mdc` | Contributor A | Jun 29 | Replays |
| skill | `.cursor/skills/release-notes/SKILL.md` | Contributor A, Contributor B, Contributor C | Oct 29 | Present |
| skill | `.cursor/skills/verify/SKILL.md` | Contributor B | Oct 30 | Replays |
| agents_md | `AGENTS.md` | Contributor B, Contributor A | Oct 29 | Replays |

Missing: hooks.

### Other signals (informational, not scored)

| Signal | Found | Detail |
|---|---|---|
| CI config | yes | .github/workflows/ci.yml, and it runs tests |
| A way to run one test file | yes | api: node --test takes file paths; shared: node --test takes file paths; worker: node --test takes file paths |
| Sample env file | n/a | the code reads no environment variables of its own |
| Worktree and port isolation | yes | no fixed ports or machine-specific absolute paths in the setup and scripts |
| AGENTS.md length | yes | 35 words |

These don't set a level or add a roadmap step.

### Evidence log

<details><summary>All evidence</summary>

| ID | Check | Component | What ran | Result |
|---|---|---|---|---|
| `ev-001` | `safety.execution_boundary` | repo | (read from files) | pass: no blocking findings; 2 items listed for review |
| `ev-002` | `bootstrap.cold_replay` | repo | (read from files) | pass: toolchain pinned in .nvmrc |
| `ev-003` | `bootstrap.cold_replay` | repo | node --version && npm --version (ran in a clean container) | pass: doctor passed |
| `ev-004` | `bootstrap.cold_replay` | repo | bash scripts/agent-install.sh (ran in a clean container) | pass: install passed |
| `ev-005` | `verify.canonical_interface` | api | npm run lint (ran in a clean container) | pass: lint passed |
| `ev-006` | `verify.canonical_interface` | shared | npm run lint (ran in a clean container) | pass: lint passed |
| `ev-007` | `verify.canonical_interface` | worker | npm run lint (ran in a clean container) | pass: lint passed |
| `ev-008` | `bootstrap.cold_replay` | repo | bash scripts/agent-start.sh (ran in a clean container) | pass: start passed |
| `ev-009` | `bootstrap.cold_replay` | api | npm run test (ran in a clean container) | pass: test passed (1 of 1 tests) |
| `ev-010` | `bootstrap.cold_replay` | shared | npm run test (ran in a clean container) | pass: test passed (3 of 3 tests) |
| `ev-011` | `bootstrap.cold_replay` | worker | npm run test (ran in a clean container) | pass: test passed (2 of 2 tests) |
| `ev-012` | `bootstrap.cold_replay` | repo | (ran in a clean container) | pass: frozen install reproduced the lockfile |
| `ev-013` | `verify.behavioral_oracle` | api | (ran in a clean container) | pass: caught 5 of 5 planted faults (tried: boundary_flip, change_constant, drop_throw_or_return, negate_condition) |
| `ev-014` | `verify.behavioral_oracle` | shared | (ran in a clean container) | pass: caught 5 of 5 planted faults (tried: boundary_flip, change_constant, negate_condition, drop_throw_or_return) |
| `ev-015` | `verify.behavioral_oracle` | worker | (ran in a clean container) | fail: caught 0 of 5 planted faults; missed: change_constant at packages/worker/src/retry.js:5, change_constant at packages/worker/src/retry.js:9, change_constant at p |
| `ev-016` | `context.instructions_verified` | repo | npm run lint -w api (ran in a clean container) | pass: .cursor/rules/style.mdc:6 `npm run lint -w api` replays |
| `ev-017` | `context.instructions_verified` | repo | node --version && npm --version (ran in a clean container) | pass: .cursor/skills/verify/SKILL.md:15 `node --version && npm --version` replays |
| `ev-018` | `context.instructions_verified` | repo | npm run test (ran in a clean container) | pass: .cursor/skills/verify/SKILL.md:56 `npm run test` replays |
| `ev-019` | `context.instructions_verified` | repo | npm run test -w shared (ran in a clean container) | pass: AGENTS.md:6 `npm run test -w shared` replays |
| `ev-020` | `context.instructions_verified` | repo | npm test (ran in a clean container) | pass: AGENTS.md:7 `npm test` replays |

</details>

Evidence strength, weakest to strongest: stated in docs, read from files, ran on host, ran in a clean container, confirmed by outcomes. A check passes only at its required strength.

## About this report

Audited Nov 30, 2026 at 9a2c092. Eval run with a pinned seed; not a production result. Outcomes come from a recorded PR file, not GitHub; not a production result. Scripts match the agent-readiness-v0.1.0 manifest bundled with this copy; the published release isn't checked here, and the seal is an unkeyed digest, which shows edits but not who sealed it.

- **Audit:** aud-2026-11-30-9a2c092-ae7a
- **Commit:** 9a2c092 (clean tree)
- **Rubric:** 2026-11-alpha
- **Permission tier:** local-exec
- **Seal:** Scripts match the agent-readiness-v0.1.0 manifest bundled with this copy; the published release isn't checked here, and the seal is an unkeyed digest, which shows edits but not who sealed it
- **Skill digest:** a3f4148e45a5
- **Planted faults:** seed pinned (eval run; not a production result)
- **Replay environment:** docker container, node:22-bookworm
- **Stored in:** .agent-readiness/history/audits/aud-2026-11-30-9a2c092-ae7a

---

Generated from `report.json` by the agent-readiness skill; `report.html` is the same report as a page. For signed reports, set SA_READINESS_SEAL_KEY from a CI secret where the audit runs.
