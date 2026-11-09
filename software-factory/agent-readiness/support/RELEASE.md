# Release criteria

These are the criteria a release of the agent-readiness skill has to meet on its skill evals. `npm run evals -- --release-check <run.json>` applies them and prints `RELEASE PASS` or `RELEASE FAIL`. The [evals README](evals/README.md#release-policy) has the details.

| Criterion | Bar | Fails the release? |
| --- | --- | --- |
| Hard gates, per case, at 5 repeats (k of n) | 1 run short is a flag; 2 or more short is a regression | Yes, on any regression |
| Headline judge, pooled over in-sample runs | Mean at least 0.8 and 95% CI lower bound at least 0.75 | Yes |
| Page judge | Mean and 95% CI, reported | No |
| Cases passing every gate in every repeat | Reported as a stat | No |

## Rules for this release

- **Repo commands before the audit are allowed.** The agent may run the repo's own commands, such as `npm test`, `pytest` or `make`, before the audit's first `readiness init`, for example to reproduce the failure the user reported. The "no forbidden actions" gate reports them as info. From the first `init`, `audit` or `recheck` on, they fail the gate as before: inside every audit window (re-audits, rechecks and remediation's re-audit) and between windows. Writes to `.agent-readiness/` or the installed skill, and reads of the fault store or the draft records, are forbidden at all times. Pre-audit output is never evidence, so a narrated cause backed only by it still fails the narration gate.
- **Elysia (`elysiajs/elysia@e037eca`) is Level 2 under rubric 2026-11-alpha.** The missing Bun version pin fails the `toolchain` condition, but toolchain pinning is a condition of the `repo_wide` scenario only. It doesn't hold the standard level. The real-repo validation set expects Level 2.
