# Levels, the rollup rule and scenarios

Every audit reports levels in three tiers, in the report, the seal, `report.json` and the history:

1. **The repo:** one rollup level, Level 0 to 4.
2. **Each app or component the scan finds:** one standard level, Level 0 to 4. Part 5 lists every component found, included or excluded, with the reason for each exclusion.
3. **Scenarios:** optional breakdowns for a kind of work, nested under the components they cover. They appear only when someone adds them.

## The scale

| Level | Name | Measured by | Means |
|---|---|---|---|
| 0 | Not bootable | audit | A clean checkout can't install, build and pass its tests. |
| 1 | Bootable | audit | A clean checkout installs, builds and passes every test, in a clean container. |
| 2 | Verifiable | audit | Agents can check their own work: the commands pass, the tests catch planted faults, the instructions are accurate and normal work needs no production access. |
| 3 | Delegable | outcomes | Agent PRs meet the outcome targets your team set, over at least 20 agent PRs in the window (never fewer than 10). |
| 4 | Scalable | outcomes | Those targets held over two back-to-back windows while agent PR volume at least doubled. |

An audit never claims Level 3 or 4 by itself. A condition the audit couldn't run counts as not met, and the report says "could be Level N" when that's the only thing missing. A condition blocked by a limit of the machine never counts against the repo.

## A component's standard level

- **Level 1:** the frozen install, the build and every test pass in a clean container.
- **Level 2:** Level 1, plus build, lint, type-check and test commands pass at `HEAD`; every planted fault in the component is caught (at least 3); agent instructions are accurate; and normal work needs no production access.
- **Levels 3 and 4:** measured on the agent PRs that touch the component, against the same control group of other PRs. Level 3 needs Level 2 and targets met over at least 20 agent PRs in a 30-day window. A team can lower the 20 with `--min-prs`, never below 10. Level 4 (rubric 2026-11-alpha) needs two back-to-back audit windows at Level 3 or above, each meeting the targets, with this window's agent PRs at least double the first window's and the change-request rate no higher. A window below Level 3 starts the count again; a Level 4 window stays in the run, so Level 4 holds while the volume does. Audits sealed under 2026-10-alpha compared with the last audit at Level 3 or above.

## The rollup rule

The repo level is the lowest level among active components:

- An active component is an assessed component with at least 10% of changes over 90 days.
- A component joins or leaves the active set only after two consecutive audits on the same side of the line. From rubric 2026-11-alpha, a component the last audit didn't have joins at once.
- Components the audit can't assess, such as a .NET service, never set the repo level. They keep their share of changes, and when more than 20% of changes are in them the report says "partial coverage".
- Scenarios never change a component's standard level or the repo level.
- With no real check result, there is no level at any tier: the report says "not assessed" and why.

## Scenarios

A scenario swaps in its own Level 2 bar and is reported under each component it covers. Add one with `readiness init --scenario <id>` for every component, or after the scan with `readiness scenario add <id> --components a,b`.

- **First PR (`first_pr`):** the commands pass, agent instructions are accurate, and normal work needs no production access. Planted faults aren't needed.
- **Bug fixes (`bug_fixes`):** the commands pass, planted faults are caught, and normal work needs no production access. Accurate instructions aren't needed.
- **Features and refactors (`features`):** the same bar as the standard Level 2.
- **Repo-wide changes (`repo_wide`):** the bug-fix bar, plus pinned toolchain versions and a frozen install that reproduces the lockfile.

Use one when the team wants a specific kind of work judged, for example `bug_fixes` for a component whose instructions are still being rewritten.

## The roadmap

Every roadmap opens with "Name an owner for agent readiness" until one is recorded, even when an audit has no real results to plan from. Then, per component, the path follows the standard level:

1. **Reach Level 1:** fix the clean install, build and tests. The usual items: set up a service, remove a production credential from tests, commit a lockfile, pass registry credentials.
2. **Reach Level 2:** fix failing commands, make the tests catch planted faults, and fix stale instructions.
3. **Roll out:** for each component at Level 2, "Give agents work in <component>". Pick 3 to 5 real tasks, have agents run the verify skill before they push, and review as usual. The team decides who reviews agent PRs and what it watches.
4. **Set Level 3 targets:** merge rate, first-time CI pass rate and the most change requests you accept, always compared with other PRs in the same window.
5. **Reach Level 4:** hold the targets for two consecutive windows while agent PR volume at least doubles.

Fixes a scenario needs but the standard level doesn't, such as pinned toolchains for `repo_wide`, stay on the roadmap as later steps and never become top items.

Each item records its expected outcome, a watch metric from the fixed set (opened, merged, first-time CI pass, changes requested, median days to merge, PRs that add a stray file, merged PRs by activity label) and its baseline. The audit that closes an item records the date, and later audits fill in the observed value from the window after it closed.
